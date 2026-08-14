#!/bin/bash
# imagegen-grsai.sh — GrsAI GPT-Image 后端（grsai.ai，OpenAI 风格 /v1/draw/completions）
# 用法：bash imagegen-grsai.sh --prompt-file <文件> --size <宽高比如 1:1 或 2:3> --out <输出PNG路径> [--ref <本地路径或URL>]
# 依赖：curl + python（JSON 处理内置于同目录 api-json.py，无需 jq）+ base64
#
# 环境变量：
#   GRSAI_API_KEY        必填；grsai.ai 控制台创建
#   GRSAI_BASE_URL       可选；默认 https://api.grsai.com（海外）；国内可设 https://api.grsai.cn
#   GRSAI_MODEL          可选；默认 gpt-image-2
# 认证：Authorization: Bearer $GRSAI_API_KEY
# 协议：POST {base}/v1/draw/completions，同步返回 {status:"succeeded", results:[{url}]}，
#       取第一张 results[0].url 下载落盘。
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
JSONPY="$SCRIPT_DIR/api-json.py"

PROMPT_FILE=""
SIZE=""
OUT=""
REF=""
while [ $# -gt 0 ]; do
	case "$1" in
	--prompt-file)
		PROMPT_FILE="$2"
		shift 2
		;;
	--size)
		SIZE="$2"
		shift 2
		;;
	--out)
		OUT="$2"
		shift 2
		;;
	--ref)
		REF="$2"
		shift 2
		;;
	*)
		echo "未知参数: $1" >&2
		exit 2
		;;
	esac
done

: "${PROMPT_FILE:?缺少 --prompt-file}"
: "${OUT:?缺少 --out}"
: "${GRSAI_API_KEY:?请设置 GRSAI_API_KEY}"
PROMPT=$(cat "$PROMPT_FILE")
BASE_URL="${GRSAI_BASE_URL:-https://api.grsai.com}"
MODEL="${GRSAI_MODEL:-gpt-image-2}"
# GrsAI 的 size 语义是宽高比（aspectRatio），如 1:1 / 2:3 / 3:4
SIZE="${SIZE:-1:1}"

command -v python >/dev/null 2>&1 || { echo "需要 python（JSON 处理依赖）" >&2; exit 1; }
command -v base64 >/dev/null 2>&1 || { echo "需要 base64" >&2; exit 1; }
mkdir -p "$(dirname "$OUT")"
RESP=$(mktemp)
REF_TMP=""
trap '[ -n "$REF_TMP" ] && rm -f "$REF_TMP"; rm -f "$RESP"' EXIT

URLS="[]"
if [ -n "${REF:-}" ]; then
	# 图生图：urls 数组传参考图（支持本地文件先转 data URL 或直接传 URL）
	case "$REF" in
	http://* | https://*)
		URLS="[\"$REF\"]"
		;;
	*)
		[ -f "$REF" ] || {
			echo "参考图不存在: $REF" >&2
			exit 1
		}
		REF_TMP=$(mktemp)
		base64 -w0 "$REF" >"$REF_TMP"
		MIME="image/png"
		case "$REF" in
		*.jpg | *.jpeg) MIME="image/jpeg" ;;
		*.webp) MIME="image/webp" ;;
		esac
		DATA="data:$MIME;base64,$(cat "$REF_TMP")"
		URLS="[\"$DATA\"]"
		;;
	esac
fi

BODY=$(python "$JSONPY" body grsai "$MODEL" "$PROMPT" "$SIZE")
# urls 字段（参考图）单独注入：body 生成器不含它，这里用 python 合并
if [ "$URLS" != "[]" ]; then
	BODY=$(python -c "
import json, sys
body = json.loads(sys.argv[1])
body['urls'] = json.loads(sys.argv[2])
print(json.dumps(body, ensure_ascii=False))
" "$BODY" "$URLS")
fi

curl -fsS --max-time 240 --retry 2 --retry-delay 5 \
	"$BASE_URL/v1/draw/completions" \
	-H "Authorization: Bearer $GRSAI_API_KEY" \
	-H "Content-Type: application/json" \
	-d "$BODY" >"$RESP"

if ERR=$(python "$JSONPY" has-error "$RESP" grsai); then
	:
else
	echo "API error: $ERR" >&2
	exit 1
fi

IMGFMT=$(python "$JSONPY" first-image "$RESP")
case "$IMGFMT" in
url:http*)
	curl -fsSL --max-time 120 -o "$OUT" "${IMGFMT#url:}"
	;;
url:data:*)
	# data URL 直接解码落盘（离线 mock / 部分代理返回内嵌图）
	python -c "
import base64, sys
raw = sys.argv[1][len('url:data:'):]
head, _, payload = raw.partition(',')
if ';base64' in head:
    sys.stdout.buffer.write(base64.b64decode(payload))
else:
    sys.stdout.buffer.write(payload.encode('utf-8'))
" "$IMGFMT" >"$OUT"
	;;
b64:*)
	printf '%s' "${IMGFMT#b64:}" | base64 --decode >"$OUT"
	;;
none)
	echo "响应无 results[].url：" >&2
	head -c 300 "$RESP" >&2
	exit 1
	;;
*)
	echo "响应格式异常：" >&2
	head -c 300 "$RESP" >&2
	exit 1
	;;
esac
[ -s "$OUT" ] || {
	echo "输出为空: $OUT" >&2
	exit 1
}

# 按实际格式修正扩展名（云后端可能返回 JPEG/WebP 而非 PNG）
NEWEXT=$(python "$JSONPY" fix-ext "$OUT" 2>/dev/null || true)
if [ -n "$NEWEXT" ]; then
	NEWOUT="${OUT%.*}.$NEWEXT"
	mv "$OUT" "$NEWOUT"
	echo "格式修正：实际为 $NEWEXT，已存为 $NEWOUT" >&2
	OUT="$NEWOUT"
fi

printf '%s
' "$PROMPT" >"${OUT%.*}.prompt.txt"
echo "OK: $OUT"

#!/bin/bash
# imagegen-volcengine.sh — 火山方舟 Seedream 图像生成（OpenAI 兼容端点）
# 用法：bash imagegen-volcengine.sh --prompt-file <文件> --size <规格> --out <输出PNG路径>
# 环境：ARK_API_KEY、ARK_BASE_URL(默认 https://ark.cn-beijing.volces.com/api/v3)、
#       ARK_IMAGE_MODEL(默认 doubao-seedream-4-0-250828；可用模型见 GET /api/v3/models)
# 依赖：curl + python（JSON 处理内置于同目录 api-json.py，无需 jq）
# 注意：Seedream 的 size 是规格串（1K/2K/4K 或宽x高），不是 gpt-image 的像素格式。
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
JSONPY="$SCRIPT_DIR/api-json.py"

PROMPT_FILE=""
SIZE=""
OUT=""
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
	*)
		echo "未知参数: $1" >&2
		exit 2
		;;
	esac
done

: "${PROMPT_FILE:?缺少 --prompt-file}"
: "${OUT:?缺少 --out}"
: "${ARK_API_KEY:?请设置 ARK_API_KEY}"
PROMPT=$(cat "$PROMPT_FILE")
BASE_URL="${ARK_BASE_URL:-https://ark.cn-beijing.volces.com/api/v3}"
MODEL="${ARK_IMAGE_MODEL:-doubao-seedream-4-0-250828}"

command -v python >/dev/null 2>&1 || {
	echo "需要 python（JSON 处理依赖）" >&2
	exit 1
}
mkdir -p "$(dirname "$OUT")"
RESP=$(mktemp)
trap 'rm -f "$RESP"' EXIT

BODY=$(python "$JSONPY" body volcengine "$MODEL" "$PROMPT" "${SIZE:-}")

curl -fsS --max-time 300 --retry 2 --retry-delay 5 \
	"$BASE_URL/images/generations" \
	-H "Authorization: Bearer $ARK_API_KEY" \
	-H "Content-Type: application/json" \
	-d "$BODY" >"$RESP"

if ERR=$(python "$JSONPY" has-error "$RESP"); then
	:
else
	echo "API error: $ERR" >&2
	exit 1
fi

IMGFMT=$(python "$JSONPY" first-image "$RESP")
case "$IMGFMT" in
url:*)
	curl -fsSL --max-time 120 -o "$OUT" "${IMGFMT#url:}"
	;;
b64:*)
	printf '%s' "${IMGFMT#b64:}" | base64 --decode >"$OUT"
	;;
*)
	echo "响应无 url 也无 b64_json：" >&2
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

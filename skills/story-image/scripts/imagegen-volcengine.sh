#!/bin/bash
# imagegen-volcengine.sh — 火山方舟 Seedream 图像生成（OpenAI 兼容端点）
# 用法：bash imagegen-volcengine.sh --prompt-file <文件> --size <规格> --out <输出PNG路径>
# 环境：ARK_API_KEY、ARK_BASE_URL(默认 https://ark.cn-beijing.volces.com/api/v3)、
#       ARK_IMAGE_MODEL(默认 doubao-seedream-4-0-250828)
# 注意：Seedream 的 size 是规格串（1K/2K/4K 或宽x高），不是 gpt-image 的像素格式。
set -euo pipefail

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
# 未显式给 size 时不传该字段（方舟默认出图规格），显式给了则原样透传
SIZE_ARG="null"
if [ -n "${SIZE:-}" ]; then SIZE_ARG="\"$SIZE\""; fi

mkdir -p "$(dirname "$OUT")"
RESP=$(mktemp)
trap 'rm -f "$RESP"' EXIT

BODY=$(jq -n \
	--arg m "$MODEL" \
	--arg p "$PROMPT" \
	--argjson s "$SIZE_ARG" \
	'{model:$m, prompt:$p, response_format:"url", watermark:true}
   + (if $s != null then {size:$s} else {} end)')

curl -fsS --max-time 300 --retry 2 --retry-delay 5 \
	"$BASE_URL/images/generations" \
	-H "Authorization: Bearer $ARK_API_KEY" \
	-H "Content-Type: application/json" \
	-d "$BODY" >"$RESP"

if jq -e '.error' "$RESP" >/dev/null 2>&1; then
	echo "API error:" >&2
	jq '.error' "$RESP" >&2
	exit 1
fi

if jq -er '.data[0].url // empty' "$RESP" 2>/dev/null | grep -q .; then
	curl -fsSL --max-time 120 -o "$OUT" "$(jq -er '.data[0].url' "$RESP")"
elif jq -er '.data[0].b64_json // empty' "$RESP" 2>/dev/null | grep -q .; then
	jq -er '.data[0].b64_json // empty' "$RESP" | base64 --decode >"$OUT"
else
	echo "响应无 url 也无 b64_json：" >&2
	head -c 300 "$RESP" >&2
	exit 1
fi
[ -s "$OUT" ] || {
	echo "输出为空: $OUT" >&2
	exit 1
}

printf '%s\n' "$PROMPT" >"${OUT%.png}.prompt.txt"
echo "OK: $OUT"

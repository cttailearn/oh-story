#!/bin/bash
# imagegen-openai.sh — OpenAI 兼容 Images API 后端（gpt-image-2 及兼容代理）
# 用法：bash imagegen-openai.sh --prompt-file <文件> --size <尺寸> --out <输出PNG路径> [--ref <本地路径或URL>]
set -euo pipefail

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
: "${GPT_IMAGE_API_KEY:?请设置 GPT_IMAGE_API_KEY}"
PROMPT=$(cat "$PROMPT_FILE")
BASE_URL="${GPT_IMAGE_BASE_URL:-https://api.openai.com/v1}"
MODEL="${GPT_IMAGE_MODEL:-gpt-image-2}"
SIZE="${SIZE:-1024x1536}"

command -v jq >/dev/null 2>&1 || { echo "需要 jq（JSON 解析），请先安装：Linux/macOS 用包管理器，Windows 用 scoop/choco 或 Git Bash 自带" >&2; exit 1; }
command -v base64 >/dev/null 2>&1 || { echo "需要 base64" >&2; exit 1; }
mkdir -p "$(dirname "$OUT")"
RESP=$(mktemp)
trap 'rm -f "$RESP"' EXIT

if [ -n "${REF:-}" ]; then
	# 图生图：images/edits 走 multipart/form-data
	REF_LOCAL="$REF"
	REF_TMP=""
	case "$REF" in
	http://* | https://*)
		REF_TMP=$(mktemp)
		curl -fsSL --max-time 60 -o "$REF_TMP" "$REF"
		REF_LOCAL="$REF_TMP"
		;;
	*)
		[ -f "$REF" ] || {
			echo "参考图不存在: $REF" >&2
			exit 1
		}
		;;
	esac
	trap '[ -n "$REF_TMP" ] && rm -f "$REF_TMP"; rm -f "$RESP"' EXIT
	curl -fsS --max-time 240 --retry 2 --retry-delay 5 \
		"$BASE_URL/images/edits" \
		-H "Authorization: Bearer $GPT_IMAGE_API_KEY" \
		--form-string "model=$MODEL" \
		--form-string "size=$SIZE" \
		--form-string "prompt=$PROMPT" \
		-F "image=@$REF_LOCAL" >"$RESP"
else
	BODY=$(jq -n --arg m "$MODEL" --arg p "$PROMPT" --arg s "$SIZE" \
		'{model:$m, prompt:$p, size:$s}')
	curl -fsS --max-time 180 --retry 2 --retry-delay 5 \
		"$BASE_URL/images/generations" \
		-H "Authorization: Bearer $GPT_IMAGE_API_KEY" \
		-H "Content-Type: application/json" \
		-d "$BODY" >"$RESP"
fi

if jq -e '.error' "$RESP" >/dev/null 2>&1; then
	echo "API error:" >&2
	jq '.error' "$RESP" >&2
	exit 1
fi

# 兼容 b64_json 与 url 两种响应
if jq -er '.data[0].b64_json // empty' "$RESP" 2>/dev/null | grep -q .; then
	jq -er '.data[0].b64_json // empty' "$RESP" | base64 --decode >"$OUT"
elif jq -er '.data[0].url // empty' "$RESP" 2>/dev/null | grep -q .; then
	curl -fsSL --max-time 120 -o "$OUT" "$(jq -er '.data[0].url' "$RESP")"
else
	echo "响应无 b64_json 也无 url：" >&2
	head -c 300 "$RESP" >&2
	exit 1
fi
[ -s "$OUT" ] || {
	echo "输出为空: $OUT" >&2
	exit 1
}

printf '%s\n' "$PROMPT" >"${OUT%.png}.prompt.txt"
echo "OK: $OUT"

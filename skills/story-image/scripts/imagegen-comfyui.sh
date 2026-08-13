#!/bin/bash
# imagegen-comfyui.sh — 本地 ComfyUI 后端（提交工作流 → 轮询 history → 下载输出）
# 用法：bash imagegen-comfyui.sh --workflow <API格式JSON> --prompt <提示词文本> --out <输出PNG路径>
#       [--negative <负向提示词>] [--timeout <秒，默认300>]
# 环境：COMFYUI_URL(默认 http://127.0.0.1:8188)、COMFY_CKPT(检查点名，默认 sd_xl_base_1.0.safetensors)
# 工作流内用占位符 __PROMPT__ / __NEGATIVE__ / __CKPT__，本脚本注入后提交（jq walk 递归替换）。
set -euo pipefail

WORKFLOW=""; PROMPT=""; NEGATIVE=""; OUT=""; TIMEOUT=300; CKPT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --workflow) WORKFLOW="$2"; shift 2 ;;
    --prompt) PROMPT="$2"; shift 2 ;;
    --negative) NEGATIVE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --ckpt) CKPT="$2"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

: "${WORKFLOW:?缺少 --workflow}"
: "${PROMPT:?缺少 --prompt}"
: "${OUT:?缺少 --out}"
: "${COMFYUI_URL:=http://127.0.0.1:8188}"
CKPT="${CKPT:-${COMFY_CKPT:-sd_xl_base_1.0.safetensors}}"
command -v jq >/dev/null 2>&1 || { echo "需要 jq" >&2; exit 1; }
command -v uuidgen >/dev/null 2>&1 || { echo "需要 uuidgen" >&2; exit 1; }

mkdir -p "$(dirname "$OUT")"

# 注入提示词/负向词/检查点占位符
WF_JSON=$(jq --arg p "$PROMPT" --arg n "${NEGATIVE:-}" --arg c "$CKPT" \
  'walk(if type=="string" then
          (if .=="__PROMPT__" then $p elif .=="__NEGATIVE__" then $n elif .=="__CKPT__" then $c else . end)
        else . end)' "$WORKFLOW")

CLIENT_ID="story-image-$(uuidgen)"
RESP=$(mktemp)
HIST=$(mktemp)
trap 'rm -f "$RESP" "$HIST"' EXIT

curl -fsS --max-time 60 \
  "$COMFYUI_URL/prompt" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --argjson wf "$WF_JSON" --arg cid "$CLIENT_ID" '{prompt:$wf, client_id:$cid}')" > "$RESP"

if jq -e '.node_errors // empty' "$RESP" >/dev/null 2>&1; then
  echo "工作流节点错误：" >&2
  jq '.node_errors' "$RESP" >&2
  exit 1
fi
PROMPT_ID=$(jq -er '.prompt_id // empty' "$RESP")
[ -n "$PROMPT_ID" ] || { echo "响应缺 prompt_id：" >&2; head -c 300 "$RESP" >&2; exit 1; }

# 轮询 history
DEADLINE=$((SECONDS + TIMEOUT))
FOUND=0
while [ $SECONDS -lt $DEADLINE ]; do
  curl -fsS --max-time 30 "$COMFYUI_URL/history/$PROMPT_ID" > "$HIST" 2>/dev/null || true
  IMG=$(jq -er ".\"$PROMPT_ID\".outputs // {} | to_entries[].value.images[0] // empty" "$HIST" 2>/dev/null || true)
  if [ -n "$IMG" ]; then FOUND=1; break; fi
  sleep 2
done
[ "$FOUND" = "1" ] || { echo "ComfyUI 出图超时（${TIMEOUT}s）：prompt_id=$PROMPT_ID" >&2; exit 1; }

FILENAME=$(jq -er ".\"$PROMPT_ID\".outputs | to_entries[].value.images[0].filename" "$HIST")
SUBFOLDER=$(jq -er ".\"$PROMPT_ID\".outputs | to_entries[].value.images[0].subfolder // empty" "$HIST")
TYPE=$(jq -er ".\"$PROMPT_ID\".outputs | to_entries[].value.images[0].type // \"output\"" "$HIST")

curl -fsS --max-time 120 -o "$OUT" \
  --get "$COMFYUI_URL/view" \
  --data-urlencode "filename=$FILENAME" \
  --data-urlencode "subfolder=$SUBFOLDER" \
  --data-urlencode "type=$TYPE"

[ -s "$OUT" ] || { echo "下载为空: $OUT" >&2; exit 1; }
printf '%s\n' "$PROMPT" > "${OUT%.png}.prompt.txt"
echo "OK: $OUT"

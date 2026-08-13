#!/bin/bash
# imagegen-dashscope.sh — 阿里通义万相图像生成（DashScope 原生异步接口）
# 用法：bash imagegen-dashscope.sh --prompt-file <文件> --size <规格> --out <输出PNG路径>
# 环境：DASHSCOPE_API_KEY、DASHSCOPE_IMAGE_MODEL(默认 wanx2.1-t2i-turbo)
#       DASHSCOPE_MODE=compatible 时改走 OpenAI 兼容端点（同步）
# 注意：万相 size 用规格串（如 "1024*1024"、"720*1280"），星号分隔。
set -euo pipefail

PROMPT_FILE=""; SIZE=""; OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --prompt-file) PROMPT_FILE="$2"; shift 2 ;;
    --size) SIZE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

: "${PROMPT_FILE:?缺少 --prompt-file}"
: "${OUT:?缺少 --out}"
: "${DASHSCOPE_API_KEY:?请设置 DASHSCOPE_API_KEY}"
PROMPT=$(cat "$PROMPT_FILE")
MODEL="${DASHSCOPE_IMAGE_MODEL:-wanx2.1-t2i-turbo}"
SIZE="${SIZE:-1024*1024}"

mkdir -p "$(dirname "$OUT")"
RESP=$(mktemp)
trap 'rm -f "$RESP"' EXIT

download_url() {
  local url="$1"
  curl -fsSL --max-time 180 -o "$OUT" "$url"
}

if [ "${DASHSCOPE_MODE:-async}" = "compatible" ]; then
  # OpenAI 兼容模式（同步，部分模型支持）
  BASE="${DASHSCOPE_BASE_URL:-https://dashscope.aliyuncs.com/compatible-mode/v1}"
  BODY=$(jq -n --arg m "$MODEL" --arg p "$PROMPT" --arg s "$SIZE" \
    '{model:$m, prompt:$p, size:$s}')
  curl -fsS --max-time 300 \
    "$BASE/images/generations" \
    -H "Authorization: Bearer $DASHSCOPE_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$BODY" > "$RESP"
  if jq -e '.error' "$RESP" >/dev/null 2>&1; then
    echo "API error:" >&2; jq '.error' "$RESP" >&2; exit 1
  fi
  if jq -er '.data[0].url // empty' "$RESP" 2>/dev/null | grep -q .; then
    download_url "$(jq -er '.data[0].url' "$RESP")"
  elif jq -er '.data[0].b64_json // empty' "$RESP" 2>/dev/null | grep -q .; then
    jq -er '.data[0].b64_json // empty' "$RESP" | base64 --decode > "$OUT"
  else
    echo "响应无 url 也无 b64_json：" >&2; head -c 300 "$RESP" >&2; exit 1
  fi
else
  # 原生异步：提交任务 → 轮询 /api/v1/tasks/{task_id}
  BASE="${DASHSCOPE_BASE_URL:-https://dashscope.aliyuncs.com/api/v1}"
  BODY=$(jq -n --arg m "$MODEL" --arg p "$PROMPT" --arg s "$SIZE" \
    '{model:$m, input:{prompt:$p}, parameters:{size:$s, n:1}}')
  curl -fsS --max-time 120 \
    "$BASE/services/aigc/text2image/image-synthesis" \
    -H "Authorization: Bearer $DASHSCOPE_API_KEY" \
    -H "Content-Type: application/json" \
    -H "X-DashScope-Async: enable" \
    -d "$BODY" > "$RESP"
  if jq -e '.code or .message' "$RESP" >/dev/null 2>&1 && ! jq -e '.output.task_id' "$RESP" >/dev/null 2>&1; then
    echo "API error:" >&2; head -c 300 "$RESP" >&2; exit 1
  fi
  TASK_ID=$(jq -er '.output.task_id // empty' "$RESP")
  [ -n "$TASK_ID" ] || { echo "响应缺 task_id：" >&2; head -c 300 "$RESP" >&2; exit 1; }

  TASK_RESP=$(mktemp)
  trap 'rm -f "$RESP" "$TASK_RESP"' EXIT
  DEADLINE=$((SECONDS + 300))
  while [ $SECONDS -lt $DEADLINE ]; do
    curl -fsS --max-time 30 \
      "$BASE/tasks/$TASK_ID" \
      -H "Authorization: Bearer $DASHSCOPE_API_KEY" > "$TASK_RESP"
    STATUS=$(jq -er '.output.task_status // empty' "$TASK_RESP")
    case "$STATUS" in
      SUCCEEDED)
        URL=$(jq -er '.output.results[0].url // empty' "$TASK_RESP")
        [ -n "$URL" ] || { echo "任务成功但无结果 url：" >&2; head -c 300 "$TASK_RESP" >&2; exit 1; }
        download_url "$URL"
        break
        ;;
      FAILED|CANCELED)
        echo "任务 $STATUS：" >&2; head -c 300 "$TASK_RESP" >&2; exit 1
        ;;
      *) sleep 2 ;;
    esac
  done
  [ -s "$OUT" ] || { echo "轮询超时（300s）：task_id=$TASK_ID" >&2; exit 1; }
fi

[ -s "$OUT" ] || { echo "输出为空: $OUT" >&2; exit 1; }
printf '%s\n' "$PROMPT" > "${OUT%.png}.prompt.txt"
echo "OK: $OUT"

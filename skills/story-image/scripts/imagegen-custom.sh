#!/bin/bash
# imagegen-custom.sh — 自定义图像 API 后端（按用户提供的 API 文档接入）
# 配置来源（优先级：环境变量 > ~/.story-image/custom-backend.conf 默认值）
#   CUSTOM_API_URL       必填 生成端点（完整 URL，如 https://api.example.com/v1/images/generations）
#   CUSTOM_API_KEY       必填 API Key
#   CUSTOM_API_MODEL     选填 请求体 model 字段（文档指定模型名时填）
#   CUSTOM_AUTH_HEADER   选填 认证头模板，默认 "Authorization: Bearer <key>"；
#                        例 "X-Api-Key: <key>"、"Authorization: <key>"
#   CUSTOM_BODY          选填 请求体 JSON 模板，占位符 __MODEL__/__PROMPT__/__SIZE__；
#                        缺省自动构造 OpenAI 兼容体 {"model","prompt","size"}
#   CUSTOM_IMAGE_PATH    选填 响应取图点路径（如 data.0.url / data.0.b64_json /
#                        results.0.url / output.url）；缺省自动（data 优先、results 其次）
#   CUSTOM_IMAGE_FIELD   选填 url|b64_json，缺省自动（url 优先）
#   CUSTOM_ERROR_PATH    选填 错误对象点路径，默认 error
#   CUSTOM_SIZE_MODE     选填 pixels(默认，透传)/aspect(写入 aspectRatio 字段)/raw(不写 size)
#   CUSTOM_EXTRA_HEADERS 选填 JSON 对象附加请求头（如 {"X-User-Id":"123"}）
#   CUSTOM_TEST_SIZE     选填 --test 用尺寸，默认 256x256
# 用法：bash imagegen-custom.sh --prompt-file <文件> [--size <尺寸>] --out <输出路径> [--test]
# 依赖：curl + python（api-json.py 做 JSON 处理）+ base64
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
JSONPY="$SCRIPT_DIR/api-json.py"
CONF="$HOME/.story-image/custom-backend.conf"

# 加载配置：conf 文件提供默认值（:="${VAR:-default}" 语义 → 环境变量优先）
if [ -f "$CONF" ]; then
  # shellcheck disable=SC1090
  . "$CONF"
fi

PROMPT_FILE=""
SIZE=""
OUT=""
TEST_MODE=0
while [ $# -gt 0 ]; do
  case "$1" in
  --prompt-file) PROMPT_FILE="$2"; shift 2 ;;
  --size) SIZE="$2"; shift 2 ;;
  --out) OUT="$2"; shift 2 ;;
  --test) TEST_MODE=1; shift ;;
  *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

: "${PROMPT_FILE:?缺少 --prompt-file}"
: "${OUT:?缺少 --out}"
: "${CUSTOM_API_URL:?未配置 CUSTOM_API_URL（生成端点）}"
: "${CUSTOM_API_KEY:?未配置 CUSTOM_API_KEY}"

if [ "$TEST_MODE" -eq 1 ]; then
  SIZE="${SIZE:-${CUSTOM_TEST_SIZE:-256x256}}"
  echo "[test] 连通性测试：$CUSTOM_API_URL（size=$SIZE）" >&2
fi

command -v python >/dev/null 2>&1 || { echo "需要 python（JSON 处理依赖）" >&2; exit 1; }
command -v base64 >/dev/null 2>&1 || { echo "需要 base64" >&2; exit 1; }
mkdir -p "$(dirname "$OUT")"

PROMPT=$(cat "$PROMPT_FILE")
MODEL="${CUSTOM_API_MODEL:-}"
AUTH_HEADER="${CUSTOM_AUTH_HEADER:-Authorization: Bearer $CUSTOM_API_KEY}"

# 构造请求体：有 CUSTOM_BODY 模板则做占位符替换（JSON 安全），否则 OpenAI 兼容体
SIZE_MODE="${CUSTOM_SIZE_MODE:-pixels}"
BODY=$(CUSTOM_BODY_TMPL="${CUSTOM_BODY:-}" MODEL="$MODEL" PROMPT="$PROMPT" SIZE="$SIZE" SIZE_MODE="$SIZE_MODE" python - "$JSONPY" <<'PYEOF'
import json, os, sys, subprocess
tmpl = os.environ.get("CUSTOM_BODY_TMPL", "")
model = os.environ.get("MODEL", "")
prompt = os.environ.get("PROMPT", "")
size = os.environ.get("SIZE", "")
size_mode = os.environ.get("SIZE_MODE", "pixels")
if tmpl:
    body = json.loads(tmpl)  # 模板本身必须是合法 JSON（值可用占位符）
    def fill(v):
        if isinstance(v, str):
            v = v.replace("__PROMPT__", prompt).replace("__MODEL__", model).replace("__SIZE__", size)
        return v
    body = {k: fill(v) for k, v in body.items()}
    # 模板里 __PROMPT__ 等出现在嵌套值中的情况：简单递归处理
    def deep(v):
        if isinstance(v, dict): return {k: deep(x) for k, x in v.items()}
        if isinstance(v, list): return [deep(x) for x in v]
        if isinstance(v, str): return v.replace("__PROMPT__", prompt).replace("__MODEL__", model).replace("__SIZE__", size)
        return v
    body = deep(body)
else:
    body = {}
    if model: body["model"] = model
    body["prompt"] = prompt
    if size_mode == "aspect":
        body["aspectRatio"] = size
    elif size_mode == "raw":
        pass
    elif size:
        body["size"] = size
sys.stdout.write(json.dumps(body, ensure_ascii=False))
PYEOF
)

EXTRA_HEADERS="${CUSTOM_EXTRA_HEADERS:-}"
RESP=$(mktemp)
trap 'rm -f "$RESP"' EXIT

# 组装 curl 参数（认证头 + 附加头）
CURL_ARGS=(-fsS --max-time 240 --retry 2 --retry-delay 5
  -H "Content-Type: application/json"
  -H "$AUTH_HEADER")
if [ -n "$EXTRA_HEADERS" ]; then
  EXTRA_JSON="$EXTRA_HEADERS" python - <<'PYEOF' >"$RESP.headers" 2>/dev/null || true
import json, os, sys
try:
    h = json.loads(os.environ["EXTRA_JSON"])
    for k, v in h.items(): print('-H ' + json.dumps(k + ': ' + str(v)))
except Exception:
    pass
PYEOF
  if [ -f "$RESP.headers" ]; then
    while IFS= read -r h; do [ -n "$h" ] && CURL_ARGS+=("$h"); done <"$RESP.headers"
  fi
fi

curl "${CURL_ARGS[@]}" -X POST "$CUSTOM_API_URL" -d "$BODY" >"$RESP" || {
  echo "请求失败（网络/端点不可达）：$CUSTOM_API_URL" >&2
  exit 1
}

# 错误检查：CUSTOM_ERROR_PATH 指定路径存在即报错；缺省按 error 字段
ERR_PATH="${CUSTOM_ERROR_PATH:-error}"
if [ "$ERR_PATH" != "none" ]; then
  ERRVAL=$(python "$JSONPY" field "$RESP" "$ERR_PATH" 2>/dev/null || true)
  if [ -n "$ERRVAL" ]; then
    echo "API error: $ERRVAL" >&2
    exit 1
  fi
fi

# 取图：CUSTOM_IMAGE_PATH 指定 → field 提取；否则 first-image 自动
IMG_PATH="${CUSTOM_IMAGE_PATH:-}"
if [ -n "$IMG_PATH" ]; then
  VAL=$(python "$JSONPY" field "$RESP" "$IMG_PATH" || true)
  case "$VAL" in
  http://* | https://*) IMGFMT="url:$VAL" ;;
  *) IMGFMT="b64:$VAL" ;;
  esac
else
  IMGFMT=$(python "$JSONPY" first-image "$RESP")
fi
case "$IMGFMT" in
b64:*)
  printf '%s' "${IMGFMT#b64:}" | base64 --decode >"$OUT"
  ;;
url:*)
  curl -fsSL --max-time 120 -o "$OUT" "${IMGFMT#url:}"
  ;;
none|*)
  echo "响应中没有图片（无 url/b64_json 字段）。响应内容：" >&2
  head -c 400 "$RESP" >&2
  exit 1
  ;;
esac
[ -s "$OUT" ] || { echo "输出为空: $OUT" >&2; exit 1; }

# 格式修正（云后端可能返回 JPEG/WebP）
NEWEXT=$(python "$JSONPY" fix-ext "$OUT" 2>/dev/null || true)
if [ -n "$NEWEXT" ]; then
  NEWOUT="${OUT%.*}.$NEWEXT"
  mv "$OUT" "$NEWOUT"
  echo "格式修正：实际为 $NEWEXT，已存为 $NEWOUT" >&2
  OUT="$NEWOUT"
fi

printf '%s\n' "$PROMPT" >"${OUT%.*}.prompt.txt"
echo "OK: $OUT"

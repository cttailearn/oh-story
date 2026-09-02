#!/bin/bash
# check-imagegen-env.sh — story-image 生成环境检查（任何生成前必跑，不满足先问用户）
# 用法：bash check-imagegen-env.sh [--backend <openai|grsai|volcengine|dashscope|custom|comfyui>]
#   --backend 指定后端时做专项检查（comfyui → URL 可达 + 工作流目录；云后端 → key 非空 + 端点可达）
# 输出：每项 [OK]/[MISSING] + 中文修复提示；有 MISSING 时 exit 1
# 依赖：bash + curl + python + base64（缺一即 MISSING，附安装提示）
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
BACKEND=""
TEST_CONN=0
while [ $# -gt 0 ]; do
  case "$1" in
  --backend) BACKEND="$2"; shift 2 ;;
  --test-conn) TEST_CONN=1; shift ;;
  *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

FAILED=0
ok() { echo "[OK] $1"; }
miss() { echo "[MISSING] $1"; FAILED=1; }

echo "===== story-image 环境检查 =====";

# 1. 运行依赖
echo "--- 1. 运行依赖 ---";
command -v bash >/dev/null 2>&1 && ok "bash（脚本执行环境）" || miss "bash：需 Git Bash（Windows）或系统 bash，安装后重试"
command -v curl >/dev/null 2>&1 && ok "curl（API 请求）" || miss "curl：Windows 建议 Git Bash 自带；或 winget install curl"
for PYBIN in python3 python py; do command -v "$PYBIN" >/dev/null 2>&1 && break; done
if command -v "${PYBIN:-}" >/dev/null 2>&1; then ok "python/python3（JSON 处理）"; else miss "python：需 python3/python 任一（api-json.py 依赖）"; fi
command -v base64 >/dev/null 2>&1 && ok "base64（图片解码）" || miss "base64：Git Bash 自带；或装 coreutils"

# 2. 后端配置探测
echo "--- 2. 后端配置 ---";
BACKENDS="$(bash "$SCRIPT_DIR/imagegen.sh" --list-backends 2>/dev/null || true)";
if [ -n "$BACKENDS" ]; then
  echo "[OK] 已配置后端: $(echo "$BACKENDS" | tr "\n" " ")";
else
  miss "后端配置：未配置任何后端（GPT_IMAGE_API_KEY / GRSAI_API_KEY / ARK_API_KEY / DASHSCOPE_API_KEY / 自定义 conf / ComfyUI）——向用户询问提供 API Key 或选择后端"
fi

# 3. 指定后端专项
if [ -n "$BACKEND" ]; then
  echo "--- 3. 专项检查: $BACKEND ---";
  case "$BACKEND" in
  comfyui)
    COMFY_URL="${COMFYUI_URL:-http://127.0.0.1:8188}";
    if curl -fsS --max-time 3 "$COMFY_URL/system_stats" >/dev/null 2>&1; then
      ok "ComfyUI 可达 ($COMFY_URL)";
    else
      miss "ComfyUI 不可达 ($COMFY_URL)：请先启动 ComfyUI，或设置 COMFYUI_URL（本机整合包常见 8198 端口）";
    fi;
    if bash "$SCRIPT_DIR/imagegen-comfyui.sh" --list-workflows >/dev/null 2>&1; then
      ok "ComfyUI 工作流目录可枚举";
    else
      miss "ComfyUI 工作流目录：设置 COMFYUI_WORKFLOW_DIR 或提供工作流 JSON 路径";
    fi;
    ;;
  custom)
    CONF="$HOME/.story-image/custom-backend.conf";
    if [ -n "${CUSTOM_API_URL:-}" ] && [ -n "${CUSTOM_API_KEY:-}" ]; then
      ok "自定义 API 配置（环境变量）";
    elif [ -f "$CONF" ]; then
      ok "自定义 API 配置（$CONF）";
    else
      miss "自定义 API 未配置：走「自定义图像 API 接入」流程（文档 + key）";
    fi;
    if [ "$TEST_CONN" -eq 1 ] && [ -n "${CUSTOM_API_URL:-}" ]; then
      if curl -fsS --max-time 5 -o /dev/null "${CUSTOM_API_URL}" 2>/dev/null; then ok "自定义端点可达"; else miss "自定义端点不可达：$CUSTOM_API_URL"; fi;
    fi;
    ;;
  openai|grsai|volcengine|dashscope)
    KEY_VAR="";
    case "$BACKEND" in
    openai) KEY_VAR="GPT_IMAGE_API_KEY" ;;
    grsai) KEY_VAR="GRSAI_API_KEY" ;;
    volcengine) KEY_VAR="ARK_API_KEY" ;;
    dashscope) KEY_VAR="DASHSCOPE_API_KEY" ;;
    esac;
    if [ -n "${!KEY_VAR:-}" ]; then
      ok "$KEY_VAR 已配置";
    else
      miss "$KEY_VAR 未配置：向用户询问提供 API Key（或改用其他后端）";
    fi;
    ;;
  esac;
fi;

echo "";
if [ "$FAILED" -eq 1 ]; then
  echo "Result: 环境不满足（缺项见上）——先向用户询问/修复后再生成";
  exit 1;
fi;
echo "Result: 环境满足，可以生成";

#!/bin/bash
# imagegen.sh — 图像生成统一入口（后端自动探测 + 分发）
# 用法：bash imagegen.sh [backend] --prompt-file <文件> --size <规格> --out <输出PNG路径> [后端专属参数...]
#   backend ∈ {auto, openai, volcengine, dashscope, grsai, comfyui}，缺省 auto
#   auto 按已配置的 key 探测：GPT_IMAGE_API_KEY > GRSAI_API_KEY > ARK_API_KEY > DASHSCOPE_API_KEY > ComfyUI 可达
#   IMG_BACKEND 环境变量显式指定时可跳过探测
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

detect_backend() {
	if [ -n "${IMG_BACKEND:-}" ]; then
		case "$IMG_BACKEND" in
		openai | volcengine | dashscope | grsai | comfyui)
			echo "$IMG_BACKEND"
			return
			;;
		*)
			echo "IMG_BACKEND 非法值: $IMG_BACKEND（可选 auto/openai/volcengine/dashscope/grsai/comfyui）" >&2
			exit 2
			;;
		esac
	fi
	[ -n "${GPT_IMAGE_API_KEY:-}" ] && {
		echo openai
		return
	}
	[ -n "${GRSAI_API_KEY:-}" ] && {
		echo grsai
		return
	}
	[ -n "${ARK_API_KEY:-}" ] && {
		echo volcengine
		return
	}
	[ -n "${DASHSCOPE_API_KEY:-}" ] && {
		echo dashscope
		return
	}
	# ComfyUI 探测：显式配置了 URL，或默认端口有响应
	COMFY_URL="${COMFYUI_URL:-http://127.0.0.1:8188}"
	if [ -n "${COMFYUI_URL:-}" ] || curl -fsS --max-time 3 "$COMFY_URL/system_stats" >/dev/null 2>&1; then
		echo comfyui
		return
	fi
	echo "未探测到可用后端。请配置其一：GPT_IMAGE_API_KEY / GRSAI_API_KEY / ARK_API_KEY / DASHSCOPE_API_KEY / 本地 ComfyUI(COMFYUI_URL)；或 IMG_BACKEND 显式指定。" >&2
	exit 1
}

BACKEND="${1:-auto}"
case "$BACKEND" in
auto)
	BACKEND=$(detect_backend)
	shift || true
	;;
openai | volcengine | dashscope | grsai | comfyui) shift ;;
*)
	echo "未知后端: $BACKEND（可选 auto/openai/volcengine/dashscope/grsai/comfyui）" >&2
	exit 2
	;;
esac

exec bash "$SCRIPT_DIR/imagegen-$BACKEND.sh" "$@"

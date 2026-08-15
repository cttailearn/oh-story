#!/bin/bash
# imagegen.sh — 图像生成统一入口（后端自动探测 + 分发）
# 用法：bash imagegen.sh [backend] --prompt-file <文件> --size <规格> --out <输出PNG路径> [后端专属参数...]
#   backend ∈ {auto, openai, volcengine, dashscope, grsai, custom, comfyui}，缺省 auto
#   auto 按已配置的 key 探测：GPT_IMAGE_API_KEY > GRSAI_API_KEY > ARK_API_KEY > DASHSCOPE_API_KEY > custom 配置 > ComfyUI 可达
#   IMG_BACKEND 环境变量显式指定时可跳过探测
#   自定义后端：CUSTOM_API_URL + CUSTOM_API_KEY（或 ~/.story-image/custom-backend.conf），详见 imagegen-custom.sh
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

detect_backend() {
	if [ -n "${IMG_BACKEND:-}" ]; then
		case "$IMG_BACKEND" in
		openai | volcengine | dashscope | grsai | custom | comfyui)
			echo "$IMG_BACKEND"
			return
			;;
		*)
			echo "IMG_BACKEND 非法值: $IMG_BACKEND（可选 auto/openai/volcengine/dashscope/grsai/custom/comfyui）" >&2
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
	# 自定义 API：环境变量或 conf 文件已配置即探测到
	if [ -n "${CUSTOM_API_URL:-}" ] && [ -n "${CUSTOM_API_KEY:-}" ]; then
		echo custom
		return
	fi
	[ -f "$HOME/.story-image/custom-backend.conf" ] && {
		echo custom
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

# --list-backends：列出当前已配置的后端（供 skill 在调用前检测/询问用户），
# 每行一个后端名；无任何配置时退出码 1 且无输出。
list_backends() {
	FOUND=0
	[ -n "${GPT_IMAGE_API_KEY:-}" ] && {
		echo openai
		FOUND=1
	}
	[ -n "${GRSAI_API_KEY:-}" ] && {
		echo grsai
		FOUND=1
	}
	[ -n "${ARK_API_KEY:-}" ] && {
		echo volcengine
		FOUND=1
	}
	[ -n "${DASHSCOPE_API_KEY:-}" ] && {
		echo dashscope
		FOUND=1
	}
	if { [ -n "${CUSTOM_API_URL:-}" ] && [ -n "${CUSTOM_API_KEY:-}" ]; } || [ -f "$HOME/.story-image/custom-backend.conf" ]; then
		echo custom
		FOUND=1
	fi
	COMFY_URL="${COMFYUI_URL:-http://127.0.0.1:8188}"
	if [ -n "${COMFYUI_URL:-}" ] || curl -fsS --max-time 3 "$COMFY_URL/system_stats" >/dev/null 2>&1; then
		echo comfyui
		FOUND=1
	fi
	[ "$FOUND" -eq 1 ] || exit 1
}

if [ "${1:-}" = "--list-backends" ]; then
	list_backends
	exit 0
fi

BACKEND="${1:-auto}"
case "$BACKEND" in
auto)
	BACKEND=$(detect_backend)
	shift || true
	;;
openai | volcengine | dashscope | grsai | custom | comfyui) shift ;;
*)
	echo "未知后端: $BACKEND（可选 auto/openai/volcengine/dashscope/grsai/custom/comfyui）" >&2
	exit 2
	;;
esac

exec bash "$SCRIPT_DIR/imagegen-$BACKEND.sh" "$@"

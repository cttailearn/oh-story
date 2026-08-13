#!/bin/bash
# imagegen-comfyui.sh — 本地 ComfyUI 后端（用户自选工作流 → 注入提示词 → 提交 → 轮询 → 下载）
# 用法：
#   列出本地已有工作流：bash imagegen-comfyui.sh --list-workflows [目录]
#     目录缺省时自动探测（通用规则）：显式参数 > COMFYUI_WORKFLOW_DIR > ~/ComfyUI 默认路径
#     > 便携版常见位置 > 从运行中的 ComfyUI 进程反推；探测失败会提示手动输入路径
#     列表会标注工作流类型（文生图/图生图/视频/其他）
#   生成：bash imagegen-comfyui.sh --workflow <API格式JSON路径> --prompt <提示词> --out <输出PNG路径>
#         [--negative <负向提示词>] [--timeout <秒，默认300>] [--ckpt <检查点名>]
# 环境：COMFYUI_URL(默认 http://127.0.0.1:8188)、COMFY_CKPT、COMFYUI_WORKFLOW_DIR
# 依赖：curl + python（JSON 处理内置于同目录 comfyui-json.py，无需 jq/uuidgen）
# 提示词注入规则：
#   1) 工作流含 __PROMPT__/__NEGATIVE__/__CKPT__ 占位符 → 直接替换（推荐，最可控）
#   2) 无占位符 → 自动注入到 CLIPTextEncode 节点：节点 ID 最小者=正向提示词，次小者=负向提示词，
#      并打印注入位置供核对
# 注意：只接受 API 格式（ComfyUI 里 Workflow → Save (API Format) 导出）；
#       UI 格式可用同目录 ui2api.py 转换（实验性），或先在 ComfyUI 中导出。
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
JSONPY="$SCRIPT_DIR/comfyui-json.py"

# ---- 工作流列表模式 ----
if [ "${1:-}" = "--list-workflows" ]; then
	# Windows 路径转 MSYS 风格（Git Bash 的 -d/-f 检查需要；Linux/macOS 无 cygpath 时原样）
	msys_path() {
		if command -v cygpath >/dev/null 2>&1; then
			cygpath -u "$1" 2>/dev/null || echo "$1"
		else
			echo "$1"
		fi
	}
	EXPLICIT="${2:-}"
	if [ -n "$EXPLICIT" ] && [ -d "$EXPLICIT" ]; then
		DIR="$EXPLICIT"
	else
		# 自动探测：COMFYUI_WORKFLOW_DIR → 默认路径 → 便携版常见位置 → 进程反推（全通用规则）
		FOUND=()
		while IFS= read -r line; do
			[ -n "$line" ] && FOUND+=("$line")
		done < <(python "$JSONPY" discover-workflows "$EXPLICIT" 2>/dev/null || true)
		case "${#FOUND[@]}" in
		0)
			echo "未自动发现工作流目录。已尝试：环境变量 COMFYUI_WORKFLOW_DIR、~/ComfyUI 默认路径、" >&2
			echo "便携版常见位置、正在运行的 ComfyUI 进程（确保 ComfyUI 已启动有助于探测）。" >&2
			if [ -t 0 ]; then
				printf '请输入工作流目录路径（或直接回车跳过）：' >&2
				read -r -t 15 USER_DIR || true
				[ -n "${USER_DIR:-}" ] && [ -d "$(msys_path "$USER_DIR")" ] && DIR="$(msys_path "$USER_DIR")"
			fi
			if [ -z "${DIR:-}" ]; then
				echo "请设置 COMFYUI_WORKFLOW_DIR 指向工作流 JSON 目录后重试，或直接在 ComfyUI 中 Workflow → Export (API) 导出后传入文件路径。" >&2
				exit 1
			fi
			;;
		1)
			DIR="$(msys_path "${FOUND[0]}")"
			;;
		*)
			# 多个候选：列出让用户选（非交互时默认取第一个）
			echo "发现多个工作流目录：" >&2
			i=1
			for d in "${FOUND[@]}"; do
				echo "  $i) $(msys_path "$d")" >&2
				i=$((i + 1))
			done
			DIR="$(msys_path "${FOUND[0]}")"
			if [ -t 0 ]; then
				printf '请输入序号（回车默认 1）：' >&2
				read -r -t 15 CHOICE || true
				if [ -n "${CHOICE:-}" ] && [ "$CHOICE" -ge 1 ] 2>/dev/null && [ "$CHOICE" -le "${#FOUND[@]}" ]; then
					DIR="$(msys_path "${FOUND[$((CHOICE - 1))]}")"
				fi
			fi
			;;
		esac
	fi
	[ -d "$DIR" ] || {
		echo "工作流目录不存在: $DIR" >&2
		exit 1
	}
	echo "工作流目录: $DIR" >&2
	for f in "$DIR"/*.json "$DIR"/*.JSON; do
		[ -f "$f" ] || continue
		KIND=$(python "$JSONPY" wf-kind "$f" 2>/dev/null || echo 其他)
		printf '%s  [%s]\n' "$(basename "$f")" "$KIND"
	done
	echo "提示：列表含 UI 格式时可用同目录 ui2api.py 转成 API 格式后再用。" >&2
	exit 0
fi

WORKFLOW=""
PROMPT=""
NEGATIVE=""
OUT=""
TIMEOUT=300
CKPT=""
while [ $# -gt 0 ]; do
	case "$1" in
	--workflow)
		WORKFLOW="$2"
		shift 2
		;;
	--prompt)
		PROMPT="$2"
		shift 2
		;;
	--negative)
		NEGATIVE="$2"
		shift 2
		;;
	--out)
		OUT="$2"
		shift 2
		;;
	--timeout)
		TIMEOUT="$2"
		shift 2
		;;
	--ckpt)
		CKPT="$2"
		shift 2
		;;
	*)
		echo "未知参数: $1" >&2
		exit 2
		;;
	esac
done

: "${WORKFLOW:?缺少 --workflow（先用 --list-workflows 查看本地工作流，选定后传入其路径）}"
: "${PROMPT:?缺少 --prompt}"
: "${OUT:?缺少 --out}"
: "${COMFYUI_URL:=http://127.0.0.1:8188}"
CKPT="${CKPT:-${COMFY_CKPT:-}}"
command -v python >/dev/null 2>&1 || {
	echo "需要 python（JSON 处理依赖，Windows 建议 G:\\AI\\miniconda3\\python.exe 加入 PATH）" >&2
	exit 1
}

mkdir -p "$(dirname "$OUT")"

# UI 格式检测
FMT=$(python "$JSONPY" format "$WORKFLOW" 2>/dev/null || true)
if [ "$FMT" != "api" ]; then
	echo "工作流不是 API 格式（检测到 UI format），无法直接提交。" >&2
	echo "请在 ComfyUI 中打开该工作流，菜单 Workflow → Export (API)，另存为 API 格式 JSON 后传入。" >&2
	echo "或尝试同目录转换脚本：python \"$SCRIPT_DIR/ui2api.py\" --url \"$COMFYUI_URL\" --input \"$WORKFLOW\" --output 输出路径" >&2
	exit 1
fi

# 占位符替换 / 自动注入（结果输出到 stdout，注入信息到 stderr）
INJECT_INFO=$(mktemp)
WF_JSON=$(python "$JSONPY" inject "$WORKFLOW" --prompt "$PROMPT" ${NEGATIVE:+--negative "$NEGATIVE"} ${CKPT:+--ckpt "$CKPT"} 2>"$INJECT_INFO") || {
	echo "提示词注入失败（请确认工作流含 __PROMPT__ 占位符或有 CLIPTextEncode 节点）" >&2
	echo "  原因：$(cat "$INJECT_INFO")" >&2
	exit 1
}
case "$(cat "$INJECT_INFO")" in
injected:placeholder*) echo "已按占位符注入提示词（__PROMPT__/__NEGATIVE__/__CKPT__）" ;;
injected:auto:*)
	NODES=$(cat "$INJECT_INFO" | cut -d: -f3-)
	echo "工作流无占位符，已自动注入提示词到 CLIPTextEncode 节点 [$NODES]（正向=最小ID，负向=次小ID），请核对生成效果"
	;;
esac
rm -f "$INJECT_INFO"

CLIENT_ID="story-image-$(python -c 'import uuid;print(uuid.uuid4())')"
RESP=$(mktemp)
HIST=$(mktemp)
trap 'rm -f "$RESP" "$HIST"' EXIT

curl -fsS --max-time 60 \
	"$COMFYUI_URL/prompt" \
	-H "Content-Type: application/json" \
	-d "$(python -c "
import json,sys
sys.stdout.reconfigure(encoding='utf-8',errors='replace')
wf=json.loads(sys.argv[1])
print(json.dumps({'prompt':wf,'client_id':sys.argv[2]},ensure_ascii=False))
" "$WF_JSON" "$CLIENT_ID")" >"$RESP"

NODEINFO=$(python "$JSONPY" nodeinfo "$RESP")
case "$NODEINFO" in
node_errors:*)
	echo "工作流节点错误：" >&2
	echo "${NODEINFO#node_errors:}" | python -m json.tool >&2
	exit 1
	;;
error:*)
	echo "提交失败：" >&2
	echo "${NODEINFO#error:}" >&2
	exit 1
	;;
prompt_id:*)
	PROMPT_ID="${NODEINFO#prompt_id:}"
	;;
*)
	echo "提交响应异常：" >&2
	head -c 300 "$RESP" >&2
	exit 1
	;;
esac

# 轮询 history
DEADLINE=$((SECONDS + TIMEOUT))
FOUND=0
while [ $SECONDS -lt $DEADLINE ]; do
	curl -fsS --max-time 30 "$COMFYUI_URL/history/$PROMPT_ID" >"$HIST" 2>/dev/null || true
	IMGINFO=$(python "$JSONPY" firstimage "$HIST" "$PROMPT_ID" 2>/dev/null || true)
	if [ -n "$IMGINFO" ]; then
		FOUND=1
		break
	fi
	sleep 2
done
[ "$FOUND" = "1" ] || {
	echo "ComfyUI 出图超时（${TIMEOUT}s）：prompt_id=$PROMPT_ID" >&2
	exit 1
}

FILENAME=$(printf '%s' "$IMGINFO" | cut -f1)
SUBFOLDER=$(printf '%s' "$IMGINFO" | cut -f2)
TYPE=$(printf '%s' "$IMGINFO" | cut -f3)

curl -fsS --max-time 120 -o "$OUT" \
	--get "$COMFYUI_URL/view" \
	--data-urlencode "filename=$FILENAME" \
	--data-urlencode "subfolder=$SUBFOLDER" \
	--data-urlencode "type=$TYPE"

[ -s "$OUT" ] || {
	echo "下载为空: $OUT" >&2
	exit 1
}
printf '%s\n' "$PROMPT" >"${OUT%.png}.prompt.txt"
echo "OK: $OUT"

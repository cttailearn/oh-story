#!/bin/bash
# imagegen-comfyui.sh — 本地 ComfyUI 后端（用户自选工作流 → 注入提示词 → 提交 → 轮询 → 下载）
# 用法：
#   列出本地已有工作流：bash imagegen-comfyui.sh --list-workflows [目录]
#     目录默认 ${COMFYUI_WORKFLOW_DIR:-$HOME/ComfyUI/user/default/workflows}
#   生成：bash imagegen-comfyui.sh --workflow <API格式JSON路径> --prompt <提示词> --out <输出PNG路径>
#         [--negative <负向提示词>] [--timeout <秒，默认300>] [--ckpt <检查点名>]
# 环境：COMFYUI_URL(默认 http://127.0.0.1:8188)、COMFY_CKPT、COMFYUI_WORKFLOW_DIR
# 提示词注入规则：
#   1) 工作流含 __PROMPT__/__NEGATIVE__/__CKPT__ 占位符 → 直接替换（推荐，最可控）
#   2) 无占位符 → 自动注入到 CLIPTextEncode 节点：节点 ID 最小者=正向提示词，次小者=负向提示词，
#      并打印注入位置供核对
# 注意：只接受 API 格式（ComfyUI 里 Save (API Format) 导出）；UI 格式请先在 ComfyUI 中转换。
set -euo pipefail

# ---- 工作流列表模式 ----
if [ "${1:-}" = "--list-workflows" ]; then
	DIR="${2:-${COMFYUI_WORKFLOW_DIR:-$HOME/ComfyUI/user/default/workflows}}"
	[ -d "$DIR" ] || {
		echo "工作流目录不存在: $DIR" >&2
		echo "可设置 COMFYUI_WORKFLOW_DIR 指向你的工作流 JSON 目录（需 API 格式导出）" >&2
		exit 1
	}
	for f in "$DIR"/*.json "$DIR"/*.JSON; do
		[ -f "$f" ] && basename "$f"
	done
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
command -v jq >/dev/null 2>&1 || {
	echo "需要 jq" >&2
	exit 1
}
command -v uuidgen >/dev/null 2>&1 || {
	echo "需要 uuidgen" >&2
	exit 1
}

mkdir -p "$(dirname "$OUT")"

# UI 格式检测：界面导出的 JSON 顶层有 nodes 数组 + links；API 格式是 {节点ID: {...}}
if jq -e '.nodes // .links // empty' "$WORKFLOW" >/dev/null 2>&1; then
	echo "这是 ComfyUI 界面格式（UI format），无法直接提交。" >&2
	echo "请在 ComfyUI 中打开该工作流，菜单 Workflow → Export (API)，另存为 API 格式 JSON 后传入。" >&2
	exit 1
fi

# 1) 占位符替换（__PROMPT__/__NEGATIVE__/__CKPT__）
WF_JSON=$(jq --arg p "$PROMPT" --arg n "${NEGATIVE:-}" --arg c "$CKPT" \
	'walk(if type=="string" then
          (if .=="__PROMPT__" then $p elif .=="__NEGATIVE__" then $n elif .=="__CKPT__" then $c else . end)
        else . end)' "$WORKFLOW")

# 2) 无占位符 → 自动注入 CLIPTextEncode（ID 最小=positive，次小=negative）
HAS_PROMPT=$(printf '%s' "$WF_JSON" | jq --arg p "$PROMPT" '[.. | strings | select(. == $p)] | length > 0')
if [ "$HAS_PROMPT" != "true" ]; then
	WF_JSON=$(printf '%s' "$WF_JSON" | jq --arg p "$PROMPT" --arg n "${NEGATIVE:-}" '
		. as $wf
		| ($wf | to_entries | map(select(.value.class_type == "CLIPTextEncode")) | sort_by(.key | tonumber)) as $enc
		| if ($enc | length) == 0 then
			error("工作流里没有 CLIPTextEncode 节点，无法自动注入提示词；请在工作流中把提示词节点文本设为 __PROMPT__ 后重试")
		  else
			reduce $enc[] as $e ($wf;
				if $e.key == $enc[0].key then .[$e.key].inputs.text = $p
				elif $e.key == ($enc[1].key // "") and ($n | length) > 0 then .[$e.key].inputs.text = $n
				else . end)
		  end')
	INJECTED=$(printf '%s' "$WF_JSON" | jq -r 'to_entries | map(select(.value.class_type == "CLIPTextEncode")) | sort_by(.key | tonumber) | map(.key) | join(",")')
	echo "工作流无占位符，已自动注入提示词到 CLIPTextEncode 节点 [$INJECTED]（正向=最小ID，负向=次小ID），请核对生成效果"
fi

CLIENT_ID="story-image-$(uuidgen)"
RESP=$(mktemp)
HIST=$(mktemp)
trap 'rm -f "$RESP" "$HIST"' EXIT

curl -fsS --max-time 60 \
	"$COMFYUI_URL/prompt" \
	-H "Content-Type: application/json" \
	-d "$(jq -n --argjson wf "$WF_JSON" --arg cid "$CLIENT_ID" '{prompt:$wf, client_id:$cid}')" >"$RESP"

if jq -e '.node_errors // empty' "$RESP" >/dev/null 2>&1; then
	echo "工作流节点错误：" >&2
	jq '.node_errors' "$RESP" >&2
	exit 1
fi
PROMPT_ID=$(jq -er '.prompt_id // empty' "$RESP")
[ -n "$PROMPT_ID" ] || {
	echo "响应缺 prompt_id：" >&2
	head -c 300 "$RESP" >&2
	exit 1
}

# 轮询 history
DEADLINE=$((SECONDS + TIMEOUT))
FOUND=0
while [ $SECONDS -lt $DEADLINE ]; do
	curl -fsS --max-time 30 "$COMFYUI_URL/history/$PROMPT_ID" >"$HIST" 2>/dev/null || true
	IMG=$(jq -er ".\"$PROMPT_ID\".outputs // {} | to_entries[].value.images[0] // empty" "$HIST" 2>/dev/null || true)
	if [ -n "$IMG" ]; then
		FOUND=1
		break
	fi
	sleep 2
done
[ "$FOUND" = "1" ] || {
	echo "ComfyUI 出图超时（${TIMEOUT}s）：prompt_id=$PROMPT_ID" >&2
	exit 1
}

FILENAME=$(jq -er ".\"$PROMPT_ID\".outputs | to_entries[].value.images[0].filename" "$HIST")
SUBFOLDER=$(jq -er ".\"$PROMPT_ID\".outputs | to_entries[].value.images[0].subfolder // empty" "$HIST")
TYPE=$(jq -er ".\"$PROMPT_ID\".outputs | to_entries[].value.images[0].type // \"output\"" "$HIST")

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

#!/bin/bash
# test-outline-detail.sh — regression tests for the outline-detail detector.
# 覆盖：完整细纲 OK、缺硬字段 THIN、--check 退出码、预算合计与字数目标数值核对、
# 按需字段/细化子项 warning 不阻断、多文件与目录参数、三副本一致性。
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$REPO_ROOT" ]; then
	echo "Error: not in a git repository" >&2
	exit 1
fi

SCRIPT="$REPO_ROOT/skills/story-long-write/scripts/check-outline-detail.js"
COPIES=(
	"$REPO_ROOT/skills/story-long-write/scripts/check-outline-detail.js"
	"$REPO_ROOT/skills/story-deslop/scripts/check-outline-detail.js"
	"$REPO_ROOT/skills/story-review/scripts/check-outline-detail.js"
)
for copy in "${COPIES[@]}"; do
	node --check "$copy" >/dev/null
	cmp -s "$SCRIPT" "$copy" || {
		echo "FAIL: outline-detail detector drifted from story-long-write source: $copy" >&2
		exit 1
	}
done

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
mkdir -p "$TMP_DIR/大纲/细纲"

fail() {
	echo "FAIL: $1" >&2
	exit 1
}

# 完整细纲（硬字段 13 项齐 + 预算合计在 [目标, ×1.1] 内）
cat >"$TMP_DIR/大纲/细纲/第001章.md" <<'EOF'
# 细纲（第 1 章）

### 第1章：初见
- 核心事件：主角推开茶馆的门，与掌柜初次交锋
- 字数目标：3000 字
- 阶段位置：开篇期第 1 章
- 单元ID/位置：U1 第 1 拍
- 目标情绪：好奇 → 警觉
- 主角目标/关键选择：拿到信物；选择亮出身份
- 本章禁止提前释放：天机阁幕后
- 章节定位：推进
- 本章设定引用：角色卡:主角/掌柜；世界观:茶馆

#### 内容概括（五段式）
- 起因：雨夜
- 发展：进门
- 转折：掌柜认出他
- 高潮：亮出信物
- 结尾：约定三日后再来

#### 情节安排（多线）
- 主线推进：信物线索
- 辅线推进：无

#### 人物关系和出场顺序
- 出场顺序：主角、掌柜
- 人物关系变化：陌生 → 相识
- 视角/信息差：读者知道信物真伪，主角不知

#### 情节细化
- 情节点1：主角推门【铺垫·疏40】
- 情节点2：掌柜试探【推进·密250】
- 情节点3：亮信物【高潮·密400】
- 情节点4：掌柜变脸【转折·密250】
- 情节点5：约定取账【收束·疏40】
- 预算合计：3000字（目标3000，范围3000-3300）

#### 结尾设定和钩子
- 结尾设定：约定三日
- 章尾钩子：三日之约 — 期待度：中
EOF
OUT=$(node "$SCRIPT" "$TMP_DIR/大纲/细纲/第001章.md")
echo "$OUT" | grep -q "\[OK\]" || fail "case1: 完整细纲应 OK，实际: $OUT"
echo "$OUT" | grep -q "硬字段 13/13" || fail "case1: 应显示硬字段 13/13，实际: $OUT"

# 用例 2：缺情节细化 + 结尾设定和钩子 → THIN，--check exit 1
cat >"$TMP_DIR/大纲/细纲/第002章.md" <<'EOF'
# 细纲（第 2 章）

### 第2章：赶路
- 核心事件：主角赶路
- 字数目标：3000 字
- 阶段位置：开篇期第 2 章
- 单元ID/位置：U1 第 2 拍
- 目标情绪：平静
- 主角目标/关键选择：赶路
- 本章禁止提前释放：无
- 本章设定引用：角色卡:主角

#### 内容概括（五段式）
- 起因：出发
- 发展：遇雨
- 转折：借宿
- 高潮：夜谈
- 结尾：天明
EOF
OUT=$(node "$SCRIPT" "$TMP_DIR/大纲/细纲/第002章.md")
echo "$OUT" | grep -q "\[THIN\]" || fail "case2: 缺执行层字段应 THIN，实际: $OUT"
echo "$OUT" | grep -q "情节细化" || fail "case2: 应点名情节细化，实际: $OUT"
echo "$OUT" | grep -q "结尾设定和钩子" || fail "case2: 应点名结尾设定和钩子，实际: $OUT"
node "$SCRIPT" --check "$TMP_DIR/大纲/细纲/第002章.md" >/dev/null 2>&1 && fail "case2: --check 应 exit 1"

# 用例 3：预算合计低于字数目标 → warning 但不 THIN
cat >"$TMP_DIR/大纲/细纲/第003章.md" <<'EOF'
# 细纲（第 3 章）

### 第3章：夜宿
- 核心事件：夜宿客栈
- 字数目标：3000 字
- 阶段位置：开篇期第 3 章
- 单元ID/位置：U1 第 3 拍
- 目标情绪：疲惫 → 放松
- 主角目标/关键选择：休息
- 本章禁止提前释放：无
- 章节定位：低压
- 本章设定引用：角色卡:主角

#### 内容概括（五段式）
- 起因：到店
- 发展：用饭
- 转折：邻桌议论
- 高潮：听见线索
- 结尾：入睡

#### 情节安排（多线）
- 主线推进：线索

#### 人物关系和出场顺序
- 出场顺序：主角、掌柜
- 人物关系变化：无
- 视角/信息差：无

#### 情节细化
- 情节点1：到店【疏40】
- 情节点2：用饭【疏40】
- 情节点3：听见线索【密250】
- 预算合计：1500字（目标3000，范围3000-3300）

#### 结尾设定和钩子
- 结尾设定：入睡
- 章尾钩子：线索 — 期待度：弱
EOF
OUT=$(node "$SCRIPT" "$TMP_DIR/大纲/细纲/第003章.md")
echo "$OUT" | grep -q "\[OK\]" || fail "case3: 预算低于目标应仍 OK（warning 不阻断），实际: $OUT"
echo "$OUT" | grep -q "预算合计 1500 < 字数目标下限 3000" || fail "case3: 应报预算核对 warning，实际: $OUT"
node "$SCRIPT" --check "$TMP_DIR/大纲/细纲/第003章.md" >/dev/null 2>&1 || fail "case3: 仅 warning 时 --check 应 exit 0"

# 用例 4：目录参数扫全部 .md，且 --json 输出结构化
OUT=$(node "$SCRIPT" --json "$TMP_DIR/大纲/细纲")
echo "$OUT" | grep -q '"thin": true' || fail "case4: --json 应含 thin:true，实际: $OUT"
echo "$OUT" | grep -q '"missingHard"' || fail "case4: --json 应含 missingHard，实际: $OUT"
# 3 个细纲文件都应被扫到
COUNT=$(echo "$OUT" | grep -c '"file":')
[ "$COUNT" -eq 3 ] || fail "case4: 应扫到 3 个文件，实际 $COUNT"

# 用例 5：不可读文件 / 空参数
node "$SCRIPT" --check "$TMP_DIR/大纲/细纲/不存在.md" >/dev/null 2>&1 && fail "case5: 文件不存在应报 ERROR"
node "$SCRIPT" >/dev/null 2>&1 && fail "case5: 无参数应 exit 2"

# 用例 6：真实细纲兼容性——demo 细纲（旧版写法，有情节细化节但无预算合计）
DEMO="$REPO_ROOT/demo/长篇/让你管账号，你高燃混剪炸全网/大纲/细纲/第001章.md"
if [ -f "$DEMO" ]; then
	OUT=$(node "$SCRIPT" "$DEMO")
	echo "$OUT" | grep -q "\[THIN\]" || fail "case6: demo 旧细纲应 THIN（缺新硬字段），实际: $OUT"
	echo "$OUT" | grep -q "预算合计" || fail "case6: 应报预算合计 warning，实际: $OUT"
fi

# 用例 7：硬字段齐全但内容空洞 → LEAN，--check exit 1，--json status=LEAN
mkdir -p "$TMP_DIR/leancases"
cat >"$TMP_DIR/leancases/空洞章.md" <<'EOF'
# 细纲（第 N 章）

### 第N章：空洞
- 核心事件：主角做事
- 字数目标：3000 字
- 阶段位置：发展期第 1 章
- 单元ID/位置：U2 第 1 拍
- 目标情绪：平静
- 主角目标/关键选择：做事
- 本章禁止提前释放：无
- 章节定位：推进
- 本章设定引用：无

#### 内容概括（五段式）
- 起因：略
- 发展：略
- 转折：略
- 高潮：略
- 结尾：略

#### 情节安排（多线）
- 主线推进：无

#### 人物关系和出场顺序
- 出场顺序：主角
- 人物关系变化：无

#### 情节细化
- 情节点1：对话
- 情节点2：离开
- 预算合计：3000字

#### 结尾设定和钩子
- 结尾设定：就这样
- 章尾钩子：无
EOF
OUT=$(node "$SCRIPT" "$TMP_DIR/leancases/空洞章.md")
echo "$OUT" | grep -q "[LEAN]" || fail "case7: 空洞细纲应 LEAN，实际: $OUT"
echo "$OUT" | grep -q "目标情绪缺少" || fail "case7: 应报目标情绪前后态，实际: $OUT"
node "$SCRIPT" --check "$TMP_DIR/leancases/空洞章.md" >/dev/null 2>&1 && fail "case7: --check 应 exit 1（LEAN 阻断）"
JSON=$(node "$SCRIPT" --json "$TMP_DIR/leancases/空洞章.md")
echo "$JSON" | grep -q '"status": "LEAN"' || fail "case7: --json 应含 status LEAN，实际: $JSON"

# 用例 8：低压章 3 点 + 密疏标注 → 豁免 LEAN，OK
cat >"$TMP_DIR/leancases/低压章.md" <<'EOF'
# 细纲（第 M 章）

### 第M章：歇脚
- 核心事件：主角在驿站歇脚
- 字数目标：2500 字
- 阶段位置：发展期第 2 章
- 单元ID/位置：U2 第 2 拍
- 目标情绪：疲惫 → 释然
- 主角目标/关键选择：休整
- 本章禁止提前释放：无
- 章节定位：低压生活
- 本章设定引用：角色卡:主角

#### 内容概括（五段式）
- 起因：赶路三日
- 发展：驿站伙计认错人
- 转折：主角借机掩盖行踪
- 高潮：安静一夜
- 结尾：天光上路

#### 情节安排（多线）
- 主线推进：无，喘息章

#### 人物关系和出场顺序
- 出场顺序：主角、伙计
- 人物关系变化：无

#### 情节细化
- 情节点1：进驿站【过场·疏40】
- 情节点2：回忆来路【人物塑造·密250】
- 情节点3：天光上路【铺垫·疏40】
- 预算合计：2500字（目标2500，范围2500-2750）

#### 结尾设定和钩子
- 结尾设定：天光上路
- 章尾钩子：弱钩子 — 期待度：弱
EOF
OUT=$(node "$SCRIPT" "$TMP_DIR/leancases/低压章.md")
echo "$OUT" | grep -q "[OK]" || fail "case8: 低压章 3 点应 OK（豁免），实际: $OUT"

# 用例 9：短章（<1500 字）3 点 → 豁免 LEAN，OK
cat >"$TMP_DIR/leancases/短章.md" <<'EOF'
# 细纲（第 K 章）

### 第K章：一页信
- 核心事件：主角拆信
- 字数目标：1200 字
- 阶段位置：发展期第 3 章
- 单元ID/位置：U2 第 3 拍
- 目标情绪：平静 → 震动
- 主角目标/关键选择：读信
- 本章禁止提前释放：无
- 章节定位：推进
- 本章设定引用：无

#### 内容概括（五段式）
- 起因：信送到
- 发展：主角拆信
- 转折：只有一行字
- 高潮：认出笔迹
- 结尾：信纸落地

#### 情节安排（多线）
- 主线推进：信物线索浮出

#### 人物关系和出场顺序
- 出场顺序：主角、信
- 人物关系变化：无

#### 情节细化
- 情节点1：收信【铺垫·疏40】
- 情节点2：拆信【推进·密250】
- 情节点3：认出笔迹【转折·密250】
- 预算合计：1200字（目标1200，范围1200-1320）

#### 结尾设定和钩子
- 结尾设定：信纸落地
- 章尾钩子：笔迹是谁 — 期待度：中
EOF
OUT=$(node "$SCRIPT" "$TMP_DIR/leancases/短章.md")
echo "$OUT" | grep -q "[OK]" || fail "case9: 短章 3 点应 OK（豁免），实际: $OUT"

# 用例 10：模板式情节点写法（无「情节点N：」前缀，直接列表项+密/疏标注）→ 识别为情节点，OK
cat >"$TMP_DIR/leancases/模板式.md" <<'EOF'
# 细纲（第 P 章）

### 第P章：模板式
- 核心事件：模板式事件
- 字数目标：3000 字
- 阶段位置：开篇期第 1 章
- 单元ID/位置：U1 第 1 拍
- 目标情绪：平静 → 紧张
- 主角目标/关键选择：测试
- 本章禁止提前释放：无
- 章节定位：推进
- 本章设定引用：无

#### 内容概括（五段式）
- 起因：事件发生
- 发展：冲突推进
- 转折：局势变化
- 高潮：情绪峰值
- 结尾：落点明确

#### 情节安排（多线）
- 主线推进：测试推进

#### 人物关系和出场顺序
- 出场顺序：主角
- 人物关系变化：无

#### 情节细化
- 主角推门【铺垫·疏40】
- 掌柜试探【推进·密250】
- 认出信物【信息揭示·密250】
- 亮出信物【高潮·密400】
- 约定三日【收束·疏40】
- 离开茶馆【铺垫·疏40】
- 预算合计：3000字（目标3000，范围3000-3300）

#### 结尾设定和钩子
- 结尾设定：约定三日后取账本
- 章尾钩子：三日之约 — 期待度：中
EOF
OUT=$(node "$SCRIPT" "$TMP_DIR/leancases/模板式.md")
echo "$OUT" | grep -q "[OK]" || fail "case10: 模板式情节点写法应 OK（6 点识别），实际: $OUT"

# 用例 11：预算合计区间写法（8000-8800字）→ 解析成功，无预算警告
cat >"$TMP_DIR/leancases/预算区间.md" <<'EOF'
# 细纲（第 Q 章）

### 第Q章：预算区间
- 核心事件：区间事件
- 字数目标：8000 字
- 阶段位置：发展期第 1 章
- 单元ID/位置：U2 第 1 拍
- 目标情绪：平静 → 紧张
- 主角目标/关键选择：测试
- 本章禁止提前释放：无
- 章节定位：推进
- 本章设定引用：无

#### 内容概括（五段式）
- 起因：事件发生
- 发展：冲突推进
- 转折：局势变化
- 高潮：情绪峰值
- 结尾：落点明确

#### 情节安排（多线）
- 主线推进：测试推进

#### 人物关系和出场顺序
- 出场顺序：主角
- 人物关系变化：无

#### 情节细化
- 情节点1：主角推门【铺垫·疏40】
- 情节点2：掌柜试探【推进·密250】
- 情节点3：认出信物【信息揭示·密250】
- 情节点4：亮出信物【高潮·密400】
- 情节点5：约定三日【收束·疏40】
- 情节点6：离开茶馆【铺垫·疏40】
- 预算合计：8000-8800字（目标8000）

#### 结尾设定和钩子
- 结尾设定：约定三日后取账本
- 章尾钩子：三日之约 — 期待度：中
EOF
OUT=$(node "$SCRIPT" "$TMP_DIR/leancases/预算区间.md")
echo "$OUT" | grep -q "[OK]" || fail "case11: 预算区间写法应 OK，实际: $OUT"
echo "$OUT" | grep -q "预算合计 8" && fail "case11: 预算区间不应报预算警告，实际: $OUT"

echo "PASS: test-outline-detail.sh"

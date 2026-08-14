#!/bin/bash
# test-outline-copy.sh — regression tests for the outline-copy detector.
# 覆盖：锚句豁免（片段头/尾/中间、整体等于锚句、字段写「无」、存量细纲无该字段）、
# 正常正文无命中、照搬正文命中、--check 退出码、一次传多章各自比对、三副本一致性。
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$REPO_ROOT" ]; then
  echo "Error: not in a git repository" >&2
  exit 1
fi

SCRIPT="$REPO_ROOT/skills/story-deslop/scripts/check-outline-copy.js"
COPIES=(
  "$REPO_ROOT/skills/story-deslop/scripts/check-outline-copy.js"
  "$REPO_ROOT/skills/story-long-write/scripts/check-outline-copy.js"
  "$REPO_ROOT/skills/story-review/scripts/check-outline-copy.js"
)
for copy in "${COPIES[@]}"; do
  node --check "$copy" >/dev/null
  cmp -s "$SCRIPT" "$copy" || {
    echo "FAIL: outline-copy detector drifted from story-deslop source: $copy" >&2
    exit 1
  }
done

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
mkdir -p "$TMP_DIR/正文" "$TMP_DIR/大纲/细纲"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# 细纲模板（带复沓锚句字段 + 一条成品散文句情节点）
cat > "$TMP_DIR/大纲/细纲/第001章.md" << 'EOF'
# 细纲（第 1 章）

### 第1章：初见

- 复沓锚句：
  - "天机阁的规矩，从不问客从何来。"
  - "这盏茶，喝了就是缘分。"
- 情节细化：
  - 情节点：主角推门，雨声灌进来，掌柜抬头看他
EOF

# 用例 1：正常正文 + 锚句原样（应无命中）
cat > "$TMP_DIR/正文/第001章_初见.md" << 'EOF'
# 第1章 初见

雨夜，主角推开茶馆的门，雨声灌进来，掌柜抬头看他。

"天机阁的规矩，从不问客从何来。"掌柜说着，把茶盏推过来。

"这盏茶，喝了就是缘分。"
EOF
OUT=$(node "$SCRIPT" "$TMP_DIR/正文/第001章_初见.md")
echo "$OUT" | grep -q "\[OK\]" || fail "case1: 正常正文应 OK，实际: $OUT"
echo "$OUT" | grep -q "锚句 2 条已豁免" || fail "case1: 应豁免 2 条锚句，实际: $OUT"

# 用例 2：照搬情节点成品句（应命中）
cat > "$TMP_DIR/正文/第001章_初见.md" << 'EOF'
# 第1章 初见

雨夜，他推开门，说了一句：主角推门，雨声灌进来，掌柜抬头看他，这盏茶喝下去就算进了门。
EOF
node "$SCRIPT" --check "$TMP_DIR/正文/第001章_初见.md" >/dev/null 2>&1 && fail "case2: 照搬应 exit 1"

# 用例 3：锚句在片段中间（正文嵌锚句于叙述中，应豁免）
cat > "$TMP_DIR/正文/第001章_初见.md" << 'EOF'
# 第1章 初见

他进门时雨正大。掌柜说"天机阁的规矩，从不问客从何来"，随后把茶推过来。他接过，掌柜补了一句"这盏茶，喝了就是缘分"。
EOF
OUT=$(node "$SCRIPT" "$TMP_DIR/正文/第001章_初见.md")
echo "$OUT" | grep -q "\[OK\]" || fail "case3: 锚句嵌中间应 OK，实际: $OUT"

# 用例 4：存量细纲无锚句字段（应照常检测，无豁免）
cat > "$TMP_DIR/大纲/细纲/第001章.md" << 'EOF'
# 细纲（第 1 章）

### 第1章：初见

- 情节细化：
  - 情节点：主角推门，雨声灌进来，掌柜抬头看他
EOF
cat > "$TMP_DIR/正文/第001章_初见.md" << 'EOF'
# 第1章 初见

雨夜，他说：主角推门，雨声灌进来，掌柜抬头看他。
EOF
node "$SCRIPT" --check "$TMP_DIR/正文/第001章_初见.md" >/dev/null 2>&1 && fail "case4: 无锚句字段时照搬应 exit 1"

# 用例 5：锚句字段写「无」（不豁免任何内容）
cat > "$TMP_DIR/大纲/细纲/第001章.md" << 'EOF'
# 细纲（第 1 章）

### 第1章：初见

- 复沓锚句：无
- 情节细化：
  - 情节点：主角推门，雨声灌进来，掌柜抬头看他
EOF
cat > "$TMP_DIR/正文/第001章_初见.md" << 'EOF'
# 第1章 初见

雨夜，他说：主角推门，雨声灌进来，掌柜抬头看他。
EOF
node "$SCRIPT" --check "$TMP_DIR/正文/第001章_初见.md" >/dev/null 2>&1 && fail "case5: 锚句=无 时照搬应 exit 1"

# 用例 6：一次传多章各自比对（第 2 章无细纲 → SKIP，不影响第 1 章）
cat > "$TMP_DIR/正文/第002章_次日.md" << 'EOF'
# 第2章 次日

第二天清晨，主角收拾行装。
EOF
OUT=$(node "$SCRIPT" "$TMP_DIR/正文/第001章_初见.md" "$TMP_DIR/正文/第002章_次日.md")
echo "$OUT" | grep -q "\[COPY\]" || fail "case6: 多章应各自比对，实际: $OUT"
echo "$OUT" | grep -q "\[SKIP\].*no outline" || fail "case6: 第2章应 SKIP，实际: $OUT"

# 用例 7：--json 输出可解析
node "$SCRIPT" --json "$TMP_DIR/正文/第001章_初见.md" | python -c "import json,sys; json.load(sys.stdin)" \
  || fail "case7: --json 输出应可解析"

echo "outline-copy regression tests passed (7 cases)."

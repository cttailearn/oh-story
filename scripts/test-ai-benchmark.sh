#!/bin/bash
# test-ai-benchmark.sh — 去AI味检测器评测基准回归
# 数据集：scripts/ai-pattern-benchmark/
#   positives-blocking.txt  每行一句必须命中（blocking 句式）
#   positives-advisory.txt  密度型 advisory 组，整组必须产生 findings
#   negatives.txt            demo 真实小说文本，验证零误伤（构建时已自举剔除命中句）
# 阈值：blocking 正例命中率 < 90% → FAIL；advisory 零命中 → FAIL；负例任意误伤 → FAIL
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
SCRIPT="$REPO_ROOT/skills/story-deslop/scripts/check-ai-patterns.js"
BENCH="$REPO_ROOT/scripts/ai-pattern-benchmark"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }

# 1) blocking 正例：每行必须命中
node "$SCRIPT" --json "$BENCH/positives-blocking.txt" > "$OUT/blocking.json" || true
TOTAL=$(wc -l < "$BENCH/positives-blocking.txt")
HITS=$(node - "$OUT/blocking.json" <<'NODE'
const fs = require('fs');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
console.log(new Set(r.findings.map((f) => f.line)).size);
NODE
)
RATE=$((HITS * 100 / TOTAL))
[ "$RATE" -ge 90 ] || fail "blocking 正例命中率 ${RATE}%（${HITS}/${TOTAL}），阈值 90%"

# 2) advisory 密度组：整组必须产生 findings
node "$SCRIPT" --json "$BENCH/positives-advisory.txt" > "$OUT/advisory.json" || true
ADV_N=$(node - "$OUT/advisory.json" <<'NODE'
const fs = require('fs');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
console.log(r.findings.length);
NODE
)
[ "$ADV_N" -ge 1 ] || fail "advisory 密度组零命中"

# 3) 负例：零误伤
node "$SCRIPT" --json "$BENCH/negatives.txt" > "$OUT/negatives.json" || true
NEG_N=$(node - "$OUT/negatives.json" <<'NODE'
const fs = require('fs');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
console.log(r.findings.length);
NODE
)
[ "$NEG_N" -eq 0 ] || fail "负例误伤 ${NEG_N} 处"

echo "AI-pattern benchmark passed: blocking ${HITS}/${TOTAL} (${RATE}%), advisory ${ADV_N}, negatives 0/${TOTAL_NEG:-60}"

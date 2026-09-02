#!/usr/bin/env node
"use strict";
// run-guards.js — 本地一键跑齐 CI guards.yml 的全部静态守卫与回归测试
// （与 .github/workflows/guards.yml 的 step 顺序一致，含 6 个此前游离在 CI 外的回归）
// 用法：node scripts/run-guards.js [--list]
const { spawnSync } = require("child_process");

const repoRoot = __dirname + "/..";

const BASH = require("./find-git-bash")();
const PY =
  process.env.PYTHON3 || (process.platform === "win32" ? "python" : "python3");
const NODE = process.env.NODE || "node";

// 每步：[kind, script, ...args]；kind: bash | py | node
const STEPS = [
  ["bash", "scripts/static-check.sh"],
  ["py", "scripts/skill-numbering.py", "check"],
  ["bash", "scripts/check-current-skill-contracts.sh"],
  ["bash", "scripts/check-doc-budget.sh"],
  ["py", "scripts/sync-shared-assets.py", "check"],
  ["bash", "scripts/check-python-invocation.sh"],
  ["py", "scripts/test-static-check.py"],
  ["bash", "scripts/test-skill-numbering.sh"],
  ["py", "scripts/test-current-skill-contracts.py"],
  ["py", "scripts/test-shared-assets.py"],
  ["node", "scripts/test-normalize-punctuation.js"],
  ["node", "scripts/test-scan-runtime.js"],
  ["bash", "scripts/test-ai-patterns.sh"],
  ["bash", "scripts/test-outline-copy.sh"],
  ["bash", "scripts/test-outline-detail.sh"],
  ["bash", "scripts/test-degeneration.sh"],
  ["bash", "scripts/test-ai-benchmark.sh"],
  ["bash", "scripts/test-charcount-portable.sh"],
  ["py", "scripts/test-tracking-commit.py"],
  ["py", "scripts/test-tracking-workflow-contracts.py"],
  ["node", "scripts/test-chapter-consistency.js"],
  ["node", "scripts/test-imagegen-custom.js"],
  ["node", "scripts/test-imagegen-env.js"],
  ["node", "scripts/test-project-consistency.js"],
  ["node", "scripts/test-revision-duplicate.js"],
  ["node", "scripts/test-write-review-record.js"],
  ["node", "scripts/test-delivery-contract.js"],
  ["py", "scripts/test-author-memory-commit.py"],
];

if (process.argv.includes("--list")) {
  STEPS.forEach(([k, s]) => console.log(`${k}: ${s}`));
  process.exit(0);
}

let failed = [];
STEPS.forEach(([kind, script, ...args], i) => {
  const runner = kind === "bash" ? BASH : kind === "py" ? PY : NODE;
  const label =
    `${i + 1}/${STEPS.length} [${kind}] ${script} ${args.join(" ")}`.trim();
  process.stdout.write(`${label} … `);
  const r = spawnSync(runner, [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 600000,
    stdio: ["inherit", "pipe", "pipe"],
  });
  const head = (r.stdout || "")
    .split("\n")
    .slice(-2)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" | ");
  if (r.status === 0) {
    console.log("OK" + (head ? ` — ${head}` : ""));
  } else {
    console.log(`FAIL (exit ${r.status})`);
    if (head) console.log("  " + head);
    const tailErr = (r.stderr || "")
      .split("\n")
      .slice(-3)
      .map((s) => s.trim())
      .filter(Boolean)
      .join(" | ");
    if (tailErr) console.log("  stderr: " + tailErr);
    failed.push(label);
  }
});

if (failed.length) {
  console.error(`\nFAILED ${failed.length}/${STEPS.length}:`);
  failed.forEach((s) => console.error("  ✗ " + s));
  process.exit(1);
}
console.log(`\nAll ${STEPS.length} guard steps passed.`);

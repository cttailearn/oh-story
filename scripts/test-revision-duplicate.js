#!/usr/bin/env node
"use strict";
// test-revision-duplicate.js — check-revision-duplicate.js 回归（重写残片/锚句豁免/内部自重复）
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const script = path.join(repoRoot, "skills/story-long-write/scripts/check-revision-duplicate.js");

function run(origText, revText, mode, exemptText) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "revdup-"));
  const o = path.join(tmp, "orig.md"), r = path.join(tmp, "rev.md"), e = path.join(tmp, "ex.md");
  fs.writeFileSync(o, origText, "utf8"); fs.writeFileSync(r, revText, "utf8");
  const args = [script, "--check", "--original", o, "--revised", r, "--mode", mode];
  if (exemptText !== undefined) { fs.writeFileSync(e, exemptText, "utf8"); args.push("--exempt", e); }
  const out = spawnSync(process.execPath, args, { encoding: "utf8" });
  fs.rmSync(tmp, { recursive: true, force: true });
  return out;
}

const ORIG = "主角推开茶馆的门，掌柜抬头打量了他一眼。天机阁的规矩，从不问客从何来。主角坐下，点了一壶茶。";
const REWRITTEN = "雨夜，主角踏进茶馆。掌柜的目光在他身上停了一瞬。他坐下，要了一壶热茶，茶香混着雨气漫开。";
const WITH_COPY = "雨夜，主角踏进茶馆。掌柜的规矩，从不问客从何来——这是旧文残片。他坐下，点了一壶茶，茶香漫开。天机阁的规矩，从不问客从何来。";
const ANCHOR = "雨夜，主角踏进茶馆。掌柜的目光在他身上停了一瞬。\"天机阁的规矩，从不问客从何来。\"他说。茶香混着雨气漫开。";
const OUTLINE = "# 细纲\n\n- 复沓锚句：\`\"天机阁的规矩，从不问客从何来。\"（P3）\`\n";
const DUP = "主角推开大门，跨过门槛，走进落满灰尘的老宅。他环顾四周，只见蛛网结满梁柱。主角推开大门，跨过门槛，走进落满灰尘的老宅，这一次他的脚步更慢。";

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`[PASS] ${name}`);
  else { failures++; console.error(`[FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

const r1 = run(ORIG, REWRITTEN, "rewrite");
check("重写无残片 PASS", r1.status === 0 && r1.stdout.includes("Result: PASS"), r1.stdout.slice(-150));
const r2 = run(ORIG, WITH_COPY, "rewrite");
check("重写残片检出（exit 1 + rev-copy）", r2.status === 1 && r2.stdout.includes("rev-copy"), r2.stdout.slice(-200));
const r3 = run(ORIG, ANCHOR, "rewrite", OUTLINE);
check("锚句豁免 PASS（--exempt 细纲）", r3.status === 0, r3.stdout.slice(-150));
const r4 = run(ORIG, DUP, "patch");
check("内部自重复检出（一条合并报告）", r4.status === 1 && r4.stdout.includes("rev-dup") && (r4.stdout.match(/rev-dup/g) || []).length <= 2, r4.stdout.slice(-300));
const r5 = run(ORIG, REWRITTEN, "patch");
check("patch 模式无重复 PASS", r5.status === 0, r5.stdout.slice(-120));

console.log(failures === 0 ? "PASS: test-revision-duplicate.js" : `FAIL: ${failures} case(s)`);
process.exit(failures === 0 ? 0 : 1);

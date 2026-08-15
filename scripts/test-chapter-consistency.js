#!/usr/bin/env node
"use strict";
// test-chapter-consistency.js — check-chapter-consistency.js 回归（倒挂/回退全部检出 + 正常项目 PASS）
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const script = path.join(repoRoot, "skills/story-long-write/scripts/check-chapter-consistency.js");

function mkProject(name, chapters) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chcons-" + name + "-"));
  fs.mkdirSync(path.join(tmp, "正文"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "大纲", "细纲"), { recursive: true });
  chapters.forEach((c, i) => {
    fs.writeFileSync(path.join(tmp, "大纲", "细纲", `第00${i + 1}章.md`), "# 细纲\n");
    fs.writeFileSync(path.join(tmp, "正文", `第00${i + 1}章_x.md`), c);
  });
  return tmp;
}
function run(project, args) {
  return spawnSync(process.execPath, [script, "--project", project, ...args], { encoding: "utf8" });
}

// bad: 倒挂/回退
const bad = mkProject("bad", ["周一周五 5月10日 第1天 还剩10天", "周四周四 5月12日 第2天 还剩9天", "周一周二 5月11日 第1天 还剩12天"]);
const rb = run(bad, ["--check"]);
// good
const good = mkProject("good", ["周一周五 5月10日 第1天 还剩10天", "周五 5月12日 第2天 还剩9天", "周六 5月13日 第3天 还剩8天"]);
// 注：第1章周五→第2章周五（同日多章合法）→第3章周六（前进）
const rg = run(good, ["--check"]);
// 缺细纲
const miss = mkProject("miss", ["正文"]);
// 细纲 001/002 都有，正文只有 001 → 检出「细纲第002章 无对应正文」
fs.writeFileSync(path.join(miss, "大纲", "细纲", "第002章.md"), "# x");
const rm = run(miss, ["--check"]);

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`[PASS] ${name}`);
  else { failures++; console.error(`[FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
check("倒挂项目退出 1", rb.status === 1, `status=${rb.status}`);
check("检出星期倒挂", rb.stdout.includes("星期倒挂"));
check("检出日期倒挂", rb.stdout.includes("日期倒挂"));
check("检出天数回退", rb.stdout.includes("天数回退"));
check("检出倒计时回退", rb.stdout.includes("倒计时回退"));
check("正常项目 PASS", rg.status === 0 && rg.stdout.includes("Result: PASS"), rg.stdout.slice(-120));
check("缺细纲检出", rm.status === 1 && rm.stdout.includes("[S1][pair]"), rm.stdout.slice(-200));

fs.rmSync(bad, { recursive: true, force: true });
fs.rmSync(good, { recursive: true, force: true });
fs.rmSync(miss, { recursive: true, force: true });
console.log(failures === 0 ? "PASS: test-chapter-consistency.js" : `FAIL: ${failures} case(s)`);
process.exit(failures === 0 ? 0 : 1);

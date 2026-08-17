#!/usr/bin/env node
"use strict";
// test-chapter-consistency.js — check-chapter-consistency.js 回归
// （S1 阻断：正文无细纲；S2 提示：星期/日期/天数/倒计时变化 + 跨周/跨年/滚动细纲不误报）
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
    fs.writeFileSync(path.join(tmp, "大纲", "细纲", "第00" + (i + 1) + "章.md"), "# 细纲\n");
    fs.writeFileSync(path.join(tmp, "正文", "第00" + (i + 1) + "章_x.md"), c);
  });
  return tmp;
}
function run(project, args) {
  return spawnSync(process.execPath, [script, "--project", project, ...args], { encoding: "utf8" });
}
function mkOutlineOnly(name, outlineCount, bodyCount) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chcons-" + name + "-"));
  fs.mkdirSync(path.join(tmp, "正文"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "大纲", "细纲"), { recursive: true });
  for (let i = 1; i <= outlineCount; i++) fs.writeFileSync(path.join(tmp, "大纲", "细纲", "第00" + i + "章.md"), "# 细纲\n");
  for (let i = 1; i <= bodyCount; i++) fs.writeFileSync(path.join(tmp, "正文", "第00" + i + "章_x.md"), "正文内容。");
  return tmp;
}

// 1. bad：星期/日期/天数/倒计时倒退 → S2 提示检出、--check 不阻断（status 0）
const bad = mkProject("bad", ["周一周五 5月10日 第1天 还剩10天", "周四周四 5月12日 第2天 还剩9天", "周一周二 5月11日 第1天 还剩12天"]);
const rb = run(bad, ["--check"]);
// 2. good：无变化 → PASS
const good = mkProject("good", ["周一周五 5月10日 第1天 还剩10天", "周五 5月12日 第2天 还剩9天", "周六 5月13日 第3天 还剩8天"]);
const rg = run(good, ["--check"]);
// 3. miss：正文 002 无对应细纲 → S1 阻断
const miss = mkProject("miss", ["a", "b"]);
fs.rmSync(path.join(miss, "大纲", "细纲", "第002章.md"));
const rm = run(miss, ["--check"]);
// 4. roll：细纲 1-3、正文只有 1（滚动建纲正常状态）→ 不再报 S1 pair
const roll = mkOutlineOnly("roll", 3, 1);
const rr = run(roll, ["--check"]);
// 5. week：第1章周五 → 第2章下周一（合法跨周）→ 不阻断、Result: PASS
const week = mkProject("week", ["周五那天，他进了训练场。", "下周一，比赛开始。"]);
const rw = run(week, ["--check"]);
// 6. year：12月30日 → 1月2日（合法跨年）→ 不阻断、Result: PASS
const year = mkProject("year", ["12月30日，跨年倒计时。", "1月2日，新年第一天。"]);
const ry = run(year, ["--check"]);

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log("[PASS] " + name);
  else { failures++; console.error("[FAIL] " + name + (detail ? " — " + detail : "")); }
}
check("倒退四项均检出（S2 提示）", rb.stdout.includes("星期变化") && rb.stdout.includes("日期变化") && rb.stdout.includes("天数变化") && rb.stdout.includes("倒计时变化"), rb.stdout.slice(-400));
check("倒退不阻断（--check 退出 0）", rb.status === 0, "status=" + rb.status);
check("正常项目 PASS", rg.status === 0 && rg.stdout.includes("Result: PASS"), rg.stdout.slice(-120));
check("正文无细纲检出（S1 阻断）", rm.status === 1 && rm.stdout.includes("[S1][pair]"), rm.stdout.slice(-200));
check("滚动建纲不报 S1 pair", rr.status === 0 && !rr.stdout.includes("[S1][pair]"), rr.stdout.slice(-200));
check("跨周边界不误报", rw.status === 0 && rw.stdout.includes("Result: PASS"), rw.stdout.slice(-300));
check("跨年不误报", ry.status === 0 && ry.stdout.includes("Result: PASS"), ry.stdout.slice(-300));

fs.rmSync(bad, { recursive: true, force: true });
fs.rmSync(good, { recursive: true, force: true });
fs.rmSync(miss, { recursive: true, force: true });
fs.rmSync(roll, { recursive: true, force: true });
fs.rmSync(week, { recursive: true, force: true });
fs.rmSync(year, { recursive: true, force: true });
console.log(failures === 0 ? "PASS: test-chapter-consistency.js" : "FAIL: " + failures + " case(s)");
process.exit(failures === 0 ? 0 : 1);
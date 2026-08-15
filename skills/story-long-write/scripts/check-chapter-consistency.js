#!/usr/bin/env node
"use strict";

// check-chapter-consistency.js — 正文时间线硬事实一致性检查（重排/批量生成后必跑）
// 检查项：
//   1. 章文件编号对应：正文/第N章_*.md 与 大纲/细纲/第N章.md 一一对应
//   2. 星期倒挂：正文中「周X」按章序递增推算（如第9章周五 → 第10章周四 = S1）
//   3. 日期倒挂：正文中「X月X日」按章序非降序
//   4. 倒计时单调性：「第X天/还剩X天」按章序单调（第X天递增、还剩X天递减）
// 用法：node check-chapter-consistency.js [--check] [--json] --project <项目根>
const fs = require("node:fs");
const path = require("node:path");

const USAGE = "Usage: node check-chapter-consistency.js [--check] [--json] --project <root>";
const WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };

function readText(p) { try { return fs.readFileSync(p, "utf8"); } catch { return null; } }
function globMd(root, sub) {
  const dir = path.join(root, sub);
  try { return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort(); } catch { return []; }
}

function chapterNumber(file) {
  const m = file.match(/第(\d+)章/);
  return m ? parseInt(m[1], 10) : null;
}

function main() {
  const args = process.argv.slice(2);
  let check = false, json = false, project = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--check") check = true;
    else if (a === "--json") json = true;
    else if (a === "--project" && i + 1 < args.length) project = args[++i];
    else { console.error(USAGE); process.exit(2); }
  }
  if (!project) { console.error(USAGE); process.exit(2); }

  const fails = [];
  const chapters = globMd(project, "正文").map((f) => ({ file: f, no: chapterNumber(f) })).filter((x) => x.no !== null).sort((a, b) => a.no - b.no);
  const outlines = globMd(project, "大纲/细纲").map((f) => chapterNumber(f)).filter((x) => x !== null);
  const outlineSet = new Set(outlines);
  const chapterSet = new Set(chapters.map((x) => x.no));

  // 1. 章编号对应
  for (const c of chapters) {
    if (!outlineSet.has(c.no)) fails.push(`[S1][pair] 正文 ${c.file} 无对应细纲 大纲/细纲/第${c.no}章.md`);
  }
  for (const o of outlines) {
    if (!chapterSet.has(o)) fails.push(`[S1][pair] 细纲 第${o}章 无对应正文（缺写或缺文件）`);
  }

  // 2/3/4. 时间线硬事实（星期/日期/倒计时）按章序单调性
  let lastWeekday = 0, lastMonthDay = 0, lastDayCount = 0, lastRemain = Infinity;
  for (const c of chapters) {
    const text = readText(path.join(project, "正文", c.file)) || "";
    // 星期：取最后出现的「周X」
    let wd = null;
    const wm = [...text.matchAll(/周([一二三四五六日天])/g)];
    if (wm.length) { const last = wm[wm.length - 1][1]; wd = WEEKDAY[last] || null; }
    if (wd !== null && lastWeekday !== 0) {
      // 只查倒退：同日多章（同星期）合法，倒退（如周五→周四）才报
      if (wd < lastWeekday) fails.push(`[S1][timeline] 第${c.no}章 星期倒挂：前章周${lastWeekday}，本章周${wd}（倒退）`);
    }
    if (wd !== null && wd > lastWeekday) lastWeekday = wd;

    // 日期：取最后出现的「X月X日」
    const dm = [...text.matchAll(/(\d{1,2})月(\d{1,2})日/g)];
    if (dm.length) {
      const last = dm[dm.length - 1];
      const md = parseInt(last[1], 10) * 100 + parseInt(last[2], 10);
      if (lastMonthDay !== 0 && md < lastMonthDay) fails.push(`[S1][timeline] 第${c.no}章 日期倒挂：${last[0]} 早于前章 ${lastMonthDay}`);
      if (md > lastMonthDay) lastMonthDay = md;
    }

    // 第X天（递增）
    const dcm = [...text.matchAll(/第(\d{1,3})天/g)];
    if (dcm.length) {
      const last = parseInt(dcm[dcm.length - 1][1], 10);
      if (lastDayCount !== 0 && last < lastDayCount) fails.push(`[S1][timeline] 第${c.no}章 天数回退：第${last}天 早于前章 第${lastDayCount}天`);
      if (last > lastDayCount) lastDayCount = last;
    }
    // 还剩X天（递减）
    const rm = [...text.matchAll(/还剩(\d{1,3})天/g)];
    if (rm.length) {
      const last = parseInt(rm[rm.length - 1][1], 10);
      if (lastRemain !== Infinity && last > lastRemain) fails.push(`[S1][timeline] 第${c.no}章 倒计时回退：还剩${last}天 多于前章 还剩${lastRemain}天`);
      if (last < lastRemain) lastRemain = last;
    }
  }

  if (json) { console.log(JSON.stringify({ checked: chapters.length, issues: fails }, null, 2)); }
  else {
    console.log(`--- 正文时间线一致性（${chapters.length} 章）---`);
    if (fails.length === 0) console.log("  [PASS]");
    else for (const f of fails) console.log("  " + f);
    console.log(fails.length ? `FAIL: ${fails.length} issue(s)` : "Result: PASS");
  }
  if (check && fails.length) process.exit(1);
  process.exit(0);
}

main();

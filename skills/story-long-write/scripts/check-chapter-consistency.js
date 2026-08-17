#!/usr/bin/env node
"use strict";

// check-chapter-consistency.js — 正文硬事实一致性检查（重排/批量生成后必跑）
// 检查项：
//   1. 章编号对应：正文/第N章_*.md 必须有对应细纲（正文无细纲 = S1 阻断；
//      「细纲无正文」是滚动建纲的正常状态，不报）
//   2. 星期/日期/倒计时变化：按章序比较，倒退/回退输出 S2 提示级——无周号/年份
//      上下文时无法区分「真倒退」与「跨周/跨年/倒叙/时间跳跃」，故不阻断，
//      由作者人工核对（如第9章周五 → 第10章周一可能是合法跨周）
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

  const fails = []; // S1 阻断项
  const hints = []; // S2 提示项（需人工核对）
  const chapters = globMd(project, "正文").map((f) => ({ file: f, no: chapterNumber(f) })).filter((x) => x.no !== null).sort((a, b) => a.no - b.no);
  const outlines = globMd(project, "大纲/细纲").map((f) => chapterNumber(f)).filter((x) => x !== null);
  const outlineSet = new Set(outlines);
  const chapterSet = new Set(chapters.map((x) => x.no));

  // 1. 章编号对应：正文必须有细纲（S1）；「细纲无正文」按项目滚动建纲约定是
  //    正常状态（首批 10 章细纲先建、正文逐章写），不作为问题报告
  for (const c of chapters) {
    if (!outlineSet.has(c.no)) fails.push(`[S1][pair] 正文 ${c.file} 无对应细纲 大纲/细纲/第${c.no}章.md`);
  }

  // 2/3/4. 时间线变化（星期/日期/倒计时）：按章序比较倒退/回退 → S2 提示级。
  //    无周号/年份上下文时「真倒退」与「跨周/跨年/倒叙/时间跳跃」不可区分，
  //    自动判定会误杀合法故事（周五→下周一、12月30日→1月2日均为合法推进），
  //    故只输出提示由作者人工核对，不阻断（S1 仅保留确定性问题）。
  let lastWeekday = 0, lastMonthDay = 0, lastMonthDayText = "", lastDayCount = 0, lastRemain = Infinity;
  for (const c of chapters) {
    const text = readText(path.join(project, "正文", c.file)) || "";
    // 星期：取最后出现的「周X」
    let wd = null;
    const wm = [...text.matchAll(/周([一二三四五六日天])/g)];
    if (wm.length) { const last = wm[wm.length - 1][1]; wd = WEEKDAY[last] || null; }
    if (wd !== null && lastWeekday !== 0) {
      // 同日多章（同星期）合法；倒退或跨周跳跃均提示人工核对
      if (wd < lastWeekday) hints.push(`[S2][timeline] 第${c.no}章 星期变化：前章周${lastWeekday}，本章周${wd}——倒退或跨周跳跃；若为跨周/倒叙/时间跳跃请忽略，否则人工核对`);
    }
    if (wd !== null && wd > lastWeekday) lastWeekday = wd;

    // 日期：取最后出现的「X月X日」
    const dm = [...text.matchAll(/(\d{1,2})月(\d{1,2})日/g)];
    if (dm.length) {
      const last = dm[dm.length - 1];
      const md = parseInt(last[1], 10) * 100 + parseInt(last[2], 10);
      if (lastMonthDay !== 0 && md < lastMonthDay) hints.push(`[S2][timeline] 第${c.no}章 日期变化：${last[0]} 早于前章 ${lastMonthDayText}——倒退或跨年；若为跨年/倒叙/时间跳跃请忽略，否则人工核对`);
      if (md > lastMonthDay) { lastMonthDay = md; lastMonthDayText = last[0]; }
    }

    // 第X天（递增）
    const dcm = [...text.matchAll(/第(\d{1,3})天/g)];
    if (dcm.length) {
      const last = parseInt(dcm[dcm.length - 1][1], 10);
      if (lastDayCount !== 0 && last < lastDayCount) hints.push(`[S2][timeline] 第${c.no}章 天数变化：第${last}天 早于前章 第${lastDayCount}天——倒退或跳段；若为时间跳跃/倒叙请忽略，否则人工核对`);
      if (last > lastDayCount) lastDayCount = last;
    }
    // 还剩X天（递减）
    const rm = [...text.matchAll(/还剩(\d{1,3})天/g)];
    if (rm.length) {
      const last = parseInt(rm[rm.length - 1][1], 10);
      if (lastRemain !== Infinity && last > lastRemain) hints.push(`[S2][timeline] 第${c.no}章 倒计时变化：还剩${last}天 多于前章 还剩${lastRemain}天——回退或跨章重计；若为合法重计/倒叙请忽略，否则人工核对`);
      if (last < lastRemain) lastRemain = last;
    }
  }

  if (json) { console.log(JSON.stringify({ checked: chapters.length, issues: fails, hints }, null, 2)); }
  else {
    console.log(`--- 正文时间线一致性（${chapters.length} 章）---`);
    for (const h of hints) console.log("  " + h);
    if (fails.length === 0) console.log("  [PASS]");
    else for (const f of fails) console.log("  " + f);
    if (hints.length) console.log(`  （${hints.length} 条 S2 时间线提示：跨周/跨年/倒叙/时间跳跃属正常，请人工核对）`);
    console.log(fails.length ? `FAIL: ${fails.length} issue(s)` : "Result: PASS");
  }
  if (check && fails.length) process.exit(1);
  process.exit(0);
}

main();

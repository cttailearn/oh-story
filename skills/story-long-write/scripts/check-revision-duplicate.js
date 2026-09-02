#!/usr/bin/env node
"use strict";

// check-revision-duplicate.js — 正文修订/重写的重复与残片检测（修订核验的机械层）
// 用法：node check-revision-duplicate.js [--check] [--json] --original <原稿> --revised <新稿> [--mode rewrite|patch]
//   --mode rewrite  全文重写：新稿中 ≥15 字连续片段若在原稿中出现 → [S1][rev-copy]（旧文残片/整句照抄）
//   --mode patch    局部修改：只查新稿内部自重复（≥15 字片段出现 ≥2 次）→ [S1][rev-dup]
//   两种模式都输出：字数统计（原稿/新稿/增/删）、内部自重复、可豁免清单提示
//   豁免（--exempt <细纲文件>）：只取细纲中「复沓锚句」登记行的原话——重写本就要忠实细纲，
//   若整文件豁免会系统性放过「照着细纲照抄」的残片；引号内台词/弹幕刷屏由调用方在 SKILL 流程核对
const fs = require("node:fs");
const path = require("node:path");

const USAGE =
  "Usage: node check-revision-duplicate.js [--check] [--json] --original <file> --revised <file> [--mode rewrite|patch] [--exempt <file>]";
const MIN_LEN = 15;

function readText(p) {
  try {
    return fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return null;
  }
}

// 去空白后的文本用于片段检测（换行/空格不影响重复判定）
function compact(t) {
  return t.replace(/\s+/g, "");
}

// 豁免语料：只取「复沓锚句」登记行（登记格式反引号包原话，如 `"xxx"（P3）`；
// 无反引号时取冒号后整段）。细纲的其它内容（情节点/内容概括/情节细化等）不是豁免源。
function extractAnchorSentences(text) {
  if (!text) return "";
  const parts = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/复沓锚句/.test(line)) continue;
    const bq = [...line.matchAll(/`([^`]+)`/g)];
    if (bq.length) {
      for (const m of bq) parts.push(m[1]);
    } else {
      const rest = line.replace(/^[-\s]*复沓锚句\s*[：:]\s*/, "");
      if (rest) parts.push(rest);
    }
  }
  return parts.join("");
}

// 新稿内部自重复：≥15 字片段出现 ≥2 次；合并为最长公共片段，每条重复只报一次
function internalDuplicates(rev) {
  const found = [];
  const skip = new Set();
  for (let i = 0; i + MIN_LEN <= rev.length; i++) {
    if (skip.has(i)) continue;
    const s = rev.slice(i, i + MIN_LEN);
    if (!/[\u4e00-\u9fa5]/.test(s)) continue;
    const j = rev.indexOf(s, i + MIN_LEN);
    if (j === -1) continue;
    // 向后扩展
    let L = MIN_LEN;
    while (
      i + L < rev.length &&
      j + L < rev.length &&
      rev[i + L] === rev[j + L]
    )
      L++;
    // 向前扩展
    let i0 = i,
      j0 = j;
    while (i0 > 0 && j0 > 0 && rev[i0 - 1] === rev[j0 - 1]) {
      i0--;
      j0--;
      L++;
    }
    found.push(rev.slice(i0, i0 + L));
    for (let k = i0; k < i0 + L; k++) skip.add(k);
    i = i0 + L - 1;
  }
  return found;
}

function main() {
  const args = process.argv.slice(2);
  let check = false,
    json = false,
    original = null,
    revised = null,
    mode = "rewrite",
    exemptFile = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--check") check = true;
    else if (a === "--json") json = true;
    else if (a === "--original" && i + 1 < args.length) original = args[++i];
    else if (a === "--revised" && i + 1 < args.length) revised = args[++i];
    else if (a === "--mode" && i + 1 < args.length) mode = args[++i];
    else if (a === "--exempt" && i + 1 < args.length) exemptFile = args[++i];
    else {
      console.error(USAGE);
      process.exit(2);
    }
  }
  if (!original || !revised || !["rewrite", "patch"].includes(mode)) {
    console.error(USAGE);
    process.exit(2);
  }

  const origText = readText(original);
  const revText = readText(revised);
  if (origText === null || revText === null) {
    console.error("无法读取原稿或新稿");
    process.exit(2);
  }
  const orig = compact(origText);
  const rev = compact(revText);
  // 豁免语料（细纲「复沓锚句」登记行原话，见 extractAnchorSentences）：
  // 命中片段同时出现在豁免语料中 → 跳过；细纲其它内容不豁免
  const exempt = exemptFile
    ? compact(extractAnchorSentences(readText(exemptFile) || ""))
    : "";

  const issues = [];
  // 1. 重写模式：新稿片段与原稿重叠（残片/整句照抄）
  // 15 字窗口命中原稿 → 向两边扩展求真实匹配长度 → 合并相邻命中为残片区段 → 段长 ≥20 报
  if (mode === "rewrite") {
    const hits = [];
    for (let i = 0; i + MIN_LEN <= rev.length; i++) {
      const s = rev.slice(i, i + MIN_LEN);
      if (!/[\u4e00-\u9fa5]/.test(s)) continue;
      if (orig.includes(s)) hits.push(i);
    }
    // 合并相邻命中（间隔 < MIN_LEN）
    const segments = [];
    for (const h of hits) {
      const last = segments[segments.length - 1];
      if (last && h - last.end < MIN_LEN) {
        last.end = h + MIN_LEN;
        last.hits.push(h);
      } else segments.push({ start: h, end: h + MIN_LEN, hits: [h] });
    }
    for (const seg of segments) {
      // 向两端扩展真实匹配长度
      let left = seg.start,
        right = seg.end;
      while (left > 0 && orig.includes(rev.slice(left - 1, right))) left--;
      while (right < rev.length && orig.includes(rev.slice(left, right + 1)))
        right++;
      const len = right - left;
      const frag = rev.slice(left, right);
      if (len >= 15 && !(exempt && exempt.includes(frag))) {
        issues.push({
          type: "rev-copy",
          severity: "S1",
          pos: left,
          snippet: rev.slice(left, left + 40) + "…",
          message: `重写残片：新稿含原稿连续片段（约 ${len} 字）——若非复沓锚句登记原话，删除旧文残片或改写表达；${exempt ? "" : "复沓锚句登记原话可用 --exempt <细纲文件> 豁免（只取复沓锚句行）"}`,
        });
      }
    }
  }
  // 2. 新稿内部自重复（两种模式都查）
  const dups = internalDuplicates(rev);
  for (const d of dups.slice(0, 10)) {
    issues.push({
      type: "rev-dup",
      severity: "S1",
      snippet: d.slice(0, 40) + "…",
      message:
        "新稿内部重复：≥15 字片段出现 ≥2 次（引号内台词/弹幕/复沓锚句登记可豁免，其余需去重）",
    });
  }

  // 3. 字数统计
  const stats = {
    original: orig.length,
    revised: rev.length,
    delta: rev.length - orig.length,
  };

  if (json) {
    console.log(JSON.stringify({ mode, stats, issues }, null, 2));
  } else {
    console.log(`--- 修订重复检测（mode=${mode}）---`);
    console.log(
      `  原稿 ${stats.original} 字 → 新稿 ${stats.revised} 字（${stats.delta >= 0 ? "+" : ""}${stats.delta}）`,
    );
    if (issues.length === 0) console.log("  [PASS]");
    else
      for (const x of issues)
        console.log(`  [${x.severity}][${x.type}] ${x.message}：${x.snippet}`);
    console.log(
      issues.length ? `FAIL: ${issues.length} issue(s)` : "Result: PASS",
    );
  }
  if (check && issues.length) process.exit(1);
  process.exit(0);
}

main();

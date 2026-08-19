#!/usr/bin/env node
"use strict";

// check-project-consistency.js — 写作项目机械一致性检查（Gate 辅助）
// 检查项（按 --scope 分组）：
//   setup   : 设定索引 vs 实际文件（关系.md 角色索引、角色线阶段编号连续性）
//   outline : 卷纲字段完整性（剧情单元/情绪弧线/人物弧线/伏笔/反转/对标结构坐标）、全书体量
//   detail  : 细纲「本章设定引用」点名的设定文件存在性
//   review  : 审查记录存在性与关键栏目非空（Gate A/B/C 后的语义审查产物）
// 用法：node check-project-consistency.js [--check] [--json] --project <项目根> [--scope setup|outline|detail|review|all]
//   --check  任一 FAIL 退出 1；缺省只报告
const fs = require("node:fs");
const path = require("node:path");

const USAGE = "Usage: node check-project-consistency.js [--check] [--json] --project <root> [--scope setup|outline|detail|review|all]";

function readLines(p) {
  try { return fs.readFileSync(p, "utf8").split(/\r?\n/); } catch { return null; }
}
function glob(root, sub) {
  const dir = path.join(root, sub);
  try { return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort(); } catch { return []; }
}

// --- setup: 角色索引 vs 文件 + 角色线阶段编号 ---
function checkSetup(root) {
  const fails = [];
  // 1. 关系.md 角色索引（**粗体** 或 列表项冒号前）→ 设定/角色/{名}.md
  const rel = readLines(path.join(root, "设定", "关系.md"));
  if (rel) {
    const names = new Set();
    // 关系符号/句式词：关系对（↔/vs/→）与"起点/转折/当前"等叙述词不算角色索引
    const badChar = /[↔⇄⇆vs→×（()）【】\s]/;
    const stopWords = new Set(["起点", "转折", "当前", "变化", "关系", "情感", "状态", "起始", "节点", "角色 A", "角色 B", "角色a", "角色b"]);
    const isName = (n) => {
      if (!n || n.length > 8 || badChar.test(n)) return false;
      if (stopWords.has(n)) return false;
      // 「XX系统」是金手指/外挂而非角色（关系表常把系统列入），不索引
      if (/系统$/.test(n)) return false;
      return /^[\u4e00-\u9fa5A-Za-z0-9·]+$/.test(n);
    };
    for (const l of rel) {
      // 表格行：前两列（角色 A / 角色 B）为角色索引
      if (l.trim().startsWith("|")) {
        const cells = l.split("|").map((x) => x.trim()).filter(Boolean);
        if (cells.length >= 2 && !/角色|^--/.test(cells[0]) && !/角色|^--/.test(cells[1])) {
          if (isName(cells[0])) names.add(cells[0]);
          if (isName(cells[1])) names.add(cells[1]);
        }
        continue;
      }
      // 粗体（关系演变段）：排除关系对写法
      let m;
      const re = /\*\*([^*]+?)\*\*/g;
      while ((m = re.exec(l))) { const n = m[1].trim(); if (isName(n)) names.add(n); }
    }
    for (const n of names) {
      if (!fs.existsSync(path.join(root, "设定", "角色", n + ".md"))) {
        fails.push(`[S2][index] 关系.md 索引「${n}」但 设定/角色/${n}.md 不存在`);
      }
    }
  }
  // 2. 角色线阶段编号连续性（### 阶段 N：从 1 连续、无跳号重复）
  for (const f of glob(root, "设定/角色")) {
    const lines = readLines(path.join(root, "设定", "角色", f));
    if (!lines) continue;
    const inSection = [];
    let active = false;
    for (const l of lines) {
      if (/^##\s*角色线/.test(l)) { active = true; continue; }
      if (active && /^##\s/.test(l)) break;
      if (active) { const m = l.match(/^###\s*阶段\s*(\d+)\s*[：:]/); if (m) inSection.push(parseInt(m[1], 10)); }
    }
    if (inSection.length > 0) {
      const sorted = [...inSection].sort((a, b) => a - b);
      for (let i = 0; i < sorted.length; i++) {
        if (sorted[i] !== i + 1) {
          fails.push(`[S1][stage] ${f} 角色线阶段编号不连续（实际 ${sorted.join(",")}，应 1..${Math.max(...sorted)}）`);
          break;
        }
      }
      if (new Set(sorted).size !== sorted.length) fails.push(`[S1][stage] ${f} 角色线阶段编号重复`);
    }
  }
  return fails;
}

// --- outline: 卷纲字段 + 全书体量 ---
const OUTLINE_SECTIONS = ["剧情单元", "情绪弧线", "人物弧线", "伏笔", "反转", "对标结构坐标"];
function checkOutline(root) {
  const fails = [];
  // 全书体量
  const dm = readLines(path.join(root, "大纲", "大纲.md"));
  if (!dm || !dm.some((l) => /全书体量|阶段总览/.test(l))) {
    fails.push("[FAIL][volume] 大纲/大纲.md 缺「全书体量与阶段总览」");
  }
  // 卷纲字段
  for (const f of glob(root, "大纲/卷纲")) {
    const lines = readLines(path.join(root, "大纲", "卷纲", f));
    if (!lines) continue;
    for (const s of OUTLINE_SECTIONS) {
      if (!lines.some((l) => new RegExp(`^#{2,4}\\s*${s}`).test(l))) {
        fails.push(`[FAIL][outline] ${f} 缺「${s}」节`);
      }
    }
  }
  return fails;
}

// --- detail: 细纲「本章设定引用」点名文件存在性 + 角色线阶段标题存在性 ---
// 解析口径（与 workflow-setup「本章设定引用」模板示例一致）：
//   - 按 ；/;，/, 拆 token（并剥掉 `——说明` 尾注）
//   - 角色卡:A/B（一 token 多角色）→ 逐个查 设定/角色/{名}.md
//   - 世界观:X§小节 / 势力:X → § 后是卡内小节定位，只取文件部分 X 查存在性
//   - 角色线:{角色名}·阶段N → 查 设定/角色/{角色名}.md 存在 + 「角色线」内「### 阶段 N：」标题存在；
//     多段如 ·阶段2·备注 时 stagePart 非纯阶段号 → want=null，跳过阶段核对（放宽行）
//   - 物品:X 无独立归档目录，不查文件（语义一致性归写入审查）
function checkDetail(root) {
  const fails = [];
  const kindDir = { 角色卡: "角色", 世界观: "世界观", 势力: "势力" };
  for (const f of glob(root, "大纲/细纲")) {
    const lines = readLines(path.join(root, "大纲", "细纲", f));
    if (!lines) continue;
    for (const l of lines) {
      const m = l.match(/本章设定引用[：:]\s*(.*)$/);
      if (!m) continue;
      for (const token of m[1].split(/[；;,，]/)) {
        // 剥掉「——...」尾注（模板里「物品:X——按本章实际用到填写…」），防注释被并入假文件名
        const t = token.split("——")[0].trim();
        if (!t) continue;
        if (t.startsWith("角色卡:")) {
          for (const n of t.slice("角色卡:".length).split("/")) {
            const name = n.trim();
            if (!name || name === "无") continue;
            if (!fs.existsSync(path.join(root, "设定", "角色", name + ".md"))) {
              fails.push(`[S2][ref] ${f} 引用角色卡:${name} 但 设定/角色/${name}.md 不存在`);
            }
          }
        } else if (t.startsWith("世界观:") || t.startsWith("势力:")) {
          const kind = t.startsWith("世界观:") ? "世界观" : "势力";
          const name = t.slice(kind.length + 1).split("§")[0].trim();
          if (!name || name === "无") continue;
          if (!fs.existsSync(path.join(root, "设定", kindDir[kind], name + ".md"))) {
            fails.push(`[S2][ref] ${f} 引用${kind}:${name} 但 设定/${kindDir[kind]}/${name}.md 不存在`);
          }
        } else if (t.startsWith("角色线:")) {
          const raw = t.slice("角色线:".length).trim();
          const [namePart, stagePart] = raw.split("·");
          const n = (namePart || "").trim();
          if (!n || n === "无") continue;
          const cardPath = path.join(root, "设定", "角色", n + ".md");
          if (!fs.existsSync(cardPath)) {
            fails.push(`[S2][ref] ${f} 引用角色线:${n} 但 设定/角色/${n}.md 不存在`);
            continue;
          }
          // 机械核对被引用的阶段标题存在（### 阶段 N：）
          if (stagePart) {
            const st = stagePart.trim();
            let want = null;
            if (/^阶段\s*(\d+)$/.test(st)) want = parseInt(/^阶段\s*(\d+)$/.exec(st)[1], 10);
            else if (/^\d+$/.test(st)) want = parseInt(st, 10);
            if (want !== null) {
              const cardLines = readLines(cardPath);
              const stageNums = new Set();
              let inRoleLine = false;
              for (const cl of cardLines || []) {
                if (/^##\s*角色线/.test(cl)) { inRoleLine = true; continue; }
                if (inRoleLine && /^##\s/.test(cl)) break;
                if (inRoleLine) {
                  const sm = cl.match(/^###\s*阶段\s*(\d+)\s*[：:]/);
                  if (sm) stageNums.add(parseInt(sm[1], 10));
                }
              }
              if (!stageNums.has(want)) {
                fails.push(`[S2][ref] ${f} ${n}.md「角色线」无「### 阶段 ${want}：」标题（引用 角色线:${n}·阶段${want}）`);
              }
            }
          }
        }
        // 物品: 等其余前缀无独立归档目录，不查文件（语义一致性归写入审查）
      }
    }
  }
  return fails;
}

// --- review: 审查记录存在性与关键栏目 ---
function checkReview(root) {
  const fails = [];
  const files = glob(root, "大纲/审查记录");
  if (files.length === 0) {
    fails.push("[FAIL][review] 大纲/审查记录/ 无审查记录（Gate A/B/C 后与每章正文后必须写审查记录，缺失=未完成）");
    return fails;
  }
  for (const f of files) {
    const lines = readLines(path.join(root, "大纲", "审查记录", f));
    const text = (lines || []).join("\n");
    if (!lines || text.trim().length < 40 || !/S1|S2|S3|S4|结论|发现|处置/.test(text)) {
      fails.push(`[FAIL][review] ${f} 内容不完整（需含 审查范围/发现(S1-S4)/处置/结论）`);
    }
  }
  // 正文审查记录：每章必写（写章三查落盘）
  const chapters = glob(root, "正文").map((f) => f.match(/第(\d+)章/)).filter(Boolean).map((m) => m[1]);
  const reviewNames = new Set(files);
  for (const n of chapters) {
    const expect = `正文审查_第${n}章.md`;
    if (!reviewNames.has(expect)) fails.push(`[FAIL][review] 缺 ${expect}（写章三查记录必写，缺失=该章未完成）`);
  }
  return fails;
}

function main() {
  const args = process.argv.slice(2);
  let check = false, json = false, project = null, scope = "all";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--check") check = true;
    else if (a === "--json") json = true;
    else if (a === "--project" && i + 1 < args.length) project = args[++i];
    else if (a === "--scope" && i + 1 < args.length) scope = args[++i];
    else { console.error(USAGE); process.exit(2); }
  }
  if (!project) { console.error(USAGE); process.exit(2); }
  const KNOWN_SCOPES = ["setup", "outline", "detail", "review"];
  const requested = scope === "all" ? KNOWN_SCOPES : scope.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = requested.filter((s) => !KNOWN_SCOPES.includes(s));
  if (unknown.length) { console.error(USAGE + "\nunknown scope(s): " + unknown.join(", ")); process.exit(2); }
  const scopes = requested;
  const results = {};
  let fails = [];
  for (const s of scopes) {
    const f = { setup: checkSetup, outline: checkOutline, detail: checkDetail, review: checkReview }[s](project);
    results[s] = f;
    fails = fails.concat(f.map((x) => `[${s}] ${x}`));
  }
  if (json) { console.log(JSON.stringify(results, null, 2)); }
  else {
    for (const s of scopes) {
      console.log(`--- ${s} ---`);
      if (results[s].length === 0) console.log("  [PASS]");
      else for (const x of results[s]) console.log("  " + x);
    }
    if (fails.length) console.log("\nFAIL: " + fails.length + " issue(s)");
    else console.log("\nResult: PASS");
  }
  if (check && fails.length) process.exit(1);
  process.exit(0);
}

main();

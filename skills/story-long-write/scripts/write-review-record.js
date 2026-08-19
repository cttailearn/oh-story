#!/usr/bin/env node
"use strict";
// write-review-record.js — 生成「正文审查_第{N}章.md」（写章三查落盘记录）
//
// 写章三查（workflow-chapter 流程）的最后一步：把查1（追踪状态）、查2（细纲兑现差异）、
// 查3（禁用词 Gate）的结论收进一个 JSON，由本脚本按固定模板落盘到
// {项目根}/大纲/审查记录/正文审查_第{N}章.md。
//
// 机械部分自动填充：查1 的 last_committed_chapter / state_revision 与查3 的两种 blocking
// 计数由脚本照 JSON 原样填入；模型只需在 JSON 里提供 查2 差异列表、可选 S1-S4 发现与结论。
// 与 tracking_commit 相同的 fail-closed：查3 任一 blocking > 0 时拒绝生成记录（除非
// --allow-blocking），防止带毒句式被标记为「已完成」。
//
// 文件名的章号宽度与 正文/ 实际章节文件名对齐（如 正文/第012章_*.md → 正文审查_第012章.md），
// 使 check-project-consistency.js --scope review 的「每章记录必选」校验两端一致；
// 找不到对应正文文件时退回无前导零的裸章号。
//
// 用法：
//   node write-review-record.js --project <项目根> --data <review.json> [--allow-blocking]
//
// review.json schema：
// {
//   "chapter": 12,                          // 必填：章号（正整数）
//   "chapter_name": "章名",                  // 可选：显示在标题
//   "check1": {                              // 必填：查1 追踪状态
//     "last_committed_chapter": 11,          // 必填：非负整数
//     "state_revision": 37,                  // 必填：非负整数
//     "ok": true,                            // 可选：衔接正常（false 时用 note 说明）
//     "note": "衔接正常"                      // 可选：衔接说明
//   },
//   "check2": {                              // 必填：查2 细纲兑现差异（提供方=模型）
//     "items": [
//       { "item": "核心事件", "ok": true, "note": "" },
//       { "item": "禁止提前释放", "ok": false, "note": "第3段提前带出天机阁" }
//     ]
//   },
//   "check3": {                              // 必填：查3 禁用词 Gate
//     "ai_blocking": 0,                      // 必填：非负整数（check-ai-patterns blocking 数）
//     "deg_blocking": 0,                     // 必填：非负整数（check-degeneration blocking 数）
//     "note": "无命中"                        // 可选
//   },
//   "findings": [                            // 可选：S1-S4 发现
//     { "level": "S2", "category": "consistency",
//       "desc": "描述", "disposition": "已修" }
//   ],
//   "conclusion": "可进入下一章"              // 必填：本章完成度结论
// }
// 成功生成后删除 .story-txn/review.json（与 tracking_commit 的 pending.json 同约定）。
const fs = require("node:fs");
const path = require("node:path");

const USAGE = "Usage: node write-review-record.js --project <项目根> --data <review.json> [--allow-blocking]";

function fail(msg) {
	console.error(`[ERROR] write-review-record: ${msg}`);
	process.exit(1);
}

function parseArgs(argv) {
	const args = { allowBlocking: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--project" && i + 1 < argv.length) args.project = argv[++i];
		else if (a === "--data" && i + 1 < argv.length) args.data = argv[++i];
		else if (a === "--allow-blocking") args.allowBlocking = true;
		else {
			console.error(USAGE);
			process.exit(2);
		}
	}
	if (!args.project || !args.data) {
		console.error(USAGE);
		process.exit(2);
	}
	return args;
}

// 必填校验：值缺/空串/undefined/null 一律视为缺失
function mustHave(obj, key, label) {
	const v = obj == null ? undefined : obj[key];
	if (v === undefined || v === null || v === "") fail(`缺少必填字段 ${label}（${key}）`);
}

// 严格类型校验：必须是 number 类型的整数（避免 Number("0x")=NaN 之类脏值绕过 fail-closed）
function mustPosInt(v, label) {
	if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
		fail(`${label} 必须是正整数（number 类型，得到 ${JSON.stringify(v)}）`);
	}
}
function mustNonNegInt(v, label) {
	if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
		fail(`${label} 必须是非负整数（number 类型，得到 ${JSON.stringify(v)}）`);
	}
}

// 取 正文/第{N}章_*.md 的原始章号串：记录文件名与其零填充宽度对齐
function chapterToken(project, chapter) {
	try {
		const dir = path.join(project, "正文");
		if (fs.existsSync(dir)) {
			for (const f of fs.readdirSync(dir)) {
				const m = f.match(/^第(\d+)章/);
				if (m && parseInt(m[1], 10) === chapter) return m[1];
			}
		}
	} catch (e) { /* 目录不可读时退回裸章号 */ }
	return String(chapter);
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const project = path.resolve(args.project);
	if (!fs.existsSync(project) || !fs.statSync(project).isDirectory()) {
		fail(`项目根不存在或不是目录：${project}`);
	}

	// --data 相对路径先按 CWD 解析，找不到再退回项目根
	let dataPath = path.resolve(args.data);
	if (!fs.existsSync(dataPath)) {
		const alt = path.join(project, args.data);
		if (fs.existsSync(alt)) dataPath = alt;
	}
	let data;
	try {
		data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
	} catch (e) {
		fail(`读取/解析 ${args.data} 失败：${e.message}`);
	}

	// —— 字段必填 + 严格类型 ——
	mustHave(data, "chapter", "chapter（章号）");
	mustPosInt(data.chapter, "chapter");
	const chapter = Number(data.chapter);
	mustHave(data.check1, "last_committed_chapter", "check1.last_committed_chapter");
	mustNonNegInt(data.check1.last_committed_chapter, "check1.last_committed_chapter");
	mustHave(data.check1, "state_revision", "check1.state_revision");
	mustNonNegInt(data.check1.state_revision, "check1.state_revision");
	mustHave(data.check2, "items", "check2.items（查2 差异列表）");
	if (!Array.isArray(data.check2.items)) fail("check2.items 必须是数组");
	const items = data.check2.items.filter((it) => it && typeof it === "object");
	if (items.length === 0) fail("check2.items 必须是非空数组（逐项列出细纲兑现核对）");
	mustHave(data.check3, "ai_blocking", "check3.ai_blocking");
	mustNonNegInt(data.check3.ai_blocking, "check3.ai_blocking");
	mustHave(data.check3, "deg_blocking", "check3.deg_blocking");
	mustNonNegInt(data.check3.deg_blocking, "check3.deg_blocking");
	mustHave(data, "conclusion", "conclusion（结论）");

	// —— fail-closed：查3 任一 blocking > 0 拒绝生成（除非显式放行）——
	const ai = data.check3.ai_blocking;
	const deg = data.check3.deg_blocking;
	if ((ai > 0 || deg > 0) && !args.allowBlocking) {
		fail(`查3 禁用词 Gate 未过：check-ai-patterns blocking=${ai}、check-degeneration blocking=${deg}。` +
			" 先改写正文清零再生成记录；确属误报需记录进展可加 --allow-blocking");
	}

	// —— 组装记录（固定模板，schema 与 review-log「正文审查」节一致）——
	const lines = [];
	lines.push(`# 正文审查 — 第${chapter}章${data.chapter_name ? " " + data.chapter_name : ""}`.trimEnd());
	lines.push("");
	const c1Ok = data.check1.ok !== false;
	lines.push(
		`- 查1 追踪状态（写前）：last_committed_chapter=${data.check1.last_committed_chapter} / ` +
			`state_revision=${data.check1.state_revision}；衔接 ${c1Ok ? "正常" : data.check1.note || "需说明"}`
	);
	lines.push("- 查2 细纲兑现（写后）：差异列表——");
	for (const it of items) {
		const note = typeof it.note === "string" && it.note ? it.note : "";
		lines.push(`  - ${it.item}：${it.ok === false ? "✗" : "✓"}${note ? "（" + note + "）" : ""}`);
	}
	const safeNote = typeof data.check3.note === "string" && data.check3.note
		? data.check3.note
		: ai + deg === 0 ? "无命中" : "见结论文档";
	lines.push(`- 查3 禁用词 Gate（写后）：check-ai-patterns blocking=${ai}、check-degeneration blocking=${deg}；${safeNote}`);
	lines.push("");
	lines.push("## 发现（S1-S4）");
	const findings = (Array.isArray(data.findings) ? data.findings : []).filter((f) => f && typeof f === "object");
	if (findings.length === 0) {
		lines.push("");
		lines.push("- 无");
	} else {
		for (const f of findings) {
			lines.push("");
			lines.push(
				`- [${f.level || "S4"}][${f.category || "consistency"}] ${f.desc || ""}；处置：${f.disposition || "待确认"}`
			);
		}
	}
	lines.push("");
	lines.push("## 结论");
	lines.push("");
	lines.push(`- 本章完成度：${data.conclusion}`);

	const token = chapterToken(project, chapter);
	const outDir = path.join(project, "大纲", "审查记录");
	fs.mkdirSync(outDir, { recursive: true });
	const out = path.join(outDir, `正文审查_第${token}章.md`);
	fs.writeFileSync(out, lines.join("\n") + "\n", "utf8");

	console.log(`WriteReview 落盘：${path.relative(project, out)}`);
	console.log(`  第${token}章 / 衔接=${c1Ok ? "正常" : "异常"} / blocking=${ai}/${deg} / 结论=${data.conclusion}`);
}

main();

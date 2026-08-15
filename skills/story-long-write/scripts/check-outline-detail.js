#!/usr/bin/env node
// check-outline-detail.js — 细纲字段完整性检测（防"薄细纲"）
//
// 细纲是正文的章节蓝图，缺执行层字段时正文写作无从编排：只有"是什么"没有
// "怎么写"，写出来的正文要么写薄、要么注水、要么破坏信息差。本脚本机械校验
// 每章细纲的必填硬字段与按需字段，只报缺项不自动改写。
//
// 判定口径（权威 = workflow-setup.md「细纲字段强度分层」）：
//   - 每章必填硬字段（缺任一即判 THIN，--check 退出 1）：
//     核心事件 / 字数目标 / 阶段位置 / 单元ID/位置 / 目标情绪 /
//     主角目标/关键选择 / 本章禁止提前释放 / 内容概括（五段式） /
//     情节安排（多线） / 人物关系和出场顺序 / 情节细化（含预算合计） /
//     结尾设定和钩子 / 本章设定引用
//   - 按需字段（缺项判 warning，不阻断）：本章结构公式 / 章首钩子 / 爽点 /
//     契约风险（低压/过场/信息整理章可弱化，但须有占位结论，不得整行删除）
//   - 情节细化子项（warning）：预算合计 / 密疏标注（密\d+ / 【密 / 疏\d+） /
//     复沓锚句 / 行动成本或收益归属 / 视角信息差（人物关系节的子项）
//   - 预算核对（warning）：预算合计数值 < 字数目标，或 > 字数目标 × 1.1
//     （目标为区间时按区间上限算，目标解析失败则跳过）
//   - 充实度（硬字段 13/13 齐全但内容空洞 → 判 LEAN，--check 退出 1）：
//     目标情绪须含「前→后」状态（不得只写"热血/悲伤"标签）/ 内容概括五段
//     须有实质内容且结尾段非状态判词 / 主线推进非空 / 出场顺序非空 /
//     情节细化情节点数（普通章 ≥5，短章<1500字 或 低压/过场/信息整理/关系回收
//     章 ≥3）且至少一条带 密/疏 标注 / 结尾设定有具体落点且非状态判词
//
// 用法：
//   node check-outline-detail.js [--check] [--json] <细纲文件或目录...>
//     --check  有 THIN 或 LEAN 判定时退出 1（供 hook/CI 用）；缺省只报告不退出
//     --json   输出 JSON 数组（含 status: THIN | LEAN | OK，供主会话程序化消费）
//   exit code：--check 且有 THIN/LEAN → 1；参数错误 → 2；正常 → 0
const fs = require("fs");
const path = require("path");

const USAGE = `Usage: node check-outline-detail.js [--check] [--json] <outline file or dir...>
Check required fields in chapter outlines (大纲/细纲/第NNN章.md).
  --check   exit 1 when any outline is THIN (missing required field); default reports only
  --json    output JSON array`;

// 硬字段检测：字段名出现在字段行（行首列表符/粗体后紧跟字段名+冒号），
// 或作为小节的 H3/H4 标题出现。别名用于各项目细纲的写法差异。
const HARD_FIELDS = [
	{
		name: "核心事件",
		aliases: [],
		mode: "field",
		re: /(?:^|\n)\s*[-*]\s*(?:\*\*)?核心事件(?:\*\*)?[：:]/,
	},
	{
		name: "字数目标",
		aliases: ["目标字数"],
		mode: "field",
		re: /(?:^|\n)\s*[-*]\s*(?:\*\*)?(?:字数目标|目标字数)(?:\*\*)?[：:]/,
	},
	{
		name: "阶段位置",
		aliases: [],
		mode: "field",
		re: /(?:^|\n)\s*[-*]\s*(?:\*\*)?阶段位置(?:\*\*)?[：:]/,
	},
	{
		name: "单元ID/位置",
		aliases: ["单元ID", "单元编号"],
		mode: "field",
		re: /(?:^|\n)\s*[-*]\s*(?:\*\*)?(?:单元ID|单元编号)(?:\*\*)?[：:/]/,
	},
	{
		name: "目标情绪",
		aliases: [],
		mode: "field",
		re: /(?:^|\n)\s*[-*]\s*(?:\*\*)?目标情绪(?:\*\*)?[：:]/,
	},
	{
		name: "主角目标/关键选择",
		aliases: ["主角目标", "关键选择"],
		mode: "field",
		re: /(?:^|\n)\s*[-*]\s*(?:\*\*)?(?:主角目标(?:\*\*)?[：:/]|关键选择(?:\*\*)?[：:])/,
	},
	{
		name: "本章禁止提前释放",
		aliases: ["禁止提前释放", "本章禁放"],
		mode: "field",
		re: /(?:^|\n)\s*[-*]\s*(?:\*\*)?(?:本章禁止提前释放|禁止提前释放)(?:\*\*)?[：:]/,
	},
	{
		name: "内容概括（五段式）",
		aliases: ["内容概括"],
		mode: "heading",
		re: /#{2,6}\s*内容概括/,
	},
	{
		name: "情节安排（多线）",
		aliases: ["情节安排"],
		mode: "heading",
		re: /#{2,6}\s*情节安排/,
	},
	{
		name: "人物关系和出场顺序",
		aliases: ["人物关系", "出场顺序", "人物关系变化"],
		mode: "both",
		re: /(?:#{2,6}\s*人物关系|(?:^|\n)\s*[-*]\s*(?:\*\*)?(?:出场顺序|人物关系变化|视角\/信息差)(?:\*\*)?[：:])/,
	},
	{
		name: "情节细化",
		aliases: ["情节点序列", "情节点"],
		mode: "both",
		re: /(?:#{2,6}\s*情节细化|(?:^|\n)\s*[-*]\s*(?:\*\*)?情节细化(?:\*\*)?[：:]|(?:^|\n)\s*[-*]\s*(?:\*\*)?情节点(?:\*\*)?[：:])/,
	},
	{
		name: "结尾设定和钩子",
		aliases: ["结尾设定", "章尾钩子", "章尾"],
		mode: "both",
		re: /(?:#{2,6}\s*结尾设定|(?:^|\n)\s*[-*]\s*(?:\*\*)?(?:结尾设定|章尾钩子)(?:\*\*)?[：:])/,
	},
	{
		name: "本章设定引用",
		aliases: ["设定引用"],
		mode: "field",
		re: /(?:^|\n)\s*[-*]\s*(?:\*\*)?(?:本章设定引用|设定引用)(?:\*\*)?[：:]/,
	},
];

// 按需字段：缺项只报 warning。低压/过场/信息整理章可弱化，但需占位结论。
const SOFT_FIELDS = [
	{
		name: "本章结构公式",
		aliases: ["结构公式"],
		re: /(?:^|\n)\s*[-*]\s*(?:\*\*)?(?:本章结构公式|结构公式)(?:\*\*)?[：:]/,
	},
	{
		name: "章首钩子",
		aliases: [],
		re: /(?:^|\n)\s*[-*]\s*(?:\*\*)?章首钩子(?:\*\*)?[：:]/,
	},
	{
		name: "爽点",
		aliases: [],
		re: /(?:^|\n)\s*[-*]\s*(?:\*\*)?爽点(?:\*\*)?[：:]/,
	},
	{
		name: "契约风险",
		aliases: [],
		re: /(?:^|\n)\s*[-*]\s*(?:\*\*)?契约风险(?:\*\*)?[：:]/,
	},
];

// 情节细化子项：warning 级，缺项说明细纲执行层仍偏薄
const DETAIL_SUB_FIELDS = [
	{ name: "预算合计", re: /预算合计/ },
	{ name: "密疏标注", re: /(?:【[^】]*[密疏]|密\d{2,4}|疏\d{1,3}|·密|·疏)/ },
	{ name: "复沓锚句", re: /复沓锚句/ },
	{ name: "行动成本/收益归属", re: /(?:行动成本|收益归属)/ },
	{ name: "视角/信息差", re: /(?:视角\/信息差|信息差)/ },
];

// 解析「字数目标：X 字」：支持 "8000 字"、"3000-4000 字"、"约 1842 字"
function parseWordTarget(text) {
	const m = text.match(
		/(?:字数目标|目标字数)[：:]\s*[约\s]*(\d{3,6})(?:\s*[-~至]\s*(\d{3,6}))?\s*字/,
	);
	if (!m) return null;
	const lo = parseInt(m[1], 10);
	const hi = m[2] ? parseInt(m[2], 10) : lo;
	return { lo, hi };
}

// 解析「预算合计：X字（目标Y，范围Y-Z）」/「预算合计：X字」/「预算合计：8000-8800字」；
// 支持全角/半角冒号；括号内备注不参与解析
function parseBudgetTotal(text) {
	const m = text.match(/预算合计[：:]\s*[约\s]*(\d{3,6})(?:\s*[-~至]\s*(\d{3,6}))?\s*字/);
	if (!m) return null;
	const lo = parseInt(m[1], 10);
	const hi = m[2] ? parseInt(m[2], 10) : lo;
	return { lo, hi };
}

// 提取章节定位（用于按需字段的报告提示）
function parseChapterPosition(text) {
	const m = text.match(
		/(?:^|\n)\s*[-*]\s*(?:\*\*)?章节定位(?:\*\*)?[：:]\s*([^\n，,。]{1,20})/,
	);
	return m ? m[1].trim() : null;
}

// 状态判词表：出现即视为"没写具体落点"（细纲模板明令禁止的状态式收尾）
const STATE_JUDGMENTS = [
	"尘埃落定", "一切结束", "就这样", "他终于明白", "一切尽在不言中",
	"就此别过", "无需多言", "尽在不言中", "最终", "终于",
];

// 空洞判定：长度 < 2 或纯占位词（"略/无/同上"式）——短句落点（"雨夜""到店"）不算空洞
const HOLLOW_WORDS = new Set(["略", "无", "同上", "同前", "见上", "无变化", "-", ""]);
function isHollow(value) {
	const bare = (value || "").replace(/[【】\[\]]/g, "").trim();
	return bare.length < 2 || HOLLOW_WORDS.has(bare);
}

// 低压/过场/信息整理/关系回收章：情节细化点数下限放宽（3 点），其余充实度照查
const LOW_PRESSURE_MARKERS = ["低压", "过场", "信息整理", "关系回收"];

// 取字段行的值（字段名+冒号后到行尾），去空白；找不到返回 null
function fieldValue(text, name) {
	const m = text.match(
		new RegExp(`(?:^|\\n)\\s*[-*]\\s*(?:\\*\\*)?${name}(?:\\*\\*)?[：:]\\s*([^\\n]*)`),
	);
	return m ? m[1].trim() : null;
}

// 取小节正文（#### 标题 到下一个 ####/###/## 或文末）
function sectionBody(text, heading) {
	const m = text.match(
		new RegExp(`#{2,6}\\s*${heading}[^\\n]*\\n([\\s\\S]*?)(?=\\n#{2,6}\\s|\\n## |$)`),
	);
	return m ? m[1] : null;
}

// 充实度检查（LEAN 判定）：硬字段齐全但内容空洞。只报可机械判定的空洞，
// 不评判文学质量；低压/短章按规则放宽下限，避免误伤。
function checkQuality(text, position, wordTarget) {
	const warnings = [];
	const lowPressure = position && LOW_PRESSURE_MARKERS.some((m) => position.includes(m));
	const shortChapter = wordTarget && wordTarget.lo < 1500;

	// 1. 目标情绪须含「前→后」状态（模板：不得只写"热血/悲伤"标签）
	const emo = fieldValue(text, "目标情绪");
	if (emo && !/→|->|至|到/.test(emo)) {
		warnings.push("目标情绪缺少「前→后」状态（模板要求：具体情绪前状态→后状态，不得只写标签）");
	}

	// 2. 内容概括五段：各段有实质内容；结尾段非状态判词
	const summary = sectionBody(text, "内容概括");
	if (summary) {
		for (const seg of ["起因", "发展", "转折", "高潮", "结尾"]) {
			const v = fieldValue(summary, seg);
			if (v === null) {
				warnings.push(`内容概括·${seg} 段缺失`);
				continue;
			}
			if (isHollow(v)) {
				warnings.push(`内容概括·${seg} 过空（${v || "空"}）——写具体落点，不写"略/同上"式占位`);
			} else if (seg === "结尾" && STATE_JUDGMENTS.some((w) => v.includes(w))) {
				warnings.push(`内容概括·结尾 是状态判词（${v}）——写具体动作/画面落点`);
			}
		}
	}

	// 3. 情节安排·主线推进非空
	const mainline = fieldValue(text, "主线推进");
	if (mainline !== null && isHollow(mainline)) {
		warnings.push("情节安排·主线推进 过空——写清本章对主目标的推进");
	}

	// 4. 人物关系和出场顺序·出场顺序非空
	const order = fieldValue(text, "出场顺序");
	if (order !== null && isHollow(order)) {
		warnings.push("人物关系和出场顺序·出场顺序 过空——按实际出现顺序列出角色/势力/关键物件");
	}

	// 5. 情节细化：情节点数下限 + 至少一条密/疏标注
	// 情节点识别兼容两种写法：模板示例「- 情节点1：内容【铺垫·疏40】」与
	// 直接列表项「- 内容【铺垫·疏40】」（带密/疏标注或功能标签即视为情节点）
	const detail = sectionBody(text, "情节细化");
	if (detail) {
		const pointLineRe = /^\s*[-*]\s+(?:\*\*)?情节点|^\s*[-*]\s+[^【\n]*(?:【[^】]*[密疏][^】]*】|·密|·疏|密\d{2,4}|疏\d{1,3})/;
		const pointLines = new Set();
		detail.split("\n").forEach((l) => { if (pointLineRe.test(l)) pointLines.add(l.trim()); });
		const points = pointLines.size;
		const min = shortChapter || lowPressure ? 3 : 5;
		if (points < min) {
			warnings.push(`情节细化·情节点 ${points} 个 < ${min}（普通章 ≥5；<1500 字短章或低压/过场/信息整理/关系回收章 ≥3；写法：「- 情节点N：内容【密/疏+字数】」或「- 内容【密/疏+字数】」）`);
		}
		if (!/(?:【[^】]*[密疏]|·密|·疏|密\d{2,4}|疏\d{1,3})/.test(detail)) {
			warnings.push("情节细化·情节点缺少 密/疏 标注（每点标 密/疏 + 字数预算，如【铺垫·疏40】【高潮·密400】）");
		}
	}

	// 6. 结尾设定：有具体落点，非状态判词
	const ending = fieldValue(text, "结尾设定");
	if (ending !== null) {
		if (isHollow(ending)) {
			warnings.push("结尾设定 过空——写清收束落到什么具体动作或画面");
		} else if (STATE_JUDGMENTS.some((w) => ending.includes(w))) {
			warnings.push(`结尾设定 是状态判词（${ending}）——写具体落点，不写"就这样/他终于明白"式状态`);
		}
	}

	return warnings;
}

function checkOutline(text) {
	const missingHard = [];
	const missingSoft = [];
	const detailWarnings = [];

	for (const f of HARD_FIELDS) {
		if (!f.re.test(text)) missingHard.push(f.name);
	}
	for (const f of SOFT_FIELDS) {
		if (!f.re.test(text)) missingSoft.push(f.name);
	}
	for (const f of DETAIL_SUB_FIELDS) {
		if (!f.re.test(text)) detailWarnings.push(f.name);
	}

	// 预算核对（仅在硬字段齐全或预算合计存在时做）：预算值（或区间）应落在 [目标下限, 目标上限×1.1] 内
	if (!detailWarnings.includes("预算合计")) {
		const target = parseWordTarget(text);
		const total = parseBudgetTotal(text);
		if (target && total !== null) {
			if (total.lo < target.lo) {
				detailWarnings.push(`预算合计 ${total.lo} < 字数目标下限 ${target.lo}`);
			} else if (total.hi > Math.round(target.hi * 1.1)) {
				detailWarnings.push(`预算合计 ${total.hi} > 字数目标上限 ${target.hi} × 1.1`);
			}
		}
	}

	const position = parseChapterPosition(text);
	const thin = missingHard.length > 0;
	const qualityWarnings = thin ? [] : checkQuality(text, position, parseWordTarget(text));
	const lean = qualityWarnings.length > 0;
	return { thin, lean, missingHard, missingSoft, detailWarnings, qualityWarnings, position };
}

function readText(file) {
	try {
		return fs.readFileSync(file, "utf8");
	} catch (err) {
		return null;
	}
}

function isOutlineFile(file) {
	return /\.md$/i.test(file);
}

// 展开参数：文件直接入列；目录扫全部 .md（细纲目录通常就是 大纲/细纲/）
function expandArgs(args) {
	const files = [];
	for (const a of args) {
		let st;
		try {
			st = fs.statSync(a);
		} catch (err) {
			files.push(a); // 保留原样，由 readText 报错
			continue;
		}
		if (st.isDirectory()) {
			const entries = fs.readdirSync(a).sort();
			for (const e of entries) {
				const full = path.join(a, e);
				if (isOutlineFile(e) && fs.statSync(full).isFile()) files.push(full);
			}
		} else if (st.isFile()) {
			files.push(a);
		}
	}
	return files;
}

function main() {
	const args = process.argv.slice(2);
	let check = false;
	let json = false;
	const paths = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--check") check = true;
		else if (a === "--json") json = true;
		else if (a.startsWith("--")) {
			console.error(USAGE);
			process.exit(2);
		} else {
			paths.push(a);
		}
	}
	if (paths.length === 0) {
		console.error(USAGE);
		process.exit(2);
	}

	const files = expandArgs(paths);
	const results = [];
	let anyThin = false;
	let anyLean = false;
	let anyError = false;
	for (const f of files) {
		const text = readText(f);
		if (text === null) {
			results.push({ file: f, error: `cannot read: ${f}` });
			anyError = true;
			continue;
		}
		const r = checkOutline(text);
		results.push({ file: f, status: r.thin ? "THIN" : r.lean ? "LEAN" : "OK", ...r });
		if (r.thin) anyThin = true;
		if (r.lean) anyLean = true;
	}

	if (json) {
		console.log(JSON.stringify(results, null, 2));
	} else {
		for (const r of results) {
			if (r.error) {
				console.error(`[ERROR] ${r.file}: ${r.error}`);
				continue;
			}
			if (r.lean) {
				const warnText = r.detailWarnings.length
					? ` · 细化提示 ${r.detailWarnings.length} 条`
					: "";
				console.log(`[LEAN] ${r.file}: 硬字段 13/13 但充实度不足（${r.qualityWarnings.length} 项${warnText}）`);
				for (const w of r.qualityWarnings) {
					console.log(`    W: ${w}`);
				}
				for (const w of r.detailWarnings) {
					console.log(`    W: ${w}`);
				}
				if (r.position) {
					console.log(
						`    i: 章节定位「${r.position}」——按细纲模板补齐空洞字段后再写正文，正文只按细纲执行`,
					);
				}
				continue;
			}
			if (!r.thin) {
				const warnText = r.detailWarnings.length
					? ` · 细化提示 ${r.detailWarnings.length} 条`
					: "";
				console.log(`[OK] ${r.file}（硬字段 13/13${warnText}）`);
				for (const w of r.detailWarnings) {
					console.log(`    W: ${w}`);
				}
				continue;
			}
			console.log(
				`[THIN] ${r.file}: 缺硬字段 ${r.missingHard.length} 项：${r.missingHard.join("、")}`,
			);
			if (r.missingSoft.length) {
				console.log(
					`    W: 按需字段缺失（低压/过场章可弱化，但须占位结论）：${r.missingSoft.join("、")}`,
				);
			}
			for (const w of r.detailWarnings) {
				console.log(`    W: ${w}`);
			}
			if (r.position) {
				console.log(
					`    i: 章节定位「${r.position}」——情节细化（情节点序列+密/疏+预算合计）是写正文的编排依据，缺了正文只能临场发挥`,
				);
			}
		}
	}

	if (check && (anyThin || anyLean || anyError)) process.exit(1);
	process.exit(0);
}

main();

#!/usr/bin/env node
// check-outline-copy.js — 细纲照搬检测（正文退化成誊抄的确定性证据）
//
// 细纲的情节点一旦写成成品散文句，正文就只剩誊抄——全章最好的几句在写细纲那一步
// 就定死了。本脚本检测正文与同章细纲的**连续**重合片段（>15 字即报），只提供证据
// 不自动改写：系统面板、誓词、案卷原话、固定专名本就该逐字一致（细纲「复沓锚句」
// 字段显式登记这些原话，检测时豁免）。
//
// 用法：
//   node check-outline-copy.js [--check] [--json] [--outline <细纲文件>] <正文文件...>
//     --outline 指定细纲文件；缺省时对每个正文文件自动找同目录/同名的细纲
//               （正文/第001章_X.md → 大纲/细纲/第001章.md；找不到则跳过该正文）
//     --check    有命中时退出 1（供 hook/CI 用）；缺省只报告不退出
//     --json     输出 JSON 数组（供主会话程序化消费）
//   exit code：--check 且有命中 → 1；参数错误 → 2；正常 → 0
//
// 判定口径：
//   - 只比「连续重合」：正文与细纲各自去空白后，滑动窗口找最长公共连续子串；
//     长度 > 15 字（去空白后）即记一条命中
//   - 复沓锚句豁免：细纲「复沓锚句」字段逐行列出的原话（去空白后）从细纲文本中
//     先剔除，再参与比对——锚句是「必须原样进正文」的合法逐字一致
//   - 命中信息：正文文件、细纲文件、重合片段（截断 60 字）、正文行号
const fs = require('fs');
const path = require('path');

const USAGE = `Usage: node check-outline-copy.js [--check] [--json] [--outline <细纲文件>] <正文文件...>
Detect prose that merely copies the chapter outline (longest common contiguous run > 15 chars).
  --outline   explicit outline file; default: auto-match per prose file (正文/第NNN章_X.md → 大纲/细纲/第NNN章.md)
  --check     exit 1 when any finding; default reports only
  --json      output JSON array`;

const MIN_RUN = 15; // 去空白后连续重合的最小字符数

function stripWs(s) {
	return s.replace(/\s+/g, '');
}

// 提取细纲「复沓锚句」字段的原文行（去空白后），用于豁免
function extractAnchorLines(outlineText) {
	const lines = outlineText.split('\n');
	const anchors = [];
	let inAnchor = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (/复沓锚句/.test(trimmed) && /[:：]/.test(trimmed)) {
			inAnchor = true;
			const rest = trimmed.split(/[:：]/).slice(1).join('：').trim();
			if (rest && !/^无$|^没有|^暂/.test(rest)) anchors.push(rest);
			continue;
		}
		if (inAnchor) {
			// 锚句字段的续行：以 - / * 开头的条目，或普通文本，直到空行/下一个字段
			if (!trimmed) break;
			if (/^#{1,6}\s/.test(trimmed)) break;
			// 先判「新字段」再判「锚句条目」：`- 情节细化：` 这类带字段名的行
			// 是下一个字段，不是锚句内容；`- "原话"` 才是锚句条目
			if (/^[-*]\s*[^：:]{1,12}[：:]/.test(trimmed)) break;
			if (/^[-*]\s+/.test(trimmed)) {
				anchors.push(trimmed.replace(/^[-*]\s+/, '').trim());
			} else if (/^[^：:]+[:：]/.test(trimmed)) {
				break; // 下一个字段（无列表符号的字段行）
			} else {
				anchors.push(trimmed);
			}
		}
	}
	return anchors.filter(Boolean);
}

// 在去除锚句后的细纲里找与正文片段的最长连续重合
function findLongestCommonRun(proseClean, outlineClean) {
	// 简化实现：对正文每个位置，在细纲里尝试匹配尽可能长的连续子串
	let best = { len: 0, proseStart: -1, outlineStart: -1 };
	const outlineLen = outlineClean.length;
	const proseLen = proseClean.length;
	if (outlineLen === 0 || proseLen === 0) return best;

	// 用「正文片段 → 细纲中首次出现位置」做起点加速：只查 prose 里 8 字以上的
	// 连续窗口是否出现在 outline 中，再向两边扩展
	const MIN_SEED = 8;
	const seen = new Set();
	for (let i = 0; i + MIN_SEED <= proseLen && i + MIN_SEED <= outlineLen; i++) {
		const seed = proseClean.slice(i, i + MIN_SEED);
		if (seen.has(seed)) continue;
		seen.add(seed);
		const start = outlineClean.indexOf(seed);
		if (start < 0) continue;
		// 向左右扩展公共子串
		let left = 0;
		let right = MIN_SEED;
		while (start - left - 1 >= 0 && i - left - 1 >= 0 &&
			proseClean[i - left - 1] === outlineClean[start - left - 1]) left++;
		while (start + right < outlineLen && i + right < proseLen &&
			proseClean[i + right] === outlineClean[start + right]) right++;
		const len = left + right;
		if (len > best.len) {
			best = { len, proseStart: i - left, outlineStart: start - left };
		}
	}
	return best;
}

function readText(file) {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch (err) {
		return null;
	}
}

// 正文文件 → 自动匹配细纲文件（正文/第NNN章_X.md → 大纲/细纲/第NNN章.md）
function autoOutlineFor(proseFile) {
	const base = path.basename(proseFile);
	const m = base.match(/^第(\d+)章/);
	if (!m) return null;
	const dir = path.dirname(proseFile);
	// 项目根：正文/ 的上一级
	const projectRoot = path.resolve(dir, '..');
	const chapter = m[1];
	const candidates = [
		path.join(projectRoot, '大纲', '细纲', `第${chapter}章.md`),
		path.join(projectRoot, '大纲', '细纲', `第${chapter.padStart(3, '0')}章.md`),
	];
	for (const c of candidates) {
		if (fs.existsSync(c)) return c;
	}
	// 同目录兜底（demo/测试用扁平结构）
	const sameDir = path.join(dir, `第${chapter}章.md`);
	return fs.existsSync(sameDir) ? sameDir : null;
}

function checkFile(proseFile, outlineFile) {
	const proseText = readText(proseFile);
	if (proseText === null) return { error: `cannot read prose: ${proseFile}` };
	const outlineText = readText(outlineFile);
	if (outlineText === null) return { error: `cannot read outline: ${outlineFile}` };

	const proseClean = stripWs(proseText);
	const anchors = extractAnchorLines(outlineText);
	let outlineClean = stripWs(outlineText);
	for (const a of anchors) {
		outlineClean = outlineClean.split(stripWs(a)).join('');
	}

	// 正文行号定位：找到 proseStart 对应的原始行
	function lineForPos(pos) {
		let line = 1;
		for (let i = 0; i < pos && i < proseText.length; i++) {
			if (proseText[i] === '\n') line++;
		}
		return line;
	}

	const findings = [];
	// 多次检测：找到最长重合后，从正文中剔除该段继续找，避免一次只报一条
	let workProse = proseClean;
	let workOutline = outlineClean;
	let guard = 0;
	while (guard++ < 20) {
		const best = findLongestCommonRun(workProse, workOutline);
		if (best.len <= MIN_RUN) break;
		const fragment = workProse.slice(best.proseStart, best.proseStart + best.len);
		// 正文原始行号（按去空白前的位置近似：用 proseClean 中该段前的换行数）
		const line = lineForPos(best.proseStart);
		findings.push({
			file: proseFile,
			outline: outlineFile,
			runLength: best.len,
			fragment: fragment.slice(0, 60),
			line,
		});
		// 从工作副本剔除该段，继续找下一处（正文和细纲都剔，防同一段重复报）
		workProse = workProse.slice(0, best.proseStart) + workProse.slice(best.proseStart + best.len);
		workOutline = workOutline.slice(0, best.outlineStart) + workOutline.slice(best.outlineStart + best.len);
	}
	return { findings, anchors: anchors.length };
}

function main() {
	const args = process.argv.slice(2);
	let check = false;
	let json = false;
	let outline = null;
	const files = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === '--check') check = true;
		else if (a === '--json') json = true;
		else if (a === '--outline') {
			i++;
			if (i >= args.length) {
				console.error(USAGE);
				process.exit(2);
			}
			outline = args[i];
		} else if (a.startsWith('--')) {
			console.error(USAGE);
			process.exit(2);
		} else {
			files.push(a);
		}
	}
	if (files.length === 0) {
		console.error(USAGE);
		process.exit(2);
	}

	const results = [];
	let anyFinding = false;
	for (const f of files) {
		const o = outline || autoOutlineFor(f);
		if (!o) {
			results.push({ file: f, skipped: true, reason: 'no outline matched' });
			continue;
		}
		const r = checkFile(f, o);
		if (r.error) {
			results.push({ file: f, error: r.error });
			continue;
		}
		results.push({ file: f, outline: o, findings: r.findings, anchorCount: r.anchors });
		if (r.findings.length > 0) anyFinding = true;
	}

	if (json) {
		console.log(JSON.stringify(results, null, 2));
	} else {
		for (const r of results) {
			if (r.error) {
				console.error(`[ERROR] ${r.file}: ${r.error}`);
				continue;
			}
			if (r.skipped) {
				console.log(`[SKIP] ${r.file}: ${r.reason}`);
				continue;
			}
			if (r.findings.length === 0) {
				console.log(`[OK] ${r.file}（与 ${r.outline} 无超限连续重合${r.anchorCount ? `；锚句 ${r.anchorCount} 条已豁免` : ''}）`);
				continue;
			}
			console.log(`[COPY] ${r.file}: ${r.findings.length} 处连续重合 >${MIN_RUN} 字`);
			for (const f of r.findings) {
				console.log(`  L${f.line} 连续 ${f.runLength} 字：「${f.fragment}」`);
			}
		}
	}

	if (check && anyFinding) process.exit(1);
	process.exit(0);
}

main();

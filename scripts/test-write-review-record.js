#!/usr/bin/env node
"use strict";
// test-write-review-record.js — write-review-record.js 回归测试
// 覆盖：合法 JSON 生成记录 / 缺必填字段 exit 1 / 查3 blocking>0 拒绝生成（fail-closed）/
// --allow-blocking 放行 / --data 相对路径回退项目根 / 生成记录满足 --scope review 内容要求。
// 说明：子进程用 stdio:'inherit' 直通，避免沙箱下管道捕获 EPERM；断言只依赖退出码与落盘文件。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "skills", "story-long-write", "scripts", "write-review-record.js");

let failures = 0;
function ok(cond, msg) {
	if (cond) console.log("  PASS: " + msg);
	else {
		console.error("  FAIL: " + msg);
		failures++;
	}
}

function runRecord(project, dataPath, extra = []) {
	const r = spawnSync(
		process.execPath,
		[SCRIPT, "--project", project, "--data", dataPath, ...extra],
		{ stdio: "inherit" },
	);
	if (r.error) return { code: 1, err: String(r.error) };
	return { code: r.status == null ? 1 : r.status, err: "" };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wrrecord-"));
const project = path.join(tmp, "proj");
fs.mkdirSync(path.join(project, "大纲", "审查记录"), { recursive: true });

const valid = {
	chapter: 12,
	chapter_name: "初见",
	check1: { last_committed_chapter: 11, state_revision: 37, ok: true, note: "衔接正常" },
	check2: {
		items: [
			{ item: "核心事件", ok: true, note: "" },
			{ item: "禁止提前释放", ok: true, note: "未泄露" },
			{ item: "复沓锚句", ok: false, note: "第5段缺锚句，已补写" },
		],
	},
	check3: { ai_blocking: 0, deg_blocking: 0, note: "无命中" },
	findings: [
		{ level: "S3", category: "consistency", desc: "掌柜称呼不一致已在首处统一", disposition: "已修" },
	],
	conclusion: "可进入下一章",
};
const dataPath = path.join(tmp, "review.json");
fs.writeFileSync(dataPath, JSON.stringify(valid), "utf8");

console.log("用例1：合法 JSON 生成记录");
let r = runRecord(project, dataPath);
ok(r.code === 0, "exit 0（得到 " + r.code + "）" + (r.err ? " err=" + r.err : ""));
const rec = path.join(project, "大纲", "审查记录", "正文审查_第12章.md");
ok(fs.existsSync(rec), "记录文件已生成");
if (fs.existsSync(rec)) {
	const txt = fs.readFileSync(rec, "utf8");
	ok(txt.includes("last_committed_chapter=11"), "含查1 章号");
	ok(txt.includes("state_revision=37"), "含查1 修订号");
	ok(txt.includes("check-ai-patterns blocking=0"), "含查3 ai blocking");
	ok(txt.includes("check-degeneration blocking=0"), "含查3 deg blocking");
	ok(txt.includes("✗"), "含查2 差异 ✗");
	ok(/^## 结论/m.test(txt) && /可进入下一章/.test(txt), "含结论");
	ok(/S3/.test(txt), "含 S 级发现");
	ok(txt.trim().length > 40 && /S1|S2|S3|S4|结论|发现|处置/.test(txt), "满足 check-project-consistency --scope review 内容要求");
}

console.log("用例2：缺必填字段 → exit 1（非 2）");
const bad = JSON.parse(JSON.stringify(valid));
delete bad.check3.ai_blocking;
fs.writeFileSync(dataPath, JSON.stringify(bad), "utf8");
r = runRecord(project, dataPath);
ok(r.code === 1, "exit 1（得到 " + r.code + "）");

console.log("用例3：查3 blocking>0 → fail-closed 拒绝生成");
const blk = JSON.parse(JSON.stringify(valid));
blk.chapter = 13;
blk.check3.ai_blocking = 2;
blk.chapter_name = undefined;
const blkPath = path.join(tmp, "blk.json");
fs.writeFileSync(blkPath, JSON.stringify(blk), "utf8");
r = runRecord(project, blkPath);
ok(r.code === 1, "exit 1（得到 " + r.code + "）");
ok(!fs.existsSync(path.join(project, "大纲", "审查记录", "正文审查_第13章.md")), "未生成带毒记录");

console.log("用例4：blocking>0 + --allow-blocking → 放行生成");
r = runRecord(project, blkPath, ["--allow-blocking"]);
ok(r.code === 0, "exit 0 with --allow-blocking（得到 " + r.code + "）");
ok(fs.existsSync(path.join(project, "大纲", "审查记录", "正文审查_第13章.md")), "允许时生成记录");

console.log("用例5：--data 相对路径回退项目根");
fs.writeFileSync(path.join(project, "rel.json"), JSON.stringify(valid), "utf8");
r = runRecord(project, "rel.json");
ok(r.code === 0, "相对路径回退项目根解析（得到 " + r.code + "）");

console.log("用例6：记录文件名与 正文/ 章号零填充宽度对齐");
const padProj = path.join(tmp, "padproj");
fs.mkdirSync(path.join(padProj, "正文"), { recursive: true });
fs.mkdirSync(path.join(padProj, "大纲", "审查记录"), { recursive: true });
fs.writeFileSync(path.join(padProj, "正文", "第012章_天亮之前.md"), "正文", "utf8");
const padData = JSON.parse(JSON.stringify(valid));
const padPath = path.join(tmp, "pad.json");
fs.writeFileSync(padPath, JSON.stringify(padData), "utf8");
r = runRecord(padProj, padPath);
ok(r.code === 0, "对齐项目 exit 0（得到 " + r.code + "）");
ok(fs.existsSync(path.join(padProj, "大纲", "审查记录", "正文审查_第012章.md")), "生成 正文审查_第012章.md（零填充对齐）");
ok(!fs.existsSync(path.join(padProj, "大纲", "审查记录", "正文审查_第12章.md")), "未生成裸章号文件名");

console.log("用例7：脏值绕过 fail-closed 被拒（Number(\"0x\")=NaN 之类）");
const dirty = JSON.parse(JSON.stringify(valid));
dirty.check3.ai_blocking = "0x";
const dirtyPath = path.join(tmp, "dirty.json");
fs.writeFileSync(dirtyPath, JSON.stringify(dirty), "utf8");
r = runRecord(project, dirtyPath);
ok(r.code === 1, "ai_blocking=\"0x\" 应 exit 1（得到 " + r.code + "）");
const dirty2 = JSON.parse(JSON.stringify(valid));
dirty2.chapter = "abc";
const dirty2Path = path.join(tmp, "dirty2.json");
fs.writeFileSync(dirty2Path, JSON.stringify(dirty2), "utf8");
r = runRecord(project, dirty2Path);
ok(r.code === 1, "chapter=\"abc\" 应 exit 1（得到 " + r.code + "）");

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "PASS: test-write-review-record.js" : "FAIL: " + failures + " case(s)");
process.exit(failures === 0 ? 0 : 1);

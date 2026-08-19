#!/usr/bin/env node
"use strict";

// test-project-consistency.js — check-project-consistency.js 回归
// 夹具：good（全 PASS）与 bad（11 类问题全命中）
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const script = path.join(repoRoot, "skills/story-long-write/scripts/check-project-consistency.js");

function mkProject(name) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "projcons-" + name + "-"));
  const mk = (rel) => fs.mkdirSync(path.join(tmp, rel), { recursive: true });
  mk("设定/角色"); mk("设定/世界观"); mk("设定/势力");
  mk("大纲/卷纲"); mk("大纲/细纲"); mk("大纲/审查记录");
  return tmp;
}

function run(project, args) {
  return spawnSync(process.execPath, [script, "--project", project, ...args], { encoding: "utf8" });
}

// good project
const good = mkProject("good");
fs.writeFileSync(path.join(good, "设定", "关系.md"), "- **江晨**：主角\n- 钟嘉嘉：女主\n");
fs.writeFileSync(path.join(good, "设定", "角色", "江晨.md"), "# 江晨\n\n## 角色线\n\n### 阶段 1：开篇\n- 目标\n\n### 阶段 2：发展\n- 目标\n");
fs.writeFileSync(path.join(good, "设定", "角色", "钟嘉嘉.md"), "# 钟嘉嘉\n\n## 角色线\n\n### 阶段 1：开篇\n- 目标\n");
fs.writeFileSync(path.join(good, "设定", "世界观", "力量体系.md"), "# 力量体系\n");
fs.writeFileSync(path.join(good, "设定", "势力", "文工团.md"), "# 文工团\n");
fs.writeFileSync(path.join(good, "大纲", "大纲.md"), "## 全书体量与阶段总览\n\n- 总章节数：100\n");
fs.writeFileSync(path.join(good, "大纲", "卷纲", "第1卷.md"), "## 第一卷\n\n### 剧情单元\n- U1\n\n### 情绪弧线\n- 表\n\n### 人物弧线\n- 表\n\n### 伏笔\n- 表\n\n### 反转\n- 表\n\n### 对标结构坐标\n- 表\n");
fs.writeFileSync(path.join(good, "大纲", "细纲", "第001章.md"), "# 细纲\n\n- 本章设定引用：角色卡:江晨；世界观:力量体系；势力:文工团\n");
fs.writeFileSync(path.join(good, "大纲", "审查记录", "设定审查.md"), "# 设定审查\n\n- 审查范围：角色卡\n- 发现：无 S1/S2\n- 处置：无\n- 结论：通过\n");

// bad project
const bad = mkProject("bad");
fs.writeFileSync(path.join(bad, "设定", "关系.md"), "- **俞师师**：女配\n");
fs.writeFileSync(path.join(bad, "设定", "角色", "江晨.md"), "# 江晨\n\n## 角色线\n\n### 阶段 2：发展\n- 目标\n\n### 阶段 4：高潮\n- 目标\n");
fs.writeFileSync(path.join(bad, "大纲", "大纲.md"), "# 大纲\n");
fs.writeFileSync(path.join(bad, "大纲", "卷纲", "第1卷.md"), "## 第一卷\n\n### 剧情单元\n- U1\n");
fs.writeFileSync(path.join(bad, "大纲", "细纲", "第001章.md"), "# 细纲\n\n- 本章设定引用：角色卡:俞师师；世界观:不存在的设定\n");

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`[PASS] ${name}`);
  else { failures++; console.error(`[FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

const rGood = run(good, []);
check("good 项目全 PASS", rGood.status === 0 && rGood.stdout.includes("Result: PASS"), rGood.stdout.slice(-300));
const rBad = run(bad, ["--check"]);
check("bad 项目退出 1", rBad.status === 1, `status=${rBad.status}`);
check("bad 命中索引缺失", rBad.stdout.includes("俞师师"));
check("bad 命中阶段编号", rBad.stdout.includes("[S1][stage]"));
check("bad 命中卷纲字段", rBad.stdout.includes("[FAIL][outline]"));
check("bad 命中设定引用", rBad.stdout.includes("[S2][ref]"));
check("bad 命中审查记录缺失", rBad.stdout.includes("[FAIL][review]"));
const rJson = run(good, ["--json"]);
check("--json 输出", rJson.status === 0 && rJson.stdout.includes("\"setup\""), rJson.stdout.slice(0, 100));

// mixed project：模板示例写法（组合 / 与 § 与 · 阶段）+ 角色线阶段标题机械核对
const mixed = mkProject("mixed");
fs.writeFileSync(path.join(mixed, "设定", "角色", "江晨.md"), "# 江晨\n\n## 角色线\n\n### 阶段 1：开篇\n- 目标\n\n### 阶段 2：发展\n- 目标\n");
fs.writeFileSync(path.join(mixed, "设定", "角色", "张耀祖.md"), "# 张耀祖\n\n## 角色线\n\n### 阶段 1：开篇\n- 目标\n");
fs.writeFileSync(path.join(mixed, "设定", "世界观", "力量体系.md"), "# 力量体系\n");
fs.writeFileSync(path.join(mixed, "设定", "势力", "文工团.md"), "# 文工团\n");
// ① 模板示例写法不误报：角色卡:A/B 拆名、世界观:X§小节 取文件、物品不查
fs.writeFileSync(path.join(mixed, "大纲", "细纲", "组合.md"), "# 细纲\n\n- 本章设定引用：角色卡:江晨/张耀祖；世界观:力量体系§传送阵；势力:文工团；物品:龙血针\n");
// ② 规范单名 + 阶段标题存在 → 不报
fs.writeFileSync(path.join(mixed, "大纲", "细纲", "阶段存在.md"), "# 细纲\n\n- 本章设定引用：角色卡:江晨；角色线:江晨·阶段2；世界观:力量体系\n");
// ③ 阶段标题缺失 → 命中机械核对
fs.writeFileSync(path.join(mixed, "大纲", "细纲", "阶段缺失.md"), "# 细纲\n\n- 本章设定引用：角色线:江晨·阶段9\n");
// ④ 组合 token 中缺失的角色 → 命中
fs.writeFileSync(path.join(mixed, "大纲", "细纲", "角色缺失.md"), "# 细纲\n\n- 本章设定引用：角色卡:江晨/路人甲\n");
const rMixed = run(mixed, ["--scope", "detail"]);
check("mixed 运行无用法错误", rMixed.status === 0, `status=${rMixed.status}`);
check("组合写法不误报（角色卡:A/B 拆名）", !rMixed.stdout.includes("组合.md"), rMixed.stdout);
check("世界观:X§小节 不误报", !rMixed.stdout.includes("力量体系§传送阵"), rMixed.stdout);
check("阶段存在不误报（角色线:名·阶段N 有标题）", !rMixed.stdout.includes("阶段存在.md"), rMixed.stdout);
check("阶段缺失命中机械核对", rMixed.stdout.includes("阶段 9") && rMixed.stdout.includes("江晨.md「角色线」"), rMixed.stdout);
check("组合中缺失角色命中", rMixed.stdout.includes("角色卡:路人甲"), rMixed.stdout);
fs.rmSync(mixed, { recursive: true, force: true });

fs.rmSync(good, { recursive: true, force: true });
fs.rmSync(bad, { recursive: true, force: true });

console.log(failures === 0 ? "PASS: test-project-consistency.js" : `FAIL: ${failures} case(s)`);
process.exit(failures === 0 ? 0 : 1);

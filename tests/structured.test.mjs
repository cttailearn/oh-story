import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectStructuredKind,
  parseStructured,
  serializeStructured,
} from "../skills/story/assets/structured.mjs";

test("detectStructuredKind 按路径分类", () => {
  assert.equal(detectStructuredKind("书/设定/角色/江晨.md"), "character-card");
  assert.equal(detectStructuredKind("书/大纲/角色线/江晨.md"), "arc");
  assert.equal(detectStructuredKind("书/追踪/角色线/江晨.md"), "arc");
  assert.equal(detectStructuredKind("书/追踪/角色状态/江晨.md"), "character-status");
  assert.equal(detectStructuredKind("书/设定/世界观/背景设定.md"), "settings-doc");
  assert.equal(detectStructuredKind("书/设定/文风.md"), "settings-doc");
  assert.equal(detectStructuredKind("书/正文/第001章.md"), null);
  assert.equal(detectStructuredKind("书/设定/角色/江晨.txt"), null);
});

const CARD = [
  "---",
  "name: 江晨",
  "---",
  "",
  "# 江晨",
  "",
  "## 基本信息",
  "",
  "- **身份**：火箭军文工团宣传兵",
  "- **核心特质**：商业嗅觉极锐",
  "- **当前能力**（系统赋予）：",
  "  - 天王级唱功（第 11 章）",
  "  - 大师级导演能力（第 1 章）",
  "- **核心动机**：用地球文娱神作重振新媒体处女地",
  "- **弱点/缺陷**：专注创作时对外界完全屏蔽",
  "",
  "---",
  "",
  "## 外在表现",
  "",
  "**身份/外貌**",
  "军艺毕业，军装舞台照被刷屏。",
  "",
  "## 出场记录",
  "",
  "| 章节 | 关键事件 | 状态变化 |",
  "|------|---------|---------|",
  "| 第 1 章 | 穿越报到 | 认清机会 |",
  "| 第 2 章 | 发布首支视频 | 完成首发 |",
  "",
  "## 别名",
  "",
  "- 江导（战友称）",
  "- 晨哥（战友称）",
  "",
].join("\n");

test("角色卡：解析 + 保真回写 + 编辑", () => {
  const view = parseStructured(CARD, "character-card");
  assert.equal(view.kind, "character-card");
  assert.equal(view.title, "江晨");
  assert.equal(view.basic.length, 5);
  assert.deepEqual(view.basic.map((b) => b.core), ["身份", "核心特质", "当前能力", "核心动机", "弱点/缺陷"]);
  assert.match(view.basic[2].value, /天王级唱功[\s\S]*大师级导演能力/);
  assert.equal(view.table.header.join("|"), "章节|关键事件|状态变化");
  assert.equal(view.table.rows.length, 2);
  assert.deepEqual(view.aliases, ["江导（战友称）", "晨哥（战友称）"]);
  view.basic[0].value = "火箭军文工团宣传兵（晋升）";
  view.table.rows.push(["第 3 章", "新事件", "新变化"]);
  const out = serializeStructured(view);
  assert.match(out, /身份.*：火箭军文工团宣传兵（晋升）/);
  assert.match(out, /当前能力.*：/);
  assert.match(out, /天王级唱功[\s\S]*大师级导演能力/);
  assert.match(out, /\| 第 3 章 \| 新事件 \| 新变化 \|/);
  assert.match(out, /## 别名/);
  assert.equal((out.match(/^# /gm) || []).length, 1);
});

const ARC = [
  "# 角色线：江晨（主角·军宣创作者崛起）",
  "",
  "> 示例：只写计划；状态机推进到 追踪/角色线/江晨.md。",
  "",
  "## 弧线定义",
  "",
  "- 类型：正弧（自我价值确认）",
  "- Lie（起点信念）：作品只是数据",
  "- Truth（终点信念）：老兵敬意才是归宿",
  "- Want（表层所求）：完成系统任务",
  "- Need（深层所需）：让军人被看见",
  "- Ghost（创伤来源）：前世 MCN 倒闭",
  "",
  "## 阶段规划",
  "",
  "### 阶段 1：新人破圈（第一卷·第1-8章）",
  "",
  "- 阶段目标：从军宣透明人到全网爆款",
  "- 关键事件与场景：首秀、军迷圈沸腾",
  "- 变化信号：粉丝 0 → 15 万",
  "- 影响维度：外在（身份/名望）",
  "",
  "### 阶段 2：创作定调（第一卷·第9-14章）",
  "",
  "- 阶段目标：从刷数据转向真情感",
  "- 关键事件与场景：实弹训练看片",
  "- 变化信号：创作冲动被点燃",
  "- 影响维度：内在（创作信念）",
  "",
  "## 与其他线交织点",
  "",
  "- 钟嘉嘉感情线：第 12 章并轨",
  "",
  "## 进度指针",
  "",
  "→ 状态机推进",
  "",
].join("\n");

test("角色线：弧线定义 + 阶段规划 + 保真回写", () => {
  const view = parseStructured(ARC, "arc");
  assert.equal(view.title, "角色线：江晨（主角·军宣创作者崛起）");
  assert.equal(view.definition.length, 6);
  assert.deepEqual(view.definition.map((d) => d.core).slice(0, 2), ["类型", "Lie（起点信念）"]);
  assert.equal(view.stages.length, 2);
  assert.deepEqual(view.stages[0].items.map((i) => i.core), ["阶段目标", "关键事件与场景", "变化信号", "影响维度"]);
  view.stages[1].items.find((i) => i.core === "阶段目标").value = "【改】转向情感叙事";
  const out = serializeStructured(view);
  assert.equal((out.match(/^### 阶段 /gm) || []).length, 2);
  assert.equal((out.match(/^# /gm) || []).length, 1);
  assert.match(out, /- 阶段目标：【改】转向情感叙事/);
  assert.match(out, /## 与其他线交织点/);
  assert.match(out, /## 进度指针/);
});

const STATUS = [
  "# 江晨｜当前状态",
  "",
  "- 状态修订：0",
  "- 截至章节：第20章",
  "- 身份：火箭军文工团宣传兵",
  "- 位置：火箭军文工团",
  "- 当前目标：承接老兵故事",
  "- 身心状态：声望到达新高点",
  "",
  "## 能力与资源",
  "",
  "- 天王级唱功",
  "",
  "## 关键关系",
  "",
  "- 与钟嘉嘉暧昧升温",
  "",
].join("\n");

test("角色状态：头部字段 + 各节 + 保真回写", () => {
  const view = parseStructured(STATUS, "character-status");
  assert.equal(view.header.length, 6);
  view.header.find((h) => h.core === "当前目标").value = "【新】打造十年军宣系列";
  const out = serializeStructured(view);
  assert.equal((out.match(/^# /gm) || []).length, 1);
  assert.match(out, /- 当前目标：【新】打造十年军宣系列/);
  assert.match(out, /## 关键关系/);
});

const SETTINGS = [
  "# 力量体系",
  "",
  "> 说明：本设定只写权威版本。",
  "",
  "## 境界划分",
  "",
  "- 炼气",
  "- 筑基",
  "",
  "## 禁忌",
  "",
  "- 不得传授魔功",
  "",
  "## 写作约束",
  "",
  "- 金手指不上天",
  "",
].join("\n");

test("设定文档：通用大纲式结构化", () => {
  const view = parseStructured(SETTINGS, "settings-doc");
  assert.equal(view.sections.length, 3);
  assert.deepEqual(view.sections.map((s) => s.heading), ["境界划分", "禁忌", "写作约束"]);
  const out = serializeStructured(view);
  assert.match(out, /# 力量体系/);
  assert.match(out, /## 写作约束/);
  assert.match(out, /金手指不上天/);
});

test("未知类型返回 null，序列化空值返回空串", () => {
  assert.equal(parseStructured("# 随便", null), null);
  assert.equal(serializeStructured(null), "");
});

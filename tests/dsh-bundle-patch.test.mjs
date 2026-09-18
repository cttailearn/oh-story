import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const patch = readFileSync(resolve(root, "cordis.patch.yml"), "utf8");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

test("dsh bundle patch 以按 id 覆盖挂载（不得再引入重复 entry id）", () => {
  // v2.5.0 回归：包内 bundle 用 insert 注入 oh-story-skills，与旧版（v2.4.x 文档）手工
  // 追加到 ~/.dsh/cordis.patch.yml 的挂载行同名，dsh loader 报
  // “duplicate loader entry id: oh-story-skills” 导致整棵 web 树启动失败。
  assert.match(patch, /- id: skill-filesystem/, "必须按 id 覆盖 @deepseek-ai/dsh-base 的 skill-filesystem 条目");
  assert.ok(!/^\s*-\s+insert:/m.test(patch), "不得再用 insert 注入条目（insert 不与既有条目去重，旧挂载行残留即重复崩溃）");
  assert.ok(!/id\s*:\s*oh-story-skills\b/.test(patch), "不得再声明与旧版手工挂载行冲突的 entry id");
});

test("v2.5.2 回归：agent-preset 构建里必须重新启用 skill-filesystem 并只挂包内 skills", () => {
  // dsh-plugin-desktop 2.0.x（@deepseek-ai/* 0.1.x-rc）把 skill 发现移到 agent preset：
  // @deepseek-ai/dsh-web-app 把全局 skill-filesystem 行 disabled: true，preset 各自挂
  // 自己的副本。只 append customSkillDirs（v2.5.1）命中的是一行被禁用的条目，安装后
  // skills 完全不注册（“安装了但未生效”）。修复 = 同一行 disabled: false 重新启用 +
  // includeDefaultRoots: false 隔离到包内 skills（项目/用户根由 preset 自己的副本负责）。
  const systemIdx = patch.indexOf("- id: skill-filesystem");
  assert.ok(systemIdx >= 0, "找不到 skill-filesystem 覆盖条目");
  const block = patch.slice(systemIdx);
  assert.match(block, /disabled:\s*false/, "必须重新启用被 dsh-web-app 禁用的全局 skill-filesystem 行（否则 agent-preset 构建里 skills 不注册）");
  assert.match(block, /includeDefaultRoots:\s*false/, "全局提供方必须隔离到包内 skills（不得再扫项目/用户根，避免与 preset 副本重复发现）");
  assert.match(block, /customSkillDirs:/);
  assert.match(block, /node_modules\/oh-story\/skills/);
  assert.match(block, /fileURLToPath\(/, "customSkillDirs 必须用绝对路径表达式（baseUrl 锚定 profile 目录）");
});

test("package.json 声明 dsh.bundle 且发布文件包含 patch", () => {
  assert.equal(pkg.dsh?.bundle?.patch, "./cordis.patch.yml");
  assert.ok(Array.isArray(pkg.files) && pkg.files.includes("cordis.patch.yml"));
  assert.equal(pkg.version, "2.5.2");
});

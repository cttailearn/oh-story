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
  assert.match(patch, /customSkillDirs:/);
  assert.match(patch, /node_modules\/oh-story\/skills/);
  assert.match(patch, /fileURLToPath\(/, "customSkillDirs 必须用绝对路径表达式（baseUrl 锚定 profile 目录）");
});

test("package.json 声明 dsh.bundle 且发布文件包含 patch", () => {
  assert.equal(pkg.dsh?.bundle?.patch, "./cordis.patch.yml");
  assert.ok(Array.isArray(pkg.files) && pkg.files.includes("cordis.patch.yml"));
  assert.equal(pkg.version, "2.5.1");
});

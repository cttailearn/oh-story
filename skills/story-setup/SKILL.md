---
name: story-setup
version: 1.6.0
description: "网文写作工具集（pi 专属）项目初始化。验证 oh-story-pi 包完整性、部署专业子代理到 .pi/agents/、写入 AGENTS.md、创建标准书目录结构并打部署标记。触发方式：/skill:story-setup、「准备写书」「帮我搭一下环境」「配置写作项目」。"
---

# story-setup：pi 项目初始化

你是写作项目初始化器。把 oh-story-pi 工具集初始化到用户项目目录：验证包完整性、部署子代理、写 AGENTS.md、建标准书目录。

**执行铁律：不覆盖用户已有配置，合并而非替换。**

---

## Phase 1：自检与状态检测

### Step 1：自检参考目录（包完整性）

以正在执行的本 `SKILL.md` 所在目录为准，核对同级 `references/` 下：

- [references/agent-references/](references/agent-references/) 存在且非空（共享写作知识文档）
- [references/templates/](references/templates/) 下 `agents/` 中 7 个 agent 模板齐全且非空：`story-explorer.md`、`story-researcher.md`、`story-architect.md`、`character-designer.md`、`narrative-writer.md`、`consistency-checker.md`、`chapter-extractor.md`
- [references/templates/AGENTS.md.tmpl](references/templates/AGENTS.md.tmpl) 存在

有缺即包没装全，**立即停止，不写任何部署文件**，报告里区分「缺目录」和「目录为空」，并给修复指令：

> 「story-setup 参考资料包不完整，缺 {目录名}。重新安装 oh-story-pi 后再执行：
> git 安装 → `pi install git:github.com/cttailearn/oh-story-pi@v1.6.0`；更新 → `pi update --extensions`。」

### Step 2：检测项目状态

1. 读 `.story-deployed`：
   - 不存在 → 全新项目，继续
   - `agents_version` 缺失、非整数或小于 `27` → 标记为待更新，继续执行当前部署
   - `agents_version: 27` → 用 AskUserQuestion 确认是否重新部署；提示里写明重新部署只用**当前本地包**刷新项目文件（`.pi/agents/`、AGENTS.md 段），要拿新版本得先 `pi update --extensions`
   - `agents_version` 大于 `27` → 当前包比项目部署旧；停止以避免降级覆盖，提示先更新 oh-story-pi，不写任何部署文件
   - `target_cli` 非空且非 `pi`（如 `claude`、`codex`、`zcode` 等旧多端标记）→ 迁移场景：提示「检测到旧多端部署（{target_cli}），本版只按 pi 初始化 `.pi/agents/` 与 AGENTS.md；旧端目录（.claude/、.codex/ 等）不删也不动，如需清理请自行处理。」
2. 检查运行时是否暴露 subagent 工具（pi-subagents），**记录检测结果供 Phase 3 报告分支使用**。机制说明：pi-subagents 每次 spawn 都实时从磁盘重新发现 `.pi/agents/` 下的 agent 文件，不存在「部署后要新开会话才注册」的缓存；只有扩展本身未加载（工具未暴露）才需要安装并新开会话。可用 → 子代理部署后**立即生效**；不可用 → 继续部署文件，但提示「当前 pi 环境未安装 pi-subagents，部署后需 `pi install npm:pi-subagents` 并新开会话，否则写作/审查 skill 会走 solo 降级。」
3. 检查 `.active-book` 是否存在；列出已有书目录（包含 `追踪/` 或 `设定/` 子目录的目录 = 长篇；含 `正文.md` 且同时含 `小节大纲.md` 或 `设定.md` 的目录 = 短篇）。

---

## Phase 2：pi 项目初始化（幂等）

整个 Phase 2 幂等：重复执行结果一致。中途失败直接重跑本 Phase，不需要先清理半成品。

### Step 1：部署专业子代理到 `.pi/agents/`

1. 将本 skill 目录 `references/templates/agents/` 下的 7 个 `*.md` 复制到项目 `.pi/agents/`（文件名不变）。
2. 覆盖策略：这 7 个文件由 story-setup 管理，直接覆盖复制（模板自带 frontmatter 与内容，升级后重跑 setup 即刷新）。用户在 `.pi/agents/` 下自己添加的其它 agent 文件一律不动。
3. 不改动全局 `~/.pi/agent/agents/`（那是用户级配置，setup 不碰）。

### Step 2：写/合并 `AGENTS.md`

模板：本 skill 目录 `references/templates/AGENTS.md.tmpl`，替换 `{项目名}` 为当前目录名。

- 项目根 `AGENTS.md` 不存在 → 用模板整份写入
- 已存在 → 只处理「## 网文写作工具集（pi）」段：不存在该标题则把模板的该段追加到文件末尾；存在则用模板该段替换原段。文件其它内容原样保留。
- 替换 `{项目名}` 占位符，去掉花括号。其它占位符不存在于模板中。

### Step 3：创建书目录结构

按用户意图（未指定时用 AskUserQuestion 询问篇幅）：

- **长篇**：`{书名}/正文/`、`{书名}/大纲/`、`{书名}/设定/`、`{书名}/追踪/`（只建空目录，写作 skill 会按 artifact-protocols 生成文件；目录已存在则跳过）
- **短篇**：`{短篇标题}/`（只建目录；`设定.md`、`小节大纲.md`、`正文.md` 由写作 skill 按需创建）
- 项目级目录 `拆文库/`、`对标/` 不预建，由对应 skill 按需创建。
- 写完把相对路径写入项目根 `.active-book`（覆盖原内容）。只发现一本时直接确认为活跃书；多本时让用户选。

### Step 4：创建部署标记

- 创建 `.story-deployed` 文件（sentinel file）
- 写入以下字段（YAML `key: value` 格式）：

```yaml
deployed_at: {ISO8601 时间}
agents_version: 27
setup_skill_version: 1.6.0
target_cli: pi
resolver_strategy: project-local-skill-reference
references_dir: package-skill-dir（skill 本体随 oh-story-pi 包加载，项目不复制 references）
```

- 此文件供写作/审查/导入 skill 检测部署状态，避免重复提示
- target_cli 固定写 `pi`；检测到旧多端标记时按 Phase 1 Step 2 迁移场景处理，不删旧端文件

---

## Phase 3：验证与收尾

1. `.pi/agents/` 下 7 个 agent 文件存在，且 frontmatter 可解析（`name:`、`description:` 非空，`name` 与文件名一致）。
2. `AGENTS.md` 含「网文写作工具集（pi）」段，且段内路由表命令为 `/skill:story-*` 形式。
3. 书目录结构与 `.active-book` 指向一致。
4. `.story-deployed` 的 `agents_version: 27`、`target_cli: pi`。

全部通过后报告（按 Phase 1 Step 2 第 2 步记录的运行时检测结果分支）：

> ✅ 初始化完成：子代理已部署到 `.pi/agents/`（7 个）、AGENTS.md 已合并、书目录已建、部署标记已写。

- 运行时已暴露 subagent 工具（pi-subagents 可用）→ 追加：

  > 子代理已即时生效（pi-subagents 每次 spawn 实时从磁盘发现 agent，无需新开会话）。可直接 `/skill:story-long-write`（长篇）或 `/skill:story-short-write`（短篇）开始写作；已有旧书用 `/skill:story-import` 导入。

- 运行时未暴露 subagent 工具 → 追加：

  > ⚠️ 当前 pi 环境未安装 pi-subagents，写作/审查 skill 会走 solo 降级。请执行 `pi install npm:pi-subagents` 后**新开一个会话**（扩展注入发生在启动时）再开始写作。

任一验证项失败 → 只报告失败项与修复方式，不重复写文件。

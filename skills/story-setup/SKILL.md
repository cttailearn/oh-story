---
name: story-setup
version: 2.2.0
description: "网文写作工具集项目初始化（pi / dsh 双运行时自适应）。验证 oh-story 包完整性、按运行时部署专业子代理（pi → .pi/agents/，dsh → .dsh/story-agents/ prompt 模板）、写入 AGENTS.md、创建标准书目录结构并打部署标记。触发方式：/skill:story-setup、/story-setup、「准备写书」「帮我搭一下环境」「配置写作项目」。"
---

# story-setup：写作项目初始化（pi / dsh 自适应）

> **双运行时**：pi 触发 `/skill:story-setup`；dsh 触发 `/story-setup`；自然语言均可。两端流程指令通用。

你是写作项目初始化器。把 oh-story 工具集初始化到用户项目目录：检测运行时、验证包完整性、按运行时部署子代理、写 AGENTS.md、建标准书目录。

**执行铁律：不覆盖用户已有配置，合并而非替换。**

---

## Phase 0：运行时检测（pi / dsh）

先确定当前 agent 运行时，全程按此分支执行：

1. 查看本会话可用工具与运行环境：
   - 有 `pwsh` / `run_code` / `glob` / `grep` 工具（且无 `fffind`/`ffgrep`）→ **dsh**
   - 有 `fffind` / `ffgrep` 工具（pi 文件搜索工具）→ **pi**
   - 工具特征不明显时：读环境变量（`DSH_*` 前缀存在 → dsh）、`~/.dsh` 目录存在 → dsh；`~/.pi` 目录存在且无 `~/.dsh` → pi
2. 记录 `runtime: pi | dsh`，后续 Phase 2 / Phase 3 按此分支执行。
3. 顺带检测 subagent 能力（pi 需 pi-subagents；dsh 原生具备 `subagent` 工具），记录供 Phase 3 报告分支使用。

---

## Phase 1：自检与状态检测

### Step 1：自检参考目录（包完整性）

以正在执行的本 `SKILL.md` 所在目录为准，核对同级 `references/` 下：

- [references/agent-references/](references/agent-references/) 存在且非空（共享写作知识文档）
- [references/templates/](references/templates/) 下 `agents/` 中 7 个 agent 模板齐全且非空：`story-explorer.md`、`story-researcher.md`、`story-architect.md`、`character-designer.md`、`narrative-writer.md`、`consistency-checker.md`、`chapter-extractor.md`
- [references/templates/AGENTS.md.tmpl](references/templates/AGENTS.md.tmpl) 存在

有缺即包没装全，**立即停止，不写任何部署文件**，报告里区分「缺目录」和「目录为空」，并给修复指令：

> 「story-setup 参考资料包不完整，缺 {目录名}。重新安装 oh-story 后再执行：
> pi → `pi install git:github.com/cttailearn/oh-story@v2.0.0`（更新 → `pi update --extensions`）；
> dsh → 重新执行 oh-story 的 dsh 安装脚本（`scripts/install-dsh.ps1`）或按 README 检查 skills 根。」

### Step 2：检测项目状态

1. 读 `.story-deployed`：
   - 不存在 → 全新项目，继续
   - `agents_version` 缺失、非整数或小于 `30` → 标记为待更新，继续执行当前部署
   - `agents_version: 30` → 用 AskUserQuestion（dsh 下为 ask_user_question）确认是否重新部署；提示里写明重新部署只用**当前本地包**刷新项目文件（pi: `.pi/agents/`；dsh: `.dsh/story-agents/`；及 AGENTS.md 段），要拿新版本得先更新 oh-story 包
   - `agents_version` 大于 `30` → 当前包比项目部署旧；停止以避免降级覆盖，提示先更新 oh-story，不写任何部署文件
   - `target_cli` 非空且非 `pi`/`dsh`（如 `claude`、`codex`、`zcode` 等旧多端标记）→ 迁移场景：提示「检测到旧多端部署（{target_cli}），本版只按当前运行时初始化；旧端目录（.claude/、.codex/ 等）不删也不动，如需清理请自行处理。」
   - `target_cli` 为另一运行时（如 pi 项目在 dsh 下运行 setup，或反之）→ **跨环境切换**：提示「项目原按 {target_cli} 部署。本次按当前运行时（{Phase 0 检测结果}）补充部署（pi → `.pi/agents/`；dsh → `.dsh/story-agents/`），原部署目录保留不动——两个运行时可共存，sentinel 的 target_cli 更新为当前运行时。」
2. 检查 `.active-book` 是否存在；列出已有书目录（包含 `追踪/` 或 `设定/` 子目录的目录 = 长篇；含 `正文.md` 且同时含 `小节大纲.md` 或 `设定.md` 的目录 = 短篇）。

---

## Phase 2：项目初始化（幂等，按运行时分支）

整个 Phase 2 幂等：重复执行结果一致。中途失败直接重跑本 Phase，不需要先清理半成品。

### Step 1：部署专业子代理（按运行时分支）

**pi 分支** → 部署到 `.pi/agents/`：

1. 将本 skill 目录 `references/templates/agents/` 下的 7 个 `*.md` 复制到项目 `.pi/agents/`（文件名不变）。
2. 覆盖策略：这 7 个文件由 story-setup 管理，直接覆盖复制（模板自带 frontmatter 与内容，升级后重跑 setup 即刷新）。用户在 `.pi/agents/` 下自己添加的其它 agent 文件一律不动。
3. 不改动全局 `~/.pi/agent/agents/`（那是用户级配置，setup 不碰）。
4. pi-subagents 每次 spawn 实时从磁盘发现 agent 文件，部署后**立即生效**；若运行时未暴露 subagent 工具（未装 pi-subagents），部署文件后提示「当前 pi 环境未安装 pi-subagents，部署后需 `pi install npm:pi-subagents` 并新开会话，否则写作/审查 skill 会走 solo 降级。」

**dsh 分支** → 部署 prompt 模板到 `.dsh/story-agents/`：

1. 将本 skill 目录 `references/templates/agents/` 下的 7 个 `*.md` 复制到项目 `.dsh/story-agents/`（文件名不变，frontmatter 保留；dsh 无文件式 agent 注册，这些文件作为 **subagent spawn 的 prompt 模板**，文件末尾的「DSH 运行时使用说明」段落即用法）。
2. 覆盖策略同 pi 分支：7 个文件直接覆盖复制，用户自建文件不动。
3. 写一个索引文件 `.dsh/story-agents/README.md`，内容：

   > 本目录是 oh-story 专业子代理的 prompt 模板（dsh 运行时）。
   > spawn 用法：用 `subagent` 工具（默认后台），prompt = 对应模板 frontmatter 之后的正文（完整自包含：项目路径、任务类型、查询参数/范围）；工具名映射：`fffind`→`glob`、`ffgrep`→`grep`、`read/write/edit` 同名；模型默认继承当前会话模型（如需钉模型在 subagent/workflow 请求中指定）。
   > 写作/审查 skill 会在 spawn 前检查本目录与 `.story-deployed`。

4. 提示用户：dsh 下子代理**立即可用**（`subagent` 工具原生存在，无需安装扩展或新开会话）。
5. **部署追踪工具**：把本 skill 的 `scripts/tracking_commit.py` 复制到项目 `.dsh/tools/tracking_commit.py`（说明文件一并复制：`references/tracking-transaction.md`），并在 `AGENTS.md` 写入「追踪工具」节（见 Step 2 模板）——追踪状态的**唯一写入口**是该项目内工具：`python .dsh/tools/tracking_commit.py check|commit --project {项目根}`，禁止手改 `追踪/` 下任何文件（追踪一致性由 `check-project-consistency.js` 与写作 Gate 机械校验）。

### Step 2：写/合并 `AGENTS.md`（双运行时模板）

模板：本 skill 目录 `references/templates/AGENTS.md.tmpl`（路由表已双运行时化），替换 `{项目名}` 为当前目录名。

- 项目根 `AGENTS.md` 不存在 → 用模板整份写入。
- 已存在 → 只处理「网文写作工具集」段，**子节白名单替换**（只替换模板管理的子节，其余内容一律保留——用户自定义段无论位于段内何处都不得吞并）：
  - 段起点：标题文本匹配 `#{1,2} .*网文写作工具集(（pi）)?`（兼容新旧写法）。
  - 段内逐项处理：
    1. 段标题行 → 替换为模板段标题（`# {项目名} — 网文写作工具集`）；
    2. 段标题后到第一个 `## ` 子节之间的引言 → 替换为模板引言；
    3. **白名单子节**（「Skill 路由表」「文件结构」「协作规则」「Compact 后恢复上下文」四个 `## ` 标题）：
       段内存在 → 用模板对应子节**整体替换**（子节标题+内容，内容到下一个 `## ` 子节标题或段结束）；
       段内缺失 → 按模板顺序**追加到段尾**；
    4. **段内其他子节（用户自定义，如「项目边界」）一律原样保留**，位置与内容都不动；
  - 段结束 = 下一个与段标题同级（或更高级）的标题或文末；段之外内容一律保留。
  - 未找到工具集段 → 模板（替换 {项目名} 后）整份追加到文件末尾。
- 替换 `{项目名}` 占位符，去掉花括号。其它占位符不存在于模板中。
- 说明：pi 不自动读 AGENTS.md（仅作约定文档）；dsh 的 agent-instructions 会自动加载项目根 `AGENTS.md` 作为会话指令，路由表对 dsh 模型直接生效。

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
agents_version: 30
setup_skill_version: 2.2.0
target_cli: {Phase 0 检测到的 runtime: pi | dsh}
resolver_strategy: project-local-skill-reference
references_dir: package-skill-dir（skill 本体随 oh-story 包加载，项目不复制 references）
```

- 此文件供写作/审查/导入 skill 检测部署状态，避免重复提示
- `target_cli` 按运行时写 `pi` 或 `dsh`；检测到旧多端标记时按 Phase 1 Step 2 迁移场景处理，不删旧端文件

---

## Phase 3：验证与收尾（按运行时分支）

**pi 分支验证**：

1. `.pi/agents/` 下 7 个 agent 文件存在，且 frontmatter 可解析（`name:`、`description:` 非空，`name` 与文件名一致）。
2. `AGENTS.md` 含「网文写作工具集」段。
3. 书目录结构与 `.active-book` 指向一致。
4. `.story-deployed` 的 `agents_version: 30`、`target_cli: pi`。

**dsh 分支验证**：

1. `.dsh/story-agents/` 下 7 个模板文件 + README.md 存在。
2. `AGENTS.md` 含「网文写作工具集」段（dsh 会自动加载）。
3. 书目录结构与 `.active-book` 指向一致。
4. `.story-deployed` 的 `agents_version: 30`、`target_cli: dsh`。

全部通过后报告（按 Phase 0 运行时与 subagent 能力分支）：

> ✅ 初始化完成（运行时：{pi|dsh}）：子代理已部署（pi → `.pi/agents/` / dsh → `.dsh/story-agents/`，7 个）、AGENTS.md 已合并、书目录已建、部署标记已写。

- subagent 能力可用 → 追加：

  > 子代理已即时生效。可直接 `/story-long-write`（dsh）/ `/skill:story-long-write`（pi）开始写作（或自然语言「写长篇」）；已有旧书用 `/story-import` / `/skill:story-import` 导入。

- subagent 能力不可用（仅 pi 未装 pi-subagents 时）→ 追加：

  > ⚠️ 当前 pi 环境未安装 pi-subagents，写作/审查 skill 会走 solo 降级。请执行 `pi install npm:pi-subagents` 后**新开一个会话**（扩展注入发生在启动时）再开始写作。

任一验证项失败 → 只报告失败项与修复方式，不重复写文件。

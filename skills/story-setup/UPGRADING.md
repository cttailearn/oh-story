# 升级指南

## 当前版本

- `setup_skill_version: 2.0.0`
- `agents_version: 27`

`.story-deployed` 缺失任一字段，或 `agents_version` 缺失 / 非整数 / 小于 `27`，都视为待更新部署。直接重新运行 `/skill:story-setup`；不在运行时逐级兼容历史模板。如项目 `agents_version` 大于 `27`，说明本地 story-setup 比项目旧：先更新 oh-story，不得用旧版降级覆盖。历史版本改动见仓库根目录 `CHANGELOG.md`。

## 多端版 → pi 版迁移（v1.3.0–v1.x 历史）

v1.3.0 起 oh-story 为 pi 专属包。旧多端部署项目（`.story-deployed` 的 `target_cli` 为
`claude-code` / `codex` / `opencode` / `zcode` / `openclaw` / `reasonix` 或组合）迁移要点：

1. 旧端目录（`.claude/`、`.codex/`、`.opencode/`、`.zcode/` 等）**不再由 story-setup 管理**，
   本版不删除也不更新它们；确认不再使用对应 CLI 后可自行清理。
2. 重新运行 `/skill:story-setup`：按 pi 初始化部署 `.pi/agents/`、合并 AGENTS.md、
   把 sentinel 改写为 `target_cli: pi`。
3. 旧端 hooks 守卫（写前校验、提交验证）在 pi 中无对应物：pi 版由写作 skill 的
   workflow 指令 + `tracking_commit.py` / 检查脚本承担等价检查点，不再有运行时硬拦截。
4. 项目数据（书目录、`追踪/`、`拆文库/`、`对标/`）与平台无关，直接沿用。

## pi 版 → 双运行时版迁移（v2.0.0）

v2.0.0 起 oh-story 为 pi / dsh 双运行时包。pi 部署项目迁移：

1. 更新包（见「升级步骤」第 1 条）。
2. 重跑 `/skill:story-setup`（dsh 下 `/story-setup`）：按检测到的运行时部署（pi → `.pi/agents/`；dsh → `.dsh/story-agents/`），
   sentinel 改写为 `target_cli: pi` 或 `target_cli: dsh`。
3. dsh 用户在项目根刷新/新开会话后，写作/审查 skill 的 agent spawn 自动走 `.dsh/story-agents/` 模板。

## 升级策略

| 策略 | 适用场景 | 行为 |
| ------ | ---------- | ------ |
| 覆盖部署 | 全新项目 | 写入当前 agents 模板与 AGENTS.md |
| 合并部署 | 已有项目 | 替换 story-setup 管理文件（`.pi/agents/` 7 个模板），合并 AGENTS.md 段 |
| 手动更新 | 只更新特定文件 | 仅建议熟悉部署契约的维护者使用 |

推荐始终重新运行 story-setup，让部署器按文件所有权处理。

## 文件所有权

### story-setup 管理，可替换

这些文件由 story-setup 管理，不含用户自定义内容：

- `.pi/agents/`（pi 运行时）— 7 个 story agent 定义（story-explorer、story-researcher、story-architect、
  character-designer、narrative-writer、consistency-checker、chapter-extractor），升级后重跑 setup 即刷新
- `.dsh/story-agents/`（dsh 运行时）— 同上 7 个模板 + README.md 索引（subagent prompt 模板）
- `AGENTS.md` 的「## 网文写作工具集」段

### 用户维护，story-setup 不覆盖

- `.pi/settings.json`（story-setup 不写此文件；项目级包安装用 `pi install -l` 自行管理）
- `.pi/agents/` 下用户自己添加的其它 agent 文件
- `AGENTS.md` 的其它内容段
- `.active-book`、书目录、`拆文库/`、`对标/` 等写作数据

### 包级管理

- 13 个 skill 本体由 pi 包管理（`pi update --extensions`），story-setup 不复制 skill 到项目
- 写作参考文档随 skill 加载（`references/` 与包同版本），项目无需本地副本

## 升级步骤

1. 更新包：pi → `pi update --extensions` 或 `pi install git:github.com/cttailearn/oh-story@<新 ref>`；
   dsh → 重新执行 `scripts/install-dsh.ps1`（或 git pull 后刷新会话）。
2. 在项目根重跑 `/skill:story-setup`（dsh 下 `/story-setup`），确认 `.story-deployed` 写入
   `agents_version: 27` 与 `setup_skill_version: 2.0.0`（`target_cli` 为 pi 或 dsh）。
3. 已有拆文工程核对 `_progress.md` 的 `schema_version: 2`（当前拆文契约；不符则按
   story-import 的修复流程重建）。
4. 无需新开会话：pi-subagents 每次 spawn 实时从磁盘发现 `.pi/agents/` 下的 agent，重跑 setup 后下一次 spawn 即用新版。仅当运行时不暴露 subagent 工具（未安装 pi-subagents）时，才需 `pi install npm:pi-subagents` 并新开会话。

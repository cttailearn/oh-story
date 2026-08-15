# 贡献指南

感谢你对网文写作工具箱（oh-story）的关注，欢迎贡献。

## 仓库结构

```text
skills/
├── story/                   # 工具箱路由
├── story-setup/             # pi 项目初始化（子代理部署/AGENTS.md/书目录）
├── story-import/            # 逆向导入
├── story-long-write/        # 长篇写作
├── story-long-analyze/      # 长篇拆文
├── story-long-scan/         # 长篇扫榜
├── story-short-write/       # 短篇写作
├── story-short-analyze/     # 短篇拆文
├── story-short-scan/        # 短篇扫榜
├── story-deslop/            # 去AI味
├── story-review/            # 多视角审查
├── story-image/             # 图像生成（封面/人设/三视图/场景）
└── browser-cdp/             # 浏览器操控
extensions/                   # pi 扩展（/story 命令别名）
scripts/                      # 开发守卫 / 测试 / 同步（完整索引见 scripts/README.md）
tests/                        # dashboard 测试
```

每个 skill 由一个 `SKILL.md`（入口）和 `references/` 目录（知识库）组成。
`story-setup/references/templates/agents/` 是 7 个 pi-subagents 子代理模板（部署源）。

## Skill 格式

`SKILL.md` 开头必须有 frontmatter：

```yaml
---
name: skill-name
description: "一句话描述。触发方式：/skill:skill-name、触发词1、触发词2"
---
```

- pi 实现 Agent Skills 标准：`name` 必须小写 a-z/0-9/连字符，`description` ≤ 1024 字。
- 触发方式统一写 pi 命令 `/skill:name` 或自然语言触发词；不要引入其它 CLI 的约定。
- `references/` 中的文件由 skill 按需加载，不会全部塞进上下文。

## 如何贡献

### 改进现有 skill

1. Fork 仓库
2. 从 `main` 创建分支：`git checkout -b feat/your-feature main`
3. 修改对应的 `SKILL.md` 或 `references/` 文件
4. 提交 PR，说明改了什么、为什么改

### 新增 / 修改子代理

1. 只改 `skills/story-setup/references/templates/agents/*.md`（唯一部署源）
2. frontmatter 保持 pi-subagents 格式（`tools` 白名单、`systemPromptMode: replace`、
   `turnBudget`；`model` 不写死）
3. 涉及新增 agent 时同步更新 story-setup `SKILL.md` 的自检清单与部署列表

## CI 检查

PR 与 main push 自动运行两套流水线：

- `.github/workflows/guards.yml`：全部静态守卫 + 回归测试（static-check / skill-numbering /
  current-contract / doc-budget / shared-assets / python-invocation / AI 味基准 / 追踪事务 /
  dashboard API 等 19 个 step），无路径过滤，任何改动都会触发。
- `.github/workflows/dashboard.yml`：dashboard e2e（playwright，仅 dashboard 相关路径）。

提交前也可本地跑完整守卫清单：

```bash
bash scripts/static-check.sh
python3 scripts/test-static-check.py
python3 scripts/skill-numbering.py check
bash scripts/test-skill-numbering.sh
bash scripts/check-current-skill-contracts.sh
python3 scripts/test-current-skill-contracts.py
bash scripts/check-doc-budget.sh
python3 scripts/test-shared-assets.py
node scripts/test-normalize-punctuation.js
node scripts/test-scan-runtime.js
node scripts/test-imagegen-custom.js
node scripts/test-project-consistency.js
node scripts/test-chapter-consistency.js
node scripts/test-imagegen-env.js
bash scripts/test-outline-detail.sh
bash scripts/test-ai-patterns.sh
bash scripts/test-outline-copy.sh
bash scripts/test-degeneration.sh
bash scripts/check-python-invocation.sh
bash scripts/test-charcount-portable.sh
python3 scripts/test-tracking-commit.py
python3 scripts/test-tracking-workflow-contracts.py
npm test
```

每个脚本的用途与触发时机见 [scripts/README.md](scripts/README.md)。

## 工作流编号规范

新增或调整流程步骤时，显式标题使用 `Step 1`、`Step 2` 这类连续整数；不要为了插入步骤创建 `Step 1.5` / `Phase 2.1` / `Stage 0.5`，也不要在 `SKILL.md` 用 `### 2.1` 或 `- 2.1` 代替明确的工作流标题。`references/` 手册自身的 `3.1` 章节/列表号不受此规则影响。

修改编号前先预览，再写入并复查：

```bash
python3 scripts/skill-numbering.py audit
python3 scripts/skill-numbering.py fix --dry-run
python3 scripts/skill-numbering.py fix --write
python3 scripts/skill-numbering.py check
```

自动修复只重排显式 Step 标题及可无歧义绑定的引用。无法绑定的 fractional Step 引用或一对多映射会让整个写入在落盘前失败；Phase、裸编号标题和 bullet 子步骤需要按语义手工命名。完整算法与局部路径用法见 [scripts/README.md](scripts/README.md#工作流编号维护)。

## 共享文件规范

部分文件跨 skill 共享（如 banned-words.md、anti-ai-writing.md），修改时必须同步所有副本。

- runtime 脚本与 reference 文档的唯一源/目标都定义在 `scripts/shared-assets.json`（v1.2.2 起 69 组覆盖 97 份副本）；先改 `source`，再运行 `python3 scripts/sync-shared-assets.py sync`。
- 同名文件只能属于一个 canonical group，且每个 target 必须保留 source basename；禁止用改名 target 绕过单一 owner。
- reference 文档的同步提示写在各副本首行注释（`sync-shared-assets.py`）；提交前统一运行 `python3 scripts/test-shared-assets.py`；未在 manifest 登记的重名副本会直接失败。
- **有意分化的同名文件**（如 quality-checklist.md 各 skill 定制版）不登记入 manifest；分化前先确认不是漏同步。

### 知识库贡献

最有价值的贡献类型：

- **实战数据**：各平台最新榜单分析、题材趋势变化
- **新题材框架**：新的题材写作公式、结构模板
- **去AI味规则**：新的 AI 痕迹模式、改写范例
- **平台规则更新**：投稿要求、推荐机制的变化

## 质量要求

- **操作性**：内容必须能让 AI agent 直接执行，不要写教程
- **简洁**：用表格和模板，不要长篇叙述
- **无冗余**：不同 skill 的 `references/` 之间可以共享文件（通过路径引用），但同一 skill 内不要重复
- **中文**：所有内容用中文

## 提交流程

```text
fork → branch → commit → PR → review → merge
```

- 一个 PR 聚焦一个改动
- commit message 用中文，格式：`类型: 简短描述`
- 类型：`feat`（新增）/ `fix`（修复）/ `docs`（文档）/ `refactor`（重构）

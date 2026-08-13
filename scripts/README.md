# scripts/ —— 仓库开发脚本索引

这些是开发本仓库（skill 套件本体）用的**守卫 / 测试 / 同步**脚本，**不是** skill 运行时脚本（运行时脚本在各 skill 自己的 `scripts/` 下，如 `story-deslop/scripts/check-ai-patterns.js`，跨 skill 字节同步由 `shared-assets.json` 管理）。

- CI 由 `.github/workflows/dashboard.yml` 覆盖 dashboard 测试；其余守卫本地跑。提交前本地一把梭的完整命令见 [CONTRIBUTING.md](../CONTRIBUTING.md)「CI 检查」。
- **改名 / 移动任一脚本**，要同步改 `CONTRIBUTING.md`、本文件，以及调用它的兄弟脚本（见下方「何时跑」里的调用关系）。

## 静态守卫（check-*）

| 脚本 | 检查什么 | 何时跑 |
| --- | --- | --- |
| `static-check.sh` + `static-check.py` | 结构化验证 frontmatter、Markdown 路径/锚点、Agent 引用、references 可达性；除基础组件 `browser-cdp` 外禁止跨 Skill 文件引用 | 提交前 |
| `skill-numbering.py check` | 工作流 Step/Phase/Stage 编号策略、引用绑定、SKILL.md 裸编号/子步骤小数守卫 | 改工作流结构后 |
| `check-current-skill-contracts.sh` + `.py` + `current-contract.json` | 从结构化 manifest 校验当前版本、Phase、schema、主产物与细纲契约；保留 legacy/path 守卫并拦截缺主产物后的静默替代 | 提交前 |
| `check-doc-budget.sh` + `doc-budget.json` | 热路径 SKILL/references/agent 模板的去空白字数预算与路径合计上限；超了要么删等量旧文本，要么显式调高 budget | 增删热路径正文后 |
| `check-python-invocation.sh` | 技能文档禁止裸调 `python3`（须 python3→python→py 探测） | 提交前 |

## 测试回归（test-*）

| 脚本 | 测什么 | 何时跑 |
| --- | --- | --- |
| `test-ai-patterns.sh` | 确定性 AI 句式检测器 `check-ai-patterns.js` 回归 | 提交前 |
| `test-degeneration.sh` | 模型退化检测器 `check-degeneration.js` 回归 | 提交前 |
| `test-tracking-workflow-contracts.py` | 文件优先追踪契约：唯一事务写入口、续写状态卡（固定 7 栏）、导入基线、作者/读者时间线隔离、旧结构清零 | 提交前 |
| `test-tracking-commit.py` | 单权威追踪行为：state 最后提交、失败同事务重跑、派生一致性、修订语义、导入截止章 | 提交前 |
| `test-static-check.py` | 真 frontmatter block、精确路径/锚点、跨 Skill 引用、fence、死 reference、Agent 与章节链接 fixture | 提交前 |
| `test-current-skill-contracts.py` | current-contract manifest 类型/固定值与主产物 fail-fast 语义 fixture | 提交前 |
| `test-shared-assets.py` | 共享资产 manifest 的 drift、sync、路径越界、basename 单一 owner 与未登记重复检测 | 提交前 |
| `test-normalize-punctuation.js` | 标点归一化的只读检查、frontmatter/fence、CRLF、引号模式与幂等性 | 提交前 |
| `test-scan-runtime.js` | CDP argv 边界/报错/JSON 契约与 scraper 无副作用 import | 提交前 |
| `test-charcount-portable.sh` | 跨平台字符统计命令在三平台 + Windows 的正确性 | 提交前 |
| `test-skill-numbering.sh` | Step 重排级联安全、锚点 fail-closed、代码块引用、验证零写入/提交回滚、dry-run/write/幂等性 | 提交前 |

## 共享资产同步

| 脚本 | 干什么 | 何时跑 |
|---|---|---|
| `shared-assets.json` + `sync-shared-assets.py` | 为必须随 skill 独立部署的重复 runtime 脚本指定唯一源和目标（AI 句式检测器、退化检测器、标点归一化、追踪事务、CDP 工具） | 改共享 runtime 后跑 `sync`；提交前跑 `check` |

## 工作流编号维护

`skill-numbering.py` 默认扫描 canonical `skills/**/*.md`，用于阻止迭代插入把工作流编号累积成 `Step 1.3`、`Phase 2.5` 一类小数标签。

```bash
python3 scripts/skill-numbering.py audit          # 只读盘点；发现问题仍退出 0
python3 scripts/skill-numbering.py check          # CI 守卫；发现问题退出非 0
python3 scripts/skill-numbering.py fix --dry-run  # 先看完整 diff，不落盘
python3 scripts/skill-numbering.py fix --write    # 校验通过后一次性落盘
bash scripts/test-skill-numbering.sh              # 隔离 fixture 回归
```

维护策略：

- 只有形如 `### Step N` 的**显式 Step 标题**会自动重排；分组键是「文件 + 标题层级 + 最近父标题」，每组从 1 连续编号。
- 标题与可唯一绑定的 `Step N` 引用基于旧文本同时换号，包含 fenced code block 内的命令/示例引用，避免 `1.5 → 2` 后又被 `2 → 3` 二次级联。
- fractional Step 引用找不到本文件标题，或一个旧标签可能映射到多个新标签时，`fix` 会在任何写入前失败。多文件写入先全量校验/暂存并带回滚，不接受半套结果。
- 标题改号会改变 GitHub Markdown anchor；只要仓库内存在指向旧 anchor 的同文件或跨文件链接，`fix` 就在写入前 fail-closed，并报告每个 fragment，要求先显式更新链接后再重试。局部路径模式同样扫描仓库内入站链接。
- `Step N.M` / `Phase N.M` / `Stage N.M`、直接 `skills/*/SKILL.md` 中的裸小数标题及 bullet 小数子步骤由 `check` 报错，但不做猜测式自动修改。
- `references/` 手册本身的 `3.1` 章节/列表编号不属于工作流标签，不检查、不改写。如果管道 ID 需要插入中间阶段，使用语义名称或 `Stage 2A`，不用小数。
- 可在命令末尾传文件或目录做局部审计，例如 `... audit skills/story-cover/SKILL.md`；合入前仍须跑默认全量 `check`。

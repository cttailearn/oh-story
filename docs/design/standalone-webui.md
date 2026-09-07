# oh-story 独立 WebUI 网文写作工具 —— 详细设计方案

> 状态：**设计方案（v0.5，待评审）**
> 决策基线：**① 完全独立 Web 应用（前后端分离，不依赖 pi/dsh 运行时）② 个人单机（仅 127.0.0.1）③ 每步人工确认（human-in-the-loop at every stage）④ 从「聊天驱动」转为「用户需求 + 智能体自动调用 + 流程门禁」⑤ 技术栈 TypeScript + React；模型配置用 `@earendil-works/pi-ai`，智能体核心用 `@earendil-works/pi-agent-core`**
> 目标读者：后续 P0–P4 的实现者。
>
> 变更记录：
> - **v0.5** — 深化与补缺口第二批：智能体运行时（[agents-runtime.md](agents-runtime.md)，代码级装配/Context/内循环）、拆文+剧情模块库（[teardown-module.md](teardown-module.md)）、已有小说导入（[importing-existing.md](importing-existing.md)）、门禁执行器与报告契约（[gates-runner.md](gates-runner.md)）、实施计划（[implementation-plan.md](implementation-plan.md)）；同期收纳外部并稿「角色线管理方案」（[character-line-management.md](character-line-management.md)）。
> - **v0.4** — 补全实现级规格文档包：流程定义规范（[process-definition.md](process-definition.md)）、API 契约（[api-contract.md](api-contract.md)）、数据模型（[data-model.md](data-model.md)）；本文档增设「设计文档地图」。
> - **v0.3** — 确定层策略调整：Python/bash 脚本**移植为 Node/TS 同栈**（首选），`tracking_commit` / `author_memory_commit` / `check-imagegen-env` / 图像 prompt 组装列为必须移植项；WebUI 运行时目标为**零 Python/bash 依赖**。脚本保留 CLI 契约（`--project/--out`）与产物 schema，保证与现有 skill 互操作，回归用同一份 fixture 对齐。
> - **v0.2** — 接入真实包 API 固化技术栈（pi-ai / pi-agent-core 0.85.1 的 `.d.ts` 为准）：渠道=createProvider、Agent=有状态循环 + StreamFn 接缝、成本/预算直接复用 pi-ai Usage、图片走 images 注册机制。Node 引擎要求升至 ≥22.19。

## 设计文档地图（docs/design/）

| 文档 | 内容 | 何时用 |
|---|---|---|
| **[standalone-webui.md](standalone-webui.md)** | 总览：架构/模块/里程碑/风险/决策（本文） | 评审与总体把握 |
| [**process-definition.md**](process-definition.md) | 流程定义类型 + long/short 完整 JSON + 状态机 + Context 组装示例 | M1 流程引擎 |
| [**agents-runtime.md**](agents-runtime.md) | 智能体运行时：pi-ai/pi-agent-core 装配、StreamFn 桥、Role 库、Context 组装器、内循环、ai-edit、成本安全 | M1 智能体层 |
| [**gates-runner.md**](gates-runner.md) | 门禁执行器 + 每个 gate 报告契约 + Python→Node 对拍 harness | M0/M1 确定层 |
| [**api-contract.md**](api-contract.md) | 全端点 + JSON 示例 + SSE 事件 + 错误码 | M1 起前后端对拍 |
| [**data-model.md**](data-model.md) | SQLite DDL + 文件系统约束 + webui-config + 备份迁移 | M0 建库与数据层 |
| [**teardown-module.md**](teardown-module.md) | 拆文工作台建模 + 剧情模块库「拆→重组→新书」闭环 | M2 拆文 |
| [**importing-existing.md**](importing-existing.md) | 已有小说导入：分章/追踪生成(置信度)/校对页/幂等 | M4 导入 |
| [**webui-frontend.md**](webui-frontend.md) | 前端信息架构/线框/交互/组件/设计系统「书稿编辑部」 | M0-M2 前端 |
| [**implementation-plan.md**](implementation-plan.md) | M0/M1 WBS、逐任务验收、测试策略、风险门与 DoD | 开工指引 |
| [**character-line-management.md**](character-line-management.md) | 角色线（人物变化）管理与规划：三层结构、现状基线、4 套方案（A 弧线文件/D 审计闸门推荐）、规划模板 | 角色弧线深化（并稿·外部引入） |

> 阅读顺序：本文 1-3 章 → agent/process/api/data-model（核心）→ frontend → teardown/import → implementation-plan 开工。

---

## 1. 背景与目标

### 1.1 现状
oh-story 目前是「**对话驱动**」的 skill 包：用户在 pi/dsh 的聊天框里说话，LLM 现场读取 SKILL.md 指令即兴编排流程（workflow-chapter / workflow-daily / workflow-revision 等），产物落盘到标准书目录结构（`正文/ 大纲/ 设定/ 追踪/`）。

### 1.2 目标形态
建成一款**独立 WebUI 网文写作工具**：

```
用户录入需求(表单) → 系统读取流程定义 → 自动调用智能体(按角色分工)
→ 每阶段产物落盘 → 确定性门禁校验 → WebUI 呈现
→ 用户逐阶段确认(通过/修改重跑/驳回) → 进入下一阶段 → 交付导出
```

用户不通过 AI 聊天交互完成创作；聊天式的自由发挥退化为「辅助小工具」（如灵感问答、一致性查询），不再承载流程控制。

### 1.3 核心设计转变
| 维度 | 现状（chat 驱动） | 目标（流程驱动） |
|---|---|---|
| 控制流 | LLM 现场即兴编排 | **显式流程定义（Process as Data）**，引擎编排 |
| 上下文 | 长对话历史 | **任务即上下文**：从磁盘状态重建 |
| 质量 | skill 内检查点（部分靠 LLM） | **确定性门禁**由引擎执行，LLM 不负责 |
| 交互 | 文本框聊天 | 阶段看板 + 产物编辑器 + 确认按钮 |
| 状态 | `追踪/_tracking-state.json` + 会话 | `_tracking-state.json` + SQLite（任务/审计/成本） |

---

## 2. 总体架构

```
┌─────────────────────────────────────────────────────┐
│  WebUI（浏览器，仅访问 http://127.0.0.1:<port>）        │
│  项目列表 │ 阶段看板 │ 产物编辑器(CodeMirror) │ 门禁报告 │
│  任务队列 │ 配置页(渠道/模型/风格/预算) │ 导出页          │
└──────────────────────┬──────────────────────────────┘
                       │ REST + SSE（进度推送）
┌──────────────────────▼──────────────────────────────┐
│  后端服务（Node ≥20，Fastify，单进程单机）                │
│  ┌────────────────────────────────────────────────┐  │
│  │ 编排层 Engine                                    │  │
│  │  流程定义解释器 · 状态机 · 每步确认交互模型            │  │
│  │  门禁调度 · 任务队列(DB-backed) · 重跑/回滚/续跑      │  │
│  └───────────────┬────────────────────────────────┘  │
│  ┌───────────────▼────────────────────────────────┐  │
│  │ 智能体层 Agent                                  │  │
│  │  角色模板(移植现有 agent .md) · 上下文组装(Context) │  │
│  │  知识检索(References RAG) · 模型路由(渠道+角色)     │  │
│  │  图片后端(OpenAI 兼容 /images/generations·edits)   │  │
│  └───────────────┬────────────────────────────────┘  │
│  ┌───────────────▼────────────────────────────────┐  │
│  │ 确定层 Gates（Node/TS 同栈移植，引擎内联调用）        │  │
│  │  check-ai-patterns / degeneration / outline-detail │ │
│  │  revision-duplicate / delivery-contract          │  │
│  │  tracking-commit / author-memory-commit (Node 版) │  │
│  └───────────────┬────────────────────────────────┘  │
│  ┌───────────────▼────────────────────────────────┐  │
│  │ 存储层                                           │  │
│  │  书内容→文件系统(复用 {书}/正文·大纲·设定·追踪)       │  │
│  │  元数据/任务/审计/成本→SQLite(webui.db)            │  │
│  └────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### 2.1 进程与部署
- **单进程**：Fastify HTTP 服务 + 内存任务执行器。个人单机场景不需要分布式/消息队列。
- **运行时要求**：**Node ≥ 22.19**（`@earendil-works/pi-ai` 的 engine 硬要求；本机 node 24 满足）。ESM 工程（pi-ai/pi-agent-core 均为 ESM + TS 类型）。
- **任务队列**：SQLite 表作为持久队列；执行器串行/受控并行（默认同时 1~2 个写任务，防模型限流与成本失控）。
- **启动**：`npm run web` → `node webui/dist/server.mjs --port 3081 --root <workspace>`；默认仅绑定 `127.0.0.1`。
- **可执行文件（可选）**：后期用 pkg / Node SEA 打包单文件，双击即用。

---

## 3. 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 前端 | React 18 + TypeScript + Vite | 生态成熟，看板型 UI 组件多 |
| 前端 UI | Ant Design 5 + Tailwind | 表格/表单/步骤条/上传开箱即用 |
| 富文本编辑 | CodeMirror 6（markdown 语法高亮 + 大文件性能好） | 单机海量章节文本 |
| 后端 | Node ≥22.19 + Fastify（TS/ESM） | pi-ai 引擎要求；与现有 skill 的 `.js` 检查脚本同语义 |
| 数据库 | better-sqlite3（本地文件 `webui.db`） | 零运维、事务、单文件备份 |
| 模型/LLM 运行时 | **`@earendil-works/pi-ai@0.85.x`** | 统一 LLM API · Provider 抽象 · 自动模型发现 · **内置 token/成本统计** |
| 智能体核心 | **`@earendil-works/pi-agent-core@0.85.x`** | `Agent` 有状态循环 · 事件流 · tool 执行 · steering/session，与具体渠道解耦 |
| 任务进度 | SSE（Server-Sent Events） | 单向推送足够，实现简单 |
| 确定层 Gate | 移植为 **TS 模块内联调用**（`child_process` 跑现有 `.js` 兜底） | 同栈、可单测；运行时**零 Python/bash 依赖** |

> **Python 退役策略**：运行时用到的全部 Python/bash 脚本（`tracking_commit.py`、`author_memory_commit.py`、`imagegen-*.sh/py`、`prompt-template.py`、`character-card.py`、`check-imagegen-env.sh`）**移植为 Node/TS**，WebUI 安装即用、无需 Python 环境。原 `.py/.sh` 仍保留在 skill 包内供 CLI 使用，两实现以**相同 CLI 契约与产物 schema**保证行为一致（回归用同一份 fixture，见 §7.4）。
> **版本策略**：`pi-ai` / `pi-agent-core` 必须**同 minor**固定（0.85.x），随 pi 官方升版时一起升并跑通最小冒烟（连通渠道 + 一次对话/一次生图）再并入。

---

## 4. 核心模块一：流程定义（Process as Data）

### 4.1 Stage 定义 schema（JSON）
每个阶段 = 一个可重跑、可门禁、可人审的 step：

```jsonc
{
  "id": "chapter",
  "title": "章节写作",
  "type": "batch",                    // batch=一次产出多章节；single=单产物
  "requires": ["outline", "characters", "concept"],
  "entry": {
    "assemble": "context-chapter",    // 上下文组装函数名（见 §5）
    "templates": ["agents/narrative-writer.md"],
    "knowledge_refs": ["writing-craft.md", "hooks-chapter.md"],
    "model_role": "writer"
  },
  "artifact": {                       // 产物 schema：校验并展示
    "kind": "file-set",
    "path": "${book}/正文/第%03d章_*.md",
    "meta": "正文审查_第%03d章.md"
  },
  "gates": [                          // 确定性门禁（按序执行，全过才可提交）
    {"name": "char-count", "min": 2000},
    {"name": "ai-patterns", "blocking": true},
    {"name": "degeneration", "blocking": true},
    {"name": "chapter-consistency", "args": "--check"},
    {"name": "tracking-commit", "on_commit": true}   // 唯一权威提交
  ],
  "confirm": {                        // 每步确认交互模型（决策基线③）
    "required": true,
    "actions": ["approve", "edit_rerun", "reject_regen", "skip"],
    "rerun_scope": "this_stage"
  },
  "next": ["consistency", "review"]
}
```

### 4.2 流程定义清单（long-form 默认流程）
| # | stage id | 产物落盘 | 主要 agent | 门禁 |
|---|---|---|---|---|
| 1 | `intake` | 项目卡片（SQLite） | —（表单） | 必填校验 |
| 2 | `topic`（可选） | `设定/题材定位.md` | story-architect | 扫榜数据引用校验 |
| 3 | `concept` | `设定/世界观/*.md`、金手指 | story-architect | 字段完整性 |
| 4 | `characters` | `设定/角色/*.md` | character-designer | 角色卡字段 |
| 5 | `outline` | `大纲/大纲.md`、`大纲/卷纲/`、`大纲/细纲/第%03d章.md` | story-architect | outline-detail、outline-copy、结构公式字段 |
| 6 | `chapter`（批） | `正文/第%03d章_*.md` + 三查记录 | narrative-writer | ai-patterns、degeneration、chapter-consistency、char-count、**tracking-commit** |
| 7 | `review` | `大纲/审查记录/` | review 多视角 | project-consistency（--scope review） |
| 8 | `deslop` | 改后正文 | narrative-writer | ai-patterns（blocking 清零）、normalize-punctuation |
| 9 | `cover` | `封面/`、`角色卡图/` | 图片后端（gpt-image-2） | imagegen 环境检查、尺寸校验 |
| 10 | `export` | 交付出品（.txt/.md 打包） | — | 字数/完整性统计 |

short-form 流程为单文件管线：`intake → concept → emotion(情绪设计/反转) → write → delivery-contract gate → deslop`。

### 4.3 状态机
每阶段四态：`pending → running → review → done`，另有 `blocked`（门禁未过/LLM 失败）。

```
pending ──run──▶ running ──产物+门禁──▶ review ─approve─▶ done ──▶ next
                    ▲                     │
                    └──── error/blocked ◀──┘
                    （重跑 = 回到 running，产物加 revision 后缀）
```

- **提交原子性**：门禁全过 → 产物 `rename` 正式落位 → tracking_commit 提交 → 状态写库。任一步失败即回滚（沿用现有「标点归一化原子写」模式）。
- **可回滚**：手动「回退到某阶段」= 新开 revision，不破坏已提交产物。
- **续跑**：任务记录持久化，服务重启后 `running` 状态复位为 `review`（因为单机，进程中断不可能有仍在跑的 LLM 调用）→ 用户重新确认。

---

## 5. 核心模块二：任务即上下文（Context = State）

这是「去对话化」的关键。每个任务**不接受聊天历史**，只从磁盘状态组装 prompt：

```
buildPrompt(stage, bookId) =
  [system]  agent 模板（移植现有 .md）
  + [系统事实块] book meta、题材定位、世界观、金手指、角色卡、卷纲/细纲(本章)
  + [追踪状态块] _tracking-state.json 精选：
      · characters.*.state/goal/open_threads
      · context.position / recent_chapters(最近3~5章摘要) / next_chapter_commitments
      · context.continuity_risks / long_term_constraints
      · foreshadow（涉本章：即将揭示/已埋未收）
      · timeline（未揭示事件）
  + [作者记忆块] .story/作者记忆/ 当前 scope 命中条目（author_memory_commit 读取）
  + [知识块]  按 stage.knowledge_refs 从 references/ 检索的 top-K 片段（M0 用关键词，
              后期可换 embedding）
  + [任务指令] stage.entry.template 注入当前产物目标
```

- **预算管理**：沿用 doc-budget 思路，每 stage 设 max_tokens（上下文输入上限 + 输出上限），超限自动裁剪「知识块→追踪历史→近期章节摘要」优先级。
- **一致性兜底**：追踪状态由 `tracking_commit` 独家维护；WebUI 不直接改 `_tracking-state.json`（除非用户手动编辑），保证与 CLI 技能互操作。

---

## 6. 核心模块三：智能体层（Agent）

> 决策：**门禁绝不交给 LLM**；agent 只负责「生成/改写」，引擎负责「校验」。

### 6.1 Agent 运行时（pi-agent-core + pi-ai 实测接线）
- **`Agent` 类**（`@earendil-works/pi-agent-core`）：有状态循环 `new Agent({ streamFn, transformContext, beforeToolCall, afterToolCall, shouldStopAfterTurn, sessionId, ... })`；
  - `agent.prompt(text)` 开启一轮；`agent.subscribe(listener)` 收事件流（turn / text / tool_call / agent_end）；`agent.state` 持有 transcript 与 tools；`steer / followUp / abort / waitForIdle` 控制循环与停止。
  - **`transformContext()` / `convertToLlm` 钩子 = 我们的「任务即上下文」注入点**：在这里把 §5 组装的系统事实块 / 追踪状态 / 知识块合并进 messages，再交给 LLM。
  - **`StreamFn` 接缝**：`StreamFn = (model, context, options) => AssistantMessageEventStream`。我们以 `setDefaultStreamFn((m, c, o) => models.streamSimple(m, c, o))` 把 pi-ai 运行时接进 `Agent` —— **Agent 不感知具体渠道**，渠道由 pi-ai 的 Models 管理。
- **渠道运行时**（`@earendil-works/pi-ai`）：`createModels()` → `models.setProvider(createProvider({ id, baseUrl, auth:{ apiKey }, models:[...], api:{ 'openai-completions': {...} } }))`；
  - **一个「渠道」 = 一个 `createProvider`**（自定义 baseURL + apiKey + 静态模型目录）；`models.getAvailable()` / `models.refresh()` 做连通性与模型发现。
  - `Model` 自带 `contextWindow / maxTokens / cost`；每次响应 `AssistantMessage.usage{ input, output, totalTokens, cost }` → **成本/预算治理直接复用 pi-ai 的用量统计**，无需自造。
  - OpenAI 兼容网关差异用 `Model.compat`（`OpenAICompletionsCompat`）调：`maxTokensField`、`thinkingFormat`（`openai`/`deepseek`/`qwen`/…）、`samplingParams` 透传（`top_p`/`repetition_penalty` 等）。内置 provider id 已含 `opencode-go` 等（与 oh-story agent 模板的模型名体系一致）。
- **业务层角色抽象**（我们自己的薄封装）：
```ts
interface Role {
  id: 'architect'|'designer'|'writer'|'checker'|'researcher'|'explorer';
  template: string;                        // 移植自 references/templates/agents/*.md（或 SKILL.md 指令）
  model: { channelId: string; modelId: string };   // 模型路由 → 具体 Model
  tools?: Tool[];                          // pi-ai 的 Tool<TSchema> 定义
}
```
- **MVP 建议**：主流程 agent **不开放工具**（纯生成，产物按 schema 一次性产出，引擎负责落盘与校验）；复杂场景用「生成 → 门禁/自检 → 修复」最多 2 轮内循环（引擎控制轮数并计入成本），规避 Agent 工具链的不稳定。
- **后续可选**：仅对 `researcher` / `explorer` 开放只读工具（项目内 grep/read），用 pi-ai `Tool` 定义 + `Agent.beforeToolCall / afterToolCall` 钩子执行；门禁脚本**不进 agent 工具箱**（仍由编排层执行）。

### 6.2 模型路由
- 复用 oh-story 的模型分工思想：只读/校验 agent 用廉价模型（如 `deepseek-v4-flash`），创作 agent 用强模型（如 `deepseek-v4-pro`）——映射到 `Role.model.{channelId, modelId}`。
- 所有渠道经 **pi-ai Provider 目录**统一管理（`createProvider`，OpenAI 兼容 baseURL + API key + 模型目录），与 story-image 的「渠道」概念统一；配置存本地 `webui-config.json`（ACL 0600），密钥**不明文入库**（见 §10）。
- 未配置任何渠道时：启动首跳进入「设置向导」；无渠道不提供写作，但可浏览/编辑已有项目。

### 6.3 图片后端（pi-ai images 注册机制）
- 自定义 OpenAI 兼容生图端点用 `registerImagesApiProvider(api, { generateImages })` 注册：实现内部调 baseURL 的 `/images/generations`（gpt-image-2，文生图）与 `/images/edits`（图生图/参考图）→ 解析 base64 → 产 `AssistantImages { output: ImageContent[] }`。
- 渠道页复用一个 channel 的 baseURL/apiKey（`generateImages(model, { input }, { apiKey, headers })`）；结果 base64 → 落盘 `封面/`、`角色卡图/`；运行前跑 `check-imagegen-env` 环境门禁。
- 封面/角色卡 prompt 组装沿用 `prompt-template.py` / `character-card.py` 逻辑（**Node/TS 重写**为 `image-prompt.ts` 模块）；不注册生图 provider 时 `image` 阶段降级为「仅提示手动出图」。

### 6.4 多 agent 协同的边界
- 「用户需求 + 智能体自动调用」在本方案 = **每阶段按需 spawn 对应 agent**（串行执行），不做并发多 agent 竞争（单用户、每步确认、成本可控）。
- `consistency-checker`、`chapter-extractor` 等只读 agent 可作为**后台辅助任务**与主流程并行（例如章节写完自动触发一致性快检）。

---

## 7. 核心模块四：确定性门禁（Gates）

### 7.1 门禁适配器
```ts
interface GateAdapter {
  name: string;
  run(args): Promise<GateReport>;   // 内联调用（模块导入，或 spawn 现有 .js 兜底），解析结构化输出
}
interface GateReport {
  ok: boolean;
  blocking: string[];   // 会 fail-closed 的问题
  warnings: string[];
  detail: { rule: string; level: 'blocking'|'warning'; evidence: string }[];
}
```

### 7.2 确定层脚本 → Node/TS 映射
> 目标：WebUI 运行时零 Python/bash；迁移后**保留 CLI 契约不变**（原 `.js/.py/.sh` 仍可被 skill 包调用），WebUI 用 TS 实现（优先内联 import，特殊情况 spawn）。带 ⭐ 的是**必须移植项**（运行时被流水线直接依赖）。

| 现有脚本 | 用途 | WebUI 采用方式 |
|---|---|---|
| `check-ai-patterns.js` | AI 味/禁用句式（blocking） | ⭐ 直接复用逻辑 → TS 模块（原子性检查） |
| `check-degeneration.js` | 退化检测 | 复用 → TS 模块 |
| `normalize-punctuation.js` | 标点规范化（原子写） | ⭐ 复用 → TS 模块（写文件路径保持 rename 原子性） |
| `check-outline-detail.js` | 细纲字段（含场景演化学子项） | 复用 → TS 模块 |
| `check-outline-copy.js` | 细纲照搬检测 | 复用 → TS 模块 |
| `check-chapter-consistency.js` | 章编号/时间/倒计时硬事实 | 复用 → TS 模块 |
| `check-project-consistency.js` | 设定引用/面板/审查记录一致 | 复用 → TS 模块 |
| `check-revision-duplicate.js` | 重写残片/内部自重复 | 复用 → TS 模块 |
| `write-review-record.js` | 三查记录生成（机械填充） | ⭐ 复用 → TS 模块 |
| `check-delivery-contract.js` | 短篇交付形态验收 | 复用 → TS 模块 |
| `tracking_commit.py` | 追踪状态事务提交（唯一权威） | ⭐ **重写为 Node** `tracking-commit.ts`（保持 JSON 事务协议 + `schema_version`/`state_revision` 语义） |
| `author_memory_commit.py` | 作者记忆事务 | ⭐ **重写为 Node** `author-memory-commit.ts`（保持证据/候选/冲突/撤回协议） |
| `check-imagegen-env.sh` | 图像环境检测 | ⭐ 重写为 TS（检查 node 可执行文件/依赖/网络可达性即可，不再依赖 bash） |

> **移植纪律**：① 每条门禁行为与原实现逐条对照（沿用原 `test-*.py/js` 用例改写为 vitest，同一份 fixture 断言一致）；② 落盘文件与追踪状态 schema 不因移植改变（`_tracking-state.json` 仍是唯一权威）；③ 保持 `--project <path>` / `--out <tmp>` 参数面，便于对拍与回退。
> **兜底**：移植完成前，`spawn('node', [脚本])`（原 .js 检查脚本可先直接子进程跑）；`tracking_commit` 未移植前临时以 python 子进程调用，但 M1 结束前必须完成 Node 化。

### 7.3 Go/No-Go 策略
- 任一 `blocking` 命中 → 阶段 `blocked`，**不进入 review**，自动触发一次修复性重跑（引擎内循环，≤N 次），仍在 blocking → 呈现报告等待人工处理。
- 仅 `warning` → 可进入 review，但报告显著提示。
- 门禁报告持久化：`webui.db.gate_runs`，WebUI 提供「历史门禁趋势」视图（字数曲线、blocking 命中率、复查复现）。

### 7.4 移植回归规范（Python→Node）
- 每个移植项配 vitest 用例，**复用原脚本现有测试 fixture**（`scripts/test-*.py/js` 的输入/期望文件），断言「Node 版输出 == 原版输出」。
- 硬契约逐条对照：`tracking_commit`（26 项回归）、`author_memory_commit`（全流程事务）、`normalize-punctuation`（原子写/ BOM）、`check-ai-patterns`（blocking 10/10 benchmark）。
- 对拍脚本保留在 `webui/server/gates/__migration_spec__/`：本地可一键 `npm run test:gates-migration` 拉原版做 diff，CI 上也跑。

---

## 8. 数据模型

### 8.1 文件系统（内容真相，与 CLI 技能完全兼容）
```
{book}/
├── 正文/第%03d章_标题.md
├── 大纲/{大纲.md, 卷纲/, 细纲/, 审查记录/}
├── 设定/{题材定位.md, 文风.md, 关系.md, 世界观/, 角色/}
├── 追踪/_tracking-state.json   ← 唯一权威（含 schema_version/state_revision/伏笔/时间线）
└── .story/作者记忆/             （author_memory_commit 数据）
```

### 8.2 SQLite（`webui.db`）
```sql
books(id, name, dir, pipeline, created_at, updated_at, active_stage, meta_json);
stages(book_id, stage_id, status, revision, started_at, reviewed_at, note);
artifacts(book_id, stage_id, revision, path, type, size, checksum);
jobs(id, book_id, stage_id, kind, status, progress, error, cost_cents, detail_json, created_at, finished_at);
gate_runs(id, book_id, stage_id, revision, gate, ok, blocking_json, warnings_json, ran_ms, created_at);
channels(id, name, base_url, model_ids_json, enabled);   -- 密钥存 webui-config.json，不在此表
audit(id, ts, who, action, target, detail_json);         -- 每步确认/重跑均留痕
```

### 8.3 导入既有项目
`story-import` 现有反向解析逻辑移植到后端 `POST /api/import`：解析正文/大纲/设定 → 生成 `_tracking-state.json`（schema_version 4 对齐）→ 建书 + 定位 `last_committed_chapter`，之后可在 WebUI 继续流程。

---

## 9. API 设计（REST + SSE）

### 9.1 书籍与文件
- `GET   /api/books` / `POST /api/books`（新建/导入）
- `GET   /api/books/:id`（meta + active_stage + 流程缩略）
- `GET   /api/books/:id/tree?path=`（文件树）
- `GET   /api/files?path=` / `PUT /api/files`（读/改写；带 mtime 冲突检测，沿用 Dashboard 冲突保护）

### 9.2 流程
- `GET   /api/books/:id/stages`（管线视图：全部 stage 状态/产物/门禁摘要）
- `POST  /api/books/:id/stages/:stage/run`（发起执行 → 返回 jobId）
- `GET   /api/books/:id/stages/:stage`（产物 + 最新门禁报告）
- `POST  /api/books/:id/stages/:stage/review` `{action: approve|edit_rerun|reject_regen|skip, note?, edits?}`
- `POST  /api/books/:id/stages/:stage/rollback`（回到该阶段开新 revision）

### 9.3 任务与实时
- `GET   /api/jobs` / `GET /api/jobs/:id`
- `GET   /api/books/:id/jobs/events`（SSE：阶段开始/进度/门禁批次结果/完成/失败）

### 9.4 Agent 辅助
- `POST /api/books/:id/agents/run` `{agent:'explorer'|'researcher'|..., question, refs?}`（一次性问答，不占主流程）

### 9.5 配置
- `GET/PUT /api/config`（渠道、模型角色映射、风格预设、预算上限、去AI味强度）
- `POST /api/config/channels/test`（连通性自检）

### 9.6 交付
- `POST /api/books/:id/export` `{format:'markdown'|'txt'|'epub'(后期)}`

---

## 10. 安全与隐私

- 仅监听 `127.0.0.1`；服务管理 API 默认不暴露局域网。
- 可选访问令牌（`webui-config.json` 内 `access_token`），前端每次请求携带。
- **密钥不入库**：渠道 API key 存本地配置文件，`0600` 权限（Windows 下 NTFS ACL），界面输入时掩码。
- 无遥测、无公网上报；`--root` 限定工作区，文件 API 做路径规范化防穿越。
- 每步确认全量留痕到 `audit`，支持回溯「谁在何时对哪个 stage 做了什么」。

---

## 11. 里程碑（M0→M4）

### M0 骨架（交互先行）
- Fastify 骨架 + SQLite + `books` CRUD + 建/导入
- 文件树 + CodeMirror 编辑器 + 冲突保护 + 书籍工作台布局 + 阶段侧栏（静态）
- **确定层 Node 移植脚手架**：`gates/` 目录 + vitest + 迁移对拍骨架（先跑通「原 .js 脚本 spawn 兜底」，供后续逐一替换）
- **验收**：能用 WebUI 浏览/编辑 demo 长篇项目，替代 Story Dashboard。

### M1 流程引擎闭环（第一段流程）
- 流程定义解释器 + 状态机 + 任务队列(SSE) + 每步确认交互模型
- 跑通 `intake → concept → characters → outline`，全部挂对应门禁
- **pi-ai 接线**：`createModels` + 渠道 → `createProvider`（OpenAI 兼容），连通性/模型发现、`Agent` + `StreamFn` 接缝、SSE 进度桥接到 `Agent.subscribe`
- **确定层移植第一批（⭐ 项）**：`tracking_commit` → `tracking-commit.ts`、`author_memory_commit` → `author-memory-commit.ts`、`normalize-punctuation` / `write-review-record` → TS 模块，各自过 7.4 对拍
- 渠道/配置页 + 模型路由 + 设置向导 + 首次对话/生图冒烟
- **验收**：新建一本书，UI 上逐步确认产出大纲（模型真实调用），门禁报告可见，token/成本统计入库；**tracking/author-memory 已无 python 依赖**。

### M2 章节写作主链路
- `chapter` 批处理：细纲→每章正文 + 三查记录 + 门禁 + **tracking_commit** 提交
- 上下文组装（Context 模块）+ 知识检索（关键词 RAG）
- 一致性快检（consistency-checker 独立辅助任务）
- 作者记忆读写接入
- 角色线深化：按 [character-line-management.md](character-line-management.md) 方案 **A（弧线文件+阶段状态机）+ D（写后记账代理+弧线审计闸门）** 增量落地，弧线状态并入追踪派生视图
- **验收**：连续写 3 章，追踪状态正确演进，blocking 门禁可中断。

### M3 兜底与交付
- `review`（多视角审查）→ `deslop`（去AI味，blocking 清零）
- `image`（封面/角色卡，复用 gpt-image-2 渠道）
- `export`（txt/markdown + 统计）
- **验收**：demo 项目一键走完全流程无人工改码。

### M4 打磨
- `story-import` 完整移植（导入已有书继续流程）
- 门禁历史/成本统计视图、预算熔断、重跑/回滚 UX 完善
- 可选单文件打包（pkg/SEA）；README(WebUI) + `webui/` 目录纳入本仓库发布包

---

## 12. 目录结构（落地建议）

```
webui/                        ← 新增独立应用（本仓库内，或独立仓库后 link）
├── package.json
├── server/
│   ├── index.mts             # Fastify 入口（TS/ESM）
│   ├── config/               # 渠道/模型/预算（webui-config.json 读写）
│   ├── db/                   # better-sqlite3 (webui.db)
│   ├── engine/               # 流程定义解释器 + 状态机 + 队列 + 确认交互
│   ├── ai/                   # pi-ai 运行时：createModels/createProvider(渠道) + images 注册 + usage/成本
│   ├── agents/               # pi-agent-core：Agent 装配 + StreamFn 接缝 + 角色模板 + 上下文组装(Context)
│   ├── gates/                # gate 适配器（Node/TS 移植内联 + 原 .js 子进程兜底 + 迁移对拍用例）
│   └── routes/               # REST/SSE
└── client/                   # React + Vite + AntD + CodeMirror
    ├── pages/                # 项目列表/工作台/阶段内容/配置/导出
    ├── components/           # StageCard/GateReport/ConfirmBar/ProgressSSE
    └── api/                  # 客户端 API 封装
docs/design/standalone-webui.md   # 本文档
```

> 流程定义（`webui/server/engine/definitions/*.json`）与上下文组装函数（`Context`）是本方案「流程化 + 智能体自动调用」的两个核心沉淀点，也是与现有 skill 的唯一耦合面——skill 指令的每一次升级最终都应落到这两处。
> 前端界面设计（信息架构 / 页面线框 / 交互流程 / 组件清单 / 设计系统「书稿编辑部」）见 [`docs/design/webui-frontend.md`](webui-frontend.md)。

---

## 13. 关键风险与对策（更新）

| 风险 | 对策 |
|---|---|
| 长篇上下文爆炸 | 分层上下文（§5 优先级裁剪）+ doc-budget + 追踪摘要 |
| 创作质量主观 | 每步确认（决策基线③）+ 审查/去AI味 stage + warning 门禁 |
| LLM 失败/限流 | 任务队列 + 内循环重试(N 次) + 服务重启后阶段复位为 review + 预算熔断 |
| 门禁误杀/漏杀 | 门禁分级 blocking/warning + 门禁历史可回溯调参 |
| 与 CLI 技能的双向兼容 | 内容只写标准书结构；追踪状态唯一权威不变；导出兼容 |
| 模型渠道质量参差 | 渠道模型目录化 + 角色路由配置 + 连通性自检 |
| pi-ai/pi-agent-core 版本漂移 | 同 minor 固定（0.85.x）+ 冒烟测试；API 以本地装包 `.d.ts` 为准 |
| 上游 API 未建模的网关方言 | `Model.compat`（maxTokensField/thinkingFormat/samplingParams）覆盖 OpenAI 兼容差异 |
| Python→Node 移植行为漂移 | 移植回归对拍（§7.4）同一 fixture 断言一致；追踪状态 schema 不因移植改变 |
| 遗漏 Python 运行时依赖导致安装门槛 | `npm run check:no-python` 门禁：扫 server 源码无 `.py/.sh` 运行时依赖后再放行 |

---

## 14. 待评审决策点
1. **独立仓库还是并入 oh-story**：建议并入（`webui/` 目录纳入发布包），与技能包同版发布；若嫌包体积大可拆独立仓库，仅共享 docs/design 与脚本。
2. **RAG 起点**：M1 用「关键词 + 人工 curated 引用段」；M2 起按需引入 embedding（本地 SQLite-vec / 无外部服务）。
3. **导出格式优先级**：先 md/txt；epub/PDF 后期。
4. **AI 辅助问答**（explorer/researcher）是否在 M1 就开放只读工具调用，还是纯 LLM 生成式回答。建议 M3 后再开工具。
5. **pi 生态接入策略**：本方案只依赖 `pi-ai` / `pi-agent-core`（MIT，npm 可装、无 pi CLI 依赖）；是否顺带读入 pi 官方 provider 目录（含已配 `opencode-go` 之类）作为渠道模板——建议 M1 自定义 createProvider 起步，官方目录仅作参考。

---

*本方案 v0.5 —— 所有 stage/gate/API 名称以最终实现为准；实现时以本地安装的 `pi-ai@0.85.x` / `pi-agent-core@0.85.x` 的 `.d.ts` 为 API 权威；确定层脚本一律 Node/TS 化、零 Python/bash 运行时依赖；完整规格九篇见文档地图，开工顺序以 [implementation-plan.md](implementation-plan.md) 为准。*

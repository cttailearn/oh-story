# oh-story WebUI 流程定义规范（v0.1）

> 配套 [`standalone-webui.md`](standalone-webui.md)（主案）第四章「流程定义（Process as Data）」。
> 本文是实现级的规格：**类型定义 → 完整流程 JSON → 状态机 → Context 组装**。是「用户需求 + 智能体自动调用」的第一处核心沉淀，所有 skill 指令的升级最终落到这里。

---

## 1. 定版与版本
- `PROCESS_DEF_VERSION = 1`；写入 `webui-config.json`，与书记录 `pipeline_version` 关联。
- 流程定义 = 结构化数据，不硬编码在业务代码里；升级只改 `definitions/*.json` + 迁移函数（见 data-model 的升级策略）。

---

## 2. 类型定义（TypeScript 权威接口）

```ts
// webui/server/engine/types.ts
type StageStatus = 'pending' | 'running' | 'review' | 'blocked' | 'done' | 'skipped';
type ConfirmAction = 'approve' | 'edit_rerun' | 'reject_regen' | 'skip';

interface ProcessDefinition {
  id: string;                // 'long' | 'short'
  version: number;           // 1
  title: string;
  stages: StageDefinition[];
  defaults: {
    retry_limit: number;     // 内循环重试上限，默认 2
    model_role?: string;
    confirm_required: boolean; // 每步确认，本方案恒 true
    max_tokens_in: number;   // 上下文输入预算
    max_tokens_out: number;  // 输出预算
  };
}

interface StageDefinition {
  id: string;
  title: string;
  type: 'single' | 'batch';
  requires: string[];        // 前置阶段 id
  entry: StageEntry;
  artifact: ArtifactSpec;
  gates: GateSpec[];
  confirm: ConfirmSpec;
  next?: string[];           // 默认按定义顺序取 | 或显式列表
  retry_policy?: { limit?: number; on: 'blocking' | 'error' | 'both' };
}

interface StageEntry {
  assemble: string;          // 上下文组装函数名（§5 Context 注册表）
  templates: string[];       // 相对 webui/agents/templates/ 的模板文件
  knowledge_refs: string[];  // 相对知识库根（映射到 references/agent-references/）的检索目标
  model_role: string;        // 角色→模型路由键（writer/architect/checker/…）
  instructions?: string;     // 追加的固定指令（可选）
}

interface ArtifactSpec {
  kind: 'file-set' | 'file' | 'record' | 'image-set';
  path: string;              // 支持 ${book} 与 %0Nd 占位
  meta?: string;             // 伴生元数据文件/记录
  fields?: string[];         // record 的必填字段
}

type GateName =
  | 'char-count' | 'ai-patterns' | 'degeneration' | 'outline-detail'
  | 'outline-copy' | 'chapter-consistency' | 'project-consistency'
  | 'revision-duplicate' | 'delivery-contract' | 'normalize-punctuation'
  | 'write-review-record' | 'tracking-commit' | 'author-memory' | 'imagegen-env';

interface GateSpec {
  name: GateName;
  blocking?: boolean;        // 默认 true
  args?: string[];           // 透传 CLI 参数（--project/--scope/--mode/…）
  on_commit?: boolean;       // 允许在提交事务内执行（tracking-commit）
  min?: number; max?: number;   // char-count 等数值门禁
}

interface ConfirmSpec {
  required: boolean;          // 恒 true（每步确认）
  actions: ConfirmAction[];
  rerun_scope: 'this_stage' | 'subsequent';  // 改后重跑是只跑本阶段还是连同后续
}
```

---

## 3. long-form 完整流程定义（v1）

```jsonc
{
  "id": "long",
  "version": 1,
  "title": "长篇网文全流程",
  "defaults": { "retry_limit": 2, "confirm_required": true, "max_tokens_in": 26000, "max_tokens_out": 6000 },

  "stages": [
    {
      "id": "intake",
      "title": "需求录入",
      "type": "single",
      "requires": [],
      "entry": { "assemble": "context-intake", "templates": [], "knowledge_refs": [], "model_role": "architect" },
      "artifact": { "kind": "record", "path": "${book}/设定/题材定位.md", "fields": ["题材","类型","目标字数","平台风格","金手指","核心卖点","一句话Idea"] },
      "gates": [{ "name": "project-consistency", "args": ["--scope", "setup"] }],
      "confirm": { "required": true, "actions": ["approve", "edit_rerun"], "rerun_scope": "this_stage" }
    },

    {
      "id": "topic",
      "title": "选题/扫榜",
      "type": "single",
      "requires": ["intake"],
      "entry": { "assemble": "context-topic", "templates": ["agents/story-architect.md"], "knowledge_refs": ["genre-catalog.md", "genre-readers.md"], "model_role": "researcher" },
      "artifact": { "kind": "file", "path": "${book}/设定/题材定位.md" },
      "gates": [],
      "confirm": { "required": true, "actions": ["approve", "edit_rerun", "skip"], "rerun_scope": "this_stage" }
    },

    {
      "id": "concept",
      "title": "题材/世界观/金手指",
      "type": "single",
      "requires": ["intake", "topic"],
      "entry": { "assemble": "context-concept", "templates": ["agents/story-architect.md"], "knowledge_refs": ["worldbuilding.md", "plot-core-methods.md", "outline-methods.md"], "model_role": "architect" },
      "artifact": { "kind": "file-set", "path": "${book}/设定/{题材定位.md, 文风.md, 关系.md, 世界观/*.md}" },
      "gates": [{ "name": "project-consistency", "args": ["--scope", "setup"] }],
      "confirm": { "required": true, "actions": ["approve", "edit_rerun", "reject_regen"], "rerun_scope": "this_stage" }
    },

    {
      "id": "characters",
      "title": "人设",
      "type": "single",
      "requires": ["concept"],
      "entry": { "assemble": "context-characters", "templates": ["agents/character-designer.md"], "knowledge_refs": ["character-basics.md", "character-design-methods.md", "dialogue-mastery.md"], "model_role": "writer" },
      "artifact": { "kind": "file-set", "path": "${book}/设定/角色/*.md" },
      "gates": [{ "name": "project-consistency", "args": ["--scope", "setup"] }],
      "confirm": { "required": true, "actions": ["approve", "edit_rerun"], "rerun_scope": "this_stage" }
    },

    {
      "id": "outline",
      "title": "大纲（卷纲+细纲）",
      "type": "batch",
      "requires": ["concept", "characters"],
      "entry": { "assemble": "context-outline", "templates": ["agents/story-architect.md"], "knowledge_refs": ["outline-methods.md", "outline-rhythm.md", "outline-conflict.md", "hooks-chapter.md"], "model_role": "architect" },
      "artifact": { "kind": "file-set", "path": "${book}/大纲/{大纲.md, 卷纲/*, 细纲/*.md}" },
      "gates": [
        { "name": "outline-detail", "blocking": true },
        { "name": "outline-copy", "blocking": true },
        { "name": "project-consistency", "args": ["--scope", "outline"] }
      ],
      "confirm": { "required": true, "actions": ["approve", "edit_rerun", "reject_regen"], "rerun_scope": "this_stage" }
    },

    {
      "id": "chapter",
      "title": "章节写作",
      "type": "batch",
      "requires": ["outline"],
      "entry": { "assemble": "context-chapter", "templates": ["agents/narrative-writer.md"], "knowledge_refs": ["writing-craft.md", "emotional-arc-design.md", "hooks-suspense.md", "opening-design.md"], "model_role": "writer" },
      "artifact": { "kind": "file-set", "path": "${book}/正文/第%03d章_*.md", "meta": "正文审查_第%03d章.md" },
      "gates": [
        { "name": "char-count", "min": 1800 },
        { "name": "ai-patterns", "blocking": true },
        { "name": "degeneration", "blocking": true },
        { "name": "normalize-punctuation", "blocking": true },
        { "name": "chapter-consistency", "args": ["--check"] },
        { "name": "write-review-record" },
        { "name": "tracking-commit", "on_commit": true }
      ],
      "confirm": { "required": true, "actions": ["approve", "edit_rerun", "reject_regen"], "rerun_scope": "subsequent" }
    },

    {
      "id": "review",
      "title": "多视角审查",
      "type": "single",
      "requires": ["chapter"],
      "entry": { "assemble": "context-review", "templates": ["agents/consistency-checker.md"], "knowledge_refs": ["format-and-structure.md", "quality-checklist.md"], "model_role": "checker" },
      "artifact": { "kind": "file-set", "path": "${book}/大纲/审查记录/*.md" },
      "gates": [{ "name": "project-consistency", "args": ["--scope", "review"] }],
      "confirm": { "required": true, "actions": ["approve", "edit_rerun", "reject_regen"], "rerun_scope": "subsequent" }
    },

    {
      "id": "deslop",
      "title": "去AI味",
      "type": "batch",
      "requires": ["review"],
      "entry": { "assemble": "context-deslop", "templates": ["agents/narrative-writer.md"], "knowledge_refs": ["anti-ai-writing.md"], "model_role": "writer" },
      "artifact": { "kind": "file-set", "path": "${book}/正文/第%03d章_*.md" },
      "gates": [
        { "name": "ai-patterns", "blocking": true },
        { "name": "normalize-punctuation", "blocking": true },
        { "name": "revision-duplicate", "args": ["--mode", "patch"] }
      ],
      "confirm": { "required": true, "actions": ["approve", "edit_rerun"], "rerun_scope": "this_stage" }
    },

    {
      "id": "cover",
      "title": "封面/角色图",
      "type": "batch",
      "requires": ["concept", "characters"],
      "entry": { "assemble": "context-image", "templates": [], "knowledge_refs": [], "model_role": "" },
      "artifact": { "kind": "image-set", "path": "${book}/封面/*.webp, ${book}/角色卡图/*.webp" },
      "gates": [{ "name": "imagegen-env", "blocking": false }],
      "confirm": { "required": true, "actions": ["approve", "edit_rerun", "skip"], "rerun_scope": "this_stage" }
    },

    {
      "id": "export",
      "title": "交付导出",
      "type": "single",
      "requires": ["deslop"],
      "entry": { "assemble": "context-export", "templates": [], "knowledge_refs": [], "model_role": "" },
      "artifact": { "kind": "file", "path": "${book}/交付/*.{txt,md}" },
      "gates": [{ "name": "delivery-contract", "blocking": true }],
      "confirm": { "required": true, "actions": ["approve"], "rerun_scope": "this_stage" }
    }
  ]
}
```

> 说明：`chapter` 与 `deslop` 的 `max_tokens_out` 由 defaults 继承；batch 内每章独立记录 usage 与成本。`cover`/`export` 的 `model_role` 为空 = 不需要文本 agent（分别走 images provider / 纯文件操作）。

---

## 4. short-form 流程定义（单文件短篇）

```jsonc
{
  "id": "short",
  "version": 1,
  "title": "短篇/盐言单篇",
  "stages": [
    { "id": "intake",   "title": "需求与选题",     "entry": { "assemble": "context-intake", "model_role": "architect"  }, "artifact": { "kind": "file", "path": "${book}/设定.md" }, "gates": [], "confirm": { "required": true, "actions": ["approve","edit_rerun"] } },
    { "id": "concept",  "title": "故事核/反转设计",  "entry": { "assemble": "context-short-concept", "templates": ["agents/story-architect.md"], "model_role": "architect" }, "artifact": { "kind": "file", "path": "${book}/小节大纲.md" }, "gates": [{ "name": "outline-detail", "blocking": false }], "confirm": { "required": true, "actions": ["approve","edit_rerun","reject_regen"] } },
    { "id": "write",    "title": "正文写作",        "entry": { "assemble": "context-short-write", "templates": ["agents/narrative-writer.md"], "model_role": "writer" }, "artifact": { "kind": "file", "path": "${book}/正文.md" }, "gates": [{ "name": "ai-patterns","blocking": true }, { "name": "delivery-contract","blocking": true }, { "name": "normalize-punctuation","blocking": true }], "confirm": { "required": true, "actions": ["approve","edit_rerun"], "rerun_scope":"subsequent" } },
    { "id": "deslop",   "title": "去AI味",          "entry": { "assemble": "context-deslop", "templates": ["agents/narrative-writer.md"], "model_role": "writer" }, "artifact": { "kind": "file", "path": "${book}/正文.md" }, "gates": [{ "name": "ai-patterns","blocking": true }, { "name": "revision-duplicate","args":["--mode","patch"] }], "confirm": { "required": true, "actions": ["approve","edit_rerun"] } },
    { "id": "export",   "title": "交付",            "entry": { "assemble": "context-export", "model_role": "" }, "artifact": { "kind": "file", "path": "${book}/交付/*.txt" }, "gates": [{ "name": "delivery-contract","blocking": true }], "confirm": { "required": true, "actions": ["approve"] } }
  ]
}
```

---

## 5. Context 组装（Context 注册表）

### 5.1 接口
```ts
// webui/server/agents/context.ts
interface ContextBundle {
  system: string;              // agent 模板（Role.template）渲染后
  blocks: PromptBlock[];       // 有序注入块
}
interface PromptBlock { kind: 'facts'|'tracking'|'memory'|'knowledge'|'task'; title: string; text: string; tokens: number }
type Glue = { key: string; assemble(book, stage, role): Promise<ContextBundle> };
```

### 5.2 注册表（assemble 键 → 实现）
| glue | 用途 | 读取源 |
|---|---|---|
| `context-intake` / `context-topic` | 向导/选题 | 需求卡 + prose-card 检索 |
| `context-concept` | 题材/世界观/金手指 | 题材定位已有内容 + 题材卡 + 世界观骨架 |
| `context-characters` | 人设 | 世界观要点 + 已有人设去重校验 |
| `context-outline` | 卷纲/细纲 | 题材定位 + 角色卡摘要 + 情绪曲线模板 |
| `context-chapter` | 单章正文 | 详见 5.3 |
| `context-review` | 审查 | 涉审章节 + 追踪摘要 + 平台评分标准 |
| `context-deslop` | 去AI味 | 目标章 + AI 味检查报告(blocking 明细) + 规范化规则 |
| `context-image` | 封面/角色图 | 角色卡→structured json（`character-card` 提取） |
| `context-export` | 交付 | 全本统计 + 章节清单 |

### 5.3 一次 `chapter` 任务的 buildPrompt 实际形态（示例）

```json
{
  "system": "<narrative-writer.md 模板渲染>：你是网文正文执笔……（去AI味 7 Gate、语感要求…）",
  "blocks": [
    { "kind": "facts",  "title": "本章任务", "tokens": 320,
      "text": "书：《让你管账号……》 卷：第一卷·军宣整顿 章：第21章（无细纲，需先补）目标字数 2200-2600。" },
    { "kind": "facts",  "title": "题材定位/文风", "tokens": 700,
      "text": "……（题材定位.md + 文风.md 节选）" },
    { "kind": "facts",  "title": "本章细纲（硬要求）", "tokens": 900,
      "text": "细纲/第021章.md：结构公式=起(悬念露头)→承(战士围拢)→转(手机拍摄)→合(老兵开口)；禁提前释放='系统奖励来源'；结尾钩子='老兵说：故事得从四十七年前说起'。" },
    { "kind": "tracking", "title": "追踪状态（精选）", "tokens": 1100,
      "text": "position=火箭军文工团，如愿破亿后第二天；recent_chapters=[18,19,20] 摘要…；next_chapter_commitments=先补细纲再承接老兵邀请；continuity_risks=卷界未确认勿开新卷；金手指=前世MCN经验/天王唱功/导演能力（未用尽）" },
    { "kind": "tracking", "title": "伏笔与时间线（涉本章）", "tokens": 400,
      "text": "F054(已埋·高)=老兵邀江晨上门听故事→本章应承接；E013(未揭示)=军方培养安排，读者未知，本章不得提前揭示。" },
    { "kind": "memory",  "title": "作者记忆", "tokens": 200,
      "text": "[文风] 战士对话口语化、不喊口号；[流程] 军宣爽点必须靠作品效果/数据/围观反应链兑现。" },
    { "kind": "knowledge", "title": "知识检索 top-K", "tokens": 800,
      "text": "写作craft·对话掌控(节选)；hooks-suspense(节选)。" },
    { "kind": "task",   "title": "交付格式", "tokens": 150,
      "text": "输出 markdown 正文一章 + 结尾三查字段；随后由引擎跑门禁：char-count≥1800、ai-patterns=0 blocking、tracking-commit 提交第21章。" }
  ]
}
```

- **预算裁剪顺序**：`knowledge → tracking 历史 → 近期章节摘要 → facts 详情`，超 `max_tokens_in` 时按此丢。
- **一致性**：`chapter` 任务内**禁止携带全书 200 章正文**；只给摘要 + 相关检索（分层上下文）。

---

## 6. 状态机规则

```
状态: pending → running → review →(approve)→ done
                        ↘ blocked ←(blocking 未消 / error)
                              ↳ 引擎内循环(≤retry_limit) 重跑 running
```
- **转移表**
  | 事件 | 前置 | 后置 | 备注 |
  |---|---|---|---|
  | `run` | pending/review/blocked | running | 每次 run 递增 `revision` |
  | 产物+门禁全过 | running | review | 落盘 + 门禁报告入库 |
  | 有 blocking | running | blocked | 自动重试至 limit，仍 blocking 停 |
  | `review{approve}` | review | done | 写 audit；推进 next |
  | `review{edit_rerun}` | review | running | 携带用户 edits 重跑 |
  | `review{reject_regen}` | review | running | 弃当前 revision 重生成 |
  | `review{skip}` | review | skipped | 写 audit 原因 |
  | `rollback(stage)` | 任意 | 该 stage review | 新 revision，不破坏已提交产物 |
- **幂等**：`run` 带 `idempotencyKey`（bookId+stage+revision），重复提交返回已存在的 job。
- **并发**：同一本书同一 stage 同一时刻仅 1 个 running job（DB 唯一索引 `(book_id,stage_id,status='running')` 唯一）；不同书可并行（默认并发 2）。
- **fail-closed**：`tracking-commit` gate 缺失/不一致 → blocked，绝不允许跳过提交直接进下一章。
- **恢复**：服务重启 → 所有 running 复位为 review（单机无在途 LLM）；blocked 保持；pending 保持。

---

## 7. 与 skill 的耦合面（升级映射）

| 现有 skill 内流程指令 | 对应 Process 元素 |
|---|---|
| `story-long-write` workflow-chapter / daily / revision | `chapter`/`review`/`deslop` stage 定义 + glue `context-*` |
| `story-short-write` Phase 1-5 | `short` pipeline |
| `story-long-analyze` Stage1-3 | 拆文工作台（独立于 pipeline，但对拍拆文产物 schema） |
| `story-deslop` 检测+改写 | `deslop` stage `gates`（ai-patterns/anti-ai-writing refs） |
| `story-setup` 部署/AGENTS.md | 建库初始化（M0 的 setup 等效物 = 生成目录 + 部署 agent 模板） |
| 子代理模板 `references/templates/agents/*.md` | `Role.template` → `ContextBundle.system` |
| `references/agent-references/*.md` | `knowledge_refs` 检索源（500KB+ 知识库） |

> 纪律：skill 指令升级时，改动应**下沉**到 `definitions/*.json` 与 `agents/templates/*.md`；两处的变更即未来 CLI/WebUI 双端的行为同步点。

---

*流程定义规范 v0.1 —— 以 `webui/server/engine/definitions/{long,short}.json` 为最终落地文件；与主案 v0.3 对齐。*

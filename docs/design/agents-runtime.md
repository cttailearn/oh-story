# oh-story WebUI 智能体运行时（v0.1）

> 配套 [`standalone-webui.md`](standalone-webui.md) §6 与 [`process-definition.md`](process-definition.md) §5。
> 本文把「**用户需求 + 智能体自动调用**」落到代码级：**pi-ai 运行时装配 → Agent 实例化 → Context 组装 → 生成→门禁→修复内循环 → 事件桥 SSE → 失败/重试/预算**。所有职责归属有明确边界：**Agent 只管"生成/改写"，门禁与状态机归引擎**。

---

## 1. 运行时装配（server/ai/）

### 1.1 pi-ai 初始化（启动即建）
```ts
// server/ai/runtime.ts
import { createModels, createProvider, type Provider } from '@earendil-works/pi-ai';
import { openaiCompletionsStreams } from '../gates/.../bridge'; // 或直接用 api/openai-completions 的 stream

export class AiRuntime {
  private models = createModels();   // 内存 Provider 集合 + 可选 CredentialStore
  private byChannel = new Map<string, { llm: Provider; images?: ImageProvider }>();

  /** 每个渠道 = 一个 OpenAI 兼容 Provider（openai-completions），同步 webui-config.channels */
  setChannel(c: { id: string; baseUrl: string; apiKey: string; models: string[] }): void {
    const provider = createProvider({
      id: c.id,
      name: c.id,
      baseUrl: c.baseUrl,
      headers: { Authorization: `Bearer ${c.apiKey}` },   // 或 auth:{apiKey}
      auth: { apiKey: { env: `OHSTORY_CH_${c.id.toUpperCase()}` } }, // apiKey 由 getApiKey 兜底
      models: c.models.map((m, i) => ({
        id: m, name: m, api: 'openai-completions' as const, provider: c.id,
        baseUrl: c.baseUrl, reasoning: true, input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },  // 单价见 §5.3 从模型目录补
        contextWindow: 128_000, maxTokens: 8_192,   // 由模型目录/用户填
      })),
      api: { 'openai-completions': openaiCompletionsStreams },
    });
    this.models.setProvider(provider);
    this.byChannel.set(c.id, { llm: provider });
  }

  /** 取渠道+模型的长老 Model */
  modelFor(channelId: string, modelId: string) {
    const m = this.models.getModel(channelId, modelId);
    if (!m) throw new ApiError('MODEL_NOT_FOUND', `channel=${channelId} model=${modelId}`);
    return m;
  }
  get modelsApi() { return this.models; }
}
```
- **说明**：模型单价（`cost.*`）由「渠道模型目录」补充（用户可填每百万 token 单价，或维持 0 而只用 token 记账、前端按渠道默认价显示）。上游不支持的新字段靠 `Model.compat`（见主案 §6）逐渠道调。

### 1.2 与 pi-agent-core 的 StreamFn 接缝
```ts
// server/agents/streamFn.ts
import { setDefaultStreamFn, type StreamFn } from '@earendil-works/pi-agent-core';
import type { Model, Context, SimpleStreamOptions } from '@earendil-works/pi-ai';

/** 由 engine 注入：StreamFn 总入口 → 解析 model.provider 路由到 Models 流式调用 */
export function installStreamFn(ai: AiRuntime): void {
  const fn: StreamFn = (model: Model<any>, ctx: Context, opts?: SimpleStreamOptions) =>
    ai.modelsApi.streamSimple(model as any, ctx, opts);
  setDefaultStreamFn(fn);
}
```
> 这样 `Agent` 只依赖统一的 `Model/Context/事件流`，**不感知渠道**；换渠道/换模型只在配置层发生。

---

## 2. Agent 实例化与角色（server/agents/）

### 2.1 Role 注册表（模板即资产）
```
webui/agents/templates/
├── story-architect.md      # 题材/世界观/大纲/反转
├── character-designer.md   # 人设/语言风格/动机链
├── narrative-writer.md     # 正文/去AI味
├── consistency-checker.md  # 一致性/伏笔（只读）
├── chapter-extractor.md    # 章节摘要/情节点（只读，并行）
├── story-explorer.md       # 项目结构化查询（只读）
└── story-researcher.md     # 资料研究（只读）
```
模板 frontmatter 约定：
```yaml
---
role: narrative-writer
model_role: writer            # 对应 webui-config.model_routing 键
tools: false                  # true 才装载工具（explorer/researcher）
default_contexts: [context-chapter, context-deslop]
max_in: 26000
---
<正文即 system 提示词>
```

### 2.2 单阶段执行（engine 调用契约）
```ts
// server/engine/stageRunner.ts（伪代码级）
async function runStage(book, stage, revision, userEdits?) {
  const role  = roleFor(stage.entry.model_role);
  const agent = new Agent({
    streamFn,                                   // 全局已装
    transformContext: async (msgs) => msgs,     // Context 已由我们预组装（见 §3）
    afterToolCall: execOnlyForReadOnlyRoles(role),
    onPayload: (p) => sseBridge.emit({ jobId, type:'job:progress', text: p }),
  });
  const bundle = await assemble(stage.entry.assemble, book, stage, role);   // §3
  agent.state.systemPrompt = bundle.system;
  await agent.prompt(bundle.user_message);       // 产物按 artifact schema 一次性输出
  const drafted = extractArtifact(await agent.waitForIdle(), stage.artifact);
  return drafted;
}
```
- **生成→门禁→修复内循环**（引擎负责，非 Agent）：
```
drafted → gates.runAll(stage.gates, book, revision)
  ├─ 全过 → 原子落盘 → tracking-commit(on_commit gate) → status=review → SSE job:review
  ├─ 有 blocking → 若无 userEdits 且重试<retry_limit → rerun(携带 blocking 报告给 Agent 修复)
  └─ 仍有 blocking / 超限 → status=blocked → SSE gate:batch（最终报告）
```
- 修复重跑时把 `blocking 明细`（rule+evidence）作为追加指令注入同一 Agent 的下一轮（`agent.prompt` 同实例续上下文，或重建 + 传修复清单，二选一：**选重建**以保证"任务即上下文"纯净，成本预算可控）。

---

## 3. Context 组装器（server/agents/contexts/）

### 3.1 注册与实现约定
```ts
// glue: { key, assemble(book, stage, role): Promise<ContextBundle> }
const CONTEXT_GLUES = {
  'context-chapter':   buildChapter,      // process §5.3 给出示例 JSON
  'context-outline':   buildOutline,
  'context-characters':buildCharacters,
  'context-concept':   buildConcept,
  'context-topic':     buildTopic,
  'context-intake':    buildIntake,
  'context-review':    buildReview,
  'context-deslop':    buildDeslop,       // 注入 ai-patterns 报告的 blocking 明细作修复依据
  'context-image':     buildImage,        // 角色卡→structured json（character-card 逻辑 Node 版）
  'context-export':    buildExport,
  'context-short-*':   /* 短篇 */
} satisfies Record<string, ContextGlue>;
```
- 每个组装器统一返回 `ContextBundle { system, user_message, blocks[], budget }`；`budget` 记录各块 token 估算，供裁剪与成本。
- **知识检索**：M0 用 `knowledge_refs` 文件名直取（references/agent-references/*.md 常驻缓存目录 + 关键词定位段落），RAG 化延迟到 M2。

### 3.2 只读工具（explorer / researcher）
用 pi-ai `Tool` 定义 + Agent 钩子执行（仅 model_role 为 explorer/researcher 的角色装载）：
```ts
const readTools: Tool[] = [
  { name: 'read', description: '读取项目内文件', parameters: Type.Object({ path: Type.String() }) },
  { name: 'grep', description: '在工作区内正则检索', parameters: Type.Object({ pattern: Type.String(), include: Type.Optional(Type.String()) }) },
];
// 执行：beforeToolCall 校验 path 在 --root 内（防穿越）；afterToolCall 结果回写 transcript
```
- **门禁脚本绝不给 Agent 调用**（引擎独占）。

---

## 4. AI 需求式编辑（server/agents/aiEdit.ts）

- 无状态任务：不占 stage 状态机，只记账 + 审计。
```ts
async function aiEdit(book, req: { target, demand, model_role, tone?, intensity? }) {
  const role = roleFor(req.model_role);          // writer|architect|checker…
  const ctx  = buildAiEditContext(book, req);    // 目标文件选中段 + 关联细纲/tracking 精简
  const agent = new Agent({ streamFn });
  await agent.prompt(ctx.user);
  const diff = makeDiff(await agent.waitForIdle(), req.target);
  return { edit_id, diff, applied:false, cost_cents };  // 前端展示，用户确认后 PUT /files
}
```
- **需求映射**：`demand.kind` 快捷键（hook/rewrite/condense/pov…）→ 预置指令注入；`custom` 原样拼接。
- 产物不自动过门禁；用户「应用并校验」时才触发对应 gates（见 frontend P5）。

---

## 5. 失败 / 重试 / 成本 / 安全

### 5.1 失败分级
| 类型 | 处理 |
|---|---|
| 流起始失败 / 网络 / 401 | 重试 ≤2（指数退避，`maxRetryDelayMs`）→ 仍失 → job:error + 阶段 blocked |
| 输出被截断（`stopReason=length`） | 视为需修复：重跑并给「余下部分」指令 + 提高 maxTokens（预算内） |
| 工具调用异常（只读） | 该工具结果标 error 回写，不中断主流程 |
| `BUDGET_EXCEEDED` | 立即熔断 → job:error → WebUI 提示调整预算/换模型 |

### 5.2 成本记账
- 每次 `AssistantMessage.usage` 落 `jobs.tokens_* / cost_cents`（累计），gate_runs/省；书级汇总 `GET /books/:id` meta。
- 前端「流程看板」右上角实时显示本阶段 `¥` 与全本累计；超 `stage_max_cents` 由引擎在 gate 前预检拦截。

### 5.3 单价
- webui-config 可按渠道填 `price_per_mtok: {input, output, cacheRead, cacheWrite}`；未填则 `cost=0`，仅显示 token——绝不让"零报价渠道"意外烧钱。
- 后续可加载 pi-ai 官方模型价目（模型目录含 cost）作为默认。

### 5.4 安全
- `--root` 工作区白名单；一切文件读写经 `server/fs`（路径规范化）。
- 渠道 apiKey 只在服务端持有，不出接口（读回掩码）；模板渲染用缺失枚举，防 prompt 注入把工具/文件路径带偏。
- Agent 无写工具 → 即使被诱导也改不了盘（写只发生在引擎落盘路径）。

---

*智能体运行时 v0.1 —— M1 以本文件装配「pi-ai + pi-agent-core」最小链；先通 `故事 → 正文` 一节真实调用，再扩展其余 glue。*

# oh-story WebUI AI 编辑规格（v0.1）

> 配套 [`agents-runtime.md`](agents-runtime.md) §4（服务侧）与 [`api-contract.md`](api-contract.md) §3.7。
> 本文把「**AI 根据需求编辑**」从"一个抽屉"深化为完整产品能力：**触发入口 → 需求模板库 → 三种模式 → diff 采纳多轮 → Revision/Undo → 门禁修复闭环 → 成本与审计**。AI 编辑永远只是**辅助小工具**，不进入流程状态机。

---

## 1. 触发入口（前端各模块）
| 位置 | 触发 | 默认目标 |
|---|---|---|
| 设定/大纲/正文 | 选中文本 → 浮动条 ✒ | `target.range` |
| 正文 | 章节顶栏「✒ 按需求改本章」 | 整章/光标段 |
| 环节卡（角色/设定卡） | 卡右上 ✒ | 整卡文件 |
| 流程看板·blocked | 「让 AI 修复」 | gateFix 模式（见 §6） |
| 空目标 | 新建（加一个角色/卡片/章节设定） | `mode:'insert'` |

---

## 2. 需求模板库（per-module 定制）
```ts
// server/agents/demand-templates.ts
const DEMAND_TEMPLATES: Record<string, DemandTemplate[]> = {
  chapters: [                                        // 正文
    { kind: 'hook',        label: '强化本章钩子',   prompt: '把结尾改写成更强的悬念/转折，保留前文事实' },
    { kind: 'opening',     label: '改开篇抓人',     prompt: '重写开头，前 3 句就要抓住读者（冲突/悬念/画面起手）' },
    { kind: 'condense',    label: '压缩到N字',      prompt: '删除复述与无功能过场，精炼到 {n} 字左右' },
    { kind: 'pov',         label: '改人称/视角',    prompt: '改第三人称/受限视角，全章一致' },
    { kind: 'de-ai',       label: '去AI味',         prompt: '消除 AI 腔：拆分长句、去排比口号、语料口语化' },
    { kind: 'foreshadow',  label: '埋一处伏笔',     prompt: '在不破坏本章契约前提下埋一处可收回伏笔，给出计划章' },
    { kind: 'custom',      label: '自定义需求',     prompt: null },   // 拼接用户原文
  ],
  outlines: [ { kind:'hook', label:'加强结局钩子' }, { kind:'split', label:'拆成两章' }, { kind:'tighten', label:'压缩该章要点' } ],
  characters: [ { kind:'deepen', label:'补强动机链' }, { kind:'arc', label:'规划本卷弧线(见角色线方案A)' }, { kind:'voice', label:'提炼语言风格档案' } ],
  worldbuilding: [ { kind:'fill', label:'圆场设定漏洞' }, { kind:'expand', label:'扩展当前小节' } ],
  state: [ { kind:'trace', label:'整理未收伏笔清单' }, { kind:'risk', label:'诊断一致性风险' } ],
};
```
- `{n}` / `{「占位」}` 由前端弹参数（如目标字数），服务端模板替换。
- 业务约束：正文类模板指令里**强制追加**「不得改变事实/编号/已建立设定」「改完请给出变更摘要」。

---

## 3. 请求模型（扩展 api-contract §3.7）
```ts
interface AiEditRequest {
  mode: 'rewrite' | 'insert' | 'fix-gates';
  target: { path: string; range?: { start: number; end: number } } | 'new';
  demand: { kind: string; custom?: string; params?: Record<string, string|number> };
  refs?: string[];                 // 追加知识引用
  model_role?: 'writer'|'architect';
}
interface AiEditResult {
  edit_id: string;
  mode: AiEditRequest['mode'];
  diff: DiffHunk[];                // {type:'add'|'del', line, text}
  applied: false;
  note: string;                    // AI 变更摘要（"改了什么、为什么"）
  cost_cents: number;
  gates_hint?: { after_fix?: boolean };  // fix-gates 模式回执
}
```
- **SSE**：服务端流式下发 `edit:diff`（分块），前端边收边画。
- **超时**：单次 120s；超出 → `job:error` + 已流出的 diff 保留可部分采纳。

---

## 4. 采纳交互细化
- **diff 视图**（左原右新，绿增朱删，行对齐）；顶部状态：`未采纳 · 草稿不落盘`。
- 操作：`[接受全部] [逐块接受] [重写一次] [放弃]`；重写一次记录为同 `edit_id` 的微迭代。
- **多轮补改**：在接受部分块后可选「继续改这块」→ 生成 `edit_id` 续篇（以当前半成品为基线），最多 3 轮。
- **采纳 = 落 Revision**：写文件到 `正文/_rev/第021章.md.r3`（或按文件名后缀）→ **不自动进正稿**；用户在下拉 Revision 切换器确认「设为正式」→ 触发所选 gates（默认 ai-patterns + normalize-punctuation + chapter-consistency）。
- **Undo**：任何一次采纳都可回退（Revision 栈），`audit` 留痕 `ai-edit:apply` / `ai-edit:undo`。

---

## 5. 门禁修复闭环（`fix-gates`，blocked 的"一键修复"）
> **次序（与引擎自动重试的关系）**：`blocked` 的产生顺序是 **引擎全自动内循环（≤retry_limit，携带 blocking 报告给 Agent 修复）→ 仍未过 → 阶段置 blocked → 人工点「让 AI 修复」进 `fix-gates`**。二者不重复：内循环是无人值守兜底，`fix-gates` 是人工介入的深度修复（可控 diff）。
```
[阶段 blocked]
 → 看板「让 AI 修复」  → POST /ai-edit { mode:'fix-gates', demand:{ kind:'resolve-blocking' } }
   服务端组装:
     · 输入 = 失败文件列表 + 最新 gate 报告(blocking 明细 rule+evidence) + 原文+细纲硬要求
     · 指令 = "逐条修复下列 blocking（{证据}），不许改事实/编号；给出变更摘要"
 → 流式 diff → 用户逐块/全部采纳 →「接受并重新跑门禁」
   引擎: 落 Revision（非正稿）→ 仅跑被修 gate → 全过 → 提示"可设为正式并提交"
```
- **安全阀**：`fix-gates` 不自动提交、不改追踪；被修文件先落 Revision，正稿由用户确认。
- **防止"改成别的毛病"**：fix 指令强制带「变更摘要」，且重跑**全量**该 stage gates（不只 blocked 项）才允许设为正式。

---

## 6. 成本 / 限流 / 审计
- 每次 `edit` 独立记账；`stage_max_cents` 对 ai-edit 不生效（可用 `daily_max_cents` 兜底）。
- 高频触发保护：单用户同一文件 60s 内最多 6 次新 `edit_id`（429）。
- `audit.action`：`ai-edit:request / ai-edit:apply / ai-edit:undo / ai-edit:fix-gates`，`target` 形如 `book:nb_02K/file:正文/第021章.md`。

---

## 7. 边界
- **不改追踪状态**：AI 编辑产物只改目标文件；角色/伏笔变化走 `tracking-commit`（提示性引导，不代写）。
- **抓【错误目标】**：`target.path` 必须存在于 `--root` 内且属于当前书；`range` 按 CodeMirror 行/字符索引校验。
- **长文整章**：正文类 rewrite 默认只处理选区；整章时服务端截取 ≤`max_tokens_out` 的前 N 段并提示分段处理。

---

*AI 编辑规格 v0.1 —— M1 先落地 `rewrite` + `insert`（抽屉可用），`fix-gates` 随 M2 门禁闭环启用。*

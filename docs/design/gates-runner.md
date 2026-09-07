# oh-story WebUI 门禁执行器（v0.1）

> 配套 [`standalone-webui.md`](standalone-webui.md) §7、[`process-definition.md`](process-definition.md)（`GateSpec`）、[`api-contract.md`](api-contract.md)（`gate:batch` 事件）。
> 本文给出：**执行器设计 → 统一报告契约 → 每个 gate 的字段语义 → 迁移对拍 harness**。核心铁律：**门禁只由引擎执行，Agent 永不调用**。

---

## 1. 执行器（server/gates/runner.ts）

```ts
interface GateReport {
  gate: string;
  ok: boolean;
  blocking: RuleHit[];
  warnings: RuleHit[];
  value?: number | string;          // char-count 等数值门禁
  meta?: Record<string, unknown>;   // tracking-commit 的 commit 信息等
  ran_ms: number;
}
interface RuleHit { rule: string; evidence: string; level: 'blocking'|'warning' }

type GateImpl = (ctx: GateCtx, spec: GateSpec) => Promise<GateReport>;
// GateCtx = { bookDir, revisionDir, projectPath(calc), tmpOut, env }
```

### 1.1 执行语义
- 顺序执行（stage.gates 数组序），**遇 blocking 即记 failure，但继续跑完同批剩余项**（前端一次拿到完整报告，便于修复）。
- 超时：per-gate 默认 30s（`tracking-commit` 60s），超时按 `ok:false, blocking:[{rule:'gate-timeout'}]` 处理。
- 并发：门禁无副作用时并行（如 ai-patterns + degeneration）；`on_commit`（tracking-commit）串行且最后执行。
- 输出解析：Node 版直接返回结构化对象；`spawn` 回退时解析 stdout JSON（`--out -` 或 `--json`），无 JSON 时按行规则 fallback。
- 幂等：同一 stage+revision 已跑过的 gate 结果**不重跑**（以 `gate_runs` 查存），除非 `review{edit_rerun}` 产生新 revision。

### 1.2 TS 模块化（Node 化后）
- 每个 `check-*.js/py` → `server/gates/impl/<gate>.ts`，导出 `run(ctx, spec): GateReport`；
- 保留原脚本 CLI 契约以跑对拍（§3），但 WebUI 主路径**内联 import**，零子进程。

---

## 2. 每个 gate 的报告契约

| gate | blocking 语义 | 报告字段 | 依据 |
|---|---|---|---|
| `char-count` | 字数 < `spec.min`（默认 1800） | `value=实际字数` | 正文 md 去空行计 |
| `ai-patterns` | 命中**确定性句式/标点黑名单** | `blocking[]: rule+evidence(句)`；AI 味弱项走 warning | 保留原 benchmark 10/10 |
| `degeneration` | 连续重复/车轱辘话密度超阈值 | `blocking[]/warnings[]` + `value=密度` | 原检测逻辑 |
| `normalize-punctuation` | **写入失败才 blocking**（规范自身非阻断） | `meta:{rewritten:N, atomic:true}` | 原子写（tmp+rename） |
| `outline-detail` | 细纲缺必填字段/密点缺场景演化学子项 | `blocking[]: {field}` → 缺失字段名 | current-contract required_* |
| `outline-copy` | 正文连续片段与细纲重叠超阈值 | `blocking[]: {span}` | 播种上界去除后的逻辑 |
| `chapter-consistency` | 章编号/星期/倒计时硬事实错 | `blocking[]`；其余为 warning | 原脚本 |
| `project-consistency` | `--scope {setup\|outline\|review}` 结构/引用/记录不符 | `blocking[]/warnings[]`；review 缺三查记录= blocking | 原脚本 |
| `revision-duplicate` | 重写残片 ≥15 字重叠 / 内部自重复 | `blocking[]: {overlap}`；`--mode patch\|rewrite` | 原脚本 |
| `delivery-contract` | 短篇正文为空/分节样式/段间空行（blocking） | `meta:{chars}` | 原脚本 |
| `write-review-record` | 三查记录缺失/与章号不齐（fail-closed） | `blocking[]: {missing file}` | 原脚本生成+校验 |
| `tracking-commit` | 追踪状态缺失/不一致/提交失败 | `ok:false`；成功后 `meta:{commit:{last_committed_chapter,state_revision}}` | Node 化，事务协议 |
| `author-memory` | 事务协议错误 | `meta:{kinds,scopes}` | 注入作者偏好（非强制 gate） |
| `imagegen-env` | 仅 warning（环境缺工具提示） | `meta:{deps:[{name,ok}]}` | 不再依赖 bash |

> 字段级 `level`/`evidence` 在 `gate:batch` SSE 里逐条下发，前端按 rule 归类展示（朱批浮动 label）。

---

## 3. 迁移对拍 harness（Python→Node 的"照妖镜"）

```
server/gates/__migration_spec__/
├── fixtures/                     # 与原 scripts/test-*.py/js 相同输入/期望
│   ├── ai-patterns/{pass.md, fail.md, expected.json}
│   ├── tracking/{chain…}
│   └── …
└── diff.spec.ts                  # vitest：Node 版 vs 原版（spawn 原脚本）输出 diff
```
- 每次 gate 改动：本地 `npm run test:gates-migration`（全部 diff 必须 green）→ CI `guards.yml` 加同名 step。
- 断言方式：结构化 JSON diff（deep-equal），数字门禁允许 ±eps；文本证据段允许顺序差异（排序后比较）。
- **回归门禁**：`tracking-commit`（26 项）、`ai-patterns`（benchmark 10/10）、`normalize-punctuation`（BOM/原子写）为不可回退项——对拍失败即红。

---

## 4. Go/No-Go 汇总（与主案 §7.3 同表）
- **blocking 任一命中** → 阶段 `blocked` → 引擎内循环修复（带报告给 Agent）≤`retry_limit` → 仍失败则等人工。
- **review{approve} 被拒**：若最新 gate_runs 存在 blocking → 409 `GATE_BLOCKING`（api-contract）。
- **门禁历史**：`gate_runs` 全量入库 → WebUI「门禁趋势」可查（blocking 命中率/复查复现/耗时）。

---

*门禁执行器 v0.1 —— M0 建 runner+契约框架（原 .js 先 spawn 兜底），M1 完成 ⭐ Node 化并对拍通过后切内联。*

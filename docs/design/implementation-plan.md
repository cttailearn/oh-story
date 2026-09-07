# oh-story WebUI 实施计划与验收（M0–M1）

> 配套主案里程碑（§11）与全部规格文档。本文把 M0/M1 拆成**可开工的任务清单（WBS）**：每个任务 = 依赖的规格文档 + 产出文件 + 验收点。目标是"照此清单即可进入编码"。

---

## 0. 前置环境（一次即可）
```
node >=22.19  ✓(本机 node 24)
git 本仓库（docs/design/ 已入库）
webui/ 独立包：package.json(ESM/private) + tsconfig + vitest
npm i @earendil-works/pi-ai@0.85.1 @earendil-works/pi-agent-core@0.85.1
     fastify @fastify/static better-sqlite3 react react-dom
     vite @vitejs/plugin-react antd tailwindcss……（开发依赖）
```
> 参考实现可复用 `.tmp-t/pi-pkgs/node_modules`（已装 pi-ai/pi-agent-core）的 `.d.ts`。

---

## M0 骨架（验收 = 替代 Story Dashboard 的浏览/编辑）

| # | 任务 | 依据规格 | 产出 | 验收点 |
|---|---|---|---|---|
| M0.1 | TS/ESM 工程 + Fastify hello + vitest | — | `webui/package.json`, `server/index.mts`, `vitest.config` | `npm run dev` 起服，`GET /api/health` 200 |
| M0.2 | SQLite 层：建库 + 迁移骨架 | data-model §1/§4 | `server/db/*.ts`, `migrations/0001_init.sql` | 8 张表 + 索引就绪；`user_version=1` |
| M0.3 | books/teardowns CRUD + 文件树 API | api-contract §3.1/§3.2 | `server/routes/books.ts` | curl 建/列/查；`GET /tree` 递归 |
| M0.4 | 文件读/写 + mtime 乐观锁 + 冲突保护 | api-contract §3.3 | `server/fs/index.ts` | 写回 mtime 冲突 → 409 |
| M0.5 | 前端骨架：Vite+React 路由 + 书房/工作台布局 | frontend §2/§3(P0/P3) | `client/` 初始 | 静态线框可浏览 |
| M0.6 | CodeMirror 编辑器 + 草稿 localStorage | frontend §3.3 | `client/components/PageEditor.tsx` | 编辑 demo 章节并保存 |
| M0.7 | 展示 demo 长篇项目（读 demo/长篇） | data-model §2 | 数据接入 | UI 可浏览该书的正文/大纲/设定/追踪 |
| M0.8 | gates runner 框架 + 原 .js spawn 兜底 + migration harness 骨架 | gates-runner | `server/gates/*` | 对 `demo/长篇` 跑 ai-patterns 出结构化报告 |
| **M0 DoD** | — | 前端验收清单 | — | `npm run test`(vitest) 绿；手工过 P0/P3 基本浏览编辑 |

---

## M1 流程引擎闭环（第一段流程）

| # | 任务 | 依据规格 | 产出 | 验收点 |
|---|---|---|---|---|
| M1.1 | 流程定义加载器 + 状态机 + revision | process §2/§6 | `server/engine/definitions.ts`, `engine/state.ts` | 单测：状态转移/revision/幂等 |
| M1.2 | 任务队列 + SSE 事件桥 | api-contract §4 | `server/engine/queue.ts`, `routes/jobs.ts` | SSE 按事件类型下发；断线重连 |
| M1.3 | pi-ai 运行时装配 + 渠道 | agents-runtime §1 | `server/ai/` | 配置 orenica 渠道，`models.getAvailable()` 出模型 |
| M1.4 | Agent + StreamFn 接缝 + 角色模板库 | agents-runtime §2 | `server/agents/` | `story-architect` 一次真实调用出结构化产物 |
| M1.5 | Context 组装器（intake/concept/characters/outline/chapter 首批，含**角色线块** glue） | process §5, agents-runtime §3, character-card-line §4 | `server/agents/contexts/` | 单测各 glue 组装；预算裁剪生效；角色线块注入单项通过 |
| M1.6 | ⭐ 移植一批：tracking-commit / author-memory / normalize-punctuation / write-review-record → TS | gates-runner §3 | `server/gates/impl/*.ts` | `test:gates-migration` 对拍全绿 |
| M1.7 | 流程：intake→concept→characters→outline 全挂门禁 | process §3 | `engine/stageRunner.ts` | UI 逐阶段确认产出大纲（真实模型），门禁报告可见，成本入 jobs |
| M1.8 | 配置页（渠道/角色路由/预算）+ 设置向导 + 冒烟 | api-contract §3.8 | `routes/config.ts`, frontend 设置页 | 增加渠道→测试连通→保存热更新 |
| M1.9 | 每步确认批阅栏 + 门禁卡（前端） | frontend §3.5/§4 | `client/components/ReviewBar.tsx` | 通过/改后重跑/驳回全链路留 audit |
| **M1 DoD** | — | — | — | 新建一本书全流程产出大纲；**无 python 依赖**（`check:no-python` 绿）；e2e(playwright) 走一遍确认 |

---

## 测试策略（贯穿）
| 层 | 方式 | 挂载点 |
|---|---|---|
| 单元 | vitest（engine/contexts/gates 纯逻辑） | `npm test` |
| 契约 | routes 集成：请求→SQLite 断言（better-sqlite3 `:memory:`） | `test:api` |
| gate 对拍 | `test:gates-migration`（Node vs 原版 diff） | `test:gates-migration` |
| AI 冒烟 | 真调 orenica 最小用例（标记 `smoke`，可跳过） | `npm run smoke` |
| e2e | Playwright：新建→向导→看板→编辑器→确认（demo 数据假渠道） | `test:e2e` |
| 运行时门禁 | `check:no-python`：扫 `server/**` 无 `.py`/`.sh` 运行时引用 | CI |

---

## 风险门与回退点
| 检查点 | 条件 | 动作 |
|---|---|---|
| M0.3-4 | 文件 API 冲突保护不稳 | 先只读（浏览）+ 手动 Git 提交兜底，再补写 |
| M1.3 | 渠道连通失败/无 key | 设置向导先走「假渠道(demo)」让全链路前端可开发 |
| M1.7 | 真模型质量不达预期 | 全自动骨架先绿，再按「每步确认」人工兜底质量 |
| M1.6 对拍 | 任一 ⭐ 对拍红 | 不切内联，保留 spawn 原脚本直至修绿；**不作弊降门槛** |

---

## 完成判据（M1 末）
- [ ] `npm run guards`（webui 侧聚合：unit/api/gates-migration/check:no-python）全绿
- [ ] 用 `demo/长篇` 数据 + 假渠道走通完整确认链路（e2e）
- [ ] 真渠道（orenica）新建一本测试书，UI 逐步确认产出大纲，无 Python 运行时
- [ ] 成本/token 可见、预算熔断生效
- [ ] 主案 §14 决策点 5 项已有实施结论
- [ ] `characters` 阶段产出 **角色卡 + 角色线骨架**（设定/角色 + 设定/角色线），前端双视图（卡网格+线看板）可浏览

> **M2 前瞻（角色线主链路）**：`context-chapter` 角色线块常驻 → `role-line-consistency` 门禁上岗（阶段链/进度指针/验收证据，见 gates-runner）+ 卷末写后记账审计回填（character-card-line §5）→ 前端 `RoleStageTable`/`ArcProposalDrawer` 落地。

---

*实施计划 v0.1 —— M0 目标"替代 Story Dashboard"，M1 目标"第一条智能体完整链路开跑"。具体排期以团队/个人节奏为准，任务可按上面表格顺序依赖推进。*

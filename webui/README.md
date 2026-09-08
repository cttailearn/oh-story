# oh-story WebUI「书稿编辑部」

独立的网文流程化写作工具（webui/，随 oh-story 同版发布）。目标：把「能看的书」变成「能写下去的书」—— 流程引擎 + 智能体流水线 + 门禁确定层，全部 Node/TS 实现、**零 Python/bash 运行时依赖**。

- 规格：docs/design/（standalone-webui / process-definition / agents-runtime / gates-runner / api-contract / data-model / importing-existing / export-publish / ops-observability / scale-performance / webui-frontend 等十七篇）
- 技术栈：Node ≥ 22.19 · Fastify + better-sqlite3(WAL) · React 18 + Vite + antd + CodeMirror 6 · pi-ai / pi-agent-core @0.85.x

## 快速开始（开发）
```bash
cd webui
npm install
npm run dev        # 前端 :5173 + 后端 :3081（dev 需 Vite 代理 /api → 3081）
```

生产式运行（构建后单进程托管前后端）：

```bash
npm run build      # 产出 dist/client
npm start -- --port 3081 --root <workspace>
# 默认 workspace = 启动目录；.webui/（webui-config.json + webui.db + backups/ + archive/ + logs/）位于 workspace 下
```

> 首次启动会自动注册 demo 长篇书；渠道未配置时流程可用「假渠道」开发（POST run 传 fake:true）。

## 检查（guards）
```bash
npm install        # npm 11 需先批准原生构建脚本：npm approve-scripts better-sqlite3 esbuild
npm run guards     # typecheck(server+client) + vitest + check:no-python
npm run guards:full  # guards + smoke（起临时后端跑端到端断言）
```

## 真实可靠基线（一键验证，全部断言式、失败即非零退出）

| 命令 | 覆盖 | 断言数 |
|---|---|---|
| `npm run smoke` | 临时 workspace 起真后端 → 假渠道全链路（建书→4 阶段→产物落位→job 生命周期→每步确认→成本/门禁留痕）+ 前端托管自检 | 45 |
| `npm run verify:api` | 全量 REST（books/files/tree/gates/export×5/modules/characters/curves/search/stats/ops/config/ai-edit/import/teardown/软删） | 63 |
| `npm run verify:ui` | 真实 Chromium 打开 9 个页面，断言关键文案 + 零 console/page 错误（截图落 `.tmp-ui-shots/`） | 16 |
| `npm run e2e:fake` | 只跑端到端断言（需已有后端；`--base` 指定地址） | 45 |

> `verify:api` / `verify:ui` 需要后端已启动（`npm start`）且已 `npm run build`；`verify:ui` 需仓库根已装 playwright（`npx playwright install chromium`）。

### 引擎硬约束（回归测试覆盖，勿回退）

- **job 必须落终态**：`queued → running → review | done | error | killed`。跑完不落终态会让成本面板恒为 0、`health.depth=full` 永远报挂起、重启自愈把已完成任务误标 killed；且 `idx_jobs_busy` 部分唯一索引会让同阶段重跑**整行替换**上一条 job（历史被静默抹除）。见 `server/engine/jobLifecycle.test.ts`。
- **review 只属于「已产出产物」的阶段**：确认通过后不得把从未运行的后续阶段置为 review，否则批阅栏能放行空阶段（假流程）。
- **假渠道产物按 file-set 契约落位**：`设定/角色/*.md`、`大纲/细纲/第NNN章.md` 等，使 demo e2e 真实覆盖分块与门禁口径；fake 产物模板按**阶段 id** 选择，不依赖上下文块标题启发式。
- **demo 结果必须可辨识**：无渠道时 ai-edit 降级 demo，响应带 `fake: true` + 文案标注，前端加橙色标记并要求二次确认。

## 诊断 / 运维（ops）

| 命令 | 说明 |
|---|---|
| `npm run diag [-- --book <id>]` | 健康深检（db 字节/门禁量/挂起任务/渠道/24h 成本），可选对书跑 ai-patterns 冒烟 |
| `npm run trace -- --job <job_id>` | 追踪单次任务的事件序列（门禁/审计/耗时/成本） |
| `npm run backup` / `npm run snapshot` | 每日备份（保留 7 份）/ 升级前快照，VACUUM INTO 落 `.webui/backups/` |
| 设置页 → 运维 | 诊断卡片 / 门禁统计 / 审计筛选+CSV 导出 / 一键备份维护 / relink 恢复 / 任务 kill |

数据自愈：启动时 running/queued 任务置 `killed(restart-recovery)`；删除书 = 软删（目录移入 `workspace/_archive/`，可 relink 找回）；`gate_runs` 冷数据（>3 个月）按季度归档；每日自动维护（PRAGMA optimize + wal_checkpoint）。

## 升级三步（备份 → 替换 → 启动）

1. **备份**：`npm run snapshot`（或设置页「升级前快照」），确认 `.webui/backups/snapshot_*.db`。
2. **替换**：用新版本覆盖/替换 `webui/`（保留 workspace 下 `.webui/` 与他人书目录；`webui/dist/` 重新 build）。
3. **启动**：`npm start`；schema 迁移按 `PRAGMA user_version` 自动执行（`server/db/migrations/*.sql`），升级日志写 `.webui/upgrade.log`。

若 `books.dir` 对不上（如目录被移动/恢复）：设置页 → 运维 → relink，填相对目录（校验 `_tracking-state.json`）。

## 发布 / 单文件打包

`webui/` 已纳入仓库（`git add webui`）。可选把后端打成单文件可执行（Node SEA / pkg）：

```bash
npm run pack:standalone     # 生成 dist/standalone/* + sea-config.json + 说明
```

SEA 完整产物需本机 Node 二进制注入工具（postject）；`scripts/build-standalone.mjs` 产出 bundle 与配置并给出后续步骤（pkg 打包同理）。

## 目录速览

```
webui/
├── server/
│   ├── index.mts          # Fastify 入口（127.0.0.1）
│   ├── db/                # better-sqlite3 + migrations (user_version)
│   ├── config/            # webui-config.json（密钥唯一明文）
│   ├── engine/            # 流程定义解释器 + 状态机 + stageRunner（内循环重试）
│   ├── agents/            # pi-agent-core 装配 + Context + ai-edit
│   ├── gates/             # 门禁适配器（Node 移植内联 + 原 .js spawn 兜底）
│   ├── import/            # 已有小说导入 + 导入校对（fail-closed 解锁）
│   ├── export/            # md/txt/zip/excel/epub 导出
│   ├── ops/               # 诊断/统计/审计CSV/备份/归档/relink/kill
│   ├── util/              # 零依赖 zip/xlsx/epub 写入器
│   └── routes/            # REST + SSE
├── client/src/            # React SPA（书房/工作台/流程看板/导入校对/模块库/拆文/导出/设置）
└── scripts/               # check-no-python / diag / trace / backup
```

## 主要功能（对齐 M0–M4 里程碑）

- M0 骨架：书房 / 文件树 / CodeMirror 编辑（mtime 乐观锁）/ 门禁骨架
- M1 流程引擎闭环：intake→concept→characters→outline 全挂门禁、每步确认（approve/edit_rerun/reject/skip）、成本与门禁可见
- M2 章节主链路：chapter 批处理 + 三查记录 + tracking-commit、角色线（卡+线看板+AI 提议）、关键词 RAG
- M3 兜底与交付：review/deslop/image 阶段、导出（md/txt 平台/分卷 zip）、AI 编辑抽屉
- M4 打磨：story-import 完整移植 + 导入校对页（置信度模型/fail-closed 解锁）、门禁历史/成本/审计 CSV、health?depth=full、每日备份/归档/relink/软删/kill、epub/Excel 导出、诊断脚本

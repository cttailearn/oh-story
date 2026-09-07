# oh-story WebUI ——「书稿编辑部」

独立的 WebUI 网文写作工具（前后端分离，仅绑定 `127.0.0.1`）。设计见 `docs/design/standalone-webui.md`（主案 v0.8）、`webui-frontend.md`（前端「书稿编辑部」）、`implementation-plan.md`（M0/M1 WBS）。

## 状态

**当前：M0 骨架已落地** —— 可浏览/编辑 `demo/长篇`，替代 Story Dashboard。

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | TS/ESM + Fastify + SQLite + 文件树/读写(mtime 锁) + 前端线框(书房/工作台/编辑器/追踪看板/流程看板) + gates runner(spawn 兜底) | ✅ 本分支 |
| M1 | 流程引擎/状态机/SSE/pi-ai 接线/Node 化移植/tracking-commit | ⏳ 待开发 |

## 快速开始

```bash
cd webui
npm install            # 需可运行 postinstall（esbuild/better-sqlite3 原生绑定）
npm run dev            # 同时起后端(3081) + Vite 前端(5173, /api 代理)
# 或生产模式：
npm run build          # vite build → dist/client
npm start              # node server/index.mts --port 3081 --root <workspace>，直接提供页面
```

- 首次启动自动注册 `demo/长篇` 为书（书库为空时）。
- 数据目录 `<workspace>/.webui/`：`webui.db`（SQLite）+ `webui-config.json`（渠道/密钥，已 gitignore）。
- 运行环境：Node ≥ 22.19（本机检验 v24）。

## 命令

| 命令 | 说明 |
|---|---|
| `npm run dev` | 后端 3081 + Vite 5173 并行（HMR） |
| `npm run start` | 生产：一个进程服务 API + 构建后前端 |
| `npm run build` | 构建前端到 `dist/client` |
| `npm run typecheck` | tsc 双端 noEmit |
| `npm test` | vitest（db/fs/gates harness） |
| `npm run test:gates-migration` | 门禁 Node 移植对拍（M1 起逐项启用） |
| `npm run check:no-python` | 扫 server 源码零 Python/bash 运行时引用 |
| `npm run guards` | typecheck + test + check:no-python 聚合门禁 |

## 目录结构

```
webui/
├── server/
│   ├── index.mts          # Fastify 入口（静态托管 + 路由 + demo 注册）
│   ├── db/                # better-sqlite3 + migrations/0001_init.sql
│   ├── config/            # webui-config.json（渠道/预算/偏好，密钥 0600）
│   ├── fs/                # 路径安全 + mtime 乐观锁 + 文件树
│   ├── routes/            # books/files/tree/tracking/config/stages/jobs/audit/gates
│   └── gates/             # 门禁框架（types/runner/spawn 兜底/registry）+ 迁移对拍
└── client/                # React 18 + Vite + CodeMirror 6（书稿编辑部设计令牌）
    ├── src/pages/         # 书房 P0 / 新建向导 P1 / 工作台 P3 / 流程 P4 / 设置 P6
    ├── src/components/    # PageEditor / GateReportCard / TrackingBoard
    └── src/styles/        # tokens.css（晴窗纸/灯下稿） + layout.css
```

## 测试

- 单测：`npm test`（db 建库/唯一索引、fs 路径穿越/mtime 冲突、gates harness 对 demo 跑 ai-patterns）
- 集成手验：`node scripts/verify-api.mjs`（mtime 409 / 写 / 门禁）
- 页面手验：`node scripts/verify-ui.mjs`（Playwright 截图 + 0 控制台错误）

## 说明（设计约束实现状态）

- **零 Python 依赖**：`check:no-python` 绿。`tracking_commit`/`author_memory_commit` 的 Node 版属 M1 ⭐ 移植项。
- **门禁**：M0 用原 `.js` 脚本 spawn 兜底（`check-ai-patterns.js` 等，产出结构化报告）；M1 逐项内联 TS + 对拍。
- **每步确认**：前端批阅栏（通过/改后重跑/驳回/跳过）已就位，引擎状态机（真调用模型）在 M1。

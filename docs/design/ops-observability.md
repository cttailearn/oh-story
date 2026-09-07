# oh-story WebUI 运维与可观测性（单机，v0.1）

> 单机产品也要"出问题能查、坏了能救"。本文给：**日志 → 诊断 → 审计 → 备份/恢复 SOP → 升级路径**。不引外部栈（无 ELK/Prometheus），一切落在本地文件 + SQLite + 一次性脚本。

---

## 1. 日志（`<workspace>/.webui/logs/`）
| 文件 | 内容 | 轮转 |
|---|---|---|
| `server.log` | 结构化 JSON 行：`{ts, level, ev, job?, book?, stage?, ms, cost?}` | 按 5MB + 保留 10 份 |
| `ai.log` | 每次模型调用的 `model/tokens/status/error`（**无 prompt 正文，无 key**） | 同上 |
| `gate.log` | 每次 gate 的 `gate/revision/ok/ran_ms`；blocking 明细 | 同上 |
| `error.log` | 栈 + trace_id | 保留 30 份 |
- **铁律**：日志绝不含 apiKey/完整正文；debug 级才可含 prompt 摘要（默认 info）。

---

## 2. 诊断
- `GET /api/health?depth=full`（见 scale-performance §6）：
```json
{ "ok": true, "version": "0.1.0", "node": "24.19.0", "python_dep_free": true,
  "db": { "bytes": 8388608, "gate_runs": 14200, "jobs_pending": 0 },
  "channels": [ { "id": "orenica", "configured": true, "tested_at": "…" } ],
  "ctx_cache": { "hit": 0.92, "entries": 41 },
  "perf": { "last_gate_ms_p95": 412, "ai_calls_24h": 381, "cost_24h_cents": 156.2 } }
```
- **`npm run diag`**（一次性）：起临时实例跑一轮骨架 `intake`（假渠道）+ 一次 `ai-patterns` gate + 一次 `tracking-commit` dry-run，输出耗时/错误摘要 → 快速定位"是模型、是门禁、还是环境"。
- **追踪单次任务**：`npm run trace -- --book nb_02K --stage chapter --job job_09Q` 打印该 job 的完整事件序列（queue→agent→gates→commit）与每段耗时/成本。

---

## 3. 审计查询（WebUI「设置→审计」+ 直接 SQL）
- 表 `audit` 全量保留；界面按 `action/target/时间` 筛选/导出 CSV。
- 常用 SQL（调试时可直接跑 better-sqlite3）：
```sql
-- 每步确认的人类留痕
SELECT ts, action, target, detail_json FROM audit
WHERE action IN ('approve','edit_rerun','reject','skip','rollback') ORDER BY ts DESC LIMIT 50;
-- 单书成本合计
SELECT book_id, ROUND(SUM(cost_cents),2) AS cents, SUM(tokens_in), SUM(tokens_out)
FROM jobs WHERE book_id='nb_02K' GROUP BY book_id;
-- blocked 频率（门禁体检）
SELECT gate, COUNT(*) AS fails FROM gate_runs WHERE ok=0 GROUP BY gate ORDER BY fails DESC;
```

---

## 4. 备份 / 恢复 SOP
| 场景 | 操作 |
|---|---|
| 日常备份 | 每日自动 `webui.db` → `VACUUM INTO .webui/backups/daily_YYYYMMDD.db`（保留 7 份）+ 书目录由 git/网盘覆盖 |
| 升级前 | 手动「一键快照」两者都做 |
| 目录丢失 | 重克隆/恢复目录 → 写 `books.dir` 对不上时，`POST /api/books/:id/relink {dir}`（校验 `_tracking-state.json` 存在） |
| 库损坏 | 恢复最近快照；书稿（文件）不受影响，重建库后按目录重新挂载 |
| 误删书 | `DELETE` 只移 `_archive/`，从 `_archive/` 改回目录 + `relink` |

---

## 5. 故障自愈（单机尽力而为）
- **启动**：`stages` 中 running 一律复位 review（§process §6）；`jobs` 中 running/queued → `killed` 并记 `error='restart-recovery'`。
- **任务卡死**：job 心跳超过 5min 无更新 → 引擎标记 `stalled`，可手动 kill（`POST /jobs/:id/kill`）重跑。
- **端口占用**：启动前探测 3081，占用则提示 `--port` 或自动 +1 并在终端告知实际 URL。
- **崩溃**：进程管理器可选（`pm2`/`node --watch` 或系统计划任务拉起），核心是**幂等 + 恢复先于一切**（数据在文件系统，重跑可恢复）。

---

## 6. 升级路径（webui 与 oh-story 包同版）
```
webui/ 发布 → 迁移链按序执行:
  1) 备份（§4）
  2) schema 迁移 PRAGMA user_version（data-model §4）
  3) process 版本迁移（stage 映射，process §6）
  4) 门禁 Node 化对拍（gates-runner §3）——若新版本引入新 node 化项，先跑 test:gates-migration
  5) 冒烟：health full + 一次假渠道骨架
```
- 升级日志写入 `.webui/upgrade.log`；失败自动回滚到「升级前快照」。
- 文档：README(WebUI) 说明备份→替换→启动三步。

---

*运维 v0.1 —— M0 建日志/健康；M4 补 diag/snapshot/升级链。单机不追求高可用，追求「查得清、救得回」。*

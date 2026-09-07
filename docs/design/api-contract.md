# oh-story WebUI API 契约（v0.1）

> 配套 [`standalone-webui.md`](standalone-webui.md)（主案）第九章。实现级规格：端点、请求/响应 JSON 示例、SSE 事件、错误码。前端仅消费本契约。

---

## 1. 通用约定
- **Base URL**：`http://127.0.0.1:<port>/api`（服务默认仅绑定回环）。
- **认证**：可选 `Authorization: Bearer <token>`（`webui-config.json` 未设 token 时可为空）。
- **内容类型**：`application/json; charset=utf-8`。
- **时间**：ISO-8601 UTC（`2026-09-07T01:29:00.000Z`）。
- **分页**：`?offset=0&limit=50`（limit≤200）；响应带 `{ total, offset, limit }`。
- **幂等**：写操作（`run`/`review`/`ai-edit`/`import`）接受 `Idempotency-Key` 头，重复请求返回既有结果。
- **错误封装**：
```json
{ "error": { "code": "STAGE_NOT_FOUND", "message": "…", "detail": {} } }
```

---

## 2. 端点总表

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/books` | 项目列表 / 新建 |
| GET | `/books/:id` | 项目 meta + 流程缩略 |
| PUT | `/books/:id` | 改名/改主题色 |
| DELETE | `/books/:id` | 删除（确认后：库记录 + 目录移入 `_archive/`，不硬删） |
| POST | `/import` | 导入已有小说（解析→追踪状态→书） |
| GET | `/books/:id/tree?path=` | 文件树快照 |
| GET/PUT | `/files?path=` / `/files` | 读/改写（带 mtime 乐观锁） |
| GET | `/books/:id/stages` | 管线视图 |
| GET | `/books/:id/stages/:stage` | 单个阶段（产物 + 最新门禁） |
| POST | `/books/:id/stages/:stage/run` | 发起执行 → jobId |
| POST | `/books/:id/stages/:stage/review` | 每步确认 |
| POST | `/books/:id/stages/:stage/rollback` | 回退到该阶段 |
| GET | `/jobs` · `GET /jobs/:id` | 任务列表 / 详情 |
| GET | `/books/:id/jobs/events` | SSE 事件流 |
| GET | `/books/:id/tracking` | 追踪状态投影（只读） |
| POST | `/books/:id/ai-edit` | AI 需求式编辑 |
| GET | `/modules?kind&tag&usable_for&source&sort` | 模块库列表（项目级/全局） |
| GET/PUT/DELETE | `/modules/:id` | 模块详情 / 编辑(tags,摘要,正文) / 软删 |
| POST | `/books/:id/modules/archive` | 拆文批量入库（单元列表 → SSE 进度） |
| POST | `/books/:id/modules/recommend` | 新书向导按 {genre,kinds} 推荐模块 |
| POST | `/novels/:id/modules/attach` | 注入模块到书 → 影响预估 + 生效 |
| GET | `/books/:id/characters` | 角色卡列表（含红线计数/关联角色线） |
| GET/PUT | `/books/:id/characters/:name/arc` | 角色线：阶段/进度指针/审计（读/推进·写线文件+audit） |
| POST | `/books/:id/characters/:name/arc/propose` | AI 提议下阶段（architect→diff 草案→人工采纳） |
| GET | `/books/:id/curves/emotion` · `/curves/rhythm` | 情绪曲线 / 节奏条带数据（`{x,series,markers}`） |
| GET | `/books/:id/cost` | 成本仪表（日/月/按阶段/按模型/曲线） |
| GET | `/api/search?q=` | 全局搜索（正文/角色/伏笔/设定/大纲，带命中片段） |
| POST | `/books/:id/export` | 交付导出 |
| GET/PUT | `/config` | 配置（渠道/路由/偏好/预算） |
| POST | `/config/channels/:id/test` | 渠道连通性自检 |
| GET | `/health` | 存活 + 版本 + 无 Python 依赖门禁结果 |

---

## 3. 关键端点契约（JSON 示例）

### 3.1 新建项目 `POST /books`
```jsonc
// req
{ "name": "我的第一部长篇", "type": "novel-project", "theme_color": "#B8860B", "initial_novel": { /* 走 novels/new 同参 */ } }
```
```jsonc
// 200
{ "id": "bk_01H", "name": "我的第一部长篇", "dir": "D:\\AI\\oh-story\\我的第一部长篇",
  "pipeline": "long", "active_stage": "concept", "created_at": "…", "books": [], "teardowns": [] }
```

### 3.2 新建小说（需求录入）`POST /books/:id/novels`（骨架 + 从 intake 起跑）
```jsonc
// req
{ "novel_name": "让你管账号，你高燃混剪炸全网",
  "intake": { "genre": ["都市系统流"], "kind": "long", "target_words": 200000,
              "platform_style": "番茄", "idea": "重生军宣新人把废号做成顶流",
              "golden_finger": ["短视频爆款预知", "天王唱功"], "keywords": ["爽文","追妻火葬场"] } }
// 202
{ "book_id": "nb_02K", "job_id": "job_09Q", "stage": "concept", "pipeline": "long" }
```

### 3.3 发起阶段执行 `POST /books/:id/stages/:stage/run`
```jsonc
// req（可携带局部入参）
{ "chapters": ["第021章"], "note": "补第21章细纲后写正文" }
// 200
{ "job_id": "job_09Q", "stage": "chapter", "revision": 3, "status": "running" }
```

### 3.4 每步确认 `POST /books/:id/stages/:stage/review`
```jsonc
// req
{ "action": "edit_rerun",            // approve|edit_rerun|reject_regen|skip
  "note": "结局钩子弱，改强一点",
  "edits": { "大纲/细纲/第021章.md": "# 重写第21章细纲…" } }   // edit_rerun 时附修改
// 200
{ "stage": "outline", "status": "running", "next": "characters", "audit_id": "au_77" }
```

### 3.5 阶段详情 `GET /books/:id/stages/:stage`
```jsonc
// 200
{ "stage": "chapters", "status": "review", "revision": 3,
  "artifacts": [ { "path": "正文/第021章_老兵的故事.md", "size": 5321, "checksum": "…" } ],
  "latest_gates": {
    "char-count":        { "ok": true,  "value": 2410, "blocking": [], "warnings": [] },
    "ai-patterns":       { "ok": true,  "blocking": [], "warnings": [ { "rule": "过度口语省略", "evidence": "第12段", "level": "warning" } ] },
    "chapter-consistency": { "ok": true, "blocking": [], "warnings": [] },
    "tracking-commit":   { "ok": true,  "blocking": [], "warnings": [], "commit": { "last_committed_chapter": 21 } }
  },
  "cost": { "total_cents": 4.2, "tokens_in": 98200, "tokens_out": 24050 } }
```

### 3.6 追踪状态投影 `GET /books/:id/tracking`
```jsonc
// 200（只读投影，写路径仅 tracking-commit）
{ "book_title": "…", "last_committed_chapter": 21, "schema_version": 4,
  "position": { "scene": "…", "story_time": "…", "volume": "第一卷·军宣整顿(候选)" },
  "characters": [ { "name": "江晨", "state": "…", "goal": "…", "open_threads": 6, "location": "…" } ],
  "foreshadow":  [ { "id": "F054", "status": "已埋", "importance": "高", "planted": 20, "due": null, "due_within": 2 } ],
  "timeline":    [ { "id": "E013", "reveal_status": "未揭示", "story_time": "…" } ],
  "risks": [ "第一卷卷界仍是候选…" ], "next_commitment": "先补第21章细纲…" }
```
> `due_within`：应揭示章节与当前章的差距 ≤2 时由后端计算并返回，前端据此浮签提醒。

### 3.7 AI 需求式编辑 `POST /books/:id/ai-edit`
```jsonc
// req
{ "target": { "path": "正文/第021章_老兵的故事.md", "range": { "start": 120, "end": 145 } },
  "demand": { "kind": "hook", "custom": "把结尾改成悬念反问：老兵的故事从哪里说起？" },
  "model_role": "writer", "tone": "口语化", "intensity": 0.7 }
// 202 → SSE（同一 jobs/events 通道出 diff 流）
// 终态产物
{ "edit_id": "ed_5", "diff": [ { "type": "del", "line": 121, "text": "…" }, { "type": "add", "line": 121, "text": "…" } ],
  "applied": false, "cost_cents": 1.2 }
```
> `applied:false` → 前端展示 diff，用户「应用」再调 `PUT /files` 落 revision + 可选触发门禁。

### 3.8 渠道连通性 `POST /config/channels/:id/test`
```jsonc
// 200
{ "ok": true, "llm": { "models": 5, "ping_ms": 312 }, "images": { "ok": true, "model": "gpt-image-2" },
  "msg": "渠道可用（5 模型）" }
```

### 3.9 导出 `POST /books/:id/export`
```jsonc
{ "format": "markdown", "include": ["chapters", "outline"], "target": "交付/《…》md 打包.zip" }
```

### 3.10 模块库（拆文→新书复用）
```jsonc
// 拆文批量入库 POST /books/:id/modules/archive
// req
{ "teardown_id": "td_0T3", "units": [
    { "kind": "plot", "title": "越级打脸三连", "body": "弱者挑衅→碾压→围观反转→爽点结算",
      "tags": ["爽文","打脸"], "usable_for": ["都市系统流"], "source_path": "剧情/情节点.md" } ],
  "batch_tags": ["都市系统流"] }
// 202 → SSE module:archived（逐条）→ 终态
{ "ok": true, "created": 12, "skipped_existing": 1, "module_ids": ["md_01…"] }

// 推荐 POST /books/:id/modules/recommend
// req { "genre": "都市系统流", "kinds": ["plot","hook"] }
// 200 { "items": [ { "module_id": "md_07", "score": 0.93, "reason": "题材匹配+本周常用" } ] }

// 注入 POST /novels/:id/modules/attach
// req { "module_ids": ["md_07","md_12"], "scope": "outline" }
// 200 { "attached": 2, "impact": { "glue": ["context-outline"], "knowledge_blocks": 2, "tokens_est": 1480 },
//        "annotate": "细纲头注释 <!-- 参考模块: md_07 -->" }
```

### 3.11 角色卡 / 角色线（character-card-line）
```jsonc
// 推进角色线阶段 PUT /books/:id/characters/:name/arc
// req
{ "action": "advance", "to_stage": 2, "to_status": "done",
  "acceptance_done": ["第6章 默许帮忙"], "note": "阶段1验收通过" }
// 200
{ "ok": true, "arc": { "current_stage": 2, "status": "active", "audit": "pending(卷末回填)" }, "audit_id": "au_81" }

// AI 提议下阶段 POST /books/:id/characters/:name/arc/propose
// req { "at_stage": 2, "hint": "第30章困境：沈栀被迫独行" }
// 200 { "proposal": { "stage_no": 3, "target_3layer": {...}, "acceptance": "...", "gradient": ["第31章…"] },
//        "diff": [...], "applied": false }   // 采纳后再 PUT /arc
```

### 3.12 图表 / 成本 / 搜索（webui-frontend §10 数据源）
```jsonc
// 情绪曲线 GET /books/:id/curves/emotion
{ "x": [1,2,3], "series": [ { "name": "情绪", "data": [1.2, -0.5, 2.3] } ],
  "markers": [ { "chap": 3, "label": "爽点", "flag": "🚩" } ] }
// 成本仪表 GET /books/:id/cost
{ "day_cents": 32, "month_cents": 156, "budget_month_cents": 1000,
  "by_stage": { "chapter": 120 }, "by_model": { "deepseek-v4-pro": 140 },
  "curve": [ { "date": "2026-09-01", "cents": 12 } ] }
// 全局搜索 GET /api/search?q=江晨
{ "results": { "chapters": [ { "path": "正文/第003章…", "snippet": "…<mark>江晨</mark>…" } ],
               "characters": [...], "foreshadow": [...], "settings": [...], "outline": [...] } }
```

---

## 4. SSE 事件流 `GET /books/:id/jobs/events`（`text/event-stream`）

| event | data（JSON） | 前端行为 |
|---|---|---|
| `job:start` | `{ jobId, stage, revision }` | 阶段卡点亮 running |
| `job:progress` | `{ jobId, phase, percent?, text? }` | 运行流里显示"墨迹"文本 / 进度 |
| `gate:batch` | `{ jobId, gate, ok, blocking[], warnings[] }` | 门禁逐个落卡 |
| `job:review` | `{ jobId, stage, revision, latest_gates, cost }` | 唤起批阅栏 + 产物预览 |
| `edit:diff` | `{ editId, diff[] }` | AI 编辑抽屉 diff 流式展开 |
| `module:archived` | `{ moduleId, title, created|updated }` | 入库逐个盖章，模块库计数 +1 |
| `module:attached` | `{ novelId, moduleIds[], tokens_est }` | 注入生效，RefBadge 呈现 |
| `job:error` | `{ jobId, code, message }` | 浮签（朱批式） |
| `heartbeat` | `{ ts }` | 保活（每 25s） |

```
事件行格式：
event: job:start
data: {"jobId":"job_09Q","stage":"chapter","revision":3}
```
- 前端用 `EventSource`（GET SSE 天然支持）；断线由 `Last-Event-ID` 重放心跳后全量刷新 `GET /jobs/:id`。
- 兼容：无 EventSource 时降级轮询 `GET /jobs/:id?since=…`（返回增量事件数组）。

---

## 5. 错误码
| code | HTTP | 场景 |
|---|---|---|
| `AUTH_REQUIRED` | 401 | 未带 / 错 token |
| `NOT_FOUND` | 404 | 书/阶段/文件不存在 |
| `CONFLICT` | 409 | 文件已被外部修改（mtime 不符） |
| `STAGE_BUSY` | 409 | 该 stage 已有 running job |
| `GATE_BLOCKING` | 422 | review 不可 approve（blocking 未清） |
| `CHANNEL_UNCONFIGURED` | 503 | 无可用渠道 |
| `BUDGET_EXCEEDED` | 429 | 阶段/会话预算熔断 |
| `INVALID_INPUT` | 400 | 字段校验失败，`detail` 给出字段级错误 |
| `INTERNAL` | 500 | 未预期错误（含日志 trace_id） |

---

*API 契约 v0.1 —— 实现以本文为验收基线；后端 `webui/server/routes/` 与前端 `webui/client/api/` 双端以本契约对拍。*

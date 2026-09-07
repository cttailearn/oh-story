# oh-story WebUI 数据模型与存储（v0.1）

> 配套 [`standalone-webui.md`](standalone-webui.md)（主案）第八章。实现级规格：**SQLite DDL / 文件系统约束 / 配置文档 / 备份迁移**。

**分层原则**：
- **内容真相 → 文件系统**（标准书目录结构，与 CLI skill 双向兼容）。
- **过程真相 → SQLite**（任务/门禁/审计/成本），可整体删除重建而不影响书稿。
- **配置/密钥 → webui-config.json**（0600）。

---

## 1. SQLite 建表 DDL（`webui.db`）

```sql
PRAGMA journal_mode = WAL;           -- 并发读写友好
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS books (
  id            TEXT PRIMARY KEY,             -- bk_<ulid>
  name          TEXT NOT NULL,
  dir           TEXT NOT NULL UNIQUE,         -- 规范化绝对路径
  kind          TEXT NOT NULL CHECK(kind IN ('novel-project','novel','teardown')),
  pipeline_id   TEXT,                         -- 'long'|'short'（novel 才有）
  pipeline_version INTEGER,
  theme_color   TEXT,
  active_stage  TEXT,
  meta_json     TEXT,                         -- 需求卡/导入信息
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stages (
  book_id     TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  stage_id    TEXT NOT NULL,
  status      TEXT NOT NULL CHECK(status IN ('pending','running','review','blocked','done','skipped')),
  revision    INTEGER NOT NULL DEFAULT 0,
  started_at  TEXT,
  reviewed_at TEXT,
  note        TEXT,
  PRIMARY KEY (book_id, stage_id)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id    TEXT NOT NULL,
  stage_id   TEXT NOT NULL,
  revision   INTEGER NOT NULL,
  path       TEXT NOT NULL,
  kind       TEXT NOT NULL,                   -- file/image/record
  size       INTEGER,
  checksum   TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_artifacts_unq ON artifacts(book_id, stage_id, revision, path);

CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,             -- job_<ulid>
  book_id       TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  stage_id      TEXT NOT NULL,
  kind          TEXT NOT NULL,                -- stage|ai-edit|import|export
  revision      INTEGER,
  status        TEXT NOT NULL CHECK(status IN ('queued','running','review','done','error','killed')),
  progress      INTEGER NOT NULL DEFAULT 0,
  cost_cents    REAL NOT NULL DEFAULT 0,
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  detail_json   TEXT,
  idempotency_key TEXT UNIQUE,
  created_at    TEXT NOT NULL,
  finished_at   TEXT
);
CREATE UNIQUE INDEX idx_jobs_busy ON jobs(book_id, stage_id) WHERE status IN ('queued','running');

CREATE TABLE IF NOT EXISTS gate_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id     TEXT NOT NULL,
  stage_id    TEXT NOT NULL,
  revision    INTEGER NOT NULL,
  job_id      TEXT,
  gate        TEXT NOT NULL,
  ok          INTEGER NOT NULL,               -- 0/1
  blocking_json  TEXT NOT NULL DEFAULT '[]',
  warnings_json  TEXT NOT NULL DEFAULT '[]',
  detail_json    TEXT,
  ran_ms      INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_gates_lookup ON gate_runs(book_id, stage_id, revision);

CREATE TABLE IF NOT EXISTS channels (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  base_url   TEXT NOT NULL,
  model_ids  TEXT NOT NULL DEFAULT '[]',      -- JSON 数组（渠道模型目录；密钥不在此表进）
  enabled    INTEGER NOT NULL DEFAULT 1,
  api        TEXT NOT NULL DEFAULT 'openai-completions',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL,
  who       TEXT NOT NULL DEFAULT 'user',     -- user|engine|agent:<role>
  action    TEXT NOT NULL,                    -- run|approve|edit_rerun|reject|skip|rollback|ai-edit|import|delete
  target    TEXT NOT NULL,                    -- 形如 book:nb_02K/stage:chapter/rev:3
  detail_json TEXT
);
CREATE INDEX idx_audit_ts ON audit(ts);
CREATE INDEX idx_audit_target ON audit(target);
```

要点：
- `idx_jobs_busy`（部分唯一索引）= 同书同阶段并发控制的数据库层保证（幂等见 api-contract `Idempotency-Key`）。
- WAL + `foreign_keys=ON`（better-sqlite3 每次连接打开）。
- `gate_runs` 每次门禁执行一行 → 门禁历史/趋势视图直接可查。

---

## 2. 文件系统约束（内容真相）

```
{项目}/
├── AGENTS.md                 ← 建库时由 setup 等效生成（路由 + 约定）
├── .story-deployed           ← agents_version / deployed_at
├── .active-book
├── 小说/                      ← 长/短篇书目录
│   └── {书名}/
│       ├── 正文/第%03d章_标题.md
│       ├── 大纲/{大纲.md, 卷纲/, 细纲/, 审查记录/}
│       ├── 设定/{题材定位.md, 文风.md, 关系.md, 世界观/, 角色/, 角色线/}
│       │      └── 角色线/{名}.md ← 弧线规划（阶段状态机/验收/审计）；契约三态见 character-card-line §2.3
│       ├── 追踪/_tracking-state.json   ← 唯一权威（schema_version 4）
│       └── .story/作者记忆/             （author_memory_commit Node 版数据）
└── 拆文库/{书名}/             ← 拆文工作台数据（角色/设定/剧情模块/章节摘要…）
```

### 2.1 追踪状态约束（`_tracking-state.json`）
- 顶层字段对齐现有 `schema_version: 4`：`characters / context / foreshadow / timeline / imported_through_chapter / last_committed_chapter / state_revision`。
- **角色线深化**：弧线分「内在/外在/关系」三层，「阶段状态机 / 渐变证据 / 弧线审计」四套方案见 [character-line-management.md](character-line-management.md)；落地不破坏 `_tracking-state.json` 唯一权威（角色线文件作为派生视图，取值仍以角色卡 + 追踪快照为准）。
- **唯一写路径**：`tracking-commit.ts`（Node 化）事务提交；WebUI 任何界面不得直写（AI 编辑/正文编辑只写正文文件 → 之后再走 commit）。
- `state_revision` 每次 commit +1；读取端按 `last_committed_chapter` 判定进度。
- 文件命名与章节编号严格零填充（`第001章`）；check-chapter-consistency 校验编号/星期/倒计时硬事实。

### 2.2 书结构校验
`check-project-consistency.ts`（Node 化）为结构守门人，流水线在 `setup/outline/review` 各 scope 校验；`demo/长篇/` 即为基准样例（20 章细纲+正文）。

---

## 3. 配置文件 `webui-config.json`（单机；权限 0600/NTFS ACL）

```jsonc
{
  "version": 1,
  "node_engine_min": "22.19.0",
  "access_token": "<可选>",
  "workspace": "D:\\AI\\oh-story",       // --root 默认
  "pipeline_ref": { "id": "long", "version": 1 },
  "channels": [
    { "id": "orenica", "name": "orenica", "base_url": "https://api.oreniva.com/v1",
      "api_key": "sk-…",                 // 唯一明文落点；表 channels 不存 key
      "models": ["gpt-image-2", "deepseek-v4-pro", "deepseek-v4-flash"],
      "image_models": ["gpt-image-2"] }
  ],
  "model_routing": {
    "writer":   { "channel": "orenica", "model": "deepseek-v4-pro" },
    "architect":{ "channel": "orenica", "model": "deepseek-v4-pro" },
    "designer": { "channel": "orenica", "model": "deepseek-v4-pro" },
    "checker":  { "channel": "orenica", "model": "deepseek-v4-flash" },
    "researcher":{ "channel": "orenica", "model": "deepseek-v4-flash" },
    "explorer": { "channel": "orenica", "model": "deepseek-v4-flash" }
  },
  "budget": {
    "stage_max_cents": 200, "daily_max_cents": 1000,
    "chapter_max_tokens_out": 6000, "context_max_tokens_in": 26000
  },
  "prefs": { "deslop_level": "medium", "theme": "day", "confirm_required": true }
}
```
- 运行时内存中与 `channels` 同步的 pi-ai `createModels`/`createProvider` 由 `server/ai/` 持有；`GET/PUT /api/config` 落盘即热更新（provider 重建）。
- 密钥仅此一处明文；导出/备份时默认排除或提示（可在备份时加密）。

---

## 4. webui.db 生命周期 / 备份 / 迁移

- **位置**：`<workspace>/.webui/webui.db`（`--root` 下隐藏目录，与书稿同盘）。
- **备份策略**（个人单机）：
  - 每日自动 + 手动「一键快照」：`{webui.db + webui.db-wal/shm}` 用 `VACUUM INTO` 生成单文件快照，与目录 `_archive/` 同目录可恢复。
  - 书稿本身即文件系统 → 用户常规 git/网盘备份即覆盖内容真相。
- **恢复**：快照文件放回原路径即可（`VACUUM INTO` 保证一致性）；书目录单独恢复时以 `book.dir` 重建映射。
- **schema 迁移**：`webui/server/db/migrations/*.sql` 顺序编号；启动时 `PRAGMA user_version` 对比执行，先备份再迁移。
- **process 版本迁移**：`pipeline_version` 与 `PROCESS_DEF_VERSION` 不符时 → 把旧 version 的 stages 状态按 id 映射到新定义（增补 stage 置 pending、删除 stage 置 skipped + audit），提示用户在 WebUI 复核。
- **清理**：`DELETE /books/:id` 将目录移入 `_archive/`（非硬删）+ 级联清 DB；审计记录保留。

---

*数据模型 v0.1 —— 以 `webui/server/db/` 落地；`_tracking-state.json` 与 CLI 技能 schema 以现有实现为权威（schema_version 4 对齐）。*

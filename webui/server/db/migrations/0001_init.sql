-- oh-story WebUI 数据库迁移 0001：初始 schema（对齐 data-model.md §1）
PRAGMA journal_mode = WAL;
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_unq ON artifacts(book_id, stage_id, revision, path);

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
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_busy ON jobs(book_id, stage_id) WHERE status IN ('queued','running');

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
CREATE INDEX IF NOT EXISTS idx_gates_lookup ON gate_runs(book_id, stage_id, revision);

CREATE TABLE IF NOT EXISTS channels (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  base_url   TEXT NOT NULL,
  model_ids  TEXT NOT NULL DEFAULT '[]',      -- JSON 数组（密钥不在此表）
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
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit(target);

CREATE TABLE IF NOT EXISTS modules (
  id           TEXT PRIMARY KEY,              -- md_<ulid>
  kind         TEXT NOT NULL,                 -- plot|emotion|rhythm|hook|character-trait|worldbuilding
  title        TEXT NOT NULL,
  summary      TEXT NOT NULL DEFAULT '',
  source       TEXT NOT NULL,                 -- 拆文库:{书名}/路径 或 user
  tags         TEXT NOT NULL DEFAULT '[]',
  usable_for   TEXT NOT NULL DEFAULT '[]',
  body         TEXT NOT NULL,
  usage_count  INTEGER NOT NULL DEFAULT 0,
  used_in_json TEXT NOT NULL DEFAULT '[]',
  deleted_at   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_modules_lookup ON modules(kind, deleted_at);
CREATE INDEX IF NOT EXISTS idx_modules_usage  ON modules(usage_count DESC);

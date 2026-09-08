// 运维/可观测单测（ops-observability M4 + scale-performance §5/§6）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  collectHealthDeep,
  collectStats,
  auditCsv,
  runBackup,
  listBackups,
  maintain,
  archiveGateRuns,
  relinkBook,
  deleteToArchive,
  killJob,
  recoverJobsOnBoot,
} from './service.ts';

let dir: string;
let ws: string;
let webuiDir: string;
let db: InstanceType<typeof Database>;

const DDL = `
  CREATE TABLE IF NOT EXISTS books (id TEXT PRIMARY KEY, name TEXT NOT NULL, dir TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, pipeline_id TEXT, pipeline_version INTEGER, theme_color TEXT, active_stage TEXT, meta_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, who TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail_json TEXT);
  CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, book_id TEXT NOT NULL, stage_id TEXT NOT NULL, kind TEXT NOT NULL, revision INTEGER, status TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, cost_cents REAL NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, error TEXT, detail_json TEXT, idempotency_key TEXT UNIQUE, created_at TEXT NOT NULL, finished_at TEXT);
  CREATE TABLE IF NOT EXISTS gate_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, book_id TEXT NOT NULL, stage_id TEXT NOT NULL, revision INTEGER NOT NULL, job_id TEXT, gate TEXT NOT NULL, ok INTEGER NOT NULL, blocking_json TEXT NOT NULL DEFAULT '[]', warnings_json TEXT NOT NULL DEFAULT '[]', detail_json TEXT, ran_ms INTEGER NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, model_ids TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 1, api TEXT NOT NULL DEFAULT 'openai-completions', updated_at TEXT NOT NULL);
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohwebui-ops-'));
  ws = join(dir, 'ws');
  webuiDir = join(ws, '.webui');
  mkdirSync(webuiDir, { recursive: true });
  db = new Database(join(webuiDir, 'webui.db'));
  db.exec(DDL);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 24 * 3600 * 1000).toISOString();

describe('collectHealthDeep / collectStats', () => {
  it('汇总 gate_runs 与 jobs 指标', () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO gate_runs (book_id, stage_id, revision, gate, ok, ran_ms, created_at) VALUES ('b1','s1',1,'char-count',1,50,?)`).run(now);
    db.prepare(`INSERT INTO gate_runs (book_id, stage_id, revision, gate, ok, ran_ms, created_at) VALUES ('b1','s1',1,'ai-patterns',0,900,?)`).run(now);
    db.prepare(`INSERT INTO gate_runs (book_id, stage_id, revision, gate, ok, ran_ms, created_at) VALUES ('b1','s2',1,'ai-patterns',0,1100,?)`).run(now);
    db.prepare(`INSERT INTO jobs (id, book_id, stage_id, kind, status, cost_cents, tokens_in, tokens_out, created_at) VALUES ('j1','b1','s1','stage','done',12.5,100,200,?)`).run(now);
    db.prepare(`INSERT INTO jobs (id, book_id, stage_id, kind, status, cost_cents, tokens_in, tokens_out, created_at) VALUES ('j2','b1','s1','stage','running',3,50,60,?)`).run(now);
    db.prepare(`INSERT INTO jobs (id, book_id, stage_id, kind, status, created_at) VALUES ('j3','b1','s1','stage','queued',?)`).run(now);

    const st = collectStats(db);
    expect(st.gate_total).toBe(3);
    expect(st.gate_blocked).toBe(2);
    const ai = st.per_gate.find((g) => g.gate === 'ai-patterns');
    expect(ai?.runs).toBe(2);
    expect(ai?.blocked).toBe(2);
    expect(st.cost_total_cents).toBe(15.5);
    expect(st.ai_calls_24h).toBe(2);
    expect(st.last_gate_ms_p95).not.toBeNull();

    const deep = collectHealthDeep(db, {
      dbPath: join(webuiDir, 'webui.db'),
      workspace: ws,
      channels: [{ id: 'ch1', name: 'a', base_url: 'http://x', api_key: 'k', models: [] }],
      lastTested: { ch1: '2024-01-01T00:00:00Z' },
    });
    expect(deep.ok).toBe(true);
    expect(deep.python_dep_free).toBe(true);
    expect(deep.db.gates_total).toBe(3);
    expect(deep.db.jobs_pending).toBe(2);
    expect(deep.channels[0]!.configured).toBe(true);
    expect(deep.channels[0]!.tested_at).toBe('2024-01-01T00:00:00Z');
    expect(deep.perf.ai_calls_24h).toBeGreaterThanOrEqual(2);
  });
});

describe('backup / maintain / archive', () => {
  it('每日备份生成 VACUUM INTO 单文件并可列出；maintain 归档冷 gate_runs', () => {
    // 造冷数据（120 天前，超 3 个月归档线）
    db.prepare(`INSERT INTO gate_runs (book_id, stage_id, revision, gate, ok, ran_ms, created_at) VALUES ('bX','s9',1,'old-gate',1,10,?)`).run(iso(120));
    const r = runBackup(db, webuiDir, 'daily');
    expect(r.kept).toBeGreaterThanOrEqual(1);
    expect(existsSync(r.path)).toBe(true);
    const list = listBackups(webuiDir);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0]!.name.startsWith('daily_')).toBe(true);

    const slot = maintain(db, webuiDir, 3);
    expect(slot.archived).toBeGreaterThanOrEqual(1);
    // 冷数据已从热表删除
    const old = db.prepare('SELECT COUNT(*) c FROM gate_runs WHERE gate = \'old-gate\'').get() as any;
    expect(old.c).toBe(0);
    // 归档文件已生成
    const archiveDir = join(webuiDir, 'archive');
    expect(existsSync(archiveDir)).toBe(true);
    expect(readdirSync(archiveDir).length).toBeGreaterThanOrEqual(1);
  });
  it('archiveGateRuns 直接调用：无冷数据返回 0', () => {
    // 冷数据以更早前的 cutoff 判断：当前没有比 60 天前更老的冷数据 → 0
      expect(archiveGateRuns(db, webuiDir, iso(60))).toBe(0);
  });
});

describe('auditCsv', () => {
  it('按 action/target/时间筛选并导出 CSV（含转义）', () => {
    db.prepare(`INSERT INTO audit (ts, who, action, target, detail_json) VALUES (?, 'user', 'approve', 'book:b1/stage:s1', '{\"note\": "过了，,\"}')`).run(iso(0));
    const csv = auditCsv(db, { action: 'approve' });
    expect(csv.split(/\r?\n/)[0]).toBe('id,ts,who,action,target,detail_json');
    expect(csv).toContain('approve');

    const csv2 = auditCsv(db, { from: iso(1) });
    const csv3 = auditCsv(db, { target: 's1' });
    expect(csv2).toContain('book:b1');
    expect(csv3).toContain('book:b1');
  });
});

describe('relinkBook / deleteToArchive', () => {
  it('relink：缺少追踪文件 → INVALID_INPUT；有效目录 → 更新 dir', () => {
    const bookDir = join(ws, '挂载书');
    mkdirSync(join(bookDir, '正文'), { recursive: true });
    mkdirSync(join(bookDir, '追踪'), { recursive: true });
    writeFileSync(join(bookDir, '追踪/_tracking-state.json'), '{}', 'utf8');
    db.prepare(`INSERT INTO books (id, name, dir, kind, active_stage, meta_json, created_at, updated_at) VALUES ('bk1','挂载书',?,'novel','chapter','{}',?,?)`).run(bookDir, new Date().toISOString(), new Date().toISOString());

    const missing = join(ws, '无追踪');
    mkdirSync(missing, { recursive: true });
    expect(() => relinkBook(db, { id: 'bk1', name: '挂载书' }, '无追踪', ws)).toThrowError(/追踪/);

    const res = relinkBook(db, { id: 'bk1', name: '挂载书' }, '挂载书', ws);
    expect(res.dir).toBe(bookDir);
    const row = db.prepare('SELECT dir FROM books WHERE id = \'bk1\'').get() as any;
    expect(row.dir).toBe(bookDir);
  });
  it('deleteToArchive：移动到 _archive + 移除库行 + audit', () => {
    const bookDir = join(ws, '待删书');
    mkdirSync(bookDir, { recursive: true });
    writeFileSync(join(bookDir, 'x.md'), 'x', 'utf8');
    db.prepare(`INSERT INTO books (id, name, dir, kind, active_stage, meta_json, created_at, updated_at) VALUES ('bk2','待删书',?,'novel','chapter','{}',?,?)`).run(bookDir, new Date().toISOString(), new Date().toISOString());
    const r = deleteToArchive(db, { id: 'bk2', name: '待删书', dir: bookDir }, ws);
    expect(r.archivedDir).toContain(join(ws, '_archive'));
    expect(existsSync(r.archivedDir!)).toBe(true);
    expect(db.prepare("SELECT COUNT(*) c FROM books WHERE id='bk2'").get()).toMatchObject({ c: 0 });
    const audit = db.prepare("SELECT * FROM audit WHERE action='delete' ORDER BY id DESC LIMIT 1").get() as any;
    expect(audit).not.toBeUndefined();
  });
});

describe('killJob / recoverJobsOnBoot', () => {
  it('kill 活动任务；启动恢复把 running/queued 置 killed 并记 restart-recovery', () => {
    db.prepare(`INSERT INTO jobs (id, book_id, stage_id, kind, status, created_at) VALUES ('jk1','b1','s1','stage','running',?)`).run(new Date().toISOString());
    db.prepare(`INSERT INTO jobs (id, book_id, stage_id, kind, status, created_at) VALUES ('jk2','b1','s1','stage','done',?)`).run(new Date().toISOString());

    const k = killJob(db, 'jk1');
    expect(k.found).toBe(true);
    expect(db.prepare("SELECT status FROM jobs WHERE id='jk1'").get()).toMatchObject({ status: 'killed' });
    expect(killJob(db, 'nope').found).toBe(false);

    db.prepare(`INSERT INTO jobs (id, book_id, stage_id, kind, status, created_at) VALUES ('jk3','b1','s1','stage','running',?)`).run(new Date().toISOString());
    db.prepare(`INSERT INTO jobs (id, book_id, stage_id, kind, status, created_at) VALUES ('jk4','b1','s1','stage','queued',?)`).run(new Date().toISOString());
    const n = recoverJobsOnBoot(db);
    expect(n).toBeGreaterThanOrEqual(1);
    for (const id of ['jk3', 'jk4']) {
      expect(db.prepare('SELECT status, error FROM jobs WHERE id = ?').get(id)).toMatchObject({ status: 'killed', error: 'restart-recovery' });
    }
  });
});

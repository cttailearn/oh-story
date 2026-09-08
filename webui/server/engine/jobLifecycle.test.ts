// job 生命周期与阶段状态机回归（真实可靠性修复）：
//   1) 跑完的 job 必须落终态（review/done/error），否则成本统计/挂起任务/重启自愈全部失真
//   2) 同阶段重跑不得因部分唯一索引把历史 job 行整行替换掉
//   3) 从未运行过的阶段不得被置为 review（否则批阅栏能放行一个空阶段）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { getProcessDefinition } from './definitions.ts';
import { runStageJob } from './stageRunner.ts';
import { getStageRow, confirmStage, ensureStageRows } from './state.ts';
import { AiRuntime } from '../ai/runtime.ts';
import { initConfig } from '../config/index.ts';

let dir: string;
let db: InstanceType<typeof Database>;
let bookDir: string;

const DDL = `
  CREATE TABLE IF NOT EXISTS stages (book_id TEXT NOT NULL, stage_id TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, started_at TEXT, reviewed_at TEXT, note TEXT, PRIMARY KEY (book_id, stage_id));
  CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, book_id TEXT NOT NULL, stage_id TEXT NOT NULL, kind TEXT NOT NULL, revision INTEGER, status TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, cost_cents REAL NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, error TEXT, detail_json TEXT, idempotency_key TEXT UNIQUE, created_at TEXT NOT NULL, finished_at TEXT);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_busy ON jobs(book_id, stage_id) WHERE status IN ('queued','running');
  CREATE TABLE IF NOT EXISTS gate_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, book_id TEXT NOT NULL, stage_id TEXT NOT NULL, revision INTEGER NOT NULL, job_id TEXT, gate TEXT NOT NULL, ok INTEGER NOT NULL, blocking_json TEXT NOT NULL DEFAULT '[]', warnings_json TEXT NOT NULL DEFAULT '[]', detail_json TEXT, ran_ms INTEGER NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, who TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail_json TEXT);
`;

const jobsOf = (bookId: string, stageId?: string) =>
  db
    .prepare(
      stageId
        ? `SELECT * FROM jobs WHERE book_id=? AND stage_id=? ORDER BY created_at`
        : `SELECT * FROM jobs WHERE book_id=? ORDER BY created_at`,
    )
    .all(...(stageId ? [bookId, stageId] : [bookId])) as Array<{
    id: string;
    stage_id: string;
    status: string;
    error: string | null;
    detail_json: string | null;
    finished_at: string | null;
  }>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohwebui-jobs-'));
  initConfig(join(dir, 'cfg'));
  db = new Database(join(dir, 'jobs.db'));
  db.exec(DDL);
  bookDir = join(dir, 'book');
  mkdirSync(bookDir, { recursive: true });
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('job 生命周期（engine）', () => {
  it('成功跑完：job 落 review 终态并写 finished_at，detail_json 记录渠道/模型', async () => {
    const def = getProcessDefinition('long');
    const bookId = 'nb_life';
    ensureStageRows(db, bookId, def);
    const res = await runStageJob({
      db: { db, path: join(dir, 'jobs.db'), user_version: 1 },
      ai: new AiRuntime(),
      def,
      bookId,
      bookDir,
      bookName: '生命周期测试书',
      stageId: 'intake',
      fake: true,
    });
    expect(res.status).toBe('review');

    const rows = jobsOf(bookId, 'intake');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('review');
    expect(rows[0]!.finished_at).toBeTruthy();
    expect(JSON.parse(rows[0]!.detail_json ?? '{}')).toMatchObject({ channel: 'fake', model: 'fake', fake: true });
  });

  it('同阶段重跑：保留上一条 job 行（历史不被部分唯一索引替换）', async () => {
    const def = getProcessDefinition('long');
    const bookId = 'nb_life';
    const before = jobsOf(bookId, 'intake').map((r) => r.id);
    const res = await runStageJob({
      db: { db, path: join(dir, 'jobs.db'), user_version: 1 },
      ai: new AiRuntime(),
      def,
      bookId,
      bookDir,
      bookName: '生命周期测试书',
      stageId: 'intake',
      fake: true,
    });
    expect(res.status).toBe('review');
    const rows = jobsOf(bookId, 'intake');
    expect(rows).toHaveLength(before.length + 1);
    for (const id of before) expect(rows.map((r) => r.id)).toContain(id);
  });

  it('确认通过：该阶段 job 收尾为 done', () => {
    const def = getProcessDefinition('long');
    const r = confirmStage({ db, def }, { bookId: 'nb_life', stageId: 'intake', action: 'approve' });
    expect(r.status).toBe('done');
    expect(jobsOf('nb_life', 'intake').every((x) => x.status === 'done')).toBe(true);
  });

  it('确认后不得把未运行的后续阶段置为 review（空阶段不得被批阅放行）', () => {
    const def = getProcessDefinition('long');
    for (const id of ['topic', 'concept', 'characters', 'outline', 'chapter', 'review', 'deslop', 'cover', 'export']) {
      expect(getStageRow(db, 'nb_life', id)!.status, id + ' 应为 pending').toBe('pending');
    }
    // 未运行过的阶段也不该有 job 记录
    expect(jobsOf('nb_life').filter((j) => j.stage_id !== 'intake')).toHaveLength(0);
  });

  it('门禁阻塞：job 落 error 终态并带上阻塞原因', async () => {
    const def = getProcessDefinition('long');
    const bookId = 'nb_blocked';
    ensureStageRows(db, bookId, def);
    const res = await runStageJob({
      db: { db, path: join(dir, 'jobs.db'), user_version: 1 },
      ai: new AiRuntime(),
      def,
      bookId,
      bookDir,
      bookName: '阻塞测试书',
      stageId: 'chapter',
      fake: true,
    });
    expect(res.status).toBe('blocked');
    const rows = jobsOf(bookId, 'chapter');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[rows.length - 1]!.status).toBe('error');
    expect(rows[rows.length - 1]!.error).toContain('GATE_BLOCKING');
    expect(rows[rows.length - 1]!.finished_at).toBeTruthy();
  });
});

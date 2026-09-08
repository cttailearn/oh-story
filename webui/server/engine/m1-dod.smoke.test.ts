// M1 DoD smoke: fake channel full chain intake->concept->characters->outline with per-stage approve
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohwebui-dod-'));
  initConfig(join(dir, 'cfg'));
  db = new Database(join(dir, 'm1.db'));
  db.exec(DDL);
  bookDir = join(dir, 'book');
  mkdirSync(bookDir, { recursive: true });
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('M1 DoD smoke (fake full chain + per-stage approve)', () => {
  it('intake -> concept -> characters -> outline all reach review, approve to done, outline lands on disk', async () => {
    const def = getProcessDefinition('long');
    const ai = new AiRuntime();
    const bookId = 'nb_dod';
    ensureStageRows(db, bookId, def);

    const order = ['intake', 'concept', 'characters', 'outline'];
    for (const stageId of order) {
      const res = await runStageJob({
        db: { db, path: join(dir, 'm1.db'), user_version: 1 },
        ai,
        def,
        bookId,
        bookDir,
        bookName: 'M1 smoke book',
        stageId,
        fake: true,
      });
      expect(res.status, 'stage ' + stageId + ' should reach review').toBe('review');
      const cf = confirmStage({ db, def }, { bookId, stageId, action: 'approve', note: 'smoke approve' });
      expect(cf.status).toBe('done');
      expect(getStageRow(db, bookId, stageId)!.revision).toBeGreaterThanOrEqual(1);
    }

    const outlineMd = join(bookDir, '大纲', '大纲.md');
    expect(existsSync(outlineMd)).toBe(true);
    expect(readFileSync(outlineMd, 'utf8')).toMatch(/全书体量|阶段总览/);
    const xigang = join(bookDir, '大纲', '细纲', '第001章.md');
    expect(existsSync(xigang)).toBe(true);
  });
});

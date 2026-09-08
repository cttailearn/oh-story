import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { loadAllDefinitions, getProcessDefinition, resetDefinitionCache } from './definitions.ts';
import {
  ensureStageRows,
  startRun,
  markReview,
  markBlocked,
  confirmStage,
  rollbackTo,
  recoverRunningToReview,
  getStageRow,
} from './state.ts';

let db: InstanceType<typeof Database>;
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohwebui-engine-'));
  db = new Database(join(dir, 'test.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS stages (
      book_id TEXT NOT NULL, stage_id TEXT NOT NULL,
      status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
      started_at TEXT, reviewed_at TEXT, note TEXT,
      PRIMARY KEY (book_id, stage_id)
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, stage_id TEXT NOT NULL,
      kind TEXT NOT NULL, revision INTEGER, status TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0, cost_cents REAL NOT NULL DEFAULT 0,
      tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
      error TEXT, detail_json TEXT, idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_busy ON jobs(book_id, stage_id) WHERE status IN ('queued','running');
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
      who TEXT NOT NULL DEFAULT 'user', action TEXT NOT NULL,
      target TEXT NOT NULL, detail_json TEXT
    );
  `);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  resetDefinitionCache();
});

describe('definitions loader', () => {
  it('加载 long/short 并校验 gate 名', () => {
    const defs = loadAllDefinitions();
    expect(defs.size).toBe(2);
    const long = defs.get('long')!;
    expect(long.version).toBe(1);
    expect(long.stages.map((s) => s.id)).toContain('outline');
    expect(long.stages.find((s) => s.id === 'chapter')!.gates.some((g) => g.name === 'tracking-commit')).toBe(true);
    expect(long.stages.find((s) => s.id === 'characters')!.artifact.path).toContain('角色线');
  });

  it('不存在的定义报错', () => {
    expect(() => getProcessDefinition('nope')).toThrow(/PROCESS_DEF_NOT_FOUND/);
  });
});

describe('engine state machine', () => {
  const def = getProcessDefinition('long');
  const bookId = 'nb_test001';

  it('ensureStageRows 建全量 stages', () => {
    ensureStageRows(db, bookId, def);
    const rows = db.prepare(`SELECT COUNT(*) AS c FROM stages WHERE book_id=?`).get(bookId) as { c: number };
    expect(rows.c).toBe(def.stages.length);
  });

  it('startRun: pending→running + revision=1', () => {
    const r = startRun({ db, def }, { bookId, stageId: 'intake' });
    expect(r.reused).toBe(false);
    expect(r.revision).toBe(1);
    expect(getStageRow(db, bookId, 'intake')!.status).toBe('running');
    expect(getStageRow(db, bookId, 'intake')!.revision).toBe(1);
  });

  it('幂等：同 idempotencyKey 复用 job', () => {
    const a = startRun({ db, def }, { bookId, stageId: 'concept', idempotencyKey: 'k1' });
    const b = startRun({ db, def }, { bookId, stageId: 'concept', idempotencyKey: 'k1' });
    expect(a.jobId).toBe(b.jobId);
    expect(b.reused).toBe(true);
  });

  it('markReview: running→review 且 aud意；revision 保持', () => {
    startRun({ db, def }, { bookId, stageId: 'topic' });
    markReview({ db, def }, { bookId, stageId: 'topic', revision: 1 });
    expect(getStageRow(db, bookId, 'topic')!.status).toBe('review');
    const aud = db.prepare(`SELECT action FROM audit WHERE target LIKE '%topic%' ORDER BY id DESC LIMIT 1`).get() as any;
    expect(aud.action).toBe('run');
  });

  it('markBlocked: running→blocked', () => {
    startRun({ db, def }, { bookId, stageId: 'concept', idempotencyKey: undefined });
    markBlocked({ db, def }, { bookId, stageId: 'concept', revision: 1, reason: 'ai-patterns blocking' });
    expect(getStageRow(db, bookId, 'concept')!.status).toBe('blocked');
  });

  it('review{approve}: review→done；blocked 时拒绝 approve', () => {
    // concept 当前 blocked → approve 应被拒
    expect(() =>
      confirmStage({ db, def }, { bookId, stageId: 'concept', action: 'approve' }),
    ).toThrow(/GATE_BLOCKING/);

    // topic 是 review 状态 → approve 通过 → done
    const res = confirmStage({ db, def }, { bookId, stageId: 'topic', action: 'approve', note: 'ok' });
    expect(res.status).toBe('done');
    expect(getStageRow(db, bookId, 'topic')!.status).toBe('done');
    expect(typeof res.auditId).toBe('number');
  });

  it('review{edit_rerun}: review→running', () => {
    // 下一 pending stage（intake 已 done? — intake 是 running，所以 intro pending 是 character…）
    // 我们拿一个 review 状态做 edit_rerun
    startRun({ db, def }, { bookId, stageId: 'characters' });
    markReview({ db, def }, { bookId, stageId: 'characters', revision: 1 });
    const res = confirmStage({ db, def }, { bookId, stageId: 'characters', action: 'edit_rerun', note: '改' });
    expect(res.status).toBe('running');
    expect(res.stage.id).toBe('characters');
  });

  it('review{skip}: review→skipped', () => {
    startRun({ db, def }, { bookId, stageId: 'cover' });
    markReview({ db, def }, { bookId, stageId: 'cover', revision: 1 });
    const res = confirmStage({ db, def }, { bookId, stageId: 'cover', action: 'skip' });
    expect(res.status).toBe('skipped');
  });

  it('rollbackTo: 任意→review + revision+1', () => {
    const before = getStageRow(db, bookId, 'outline')?.revision ?? 0;
    rollbackTo({ db, def }, { bookId, stageId: 'outline' });
    const after = getStageRow(db, bookId, 'outline')!;
    expect(after.status).toBe('review');
    expect(after.revision).toBe(before + 1);
  });

  it('recoverRunningToReview: running→review（服务重启恢复）', () => {
    startRun({ db, def }, { bookId, stageId: 'export' });
    expect(getStageRow(db, bookId, 'export')!.status).toBe('running');
    const n = recoverRunningToReview(db);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(getStageRow(db, bookId, 'export')!.status).toBe('review');
  });
});

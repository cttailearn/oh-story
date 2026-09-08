// 流程状态机（process-definition §6）：转移表 / revision / 幂等 / 恢复
import Database from 'better-sqlite3';
import type {
  ProcessDefinition,
  StageStatus,
  ConfirmAction,
  StageDefinition,
  JobStatus,
} from './types.ts';
import { getStage } from './definitions.ts';

type Sqlite = InstanceType<typeof Database>;

export interface StageRow {
  book_id: string;
  stage_id: string;
  status: StageStatus;
  revision: number;
  started_at: string | null;
  reviewed_at: string | null;
  note: string | null;
}

export interface EngineOptions {
  db: Sqlite;
  def: ProcessDefinition;
}

const VALID_ACTIONS: ConfirmAction[] = ['approve', 'edit_rerun', 'reject_regen', 'skip', 'force_approve'];

export function ensureStageRows(db: Sqlite, bookId: string, def: ProcessDefinition): void {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO stages (book_id, stage_id, status, revision) VALUES (?,?,'pending',0)`,
  );
  const tx = db.transaction(() => {
    for (const s of def.stages) {
      ins.run(bookId, s.id);
    }
  });
  tx();
}

export function getStageRow(db: Sqlite, bookId: string, stageId: string): StageRow | undefined {
  return db
    .prepare(`SELECT * FROM stages WHERE book_id=? AND stage_id=?`)
    .get(bookId, stageId) as StageRow | undefined;
}

export function setStageStatus(
  db: Sqlite,
  bookId: string,
  stageId: string,
  status: StageStatus,
  opts: { revision?: number; started_at?: string | null; reviewed_at?: string | null; note?: string | null } = {},
): void {
  const cur = getStageRow(db, bookId, stageId);
  const rev = opts.revision ?? cur?.revision ?? 0;
  db.prepare(
    `UPDATE stages SET status=?, revision=?, started_at=COALESCE(?, started_at), reviewed_at=COALESCE(?, reviewed_at), note=COALESCE(?, note) WHERE book_id=? AND stage_id=?`,
  ).run(
    status,
    rev,
    opts.started_at ?? null,
    opts.reviewed_at ?? null,
    opts.note ?? null,
    bookId,
    stageId,
  );
}

/** run：pending/review/blocked → running，revision +1；幂等（key 已存在返回已有 job） */
export function startRun(
  opts: EngineOptions,
  params: { bookId: string; stageId: string; idempotencyKey?: string; note?: string },
): { jobId: string; revision: number; reused: boolean; stage: StageDefinition } {
  const { db, def } = opts;
  const stage = getStage(def, params.stageId);
  ensureStageRows(db, params.bookId, def);

  // 幂等：同一 idempotencyKey 返回既有 job
  if (params.idempotencyKey) {
    const existing = db
      .prepare(`SELECT id FROM jobs WHERE idempotency_key=?`)
      .get(params.idempotencyKey) as { id: string } | undefined;
    if (existing) {
      const row = getStageRow(db, params.bookId, params.stageId);
      return {
        jobId: existing.id,
        revision: row?.revision ?? 0,
        reused: true,
        stage,
      };
    }
  }

  const cur = getStageRow(db, params.bookId, params.stageId);
  // 并发保护（idx_jobs_busy 是数据库层保证）：已有在途 job 一律复用。
  // 修复：原先用 INSERT OR REPLACE，而 job 从不进入终态 → 旧行长期停留在 queued/running，
  // 重跑同一阶段会命中部分唯一索引把「上一次 job 行」整行替换掉，任务历史被静默抹除。
  const inFlight = findInFlightJob(db, params.bookId, params.stageId);
  if (inFlight) {
    return { jobId: inFlight, revision: cur?.revision ?? 0, reused: true, stage };
  }

  const revision = (cur?.revision ?? 0) + 1;
  const ts = new Date().toISOString();
  const jobId = `job_${ts.replace(/\D/g, '').slice(0, 13)}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    db.prepare(
      `INSERT INTO jobs (id, book_id, stage_id, kind, revision, status, progress, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      jobId,
      params.bookId,
      params.stageId,
      'stage',
      revision,
      'queued',
      0,
      ts,
    );
  } catch (e: any) {
    // 竞态：另一个 run 刚插入 queued 行 → 复用它的 job（仍不覆盖历史）
    const raced = findInFlightJob(db, params.bookId, params.stageId);
    if (raced) return { jobId: raced, revision: cur?.revision ?? 0, reused: true, stage };
    throw e;
  }
  setStageStatus(db, params.bookId, params.stageId, 'running', { revision });
  return { jobId, revision, reused: false, stage };
}

/** 在途 job（queued/running）——与 idx_jobs_busy 部分唯一索引同口径 */
function findInFlightJob(db: Sqlite, bookId: string, stageId: string): string | undefined {
  const row = db
    .prepare(`SELECT id FROM jobs WHERE book_id=? AND stage_id=? AND status IN ('queued','running') LIMIT 1`)
    .get(bookId, stageId) as { id: string } | undefined;
  return row?.id;
}

/**
 * job 状态落终态（jobs.status CHECK: queued|running|review|done|error|killed）。
 * running 不写 finished_at；其余终态一律写 finished_at。
 */
export function markJobStatus(
  db: Sqlite,
  jobId: string,
  status: JobStatus,
  opts: { error?: string } = {},
): void {
  if (status === 'running') {
    db.prepare(`UPDATE jobs SET status='running', error=COALESCE(?, error) WHERE id=?`).run(
      opts.error ?? null,
      jobId,
    );
    return;
  }
  db.prepare(
    `UPDATE jobs SET status=?, error=COALESCE(?, error), finished_at=? WHERE id=?`,
  ).run(status, opts.error ?? null, new Date().toISOString(), jobId);
}

/** 该阶段所有处于 from 状态的 job → to（阶段确认/跳过时收尾，避免 jobs 永远挂在 review） */
export function finishStageJobs(
  db: Sqlite,
  bookId: string,
  stageId: string,
  from: JobStatus,
  to: JobStatus,
): number {
  return db
    .prepare(
      `UPDATE jobs SET status=?, finished_at=? WHERE book_id=? AND stage_id=? AND status=?`,
    )
    .run(to, new Date().toISOString(), bookId, stageId, from).changes;
}

/** 产物 + 门禁全过 → running → review */
export function markReview(
  opts: EngineOptions,
  params: { bookId: string; stageId: string; revision: number; note?: string },
): StageRow {
  const { db } = opts;
  setStageStatus(db, params.bookId, params.stageId, 'review', {
    revision: params.revision,
    started_at: null,
    note: params.note ?? null,
  });
  db.prepare(
    `INSERT INTO audit (ts, who, action, target, detail_json) VALUES (?,?,?,?,?)`,
  ).run(
    new Date().toISOString(),
    'engine',
    'run',
    `book:${params.bookId}/stage:${params.stageId}/rev:${params.revision}`,
    JSON.stringify({ to: 'review' }),
  );
  return getStageRow(db, params.bookId, params.stageId)!;
}

/** 有 blocking / error → running → blocked */
export function markBlocked(
  opts: EngineOptions,
  params: { bookId: string; stageId: string; revision: number; reason: string },
): void {
  const { db } = opts;
  setStageStatus(db, params.bookId, params.stageId, 'blocked', { revision: params.revision });
  db.prepare(
    `INSERT INTO audit (ts, who, action, target, detail_json) VALUES (?,?,?,?,?)`,
  ).run(
    new Date().toISOString(),
    'engine',
    'blocked',
    `book:${params.bookId}/stage:${params.stageId}/rev:${params.revision}`,
    JSON.stringify({ reason: params.reason }),
  );
}

/** review{action} —— 每步确认 */
export function confirmStage(
  opts: EngineOptions,
  params: {
    bookId: string;
    stageId: string;
    action: ConfirmAction;
    note?: string;
    revision?: number;
  },
): {
  stage: StageDefinition;
  status: StageStatus;
  nextStage?: StageDefinition;
  auditId: number;
} {
  const { db, def } = opts;
  if (!VALID_ACTIONS.includes(params.action)) throw new Error(`INVALID_ACTION: ${params.action}`);
  const stage = getStage(def, params.stageId);
  // force_approve（人工放行）：人类最终拍板，不受门禁阻塞限制，始终记 audit
  const isForce = params.action === 'force_approve';
  if (!isForce && !stage.confirm.actions.includes(params.action)) {
    throw new Error(`ACTION_NOT_ALLOWED: ${params.action} for stage ${params.stageId}`);
  }
  const cur = getStageRow(db, params.bookId, params.stageId);
  const revision = params.revision ?? cur?.revision ?? 0;
  const ts = new Date().toISOString();

  if (params.action === 'approve' || isForce) {
    if (!isForce && cur && cur.status === 'blocked') throw new Error('GATE_BLOCKING');
    setStageStatus(db, params.bookId, params.stageId, 'done', { revision, reviewed_at: ts });
    // 该阶段在途 job 收尾（review → done）：jobs 必须有终态，否则成本统计/挂起任务/重启自愈全部失真
    finishStageJobs(db, params.bookId, params.stageId, 'review', 'done');
    // 注意：这里刻意不再把「下一个 pending 阶段」置为 review。
    // review 的语义是「产物已产出、等待人工批阅」；从未运行过的阶段没有产物，
    // 置为 review 会让批阅栏直接放行一个空阶段（假流程）。
  } else if (params.action === 'edit_rerun') {
    setStageStatus(db, params.bookId, params.stageId, 'running', { revision, started_at: ts });
  } else if (params.action === 'reject_regen') {
    setStageStatus(db, params.bookId, params.stageId, 'running', { revision, started_at: ts });
  } else if (params.action === 'skip') {
    setStageStatus(db, params.bookId, params.stageId, 'skipped', { revision, reviewed_at: ts });
    finishStageJobs(db, params.bookId, params.stageId, 'review', 'done');
  }

  const auditId = db.prepare(
    `INSERT INTO audit (ts, who, action, target, detail_json) VALUES (?,?,?,?,?)`,
  ).run(ts, 'user', params.action, `book:${params.bookId}/stage:${params.stageId}/rev:${revision}`, JSON.stringify({ note: params.note ?? '' })).lastInsertRowid as number;

  return { stage, status: getStageRow(db, params.bookId, params.stageId)!.status, auditId };
}

/** 回退到某阶段：任意状态 → review（新 revision，不破坏已提交产物） */
export function rollbackTo(
  opts: EngineOptions,
  params: { bookId: string; stageId: string },
): void {
  const { db, def } = opts;
  const stage = getStage(def, params.stageId);
  ensureStageRows(db, params.bookId, def);
  const cur = getStageRow(db, params.bookId, params.stageId);
  setStageStatus(db, params.bookId, params.stageId, 'review', {
    revision: (cur?.revision ?? 0) + 1,
    started_at: null,
  });
  db.prepare(
    `INSERT INTO audit (ts, who, action, target, detail_json) VALUES (?,?,?,?,?)`,
  ).run(new Date().toISOString(), 'user', 'rollback', `book:${params.bookId}/stage:${params.stageId}`, JSON.stringify({ stage: stage.id }));
}

/** 服务重启恢复：running → review（单机无在途 LLM） */
export function recoverRunningToReview(db: Sqlite): number {
  const rows = db.prepare(`SELECT DISTINCT book_id, stage_id FROM stages WHERE status='running'`).all() as Array<{ book_id: string; stage_id: string }>;
  const upd = db.prepare(`UPDATE stages SET status='review', started_at=NULL WHERE book_id=? AND stage_id=?`);
  db.transaction(() => {
    for (const r of rows) upd.run(r.book_id, r.stage_id);
  })();
  return rows.length;
}

/** job 状态更新 + 成本/用量累计（agents-runtime §5.2） */
export function updateJobUsage(
  db: Sqlite,
  jobId: string,
  usage: { tokens_in?: number; tokens_out?: number; cost_cents?: number },
  status?: JobStatus,
): void {
  const cur = db.prepare(`SELECT tokens_in, tokens_out, cost_cents FROM jobs WHERE id=?`).get(jobId) as
    | { tokens_in: number; tokens_out: number; cost_cents: number }
    | undefined;
  if (!cur) return;
  const tokens_in = cur.tokens_in + (usage.tokens_in ?? 0);
  const tokens_out = cur.tokens_out + (usage.tokens_out ?? 0);
  const cost_cents = cur.cost_cents + (usage.cost_cents ?? 0);
  db.prepare(
    `UPDATE jobs SET tokens_in=?, tokens_out=?, cost_cents=?, status=COALESCE(?, status), finished_at=CASE WHEN ? IS NOT NULL AND (status IN ('queued','running')) THEN ? ELSE finished_at END WHERE id=?`,
  ).run(tokens_in, tokens_out, cost_cents, status ?? null, status ?? null, status ? new Date().toISOString() : null, jobId);
}

export type { StageStatus, JobStatus };

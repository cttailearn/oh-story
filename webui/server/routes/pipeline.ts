// 流程路由（M1.2/M1.7）：stages 视图 + run + review + SSE + tracking 保留
import type { FastifyInstance } from 'fastify';
import type { DbHandle } from '../db/index.ts';
import type { AiRuntime } from '../ai/runtime.ts';
import { getConfig } from '../config/index.ts';
import { getProcessDefinition, loadAllDefinitions } from '../engine/definitions.ts';
import {
  ensureStageRows,
  confirmStage,
  rollbackTo,
  recoverRunningToReview,
  getStageRow,
} from '../engine/state.ts';
import { runStageJob } from '../engine/stageRunner.ts';
import { publish, subscribe } from '../engine/sse.ts';
import { importReviewPending } from '../import/service.ts';

export interface EngineRouteCtx {
  db: DbHandle;
  ai: AiRuntime;
  workspace: string;
}

export async function registerPipelineRoutes(app: FastifyInstance, ctx: EngineRouteCtx): Promise<void> {
  const { db } = ctx;

  // 启动恢复：running → review（单机无在途 LLM）
  recoverRunningToReview(db.db);

  // GET /api/books/:id/stages —— 管线视图
  app.get<{ Params: { id: string } }>('/api/books/:id/stages', async (req, reply) => {
    const book = db.db.prepare(`SELECT * FROM books WHERE id=?`).get(req.params.id) as any;
    if (!book) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
    const pipeline = book.pipeline_id ?? 'long';
    let def;
    try {
      def = getProcessDefinition(pipeline);
    } catch {
      def = getProcessDefinition('long');
    }
    ensureStageRows(db.db, book.id, def);
    const rows = db.db
      .prepare(`SELECT * FROM stages WHERE book_id=? ORDER BY rowid`)
      .all(book.id) as any[];
    const byId = new Map(rows.map((r) => [r.stage_id, r]));
    const stages = def.stages.map((s) => ({
      id: s.id,
      title: s.title,
      type: s.type,
      status: byId.get(s.id)?.status ?? 'pending',
      revision: byId.get(s.id)?.revision ?? 0,
      requires: s.requires,
      gates: s.gates.map((g) => g.name),
      // 产物规格（file-set 支持多文件/多类型）：前端按它展开该步应编辑/查看的文件
      artifact: s.artifact ? { kind: s.artifact.kind, path: s.artifact.path } : null,
    }));
    return { book_id: book.id, pipeline, version: def.version, stages };
  });

  // POST /api/books/:id/stages/:stage/run —— 发起执行（进程内后台，返回 jobId）
  app.post<{ Params: { id: string; stage: string } }>(
    '/api/books/:id/stages/:stage/run',
    async (req, reply) => {
      const book = db.db.prepare(`SELECT * FROM books WHERE id=?`).get(req.params.id) as any;
      if (!book) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
      const body = (req.body ?? {}) as { fake?: boolean; note?: string };
      const fake = body.fake ?? process.env.WEBUI_FAKE_MODE === '1';
      const pipeline = book.pipeline_id ?? 'long';
      const def = getProcessDefinition(pipeline);
      if (!def.stages.some((s) => s.id === req.params.stage)) {
        return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: '未知阶段' } });
      }
      const row = getStageRow(db.db, book.id, req.params.stage);
      if (row?.status === 'running') {
        return reply.code(409).send({ error: { code: 'STAGE_BUSY', message: '该阶段正在运行' } });
      }
      // fail-closed（importing-existing §3）：导入书未完成校对 → 不解锁 chapter 阶段
      if (req.params.stage === 'chapter') {
        let meta: Record<string, unknown> | null = null;
        if (book.meta_json) { try { meta = JSON.parse(book.meta_json); } catch { /* noop */ } }
        if (importReviewPending(book.dir, meta)) {
          return reply.code(409).send({ error: { code: 'IMPORT_REVIEW_PENDING', message: '该书为导入项目，尚未完成「导入校对」（last_committed_chapter 未认定）。请先到导入校对页复核分章与追踪条目后「开始续写」。' } });
        }
      }
      const job = await runStageJob({
        db,
        ai: ctx.ai,
        def,
        bookId: book.id,
        bookDir: book.dir,
        bookName: book.name,
        stageId: req.params.stage,
        fake,
      });
      return { job_id: job.jobId, stage: req.params.stage, status: job.status, gate_blocking: job.gateBlocking };
    },
  );

  // POST /api/books/:id/stages/:stage/review —— 每步确认
  app.post<{ Params: { id: string; stage: string } }>(
    '/api/books/:id/stages/:stage/review',
    async (req, reply) => {
      const book = db.db.prepare(`SELECT * FROM books WHERE id=?`).get(req.params.id) as any;
      if (!book) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
      const body = (req.body ?? {}) as { action: string; note?: string };
      const pipeline = book.pipeline_id ?? 'long';
      const def = getProcessDefinition(pipeline);
      try {
        const r = confirmStage(
          { db: db.db, def },
          { bookId: book.id, stageId: req.params.stage, action: body.action as any, note: body.note },
        );
        return { stage: req.params.stage, status: r.status, audit_id: `au_${r.auditId}` };
      } catch (e: any) {
        if (e?.message === 'GATE_BLOCKING') {
          return reply.code(409).send({ error: { code: 'GATE_BLOCKING', message: '门禁未清，不能直接通过（先改后重跑）' } });
        }
        if (e?.message?.startsWith('ACTION_NOT_ALLOWED')) {
          return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: e.message } });
        }
        return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: e?.message ?? String(e) } });
      }
    },
  );

  // POST /api/books/:id/stages/:stage/rollback —— 回退
  app.post<{ Params: { id: string; stage: string } }>(
    '/api/books/:id/stages/:stage/rollback',
    async (req, reply) => {
      const book = db.db.prepare(`SELECT * FROM books WHERE id=?`).get(req.params.id) as any;
      if (!book) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
      const def = getProcessDefinition(book.pipeline_id ?? 'long');
      try {
        rollbackTo({ db: db.db, def }, { bookId: book.id, stageId: req.params.stage });
        return { ok: true, stage: req.params.stage };
      } catch (e: any) {
        return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: e?.message ?? String(e) } });
      }
    },
  );

  // GET /api/books/:id/jobs/events —— SSE
  app.get<{ Params: { id: string } }>('/api/books/:id/jobs/events', async (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    subscribe(req.params.id, reply as any);
    // 心跳保活
    const hb = setInterval(() => {
      try {
        reply.raw.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
      } catch {
        /* ignore */
      }
    }, 25000);
    reply.raw.on('close', () => clearInterval(hb));
    publish(req.params.id, { event: 'heartbeat', data: { ts: Date.now(), hello: true } });
    return reply;
  });

  // GET /api/books/:id/cost —— 成本仪表（api-contract §3.12）
  app.get<{ Params: { id: string } }>('/api/books/:id/cost', async (req, reply) => {
    const book = db.db.prepare(`SELECT * FROM books WHERE id=?`).get(req.params.id) as any;
    if (!book) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
    // 统计口径：凡「已执行」的 job 都计入（review=已产出待确认 / done=已确认 / error=阻塞或调用失败 / killed=人工终止）。
    // 修复：原先只统计 done/error，而 job 此前从不进入终态 → 成本面板恒为 0（与「成本可见」承诺不符）。
    const rows = db.db
      .prepare(
        `SELECT stage_id, cost_cents, tokens_in, tokens_out, created_at, detail_json FROM jobs
         WHERE book_id=? AND status IN ('review','done','error','killed')`,
      )
      .all(book.id) as Array<{
      stage_id: string;
      cost_cents: number;
      tokens_in: number;
      tokens_out: number;
      created_at: string;
      detail_json: string | null;
    }>;
    const now = new Date();
    const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const monthKey = (d: Date) => dayKey(d).slice(0, 7);
    const isToday = (iso: string) => dayKey(new Date(iso)) === dayKey(now);
    const isThisMonth = (iso: string) => monthKey(new Date(iso)) === monthKey(now);
    let dayCents = 0;
    let monthCents = 0;
    const byStage: Record<string, number> = {};
    const byModel: Record<string, number> = {};
    const curve: Array<{ date: string; cents: number }> = [];
    const curveMap = new Map<string, number>();
    for (const r of rows) {
      if (isToday(r.created_at)) dayCents += r.cost_cents;
      if (isThisMonth(r.created_at)) monthCents += r.cost_cents;
      byStage[r.stage_id] = (byStage[r.stage_id] ?? 0) + r.cost_cents;
      // by_model：job.detail_json 记录本次实际渠道/模型（stageRunner 写入）
      let mk = '未记录';
      if (r.detail_json) {
        try {
          const dj = JSON.parse(r.detail_json) as { channel?: string; model?: string };
          if (dj?.model) mk = `${dj.channel ?? '?'}/${dj.model}`;
        } catch {
          /* 脏数据按未记录处理 */
        }
      }
      byModel[mk] = (byModel[mk] ?? 0) + r.cost_cents;
      const dk = dayKey(new Date(r.created_at));
      curveMap.set(dk, (curveMap.get(dk) ?? 0) + r.cost_cents);
    }
    for (const [date, cents] of curveMap) curve.push({ date, cents: Math.round(cents * 100) / 100 });
    curve.sort((a, b) => a.date.localeCompare(b.date));
    const budget = getConfig().budget;
    return {
      book_id: book.id,
      day_cents: dayCents,
      month_cents: monthCents,
      budget_day_cents: budget.daily_max_cents,
      budget_month_cents: budget.stage_max_cents * 5,
      month_ratio: budget.daily_max_cents > 0 ? Math.min(1, monthCents / budget.daily_max_cents) : 0,
      by_stage: byStage,
      by_model: byModel,
      curve,
      total_cents: rows.reduce((s, r) => s + r.cost_cents, 0),
      total_tokens_in: rows.reduce((s, r) => s + r.tokens_in, 0),
      total_tokens_out: rows.reduce((s, r) => s + r.tokens_out, 0),
    };
  });
}

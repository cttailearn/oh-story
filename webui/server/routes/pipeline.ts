// 流程路由（M1.2/M1.7）：stages 视图 + run + review + SSE + tracking 保留
import type { FastifyInstance } from 'fastify';
import type { DbHandle } from '../db/index.ts';
import type { AiRuntime } from '../ai/runtime.ts';
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
}

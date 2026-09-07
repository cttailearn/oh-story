// 门禁路由：对书跑门禁（M0.8 冒烟端点）+ 门禁历史查询
import type { FastifyInstance } from 'fastify';
import type { DbHandle } from '../db/index.ts';
import { buildGateAdapters } from '../gates/registry.ts';
import { runGates, summarize, hasBlocking } from '../gates/runner.ts';
import { ulid } from '../db/index.ts';

export interface GateRouteCtx {
  db: DbHandle;
  workspace: string;
}

export async function registerGateRoutes(app: FastifyInstance, ctx: GateRouteCtx): Promise<void> {
  const db = ctx.db;

  // POST /api/books/:id/gates/run —— 对某书跑配置的门禁（默认 ai-patterns+degeneration+outline-detail）
  app.post<{ Params: { id: string } }>('/api/books/:id/gates/run', async (req, reply) => {
    const book = db.db.prepare(`SELECT * FROM books WHERE id = ?`).get(req.params.id) as any;
    if (!book) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
    const body = (req.body ?? {}) as { gates?: string[]; failFast?: boolean };
    const adapters = buildGateAdapters();
    const selected = body.gates && body.gates.length
      ? adapters.filter((a) => body.gates!.includes(a.name))
      : adapters;
    if (selected.length === 0) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: '门禁不可用（技能脚本目录未找到）' } });
    }
    const jobId = ulid('job');
    db.db
      .prepare(`INSERT INTO jobs (id, book_id, stage_id, kind, status, created_at) VALUES (?,?,?,?,?,?)`)
      .run(jobId, book.id, 'gates-smoke', 'stage', 'queued', new Date().toISOString());

    const reports = await runGates(
      db.db,
      selected,
      { bookDir: book.dir, cwd: ctx.workspace, args: { failFast: body.failFast } },
      { bookId: book.id, stageId: 'gates-smoke', revision: null, jobId },
    );
    db.db
      .prepare(`UPDATE jobs SET status = ?, finished_at = ?, detail_json = ? WHERE id = ?`)
      .run(hasBlocking(reports) ? 'error' : 'done', new Date().toISOString(), JSON.stringify({ gates: reports.map((r) => r.gate) }), jobId);

    return {
      job_id: jobId,
      blocking: hasBlocking(reports),
      gates: summarize(reports),
      reports,
    };
  });

  // GET /api/books/:id/gate-runs —— 门禁历史
  app.get<{ Params: { id: string } }>('/api/books/:id/gate-runs', async (req, reply) => {
    const book = db.db.prepare(`SELECT * FROM books WHERE id = ?`).get(req.params.id) as any;
    if (!book) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
    const rows = db.db
      .prepare(`SELECT * FROM gate_runs WHERE book_id = ? ORDER BY id DESC LIMIT 200`)
      .all(req.params.id) as any[];
    return { items: rows, total: rows.length };
  });
}

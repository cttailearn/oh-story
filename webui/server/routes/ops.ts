// 运维路由（ops-observability.md M4）：health?depth=full / stats / audit.csv / backup / maintain / relink / kill
import type { FastifyInstance } from 'fastify';
import type { DbHandle } from '../db/index.ts';
import { getConfig } from '../config/index.ts';
import {
  collectHealthDeep,
  collectStats,
  auditCsv,
  runBackup,
  listBackups,
  maintain,
  relinkBook,
  deleteToArchive,
  killJob,
  type AuditFilter,
} from '../ops/service.ts';

export interface OpsRouteCtx {
  db: DbHandle;
  workspace: string;
  webuiDir: string;
}

export async function registerOpsRoutes(app: FastifyInstance, ctx: OpsRouteCtx): Promise<void> {
  const { db } = ctx     ;

  // GET /api/stats —— 门禁历史/成本/用量 汇总（设置→统计/审计）
  app.get('/api/stats', async () => collectStats(db.db));

  // GET /api/stats/audit.csv —— 审计导出 CSV（action/target/时间筛选）
  app.get('/api/stats/audit.csv', async (req, reply) => {
    const q = req.query as { action?: string; target?: string; from?: string; to?: string; limit?: string };
    const f: AuditFilter = {
      action: q.action || undefined,
      target: q.target || undefined,
      from: q.from || undefined,
      to: q.to || undefined,
      limit: q.limit ? Number(q.limit) : undefined,
    };
    const csv = auditCsv(db.db, f);
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="audit.csv"')
      .send(csv);
  });

  // 通用审计查询由 routes/index.ts 的 /api/audit 提供（本路由只出 CSV）

  // POST /api/ops/backup —— 手动备份/升级前快照
  app.post('/api/ops/backup', async (req) => {
    const body = (req.body ?? {}) as { mode?: string };
    const mode = body.mode === 'snapshot' ? 'snapshot' : 'daily';
    const r = runBackup(db.db, ctx.webuiDir, mode);
    return { ok: true, ...r };
  });

  // GET /api/ops/backups —— 已有备份列表
  app.get('/api/ops/backups', async () => ({ items: listBackups(ctx.webuiDir) }));

  // POST /api/ops/maintain —— optimize + checkpoint + gate_runs 归档
  app.post('/api/ops/maintain', async () => ({ ok: true, ...maintain(db.db, ctx.webuiDir) }));

  // POST /api/books/:id/relink —— 目录变更/从 _archive 恢复
  app.post<{ Params: { id: string } }>('/api/books/:id/relink', async (req, reply) => {
    const book = db.db.prepare('SELECT * FROM books WHERE id=?').get(req.params.id) as any;
    if (!book) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
    const body = (req.body ?? {}) as { dir?: string };
    if (!body.dir) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: '缺少 dir' } });
    try {
      return { ok: true, ...relinkBook(db.db, { id: book.id, name: book.name }, body.dir, ctx.workspace) };
    } catch (e: any) {
      const code = e?.code ?? 'INTERNAL';
      const status = code === 'NOT_FOUND' ? 404 : code === 'INVALID_INPUT' ? 400 : 500;
      return reply.code(status).send({ error: { code, message: String(e?.message ?? e) } });
    }
  });

  // POST /api/jobs/:id/kill —— kill 卡死任务（ops §5）
  app.post<{ Params: { id: string } }>('/api/jobs/:id/kill', async (req, reply) => {
    const r = killJob(db.db, req.params.id);
    if (!r.found) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '任务不存在' } });
    return { ok: true, job_id: req.params.id, from: r.status };
  });
}

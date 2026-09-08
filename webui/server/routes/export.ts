// 路由：POST /books/:id/export（export-publish.md）
import type { FastifyInstance } from 'fastify';
import type { DbHandle } from '../db/index.ts';
import { exportBook, type ExportRequest } from '../export/service.ts';

export interface ExportRouteCtx {
  db: DbHandle;
  workspace: string;
}

export async function registerExportRoute(app: FastifyInstance, ctx: ExportRouteCtx): Promise<void> {
  app.post<{ Params: { id: string } }>('/api/books/:id/export', async (req, reply) => {
    const book = ctx.db.db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id) as any;
    if (!book) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
    const body = (req.body ?? {}) as ExportRequest;
    const format = body.format ?? 'markdown';
    if (!['markdown', 'txt'].includes(format)) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'format 仅支持 markdown/txt（epub/zip 为 M4）', detail: { format } } });
    }
    const r = exportBook(ctx.db.db, { id: book.id, name: book.name, dir: book.dir }, body);
    if (!r.ok) {
      return reply.code(422).send({ error: { code: 'GATE_BLOCKING', message: '发布前检查未过（blocking 未清零）', detail: { blocking: r.stats.blocked ?? [] } } });
    }
    return r;
  });
}

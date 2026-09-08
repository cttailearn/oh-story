// 路由：POST /api/import（importing-existing.md）
import type { FastifyInstance } from 'fastify';
import type { DbHandle } from '../db/index.ts';
import { importNovel, type ImportRequest } from '../import/service.ts';

export interface ImportRouteCtx {
  db: DbHandle;
  workspace: string;
}

export async function registerImportRoute(app: FastifyInstance, ctx: ImportRouteCtx): Promise<void> {
  app.post('/api/import', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<ImportRequest>;
    const mode = body.mode ?? 'clipboard';
    if (!['text-file', 'clipboard', 'dir'].includes(mode)) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: '未知 mode', detail: { mode } } });
    }
    try {
      const r = await importNovel(ctx.db.db, ctx.workspace, {
        name: body.name ?? '',
        mode: mode as ImportRequest['mode'],
        path: body.path,
        text: body.text,
      });
      return r.book ? { book: r.book, review: r.review, duplicate: r.duplicate } : { duplicate: true };
    } catch (e: any) {
      const code = e?.code ?? 'INTERNAL';
      const status = code === 'NOT_FOUND' ? 404 : code === 'INVALID_INPUT' ? 400 : 500;
      return reply.code(status).send({ error: { code, message: String(e?.message ?? e) } });
    }
  });
}

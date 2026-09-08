// 模块库 REST 路由（api-contract §3.10 / teardown-module-ui §8）
import type { FastifyInstance } from 'fastify';
import type { DbHandle } from '../db/index.ts';
import {
  listModules,
  getModule,
  updateModule,
  softDeleteModule,
  archiveModules,
  recommendModules,
  attachModules,
} from '../modules/service.ts';
import { publish } from '../engine/sse.ts';

export interface ModuleRouteCtx {
  db: DbHandle;
  workspace: string;
}

export async function registerModuleRoutes(app: FastifyInstance, ctx: ModuleRouteCtx): Promise<void> {
  const db = ctx.db;
  const audit = (bookId: string | null, action: string, detail: unknown) => {
    db.db
      .prepare('INSERT INTO audit (ts, who, action, target, detail_json) VALUES (?,?,?,?,?)')
      .run(new Date().toISOString(), 'user', action, bookId ? 'book:' + bookId : 'modules', JSON.stringify(detail ?? {}));
  };

  // GET /api/modules —— 模块库列表（项目级/全局）
  app.get('/api/modules', async (req, reply) => {
    const q = (req.query ?? {}) as any;
    const r = listModules(db.db, {
      kind: q.kind, tag: q.tag, usable_for: q.usable_for, source: q.source,
      sort: q.sort, offset: Number(q.offset ?? 0), limit: Number(q.limit ?? 50),
    });
    return { items: r.items, total: r.total, offset: Number(q.offset ?? 0), limit: Number(q.limit ?? 50) };
  });

  // GET /api/modules/:id —— 详情（含 used_in）
  app.get<{ Params: { id: string } }>('/api/modules/:id', async (req, reply) => {
    const m = getModule(db.db, req.params.id, false);
    if (!m) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '模块不存在' } });
    return m;
  });

  // PUT /api/modules/:id —— 编辑 tags/usable_for/summary/body
  app.put<{ Params: { id: string } }>('/api/modules/:id', async (req, reply) => {
    const body = (req.body ?? {}) as any;
    const m = updateModule(db.db, req.params.id, {
      title: body.title, summary: body.summary, body: body.body,
      tags: body.tags, usable_for: body.usable_for,
    });
    if (!m) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '模块不存在或已删除' } });
    audit(null, 'module:edit', { id: m.id, title: m.title });
    return m;
  });

  // DELETE /api/modules/:id —— 软删
  app.delete<{ Params: { id: string } }>('/api/modules/:id', async (req, reply) => {
    const ok = softDeleteModule(db.db, req.params.id);
    if (!ok) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '模块不存在' } });
    audit(null, 'module:delete', { id: req.params.id });
    return { ok: true, id: req.params.id };
  });

  // POST /api/books/:id/modules/archive —— 拆文批量入库（逐条 SSE module:archived）
  app.post<{ Params: { id: string } }>('/api/books/:id/modules/archive', async (req, reply) => {
    const book = db.db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id) as any;
    if (!book) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
    const body = (req.body ?? {}) as any;
    const units = Array.isArray(body.units) ? body.units : [];
    if (units.length === 0) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'units 不能为空' } });
    const r = archiveModules(db.db, units, {
      sourceBook: book.name,
      batchTags: Array.isArray(body.batch_tags) ? body.batch_tags : [],
      defaultUsableFor: Array.isArray(body.usable_for) ? body.usable_for : [],
    });
    for (const id of r.module_ids) {
      const m = getModule(db.db, id);
      publish(req.params.id, { event: 'module:archived', data: { moduleId: id, title: m?.title ?? '', created: true } });
    }
    audit(req.params.id, 'module:archive', { created: r.created, skipped: r.skipped });
    return { ok: true, created: r.created, skipped_existing: r.skipped, module_ids: r.module_ids };
  });

  // POST /api/books/:id/modules/recommend —— 向导推荐 {genre, kinds}
  app.post<{ Params: { id: string } }>('/api/books/:id/modules/recommend', async (req, reply) => {
    const book = db.db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id) as any;
    if (!book) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
    const body = (req.body ?? {}) as any;
    const r = recommendModules(db.db, { genre: body.genre, kinds: Array.isArray(body.kinds) ? body.kinds : [] });
    return r;
  });

  // POST /api/books/:id/modules/attach —— 注入到该书（usage+1 + used_in + SSE module:attached）
  app.post<{ Params: { id: string } }>('/api/books/:id/modules/attach', async (req, reply) => {
    const book = db.db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id) as any;
    if (!book) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
    const body = (req.body ?? {}) as any;
    const ids = Array.isArray(body.module_ids) ? body.module_ids.map(String) : [];
    if (ids.length === 0) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'module_ids 不能为空' } });
    const r = attachModules(db.db, req.params.id, ids, body.scope ?? 'outline');
    if (r.attached > 0) {
      publish(req.params.id, { event: 'module:attached', data: { novelId: req.params.id, moduleIds: ids.slice(0, r.attached), tokens_est: r.impact.tokens_est } });
    }
    audit(req.params.id, 'module:attach', { module_ids: ids, scope: body.scope ?? 'outline', attached: r.attached });
    return { attached: r.attached, impact: r.impact, annotate: r.annotate };
  });
}

// 路由：拆文工作台（teardown-module.md）—— import-text / analyze
import type { FastifyInstance } from 'fastify';
import type { DbHandle } from '../db/index.ts';
import { importTeardownText, analyzeTeardown } from '../teardown/service.ts';

export interface TeardownRouteCtx { db: DbHandle; workspace: string }

export async function registerTeardownRoutes(app: FastifyInstance, ctx: TeardownRouteCtx): Promise<void> {
  const db = ctx.db;
  const teardownOf = (id: string): any | null => db.db.prepare("SELECT * FROM books WHERE id = ? AND kind = 'teardown'").get(id);
  const audit = (bookId: string, action: string, detail: unknown) => {
    db.db.prepare('INSERT INTO audit (ts, who, action, target, detail_json) VALUES (?,?,?,?,?)')
      .run(new Date().toISOString(), 'user', action, 'book:' + bookId, JSON.stringify(detail ?? {}));
  };

  // POST /api/teardowns/:id/import-text —— 导入原文 → 分章 → 拆文库
  app.post<{ Params: { id: string } }>('/api/teardowns/:id/import-text', async (req, reply) => {
    const t = teardownOf(req.params.id);
    if (!t) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '拆文项目不存在' } });
    const body = (req.body ?? {}) as { text?: string; title?: string };
    if (!body.text) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: '缺少 text' } });
    try {
      const r = importTeardownText(t.dir, t.name, body.text, body.title ?? t.name);
      audit(t.id, 'teardown:import', { chapters: r.chapters });
      return { ok: true, chapters: r.chapters, review: r.review };
    } catch (e: any) {
      return reply.code(400).send({ error: { code: e?.code ?? 'INVALID_INPUT', message: e?.message ?? String(e) } });
    }
  });

  // POST /api/teardowns/:id/analyze —— 确定性拆解 → 拆文库文件 + 可归档模块单元
  app.post<{ Params: { id: string } }>('/api/teardowns/:id/analyze', async (req, reply) => {
    const t = teardownOf(req.params.id);
    if (!t) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '拆文项目不存在' } });
    try {
      const r = analyzeTeardown(t.dir, t.name);
      audit(t.id, 'teardown:analyze', { units: r.units.length, files: r.files.length });
      return { ok: true, units: r.units, files: r.files };
    } catch (e: any) {
      return reply.code(400).send({ error: { code: e?.code ?? 'INVALID_INPUT', message: e?.message ?? String(e) } });
    }
  });
}

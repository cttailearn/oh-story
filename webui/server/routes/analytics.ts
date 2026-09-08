// 分析与检索路由（api-contract §3.12）：/search + /curves/emotion|rhythm
import type { FastifyInstance } from 'fastify';
import type { DbHandle } from '../db/index.ts';
import { searchAll, emotionCurve, rhythmCurve } from '../analytics/service.ts';

export interface AnalyticsRouteCtx { db: DbHandle; workspace: string }

export async function registerAnalyticsRoutes(app: FastifyInstance, ctx: AnalyticsRouteCtx): Promise<void> {
  // GET /api/search?q= —— 全局搜索（分组 + <mark> 命中片段）
  app.get('/api/search', async (req, reply) => {
    const q = ((req.query ?? {}) as any).q ?? '';
    if (!String(q).trim()) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: '缺少 q（搜索词）' } });
    }
    return searchAll(ctx.db.db, String(q));
  });

  // GET /api/books/:id/curves/emotion —— 情绪曲线 {x, series, markers}
  app.get<{ Params: { id: string } }>('/api/books/:id/curves/emotion', async (req, reply) => {
    const book = ctx.db.db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id) as any;
    if (!book) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
    return emotionCurve(book.dir, book.name);
  });

  // GET /api/books/:id/curves/rhythm —— 节奏条带 {x, value[]}
  app.get<{ Params: { id: string } }>('/api/books/:id/curves/rhythm', async (req, reply) => {
    const book = ctx.db.db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id) as any;
    if (!book) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
    return rhythmCurve(book.dir);
  });
}

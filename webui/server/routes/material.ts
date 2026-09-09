// Routes: per-novel writing-material (decompose other books -> module library -> inject).
import type { FastifyInstance } from 'fastify';
import type { DbHandle } from '../db/index.ts';
import { decomposeForNovel, listNovelMaterial } from '../material/service.ts';

export interface MaterialRouteCtx { db: DbHandle; workspace: string }

export async function registerMaterialRoutes(app: FastifyInstance, ctx: MaterialRouteCtx): Promise<void> {
  const db = ctx.db;
  const bookOf = (id: string): any => db.db.prepare('SELECT * FROM books WHERE id = ?').get(id);

  // GET /api/books/:id/material -- modules already injected into this novel
  app.get<{ Params: { id: string } }>('/api/books/:id/material', async (req, reply) => {
    const book = bookOf(req.params.id);
    if (!book) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
    return listNovelMaterial(db.db, req.params.id);
  });

  // POST /api/books/:id/material/decompose -- decompose another book (or pasted text) into
  // material modules, archive them into the library, then attach to this novel.
  app.post<{ Params: { id: string } }>('/api/books/:id/material/decompose', async (req, reply) => {
    const book = bookOf(req.params.id);
    if (!book) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
    if (book.kind === 'teardown') {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: '拆文项目不支持素材加载' } });
    }
    const body = (req.body ?? {}) as { text?: string; title?: string; source_book_id?: string };
    let source: { dir: string; kind: string; name: string } | null = null;
    if (body.source_book_id && body.source_book_id !== req.params.id) {
      const src = bookOf(body.source_book_id);
      if (!src) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '来源书不存在' } });
      source = { dir: src.dir, kind: src.kind, name: src.name };
    }
    if (!source && !body.text) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: '请提供来源书或直接粘贴原文' } });
    }
    try {
      const r = decomposeForNovel(db.db, { id: book.id, dir: book.dir, name: book.name }, {
        title: body.title,
        text: body.text,
        sourceDir: source?.dir,
        sourceKind: source?.kind,
        sourceName: source?.name,
      });
      db.db.prepare('INSERT INTO audit (ts, who, action, target, detail_json) VALUES (?,?,?,?,?)')
        .run(new Date().toISOString(), 'user', 'material:decompose', 'book:' + book.id, JSON.stringify({ source: r.source, chapters: r.chapters, created: r.created, attached: r.attached }));
      return { ok: true, ...r };
    } catch (e: any) {
      const code = e?.code ?? 'INTERNAL';
      const status = code === 'NOT_FOUND' ? 404 : code === 'INVALID_INPUT' ? 400 : 500;
      return reply.code(status).send({ error: { code, message: String(e?.message ?? e) } });
    }
  });
}
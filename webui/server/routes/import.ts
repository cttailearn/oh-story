// 路由：POST /api/import + 导入校对（importing-existing.md M4）
import type { FastifyInstance } from 'fastify';
import type { DbHandle } from '../db/index.ts';
import {
  importNovel,
  applyImportReview,
  importReviewPending,
  type ImportRequest,
  type ReviewApply,
  type ExtractedCandidate,
} from '../import/service.ts';

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
        dir: body.dir,
        text: body.text,
      });
      return r.book ? { book: r.book, review: r.review, duplicate: r.duplicate } : { duplicate: true };
    } catch (e: any) {
      const code = e?.code ?? 'INTERNAL';
      const status = code === 'NOT_FOUND' ? 404 : code === 'INVALID_INPUT' ? 400 : 500;
      return reply.code(status).send({ error: { code, message: String(e?.message ?? e) } });
    }
  });

  // GET /api/books/:id/import-review/status —— 该书是否待校对（锁定 chapter，fail-closed）
  app.get<{ Params: { id: string } }>('/api/books/:id/import-review/status', async (req, reply) => {
    const book = ctx.db.db.prepare('SELECT * FROM books WHERE id=?').get(req.params.id) as any;
    if (!book) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
    let meta: Record<string, unknown> | null = null;
    if (book.meta_json) { try { meta = JSON.parse(book.meta_json); } catch { /* noop */ } }
    const pending = importReviewPending(book.dir, meta);
    // 附属当前候选清单（从 _tracking-state.json 读，供校对页直接复用）
    let review: {
      chapters?: Array<{ no: number; title: string; confidence: number }>;
      characters?: ExtractedCandidate[];
      foreshadow?: ExtractedCandidate[];
      timeline?: ExtractedCandidate[];
    } | null = null;
    const { existsSync, readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const tp = join(book.dir, '追踪', '_tracking-state.json');
    if (existsSync(tp)) {
      try {
        const st = JSON.parse(readFileSync(tp, 'utf8'));
        const asCand = (obj: Record<string, any>, summaryKey: string | null) =>
          Object.entries(obj ?? {}).map(([k, v]: any) => ({
            name: k,
            summary: summaryKey ? v?.[summaryKey] ?? '' : '',
            confidence: v?.confidence ?? 0,
            evidence: v?.evidence ?? [],
            state: v?.state ?? v?.objective_fact ?? v?.summary ?? '',
          }));
        const chDir = join(book.dir, '正文');
        const chapterFiles = existsSync(chDir)
          ? readdirSync(chDir).filter((x) => x.endsWith('.md')).sort()
          : [];
        review = {
          chapters: chapterFiles.map((f) => {
            const m = f.match(/^第(\d+)章/);
            const no = m ? parseInt(m[1]!, 10) : 0;
            const head = existsSync(join(chDir, f))
              ? (readFileSync(join(chDir, f), 'utf8').split(/\r?\n/)[0] ?? '').replace(/^#\s*/, '').replace(/^第\s*\d+\s*章\s*/, '')
              : '';
            return { no, title: head || f.replace(/\.md$/, ''), confidence: head ? 1 : 0.5 };
          }),
          characters: asCand(st?.characters, null),
          foreshadow: asCand(st?.foreshadow, 'summary'),
          timeline: asCand(st?.timeline, 'objective_fact'),
        };
      } catch { /* noop */ }
    }
    return { book_id: book.id, pending, review };
  });

  // POST /api/books/:id/import-review/apply —— 应用校对决策（分章/条目/last_committed）
  app.post<{ Params: { id: string } }>('/api/books/:id/import-review/apply', async (req, reply) => {
    const book = ctx.db.db.prepare('SELECT * FROM books WHERE id=?').get(req.params.id) as any;
    if (!book) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
    const body = (req.body ?? {}) as ReviewApply;
    try {
      const result = applyImportReview(ctx.db.db, { id: book.id, dir: book.dir, name: book.name }, body);
      return { ok: true, ...result };
    } catch (e: any) {
      const code = e?.code ?? 'INTERNAL';
      const status = code === 'NOT_FOUND' ? 404 : code === 'INVALID_INPUT' ? 400 : 500;
      return reply.code(status).send({ error: { code, message: String(e?.message ?? e) } });
    }
  });
}
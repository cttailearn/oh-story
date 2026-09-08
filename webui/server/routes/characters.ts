// 角色卡 / 角色线 REST 路由（api-contract §3.11 / character-card-line §6）
import type { FastifyInstance } from 'fastify';
import type { DbHandle } from '../db/index.ts';
import type { AiRuntime } from '../ai/runtime.ts';
import {
  scanCharacters,
  readRoleLine,
  writeRoleLine,
  applyAdvance,
  activeStage,
} from '../fs/roleLine.ts';
import { runAiEdit } from '../agents/aiEdit.ts';

export interface CharacterRouteCtx {
  db: DbHandle;
  workspace: string;
  ai?: AiRuntime;
}

export async function registerCharacterRoutes(app: FastifyInstance, ctx: CharacterRouteCtx): Promise<void> {
  const db = ctx.db;
  const bookOf = (id: string): any | null => db.db.prepare('SELECT * FROM books WHERE id = ?').get(id);
  const audit = (bookId: string, action: string, detail: unknown): number => {
    const r = db.db
      .prepare('INSERT INTO audit (ts, who, action, target, detail_json) VALUES (?,?,?,?,?)')
      .run(new Date().toISOString(), 'user', action, 'book:' + bookId, JSON.stringify(detail ?? {}));
    return r.lastInsertRowid as number;
  };

  // GET /api/books/:id/characters —— 角色卡列表（红线计数 + 线关联）
  app.get<{ Params: { id: string } }>('/api/books/:id/characters', async (req, reply) => {
    const book = bookOf(req.params.id);
    if (!book) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
    return { book_id: book.id, items: scanCharacters(book.dir) };
  });

  // GET /api/books/:id/characters/:name/arc —— 角色线：阶段/进度指针/审计
  app.get<{ Params: { id: string; name: string } }>('/api/books/:id/characters/:name/arc', async (req, reply) => {
    const book = bookOf(req.params.id);
    if (!book) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
    const r = readRoleLine(book.dir, req.params.name);
    if (!r.line) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '该角色暂无角色线（运行 characters 阶段或先 propose/advance）' } });
    return {
      name: req.params.name,
      path: r.rel,
      arc: {
        stages: r.line.stages.map((s) => ({ no: s.no, title: s.title, range: s.range, status: s.status, goals: s.goals, acceptance: s.acceptance, evidence: s.evidence })),
        current: activeStage(r.line),
        progress: r.line.progressPointer,
        audit: r.line.audit,
      },
    };
  });

  // PUT /api/books/:id/characters/:name/arc —— 推进阶段/改验收（写线文件 + audit）
  app.put<{ Params: { id: string; name: string } }>('/api/books/:id/characters/:name/arc', async (req, reply) => {
    const book = bookOf(req.params.id);
    if (!book) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
    const body = (req.body ?? {}) as any;
    const toStage = Number(body.to_stage);
    if (!Number.isInteger(toStage) || toStage < 1) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: '缺少合法 to_stage（正整数）' } });
    }
    const r = readRoleLine(book.dir, req.params.name);
    if (!r.line) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '该角色暂无角色线文件' } });
    const next = applyAdvance(r.line, {
      to_stage: toStage,
      to_status: body.to_status === 'active' ? 'active' : 'done',
      acceptance_done: Array.isArray(body.acceptance_done) ? body.acceptance_done.map(String) : [],
      confirm_through_chapter: body.confirm_through_chapter !== undefined ? Number(body.confirm_through_chapter) : undefined,
      note: body.note ? String(body.note) : undefined,
    });
    try {
      writeRoleLine(book.dir, req.params.name, next);
    } catch (e: any) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: '写线文件失败：' + String(e?.message ?? e) } });
    }
    const cur = activeStage(next);
    const auditId = audit(book.id, 'arc:advance', { name: req.params.name, to_stage: toStage, to_status: body.to_status ?? 'done', note: body.note ?? '' });
    return { ok: true, arc: { current_stage: cur?.no ?? toStage, status: cur?.status ?? 'done', audit: 'pending(卷末回填)' }, audit_id: 'au_' + auditId };
  });

  // POST /api/books/:id/characters/:name/arc/propose —— AI 提议下阶段（diff 草案，人工采纳）
  app.post<{ Params: { id: string; name: string } }>('/api/books/:id/characters/:name/arc/propose', async (req, reply) => {
    const book = bookOf(req.params.id);
    if (!book) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
    if (!ctx.ai) return reply.code(503).send({ error: { code: 'CHANNEL_UNCONFIGURED', message: 'AI 运行时未装配' } });
    const r = readRoleLine(book.dir, req.params.name);
    if (!r.line || !r.rel) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '该角色暂无角色线文件' } });
    const body = (req.body ?? {}) as any;
    const fake = body.fake ?? process.env.WEBUI_FAKE_MODE === '1';
    try {
      const result = await runAiEdit(ctx.ai, { bookId: book.id, bookDir: book.dir, bookName: book.name }, {
        mode: 'rewrite',
        target: { path: r.rel },
        demand: { kind: 'arc', custom: (body.hint ? '当前困境：' + String(body.hint) + '。' : '') + '请为当前角色规划下一阶段弧线（阶段目标/三层目标/验收/渐变轨迹），保持既有阶段编号连续。' },
        model_role: (body.model_role as any) ?? 'architect',
        fake,
      });
      const parsed = readRoleLine(book.dir, req.params.name);
      audit(book.id, 'arc:propose', { name: req.params.name, edit_id: result.edit_id });
      return {
        proposal: {
          current: parsed.line ? activeStage(parsed.line) : { no: 1, status: 'planned' },
          next_stage: result.note,
          hint: body.hint ?? null,
        },
        diff: result.diff,
        applied: false,
        edit_id: result.edit_id,
      };
    } catch (e: any) {
      const code = e?.code ?? 'INTERNAL';
      if (code === 'NOT_FOUND') return reply.code(404).send({ error: { code, message: e.message } });
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: e?.message ?? String(e) } });
    }
  });
}

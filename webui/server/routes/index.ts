// REST 路由（api-contract v0.1 M0 子集：books / tree / files / tracking / config / health / jobs / audit）
import type { FastifyInstance } from 'fastify';
import type { DbHandle } from '../db/index.ts';
import { ulid } from '../db/index.ts';
import * as fileio from '../fs/index.ts';
import * as cfgmgr from '../config/index.ts';

export interface RouteCtx {
  db: DbHandle;
  workspace: string;
}

interface BookRow {
  id: string;
  name: string;
  dir: string;
  kind: string;
  pipeline_id: string | null;
  pipeline_version: number | null;
  theme_color: string | null;
  active_stage: string | null;
  meta_json: string | null;
  created_at: string;
  updated_at: string;
}

const nowIso = () => new Date().toISOString();

function rowToBook(r: BookRow) {
  return {
    id: r.id,
    name: r.name,
    dir: r.dir,
    kind: r.kind,
    pipeline: r.pipeline_id,
    pipeline_version: r.pipeline_version,
    theme_color: r.theme_color,
    active_stage: r.active_stage,
    meta: r.meta_json ? safeParse(r.meta_json) : null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function publicBook(row: BookRow) {
  const b = rowToBook(row);
  delete (b as any).meta;
  return b;
}

type Params1 = { id: string };
type Params2 = { id: string; stage: string };

export async function registerRoutes(
  app: FastifyInstance,
  ctx: RouteCtx,
): Promise<void> {
  const { db } = ctx;

  // ---------- Health ----------
  app.get('/api/health', async () => {
    return {
      ok: true,
      version: '0.1.0-m0',
      node: process.version,
      db: { user_version: db.user_version },
      no_python: true,
    };
  });

  // ---------- Books ----------
  app.get('/api/books', async () => {
    const rows = db.db
      .prepare(
        `SELECT * FROM books ORDER BY updated_at DESC`,
      )
      .all() as BookRow[];
    return { items: rows.map(publicBook), total: rows.length };
  });

  app.get<{ Params: Params1 }>('/api/books/:id', async (req, reply) => {
    const row = db.db.prepare(`SELECT * FROM books WHERE id = ?`).get(req.params.id) as
      | BookRow
      | undefined;
    if (!row) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
    // 流程缩略
    const stages = db.db
      .prepare(`SELECT stage_id, status, revision FROM stages WHERE book_id = ? ORDER BY rowid`)
      .all(row.id);
    return { ...rowToBook(row), stages };
  });

  app.post('/api/books', async (req, reply) => {
    const body = (req.body ?? {}) as {
      name?: string;
      type?: string;
      theme_color?: string;
      dir?: string;
    };
    const name = (body.name ?? '').trim();
    if (!name) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: '缺少 name', detail: { field: 'name' } } });
    }
    const kind = body.type === 'teardown' ? 'teardown' : 'novel-project';
    const theme_color = body.theme_color ?? '#B8860B';
    const id = ulid('bk');
    // 目录：默认 <workspace>/<name>；允许显式 dir（用于注册 demo）
    const bookDir = body.dir ? fileio.resolveSafe(ctx.workspace, body.dir) : fileio.resolveSafe(ctx.workspace, name);
    const ts = nowIso();
    try {
      db.db
        .prepare(
          `INSERT INTO books (id, name, dir, kind, pipeline_id, pipeline_version, theme_color, active_stage, meta_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, name, bookDir, kind, null, null, theme_color, null, '{}', ts, ts);
    } catch (e: any) {
      if (String(e?.code ?? '').includes('UNIQUE')) {
        return reply.code(409).send({ error: { code: 'CONFLICT', message: '同名项目/目录已存在', detail: { dir: bookDir } } });
      }
      throw e;
    }
    const row = db.db.prepare(`SELECT * FROM books WHERE id = ?`).get(id) as BookRow;
    return reply.code(201).send({ ...rowToBook(row), stages: [] });
  });

  app.delete<{ Params: Params1 }>('/api/books/:id', async (req, reply) => {
    const row = db.db.prepare(`SELECT * FROM books WHERE id = ?`).get(req.params.id) as BookRow | undefined;
    if (!row) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
    // M0：仅从库移除 + audit 留痕，目录保留（不硬删；归档到 _archive/ 属 M4）
    db.db.prepare(`DELETE FROM books WHERE id = ?`).run(req.params.id);
    db.db
      .prepare(`INSERT INTO audit (ts, who, action, target, detail_json) VALUES (?,?,?,?,?)`)
      .run(nowIso(), 'user', 'delete', `book:${req.params.id}`, JSON.stringify({ name: row.name }));
    return { ok: true };
  });

  // ---------- 文件树 ----------
  app.get<{ Params: Params1 }>('/api/books/:id/tree', async (req, reply) => {
    const row = db.db.prepare(`SELECT * FROM books WHERE id = ?`).get(req.params.id) as BookRow | undefined;
    if (!row) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
    const qp = req.query as { path?: string };
    const rel = qp.path ?? '';
    try {
      const tree = fileio.readTree(row.dir, rel);
      return { book_id: row.id, path: rel, tree };
    } catch (e: any) {
      if (e?.message === 'INVALID_PATH') {
        return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: '非法路径' } });
      }
      throw e;
    }
  });

  // ---------- 文件读写 ----------
  app.get('/api/files', async (req, reply) => {
    const qp = req.query as { path?: string; book_id?: string };
    if (!qp.path) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: '缺少 path' } });
    const book = bookForPath(ctx, qp.book_id, reply);
    if (!book) return reply; // 已响应
    try {
      const { content, mtime } = fileio.readText(book.dir, qp.path);
      return { path: qp.path, content, mtime: Math.round(mtime), size: content.length };
    } catch (e: any) {
      if (e?.code === 'NOT_FOUND') {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '文件不存在' } });
      }
      if (e?.message === 'INVALID_PATH') {
        return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: '非法路径' } });
      }
      throw e;
    }
  });

  app.put('/api/files', async (req, reply) => {
    const body = (req.body ?? {}) as { path?: string; content?: string; mtime?: number | null; book_id?: string };
    if (!body.path || body.content === undefined) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: '缺少 path/content' } });
    }
    const book = bookForPath(ctx, body.book_id, reply);
    if (!book) return reply;
    try {
      const expected = body.mtime == null ? null : Math.round(body.mtime as number);
      const { mtime } = fileio.writeTextLocked(book.dir, body.path, body.content, expected);
      db.db
        .prepare(`INSERT INTO audit (ts, who, action, target, detail_json) VALUES (?,?,?,?,?)`)
        .run(nowIso(), 'user', 'file-write', `book:${book.id}`,
          JSON.stringify({ path: body.path, size: body.content.length }));
      const st = fileio.fileStat(book.dir, body.path);
      return { path: body.path, mtime: Math.round(st.mtime), size: st.size };
    } catch (e: any) {
      if (e?.code === 'CONFLICT') {
        return reply.code(409).send({ error: { code: 'CONFLICT', message: e.message, detail: e?.detail } });
      }
      if (e?.message === 'INVALID_PATH') {
        return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: '非法路径' } });
      }
      if (e?.code === 'NOT_FOUND') {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '文件不存在' } });
      }
      throw e;
    }
  });

  // ---------- 追踪状态投影（只读） ----------
  app.get<{ Params: Params1 }>('/api/books/:id/tracking', async (req, reply) => {    const row = db.db.prepare(`SELECT * FROM books WHERE id = ?`).get(req.params.id) as BookRow | undefined;
    if (!row) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
    const trackPath = '追踪/_tracking-state.json';
    try {
      const { content } = fileio.readText(row.dir, trackPath);
      const raw = JSON.parse(content);
      return {
        book_title: row.name,
        ...raw,
        sourcePath: trackPath,
      };
    } catch (e: any) {
      if (e?.code === 'NOT_FOUND') {
        return reply.code(404).send({
          error: { code: 'NOT_FOUND', message: '无追踪状态（该书尚未初始化追踪文件）' },
        });
      }
      throw e;
    }
  });

  // ---------- 阶段（管线视图 + 每步确认，M0 基础交互；引擎 M1 实装） ----------
  app.get<{ Params: Params1 }>('/api/books/:id/stages', async (req, reply) => {
    const row = db.db.prepare(`SELECT * FROM books WHERE id = ?`).get(req.params.id) as BookRow | undefined;
    if (!row) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
    const stages = db.db
      .prepare(`SELECT stage_id, status, revision, started_at, reviewed_at, note FROM stages WHERE book_id = ? ORDER BY rowid`)
      .all(row.id);
    return { book_id: row.id, stages };
  });

  app.post<{ Params: Params2 }>('/api/books/:id/stages/:stage/review', async (req, reply) => {
    const row = db.db.prepare(`SELECT * FROM books WHERE id = ?`).get(req.params.id) as BookRow | undefined;
    if (!row) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
    const stageId = String(req.params.stage);
    const body = (req.body ?? {}) as { action?: string; note?: string; edits?: Record<string, string> };
    const action = body.action;
    if (!['approve', 'edit_rerun', 'reject_regen', 'skip'].includes(action ?? '')) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: '无效 action' } });
    }
    const ts = nowIso();
    // M0：仅记录 audit + 状态推进（approve→done 推进到下一个已存在 stage）
    db.db
      .prepare(`INSERT INTO audit (ts, who, action, target, detail_json) VALUES (?,?,?,?,?)`)
      .run(ts, 'user', action, `book:${row.id}/stage:${stageId}`, JSON.stringify({ note: body.note ?? '', edits: body.edits ?? null }));
    const existing = db.db
      .prepare(`SELECT * FROM stages WHERE book_id = ? AND stage_id = ?`)
      .get(row.id, stageId) as any;
    if (action === 'approve' && existing) {
      db.db
        .prepare(`UPDATE stages SET status='done', reviewed_at=? WHERE book_id=? AND stage_id=?`)
        .run(ts, row.id, stageId);
      // 推进到下一 pending 阶段
      const next = db.db
        .prepare(`SELECT stage_id FROM stages WHERE book_id=? AND status IN ('pending') ORDER BY rowid LIMIT 1`)
        .get(row.id) as any;
      if (next) {
        db.db.prepare(`UPDATE stages SET status='review', started_at=? WHERE book_id=? AND stage_id=?`).run(ts, row.id, next.stage_id);
        db.db.prepare(`UPDATE books SET active_stage=?, updated_at=? WHERE id=?`).run(next.stage_id, ts, row.id);
      } else {
        db.db.prepare(`UPDATE books SET updated_at=? WHERE id=?`).run(ts, row.id);
      }
    } else if (action === 'edit_rerun' || action === 'reject_regen') {
      // 回到 running（M0 演示：状态转移由 M1 引擎接管）
      if (existing) {
        db.db
          .prepare(`UPDATE stages SET status='running', started_at=? WHERE book_id=? AND stage_id=?`)
          .run(ts, row.id, stageId);
      }
    } else if (action === 'skip') {
      if (existing) {
        db.db
          .prepare(`UPDATE stages SET status='skipped', reviewed_at=? WHERE book_id=? AND stage_id=?`)
          .run(ts, row.id, stageId);
      }
    }
    const auditId = (db.db.prepare(`SELECT MAX(id) AS m FROM audit`).get() as any).m;
    return {
      stage: stageId,
      status: action === 'approve' ? 'done' : action === 'skip' ? 'skipped' : 'running',
      next: null,
      audit_id: `au_${auditId}`,
    };
  });

  // ---------- 配置 ----------
  app.get('/api/config', async () => {
    const cfg = cfgmgr.getConfig();
    // 掩码 api_key
    const safe = {
      ...cfg,
      channels: cfg.channels.map((c) => ({
        ...c,
        api_key: c.api_key ? maskSecret(c.api_key) : undefined,
      })),
    };
    return safe;
  });

  app.put('/api/config', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: '配置无效' } });
    }
    const updated = cfgmgr.updateConfig((cfg) => {
      // 仅允许白名单字段更新（避免覆盖密钥）
      if (Array.isArray(body.channels)) {
        cfg.channels = (body.channels as any[]).map((c) => ({
          id: String(c.id ?? ''),
          name: String(c.name ?? ''),
          base_url: String(c.base_url ?? ''),
          models: Array.isArray(c.models) ? c.models.map(String) : [],
          image_models: Array.isArray(c.image_models) ? c.image_models.map(String) : undefined,
          enabled: c.enabled !== false,
          api_key: c.api_key ? String(c.api_key) : undefined,
        }));
      }
      if (body.model_routing && typeof body.model_routing === 'object') {
        cfg.model_routing = body.model_routing as Record<string, { channel: string; model: string }>;
      }
      if (body.budget && typeof body.budget === 'object') {
        cfg.budget = { ...cfg.budget, ...(body.budget as object) };
      }
      if (body.prefs && typeof body.prefs === 'object') {
        cfg.prefs = { ...cfg.prefs, ...(body.prefs as object) };
      }
      return cfg;
    });
    const safe = { ...updated, channels: updated.channels.map((c) => ({ ...c, api_key: c.api_key ? maskSecret(c.api_key) : undefined })) };
    return safe;
  });

  // ---------- Jobs（M0 基础：历史列表） ----------
  app.get('/api/jobs', async (req) => {
    const qp = req.query as { book_id?: string; limit?: string };
    const limit = Math.min(Number(qp.limit ?? 50) || 50, 200);
    const rows = (qp.book_id
      ? db.db.prepare(`SELECT * FROM jobs WHERE book_id = ? ORDER BY created_at DESC LIMIT ?`).all(qp.book_id, limit)
      : db.db.prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`).all(limit)) as any[];
    return { items: rows, total: rows.length };
  });

  // ---------- Audit ----------
  app.get('/api/audit', async (req) => {
    const qp = req.query as { limit?: string; target?: string };
    const limit = Math.min(Number(qp.limit ?? 100) || 100, 500);
    const rows = (qp.target
      ? db.db.prepare(`SELECT * FROM audit WHERE target LIKE ? ORDER BY id DESC LIMIT ?`).all(`%${qp.target}%`, limit)
      : db.db.prepare(`SELECT * FROM audit ORDER BY id DESC LIMIT ?`).all(limit)) as any[];
    return { items: rows, total: rows.length };
  });
}

function maskSecret(secret: string): string {
  if (secret.length <= 8) return '****';
  return `${secret.slice(0, 4)}****${secret.slice(-4)}`;
}

/** 解析 book 目录：优先 book_id，否则用 query 的 book_id */
function bookForPath(ctx: RouteCtx, bookId: string | undefined, reply: any): BookRow | null {
  if (!bookId) {
    reply.code(400).send({ error: { code: 'INVALID_INPUT', message: '缺少 book_id（文件属某书目录）' } });
    return null;
  }
  const row = ctx.db.db.prepare(`SELECT * FROM books WHERE id = ?`).get(bookId) as BookRow | undefined;
  if (!row) {
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
    return null;
  }
  return row;
}

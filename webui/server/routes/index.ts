// REST 路由（api-contract v0.1 M0 子集：books / tree / files / tracking / config / health / jobs / audit）
import type { FastifyInstance } from 'fastify';
import type { DbHandle } from '../db/index.ts';
import { ulid } from '../db/index.ts';
import * as fileio from '../fs/index.ts';
import * as cfgmgr from '../config/index.ts';
import { runAiEdit, type AiEditRequest } from '../agents/aiEdit.ts';
import { publish } from '../engine/sse.ts';
import { seedNovelRequirements, type NovelRequirements } from '../fs/seed.ts';
import { classifyModels, parseModelList, modelsUrl, type ModelCatalog } from '../config/models.ts';

const EMPTY_CATALOG: ModelCatalog = { models: [], chat: [], image: [], other: [] };

export interface RouteCtx {
  db: DbHandle;
  workspace: string;
  ai?: import('../ai/runtime.ts').AiRuntime;
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
  app.get('/api/health', async (req) => {
    const qp = req.query as { depth?: string };
    if (qp.depth === 'full') {
      // ops-observability §2 / scale-performance §6：完整诊断
      const cfg = cfgmgr.getConfig();
      const { collectHealthDeep } = await import('../ops/service.ts');
      const deep = collectHealthDeep(db.db, {
        dbPath: db.path,
        workspace: ctx.workspace,
        channels: cfg.channels,
        lastTested: ((cfg.prefs as any)?.last_tested ?? {}) as Record<string, string>,
      });
      return { ...deep, db: { ...deep.db, user_version: db.user_version } };
    }
    return {
      ok: true,
      version: '0.1.0-m4',
      node: process.version,
      db: { user_version: db.user_version },
      no_python: true,
    };
  });

  // ---------- Workspace dirs (new-project wizard save-location picker) ----------
  app.get('/api/workspace/dirs', async () => {
    const excluded = ['node_modules', 'dist', 'docs', 'tests', 'scripts', '_archive', '.tmp-ui-shots', 'webui', '.github', 'skills', 'extensions', 'demo'];
    const items = fileio.collectDirs(ctx.workspace, 2, excluded);
    return { workspace: ctx.workspace, items };
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
      pipeline?: string;
      requirements?: NovelRequirements;
    };
    const name = (body.name ?? '').trim();
    if (!name) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: '缺少 name', detail: { field: 'name' } } });
    }
    const kind = body.type === 'teardown' ? 'teardown' : body.type === 'novel' ? 'novel' : 'novel-project';
    const pipeline = kind === 'novel' && (body.pipeline === 'long' || body.pipeline === 'short') ? body.pipeline : null;
    const theme_color = body.theme_color ?? '#B8860B';
    const id = ulid('bk');
    // 目录：默认 <workspace>/<name>；新建向导可显式选择相对工作区的保存目录
    let bookDir: string;
    try {
      bookDir = body.dir ? fileio.resolveSafe(ctx.workspace, body.dir) : fileio.resolveSafe(ctx.workspace, name);
    } catch (e: any) {
      if (e?.message === 'INVALID_PATH') {
        return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: '\u4fdd\u5b58\u76ee\u5f55\u975e\u6cd5\uff08\u9700\u4e3a\u5de5\u4f5c\u533a\u5185\u76f8\u5bf9\u8def\u5f84\uff09', detail: { dir: body.dir } } });
      }
      throw e;
    }
    const ts = nowIso();
    try {
      db.db
        .prepare(
          `INSERT INTO books (id, name, dir, kind, pipeline_id, pipeline_version, theme_color, active_stage, meta_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, name, bookDir, kind, pipeline, kind === 'novel' ? 1 : null, theme_color, null, '{}', ts, ts);
    } catch (e: any) {
      if (String(e?.code ?? '').includes('UNIQUE')) {
        return reply.code(409).send({ error: { code: 'CONFLICT', message: '同名项目/目录已存在', detail: { dir: bookDir } } });
      }
      throw e;
    }
    const row = db.db.prepare(`SELECT * FROM books WHERE id = ?`).get(id) as BookRow;
    // 新建小说：需求表单种子落盘（设定/题材定位.md + 文风.md）
    if (kind === 'novel' && body.requirements) {
      try {
        seedNovelRequirements(bookDir, body.requirements, name);
        db.db
          .prepare(`INSERT INTO audit (ts, who, action, target, detail_json) VALUES (?,?,?,?,?)`)
          .run(nowIso(), 'user', 'novel:seed', `book:${id}`, JSON.stringify({ pipeline }));
      } catch (e: any) {
        // 种子落盘失败不阻断建书（可后补）
        app.log.warn({ err: e, id }, 'seed requirements failed');
      }
    }
    return reply.code(201).send({ ...rowToBook(row), stages: [] });
  });

  app.delete<{ Params: Params1 }>('/api/books/:id', async (req, reply) => {
    const row = db.db.prepare(`SELECT * FROM books WHERE id = ?`).get(req.params.id) as BookRow | undefined;
    if (!row) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
    // M4（ops §4）：删除 = 软删 —— 目录移入 workspace/_archive/ 再从库移除，可 relink 恢复
    const { deleteToArchive } = await import('../ops/service.ts');
    const { archivedDir } = deleteToArchive(db.db, { id: row.id, name: row.name, dir: row.dir }, ctx.workspace);
    return { ok: true, archived: archivedDir, hint: '已移入 ' + (archivedDir ?? '（无目录）') + '，可在设置→恢复 用 relink 找回' };
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
        // 密钥语义见 mergeChannels：GET 回显的掩码值不得写回（曾把 sk-a****z 存成真实密钥），
        // 未提供 = 保留既有，'' = 显式清空，其它 = 覆盖
        cfg.channels = cfgmgr.mergeChannels(cfg.channels, body.channels as unknown[]);
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
    // M4：保存后热同步渠道到 AI 运行时（无需重启即对模型生效）
    if (ctx.ai) {
      try { ctx.ai.syncChannels(); } catch (e: any) { app.log.warn({ err: e }, 'channel sync failed'); }
    }
    const safe = { ...updated, channels: updated.channels.map((c) => ({ ...c, api_key: c.api_key ? maskSecret(c.api_key) : undefined })) };
    return safe;
  });

  // ---------- 渠道模型目录探测（设置页：填 base_url + key → 获取可用模型 → 勾选） ----------
  // 保存前即可调用；api_key 缺省时回退到该渠道已存密钥；密钥只用于请求上游，绝不回显。
  app.post('/api/config/channels/probe', async (req, reply) => {
    const body = (req.body ?? {}) as { base_url?: string; api_key?: string; id?: string };
    const baseUrl = String(body.base_url ?? '').trim().replace(/\/+$/, '');
    if (!baseUrl) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: '缺少 base_url' } });
    }
    if (!/^https?:\/\//i.test(baseUrl)) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'base_url 需以 http:// 或 https:// 开头' } });
    }
    const stored = body.id ? cfgmgr.getConfig().channels.find((c) => c.id === body.id)?.api_key : undefined;
    const typed = String(body.api_key ?? '').trim();
    const apiKey = typed && !cfgmgr.isMaskedSecret(typed) ? typed : stored;

    const url = modelsUrl(baseUrl);
    const started = Date.now();
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      const pingMs = Date.now() - started;
      const text = await res.text();
      let payload: unknown = null;
      try {
        payload = JSON.parse(text);
      } catch {
        return reply.send({
          ok: false,
          status: res.status,
          ping_ms: pingMs,
          msg: res.ok ? '上游 /models 未返回 JSON（该网关可能不支持模型目录，请手填模型名）' : `HTTP ${res.status}`,
          detail: text.slice(0, 200),
          ...EMPTY_CATALOG,
        });
      }
      if (!res.ok) {
        const upstreamMsg = (payload as { error?: { message?: string } })?.error?.message;
        return reply.send({
          ok: false,
          status: res.status,
          ping_ms: pingMs,
          msg: `HTTP ${res.status}${upstreamMsg ? '：' + upstreamMsg : ''}`,
          ...EMPTY_CATALOG,
        });
      }
      const catalog = classifyModels(parseModelList(payload));
      if (catalog.models.length === 0) {
        return reply.send({
          ok: false,
          status: res.status,
          ping_ms: pingMs,
          msg: '连通正常，但 /models 未返回可解析的模型列表（请手填模型名）',
          ...EMPTY_CATALOG,
        });
      }
      return reply.send({
        ok: true,
        status: res.status,
        ping_ms: pingMs,
        msg: `获取到 ${catalog.models.length} 个模型（对话 ${catalog.chat.length} / 图像 ${catalog.image.length} / 其它 ${catalog.other.length}）`,
        ...catalog,
      });
    } catch (e: any) {
      return reply.send({
        ok: false,
        ping_ms: Date.now() - started,
        msg: `请求失败：${e?.name === 'TimeoutError' ? '超时（10s）' : (e?.message ?? String(e))}`,
        ...EMPTY_CATALOG,
      });
    }
  });

  // ---------- 渠道连通性自检（M1.8，api-contract §3.8） ----------
  app.post<{ Params: { id: string } }>('/api/config/channels/:id/test', async (req, reply) => {
    const cfg = cfgmgr.getConfig();
    const ch = cfg.channels.find((c) => c.id === req.params.id);
    if (!ch) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '渠道不存在' } });
    if (!ch.base_url) {
      return reply.send({ ok: false, msg: '缺少 base_url', llm: {}, images: {} });
    }
    const started = Date.now();
    try {
      // 探 /models 拉取模型目录
      const url = ch.base_url.replace(/\/+$/, '') + '/models';
      const headers: Record<string, string> = {};
      if (ch.api_key) headers['Authorization'] = `Bearer ${ch.api_key}`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
      const pingMs = Date.now() - started;
      if (!res.ok) {
        return reply.send({
          ok: false,
          msg: `连通失败 HTTP ${res.status}`,
          llm: { ping_ms: pingMs },
          images: {},
        });
      }
      const data = (await res.json()) as any;
      const modelIds = Array.isArray(data?.data)
        ? data.data.map((m: any) => m?.id).filter(Boolean)
        : Array.isArray(data?.models)
          ? data.models.map((m: any) => (typeof m === 'string' ? m : m?.id)).filter(Boolean)
          : [];
      // 记录最近测试时间（health?depth=full 展示）
      const cfg = cfgmgr.getConfig();
      const lastTested = { ...(((cfg.prefs as any)?.last_tested ?? {}) as Record<string, string>) };
      lastTested[ch.id] = new Date().toISOString();
      cfgmgr.updateConfig((c) => ({ ...c, prefs: { ...c.prefs, last_tested: lastTested } }));
      return reply.send({
        ok: true,
        llm: { models: modelIds.length, ping_ms: pingMs },
        images: { ok: false },
        msg: `渠道可用（${modelIds.length} 模型）`,
        models: modelIds,
        tested_at: lastTested[ch.id],
      });
    } catch (e: any) {
      return reply.send({
        ok: false,
        msg: `连通失败：${e?.message ?? String(e)}`,
        llm: { ping_ms: Date.now() - started },
        images: {},
      });
    }
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

  // ---------- AI 需求式编辑（agents-runtime §4 / ai-edit-spec） ----------
  app.post<{ Params: Params1 }>('/api/books/:id/ai-edit', async (req, reply) => {
    const row = db.db.prepare(`SELECT * FROM books WHERE id = ?`).get(req.params.id) as BookRow | undefined;
    if (!row) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
    if (!ctx.ai) return reply.code(503).send({ error: { code: 'CHANNEL_UNCONFIGURED', message: 'AI 运行时未装配' } });
    const body = (req.body ?? {}) as Partial<AiEditRequest>;
    const mode = body.mode ?? 'rewrite';
    if (!['rewrite', 'insert', 'fix-gates'].includes(mode)) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: '未知 mode', detail: { mode } } });
    }
    const demand = body.demand ?? { kind: 'custom' };
    if (!demand || typeof demand !== 'object' || !demand.kind) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: '缺少 demand.kind' } });
    }
    const fake = (body as AiEditRequest).fake ?? process.env.WEBUI_FAKE_MODE === '1';
    try {
      const result = await runAiEdit(ctx.ai, { bookId: row.id, bookDir: row.dir, bookName: row.name }, {
        mode: mode as AiEditRequest['mode'],
        target: (body.target === 'new' ? 'new' : body.target) as AiEditRequest['target'],
        demand,
        refs: body.refs,
        model_role: body.model_role,
        tone: body.tone,
        intensity: body.intensity,
        fake,
      });
      db.db
        .prepare(`INSERT INTO audit (ts, who, action, target, detail_json) VALUES (?,?,?,?,?)`)
        .run(nowIso(), 'user', 'ai-edit:request', `book:${row.id}`, JSON.stringify({ edit_id: result.edit_id, mode: result.mode, target: result.target, diff: result.diff.length }));
      // SSE：diff 流式回执（api-contract §4 edit:diff）
      publish(row.id, { event: 'edit:diff', data: { editId: result.edit_id, diff: result.diff } });
      return reply.send(result);
    } catch (e: any) {
      const code = e?.code ?? 'INTERNAL';
      if (code === 'NOT_FOUND') return reply.code(404).send({ error: { code, message: e.message } });
      if (code === 'CHANNEL_UNCONFIGURED' || code === 'MODEL_ROUTING_MISSING') {
        return reply.code(503).send({ error: { code: 'CHANNEL_UNCONFIGURED', message: e.message } });
      }
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: e?.message ?? String(e) } });
    }
  });

  // ---------- Audit ----------
  app.get('/api/audit', async (req) => {
    // M4（ops）：复用 queryAudit 支持 action/target/from/to 筛选
    const q = req.query as import('../ops/service.ts').AuditFilter;
    const { queryAudit } = await import('../ops/service.ts');
    const rows = queryAudit(db.db, q);
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
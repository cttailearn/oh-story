// 模块库服务（teardown-module §4 + api-contract §3.10）
import Database from 'better-sqlite3';
type Sqlite = InstanceType<typeof Database>;

export type ModuleKind = 'plot' | 'emotion' | 'rhythm' | 'hook' | 'character-trait' | 'worldbuilding';
const KINDS: ModuleKind[] = ['plot', 'emotion', 'rhythm', 'hook', 'character-trait', 'worldbuilding'];

export interface ModuleUnit {
  kind: ModuleKind;
  title: string;
  summary?: string;
  body: string;
  tags?: string[];
  usable_for?: string[];
  source_path?: string;
}

function safeJson(v: string | null | undefined, dflt: unknown): unknown {
  if (!v) return dflt;
  try { return JSON.parse(v); } catch { return dflt; }
}
function toJson(v: unknown): string { return JSON.stringify(v ?? []); }
function moduleId(): string {
  return 'md_' + Date.now().toString(36).padStart(10, '0') + Math.random().toString(36).slice(2, 10).padEnd(8, '0');
}

function parseRow(r: any): any {
  return {
    ...r,
    tags: safeJson(r.tags, []) as string[],
    usable_for: safeJson(r.usable_for, []) as string[],
    used_in: safeJson(r.used_in_json, []) as any[],
  };
}

/** 列表：kind/tag/usable_for/source 过滤 + 排序 + 分页 */
export function listModules(db: Sqlite, f: any = {}): { items: any[]; total: number } {
  const where: string[] = ['deleted_at IS NULL'];
  const args: unknown[] = [];
  if (f.kind && KINDS.includes(f.kind as ModuleKind)) { where.push('kind = ?'); args.push(f.kind); }
  if (f.tag) { where.push('tags LIKE ?'); args.push('%"' + f.tag + '"%'); }
  if (f.usable_for) { where.push('usable_for LIKE ?'); args.push('%"' + f.usable_for + '"%'); }
  if (f.source) { where.push('source LIKE ?'); args.push('%' + f.source + '%'); }
  const order = ({ usage: 'usage_count DESC', newest: 'created_at DESC', title: 'title COLLATE NOCASE ASC' } as any)[f.sort ?? 'newest'] ?? 'created_at DESC';
  const limit = Math.min(f.limit ?? 50, 200);
  const offset = f.offset ?? 0;
  const sql = 'SELECT * FROM modules WHERE ' + where.join(' AND ') + ' ORDER BY ' + order + ' LIMIT ' + limit + ' OFFSET ' + offset;
  const cnt = 'SELECT COUNT(*) c FROM modules WHERE ' + where.join(' AND ');
  const total = (db.prepare(cnt).get(...args) as { c: number }).c;
  const rows = db.prepare(sql).all(...args) as any[];
  return { items: rows.map(parseRow), total };
}

/**
 * 读取模块。includeDeleted 默认 true（服务层原始访问，保留软删行供审计）；
 * REST 层一律传 false —— 软删的模块不得再被读取/编辑（否则「软删」对外等于没删）。
 */
export function getModule(db: Sqlite, id: string, includeDeleted = true): any | null {
  const sql = includeDeleted
    ? 'SELECT * FROM modules WHERE id = ?'
    : 'SELECT * FROM modules WHERE id = ? AND deleted_at IS NULL';
  const r = db.prepare(sql).get(id);
  return r ? parseRow(r) : null;
}

export function updateModule(db: Sqlite, id: string, patch: any): any | null {
  if (!getModule(db, id, false)) return null;
  const now = new Date().toISOString();
  if (patch.title !== undefined) db.prepare('UPDATE modules SET title = ? WHERE id = ?').run(patch.title, id);
  if (patch.summary !== undefined) db.prepare('UPDATE modules SET summary = ? WHERE id = ?').run(patch.summary, id);
  if (patch.body !== undefined) db.prepare('UPDATE modules SET body = ? WHERE id = ?').run(patch.body, id);
  if (Array.isArray(patch.tags)) db.prepare('UPDATE modules SET tags = ? WHERE id = ?').run(toJson(patch.tags), id);
  if (Array.isArray(patch.usable_for)) db.prepare('UPDATE modules SET usable_for = ? WHERE id = ?').run(toJson(patch.usable_for), id);
  db.prepare('UPDATE modules SET updated_at = ? WHERE id = ?').run(now, id);
  return getModule(db, id);
}

export function softDeleteModule(db: Sqlite, id: string): boolean {
  // 已删除/不存在 → false（调用方按 404 处理，避免重复删除返回假成功）
  if (!getModule(db, id, false)) return false;
  db.prepare('UPDATE modules SET deleted_at = ?, updated_at = ? WHERE id = ?').run(new Date().toISOString(), new Date().toISOString(), id);
  return true;
}

/** 拆文批量入库：按 (title, source) 去重；tags 附加 batchTags；usable_for 附加 defaultUsableFor */
export function archiveModules(
  db: Sqlite,
  units: ModuleUnit[],
  opts: { sourceBook?: string; batchTags?: string[]; defaultUsableFor?: string[] },
): { created: number; skipped: number; module_ids: string[] } {
  const now = new Date().toISOString();
  const ins = db.prepare("INSERT INTO modules (id, kind, title, summary, source, tags, usable_for, body, usage_count, used_in_json, deleted_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,0,'[]',NULL,?,?)");
  const find = db.prepare('SELECT id FROM modules WHERE title = ? AND source = ? AND deleted_at IS NULL');
  let created = 0;
  let skipped = 0;
  const ids: string[] = [];
  for (const u of units) {
    if (!u.kind || !KINDS.includes(u.kind) || !u.title || !u.body) continue;
    const source = opts.sourceBook ? ('拆文库:' + opts.sourceBook + (u.source_path ? '/' + u.source_path : '')) : 'user';
    if (find.get(u.title, source)) { skipped++; continue; }
    const id = moduleId();
    const tags = [...new Set([...(u.tags ?? []), ...(opts.batchTags ?? [])])];
    const usable = [...new Set([...(u.usable_for ?? []), ...(opts.defaultUsableFor ?? [])])];
    ins.run(id, u.kind, u.title, u.summary ?? '', source, toJson(tags), toJson(usable), u.body, now, now);
    created++;
    ids.push(id);
  }
  return { created, skipped, module_ids: ids };
}

/** 新书向导推荐：题材/kind 匹配 + 复用次数 */
export function recommendModules(db: Sqlite, req: { genre?: string; kinds?: string[] }, limit = 12) {
  const rows = listModules(db, { sort: 'usage', limit: 500 }).items;
  const items: any[] = [];
  for (const m of rows) {
    let score = 0;
    const reasons: string[] = [];
    if (req.genre && (m.usable_for ?? []).includes(req.genre)) { score += 0.6; reasons.push('题材匹配'); }
    if (req.kinds?.length && req.kinds.includes(m.kind)) { score += 0.3; reasons.push('kind 匹配'); }
    if (m.usage_count > 0) { score += Math.min(0.1, m.usage_count * 0.02); reasons.push('复用 ' + m.usage_count + ' 次'); }
    if (score > 0) items.push({ module_id: m.id, score: Math.round(score * 100) / 100, reason: reasons.join('+') });
  }
  items.sort((a, b) => b.score - a.score);
  return { items: items.slice(0, limit) };
}

/** 注入到书：usage_count+1 + used_in 记历史 + 影响预估 */
export function attachModules(db: Sqlite, bookId: string, moduleIds: string[], scope = 'outline') {
  const now = new Date().toISOString();
  let attached = 0;
  let tokens = 0;
  for (const id of moduleIds) {
    const m = db.prepare('SELECT * FROM modules WHERE id = ? AND deleted_at IS NULL').get(id) as any;
    if (!m) continue;
    const usedIn = safeJson(m.used_in_json, []) as any[];
    usedIn.push({ book_id: bookId, stage: scope, at: now });
    db.prepare('UPDATE modules SET usage_count = usage_count + 1, used_in_json = ?, updated_at = ? WHERE id = ?').run(toJson(usedIn), now, id);
    tokens += Math.ceil((m.body?.length ?? 0) / 3);
    attached++;
  }
  const glue = scope === 'outline' ? 'context-outline' : 'context-' + scope;
  return {
    attached,
    impact: { glue, knowledge_blocks: attached, tokens_est: tokens },
    annotate: attached ? ('<!-- 参考模块: ' + moduleIds.join(', ') + ' -->') : '',
  };
}

export { KINDS, safeJson, toJson };

// 运维与可观测性服务（ops-observability.md M4 + scale-performance §5/§6）
// 日志 ｜ 诊断（health?depth=full）｜ 审计/统计 ｜ 备份/快照 ｜ 归档 ｜ relink/软删 ｜ 自愈恢复
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  readdirSync,
  writeFileSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { resolveSafe } from '../fs/index.ts';
import type { ChannelConfig } from '../config/index.ts';
type Sqlite = InstanceType<typeof Database>;

export interface HealthDeep {
  ok: boolean;
  version: string;
  node: string;
  python_dep_free: boolean;
  db: { path: string; bytes: number; gates_total: number; jobs_pending: number };
  channels: Array<{ id: string; configured: boolean; enabled: boolean; tested_at: string | null }>;
  ctx_cache: { hit: number | null; entries: number };
  perf: { last_gate_ms_p95: number | null; ai_calls_24h: number; cost_24h_cents: number };
}

/** GET /api/health?depth=full —— 完整诊断（ops §2 / scale-performance §6） */
export function collectHealthDeep(
  db: Sqlite,
  info: { dbPath: string; workspace: string; channels: ChannelConfig[]; lastTested: Record<string, string> },
): HealthDeep {
  const gatesTotal = (db.prepare('SELECT COUNT(*) c FROM gate_runs').get() as any)?.c ?? 0;
  const jobsPending = (db.prepare("SELECT COUNT(*) c FROM jobs WHERE status IN ('queued','running')").get() as any)?.c ?? 0;
  const now = Date.now();
  const dayAgo = new Date(now - 24 * 3600 * 1000).toISOString();
  const ai24h = db
    .prepare("SELECT COUNT(*) c, COALESCE(SUM(cost_cents),0) s FROM jobs WHERE created_at > ? AND (tokens_in > 0 OR tokens_out > 0)")
    .get(dayAgo) as { c: number; s: number };
  // 最近 500 次门禁耗时 p95
  const samples = db.prepare('SELECT ran_ms FROM gate_runs ORDER BY id DESC LIMIT 500').all() as Array<{ ran_ms: number }>;
  const p95 = p95Of(samples.map((s) => s.ran_ms));
  let dbBytes = 0;
  try { dbBytes = statSync(info.dbPath).size; } catch { /* noop */ }
  return {
    ok: true,
    version: '0.1.0-m4',
    node: process.version,
    python_dep_free: true,
    db: { path: info.dbPath, bytes: dbBytes, gates_total: gatesTotal, jobs_pending: jobsPending },
    channels: info.channels.map((c) => ({
      id: c.id,
      configured: !!c.base_url && !!c.api_key,
      enabled: c.enabled !== false,
      tested_at: info.lastTested[c.id] ?? null,
    })),
    ctx_cache: { hit: null, entries: 0 },
    perf: { last_gate_ms_p95: p95, ai_calls_24h: ai24h.c, cost_24h_cents: Math.round(ai24h.s * 100) / 100 },
  };
}

function p95Of(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.floor(s.length * 0.95)));
  return s[i] ?? null;
}

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const compact = (d: Date) => ymd(d).replace(/-/g, '');

function backupDir(webuiDir: string): string {
  return join(webuiDir, 'backups');
}

/** 备份：VACUUM INTO 单文件快照（ops §4）。daily 保留 7 份，snapshot 保留 7 份。 */
export function runBackup(db: Sqlite, webuiDir: string, mode: 'daily' | 'snapshot' = 'daily'): { path: string; bytes: number; kept: number } {
  const dir = backupDir(webuiDir);
  mkdirSync(dir, { recursive: true });
  const now = new Date();
  const name = mode === 'daily' ? `daily_${compact(now)}.db` : `snapshot_${now.toISOString().replace(/[:.]/g, '-')}.db`;
  const file = join(dir, name);
  // 同名日备份已存在 → 先移除用新快照刷新（VACUUM INTO 不允许覆盖已存在文件）
  if (existsSync(file)) rmSync(file, { force: true });
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  if (!existsSync(file)) {
    // 部分平台对同名文件/单引号不敏感，去掉引号重试
    db.exec(`VACUUM INTO ${file.replace(/['"]/g, '')}`);
  }
  const kept = pruneBackups(dir, mode);
  const bytes = statSync(file).size;
  return { path: file, bytes, kept };
}

function pruneBackups(dir: string, mode: 'daily' | 'snapshot'): number {
  const prefix = mode === 'daily' ? 'daily_' : 'snapshot_';
  const keep = 7;
  const files = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.db')).sort();
  for (let i = 0; i < files.length - keep; i++) {
    rmSync(join(dir, files[i]!), { force: true });
  }
  return Math.min(files.length, keep);
}

export function listBackups(webuiDir: string): Array<{ name: string; bytes: number; at: string }> {
  const dir = backupDir(webuiDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => {
      const st = statSync(join(dir, f));
      return { name: f, bytes: st.size, at: new Date(st.mtimeMs).toISOString() };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** 日常维护（scale-performance §5）：optimize + wal_checkpoint + gate_runs 冷数据归档（默认保留 3 个月） */
export function maintain(db: Sqlite, webuiDir: string, keepMonths = 3): { archived: number; optimized: boolean; checkpoint: boolean } {
  try { db.pragma('optimize'); } catch { /* noop */ }
  let checkpoint = false;
  try {
    const r = db.pragma('wal_checkpoint(TRUNCATE)') as unknown as Array<[number, number, number]>;
    checkpoint = true;
  } catch { /* noop */ }
  let archived = 0;
  try {
    const cutoff = new Date(Date.now() - keepMonths * 30 * 24 * 3600 * 1000).toISOString();
    archived = archiveGateRuns(db, webuiDir, cutoff);
  } catch { /* noop */ }
  return { archived, optimized: true, checkpoint };
}

/** 归档 gate_runs：冷数据（created_at < cutoff）先 VACUUM INTO 月归档库，再从热库删除 */
export function archiveGateRuns(db: Sqlite, webuiDir: string, cutoff: string): number {
  const rows = db.prepare('SELECT COUNT(*) c FROM gate_runs WHERE created_at < ?').get(cutoff) as { c: number };
  if (!rows.c) return 0;
  const dir = join(webuiDir, 'archive');
  mkdirSync(dir, { recursive: true });
  const now = new Date();
  const name = `webui.db__archive_${compact(now)}_${Date.now().toString(36)}.db`;
  const file = join(dir, name);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  if (!existsSync(file)) db.exec(`VACUUM INTO ${file.replace(/['"]/g, '')}`);
  const del = db.prepare('DELETE FROM gate_runs WHERE created_at < ?').run(cutoff);
  return del.changes;
}

// ---------------- 统计（审计查询 ops §3 / 门禁历史视图） ----------------

export interface StatsSummary {
  gate_total: number;
  gate_blocked: number;
  per_gate: Array<{ gate: string; runs: number; blocked: number; last_ms: number | null }>;
  jobs_total: number;
  cost_total_cents: number;
  cost_24h_cents: number;
  ai_calls_24h: number;
  last_gate_ms_p95: number | null;
}

export function collectStats(db: Sqlite): StatsSummary {
  const gateTotal = (db.prepare('SELECT COUNT(*) c FROM gate_runs').get() as any)?.c ?? 0;
  const blocked = (db.prepare('SELECT COUNT(*) c FROM gate_runs WHERE ok = 0').get() as any)?.c ?? 0;
  const gates = db
    .prepare(
      'SELECT gate, COUNT(*) runs, SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) blocked, MAX(ran_ms) last_ms FROM gate_runs GROUP BY gate ORDER BY blocked DESC, runs DESC',
    )
    .all() as Array<{ gate: string; runs: number; blocked: number; last_ms: number | null }>;
  const probes = db.prepare('SELECT ran_ms FROM gate_runs ORDER BY id DESC LIMIT 500').all() as Array<{ ran_ms: number }>;
  const jobsTotal = (db.prepare('SELECT COUNT(*) c FROM jobs').get() as any)?.c ?? 0;
  const costTotal = (db.prepare('SELECT COALESCE(SUM(cost_cents),0) s FROM jobs').get() as any)?.s ?? 0;
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const cost24 = (db.prepare('SELECT COALESCE(SUM(cost_cents),0) s FROM jobs WHERE created_at > ?').get(dayAgo) as any)?.s ?? 0;
  const ai24 = (db.prepare('SELECT COUNT(*) c FROM jobs WHERE created_at > ? AND (tokens_in>0 OR tokens_out>0)').get(dayAgo) as any)?.c ?? 0;
  return {
    gate_total: gateTotal,
    gate_blocked: blocked,
    per_gate: gates,
    jobs_total: jobsTotal,
    cost_total_cents: Math.round(costTotal * 100) / 100,
    cost_24h_cents: Math.round(cost24 * 100) / 100,
    ai_calls_24h: ai24,
    last_gate_ms_p95: p95Of(probes.map((p) => p.ran_ms)),
  };
}

export interface AuditFilter {
  action?: string;
  target?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export function queryAudit(db: Sqlite, f: AuditFilter): Array<Record<string, unknown>> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (f.action) { conds.push('action = ?'); params.push(f.action); }
  if (f.target) { conds.push('target LIKE ?'); params.push('%' + f.target + '%'); }
  if (f.from) { conds.push('ts >= ?'); params.push(f.from); }
  if (f.to) { conds.push('ts <= ?'); params.push(f.to); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const limit = Math.min(Number(f.limit ?? 500) || 500, 2000);
  return db.prepare(`SELECT id, ts, who, action, target, detail_json FROM audit ${where} ORDER BY id DESC LIMIT ?`).all(...params, limit) as any[];
}

export function auditCsv(db: Sqlite, f: AuditFilter): string {
  const rows = queryAudit(db, f);
  const esc = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = 'id,ts,who,action,target,detail_json';
  const lines = rows.map((r) => [r.id, r.ts, r.who, r.action, r.target, r.detail_json].map(esc).join(','));
  return [header, ...lines].join('\r\n') + '\r\n';
}

// ---------------- 目录与库恢复（ops §4：relink / 软删） ----------------

/** relink：目录变更/从 _archive 恢复时重新挂载；校验 _tracking-state.json 存在（fail-closed） */
export function relinkBook(db: Sqlite, book: { id: string; name: string }, newDir: string, workspace: string): { dir: string } {
  let abs: string;
  try {
    abs = resolveSafe(workspace, newDir);
  } catch {
    throw Object.assign(new Error('非法目录（需在 workspace 内）'), { code: 'INVALID_INPUT' });
  }
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw Object.assign(new Error('目录不存在'), { code: 'NOT_FOUND' });
  }
  if (!existsSync(join(abs, '追踪', '_tracking-state.json'))) {
    throw Object.assign(new Error('该目录缺少 追踪/_tracking-state.json，不是可挂载的书结构'), { code: 'INVALID_INPUT' });
  }
  db.prepare('UPDATE books SET dir=?, updated_at=? WHERE id=?').run(abs, new Date().toISOString(), book.id);
  return { dir: abs };
}

/** 删除 = 软删：目录移动到 workspace/_archive/ 再从库移除（误删可找回 + relink 恢复） */
export function deleteToArchive(db: Sqlite, book: { id: string; name: string; dir: string }, workspace: string): { archivedDir: string | null } {
  let archivedDir: string | null = null;
  if (existsSync(book.dir)) {
    const root = join(workspace, '_archive');
    mkdirSync(root, { recursive: true });
    let dest = join(root, `${book.name}_${book.id}`);
    let n = 1;
    while (existsSync(dest)) dest = join(root, `${book.name}_${book.id}_${n++}`);
    renameSync(book.dir, dest);
    archivedDir = dest;
  }
  db.prepare('DELETE FROM books WHERE id=?').run(book.id);
  db.prepare('INSERT INTO audit (ts, who, action, target, detail_json) VALUES (?,?,?,?,?)').run(
    new Date().toISOString(),
    'user',
    'delete',
    'book:' + book.id,
    JSON.stringify({ name: book.name, archived: archivedDir }),
  );
  return { archivedDir };
}

// ---------------- 自愈（ops §5：kill / 启动恢复） ----------------

export function killJob(db: Sqlite, jobId: string): { found: boolean; status: string } {
  const cur = db.prepare('SELECT status FROM jobs WHERE id=?').get(jobId) as { status: string } | undefined;
  if (!cur) return { found: false, status: '' };
  db.prepare("UPDATE jobs SET status='killed', error=COALESCE(error,'killed-by-user'), finished_at=? WHERE id=?").run(new Date().toISOString(), jobId);
  return { found: true, status: cur.status };
}

/** 启动恢复：jobs 中 running/queued → killed 并记 'restart-recovery'（ops §5） */
export function recoverJobsOnBoot(db: Sqlite): number {
  const rows = db.prepare("SELECT id FROM jobs WHERE status IN ('queued','running')").all() as Array<{ id: string }>;
  const upd = db.prepare("UPDATE jobs SET status='killed', error='restart-recovery', finished_at=? WHERE id=?");
  const now = new Date().toISOString();
  const tx = db.transaction(() => { for (const r of rows) upd.run(now, r.id); });
  tx();
  return rows.length;
}

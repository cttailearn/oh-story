// 运维面板（ops-observability M4 / scale-performance §6）：诊断/统计/审计CSV/备份维护/恢复
import { useEffect, useState } from 'react';
import { api } from '../api/client.ts';

export function OpsPanel() {
  const [health, setHealth] = useState<any>(null);
  const [stats, setStats] = useState<any>(null);
  const [backups, setBackups] = useState<any[]>([]);
  const [books, setBooks] = useState<any[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [audit, setAudit] = useState<any[]>([]);

  const [fAction, setFAction] = useState('');
  const [fTarget, setFTarget] = useState('');
  const [fFrom, setFFrom] = useState('');
  const [fTo, setFTo] = useState('');

  // 恢复表单
  const [relinkBookId, setRelinkBookId] = useState('');
  const [relinkDir, setRelinkDir] = useState('');

  const refreshAll = () => {
    Promise.all([
      api.healthFull().catch((e) => ({ error: String(e?.message ?? e) })),
      api.stats().catch((e) => ({ error: String(e?.message ?? e) })),
      api.opsBackups().catch(() => ({ items: [] })),
      api.listBooks().catch(() => ({ items: [] })),
      api.jobs().catch(() => ({ items: [] })),
      api.audit().catch(() => ({ items: [] })),
    ]).then(([h, s, b, bl, j, a]) => {
      setHealth(h); setStats(s);
      setBackups(b?.items ?? []); setBooks(bl?.items ?? []);
      setJobs((j?.items ?? []).slice(0, 8)); setAudit((a?.items ?? []).slice(0, 8));
      if (bl?.items?.[0] && !relinkBookId) setRelinkBookId(bl.items[0].id);
    });
  };

  useEffect(() => { refreshAll(); }, []);

  const op = async (key: string, fn: () => Promise<any>, okMsg: string) => {
    setBusy(key); setMsg(null); setErr(null);
    try {
      const r = await fn();
      let extra = '';
      if (r?.archived != null) extra = '（归档 ' + r.archived + ' 条 gate_runs）';
      setMsg(okMsg + extra);
      refreshAll();
    } catch (e: any) { setErr(e?.message ?? String(e)); } finally { setBusy(null); }
  };

  const csvQuery = () => {
    const p = new URLSearchParams();
    if (fAction) p.set('action', fAction);
    if (fTarget) p.set('target', fTarget);
    if (fFrom) p.set('from', fFrom + 'T00:00:00Z');
    if (fTo) p.set('to', fTo + 'T23:59:59Z');
    return p.toString();
  };

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {msg && <div style={{ border: '1px solid var(--green-jade)', color: 'var(--green-jade)', borderRadius: 6, padding: '8px 12px', fontSize: 13 }}>✅ {msg}</div>}
      {err && <div style={{ border: '1px solid var(--red-vermillion)', color: 'var(--red-vermillion)', borderRadius: 6, padding: '8px 12px', fontSize: 13 }}>⚠️ {err}</div>}

      {/* 诊断 */}
      <div className="rail-block">
        <div className="rb-title">
          诊断（GET /api/health?depth=full）
          <button className="ink-btn" style={{ padding: '2px 10px', fontSize: 12 }} onClick={refreshAll}>刷新</button>
        </div>
        {!health && <div style={{ color: 'var(--ink-2)', fontSize: 13 }}>载入中…</div>}
        {health?.error && <div style={{ color: 'var(--red-vermillion)', fontSize: 13 }}>{health.error}</div>}
        {health && !health.error && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(180px,1fr))', gap: 8, fontSize: 13 }}>
            {[
              ['服务', health.ok ? 'healthy ✓' : '异常', 'var(--green-jade)'],
              ['node', health.node ?? '-', 'var(--ink)'],
              ['零 Python', String(health.python_dep_free), health.python_dep_free ? 'var(--green-jade)' : 'var(--red-vermillion)'],
              ['库大小', (health.db?.bytes ?? 0) + ' B', 'var(--ink)'],
              ['门禁累计', health.db?.gates_total ?? 0, 'var(--ink)'],
              ['排队任务', health.db?.jobs_pending ?? 0, health.db?.jobs_pending ? 'var(--gold-saffron)' : 'var(--green-jade)'],
              ['门禁 p95', (health.perf?.last_gate_ms_p95 ?? '-') + ' ms', 'var(--ink)'],
              ['24h AI 调用', health.perf?.ai_calls_24h ?? 0, 'var(--ink)'],
              ['24h 成本', (health.perf?.cost_24h_cents ?? 0) + ' 分', 'var(--ink)'],
              ['渠道', (health.channels ?? []).map((c: any) => c.id + (c.configured ? '✓' : '✗')).join(', ') || '（无）', 'var(--ink)'],
            ].map(([k, v, color]) => (
              <div key={k as string} style={{ border: '1px solid var(--line)', borderRadius: 6, padding: '8px 10px' }}>
                <div style={{ color: 'var(--ink-2)', fontSize: 12 }}>{k}</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: color as string }}>{v}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 统计（门禁历史） */}
      <div className="rail-block">
        <div className="rb-title">门禁 / 成本统计</div>
        {stats?.per_gate?.length ? (
          <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: 'var(--ink-2)', textAlign: 'left' }}>
                <th style={th}>门禁</th><th style={th}>运行</th><th style={th}>blocking</th><th style={th}>最近耗时</th>
              </tr>
            </thead>
            <tbody>
              {(stats.per_gate as any[]).map((g) => (
                <tr key={g.gate} style={{ borderTop: '1px solid var(--line)' }}>
                  <td style={td}>{g.gate}</td>
                  <td style={td}>{g.runs}</td>
                  <td style={{ ...td, color: g.blocked ? 'var(--red-vermillion)' : 'var(--green-jade)' }}>{g.blocked}</td>
                  <td style={td}>{g.last_ms != null ? g.last_ms + ' ms' : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div style={{ color: 'var(--ink-2)', fontSize: 13 }}>尚无 gate_runs 记录（去流程里跑一轮）。</div>
        )}
        {stats && (
          <div style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 8 }}>
            累计：门禁 {stats.gate_total} 条 / 总成本 {stats.cost_total_cents} 分 / 24h AI 调用 {stats.ai_calls_24h} 次 / 24h 成本 {stats.cost_24h_cents} 分
          </div>
        )}
      </div>

      {/* 审计 */}
      <div className="rail-block">
        <div className="rb-title">审计（全量保留，可筛选/导出 CSV）</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 12.5 }}>
          <select value={fAction} onChange={(e) => setFAction(e.target.value)} style={inp}>
            <option value="">全部动作</option>
            {['run', 'approve', 'edit_rerun', 'reject', 'skip', 'rollback', 'ai-edit:request', 'import', 'import-review', 'delete', 'export', 'file-write', 'novel:seed'].map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <input placeholder="目标含（如 book:b1）" value={fTarget} onChange={(e) => setFTarget(e.target.value)} style={inp} />
          <label>从 <input type="date" value={fFrom} onChange={(e) => setFFrom(e.target.value)} style={inp} /></label>
          <label>到 <input type="date" value={fTo} onChange={(e) => setFTo(e.target.value)} style={inp} /></label>
          <a className="ink-btn primary" style={{ textDecoration: 'none' }} href={api.auditCsvUrl(csvQuery())} download="audit.csv">
            导出 CSV
          </a>
        </div>
        <div style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 6 }}>
          最近留痕：{audit.map((a) => '[' + a.action + '] ' + a.target).join(' ｜ ') || '（无）'}
        </div>
      </div>

      {/* 备份 / 维护 */}
      <div className="rail-block">
        <div className="rb-title">备份 / 维护（ops §4 / scale-performance §5）</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="ink-btn primary" disabled={busy !== null} onClick={() => op('backup', () => api.opsBackup('daily'), '日备份完成')}>
            {busy === 'backup' ? '备份中…' : '💾 立即日备份（VACUUM INTO）'}
          </button>
          <button className="ink-btn" disabled={busy !== null} onClick={() => op('snap', () => api.opsBackup('snapshot'), '升级前快照完成')}>
            升级前快照
          </button>
          <button className="ink-btn" disabled={busy !== null} onClick={() => op('mt', () => api.opsMaintain(), '维护完成（optimize+checkpoint）')}>
            维护（optimize / 归档冷 gate_runs）
          </button>
        </div>
        {backups.length > 0 && (
          <div style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 8 }}>
            .webui/backups/：{backups.map((b) => b.name + '（' + b.bytes + 'B）').join(' ｜ ')}
          </div>
        )}
        <div style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 4 }}>
          备份保留：每日 7 份 / 快照 7 份。升级路径：备份 → 替换 webui/ → 启动（schema 自动迁移）。
        </div>
      </div>

      {/* 恢复（relink / 软删找回） */}
      <div className="rail-block">
        <div className="rb-title">目录恢复（relink）——删书仅移入 <span className="mono">workspace/_archive/</span>，可找回</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 12.5 }}>
          <select value={relinkBookId} onChange={(e) => setRelinkBookId(e.target.value)} style={inp}>
            {books.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <input placeholder="相对目录，如 _archive/书名_id 或 恢复后的目录名" value={relinkDir} onChange={(e) => setRelinkDir(e.target.value)} style={{ ...inp, minWidth: 260 }} />
          <button className="ink-btn" disabled={busy !== null || !relinkBookId || !relinkDir} onClick={() => op('relink', () => api.relinkBook(relinkBookId, relinkDir.trim()), '重挂载完成')}>
            重挂载（校验 _tracking-state.json）
          </button>
        </div>
      </div>

      {/* 任务 kill */}
      <div className="rail-block">
        <div className="rb-title">进行中任务（重启自愈：启动时 running/queued → killed 记 restart-recovery）</div>
        {jobs.filter((j) => ['queued', 'running', 'review'].includes(j.status)).length === 0 && (
          <div style={{ color: 'var(--ink-2)', fontSize: 12.5 }}>无进行中任务。</div>
        )}
        {jobs.filter((j) => ['queued', 'running', 'review'].includes(j.status)).map((j) => (
          <div key={j.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12.5, padding: '4px 0', borderBottom: '1px dashed var(--line)' }}>
            <span className="mono">{j.id} · {j.stage_id} · {j.status}</span>
            <button className="ink-btn" style={{ padding: '2px 8px', fontSize: 12 }} onClick={() => op('kill', () => api.killJob(j.id), '已请求 kill ' + j.id)}>kill</button>
          </div>
        ))}
      </div>
    </div>
  );
}

const th: React.CSSProperties = { padding: '4px 6px', fontWeight: 600 };
const td: React.CSSProperties = { padding: '5px 6px' };
const inp: React.CSSProperties = {
  padding: '4px 8px', border: '1px solid var(--line)', background: 'var(--paper)', color: 'var(--ink)', borderRadius: 4, fontSize: 12.5,
};

import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.ts';

const KINDS = ['plot', 'emotion', 'rhythm', 'hook', 'character-trait', 'worldbuilding'];
const selStyle: any = { padding: '4px 6px', border: '1px solid var(--line)', background: 'var(--paper)', color: 'var(--ink)', fontSize: 12.5 };

/** 模块库页（teardown-module-ui Screen B）：检索/筛选 + 拆文分析归档 + 注入新书 */
export function ModulesPage() {
  const [books, setBooks] = useState<any[]>([]);
  const [pick, setPick] = useState<string>('');
  const [attachBook, setAttachBook] = useState<string>('');
  const [items, setItems] = useState<any[]>([]);
  const [kind, setKind] = useState<string>('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const loadList = useCallback((k: string, query: string) => {
    const params = new URLSearchParams();
    if (k) params.set('kind', k);
    if (query.trim()) params.set('source', query.trim());
    api.listModules(params.toString()).then((r) => setItems(r.items)).catch((e: any) => setErr(e?.message ?? String(e)));
  }, []);

  useEffect(() => {
    api.listBooks().then((r) => {
      setBooks(r.items);
      const teardown = r.items.find((b: any) => b.kind === 'teardown');
      const novel = r.items.find((b: any) => b.kind !== 'teardown');
      setPick(teardown?.id ?? (r.items[0]?.id ?? ''));
      setAttachBook(novel?.id ?? (r.items[0]?.id ?? ''));
    }).catch(() => {});
    loadList('', '');
  }, [loadList]);

  const toggle = (id: string) => {
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };

  const archiveFromTeardown = async () => {
    setMsg(null); setErr(null);
    if (!pick) return setErr('请先选择拆文项目');
    try {
      const a = await api.teardownAnalyze(pick);
      if (!a.units?.length) return setErr('该拆文未产出可归档单元（先 import-text 再 analyze）');
      const ar = await api.archiveModules(pick, { units: a.units });
      setMsg('已归档 ' + ar.created + ' 个模块（跳过重复 ' + ar.skipped_existing + '）');
      loadList(kind, q);
    } catch (e: any) { setErr(e?.message ?? String(e)); }
  };

  const attach = async () => {
    setMsg(null); setErr(null);
    const ids = [...selected];
    if (!ids.length) return setErr('先勾选要注入的模块');
    if (!attachBook) return setErr('先选择目标书');
    try {
      const r = await api.attachModules(attachBook, { module_ids: ids, scope: 'outline' });
      setMsg('已注入 ' + r.attached + ' 个模块到书（≈ ' + r.impact.tokens_est + ' tokens，glue=' + r.impact.glue + '）');
      setSelected(new Set());
      loadList(kind, q);
    } catch (e: any) { setErr(e?.message ?? String(e)); }
  };

  return (
    <div>
      <h1 className="serif">模块库</h1>
      <p style={{ color: 'var(--ink-2)', fontSize: 13 }}>拆文 → 模块库 → 新书 的复用弹药匣（teardown-module-ui）</p>

      <div className="rail-block" style={{ display: 'grid', gap: 10, marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>拆文项目</span>
          <select value={pick} onChange={(e) => setPick(e.target.value)} style={selStyle}>
            {books.filter((b) => b.kind === 'teardown').map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <button className="ink-btn" onClick={archiveFromTeardown}>分析并归档（拆文→模块库）</button>
          <span style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>目标书</span>
          <select value={attachBook} onChange={(e) => setAttachBook(e.target.value)} style={selStyle}>
            {books.filter((b) => b.kind !== 'teardown').map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <button className="ink-btn primary" onClick={attach}>注入勾选项（{selected.size}）</button>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input value={q} onChange={(e) => { setQ(e.target.value); loadList(kind, e.target.value); }} placeholder="按来源搜索…" style={{ padding: '4px 8px', border: '1px solid var(--line)', background: 'var(--paper)', color: 'var(--ink)', fontSize: 12.5 }} />
          <select value={kind} onChange={(e) => { setKind(e.target.value); loadList(e.target.value, q); }} style={selStyle}>
            <option value="">全部 kind</option>
            {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <span className="mono" style={{ fontSize: 12, color: 'var(--ink-2)' }}>{items.length} 条</span>
        </div>
      </div>

      {msg && <div style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--green-jade)' }}>✅ {msg}</div>}
      {err && <div style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--red-vermillion)' }}>⚠️ {err}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
        {items.length === 0 && <div style={{ color: 'var(--ink-2)', fontSize: 13 }}>模块匣是空的。去拆一本爆款，把好结构存进来。</div>}
        {items.map((m) => (
          <div key={m.id} className="tt-card" style={{ borderColor: selected.has(m.id) ? 'var(--gold-saffron)' : 'var(--line)', cursor: 'pointer' }} onClick={() => toggle(m.id)}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong className="serif">{m.title}</strong>
              <span className="seal">{m.kind}</span>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--ink-2)', margin: '6px 0' }}>{m.summary || (m.body || '').slice(0, 60)}</div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--ink-2)', lineHeight: 1.6 }}>
              {m.source} · 复用 {m.usage_count} 次 · {(m.tags ?? []).join('、') || '无标签'}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

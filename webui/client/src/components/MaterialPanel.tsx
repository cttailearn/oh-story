import { useEffect, useState } from 'react';
import { api } from '../api/client.ts';

const KINDS = ['plot', 'emotion', 'rhythm', 'hook', 'character-trait', 'worldbuilding'];
const KIND_LABEL: Record<string, string> = {
  plot: '\u5267\u60c5',
  emotion: '\u60c5\u7eea',
  rhythm: '\u8282\u594f',
  hook: '\u94a9\u5b50',
  'character-trait': '\u89d2\u8272\u7279\u8d28',
  worldbuilding: '\u4e16\u754c\u89c2',
};
const selStyle: any = { padding: '4px 6px', border: '1px solid var(--line)', background: 'var(--paper)', color: 'var(--ink)', fontSize: 12.5 };
const card: any = { border: '1px solid var(--line)', borderRadius: 6, padding: '10px 12px', background: 'var(--paper)' };

/** Writing-material shelf for a novel: view injected material, decompose another book into
 *  material modules (archive into the module library + attach to this novel), and top up
 *  from the shared module library. */
export function MaterialPanel({ bookId }: { bookId: string }) {
  const [materials, setMaterials] = useState<any[]>([]);
  const [books, setBooks] = useState<any[]>([]);
  // decompose form
  const [sourceBookId, setSourceBookId] = useState('');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // module-library picker
  const [lib, setLib] = useState<any[]>([]);
  const [libQ, setLibQ] = useState('');
  const [libKind, setLibKind] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const loadMaterials = () => {
    api.materialList(bookId).then((r) => setMaterials(r.items ?? [])).catch(() => {});
  };
  const loadLib = () => {
    const p = new URLSearchParams();
    if (libKind) p.set('kind', libKind);
    if (libQ.trim()) p.set('source', libQ.trim());
    api.listModules(p.toString()).then((r) => setLib(r.items ?? [])).catch(() => {});
  };
  useEffect(() => { loadMaterials(); loadLib(); }, [bookId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    api.listBooks().then((r) => setBooks(r.items.filter((b: any) => b.id !== bookId))).catch(() => {});
  }, [bookId]);

  const decompose = async () => {
    setMsg(null); setErr(null); setBusy(true);
    try {
      if (!sourceBookId && !text.trim()) { setErr('\u8bf7\u9009\u62e9\u6765\u6e90\u4e66\u6216\u7c98\u8d34\u6765\u6e90\u4e66\u539f\u6587'); return; }
      const r = await api.materialDecompose(bookId, {
        source_book_id: sourceBookId || undefined,
        title: title.trim() || undefined,
        text: text.trim() || undefined,
      });
      setMsg(
        '\u5df2\u62c6\u89e3\u300a' + r.title + '\u300b\uff1a\u5206\u7ae0 ' + r.chapters +
        '\uff0c\u4ea7\u51fa\u6a21\u5757 ' + r.created + ' \uff08\u53bb\u91cd ' + r.skipped + ' \uff09\uff0c\u6ce8\u5165\u672c\u4e66 ' + r.attached +
        ' \u4e2a\uff08\u2248 ' + r.impact.tokens_est + ' tokens\uff09\u3002\u62c6\u6587\u5e93\u843d\u5728\u672c\u4e66\u76ee\u5f55\u4e0b\u53ef\u76f4\u63a5\u6d4f\u89c8\u3002',
      );
      setText(''); setSourceBookId('');
      loadMaterials(); loadLib();
    } catch (e: any) { setErr(e?.message ?? String(e)); } finally { setBusy(false); }
  };

  const attachSelected = async () => {
    setMsg(null); setErr(null);
    const ids = [...selected];
    if (!ids.length) { setErr('\u8bf7\u5148\u52fe\u9009\u8981\u6ce8\u5165\u7684\u6a21\u5757'); return; }
    try {
      const r = await api.attachModules(bookId, { module_ids: ids, scope: 'material' });
      setMsg('\u5df2\u6ce8\u5165 ' + r.attached + ' \u4e2a\u6a21\u5757\uff08\u2248 ' + r.impact.tokens_est + ' tokens\uff09');
      setSelected(new Set());
      loadMaterials();
    } catch (e: any) { setErr(e?.message ?? String(e)); }
  };

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <h4 className="serif" style={{ margin: 0, fontSize: 16 }}>{'\u5df2\u6ce8\u5165\u7d20\u6750'}</h4>
          <span style={{ fontSize: 12, color: 'var(--ink-2)' }}>{materials.length + ' \u4e2a\u6a21\u5757\uff0c\u4f5c\u4e3a\u5199\u4f5c\u7d20\u6750\u8fdb\u5165\u4e0a\u4e0b\u6587'}</span>
        </div>
        {materials.length === 0 && (
          <div style={{ color: 'var(--ink-2)', fontSize: 13 }}>
            {'\u8fd8\u6ca1\u6709\u7d20\u6750\u3002\u7528\u4e0b\u9762\u201c\u62c6\u89e3\u5176\u5b83\u4e66\u201d\u628a\u522b\u7684\u4e66\u62c6\u6210\u6a21\u5757\u5f52\u5165\u672c\u4e66\uff0c\u6216\u4ece\u6a21\u5757\u5e93\u8865\u5145\u3002'}
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 10 }}>
          {materials.map((m) => (
            <div key={m.id} style={{ ...card }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                <strong className="serif" style={{ fontSize: 14 }}>{m.title}</strong>
                <span className="seal">{KIND_LABEL[m.kind] ?? m.kind}</span>
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--ink-2)', margin: '6px 0' }}>{(m.summary || '').slice(0, 80)}</div>
              <div className="mono" style={{ fontSize: 11, color: 'var(--ink-2)', lineHeight: 1.6 }}>
                {m.source} · {'\u590d\u7528'} {m.usage_count} {'\u6b21'}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ borderTop: '1px dashed var(--line)', paddingTop: 12 }}>
        <h4 className="serif" style={{ margin: '0 0 8px', fontSize: 16 }}>{'\u62c6\u89e3\u5176\u5b83\u4e66 \u2192 \u5165\u7d20\u6750'}</h4>
        <div style={{ color: 'var(--ink-2)', fontSize: 12.5, marginBottom: 8, lineHeight: 1.7 }}>
          {'\u9009\u62e9\u5de5\u4f5c\u533a\u91cc\u7684\u53e6\u4e00\u672c\u4e66\uff08\u6216\u76f4\u63a5\u7c98\u8d34\u539f\u6587\uff09\uff0c\u7a33\u5b9a\u6027\u62c6\u89e3\u6210\u6e05\u8282/\u89d2\u8272/\u6784\u94a9\u7b49\u6a21\u5757\u5f52\u5165\u672c\u4e66\u4f5c\u5199\u4f5c\u7d20\u6750\u3002\u65e0 API \u6210\u672c\u3002'}
        </div>
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ display: 'grid', gap: 4, flex: 1, minWidth: 200 }}>
              <span style={{ fontSize: 13, color: 'var(--ink-2)' }}>{'\u6765\u6e90\u4e66'}</span>
              <select value={sourceBookId} onChange={(e) => { const v = e.target.value; setSourceBookId(v); const b = books.find((x) => x.id === v); if (b && !title.trim()) setTitle(b.name); }} style={selStyle}>
                <option value="">{'\uff08\u76f4\u63a5\u7c98\u8d34\u539f\u6587\uff09'}</option>
                {books.map((b) => (<option key={b.id} value={b.id}>{'\u300a' + b.name + '\u300b ' + (b.kind === 'teardown' ? '\u62c6\u6587' : '\u5c0f\u8bf4')}</option>))}
              </select>
            </span>
            <span style={{ display: 'grid', gap: 4, minWidth: 180 }}>
              <span style={{ fontSize: 13, color: 'var(--ink-2)' }}>{'\u7d20\u6750\u540d\u79f0\uff08\u53ef\u6539\uff09'}</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={'\u5982\u300a\u76d8\u9f99\u300b\u62c6\u89e3'} style={{ padding: '4px 8px', border: '1px solid var(--line)', background: 'var(--paper)', color: 'var(--ink)', fontFamily: 'var(--font-serif)', fontSize: 13 }} />
            </span>
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            placeholder={'\u6216\u76f4\u63a5\u5728\u6b64\u7c98\u8d34\u53e6\u4e00\u672c\u4e66\u7684\u5168\u6587\uff08\u652f\u6301 \u7b2c\u4e00\u7ae0/\u7b2c1\u7ae0 \u951a\u70b9\u5206\u7ae0\uff09\u2026'}
            style={{ width: '100%', border: '1px solid var(--line)', background: 'var(--paper)', color: 'var(--ink)', padding: 8, fontFamily: 'var(--font-serif)', fontSize: 13 }}
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="ink-btn primary" onClick={decompose} disabled={busy}>{busy ? '\u62c6\u89e3\u4e2d\u2026' : '\u2764 \u62c6\u89e3\u5e76\u5165\u672c\u4e66\u7d20\u6750'}</button>
            <span style={{ fontSize: 12, color: 'var(--ink-2)' }}>{'\u62c6\u51fa\u7684\u6a21\u5757\u540c\u65f6\u5165\u6a21\u5757\u5e93\uff0c\u53ef\u5728\u201c\u6a21\u5757\u5e93\u201d\u9875\u590d\u7528\u3002'}</span>
          </div>
        </div>
      </div>

      <div style={{ borderTop: '1px dashed var(--line)', paddingTop: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
          <h4 className="serif" style={{ margin: 0, fontSize: 16 }}>{'\u4ece\u6a21\u5757\u5e93\u8865\u5145'}</h4>
          <input value={libQ} onChange={(e) => { setLibQ(e.target.value); }} placeholder={'\u6309\u6765\u6e90\u641c\u7d22\u2026'} style={{ padding: '4px 8px', border: '1px solid var(--line)', background: 'var(--paper)', color: 'var(--ink)', fontSize: 12.5, width: 140 }} />
          <select value={libKind} onChange={(e) => { setLibKind(e.target.value); }} style={selStyle}>
            <option value="">{'\u5168\u90e8 kind'}</option>
            {KINDS.map((k) => (<option key={k} value={k}>{KIND_LABEL[k] ?? k}</option>))}
          </select>
          <button className="ink-btn" onClick={() => { loadLib(); loadMaterials(); }}>{'\u5237\u65b0'}</button>
          <button className="ink-btn primary" onClick={attachSelected} disabled={selected.size === 0}>{'\u6ce8\u5165\u52fe\u9009\u9879\uff08' + selected.size + '\uff09'}</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
          {lib.length === 0 && <div style={{ color: 'var(--ink-2)', fontSize: 13 }}>{'\u6a21\u5757\u5e93\u6682\u65e0\u6ee1\u8db3\u6761\u4ef6\u7684\u6a21\u5757\u3002'}</div>}
          {lib.map((m) => (
            <div key={m.id} style={{ ...card, cursor: 'pointer', borderColor: selected.has(m.id) ? 'var(--gold-saffron)' : 'var(--line)' }} onClick={() => toggle(m.id)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                <strong className="serif" style={{ fontSize: 13.5 }}>{m.title}</strong>
                <span className="seal">{KIND_LABEL[m.kind] ?? m.kind}</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--ink-2)', margin: '6px 0' }}>{(m.summary || (m.body || '').slice(0, 60))}</div>
              <div className="mono" style={{ fontSize: 11, color: 'var(--ink-2)', lineHeight: 1.6 }}>{m.source} · {'\u590d\u7528'} {m.usage_count} {'\u6b21'}</div>
            </div>
          ))}
        </div>
      </div>

      {msg && <div style={{ padding: '9px 12px', border: '1px solid var(--green-jade)', color: 'var(--green-jade)', borderRadius: 6, fontSize: 13, background: 'color-mix(in srgb, var(--green-jade) 6%, var(--paper))' }}>{'\u2705 ' + msg}</div>}
      {err && <div style={{ padding: '9px 12px', border: '1px solid var(--red-vermillion)', color: 'var(--red-vermillion)', borderRadius: 6, fontSize: 13, background: 'color-mix(in srgb, var(--red-vermillion) 6%, var(--paper))' }}>{'\u26a0\ufe0f ' + err}</div>}
    </div>
  );
}

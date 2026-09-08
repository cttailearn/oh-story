import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client.ts';

/** 拆文工作台（teardown-module-ui Screen A）：导入原文 → 分章 → 分析 → 归档模块库 */
export function TeardownPage() {
  const { bookId } = useParams();
  const [text, setText] = useState('');
  const [bookName, setBookName] = useState('');
  const [imported, setImported] = useState<any>(null);
  const [analyzed, setAnalyzed] = useState<any>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadTree = useCallback(() => {
    if (!bookId) return;
    const walk = (nodes: any[]): string[] => nodes.flatMap((n) => (n.type === 'dir' ? walk(n.children ?? []) : [n.path])).filter((p: string) => p.startsWith('拆文库/') || p === '拆文库');
    api.tree(bookId).then((r) => setFiles(walk(r.tree))).catch(() => {});
  }, [bookId]);

  useEffect(() => {
    if (!bookId) return;
    api.getBook(bookId).then((b) => setBookName(b.name)).catch(() => {});
    loadTree();
  }, [bookId, loadTree]);

  const doImport = async () => {
    if (!bookId || !text.trim()) return setErr('请粘贴原文');
    setBusy(true); setErr(null); setMsg(null); setAnalyzed(null);
    try {
      const r = await api.teardownImport(bookId, { text, title: bookName });
      setImported(r);
      setMsg('已导入并分章 ' + r.chapters + ' 章（锚点分章，低置信可复核）');
      loadTree();
    } catch (e: any) { setErr(e?.message ?? String(e)); } finally { setBusy(false); }
  };

  const doAnalyze = async () => {
    if (!bookId) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await api.teardownAnalyze(bookId);
      setAnalyzed(r);
      setMsg('拆解完成：产出 ' + r.files.length + ' 个文件，' + (r.units?.length ?? 0) + ' 个可归档模块单元（去模块库一键入库）');
      loadTree();
    } catch (e: any) { setErr(e?.message ?? String(e)); } finally { setBusy(false); }
  };

  return (
    <div style={{ maxWidth: 900 }}>
      <h1 className="serif">拆文工作台 · {bookName}</h1>
      <p style={{ color: 'var(--ink-2)', fontSize: 13 }}>拆别人的书，沉淀自己的模块库（teardown-module）</p>

      <div className="rail-block">
        <div className="rb-title">① 导入原文</div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          placeholder="粘贴整本小说文本（支持 第一章/第1章/Chapter 3 锚点分章；未识别锚点时按字数分切）…"
          style={{ width: '100%', border: '1px solid var(--line)', background: 'var(--paper)', color: 'var(--ink)', padding: 8, fontFamily: 'var(--font-serif)', fontSize: 14 }}
        />
        <div style={{ marginTop: 8 }}>
          <button className="ink-btn primary" onClick={doImport} disabled={busy}>{busy ? '处理中…' : '导入并分章'}</button>
          <button className="ink-btn" onClick={doAnalyze} disabled={busy} style={{ marginLeft: 8 }}>② 拆解分析</button>
        </div>
      </div>

      {msg && <div style={{ marginTop: 10, fontSize: 13, color: 'var(--green-jade)' }}>✅ {msg}</div>}
      {err && <div style={{ marginTop: 10, fontSize: 13, color: 'var(--red-vermillion)' }}>⚠️ {err}</div>}

      {analyzed && analyzed.units?.length > 0 && (
        <div className="rail-block" style={{ marginTop: 12 }}>
          <div className="rb-title">可归档模块单元（{analyzed.units.length}）—— 去「模块库」页一键入库</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {analyzed.units.map((u: any, i: number) => (<span key={i} className="seal" style={{ padding: '3px 8px', fontSize: 11.5 }}>{u.kind}·{u.title}</span>))}
          </div>
        </div>
      )}

      <div className="rail-block" style={{ marginTop: 12 }}>
        <div className="rb-title">拆文库文件（{files.length}）</div>
        <div className="mono" style={{ fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.8 }}>
          {files.length === 0 && <span>尚未导入原文。</span>}
          {files.map((f) => (<div key={f}>{f}</div>))}
        </div>
      </div>
    </div>
  );
}

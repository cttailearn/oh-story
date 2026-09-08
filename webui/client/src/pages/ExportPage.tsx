import { useEffect, useState } from 'react';
import { api } from '../api/client.ts';

const PLATFORMS = [
  { key: 'fanqie', label: '番茄' },
  { key: 'qidian', label: '起点' },
  { key: 'jj', label: '晋江' },
  { key: 'yanyan', label: '盐言' },
];

/** 导出流程页（webui-frontend §10.5 / export-publish）：选形态 → 发布前检查 → 统计 → 下载 */
export function ExportPage() {
  const [books, setBooks] = useState<any[]>([]);
  const [bookId, setBookId] = useState('');
  const [format, setFormat] = useState<'markdown' | 'txt'>('markdown');
  const [platform, setPlatform] = useState('fanqie');
  const [includeOutline, setIncludeOutline] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api.listBooks().then((r) => {
      const novels = r.items.filter((b: any) => b.kind !== 'teardown');
      setBooks(novels);
      setBookId(novels[0]?.id ?? '');
    }).catch(() => {});
  }, []);

  const doExport = async () => {
    if (!bookId) return setErr('请先选择目标书');
    setBusy(true); setErr(null); setMsg(null); setResult(null);
    try {
      const r = await api.exportBook(bookId, {
        format,
        platform: format === 'txt' ? platform : undefined,
        include: includeOutline ? ['chapters', 'outline'] : ['chapters'],
      });
      if (r.ok) {
        setResult(r);
        setMsg('导出完成 → 交付/' + r.name + '（' + r.stats.chars_clean.toLocaleString() + ' 字，均章 ' + r.stats.avg_chars + ' 字）');
      } else {
        setErr('发布前检查未过（blocking）：\n' + (r.stats?.blocked ?? []).join('\n'));
      }
    } catch (e: any) { setErr(e?.message ?? String(e)); } finally { setBusy(false); }
  };

  const download = async () => {
    if (!result || !bookId) return;
    try {
      const resp = await fetch(`/api/files?path=${encodeURIComponent(result.relPath)}&book_id=${bookId}`);
      if (!resp.ok) return setErr('无法读取导出文件（可能已被清理）');
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = result.name; a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) { setErr(e?.message ?? String(e)); }
  };

  return (
    <div style={{ maxWidth: 760 }}>
      <h1 className="serif">导出与发布</h1>
      <p style={{ color: 'var(--ink-2)', fontSize: 13 }}>把「能看的书」变成「能传的稿」（export-publish.md）</p>

      <div className="rail-block">
        <div className="rb-title">① 选形态</div>
        <div style={{ display: 'grid', gap: 10 }}>
          <label style={{ fontSize: 13.5 }}>目标书
            <select value={bookId} onChange={(e) => setBookId(e.target.value)} style={sel}>
              {books.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {(['markdown', 'txt'] as const).map((f) => (
              <label key={f} style={{ fontSize: 13.5 }}>
                <input type="radio" checked={format === f} onChange={() => setFormat(f)} /> {f === 'markdown' ? 'Markdown 单册（.md）' : '纯文本（.txt 平台裸稿）'}
              </label>
            ))}
          </div>
          {format === 'txt' && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {PLATFORMS.map((p) => (<label key={p.key} style={{ fontSize: 13.5 }}><input type="radio" checked={platform === p.key} onChange={() => setPlatform(p.key)} /> {p.label}</label>))}
            </div>
          )}
          <label style={{ fontSize: 13.5 }}><input type="checkbox" checked={includeOutline} onChange={(e) => setIncludeOutline(e.target.checked)} /> 附「大纲」篇（markdown）</label>
        </div>
      </div>

      <div style={{ marginTop: 10 }}>
        <button className="ink-btn primary" onClick={doExport} disabled={busy}>{busy ? '导出中…' : '② 导出并检查'}</button>
      </div>
      {msg && <div style={{ marginTop: 10, fontSize: 13, color: 'var(--green-jade)' }}>✅ {msg}</div>}
      {err && <div style={{ marginTop: 10, fontSize: 13, color: 'var(--red-vermillion)', whiteSpace: 'pre-line' }}>⚠️ {err}</div>}

      {result && result.ok && (
        <div className="rail-block" style={{ marginTop: 12 }}>
          <div className="rb-title">③ 结果</div>
          <div style={{ fontSize: 13, lineHeight: 1.9 }}>
            <div>文件：<span className="mono">交付/{result.name}</span></div>
            <div>章节：{result.stats.chapters} · 纯字符：{result.stats.chars_raw.toLocaleString()} · 扣标点：{result.stats.chars_clean.toLocaleString()} · 均章：{result.stats.avg_chars}</div>
            {result.stats.warnings?.length > 0 && <div style={{ color: 'var(--gold-saffron)' }}>警示：{result.stats.warnings.length} 条（可忽略发布）</div>}
          </div>
          <button className="ink-btn primary" onClick={download} style={{ marginTop: 8 }}>↓ 下载</button>
        </div>
      )}
    </div>
  );
}

const sel: any = { padding: '4px 8px', marginLeft: 8, border: '1px solid var(--line)', background: 'var(--paper)', color: 'var(--ink)' };

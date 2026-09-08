import { useCallback, useEffect, useRef, useState } from 'react';
import { Drawer, Input } from 'antd';
import { api } from '../api/client.ts';

interface Grouped { book_id: string; book_name: string; chapters: any[]; characters: any[]; foreshadow: any[]; settings: any[]; outline: any[] }

/** 全局搜索面板（webui-frontend §9.4）：分组 + <mark> 高亮 + 跳转；Ctrl/Cmd+P 唤起 */
export function SearchPanel({ open, onClose, onOpenPath }: { open: boolean; onClose: () => void; onOpenPath: (bookId: string, path: string) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Grouped[]>([]);
  const [loading, setLoading] = useState(false);
  const timer = useRef<any>(null);

  const search = useCallback((query: string) => {
    if (timer.current) clearTimeout(timer.current);
    if (!query.trim()) { setResults([]); return; }
    timer.current = setTimeout(() => {
      setLoading(true);
      api.search(query).then((r: any) => setResults(r.results ?? [])).catch(() => setResults([])).finally(() => setLoading(false));
    }, 250);
  }, []);

  useEffect(() => { if (open) setQ(''); }, [open]);

  const groups: Array<{ key: string; label: string; items: any[] }> = [
    { key: 'chapters', label: '正文', items: results.flatMap((r) => r.chapters.map((h) => ({ ...h, book_id: r.book_id, book_name: r.book_name }))) },
    { key: 'characters', label: '角色', items: results.flatMap((r) => r.characters.map((h) => ({ ...h, book_id: r.book_id, book_name: r.book_name }))) },
    { key: 'foreshadow', label: '伏笔/事件', items: results.flatMap((r) => r.foreshadow.map((h) => ({ ...h, book_id: r.book_id, book_name: r.book_name }))) },
    { key: 'settings', label: '设定', items: results.flatMap((r) => r.settings.map((h) => ({ ...h, book_id: r.book_id, book_name: r.book_name }))) },
    { key: 'outline', label: '大纲', items: results.flatMap((r) => r.outline.map((h) => ({ ...h, book_id: r.book_id, book_name: r.book_name }))) },
  ];

  return (
    <Drawer title={<span className="serif">⌕ 全局搜索 <span className="mono" style={{ fontSize: 11, color: 'var(--ink-2)' }}>Ctrl/Cmd+P</span></span>} width={620} open={open} onClose={onClose} destroyOnClose>
      <Input
        autoFocus
        value={q}
        onChange={(e) => { setQ(e.target.value); search(e.target.value); }}
        placeholder="搜章节/角色/伏笔/设定/大纲…（节流 250ms）"
        allowClear
      />
      {loading && <div className="mono" style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 8 }}>检索中…</div>}
      {!loading && q.trim() && results.length === 0 && <div style={{ marginTop: 12, color: 'var(--ink-2)', fontSize: 13 }}>没找到，试试搜角色线/伏笔号。</div>}
      {groups.map((g) => {
        if (!g.items.length) return null;
        return (
          <div key={g.key} style={{ marginTop: 14 }}>
            <h4 className="serif" style={{ fontSize: 13, color: 'var(--ink-2)', margin: '0 0 6px' }}>{g.label}（{g.items.length}）</h4>
            {g.items.slice(0, 12).map((h, i) => (
              <div key={i} className="tt-card" style={{ padding: '8px 10px', marginBottom: 4, cursor: 'pointer', fontSize: 12.5 }} onClick={() => { onOpenPath(h.book_id, h.path); onClose(); }}>
                <div className="mono" style={{ fontSize: 11, color: 'var(--ink-2)', marginBottom: 2 }}>{h.book_name} · {h.path}</div>
                <div dangerouslySetInnerHTML={{ __html: h.snippet }} />
              </div>
            ))}
          </div>
        );
      })}
      <div style={{ marginTop: 10, fontSize: 11, color: 'var(--ink-2)' }}>目录路径点击后会打开对应文件（正文模块）。</div>
    </Drawer>
  );
}

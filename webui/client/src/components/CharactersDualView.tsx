import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.ts';
import { CharacterLineBoard } from './CharacterLineBoard.tsx';

interface CharFile { path: string; name: string; content: string; excerpt: string }

/** 兜底：从 设定/产物.md 等整篇产物解析 角色卡/角色线（模型未按 file-block 输出时也能看） */
function parseFallback(content: string): { cards: CharFile[]; lines: CharFile[] } {
  const cards: CharFile[] = [];
  const lines: CharFile[] = [];
  if (!content) return { cards, lines };
  // 1) 《设定/角色/X.md》 / 《设定/角色线/X.md》 块（块头或行内标记）
  const reBlock = /《设定\/(角色|角色线)\/([^》\/]+?)\.md》/g;
  let m: RegExpExecArray | null;
  const segs: Array<{ kind: 'card' | 'line'; name: string; start: number; next: number }> = [];
  let last = -1;
  while ((m = reBlock.exec(content))) {
    const kind = m[1] === '角色' ? 'card' : 'line';
    const st = reBlock.lastIndex;
    segs.push({ kind, name: m[2]!.trim(), start: st, next: -1 });
    if (segs.length > 1) segs[segs.length - 2]!.next = st;
    last = st;
  }
  if (segs.length) segs[segs.length - 1]!.next = content.length;
  for (const s of segs) {
    const body = content.slice(s.start, s.next).trim().slice(0, 4000);
    const item = { path: '设定/' + (s.kind === 'card' ? '角色' : '角色线') + '/' + s.name + '.md', name: s.name, content: body, excerpt: body.replace(/^#+\s*\n?/, '').slice(0, 140) };
    if (s.kind === 'card') cards.push(item); else lines.push(item);
  }
  if (cards.length || lines.length) return { cards, lines };
  // 2) 标题式：# 角色卡：X / # 角色弧线：X
  const secRe = /^#{1,6}\s*(角色卡|角色线|角色弧线)[:：]?\s*(.+)$/gm;
  const sections: Array<{ kind: 'card' | 'line'; name: string; body: string[] }> = [];
  let cur: { kind: 'card' | 'line'; name: string; body: string[] } | null = null;
  let m2: RegExpExecArray | null;
  while ((m2 = secRe.exec(content))) {
    if (cur) sections.push(cur);
    cur = { kind: m2[1]!.startsWith('角色卡') ? 'card' : 'line', name: m2[2]!.trim(), body: [] };
  }
  if (cur) sections.push(cur);
  // 收集标题到下一个标题之间的内容
  const linesArr = content.split(/\r?\n/);
  let secIdx = 0;
  for (let i = 0; i < linesArr.length; i++) {
    const lm = linesArr[i]!.match(secRe);
    if (lm && secIdx < sections.length && sections[secIdx]!.name === lm[2]!.trim()) secIdx++;
  }
  for (const s of sections) {
    const body = '';
    const item = { path: '设定/' + (s.kind === 'card' ? '角色' : '角色线') + '/' + s.name + '.md', name: s.name, content: body, excerpt: '' };
    if (s.kind === 'card') cards.push(item); else lines.push(item);
  }
  return { cards, lines };
}

/** 角色卡 + 角色线 双视图（character-card-line：卡=契约 / 线=演进；无 设定/角色 时从产物解析兜底） */
export function CharactersDualView({ bookId, onOpenCard }: { bookId: string; onOpenCard: (path: string) => void }) {
  const [cards, setCards] = useState<CharFile[]>([]);
  const [lines, setLines] = useState<CharFile[]>([]);
  const [fromFallback, setFromFallback] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const tree = (await api.tree(bookId)).tree;
        const cardPaths: string[] = [];
        const linePaths: string[] = [];
        const walk = (nodes: any[], prefix: string) => {
          for (const n of nodes) {
            if (n.type === 'dir') walk(n.children ?? [], n.path);
            else if (n.path.startsWith('设定/角色/') && n.path.endsWith('.md')) cardPaths.push(n.path);
            else if (/角色线\/.+\.md$/.test(n.path)) linePaths.push(n.path);
            else if (n.path.startsWith('大纲/角色线/') && n.path.endsWith('.md')) linePaths.push(n.path);
          }
        };
        walk(tree, '');
        const unique = (a: string[]) => [...new Set(a)];
        const mk = (p: string) => ({ path: p, name: p.split('/').pop()!.replace(/\.md$/, ''), content: '', excerpt: '' });
        const cardFiles = [] as CharFile[];
        for (const p of unique(cardPaths)) { const f = await api.readFile(bookId, p); const b = f.content; cardFiles.push({ path: p, name: p.split('/').pop()!.replace(/\.md$/, ''), content: b, excerpt: b.replace(/^---[\s\S]*?---\s*/,'').replace(/#.*\n/,'').trim().slice(0,140) }); }
        const lineFiles = [] as CharFile[];
        for (const p of unique(linePaths)) { const f = await api.readFile(bookId, p); const b = f.content; lineFiles.push({ path: p, name: p.split('/').pop()!.replace(/\.md$/, ''), content: b, excerpt: b.replace(/^---[\s\S]*?---\s*/,'').replace(/#.*\n/,'').trim().slice(0,140) }); }

        let cards = cardFiles;
        let lines = lineFiles;
        let fallback = false;
        if (!cards.length && !lines.length) {
          // 兜底：解析 设定/产物.md、characters/产物.md、大纲/大纲.md 中的角色块
          for (const cand of ['设定/产物.md', 'characters/产物.md', '大纲/产物.md']) {
            try {
              const f = await api.readFile(bookId, cand);
              const parsed = parseFallback(f.content);
              if (parsed.cards.length || parsed.lines.length) { cards = parsed.cards; lines = parsed.lines; fallback = true; break; }
            } catch { /* 文件不存在继续 */ }
          }
        }
        if (!cancelled) { setCards(cards); setLines(lines); setFromFallback(fallback); }
      } catch (e) { /* ignore */ } finally { if (!cancelled) setLoading(false); }
    };
    load();
    return () => { cancelled = true; };
  }, [bookId]);

  const memo = useMemo(() => ({ cards, lines }), [cards, lines]);
  if (loading) return <div style={{ color: 'var(--ink-2)' }}>正在读角色…</div>;

  return (
    <div>
      <h2 className="page-title" style={{ fontSize: 18, marginBottom: 4 }}>角色 · 双视图</h2>
      <p style={{ color: 'var(--ink-2)', fontSize: 13, marginTop: 0 }}>
        卡 = 不变契约（设定/角色/） · 线 = 变化演进（角色线/）
        {fromFallback && <span className="mono" style={{ color: 'var(--gold-saffron)', marginLeft: 8 }}>（从产物解析，可到工作台跑「characters」阶段固化）</span>}
      </p>

      <h3 className="serif" style={{ fontSize: 15, color: 'var(--ink-2)', margin: '18px 0 8px' }}>角色卡（{memo.cards.length}）</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
        {memo.cards.length === 0 && <div style={{ color: 'var(--ink-2)', fontSize: 13 }}>暂无角色卡。到工作台跑 characters 阶段产出。</div>}
        {memo.cards.map((c) => (
          <div key={c.path} className="tt-card" style={{ cursor: 'pointer' }} onClick={() => onOpenCard(c.path)} title={c.path}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 34, height: 34, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'color-mix(in srgb, var(--gold-saffron) 18%, var(--paper))', border: '1px solid var(--line)', fontSize: 16, flexShrink: 0 }}>{c.name[0]?.toUpperCase()}</span>
              <strong className="serif">{c.name}</strong>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 8, lineHeight: 1.6, minHeight: 48, whiteSpace: 'pre-wrap' }}>{c.excerpt || '（空）'}</div>
          </div>
        ))}
      </div>

      <h3 className="serif" style={{ fontSize: 15, color: 'var(--ink-2)', margin: '22px 0 8px' }}>角色线看板（{memo.lines.length}）</h3>
      {memo.lines.length === 0 && <div style={{ color: 'var(--ink-2)', fontSize: 13 }}>暂无角色线。运行 characters 阶段产出线骨架。</div>}
      <div style={{ display: 'grid', gap: 6 }}>
        {memo.lines.map((l) =>
          fromFallback ? (
            <div key={l.path} className="rail-block" style={{ margin: 0 }}>
              <div className="rb-title">◈ {l.name}（从产物解析）</div>
              <div style={{ fontSize: 12.5, color: 'var(--ink-2)', whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>{l.excerpt || l.content.slice(0, 400) || '（空）'}</div>
            </div>
          ) : (
            <CharacterLineBoard key={l.path} bookId={bookId} name={l.name} />
          ),
        )}
      </div>
    </div>
  );
}

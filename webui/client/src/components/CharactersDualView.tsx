import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.ts';

interface CharFile {
  path: string;
  name: string;
  content: string;
  excerpt: string;
}

/** 角色卡 + 角色线 双视图（character-card-line：卡=契约 / 线=演进） */
export function CharactersDualView({
  bookId,
  onOpenCard,
}: {
  bookId: string;
  onOpenCard: (path: string) => void;
}) {
  const [cards, setCards] = useState<CharFile[]>([]);
  const [lines, setLines] = useState<CharFile[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const tree = (await api.tree(bookId)).tree;
        // 收集 设定/角色/*.md 与 角色线/*.md（设定/角色线 + 大纲/角色线）
        const cardPaths: string[] = [];
        const linePaths: string[] = [];
        const walk = (nodes: any[], prefix: string) => {
          for (const n of nodes) {
            if (n.type === 'dir') walk(n.children ?? [], n.path);
            else if (n.path.startsWith('设定/角色/') && n.path.endsWith('.md')) cardPaths.push(n.path);
            else if (n.path.endsWith('角色线/') || /角色线\/.+\.md$/.test(n.path)) linePaths.push(n.path);
            else if (n.path.startsWith('大纲/角色线/') && n.path.endsWith('.md')) linePaths.push(n.path);
          }
        };
        walk(tree, '');
        const unique = (a: string[]) => [...new Set(a)];
        const cardFiles = await Promise.all(
          unique(cardPaths).map(async (p) => {
            const f = await api.readFile(bookId, p);
            return {
              path: p,
              name: p.split('/').pop()!.replace(/\.md$/, ''),
              content: f.content,
              excerpt: f.content.replace(/^---[\s\S]*?---\s*/, '').replace(/#.*\n/, '').trim().slice(0, 160),
            };
          }),
        );
        const lineFiles = await Promise.all(
          unique(linePaths.map((p) => p)).map(async (p) => {
            const f = await api.readFile(bookId, p);
            return {
              path: p,
              name: p.split('/').pop()!.replace(/\.md$/, ''),
              content: f.content,
              excerpt: f.content.replace(/^---[\s\S]*?---\s*/, '').replace(/#.*\n/, '').trim().slice(0, 160),
            };
          }),
        );
        if (!cancelled) {
          setCards(cardFiles);
          setLines(lineFiles);
        }
      } catch (e) {
        /* ignore */
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  const memo = useMemo(() => ({ cards, lines }), [cards, lines]);

  if (loading) return <div style={{ color: 'var(--ink-2)' }}>正在读角色…</div>;

  return (
    <div>
      <h2 className="page-title" style={{ fontSize: 18, marginBottom: 4 }}>
        角色 · 双视图
      </h2>
      <p style={{ color: 'var(--ink-2)', fontSize: 13, marginTop: 0 }}>
        卡 = 不变契约（设定/角色/） · 线 = 变化演进（角色线/）
      </p>

      {/* 角色卡网格 */}
      <h3 className="serif" style={{ fontSize: 15, color: 'var(--ink-2)', margin: '18px 0 8px' }}>
        角色卡（{memo.cards.length}）
      </h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
        {memo.cards.length === 0 && (
          <div style={{ color: 'var(--ink-2)', fontSize: 13 }}>暂无角色卡。运行 characters 阶段产出。</div>
        )}
        {memo.cards.map((c) => (
          <div
            key={c.path}
            className="tt-card"
            style={{ cursor: 'pointer' }}
            onClick={() => onOpenCard(c.path)}
            title={c.path}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  width: 34, height: 34, borderRadius: '50%', display: 'inline-flex', alignItems: 'center',
                  justifyContent: 'center', background: 'color-mix(in srgb, var(--gold-saffron) 18%, var(--paper))',
                  border: '1px solid var(--line)', fontSize: 16, flexShrink: 0,
                }}
              >
                {c.name[0]?.toUpperCase()}
              </span>
              <strong className="serif">{c.name}</strong>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 8, lineHeight: 1.6, minHeight: 48 }}>
              {c.excerpt || '（空）'}
            </div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--ink-2)', marginTop: 8 }}>
              设定/角色/{c.name}.md
            </div>
          </div>
        ))}
      </div>

      {/* 角色线看板 */}
      <h3 className="serif" style={{ fontSize: 15, color: 'var(--ink-2)', margin: '22px 0 8px' }}>
        角色线看板（{memo.lines.length}）
      </h3>
      {memo.lines.length === 0 && (
        <div style={{ color: 'var(--ink-2)', fontSize: 13 }}>暂无角色线。运行 characters 阶段产出线骨架。</div>
      )}
      <div style={{ display: 'grid', gap: 10 }}>
        {memo.lines.map((l) => {
          const stages = (l.content.match(/^-\s*阶段\d+[（(].*?[）)]/gm) ?? []).map((s) => s.replace(/^-\s*/, ''));
          return (
            <div key={l.path} className="rail-block" style={{ background: 'var(--paper)', cursor: 'pointer' }} onClick={() => onOpenCard(l.path)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong className="serif">《{l.name}》</strong>
                <span className="mono" style={{ fontSize: 11, color: 'var(--ink-2)' }}>{l.path}</span>
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                {stages.length === 0 && <span style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>{l.excerpt}</span>}
                {stages.map((s, i) => {
                  const active = /active/.test(s);
                  const done = /done/.test(s);
                  return (
                    <span
                      key={i}
                      className={`seal ${done ? 'seal-pass' : active ? 'seal-pending' : ''}`}
                      style={{ padding: '4px 10px', fontSize: 12 }}
                    >
                      {s}
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

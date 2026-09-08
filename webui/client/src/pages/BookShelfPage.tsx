import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, Book } from '../api/client.ts';

/** P0 项目书房 */
export function BookShelfPage({ inside }: { inside?: boolean }) {
  const [books, setBooks] = useState<Book[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api
      .listBooks()
      .then((r) => setBooks(r.items))
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <h1 className="serif" style={{ margin: '0 0 6px' }}>
        我的书房
      </h1>
      <p style={{ color: 'var(--ink-2)', margin: '0 0 18px' }}>
        {loading ? '正在翻开书架…' : `${books.length} 个项目`}
      </p>

      {error && <div style={{ color: 'var(--red-vermillion)' }}>加载失败：{error}</div>}

      <div className="shelf-grid">
        {books.map((b) => (
          <div
            key={b.id}
            className="tt-card shelf-card"
            onClick={() => navigate(b.kind === 'teardown' ? `/teardowns/${b.id}` : `/novels/${b.id}`)}
          >
            <div className="tt-colorbar" style={{ background: b.theme_color ?? '#B8860B' }} />
            <div className="tt-title">《{b.name}》</div>
            <div className="tt-meta">
              <div>
                类型：{b.kind === 'novel-project' ? '小说项目' : b.kind === 'novel' ? '小说' : '拆文'}
              </div>
              <div>流水线：{b.pipeline ?? '—'}</div>
              {b.active_stage && <div>当前阶段：{b.active_stage}</div>}
              <div style={{ opacity: 0.7 }}>{new Date(b.updated_at).toLocaleString('zh-CN')}</div>
            </div>
          </div>
        ))}
        <Link to="/projects/new" className="tt-card shelf-card" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 120, borderStyle: 'dashed', color: 'var(--ink-2)' }}>
          ＋ 新建项目
        </Link>
      </div>

      <div className="recent">
        <h3>最近动笔</h3>
        {books.length === 0 && <div className="recent-line">还没有书稿。点击「新建项目」开一本。</div>}
        {books.slice(0, 5).map((b) => (
          <div key={b.id} className="recent-line">
            <Link to={`/novels/${b.id}`} style={{ color: 'var(--ink)' }}>
              小说《{b.name}》
            </Link>
            <span style={{ color: 'var(--ink-2)' }}>
              {b.active_stage ? ` · ${b.active_stage}` : ''} · {new Date(b.updated_at).toLocaleDateString('zh-CN')}
            </span>
            {b.active_stage === 'review' && <span className="seal seal-pending" style={{ marginLeft: 8 }}>待确认</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

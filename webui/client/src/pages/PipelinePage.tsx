import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, BookDetail } from '../api/client.ts';

const STAGES: Array<{ id: string; label: string }> = [
  { id: 'intake', label: '需求' },
  { id: 'concept', label: '概念' },
  { id: 'characters', label: '角色' },
  { id: 'outline', label: '大纲' },
  { id: 'chapter', label: '正文' },
  { id: 'review', label: '审校' },
  { id: 'deslop', label: '去AI味' },
  { id: 'cover', label: '封面' },
  { id: 'export', label: '导出' },
];

const ACTIONS = [
  { id: 'approve', label: '✓ 通过', cls: 'seal-pass' },
  { id: 'edit_rerun', label: '✎ 改后重跑', cls: 'seal-pending' },
  { id: 'reject_regen', label: '✕ 驳回重写', cls: 'seal-blocking' },
  { id: 'skip', label: '→ 跳过', cls: '' },
] as const;

/** P4 流程看板：阶段轴 + 每步确认（批阅栏） */
export function PipelinePage() {
  const { bookId } = useParams();
  const [book, setBook] = useState<BookDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [acting, setActing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!bookId) return;
    setLoading(true);
    api
      .getBook(bookId)
      .then((b) => {
        setBook(b);
        setError(null);
      })
      .catch((e) => setError(e?.message ?? String(e)))
      .finally(() => setLoading(false));
  }, [bookId]);

  useEffect(load, [load]);

  const stageMap = new Map((book?.stages ?? []).map((s) => [s.stage_id, s]));

  const reviewAction = async (action: string) => {
    if (!bookId) return;
    setActing(true);
    setToast(null);
    try {
      const stage = currentReviewStage();
      const res = await fetch(`/api/books/${bookId}/stages/${stage}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, note: note || undefined }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      setToast(`已落款「${ACTIONS.find((a) => a.id === action)?.label ?? action}」，audit: ${body.audit_id ?? '?'} 已留痕`);
      setNote('');
      load();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setActing(false);
    }
  };

  const currentReviewStage = () =>
    [...STAGES].reverse().find((s) => stageMap.get(s.id)?.status === 'review')?.id ?? 'outline';

  if (loading) return <div>正在读流程…</div>;
  if (error || !book) {
    return (
      <div>
        <div style={{ color: 'var(--red-vermillion)' }}>加载失败：{error}</div>
        <Link to={`/novels/${bookId}`} className="ink-btn" style={{ marginTop: 12 }}>
          返回工作台
        </Link>
      </div>
    );
  }

  const reviewing = currentReviewStage();

  return (
    <div style={{ maxWidth: 1000 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <h1 className="serif" style={{ margin: 0, fontSize: 20 }}>
          《{book.name}》流程看板
        </h1>
        <span className="mono" style={{ fontSize: 12, color: 'var(--ink-2)' }}>
          流水线 {book.pipeline ?? '—'} · rev 见阶段
        </span>
        <button className="ink-btn" style={{ marginLeft: 'auto', padding: '4px 12px', fontSize: 13 }} onClick={load}>
          ⟳ 刷新
        </button>
      </div>
      <div style={{ color: 'var(--ink-2)', fontSize: 13, marginBottom: 16 }}>
        每阶段产物确认后才会进入下一步（每步确认）。
      </div>

      <div className="pipeline-axis">
        {STAGES.map((s, i) => {
          const st = stageMap.get(s.id);
          const status = st?.status ?? 'pending';
          return (
            <div
              key={s.id}
              className={`stage-chip ${status === 'done' ? 'done' : status === 'review' ? 'review' : status === 'blocked' ? 'blocked' : ''}`}
              title={`${s.label}: ${status}`}
            >
              <div className="chip-id">
                {i + 1}. {s.id}
              </div>
              <div className="chip-status">
                {status === 'done' ? '✓ 已过' : status === 'review' ? '待确认' : status === 'blocked' ? '阻塞' : status === 'running' ? '运行中' : '未启'}
              </div>
            </div>
          );
        })}
      </div>

      {/* 当前阶段卡 */}
      {(() => {
        const st = stageMap.get(reviewing);
        const done = [...STAGES].filter((s) => stageMap.get(s.id)?.status === 'done').length;
        return (
          <div className="rail-block" style={{ background: 'var(--paper)', padding: '16px 18px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <strong className="serif" style={{ fontSize: 16 }}>
                当前阶段：{reviewing} · {STAGES.find((s) => s.id === reviewing)?.label}
              </strong>
              <span className="mono" style={{ fontSize: 12, color: 'var(--ink-2)' }}>
                总进度 {done}/{STAGES.length}
              </span>
            </div>
            <div style={{ color: 'var(--ink-2)', fontSize: 13, lineHeight: 1.8 }}>
              status: <span className="mono">{st?.status ?? 'pending'}</span>
              {st?.revision ? ` · revision ${st.revision}` : ''}
              {st?.note ? ` · 备注: ${st.note}` : ''}
            </div>
            <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
              <Link to={`/novels/${bookId}?module=chapters`} className="ink-btn">
                去手稿
              </Link>
              <Link to={`/novels/${bookId}?module=state`} className="ink-btn">
                追踪看板
              </Link>
            </div>
          </div>
        );
      })()}

      {toast && (
        <div
          className="stamp-in"
          style={{
            marginTop: 12,
            padding: '10px 14px',
            border: '1px solid var(--green-jade)',
            color: 'var(--green-jade)',
            borderRadius: 6,
            fontSize: 13,
            background: 'color-mix(in srgb, var(--green-jade) 8%, var(--paper))',
          }}
        >
          {toast}
        </div>
      )}

      {/* 批阅栏（底部浮动） */}
      <div className="review-bar">
        <div className="rb-meta">
          <strong>批阅 {reviewing}</strong>
          <div style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 2 }}>
            每步确认（M0：演示交互，实际推进在 M1 引擎实装）
          </div>
        </div>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="批语 / 修改要求（可选）…"
        />
        {ACTIONS.map((a) => (
          <button
            key={a.id}
            className="ink-btn"
            style={{ padding: '7px 14px' }}
            disabled={acting}
            onClick={() => reviewAction(a.id)}
          >
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}

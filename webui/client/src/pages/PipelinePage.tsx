import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, sseJobs } from '../api/client.ts';

const ACTIONS = [
  { id: 'approve', label: '✓ 通过', cls: 'seal-pass' },
  { id: 'edit_rerun', label: '✎ 改后重跑', cls: 'seal-pending' },
  { id: 'reject_regen', label: '✕ 驳回重写', cls: 'seal-blocking' },
  { id: 'skip', label: '→ 跳过', cls: '' },
] as const;

interface StageView {
  id: string;
  title: string;
  type: string;
  status: string;
  revision: number;
  requires: string[];
  gates: string[];
}

/** M1.9 流程看板：阶段轴 + 运行控制 + 批阅栏（接真实引擎） */
export function PipelinePage() {
  const { bookId } = useParams();
  const [stages, setStages] = useState<StageView[]>([]);
  const [bookName, setBookName] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [acting, setActing] = useState<{ stage: string; action: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [fakeMode, setFakeMode] = useState(true);
  const [runningStage, setRunningStage] = useState<string | null>(null);
  const [liveEvents, setLiveEvents] = useState<Array<{ name: string; data: any }>>([]);
  const [latestGates, setLatestGates] = useState<any>(null);
  const [currentCost, setCurrentCost] = useState<any>(null);
  const closeSseRef = useRef<(() => void) | null>(null);

  const load = useCallback(() => {
    if (!bookId) return;
    setLoading(true);
    Promise.all([api.stages(bookId), api.getBook(bookId)])
      .then(([s, b]) => {
        setStages(s.stages ?? []);
        setBookName(b.name);
        setError(null);
      })
      .catch((e) => setError(e?.message ?? String(e)))
      .finally(() => setLoading(false));
  }, [bookId]);

  useEffect(load, [load]);

  // SSE 订阅
  useEffect(() => {
    if (!bookId) return;
    const close = sseJobs(bookId, (name, data) => {
      if (name === 'job:review') {
        setLatestGates(data.latest_gates ?? null);
        setCurrentCost(data.cost ?? { total_cents: 0 });
        setRunningStage(null);
      } else if (name === 'job:error') {
        setToast(`⚠️ job 出错：${data.message ?? ''}`);
        setRunningStage(null);
      } else if (name === 'job:start') {
        setRunningStage(data.stage ?? null);
        setLatestGates(null);
      } else if (name === 'gate:batch') {
        setLatestGates((prev: any) => ({
          ...(prev ?? {}),
          [data.gate]: { ok: data.ok, blocking: data.blocking ?? [], warnings: data.warnings ?? [] },
        }));
      }
      setLiveEvents((arr) => [...arr.slice(-9), { name, data }]);
    });
    closeSseRef.current = close;
    return close;
  }, [bookId]);

  useEffect(() => {
    if (runningStage === null) return;
    const t = setTimeout(load, 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningStage, latestGates]);

  const runStage = async (id: string) => {
    setError(null);
    setToast(null);
    setLatestGates(null);
    try {
      const r = await api.runStage(bookId!, id, fakeMode);
      setToast(`已发起 ${id}（job:${r.job_id}）…`);
      setRunningStage(r.stage ?? id);
      setTimeout(load, 1200);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };

  const runAllPending = async () => {
    setError(null);
    const pendId = currentReviewStage() ?? stages.find((s) => s.status === 'pending')?.id;
    if (pendId) await runStage(pendId);
  };

  const review = async (action: string) => {
    const stage = currentReviewStage();
    if (!stage || acting) return;
    setActing({ stage, action });
    setError(null);
    try {
      const r = await api.reviewStage(bookId!, stage, action, note || undefined);
      setToast(`已落款「${ACTIONS.find((a) => a.id === action)?.label}」audit ${r.audit_id}，状态 ${r.status}`);
      setNote('');
      setTimeout(load, 400);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setActing(null);
    }
  };

  const reviewStageStatus = (id: string) => stages.find((s) => s.id === id)?.status ?? 'pending';
  const currentReviewStage = () =>
    stages.find((s) => s.status === 'review')?.id ??
    stages.find((s) => s.status === 'blocked')?.id ??
    stages.find((s) => s.status === 'pending')?.id;

  if (loading) return <div>正在读流程…</div>;
  if (error && stages.length === 0) {
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
  const doneCount = stages.filter((s) => s.status === 'done' || s.status === 'skipped').length;

  return (
    <div style={{ maxWidth: 1000 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4, flexWrap: 'wrap' }}>
        <h1 className="serif" style={{ margin: 0, fontSize: 20 }}>
          《{bookName}》流程看板
        </h1>
        <span className="mono" style={{ fontSize: 12, color: 'var(--ink-2)' }}>
          阶段 {doneCount}/{stages.length} · 内循环重跑 ≤2（引擎自动）
        </span>
        <span style={{ flex: 1 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          <input type="checkbox" checked={fakeMode} onChange={(e) => setFakeMode(e.target.checked)} />
          假渠道（demo e2e，不耗上游）
        </label>
        <button className="ink-btn" style={{ padding: '5px 12px', fontSize: 13 }} onClick={load}>
          ⟳ 刷新
        </button>
      </div>
      <div style={{ color: 'var(--ink-2)', fontSize: 13, marginBottom: 14 }}>
        每阶段产物确认后才会进入下一步（每步确认）。运行中看浮签"墨迹"流。
      </div>

      {error && (
        <div style={{ padding: '9px 14px', border: '1px solid var(--red-vermillion)', color: 'var(--red-vermillion)', borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
          ⚠️ {error}
        </div>
      )}
      {toast && (
        <div className="stamp-in" style={{ padding: '9px 14px', border: '1px solid var(--green-jade)', color: 'var(--green-jade)', borderRadius: 6, marginBottom: 12, fontSize: 13, background: 'color-mix(in srgb, var(--green-jade) 6%, var(--paper))' }}>
          {toast}
        </div>
      )}

      {/* 阶段轴 */}
      <div className="pipeline-axis">
        {stages.map((s, i) => {
          const status = s.status;
          return (
            <div
              key={s.id}
              className={`stage-chip ${status === 'done' ? 'done' : status === 'review' ? 'review' : status === 'blocked' ? 'blocked' : status === 'running' || runningStage === s.id ? 'review' : ''}`}
              title={`${s.title}: ${status}`}
            >
              <div className="chip-id">
                {i + 1}. {s.id}
              </div>
              <div className="chip-status">
                {runningStage === s.id
                  ? '运行中…'
                  : status === 'done'
                    ? '✓ 已过'
                    : status === 'review'
                      ? '待确认'
                      : status === 'blocked'
                        ? '阻塞'
                        : status === 'running'
                          ? '运行中'
                          : status === 'skipped'
                            ? '跳过'
                            : '未启'}
              </div>
              {s.gates.length > 0 && (
                <div className="mono" style={{ fontSize: 10, color: 'var(--ink-2)', marginTop: 4 }}>
                  {s.gates.join('·')}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 当前阶段卡 */}
      {reviewing && (
        <div className="rail-block" style={{ background: 'var(--paper)', padding: '16px 18px', marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
            <strong className="serif" style={{ fontSize: 16 }}>
              当前阶段：{reviewing} · {stages.find((s) => s.id === reviewing)?.title}
            </strong>
            <button className="ink-btn" style={{ padding: '5px 12px', fontSize: 13 }} disabled={!!runningStage} onClick={() => runStage(reviewing)}>
              {runningStage === reviewing ? '运行中…' : '▶ 运行本阶段'}
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {stages
              .filter((s) => s.status === 'pending' || s.status === 'blocked')
              .slice(0, 8)
              .map((s) => (
                <button key={s.id} className="ink-btn" style={{ padding: '4px 10px', fontSize: 12 }} disabled={!!runningStage} onClick={() => runStage(s.id)}>
                  {s.status === 'blocked' ? '重跑' : '运行'} {s.id}
                </button>
              ))}
          </div>

          {/* 门禁快报 */}
          {latestGates && (
            <div style={{ marginTop: 12, display: 'grid', gap: 6 }}>
              {Object.entries(latestGates).map(([gate, gv]: any) => (
                <div key={gate} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', border: '1px solid var(--line)', borderRadius: 5, fontSize: 12.5 }}>
                  <strong style={{ minWidth: 130 }}>{gate}</strong>
                  <span className={`seal ${gv?.blocking?.length ? 'seal-blocking' : gv?.ok ? 'seal-pass' : 'seal-pending'}`}>
                    {gv?.blocking?.length ? `${gv.blocking.length} 阻塞` : gv?.ok ? 'PASS' : '有警示'}
                  </span>
                  {gv?.blocking?.length > 0 && (
                    <span style={{ color: 'var(--red-vermillion)', fontSize: 12 }}>
                      {(gv.blocking as any[]).slice(0, 3).map((b) => b.rule).join('、')}
                    </span>
                  )}
                  {gv?.warnings?.length > 0 && (
                    <span style={{ color: 'var(--gold-saffron)', fontSize: 12 }}>
                      {gv.warnings.length} 警示
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* 运行流墨迹 */}
          {liveEvents.filter((e) => e.name === 'job:progress').length > 0 && (
            <div className="mono" style={{ marginTop: 10, padding: '8px 10px', background: 'var(--paper-2)', borderRadius: 5, fontSize: 12, maxHeight: 90, overflow: 'auto', color: 'var(--ink-2)' }}>
              {liveEvents.filter((e) => e.name === 'job:progress').slice(-5).map((e, i) => (
                <div key={i}>{String(e.data?.text ?? e.data?.phase ?? '').slice(0, 120)}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 批阅栏（底部浮动） */}
      <div className="review-bar">
        <div className="rb-meta">
          <strong>批阅：{reviewing ?? '—'}（{stages.find((s) => s.id === reviewing)?.title ?? ''}）</strong>
          <div style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 2 }}>
            {currentCost ? `本阶段已用 ¥${(currentCost.total_cents / 100).toFixed(2)}` : '尚未运行'} · 通过/改后重跑/驳回均写 audit
          </div>
        </div>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="批语 / 修改要求（可选）…" />
        {ACTIONS.map((a) => (
          <button
            key={a.id}
            className="ink-btn"
            style={{ padding: '7px 14px' }}
            disabled={!!acting || runningStage === reviewing}
            onClick={() => review(a.id)}
          >
            {acting?.action === a.id ? '…' : a.label}
          </button>
        ))}
      </div>
    </div>
  );
}

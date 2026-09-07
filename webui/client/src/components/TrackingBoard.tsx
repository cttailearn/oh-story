import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.ts';

/** 状态模块：追踪看板（webui-frontend §3.4，只读投影 GET /tracking） */
export function TrackingBoard({ bookId }: { bookId: string }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .tracking(bookId)
      .then((d) => setData(d))
      .catch((e) => setError(e?.message ?? String(e)))
      .finally(() => setLoading(false));
  }, [bookId]);

  useEffect(load, [load]);

  if (loading) return <div style={{ color: 'var(--ink-)' }}>正在读追踪状态…</div>;
  if (error || !data) {
    return (
      <div>
        <div style={{ color: 'var(--red-vermillion)' }}>无法读取追踪状态：{error ?? '空'}</div>
        <div style={{ marginTop: 10 }}>
          <button className="ink-btn" onClick={load}>
            重试
          </button>
        </div>
      </div>
    );
  }

  const characters = Array.isArray(data.characters) ? data.characters : [];
  const foreshadow = Array.isArray(data.foreshadow) ? data.foreshadow : [];
  const timeline = Array.isArray(data.timeline) ? data.timeline : [];
  const risks = Array.isArray(data.risks) ? data.risks : [];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <h2 className="page-title" style={{ fontSize: 18 }}>
          状态 · 追踪看板
        </h2>
        <span className="mono" style={{ fontSize: 12, color: 'var(--ink-2)' }}>
          {data.sourcePath} · schema v{data.schema_version} · rev {data.state_revision}
        </span>
        <button className="ink-btn" style={{ marginLeft: 'auto', padding: '4px 12px', fontSize: 13 }} onClick={load}>
          ⟳ 刷新
        </button>
      </div>

      {/* 进度区 */}
      <div className="rail-block">
        <div className="rb-title">进度</div>
        <div style={{ fontSize: 20, fontFamily: 'var(--font-serif)' }}>
          已连载至 <strong>第{data.last_committed_chapter ?? data.imported_through_chapter ?? 0}章</strong>
        </div>
        <div style={{ color: 'var(--ink-2)', fontSize: 13, marginTop: 6 }}>
          后续待办：{data.next_commitment ?? '—'}
        </div>
      </div>

      {/* 位置区 */}
      {data.position && (
        <div className="rail-block">
          <div className="rb-title">此刻在哪（position）</div>
          {Object.entries(data.position || {}).map(([k, v]) => (
            <div key={k} style={{ fontSize: 13, lineHeight: 1.8 }}>
              <strong>{k}</strong>：{String(v ?? '—')}
            </div>
          ))}
        </div>
      )}

      {/* 角色状态 */}
      <div className="rail-block">
        <div className="rb-title">角色状态（{characters.length}）</div>
        <div style={{ display: 'grid', gap: 8 }}>
          {characters.map((c: any) => (
            <div key={c.name} style={{ border: '1px solid var(--line)', borderRadius: 6, padding: '10px 12px', background: 'var(--paper)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong className="serif">{c.name}</strong>
                {c.open_threads > 0 && (
                  <span className="seal seal-blocking">{c.open_threads} 开放线程</span>
                )}
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 4, lineHeight: 1.7 }}>
                <div>状态：{c.state ?? '—'}</div>
                <div>目标：{c.goal ?? '—'}</div>
                {c.location && <div>位置：{c.location}</div>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 伏笔看板 */}
      <div className="rail-block">
        <div className="rb-title">伏笔看板（{foreshadow.length}）</div>
        {foreshadow.length === 0 && <div style={{ fontSize: 13, color: 'var(--ink-2)' }}>暂无登记伏笔。</div>}
        <div style={{ display: 'grid', gap: 6 }}>
          {foreshadow.map((f: any) => (
            <div
              key={f.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                border: '1px solid var(--line)',
                borderRadius: 4,
                padding: '7px 10px',
                fontSize: 13,
              }}
            >
              <span className="mono" style={{ color: 'var(--ink-2)' }}>{f.id}</span>
              <span style={{ flex: 1, margin: '0 10px' }}>{f.summary ?? '—'}</span>
              <SealForStatus status={f.status} importance={f.importance} />
            </div>
          ))}
        </div>
      </div>

      {/* 时间线 */}
      <div className="rail-block">
        <div className="rb-title">时间线（{timeline.length}）</div>
        {timeline.length === 0 && <div style={{ fontSize: 13, color: 'var(--ink-2)' }}>暂无事件。</div>}
        {timeline.map((e: any) => (
          <div key={e.id} style={{ fontSize: 13, padding: '4px 0', opacity: e.reveal_status === '未揭示' ? 0.55 : 1 }}>
            <span className="mono" style={{ color: 'var(--ink-2)', marginRight: 8 }}>{e.id}</span>
            {e.summary ?? e.event ?? e.story_time ?? '—'}{' '}
            {e.reveal_status && <span style={{ fontSize: 11.5, color: 'var(--ink-2)' }}>（{e.reveal_status}）</span>}
          </div>
        ))}
      </div>

      {/* 风险/红线（批注栏，不可一键修改） */}
      {risks.length > 0 && (
        <div className="rail-block" style={{ borderColor: 'var(--red-vermillion)', borderLeft: '4px solid var(--red-vermillion)' }}>
          <div className="rb-title" style={{ color: 'var(--red-vermillion)' }}>
            风险 / 红线（经修订流程方可改）
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
            {risks.map((r: any, i: number) => (
              <li key={i}>{typeof r === 'string' ? r : JSON.stringify(r)}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SealForStatus({ status, importance }: { status?: string; importance?: string }) {
  let cls = 'seal-pass';
  let label = status ?? '—';
  if (status === '已埋' || status === '待收') cls = 'seal-blocking';
  else if (status === '已揭示') cls = 'seal-pass';
  else cls = 'seal-pending';
  return (
    <span className={`seal ${cls}`}>
      {label}
      {importance && importance === '高' ? ' 高' : ''}
    </span>
  );
}

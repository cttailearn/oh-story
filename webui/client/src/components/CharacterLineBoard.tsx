import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.ts';

interface ArcStage { no: number; title: string; range: string; status: string; goals: string[]; acceptance: string[]; evidence: string[] }
interface ArcData { name: string; stages: ArcStage[]; current: { no: number; status: string } | null; progress: string; audit: string[] }

interface Props { bookId: string; name: string; onError?: (m: string) => void }

/** 角色线看板（character-card-line §3.2）：泳道 + 阶段条 + 推进（PUT arc）+ AI 提议 */
export function CharacterLineBoard({ bookId, name, onError }: Props) {
  const [arc, setArc] = useState<ArcData | null>(null);
  const [loading, setLoading] = useState(true);
  const [toStage, setToStage] = useState<number>(1);
  const [toStatus, setToStatus] = useState<'active' | 'done'>('active');
  const [acceptance, setAcceptance] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [proposal, setProposal] = useState<any>(null);

  const load = useCallback(() => {
    setLoading(true);
    api.characterArc(bookId, name).then((d) => {
      setArc({ name, stages: d.arc.stages, current: d.arc.current, progress: d.arc.progress, audit: d.arc.audit });
      setErr(null);
    }).catch((e: any) => setErr(e?.message ?? String(e))).finally(() => setLoading(false));
  }, [bookId, name]);

  useEffect(load, [load]);

  const advance = async () => {
    setBusy(true); setMsg(null); setErr(null);
    try {
      const r = await api.setCharacterArc(bookId, name, {
        to_stage: toStage,
        to_status: toStatus,
        acceptance_done: acceptance.split('\n').map((x) => x.trim()).filter(Boolean),
      });
      setMsg('已推进到阶段 ' + r.arc.current_stage + '（' + r.arc.status + '），audit ' + r.audit_id);
      setProposal(null);
      load();
    } catch (e: any) { setErr(e?.message ?? String(e)); } finally { setBusy(false); }
  };

  const propose = async () => {
    setBusy(true); setMsg(null); setErr(null); setProposal(null);
    try {
      const r = await api.proposeArc(bookId, name, { fake: true, hint: '' });
      setProposal(r);
      setMsg('已生成下阶段草案（diff 未落盘，可推进时按草案填阶段目标/验收）。');
    } catch (e: any) { setErr(e?.message ?? String(e)); } finally { setBusy(false); }
  };

  if (loading) return <div className="mono" style={{ color: 'var(--ink-2)', fontSize: 12 }}>读角色线…</div>;
  if (err && !arc) return <div style={{ color: 'var(--ink-2)', fontSize: 12 }}>{err}</div>;
  if (!arc) return null;

  return (
    <div className="rail-block" style={{ background: 'var(--paper)', margin: '8px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <strong className="serif">《{name}》</strong>
        <span className="mono" style={{ fontSize: 11, color: 'var(--ink-2)' }}>
          当前：{arc.current ? '阶段 ' + arc.current.no + '（' + arc.current.status + '）' : '—'}{arc.progress ? ' · ' + arc.progress : ''}
        </span>
        <button className="ink-btn" style={{ padding: '3px 10px', fontSize: 12 }} onClick={propose} disabled={busy}>
          🤖 AI 提议下阶段
        </button>
      </div>

      {/* 阶段条 */}
      <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
        {arc.stages.map((s) => (
          <span key={s.no} className={`seal ${s.status === 'done' ? 'seal-pass' : s.status === 'active' ? 'seal-pending' : ''}`} style={{ padding: '4px 10px', fontSize: 12 }}>
            {s.no}·{s.title}{s.range ? '（' + s.range + '）' : ''}
          </span>
        ))}
      </div>

      {/* 阶段细节（active 阶段） */}
      {arc.stages.filter((s) => s.status !== 'planned').slice(0, 3).map((s) => (
        <div key={s.no} style={{ marginTop: 8, fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.7 }}>
          <div><strong>阶段 {s.no}</strong>：{s.goals[0] ?? '三层目标待补'}</div>
          {s.acceptance.length > 0 && <div>验收：{s.acceptance.join('；')}</div>}
          {s.evidence.length > 0 && <div>渐变证据：{s.evidence.join('；')}</div>}
        </div>
      ))}

      {proposal && (
        <div style={{ marginTop: 10, padding: '8px 10px', border: '1px dashed var(--gold-saffron)', borderRadius: 6, fontSize: 12.5 }}>
          <strong>下阶段草案</strong>：{proposal.next_stage ?? '（见 diff）'}{proposal.hint ? '（背景：' + proposal.hint + '）' : ''}
          <div className="mono" style={{ marginTop: 4, color: 'var(--ink-2)', fontSize: 11.5 }}>diff: +{proposal.diff?.filter((d: any) => d.type === 'add').length ?? 0} / -{proposal.diff?.filter((d: any) => d.type === 'del').length ?? 0} · 未落盘（采纳后按草案填验收再推进）</div>
        </div>
      )}

      {/* 推进控件 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>推进到</span>
        <input type="number" min={1} value={toStage} onChange={(e) => setToStage(Number(e.target.value))} style={{ width: 56, padding: '3px 6px', border: '1px solid var(--line)', background: 'var(--paper)', color: 'var(--ink)' }} />
        <select value={toStatus} onChange={(e) => setToStatus(e.target.value as any)} style={{ padding: '3px 6px', border: '1px solid var(--line)', background: 'var(--paper)', color: 'var(--ink)' }}>
          <option value="active">active（进行中）</option>
          <option value="done">done（完成）</option>
        </select>
        <input value={acceptance} onChange={(e) => setAcceptance(e.target.value)} placeholder="验收证据（回车分隔，写线文件）" style={{ flex: 1, minWidth: 200, padding: '4px 8px', border: '1px solid var(--line)', background: 'var(--paper)', color: 'var(--ink)', fontSize: 12.5 }} />
        <button className="ink-btn primary" style={{ padding: '4px 12px', fontSize: 12.5 }} onClick={advance} disabled={busy}>
          推进阶段
        </button>
      </div>
      {msg && <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--green-jade)' }}>✅ {msg}</div>}
      {err && <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--red-vermillion)' }}>⚠️ {err}</div>}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { api } from '../api/client.ts';

/** P6 设置页：渠道/预算/偏好 + 连通性（M0：展示与保存通道，渠道测试 M1 实装） */
export function SettingsPage() {
  const [config, setConfig] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .config()
      .then((c) => setConfig(c))
      .catch((e) => setErr(String(e.message ?? e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div>正在读配置…</div>;
  if (err || !config)
    return <div style={{ color: 'var(--red-vermillion)' }}>读取配置失败：{err}</div>;

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const c = await api.putConfig(config);
      setConfig(c);
      setMsg(`配置已保存（${new Date().toLocaleTimeString('zh-CN', { hour12: false })}）`);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ maxWidth: 860 }}>
      <h1 className="serif">设置</h1>
      <p style={{ color: 'var(--ink-2)', fontSize: 13, margin: '0 0 18px' }}>
        配置存于 <span className="mono">webui-config.json</span>（密钥仅此一处明文，权限 0600）
      </p>

      {msg && (
        <div className="stamp-in" style={{ padding: '8px 12px', border: '1px solid var(--green-jade)', color: 'var(--green-jade)', borderRadius: 6, marginBottom: 14, fontSize: 13 }}>
          ✅ {msg}
        </div>
      )}
      {err && (
        <div style={{ padding: '8px 12px', border: '1px solid var(--red-vermillion)', color: 'var(--red-vermillion)', borderRadius: 6, marginBottom: 14, fontSize: 13 }}>
          ⚠️ {err}
        </div>
      )}

      <div className="rail-block">
        <div className="rb-title">渠道（{config.channels?.length ?? 0}）</div>
        {config.channels?.length === 0 && (
          <div style={{ fontSize: 13, color: 'var(--ink-2)', marginBottom: 10 }}>
            尚未配置 AI 渠道。保存后可在 <span className="mono">webui-config.json</span> 补充 <span className="mono">api_key</span>（M1 起提供可视化）。
          </div>
        )}
        {config.channels?.map((ch: any, i: number) => (
          <div key={ch.id} style={{ border: '1px solid var(--line)', borderRadius: 6, padding: '10px 12px', marginBottom: 8, background: 'var(--paper)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>{ch.name}</strong>
              <span className={`seal ${ch.enabled === false ? 'seal-pending' : 'seal-pass'}`}>
                {ch.enabled === false ? '停用' : '启用'}
              </span>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 4 }}>
              <div><span className="mono">{ch.base_url}</span></div>
              <div>模型：{(ch.models ?? []).join('、') || '—'}{ch.image_models?.length ? ` · 生图: ${ch.image_models.join('、')}` : ''}</div>
              <div>key：{ch.api_key ? <span className="mono">{ch.api_key}</span> : '（未填）'}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="rail-block">
        <div className="rb-title">预算</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {(
            [
              ['stage_max_cents', '单阶段上限（分）'],
              ['daily_max_cents', '日上限（分）'],
              ['chapter_max_tokens_out', '单章输出上限（token）'],
              ['context_max_tokens_in', '上下文输入上限（token）'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} style={{ display: 'grid', gap: 4, fontSize: 13 }}>
              <span style={{ color: 'var(--ink-2)' }}>{label}</span>
              <input
                type="number"
                value={config.budget?.[key] ?? 0}
                onChange={(e) =>
                  setConfig((c: any) => ({
                    ...c,
                    budget: { ...c.budget, [key]: Number(e.target.value) || 0 },
                  }))
                }
                style={{
                  background: 'var(--paper)', border: '1px solid var(--line)', color: 'var(--ink)',
                  padding: '6px 8px', borderRadius: 4, fontFamily: 'var(--font-mono)',
                }}
              />
            </label>
          ))}
        </div>
      </div>

      <div className="rail-block">
        <div className="rb-title">偏好</div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5 }}>
          <strong>主题</strong>
          <select
            value={config.prefs?.theme ?? 'day'}
            onChange={(e) =>
              setConfig((c: any) => ({ ...c, prefs: { ...c.prefs, theme: e.target.value } }))
            }
            style={{ background: 'var(--paper)', border: '1px solid var(--line)', color: 'var(--ink)', padding: '5px 8px', borderRadius: 4 }}
          >
            <option value="day">晴窗纸（日间）</option>
            <option value="night">灯下稿（夜间）</option>
          </select>
        </label>
        <div style={{ marginTop: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5 }}>
            <input
              type="checkbox"
              checked={config.prefs?.confirm_required !== false}
              onChange={(e) =>
                setConfig((c: any) => ({ ...c, prefs: { ...c.prefs, confirm_required: e.target.checked } }))
              }
            />
            每步确认（human-in-the-loop）
          </label>
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <button className="ink-btn primary" onClick={save} disabled={saving}>
          {saving ? '保存中…' : '保存设置'}
        </button>
      </div>
    </div>
  );
}

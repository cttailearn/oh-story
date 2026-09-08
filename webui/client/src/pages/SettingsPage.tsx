// P6 设置页：渠道管理（增删/测试）+ 模型路由 + 预算 + 偏好（M1.8）+ 运维页签（M4：诊断/统计/审计CSV/备份/恢复）
import { useEffect, useState } from 'react';
import { api } from '../api/client.ts';
import { OpsPanel } from '../components/OpsPanel.tsx';

/** P6 设置页 */
export function SettingsPage() {
  const [config, setConfig] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [testing, setTesting] = useState<Record<string, any>>({});
  const [tab, setTab] = useState<'config' | 'ops'>('config');

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

  const patchConfig = (fn: (c: any) => any) => setConfig((c: any) => fn(structuredClone(c)));

  const addChannel = () => {
    patchConfig((cfg) => {
      cfg.channels = cfg.channels ?? [];
      const id = `ch_${Date.now().toString(36)}`;
      cfg.channels.push({ id, name: '新渠道', base_url: 'https://api.example.com/v1', models: [], enabled: true });
      return cfg;
    });
  };

  const removeChannel = (id: string) => {
    patchConfig((cfg) => {
      cfg.channels = cfg.channels.filter((ch: any) => ch.id !== id);
      return cfg;
    });
  };

  const testChannel = async (id: string) => {
    setTesting((t) => ({ ...t, [id]: { loading: true } }));
    try {
      const res = await api.testChannel(id);
      setTesting((t) => ({ ...t, [id]: { loading: false, ...res } }));
    } catch (e: any) {
      setTesting((t) => ({ ...t, [id]: { loading: false, ok: false, msg: e?.message ?? String(e) } }));
    }
  };

  const ROLE_KEYS = ['writer', 'architect', 'designer', 'checker', 'researcher', 'explorer'];
  const allModels = (config.channels ?? [])
    .filter((ch: any) => ch.enabled !== false)
    .flatMap((ch: any) => (ch.models ?? []).map((m: string) => ({ channel: ch.id, model: m })));

  const tabBtn: React.CSSProperties = {
    padding: '5px 14px', borderRadius: 4, border: '1px solid var(--line)',
    background: 'var(--paper)', color: 'var(--ink-2)', cursor: 'pointer', fontSize: 13,
  };

  return (
    <div style={{ maxWidth: 960 }}>
      <h1 className="serif">设置</h1>
      <p style={{ color: 'var(--ink-2)', fontSize: 13, margin: '0 0 14px' }}>
        配置存于 <span className="mono">webui-config.json</span>（密钥仅此一处明文，0600）
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <button className="ink-btn" style={{ ...tabBtn, ...(tab === 'config' ? { borderColor: 'var(--gold-saffron)', color: 'var(--ink)' } : {}) }} onClick={() => setTab('config')}>
          设置
        </button>
        <button className="ink-btn" style={{ ...tabBtn, ...(tab === 'ops' ? { borderColor: 'var(--gold-saffron)', color: 'var(--ink)' } : {}) }} onClick={() => setTab('ops')}>
          运维 · 诊断/统计/备份
        </button>
      </div>

      {tab === 'ops' ? (
        <OpsPanel />
      ) : (
        <div>
          {msg && (
            <div className="stamp-in" style={{ padding: '8px 12px', border: '1px solid var(--green-jade)', color: 'var(--green-jade)', borderRadius: 6, marginBottom: 14, fontSize: 13 }}>
              ✅ {msg}
            </div>
          )}
          {err && (
            <div style={{ padding: '8px 12px', border: '1px solid var(--red-vermillion)', color: 'var(--red-vermillion)', borderRadius: 6, marginBottom: 14, fontSize: 13, cursor: 'pointer' }} onClick={() => setErr(null)}>
              ⚠️ {err}
            </div>
          )}

          {/* 渠道管理 */}
          <div className="rail-block">
            <div className="rb-title">
              渠道（{config.channels?.length ?? 0}）
              <button className="ink-btn" style={{ padding: '3px 10px', fontSize: 12 }} onClick={addChannel}>
                ＋ 新增渠道
              </button>
            </div>
            <div style={{ display: 'grid', gap: 10 }}>
              {(config.channels ?? []).map((ch: any, i: number) => {
                const t = testing[ch.id];
                return (
                  <div key={ch.id} style={{ border: '1px solid var(--line)', borderRadius: 6, padding: '12px', background: 'var(--paper)' }}>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <input value={ch.name} onChange={(e) => patchConfig((c) => { c.channels[i].name = e.target.value; return c; })} style={inputStyle} placeholder="渠道名" />
                      <input value={ch.base_url} onChange={(e) => patchConfig((c) => { c.channels[i].base_url = e.target.value; return c; })} style={{ ...inputStyle, flex: 1, minWidth: 260 }} placeholder="https://api.example.com/v1" />
                      <span className={`seal ${ch.enabled === false ? 'seal-pending' : 'seal-pass'}`} style={{ cursor: 'pointer' }} onClick={() => patchConfig((c) => { c.channels[i].enabled = !c.channels[i].enabled; return c; })}>
                        {ch.enabled === false ? '停用' : '启用'}
                      </span>
                      <button className="ink-btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => testChannel(ch.id)} disabled={t?.loading}>
                        {t?.loading ? '测试中…' : '测试连通'}
                      </button>
                      <button className="ink-btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => removeChannel(ch.id)}>
                        删除
                      </button>
                    </div>
                    {ch.api_key && <div className="mono" style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 8 }}>key: {ch.api_key}</div>}
                    <div style={{ marginTop: 8 }}>
                      <span style={{ fontSize: 12, color: 'var(--ink-2)', marginRight: 6 }}>模型目录（逗号分隔）：</span>
                      <input value={(ch.models ?? []).join(', ')} onChange={(e) => patchConfig((c) => { c.channels[i].models = e.target.value.split(/[,，\s]+/).filter(Boolean); return c; })} style={{ ...inputStyle, minWidth: 360, fontFamily: 'var(--font-mono)' }} placeholder="gpt-image-2, deepseek-v4-pro, …" />
                    </div>
                    {t?.ok && <div style={{ fontSize: 12.5, color: 'var(--green-jade)', marginTop: 6, lineHeight: 1.6 }}>✅ {t.msg} {t.models?.length ? `（发现 ${t.models.length} 个模型：${t.models.slice(0, 10).join('、')}…）` : ''}</div>}
                    {t && t.ok === false && <div style={{ fontSize: 12.5, color: 'var(--red-vermillion)', marginTop: 6 }}>❌ {t.msg}（ping {t.llm?.ping_ms}ms）</div>}
                  </div>
                );
              })}
              {(config.channels ?? []).length === 0 && (
                <div style={{ fontSize: 13, color: 'var(--ink-2)' }}>
                  尚无渠道。新增后填 base_url 与模型目录；流程可用「假渠道」开发（POST run 传 fake）。
                </div>
              )}
            </div>
          </div>

          {/* 模型路由 */}
          <div className="rail-block">
            <div className="rb-title">角色 → 模型路由</div>
            {ROLE_KEYS.map((rk) => {
              const cur = config.model_routing?.[rk];
              return (
                <div key={rk} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px dashed var(--line)' }}>
                  <strong style={{ width: 110, fontSize: 13.5 }}>{rk}</strong>
                  <select
                    value={cur ? `${cur.channel}/${cur.model}` : ''}
                    onChange={(e) => {
                      const [channel, model] = e.target.value.split('/');
                      patchConfig((c) => {
                        c.model_routing = c.model_routing ?? {};
                        c.model_routing[rk] = { channel, model };
                        return c;
                      });
                    }}
                    style={selectStyle}
                  >
                    <option value="">（未设置）</option>
                    {allModels.map((m: { channel: string; model: string }) => (
                      <option key={`${m.channel}/${m.model}`} value={`${m.channel}/${m.model}`}>{m.channel} / {m.model}</option>
                    ))}
                  </select>
                  {cur && allModels.some((m: { channel: string; model: string }) => m.channel === cur.channel && m.model === cur.model) && <span className="mono" style={{ fontSize: 12, color: 'var(--green-jade)' }}>✓</span>}
                </div>
              );
            })}
            {allModels.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 8 }}>先在上方渠道填模型目录，这里才能选。</div>}
          </div>

          {/* 预算 */}
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
                  <input type="number" value={config.budget?.[key] ?? 0} onChange={(e) => patchConfig((c) => ({ ...c, budget: { ...c.budget, [key]: Number(e.target.value) || 0 } }))} style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }} />
                </label>
              ))}
            </div>
          </div>

          {/* 偏好 */}
          <div className="rail-block">
            <div className="rb-title">偏好</div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5 }}>
              <strong>主题</strong>
              <select value={config.prefs?.theme ?? 'day'} onChange={(e) => patchConfig((c) => ({ ...c, prefs: { ...c.prefs, theme: e.target.value } }))} style={selectStyle}>
                <option value="day">晴窗纸（日间）</option>
                <option value="night">灯下稿（夜间）</option>
              </select>
            </label>
            <div style={{ marginTop: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5 }}>
                <input type="checkbox" checked={config.prefs?.confirm_required !== false} onChange={(e) => patchConfig((c) => ({ ...c, prefs: { ...c.prefs, confirm_required: e.target.checked } }))} />
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
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: 'var(--paper)', border: '1px solid var(--line)', color: 'var(--ink)',
  padding: '7px 10px', borderRadius: 4, fontSize: 13.5,
};
const selectStyle: React.CSSProperties = {
  background: 'var(--paper)', border: '1px solid var(--line)', color: 'var(--ink)',
  padding: '6px 8px', borderRadius: 4, fontSize: 13,
};

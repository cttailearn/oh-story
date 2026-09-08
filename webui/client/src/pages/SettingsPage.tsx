// P6 设置页：渠道管理（增删/获取模型/测试）+ 模型路由 + 预算 + 偏好（M1.8）+ 运维页签（M4：诊断/统计/审计CSV/备份/恢复）
import { useEffect, useState } from 'react';
import { api } from '../api/client.ts';
import { OpsPanel } from '../components/OpsPanel.tsx';

interface ProbeState {
  loading?: boolean;
  ok?: boolean;
  msg?: string;
  ping_ms?: number;
  models?: string[];
  chat?: string[];
  image?: string[];
  other?: string[];
}

/** P6 设置页 */
export function SettingsPage() {
  const [config, setConfig] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [testing, setTesting] = useState<Record<string, any>>({});
  const [probe, setProbe] = useState<Record<string, ProbeState>>({});
  /** 用户新输入的密钥（仅本次编辑会话持有；保存后清空，绝不回显已存密钥） */
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<'config' | 'ops'>('config');

  useEffect(() => {
    api
      .config()
      .then((c) => setConfig(c))
      .catch((e) => setErr(String(e.message ?? e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div>正在读配置…</div>;
  if (err && !config) return <div style={{ color: 'var(--red-vermillion)' }}>读取配置失败：{err}</div>;
  if (!config) return <div>无配置</div>;

  const save = async () => {
    setSaving(true);
    setMsg(null);
    setErr(null);
    try {
      const payload = structuredClone(config);
      for (const ch of payload.channels ?? []) {
        const typed = (keyDraft[ch.id] ?? '').trim();
        // 新密钥才回传；否则删掉该字段 → 服务端保留既有密钥（回显的掩码绝不会写回）
        if (typed) ch.api_key = typed;
        else delete ch.api_key;
      }
      const c = await api.putConfig(payload);
      setConfig(c);
      setKeyDraft({});
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
    setProbe((p) => {
      const n = { ...p };
      delete n[id];
      return n;
    });
    setKeyDraft((k) => {
      const n = { ...k };
      delete n[id];
      return n;
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

  /** 用当前表单里的 base_url + 密钥（未保存也可）拉取可用模型 */
  const fetchModels = async (ch: any) => {
    const base_url = String(ch.base_url ?? '').trim();
    if (!base_url) {
      setErr('请先填写 base_url 再获取模型');
      return;
    }
    setErr(null);
    setProbe((p) => ({ ...p, [ch.id]: { loading: true } }));
    try {
      const res = await api.probeChannelModels({
        base_url,
        api_key: (keyDraft[ch.id] ?? '').trim() || undefined,
        id: ch.id,
      });
      setProbe((p) => ({ ...p, [ch.id]: { loading: false, ...res } }));
    } catch (e: any) {
      setProbe((p) => ({ ...p, [ch.id]: { loading: false, ok: false, msg: e?.message ?? String(e) } }));
    }
  };

  const toggleModel = (i: number, model: string) =>
    patchConfig((c) => {
      const cur: string[] = c.channels[i].models ?? [];
      c.channels[i].models = cur.includes(model) ? cur.filter((m) => m !== model) : [...cur, model];
      return c;
    });

  const addModels = (i: number, list: string[]) =>
    patchConfig((c) => {
      const cur: string[] = c.channels[i].models ?? [];
      c.channels[i].models = [...cur, ...list.filter((m) => !cur.includes(m))];
      return c;
    });

  const clearModels = (i: number) =>
    patchConfig((c) => {
      c.channels[i].models = [];
      return c;
    });

  const ROLE_KEYS = ['writer', 'architect', 'designer', 'checker', 'researcher', 'explorer'];
  const allModels = (config.channels ?? [])
    .filter((ch: any) => ch.enabled !== false)
    .flatMap((ch: any) => (ch.models ?? []).map((m: string) => ({ channel: ch.id, model: m })));

  const tabBtn: React.CSSProperties = {
    padding: '5px 14px', borderRadius: 4, border: '1px solid var(--line)',
    background: 'var(--paper)', color: 'var(--ink-2)', cursor: 'pointer', fontSize: 13,
  };

  const chip = (on: boolean): React.CSSProperties => ({
    padding: '3px 9px',
    fontSize: 12,
    fontFamily: 'var(--font-mono)',
    borderRadius: 12,
    border: '1px solid ' + (on ? 'var(--green-jade)' : 'var(--line)'),
    background: on ? 'color-mix(in srgb, var(--green-jade) 10%, var(--paper))' : 'var(--paper)',
    color: on ? 'var(--green-jade)' : 'var(--ink-2)',
    cursor: 'pointer',
  });

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
            <div style={{ fontSize: 12.5, color: 'var(--ink-2)', marginBottom: 10, lineHeight: 1.7 }}>
              填 <span className="mono">base_url</span> + <span className="mono">API Key</span> → 点「获取模型」拉取该渠道可用模型 → 点选加入模型目录 → 保存。
              <br />
              已保存的密钥不会回显（显示为 <span className="mono">sk-a****z</span>）；留空即保持原密钥不变。
            </div>
            <div style={{ display: 'grid', gap: 10 }}>
              {(config.channels ?? []).map((ch: any, i: number) => {
                const t = testing[ch.id];
                const p = probe[ch.id];
                const chosen: string[] = ch.models ?? [];
                return (
                  <div key={ch.id} data-channel-card={ch.id} style={{ border: '1px solid var(--line)', borderRadius: 6, padding: '12px', background: 'var(--paper)' }}>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <input value={ch.name} onChange={(e) => patchConfig((c) => { c.channels[i].name = e.target.value; return c; })} style={inputStyle} placeholder="渠道名" />
                      <input value={ch.base_url} onChange={(e) => patchConfig((c) => { c.channels[i].base_url = e.target.value; return c; })} style={{ ...inputStyle, flex: 1, minWidth: 240 }} placeholder="https://api.example.com/v1" />
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={keyDraft[ch.id] ?? ''}
                        onChange={(e) => setKeyDraft((k) => ({ ...k, [ch.id]: e.target.value }))}
                        style={{ ...inputStyle, width: 200, fontFamily: 'var(--font-mono)' }}
                        placeholder={ch.api_key ? `已保存 ${ch.api_key}（留空不改）` : 'API Key（sk-…）'}
                      />
                      <span className={`seal ${ch.enabled === false ? 'seal-pending' : 'seal-pass'}`} style={{ cursor: 'pointer' }} onClick={() => patchConfig((c) => { c.channels[i].enabled = !c.channels[i].enabled; return c; })}>
                        {ch.enabled === false ? '停用' : '启用'}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
                      <button className="ink-btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => fetchModels(ch)} disabled={p?.loading}>
                        {p?.loading ? '拉取中…' : '⤓ 获取模型'}
                      </button>
                      <button className="ink-btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => testChannel(ch.id)} disabled={t?.loading}>
                        {t?.loading ? '测试中…' : '测试连通'}
                      </button>
                      <button className="ink-btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => removeChannel(ch.id)}>
                        删除
                      </button>
                      <span style={{ fontSize: 12, color: 'var(--ink-2)' }}>已选 {chosen.length} 个模型</span>
                    </div>

                    {p && (
                      <div style={{ marginTop: 10, border: '1px dashed var(--line)', borderRadius: 6, padding: '10px 12px', background: 'var(--paper-2)' }}>
                        {p.loading && <div style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>正在请求 /models …</div>}
                        {!p.loading && p.ok === false && (
                          <div style={{ fontSize: 12.5, color: 'var(--red-vermillion)' }}>❌ {p.msg}</div>
                        )}
                        {!p.loading && p.ok && (
                          <div style={{ display: 'grid', gap: 8 }}>
                            <div style={{ fontSize: 12.5, color: 'var(--green-jade)' }}>
                              ✅ {p.msg}
                              {typeof p.ping_ms === 'number' && <span style={{ color: 'var(--ink-2)' }}>（{p.ping_ms}ms）</span>}
                            </div>
                            {([
                              ['对话模型', p.chat, 'chat'],
                              ['图像模型', p.image, 'image'],
                              ['其它（embedding/语音等，不参与流程）', p.other, 'other'],
                            ] as const).map(([label, list, key]) =>
                              (list ?? []).length === 0 ? null : (
                                <div key={key}>
                                  <div style={{ fontSize: 12, color: 'var(--ink-2)', marginBottom: 5 }}>
                                    {label}（{(list ?? []).length}）
                                    {key !== 'other' && (
                                      <button className="ink-btn" style={{ marginLeft: 8, padding: '1px 7px', fontSize: 11 }} onClick={() => addModels(i, list ?? [])}>
                                        全选
                                      </button>
                                    )}
                                  </div>
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 170, overflow: 'auto' }}>
                                    {(list ?? []).map((m) => (
                                      <button key={m} style={chip(chosen.includes(m))} onClick={() => toggleModel(i, m)} title={m}>
                                        {chosen.includes(m) ? '✓ ' : ''}
                                        {m}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              ),
                            )}
                            <div>
                              <button className="ink-btn" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => clearModels(i)}>
                                清空已选
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    <div style={{ marginTop: 8 }}>
                      <span style={{ fontSize: 12, color: 'var(--ink-2)', marginRight: 6 }}>模型目录（逗号分隔，可手工编辑）：</span>
                      <input value={chosen.join(', ')} onChange={(e) => patchConfig((c) => { c.channels[i].models = e.target.value.split(/[,，\s]+/).filter(Boolean); return c; })} style={{ ...inputStyle, minWidth: 360, fontFamily: 'var(--font-mono)' }} placeholder="deepseek-v4-pro, gpt-image-2, …" />
                    </div>
                    {t?.ok && <div style={{ fontSize: 12.5, color: 'var(--green-jade)', marginTop: 6, lineHeight: 1.6 }}>✅ {t.msg}</div>}
                    {t && t.ok === false && <div style={{ fontSize: 12.5, color: 'var(--red-vermillion)', marginTop: 6 }}>❌ {t.msg}（ping {t.llm?.ping_ms}ms）</div>}
                  </div>
                );
              })}
              {(config.channels ?? []).length === 0 && (
                <div style={{ fontSize: 13, color: 'var(--ink-2)' }}>
                  尚无渠道。新增后填 base_url + API Key，点「获取模型」勾选即可；流程也可用「假渠道」开发（POST run 传 fake）。
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
            {allModels.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 8 }}>先在上方渠道「获取模型」并勾选，这里才能选。</div>}
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

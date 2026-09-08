import { useCallback, useEffect, useState } from 'react';
import { Drawer, Input, Button, Segmented, Tooltip, Tag } from 'antd';
import { api } from '../api/client.ts';

interface DiffHunk { type: 'add' | 'del'; line: number; text: string }
interface AiEditResp {
  edit_id: string; mode: string; target: string; diff: DiffHunk[];
  applied: boolean; note: string; cost_cents: number; resultText: string;
}

const CHAPTER_DEMANDS = [
  { key: 'hook', label: '强化钩子' },
  { key: 'opening', label: '改开篇' },
  { key: 'condense', label: '压缩字数' },
  { key: 'de-ai', label: '去AI味' },
  { key: 'foreshadow', label: '埋伏笔' },
  { key: 'custom', label: '自定义' },
];

interface AIEditDrawerProps {
  open: boolean;
  onClose: () => void;
  bookId: string;
  targetPath: string;
  mtime: number | null;
  onApplied: (mtime: number) => void;
}

/** AI 编辑抽屉（ai-edit-spec P5）：需求模板 -> diff 采纳 -> 应用落盘（PUT /files） */
export function AIEditDrawer({ open, onClose, bookId, targetPath, mtime, onApplied }: AIEditDrawerProps) {
  const [kind, setKind] = useState('hook');
  const [custom, setCustom] = useState('');
  const [role, setRole] = useState('writer');
  const [fake, setFake] = useState(false);
  const [hasChannel, setHasChannel] = useState(false);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<AiEditResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  useEffect(() => {
    if (open) { setResult(null); setError(null); setOkMsg(null); setCustom(''); }
  }, [open]);

  // M4：有已配置渠道时默认真实生成（demo 开关仍可切假渠道）
  useEffect(() => {
    if (!open) return;
    api
      .config()
      .then((cfg: any) => {
        const has = (cfg?.channels ?? []).some((c: any) => c.enabled !== false && !!c.api_key);
        setHasChannel(has);
        setFake(!has);
      })
      .catch(() => {});
  }, [open]);

  const generate = useCallback(async () => {
    setLoading(true); setError(null); setOkMsg(null); setResult(null);
    try {
      const r = await api.aiEdit(bookId, {
        mode: 'rewrite',
        target: { path: targetPath },
        demand: { kind, custom: kind === 'custom' ? custom : undefined },
        model_role: role,
        fake,
      });
      setResult(r);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [bookId, targetPath, kind, custom, role, fake]);

  const apply = async () => {
    if (!result) return;
    if (!result.resultText || !result.resultText.trim()) {
      setError('模型未产出有效修改，未应用（避免覆盖原文）');
      return;
    }
    setApplying(true); setError(null); setOkMsg(null);
    try {
      const r = await api.writeFile(bookId, targetPath, result.resultText, mtime);
      setOkMsg('已应用（Revision 已落盘；可在正文模块「保存并跑门禁」复核）');
      onApplied(r.mtime);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setApplying(false);
    }
  };

  return (
    <Drawer
      title={<span className="serif">✒ AI 编辑 · <span className="mono" style={{ fontSize: 12, color: 'var(--ink-2)' }}>{targetPath.split('/').pop()}</span></span>}
      width={680}
      open={open}
      onClose={onClose}
      destroyOnClose
    >
      <div style={{ display: 'grid', gap: 14 }}>
        <div>
          <div style={{ fontSize: 12.5, color: 'var(--ink-2)', marginBottom: 6 }}>需求（选定即注入模板指令）</div>
          <Segmented
            options={CHAPTER_DEMANDS.map((d) => ({ label: d.label, value: d.key }))}
            value={kind}
            onChange={(v) => setKind(String(v))}
          />
        </div>
        {kind === 'custom' && (
          <Input.TextArea
            rows={3}
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="自定义修改需求…例如：把第 3 段改成倒叙结尾"
          />
        )}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>角色模板</span>
          <Segmented
            options={[{ label: 'writer 执笔', value: 'writer' }, { label: 'architect 架构', value: 'architect' }, { label: 'checker 审查', value: 'checker' }]}
            value={role}
            onChange={(v) => setRole(String(v))}
          />
          <Tooltip title={hasChannel ? '当前已配置渠道：默认真实生成（真消费额度）' : '未配置渠道：demo 假渠道'}>
            <Tag.CheckableTag checked={fake} onChange={setFake}>demo 模式{!hasChannel ? '（未配置渠道）' : ''}</Tag.CheckableTag>
          </Tooltip>
        </div>

        <Button type="primary" onClick={generate} loading={loading} block>
          生成修改（diff）
        </Button>

        {error && <div style={{ color: 'var(--red-vermillion)', fontSize: 13 }}>⚠️ {error}</div>}
        {okMsg && <div style={{ color: 'var(--green-jade)', fontSize: 13 }}>✅ {okMsg}</div>}

        {result && (
          <div style={{ border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: 'var(--paper-2)', borderBottom: '1px solid var(--line)' }}>
              <span className="mono" style={{ fontSize: 12, color: 'var(--ink-2)' }}>{result.edit_id} · {result.mode}</span>
              <span style={{ fontSize: 12.5 }}>
                <span style={{ color: 'var(--green-jade)' }}>+{result.diff.filter((d) => d.type === 'add').length}</span>
                <span style={{ color: 'var(--red-vermillion)', marginLeft: 8 }}>-{result.diff.filter((d) => d.type === 'del').length}</span>
                <span className="mono" style={{ marginLeft: 12, color: 'var(--ink-2)' }}>¥{Number(result.cost_cents ?? 0).toFixed(3)}</span>
              </span>
            </div>
            <div style={{ maxHeight: 380, overflow: 'auto', fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>
              {result.diff.length === 0 && <div style={{ padding: 14, color: 'var(--ink-2)' }}>无改动（内容与需求一致）。</div>}
              {result.diff.map((h, i) => (
                <div key={i}>
                  {h.type === 'del' && (
                    <div style={{ padding: '2px 12px', background: '#f9eae6', color: 'var(--red-vermillion)', whiteSpace: 'pre-wrap' }}>
                      <span className="mono" style={{ marginRight: 8 }}>- L{h.line}</span>{h.text}
                    </div>
                  )}
                  {h.type === 'add' && (
                    <div style={{ padding: '2px 12px', background: '#e6f2ee', color: 'var(--green-jade)', whiteSpace: 'pre-wrap' }}>
                      <span className="mono" style={{ marginRight: 8 }}>+ L{h.line}</span>{h.text}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div style={{ padding: '8px 12px', fontSize: 12.5, color: 'var(--ink-2)', borderTop: '1px solid var(--line)' }}>
              {result.note}
            </div>
          </div>
        )}

        {result && (
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button onClick={() => setResult(null)}>放弃</Button>
            <Button onClick={generate} loading={loading}>重写一次</Button>
            <Button type="primary" onClick={apply} loading={applying}>应用（落 revision）</Button>
          </div>
        )}
      </div>
    </Drawer>
  );
}

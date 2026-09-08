import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.ts';

type Step = 'type' | 'info' | 'confirm';
interface WizardState {
  step: Step;
  projectType: 'novel-project' | 'teardown' | 'import';
  name: string;
  themeColor: string;
  creating: boolean;
  error: string | null;
}

/** P1 新建项目向导（三步） */
export function NewProjectPage() {
  const navigate = useNavigate();
  const [importText, setImportText] = useState('');
  const [s, setS] = useState<WizardState>({
    step: 'type',
    projectType: 'novel-project',
    name: '',
    themeColor: '#B8860B',
    creating: false,
    error: null,
  });

  const set = (patch: Partial<WizardState>) => setS((p) => ({ ...p, ...patch }));

  const create = async () => {
    if (!s.name.trim()) {
      setS((p) => ({ ...p, error: '请填写项目名' }));
      return;
    }
    if (s.projectType === 'import' && !importText.trim()) {
      setS((p) => ({ ...p, error: '请粘贴要导入的小说文本' }));
      return;
    }
    setS((p) => ({ ...p, creating: true, error: null }));
    try {
      if (s.projectType === 'import') {
        const r = await api.importNovel({ name: s.name.trim(), mode: 'clipboard', text: importText });
        navigate(`/novels/${r.book.id}`);
      } else {
        const book = await api.createBook({ name: s.name.trim(), type: s.projectType, theme_color: s.themeColor });
        navigate(`/novels/${book.id}`);
      }
    } catch (e: any) {
      setS((p) => ({ ...p, creating: false, error: e?.message ?? String(e) }));
    }
  };

  return (
    <div style={{ maxWidth: 720 }}>
      <h1 className="serif">新建项目</h1>

      {s.projectType === 'import' && s.step === 'confirm' && (
        <div className="rail-block" style={{ marginBottom: 12 }}>
          <div className="rb-title">粘贴已有小说全文（导入后会：分章 → 生成追踪状态(schema v4) → 建书）</div>
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            rows={10}
            placeholder="支持 第一章/第1章/Chapter N 锚点分章…"
            style={{ width: '100%', border: '1px solid var(--line)', background: 'var(--paper)', color: 'var(--ink)', padding: 8, fontFamily: 'var(--font-serif)', fontSize: 14 }}
          />
        </div>
      )}

      {/* 题签式步骤条 */}
      <div style={{ display: 'flex', gap: 8, margin: '18px 0', borderBottom: '1px solid var(--line)', paddingBottom: 10 }}>
        {(['type', 'info', 'confirm'] as Step[]).map((st, i) => (
          <div key={st} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              className={`seal ${s.step === st ? 'seal-pending' : s.step === 'confirm' && i < 2 ? 'seal-pass' : ''}`}
            >
              {i + 1}
            </span>
            <span style={{ color: s.step === st ? 'var(--ink)' : 'var(--ink-2)' }}>
              {st === 'type' ? '项目类型' : st === 'info' ? '基本信息' : '确认落笔'}
            </span>
            {i < 2 && <span style={{ color: 'var(--line)' }}>──</span>}
          </div>
        ))}
      </div>

      {s.error && <div style={{ color: 'var(--red-vermillion)', marginBottom: 12 }}>⚠️ {s.error}</div>}

      {s.step === 'type' && (
        <div style={{ display: 'grid', gap: 12 }}>
          {(
            [
              ['novel-project', '新建小说项目', '从需求表单开始，走智能体流水线', true],
              ['teardown', '小说拆文项目', '导入原文，拆解模块与情绪曲线', false],
              ['import', '导入已有小说', '解析正文/大纲/设定，重建追踪状态', false],
            ] as const
          ).map(([val, title, desc, rec]) => (
            <div
              key={val}
              className="tt-card"
              onClick={() => set({ projectType: val })}
              style={{
                borderColor: s.projectType === val ? 'var(--gold-saffron)' : 'var(--line)',
                boxShadow: s.projectType === val ? 'inset 0 0 0 1px var(--gold-saffron)' : undefined,
              }}
            >
              <div className="tt-title" style={{ fontFamily: 'var(--font-serif)', fontWeight: 600 }}>
                {title} {rec && <span className="seal seal-pending" style={{ marginLeft: 6 }}>推荐</span>}
              </div>
              <div style={{ color: 'var(--ink-2)', fontSize: 13 }}>{desc}</div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="ink-btn primary" onClick={() => set({ step: 'info' })}>
              下一步
            </button>
            <button className="ink-btn" onClick={() => navigate('/')}>
              取消
            </button>
          </div>
        </div>
      )}

      {s.step === 'info' && (
        <div style={{ display: 'grid', gap: 14 }}>
          <label style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: 13, color: 'var(--ink-2)' }}>项目名称</span>
            <input
              value={s.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="我的第一部长篇"
              style={{
                background: 'var(--paper)', border: '1px solid var(--line)', color: 'var(--ink)',
                padding: '8px 10px', borderRadius: 4, fontFamily: 'var(--font-serif)', fontSize: 15,
              }}
            />
          </label>
          <label style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: 13, color: 'var(--ink-2)' }}>主题色 / 封面色块</span>
            <input
              type="color"
              value={s.themeColor}
              onChange={(e) => set({ themeColor: e.target.value })}
              style={{ width: 90, height: 36, background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 4 }}
            />
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="ink-btn primary" onClick={() => set({ step: 'confirm' })}>
              下一步
            </button>
            <button className="ink-btn" onClick={() => set({ step: 'type' })}>
              上一步
            </button>
          </div>
        </div>
      )}

      {s.step === 'confirm' && (
        <div>
          <div
            className="paper-lines"
            style={{ border: '1px solid var(--line)', borderRadius: 6, padding: '18px 22px', background: 'var(--paper)' }}
          >
            <div style={{ fontFamily: 'var(--font-serif)', fontSize: 17, marginBottom: 6 }}>《{s.name || '（未命名）'}》</div>
            <div style={{ color: 'var(--ink-2)', fontSize: 13, lineHeight: 2 }}>
              类型：{s.projectType === 'novel-project' ? '小说项目' : s.projectType === 'teardown' ? '拆文项目' : '导入'}
              <br />
              目录：{s.projectType === 'novel-project' ? `./${s.name}/` : '（拆文/导入 需下一步配置）'}
              <br />
              主题色：<span style={{ display: 'inline-block', width: 12, height: 12, background: s.themeColor, borderRadius: 2, verticalAlign: 'middle' }} /> {s.themeColor}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button className="ink-btn primary" onClick={create} disabled={s.creating}>
              {s.creating ? '落笔中…' : '落笔 ✒'}
            </button>
            <button className="ink-btn" onClick={() => set({ step: 'info' })}>
              上一步
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

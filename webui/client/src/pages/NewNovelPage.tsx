import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.ts';

/** 新建小说向导（webui-frontend P2 需求录入）：表单 → 建书(种子落盘) → 流程看板 */
export function NewNovelPage() {
  const nav = useNavigate();
  const [form, setForm] = useState({ name: '', pipeline: 'long', 题材: '', 类型: '', 目标字数: '', 平台风格: '番茄', 金手指: '', 核心卖点: '', 一句话Idea: '', keywords: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const inp: any = { width: '100%', padding: '6px 8px', border: '1px solid var(--line)', background: 'var(--paper)', color: 'var(--ink)', fontFamily: 'var(--font-serif)', fontSize: 14 };
  const row: any = { display: 'grid', gap: 6 };

  const create = async () => {
    if (!form.name.trim()) return setErr('请填书名');
    setBusy(true); setErr(null);
    try {
      const book = await api.createBook({
        name: form.name.trim(),
        type: 'novel',
        pipeline: form.pipeline,
        theme_color: '#B8860B',
        requirements: {
          题材: form.题材 || undefined,
          类型: form.类型 || undefined,
          目标字数: form.目标字数 ? Number(form.目标字数) : undefined,
          平台风格: form.平台风格,
          金手指: form.金手指 || undefined,
          核心卖点: form.核心卖点 || undefined,
          一句话Idea: form.一句话Idea || undefined,
          keywords: form.keywords.split(/[，,、]/).map((s) => s.trim()).filter(Boolean),
        },
      });
      nav(`/novels/${book.id}/pipeline`);
    } catch (e: any) { setErr(e?.message ?? String(e)); } finally { setBusy(false); }
  };

  return (
    <div style={{ maxWidth: 720 }}>
      <h1 className="serif">新建小说 · 需求录入</h1>
      <p style={{ color: 'var(--ink-2)', fontSize: 13 }}>用户需求 → 智能体流程的第一入口（webui-frontend P2）；提交后进流程看板从 intake 起跑。</p>

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '1fr 1fr', alignItems: 'start' }}>
        <div className="rail-block" style={{ display: 'grid', gap: 10 }}>
          <label style={row}>书名<input value={form.name} onChange={(e) => set('name', e.target.value)} style={inp} /></label>
          <label style={row}>类型<select value={form.pipeline} onChange={(e) => set('pipeline', e.target.value)} style={inp}><option value="long">长篇</option><option value="short">短篇</option></select></label>
          <label style={row}>题材<input value={form.题材} onChange={(e) => set('题材', e.target.value)} placeholder="都市系统流 / 玄幻…" style={inp} /></label>
          <label style={row}>目标字数<input type="number" value={form.目标字数} onChange={(e) => set('目标字数', e.target.value)} placeholder="200000" style={inp} /></label>
          <label style={row}>平台/风格<select value={form.平台风格} onChange={(e) => set('平台风格', e.target.value)} style={inp}><option>番茄</option><option>起点</option><option>晋江</option><option>盐言</option></select></label>
        </div>
        <div className="rail-block" style={{ display: 'grid', gap: 10 }}>
          <label style={row}>金手指/核心爽点<input value={form.金手指} onChange={(e) => set('金手指', e.target.value)} placeholder="短视频爆款预知…" style={inp} /></label>
          <label style={row}>核心卖点<input value={form.核心卖点} onChange={(e) => set('核心卖点', e.target.value)} placeholder="爽文 / 追妻火葬场…" style={inp} /></label>
          <label style={row}>一句话Idea<input value={form.一句话Idea} onChange={(e) => set('一句话Idea', e.target.value)} placeholder="重生军宣新人把废号做成顶流" style={inp} /></label>
          <label style={row}>关键词（逗号分隔）<input value={form.keywords} onChange={(e) => set('keywords', e.target.value)} placeholder="打脸, 追妻" style={inp} /></label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="ink-btn primary" onClick={create} disabled={busy}>{busy ? '建书中…' : '立即开始 → 进流程看板'}</button>
            {err && <span style={{ color: 'var(--red-vermillion)', fontSize: 13 }}>⚠️ {err}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

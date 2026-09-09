import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, sseJobs, type FileNode } from '../api/client.ts';
// CodeMirror 按需加载（手稿编辑时才拉取 chunk）
const PageEditor = lazy(() => import('../components/PageEditor.tsx').then((m) => ({ default: m.PageEditor })));
import { AIEditDrawer } from '../components/AIEditDrawer.tsx';

interface StageView {
  id: string;
  title: string;
  type: string;
  status: string;
  revision: number;
  requires: string[];
  gates: string[];
  /** 阶段产物规格（file-set 支持多文件/多类型），来自流程定义 */
  artifact: { kind: string; path: string } | null;
}

interface StageGuide {
  label: string;
  desc: string;
  /** 产物所在目录（编辑器在此目录下找可编辑文件） */
  dir: string;
  /** 首选文件；null 表示从目录里挑 */
  primary: string | null;
  kind: 'text' | 'image';
  canSkip: boolean;
  canReject: boolean;
}

// 阶段指引：与 server/engine/definitions/long.json 的阶段对齐。
// 每个阶段 = 一屏：编辑产物文件 + [AI 生成] [AI 改稿] [保存]，确认后进下一步。
const GUIDES: Record<string, StageGuide> = {
  intake:     { label: '需求录入', desc: '第一步 · 设定：把题材、类型、金手指、卖点写进「题材定位」文件。可以先手写，再让 AI 生成并完善。', dir: '设定', primary: '设定/题材定位.md', kind: 'text', canSkip: false, canReject: false },
  topic:      { label: '选题 / 扫榜', desc: '对照题材定位做选题校准（不需要可「跳过」本步）。', dir: '设定', primary: '设定/题材定位.md', kind: 'text', canSkip: true, canReject: false },
  concept:    { label: '世界观 / 金手指', desc: '扩充世界观、金手指、文风与人物关系；不满意可「驳回重写」。', dir: '设定', primary: '设定/题材定位.md', kind: 'text', canSkip: false, canReject: true },
  characters: { label: '人设（角色卡 + 角色线）', desc: '生成角色卡与角色线。编辑器自动打开「设定」下的文件，可切换。', dir: '设定', primary: null, kind: 'text', canSkip: false, canReject: false },
  outline:    { label: '大纲（卷纲 + 细纲）', desc: '先按「AI 生成」得到初稿：大纲 / 卷纲 / 细纲，逐份校订后确认。', dir: '大纲', primary: '大纲/大纲.md', kind: 'text', canSkip: false, canReject: true },
  chapter:    { label: '章节写作', desc: '按细纲写正文，每章一个文件，编辑器自动打开最新一章。', dir: '正文', primary: null, kind: 'text', canSkip: false, canReject: true },
  review:     { label: '多视角审查', desc: 'AI 从多视角审校已写章节并留下审查记录（交付前的把关）。', dir: '大纲/审查记录', primary: null, kind: 'text', canSkip: false, canReject: true },
  deslop:     { label: '去 AI 味', desc: '把正文的 AI 腔换成更自然的表达，并在「正文」目录落地新稿。', dir: '正文', primary: null, kind: 'text', canSkip: false, canReject: false },
  cover:      { label: '封面 / 角色图', desc: '图片生成阶段（当前未接入），可直接「跳过」，不影响正文与导出。', dir: '封面', primary: null, kind: 'image', canSkip: true, canReject: false },
  export:     { label: '交付导出', desc: '最后一步：按平台格式导出 txt / md 交付物。', dir: '交付', primary: null, kind: 'text', canSkip: false, canReject: false },
};

const STATUS_LABEL: Record<string, string> = { pending: '未开始', running: '运行中', review: '待确认', blocked: '阻塞', done: '完成', skipped: '跳过' };

// 流程阶段 → 工作台模块 的对应关系（用于流程↔工作台互跳）
const WORK_MODULE: Record<string, { m: string; label: string }> = {
  intake: { m: 'settings', label: '设定' },
  topic: { m: 'settings', label: '设定' },
  concept: { m: 'settings', label: '设定' },
  characters: { m: 'settings', label: '设定' },
  outline: { m: 'outline', label: '大纲' },
  chapter: { m: 'chapters', label: '正文' },
  review: { m: 'outline', label: '审查记录' },
  deslop: { m: 'chapters', label: '正文' },
  cover: { m: 'settings', label: '角色图' },
  export: { m: 'export', label: '导出' },
};

// 把流程定义的产物路径（file-set：设定/{题材定位.md, 文风.md, 世界观/*.md} 等）展开为实际文件列表
function globToRegex(glob: string): RegExp {
  let out = '^';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i] ?? '';
    if (ch === '*') { out += '[^/]*'; i += 1; }
    else if (ch === '{') {
      const close = glob.indexOf('}', i + 1);
      if (close > i) {
        const opts = glob.slice(i + 1, close).split(',').map((s) => s.trim()).filter(Boolean);
        out += '(?:' + opts.map(globInner).join('|') + ')';
        i = close + 1;
      } else { out += '[{]'; i += 1; }
    }
    else if (ch === '}') { out += '[}]'; i += 1; }
    else { out += /[a-zA-Z0-9/_]/.test(ch) ? ch : '[' + ch + ']'; i += 1; }
  }
  return new RegExp(out + '$');
}
function globInner(part: string): string {
  let s = '';
  for (const ch of part) s += ch === '*' ? '[^/]*' : /[a-zA-Z0-9/_]/.test(ch) ? ch : '[' + ch + ']';
  return s;
}
function expandArtifact(tree: FileNode[], artifactPath: string | null | undefined): string[] {
  if (!artifactPath) return [];
  // 定义里的产物路径带书目录占位前缀（形如 "book/设定/…"），先剥掉；树接口返回的是相对书目录的路径
  const path = artifactPath.replace(/^[$][{][^}]*[}][/]?/, '');
  const files: string[] = [];
  const walk = (nodes: FileNode[]): void => {
    for (const n of nodes) {
      if (n.type === 'dir') walk(n.children ?? []);
      else files.push(n.path);
    }
  };
  walk(tree);
  const braceM = path.match(/^([^/]*)[/][{](.*)[}]$/);
  let patterns: string[] = [];
  if (braceM) {
    const base = braceM[1] ?? '';
    patterns = (braceM[2] ?? '').split(',').map((x) => base + '/' + x.trim()).filter(Boolean);
  } else {
    patterns = path.split(',').map((x) => x.trim()).filter(Boolean).map((x) => x.replace(/[%][0-9]*d/g, '*'));
  }
  const out: string[] = [];
  for (const p of patterns) {
    const rx = globToRegex(p);
    for (const f of files) if (rx.test(f) && !out.includes(f)) out.push(f);
  }
  return out;
}

const numOf = (p: string): number => {
  const m = p.match(/(\d+)/);
  return m ? parseInt(m[1] ?? '', 10) : 0;
};

/**
 * 流程向导（替代旧版「密集看板」）：面向人类的分步操作。
 * 每步 = 产物编辑框 + AI 生成 / AI 改稿 / 保存 + 确认。
 */
export function PipelinePage() {
  const { bookId } = useParams();
  const [stages, setStages] = useState<StageView[]>([]);
  const [bookName, setBookName] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [fake, setFake] = useState(false);
  const [selected, setSelected] = useState(0);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [runningStage, setRunningStage] = useState<string | null>(null);
  // 编辑器
  const [editorPath, setEditorPath] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [mtime, setMtime] = useState<number | null>(null);
  const [fileMissing, setFileMissing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [gateLine, setGateLine] = useState<{ kind: 'pass' | 'warn' | 'block'; text: string } | null>(null);
  const [aiEdit, setAiEdit] = useState<{ open: boolean; path: string; mtime: number | null }>({ open: false, path: '', mtime: null });
  const [note, setNote] = useState('');
  const [acting, setActing] = useState<string | null>(null);
  const [dayCost, setDayCost] = useState<number | null>(null);
  const [view, setView] = useState<'step' | 'overview'>('step');
  const [costAll, setCostAll] = useState<any>(null);
  const [tracking, setTracking] = useState<any>(null);

  const stage = stages[selected];
  const guide = stage ? (GUIDES[stage.id] ?? null) : null;
  const doneIds = useMemo(() => new Set(stages.filter((s) => s.status === 'done' || s.status === 'skipped').map((s) => s.id)), [stages]);

  const load = useCallback(async () => {
    if (!bookId) return;
    setLoading(true);
    setError(null);
    try {
      const [s, b, tr] = await Promise.all([api.stages(bookId), api.getBook(bookId), api.tree(bookId).catch(() => ({ tree: [] as FileNode[] }))]);
      setStages(s.stages ?? []);
      setBookName(b.name);
      setTree(tr.tree ?? []);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [bookId]);

  useEffect(() => { void load(); }, [load]);

  // 初次定位到第一个未完成阶段（仅在阶段数变化时）
  useEffect(() => {
    if (!stages.length) return;
    const idx = stages.findIndex((s) => !doneIds.has(s.id));
    if (idx >= 0) setSelected(idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stages.length]);

  // 顶栏一行成本 + 总览用全量成本 / 追踪状态
  useEffect(() => {
    if (!bookId) return;
    api.cost(bookId).then((c) => { setDayCost(c?.day_cents ?? null); setCostAll(c ?? null); }).catch(() => {});
    api.tracking(bookId).then(setTracking).catch(() => {});
  }, [bookId, stages]);

  // SSE：只消费 开始/完成/出错，维持「运行中 → 完成 → 确认」的推进
  useEffect(() => {
    if (!bookId) return;
    const close = sseJobs(bookId, (name, data) => {
      if (name === 'job:start') {
        setRunningStage(data.stage ?? null);
        setGateLine(null);
      } else if (name === 'job:review') {
        setRunningStage(null);
        setGateLine(summarizeGates(data.latest_gates));
        setRefreshKey((k) => k + 1);
        setTimeout(load, 300);
      } else if (name === 'job:error') {
        setRunningStage(null);
        setJobError(String(data.message ?? '阶段执行出错'));
        setTimeout(load, 300);
      }
    });
    return close;
  }, [bookId, load]);

  const runStage = async (stageId: string) => {
    if (!bookId || runningStage) return;
    setError(null);
    setJobError(null);
    setGateLine(null);
    try {
      // 若编辑框有未保存内容，先生成落盘（AI 会以磁盘内容为上下文）
      if (editorPath && content.length > 0) {
        try {
          const r = await api.writeFile(bookId, editorPath, content, mtime);
          setMtime(r.mtime);
        } catch { /* 写失败不阻断发任务 */ }
      }
      const r = await api.runStage(bookId, stageId, fake);
      setRunningStage(stageId);
      setToast('已发起「' + labelOf(stageId) + '」生成（job ' + r.job_id + '）…');
    } catch (e: any) {
      setJobError(e?.message ?? String(e));
    }
  };

  const review = async (action: string, stageId?: string) => {
    const st = stages.find((x) => x.id === (stageId ?? stage?.id));
    if (!st || acting) return;
    setActing(action);
    setError(null);
    try {
      const r = await api.reviewStage(bookId!, st.id, action, note || undefined);
      setToast('已「' + actionLabel(action) + '」→ ' + r.status);
      setNote('');
      await load();
      if (action === 'approve' || action === 'skip' || action === 'force_approve') {
        const cur = stages.findIndex((x) => x.id === st.id);
        const next = stages.findIndex((x, i) => i > cur && x.status !== 'done' && x.status !== 'skipped');
        setSelected(next >= 0 ? next : stages.length - 1);
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setActing(null);
    }
  };

  // ---------- 编辑器：随当前阶段解析产物文件 ----------
  // 产物优先按流程定义 artifact（file-set，多文件/多类型）展开；不可用再按阶段目录兜底。
  const artifactFiles = useMemo(() => {
    if (!stage?.artifact?.path) return [] as string[];
    return expandArtifact(tree, stage.artifact.path);
  }, [stage, tree]);

  const stageFiles = useMemo(() => {
    if (!guide) return [] as string[];
    const out: string[] = [];
    const walk = (nodes: FileNode[]): void => {
      for (const n of nodes) {
        if (n.type === 'dir') walk(n.children ?? []);
        else if (n.path.startsWith(guide.dir + '/') && n.path.endsWith('.md')) out.push(n.path);
      }
    };
    walk(tree);
    return out;
  }, [guide, tree]);

  const editorOptions = useMemo(() => {
    if (!guide || guide.kind !== 'text') return [] as string[];
    let files = artifactFiles.length ? artifactFiles : stageFiles;
    if (guide.primary && files.includes(guide.primary)) {
      files = [guide.primary, ...files.filter((p) => p !== guide.primary)];
    }
    if (files.length) {
      if (stage?.id === 'chapter' || stage?.id === 'deslop') {
        return [...files].sort((a, b) => numOf(b) - numOf(a));
      }
      return files;
    }
    return guide.primary ? [guide.primary] : [];
  }, [guide, artifactFiles, stageFiles, stage]);

  // 阶段或文件列表变化 → 切到该步的首选文件
  useEffect(() => {
    const opt = editorOptions[0] ?? null;
    setEditorPath((prev) => {
      if (opt && !editorOptions.includes(prev ?? '')) return opt;
      if (!opt) return null;
      return prev;
    });
    setContent('');
    setMtime(null);
    setGateLine(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage?.id, editorOptions.join('|')]);

  // 读取当前文件（refreshKey 用于 AI 生成后强制重读）
  useEffect(() => {
    if (!bookId || !editorPath) {
      setContent('');
      setFileMissing(false);
      return;
    }
    let cancelled = false;
    api.readFile(bookId, editorPath)
      .then((r) => {
        if (cancelled) return;
        setContent(r.content);
        setMtime(r.mtime);
        setFileMissing(false);
      })
      .catch((e: any) => {
        if (cancelled) return;
        if (e?.status === 404) { setContent(''); setMtime(null); setFileMissing(true); }
        else setFileMissing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bookId, editorPath, refreshKey]);

  const save = async () => {
    if (!bookId || !editorPath || saving) return;
    setSaving(true);
    try {
      const r = await api.writeFile(bookId, editorPath, content, mtime);
      setMtime(r.mtime);
      setFileMissing(false);
      setToast('已保存：' + editorPath + '（' + content.length + ' 字）');
      await load();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  const requiresDone = (st: StageView) => st.requires.every((r) => doneIds.has(r));
  const canGenerate = !!stage && !!guide && guide.kind === 'text' && !runningStage &&
    (stage.status === 'pending' || stage.status === 'blocked' || stage.status === 'review') &&
    requiresDone(stage);

  const confirming = !!stage && (stage.status === 'review' || stage.status === 'blocked');
  const reviewActions = (): Array<{ id: string; label: string }> => {
    if (!stage || !guide) return [];
    if (stage.status === 'blocked') {
      const arr: Array<{ id: string; label: string }> = [];
      if (guide.canSkip) arr.push({ id: 'skip', label: '→ 跳过' });
      arr.push({ id: 'force_approve', label: '⚠ 人工放行' });
      return arr;
    }
    const arr: Array<{ id: string; label: string }> = [
      { id: 'approve', label: '✓ 通过' },
      { id: 'edit_rerun', label: '✎ 改后重跑' },
    ];
    if (guide.canReject) arr.push({ id: 'reject_regen', label: '✕ 驳回重写' });
    if (guide.canSkip) arr.push({ id: 'skip', label: '→ 跳过' });
    return arr;
  };

  if (loading && stages.length === 0) return <div>正在翻开流程…</div>;
  if (!stages.length) {
    return (
      <div>
        <div style={{ color: 'var(--ink-2)' }}>这本书还没有流程定义（{error ?? ''}）。</div>
        <Link to={'/novels/' + bookId} className='ink-btn' style={{ marginTop: 12 }}>返回工作台</Link>
      </div>
    );
  }

  const doneCount = stages.filter((s) => doneIds.has(s.id)).length;

  return (
    <div style={{ maxWidth: 900 }}>
      {/* 顶栏：标题 + 进度 + 紧凑开关 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
        <h1 className='serif' style={{ margin: 0, fontSize: 20 }}>《{bookName}》创作流程</h1>
        <span className='mono' style={{ fontSize: 12, color: 'var(--ink-2)' }}>已完成 {doneCount}/{stages.length} 步</span>
        {dayCost !== null && dayCost > 0 && (
          <span className='mono' style={{ fontSize: 12, color: 'var(--ink-2)' }}>· 本日 ¥{(dayCost / 100).toFixed(2)}</span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ display: 'flex', gap: 6 }}>
          <button className={'ink-btn' + (view === 'step' ? ' primary' : '')} style={{ padding: '4px 12px', fontSize: 13 }} onClick={() => setView('step')}>步骤</button>
          <button className={'ink-btn' + (view === 'overview' ? ' primary' : '')} style={{ padding: '4px 12px', fontSize: 13 }} onClick={() => setView('overview')}>总览</button>
        </span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12.5, color: 'var(--ink-2)' }}>
          <input type='checkbox' checked={fake} onChange={(e) => setFake(e.target.checked)} />
          假渠道（demo）
        </label>
        <button className='ink-btn' style={{ padding: '4px 12px', fontSize: 13 }} onClick={load}>⟳ 刷新</button>
        <Link to={'/novels/' + bookId} className='ink-btn' style={{ padding: '4px 12px', fontSize: 13 }}>返回工作台</Link>
      </div>

      {error && (
        <div style={{ padding: '9px 14px', border: '1px solid var(--red-vermillion)', color: 'var(--red-vermillion)', borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
          ⚠️ {error}
        </div>
      )}
      {jobError && (
        <div style={{ padding: '9px 14px', border: '1px solid var(--red-vermillion)', borderRadius: 6, marginBottom: 12, fontSize: 13, background: 'color-mix(in srgb, var(--red-vermillion) 6%, var(--paper))' }}>
          <span style={{ color: 'var(--red-vermillion)' }}>⚠️ {jobError}</span>
          <button className='ink-btn' style={{ marginLeft: 10, padding: '2px 10px', fontSize: 12 }} onClick={() => setJobError(null)}>知道了</button>
        </div>
      )}
      {toast && (
        <div className='stamp-in' style={{ padding: '9px 14px', border: '1px solid var(--green-jade)', color: 'var(--green-jade)', borderRadius: 6, marginBottom: 12, fontSize: 13, background: 'color-mix(in srgb, var(--green-jade) 6%, var(--paper))' }}>
          {toast}
        </div>
      )}

      {view === 'step' && (
        <>
      {/* 步骤条：点击可跳转 */}
      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 16 }}>
        {stages.map((s, i) => {
          const st = s.status;
          const isCurrent = i === selected;
          const isDone = doneIds.has(s.id);
          return (
            <button
              key={s.id}
              onClick={() => setSelected(i)}
              title={s.title + ' · ' + (STATUS_LABEL[st] ?? st)}
              style={{
                border: isCurrent ? '1.5px solid var(--gold-saffron)' : '1px solid var(--line)',
                background: isDone ? 'color-mix(in srgb, var(--green-jade) 10%, var(--paper))' : isCurrent ? 'color-mix(in srgb, var(--gold-saffron) 12%, var(--paper))' : 'var(--paper)',
                color: isDone ? 'var(--green-jade)' : isCurrent ? 'var(--ink)' : 'var(--ink-2)',
                borderRadius: 5, padding: '5px 9px', fontSize: 12, cursor: 'pointer',
              }}
            >
              <span className='mono' style={{ marginRight: 4, opacity: 0.75 }}>{i + 1}</span>
              <span className='serif'>{GUIDES[s.id]?.label ?? s.title}</span>
            </button>
          );
        })}
      </div>

      {/* 当前步骤卡 */}
      {stage && guide && (
        <div className='rail-block' style={{ padding: '18px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
            <h2 className='serif' style={{ margin: 0, fontSize: 19 }}>第 {selected + 1} 步 · {guide.label}</h2>
            <span className={'seal ' + (doneIds.has(stage.id) ? 'seal-pass' : stage.status === 'blocked' ? 'seal-blocking' : 'seal-pending')} style={{ marginLeft: 'auto', textTransform: 'none' }}>
              {STATUS_LABEL[stage.status] ?? stage.status}
            </span>
          </div>
          {!requiresDone(stage) && (
            <div style={{ padding: '8px 12px', border: '1px solid var(--gold-saffron)', borderRadius: 5, marginBottom: 12, fontSize: 12.5, color: 'var(--gold-saffron)' }}>
              前面还有未完成的步骤：{stage.requires.map((r) => GUIDES[r]?.label ?? r).join('、')}（先完成它们）
            </div>
          )}
          <p style={{ color: 'var(--ink-2)', fontSize: 13.5, lineHeight: 1.9, margin: '6px 0 8px' }}>{guide.desc}</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
            <Link
              to={WORK_MODULE[stage.id]?.m === 'export' ? '/export' : '/novels/' + bookId + '?module=' + (WORK_MODULE[stage.id]?.m ?? 'settings') + (editorPath ? '&path=' + encodeURIComponent(editorPath) : '')}
              className='ink-btn'
              style={{ padding: '4px 12px', fontSize: 12.5 }}
            >
              在工作台「{WORK_MODULE[stage.id]?.label ?? '工作台'}」查看 / 编辑 →
            </Link>
            <span style={{ fontSize: 11.5, color: 'var(--ink-2)' }}>流程与工作台是同一批文件，AI 生成与这里编辑实时同步。</span>
          </div>

          {guide.kind === 'image' ? (
            <div style={{ padding: '14px 16px', border: '1px dashed var(--line)', borderRadius: 6, color: 'var(--ink-2)', fontSize: 13.5, lineHeight: 2 }}>
              封面 / 角色图的图片生成尚未接入。可先点下方「AI 生成」尝试（会提示未接入），然后「→ 跳过」本步，不影响正文与导出链路。
            </div>
          ) : editorPath ? (
            <>
              {/* 产物文件目录：本阶段产出的全部文件（file-set 多文件/多类型），点击切换编辑 */}
              {editorOptions.length > 1 && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.9 }}>产物文件（{editorOptions.length}）：</span>
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', flex: 1 }}>
                    {editorOptions.slice(0, 16).map((p) => (
                      <button
                        key={p}
                        onClick={() => setEditorPath(p)}
                        title={p}
                        style={{
                          border: p === editorPath ? '1.5px solid var(--gold-saffron)' : '1px solid var(--line)',
                          background: p === editorPath ? 'color-mix(in srgb, var(--gold-saffron) 12%, var(--paper))' : 'var(--paper)',
                          color: 'var(--ink)', borderRadius: 4, padding: '3px 9px', fontSize: 12, cursor: 'pointer',
                          maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}
                      >
                        {(p.split('/').pop() ?? p)}
                      </button>
                    ))}
                    {editorOptions.length > 16 && <span style={{ fontSize: 11.5, color: 'var(--ink-2)', alignSelf: 'center' }}>… 共 {editorOptions.length} 个</span>}
                    <span className='mono' style={{ fontSize: 11.5, color: 'var(--ink-2)', alignSelf: 'center', marginLeft: 4 }}>字数 {content.replace(/\s/g, '').length}</span>
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                <button className='ink-btn primary' disabled={!canGenerate} onClick={() => runStage(stage.id)} style={{ padding: '7px 16px' }}>
                  {runningStage === stage.id ? 'AI 生成中…' : stage.status === 'review' || stage.status === 'blocked' ? '↻ AI 重新生成' : 'AI 生成'}
                </button>
                <button className='ink-btn' disabled={!content && !fileMissing} onClick={() => setAiEdit({ open: true, path: editorPath, mtime })} style={{ padding: '7px 16px' }}>
                  ✨ AI 改稿
                </button>
                <button className='ink-btn' disabled={saving || !content} onClick={save} style={{ padding: '7px 16px' }}>
                  {saving ? '保存中…' : '保存'}
                </button>
              </div>

              {gateLine && (
                <div style={{ marginBottom: 8, fontSize: 12.5, padding: '7px 10px', borderRadius: 5, border: '1px solid ' + (gateLine.kind === 'block' ? 'var(--red-vermillion)' : gateLine.kind === 'warn' ? 'var(--gold-saffron)' : 'var(--green-jade)'), color: gateLine.kind === 'block' ? 'var(--red-vermillion)' : gateLine.kind === 'warn' ? 'var(--gold-saffron)' : 'var(--green-jade)', background: 'color-mix(in srgb, var(--paper-2) 60%, var(--paper))' }}>
                  {gateLine.text}
                </div>
              )}
              {fileMissing && !gateLine && (
                <div style={{ marginBottom: 8, fontSize: 12.5, color: 'var(--ink-2)' }}>
                  该文件还没生成。可以直接在这里写初稿后点「保存」，或点「AI 生成」让 AI 产出。
                </div>
              )}
              {runningStage === stage.id && !gateLine && !jobError && (
                <div style={{ marginBottom: 8, fontSize: 12.5, color: 'var(--gold-saffron)' }}>⏳ AI 正在生成「{guide.label}」…</div>
              )}

              <div className='editor-frame'>
                <Suspense fallback={<div style={{ padding: 16, color: 'var(--ink-2)', fontSize: 13 }}>编辑器载入中…</div>}>
                  <PageEditor value={content} draftKey={bookId + ':' + editorPath} onChange={(v) => setContent(v)} />
                </Suspense>
              </div>
            </>
          ) : (
            <div style={{ color: 'var(--ink-2)', fontSize: 13 }}>这个阶段暂时没有可编辑文件。</div>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 16 }}>
            <button className='ink-btn' disabled={selected <= 0} onClick={() => setSelected((v) => Math.max(0, v - 1))} style={{ padding: '6px 16px' }}>
              ← 上一步
            </button>
            <button className='ink-btn' disabled={selected >= stages.length - 1} onClick={() => setSelected((v) => Math.min(stages.length - 1, v + 1))} style={{ padding: '6px 16px' }}>
              下一步 →
            </button>
          </div>
        </div>
      )}

      {/* 批阅栏（待确认/阻塞时出现） */}
      {confirming && stage && guide && (
        <div className='review-bar'>
          <div style={{ flex: 1, minWidth: 180 }}>
            <strong>第 {selected + 1} 步「{guide.label}」待确认</strong>
            <div style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 2 }}>批语会写进留痕（audit）</div>
          </div>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={'对 ' + guide.label + ' 的批语 / 修改要求（可选）…'} style={{ flex: '1.5', minWidth: 200, background: 'var(--paper)', border: '1px solid var(--line)', color: 'var(--ink)', padding: '6px 8px', borderRadius: 4, minHeight: 32, resize: 'vertical' }} />
          {reviewActions().map((a) => (
            <button key={a.id} className='ink-btn' style={{ padding: '7px 14px' }} disabled={!!acting || !!runningStage} onClick={() => review(a.id)}>
              {acting === a.id ? '…' : a.label}
            </button>
          ))}
        </div>
      )}

        </>
      )}

      {/* 总览：目录式查看整体流程（类似旧版阶段轴 + 概览统计） */}
      {view === 'overview' && (
        <div className='rail-block' style={{ padding: '18px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
            <h2 className='serif' style={{ margin: 0, fontSize: 18 }}>全书流程 · 总览</h2>
            <span className='mono' style={{ fontSize: 12, color: 'var(--ink-2)' }}>完成 {doneCount}/{stages.length} 步</span>
            {runningStage && <span style={{ color: 'var(--gold-saffron)', fontSize: 13 }}>⏳ 「{labelOf(runningStage)}」生成中…</span>}
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 12, color: 'var(--ink-2)' }}>点阶段名可打开对应步骤</span>
          </div>

          <div style={{ display: 'grid', gap: 6, marginBottom: 16 }}>
            {stages.map((s, i) => {
              const g = GUIDES[s.id];
              const isDone = doneIds.has(s.id);
              const canRun = !!g && g.kind === 'text' && !runningStage && (s.status === 'pending' || s.status === 'blocked' || s.status === 'review');
              const isBlocked = s.status === 'blocked';
              const isReview = s.status === 'review';
              const acts: Array<{ id: string; label: string }> = [];
              if (isBlocked) {
                if (g?.canSkip) acts.push({ id: 'skip', label: '跳过' });
                acts.push({ id: 'force_approve', label: '人工放行' });
              } else if (isReview) {
                acts.push({ id: 'approve', label: '✓ 通过' }, { id: 'edit_rerun', label: '改后重跑' });
                if (g?.canReject) acts.push({ id: 'reject_regen', label: '驳回重写' });
                if (g?.canSkip) acts.push({ id: 'skip', label: '跳过' });
              }
              return (
                <div
                  key={s.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px',
                    border: '1px solid var(--line)', borderRadius: 5, flexWrap: 'wrap',
                    background: i === selected ? 'color-mix(in srgb, var(--gold-saffron) 10%, var(--paper))' : 'var(--paper)',
                  }}
                >
                  <button
                    className='ink-btn'
                    style={{ padding: '3px 9px', fontSize: 12.5, fontWeight: 600 }}
                    title={'打开第 ' + (i + 1) + ' 步：' + (g?.label ?? s.title)}
                    onClick={() => { setSelected(i); setView('step'); }}
                  >
                    {i + 1}. {g?.label ?? s.title}
                  </button>
                  <span className={'seal ' + (isDone ? 'seal-pass' : isBlocked ? 'seal-blocking' : s.status === 'review' ? 'seal-pending' : '')} style={{ fontSize: 10.5 }}>
                    {STATUS_LABEL[s.status] ?? s.status}
                  </span>
                  <span className='mono' style={{ fontSize: 11, color: 'var(--ink-2)', flex: 1, minWidth: 120 }}>
                    {s.gates.join(' · ') || '—'}
                  </span>
                  {canRun && (
                    <button className='ink-btn' style={{ padding: '3px 10px', fontSize: 12 }} disabled={!!runningStage} onClick={() => runStage(s.id)}>
                      {runningStage === s.id ? '生成中…' : s.status === 'review' || s.status === 'blocked' ? '↻ 重跑' : 'AI 生成'}
                    </button>
                  )}
                  {acts.map((a) => (
                    <button key={a.id} className='ink-btn' style={{ padding: '3px 10px', fontSize: 12 }} disabled={!!acting || !!runningStage} onClick={() => review(a.id, s.id)}>
                      {acting === a.id ? '…' : a.label}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>

          {/* 概览统计：成本 / 追踪 / 最近门禁结果 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, borderTop: '1px dashed var(--line)', paddingTop: 14 }}>
            <div>
              <div style={{ color: 'var(--ink-2)', fontSize: 12 }}>本日 / 本月成本</div>
              <div className='mono' style={{ fontSize: 15, color: (costAll?.month_ratio ?? 0) >= 1 ? 'var(--red-vermillion)' : 'inherit' }}>¥{(costAll?.day_cents ?? 0) / 100} / {(costAll?.month_cents ?? 0) / 100}</div>
            </div>
            <div>
              <div style={{ color: 'var(--ink-2)', fontSize: 12 }}>Tokens（入 / 出）</div>
              <div className='mono' style={{ fontSize: 13 }}>{(costAll?.total_tokens_in ?? 0).toLocaleString()} / {(costAll?.total_tokens_out ?? 0).toLocaleString()}</div>
            </div>
            <div>
              <div style={{ color: 'var(--ink-2)', fontSize: 12 }}>追踪状态</div>
              <div className='mono' style={{ fontSize: 13 }}>{tracking?.exists ? '已提交至第 ' + (tracking.last_committed_chapter ?? 0) + ' 章' : '未初始化'}</div>
            </div>
            <div>
              <div style={{ color: 'var(--ink-2)', fontSize: 12 }}>按阶段成本</div>
              <div className='mono' style={{ fontSize: 12 }}>
                {costAll?.by_stage && Object.keys(costAll.by_stage).length
                  ? Object.entries(costAll.by_stage as Record<string, number>).slice(0, 4).map(([k, v]) => k + ' ¥' + (v / 100).toFixed(2)).join(' · ')
                  : '—'}
              </div>
            </div>
            {gateLine && (
              <div style={{ gridColumn: '1 / -1' }}>
                <div style={{ fontSize: 12.5, padding: '6px 10px', borderRadius: 5, border: '1px solid ' + (gateLine.kind === 'block' ? 'var(--red-vermillion)' : gateLine.kind === 'warn' ? 'var(--gold-saffron)' : 'var(--green-jade)'), color: gateLine.kind === 'block' ? 'var(--red-vermillion)' : gateLine.kind === 'warn' ? 'var(--gold-saffron)' : 'var(--green-jade)' }}>
                  {gateLine.text}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* AI 改稿抽屉 */}
      <AIEditDrawer
        open={aiEdit.open}
        onClose={() => setAiEdit((s) => ({ ...s, open: false }))}
        bookId={bookId!}
        targetPath={aiEdit.path}
        mtime={aiEdit.mtime}
        onApplied={() => {
          load();
          if (aiEdit.path) {
            api.readFile(bookId!, aiEdit.path).then((r) => { setContent(r.content); setMtime(r.mtime); }).catch(() => {});
          }
        }}
      />
    </div>
  );
}

function labelOf(id: string): string {
  return GUIDES[id]?.label ?? id;
}

function actionLabel(action: string): string {
  const map: Record<string, string> = { approve: '通过', edit_rerun: '改后重跑', reject_regen: '驳回重写', skip: '跳过', force_approve: '人工放行' };
  return map[action] ?? action;
}

function summarizeGates(gates: any): { kind: 'pass' | 'warn' | 'block'; text: string } | null {
  if (!gates) return null;
  const blocks: string[] = [];
  const warns: string[] = [];
  for (const [k, v] of Object.entries(gates)) {
    const gv = (v ?? {}) as any;
    for (const b of (gv?.blocking ?? [])) blocks.push(k + '·' + b?.rule);
    for (const w of (gv?.warnings ?? [])) warns.push(w?.rule);
  }
  if (blocks.length) return { kind: 'block', text: '门禁阻塞：' + blocks.slice(0, 3).join('、') + '（可改稿或改后重跑）' };
  if (warns.length) return { kind: 'warn', text: '门禁通过（' + warns.length + ' 条警示）' };
  return { kind: 'pass', text: '✓ 门禁全过，可以确认' };
}

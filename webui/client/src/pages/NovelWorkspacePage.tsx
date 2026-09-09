import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, BookDetail, FileNode } from '../api/client.ts';
// CodeMirror 6 体积占首屏一半以上：按需加载（打开手稿时才拉取 chunk）
const PageEditor = lazy(() => import('../components/PageEditor.tsx').then((m) => ({ default: m.PageEditor })));
import { GateReportCard } from '../components/GateReportCard.tsx';
import { TrackingBoard } from '../components/TrackingBoard.tsx';
import { CharactersDualView } from '../components/CharactersDualView.tsx';
import { AIEditDrawer } from '../components/AIEditDrawer.tsx';
import { SearchPanel } from '../components/SearchPanel.tsx';
import { MaterialPanel } from '../components/MaterialPanel.tsx';
import { EmotionLine, RhythmStrip } from '../components/ChartCard.tsx';

type Module = 'settings' | 'outline' | 'chapters' | 'state' | 'pipeline' | 'material';

/** P3 小说工作台：左结构树 + 中手稿 + 右工具廊 */
export function NovelWorkspacePage() {
  const { bookId } = useParams();
  const [params, setParams] = useSearchParams();
  const [book, setBook] = useState<BookDetail | null>(null);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [emotion, setEmotion] = useState<any>(null);
  const [rhythm, setRhythm] = useState<any>(null);
  const [importPending, setImportPending] = useState(false);
  const [aiEdit, setAiEdit] = useState<{ open: boolean; path: string; mtime: number | null }>({ open: false, path: '', mtime: null });
  const navigate = useNavigate();

  const module = (params.get('module') ?? 'chapters') as Module;
  const filePath = params.get('path');

  useEffect(() => {
    if (!bookId) return;
    api
      .getBook(bookId)
      .then(setBook)
      .catch((e) => setError(String(e.message ?? e)));
    api
      .tree(bookId)
      .then((r) => setTree(r.tree))
      .catch(() => setTree([]));
    // 导入书待校对 → 顶栏黄条引导（fail-closed：未复核不能开启正文续写）
    api
      .importReviewStatus(bookId)
      .then((r) => setImportPending(!!r.pending && !!r.review))
      .catch(() => setImportPending(false));
  }, [bookId]);

  const moduleTabs: Array<[Module, string]> = [
    ['settings', '设定'],
    ['outline', '大纲'],
    ['chapters', '正文'],
    ['state', '状态'],
    ['pipeline', '流程'],
    ['material', '素材'],
  ];

  const setModule = useCallback(
    (m: Module) => {
      const next = new URLSearchParams(params);
      next.set('module', m);
      next.delete('path');
      setParams(next);
    },
    [params, setParams],
  );

  // 全局搜索快捷键（webui-frontend §9.1 Ctrl/Cmd+P）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') { e.preventDefault(); setSearchOpen((v) => !v); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!bookId) return;
    api.emotionCurve(bookId).then(setEmotion).catch(() => {});
    api.rhythmCurve(bookId).then(setRhythm).catch(() => {});
  }, [bookId, module]);

  const openSearchPath = (bid: string, path: string) => {
    navigate(`/novels/${bid}?module=chapters&path=${encodeURIComponent(path)}`);
  };

  return (
    <div className="workspace">
      <aside className="struct-tree">
        <h4>{book?.name ?? '…'}</h4>
        <div style={{ display: 'grid', gap: 2 }}>
          {moduleTabs.map(([m, label]) => (
            <button
              key={m}
              className={`tree-item ${module === m ? 'active' : ''}`}
              style={{
                border: 'none',
                background: 'transparent',
                width: '100%',
                justifyContent: 'flex-start',
              }}
              onClick={() => setModule(m)}
            >
              <span className="tree-icon">{iconFor(m)}</span>
              {label}
            </button>
          ))}
          <button
            className={`tree-item ${params.get('view') === 'characters' ? 'active' : ''}`}
            style={{ border: 'none', background: 'transparent', width: '100%', justifyContent: 'flex-start' }}
            onClick={() => {
              const next = new URLSearchParams(params);
              next.set('module', 'settings');
              next.set('view', 'characters');
              next.delete('path');
              setParams(next);
            }}
          >
            <span className="tree-icon">◉</span>
            角色双视图
          </button>
        </div>
        <div style={{ marginTop: 14 }}>
          <h4>书稿结构</h4>
          <TreeNodes
            nodes={tree}
            currentPath={filePath}
            onPick={(p) => {
              const next = new URLSearchParams(params);
              next.set('module', 'chapters');
              next.set('path', p);
              setParams(next);
            }}
          />
        </div>
      </aside>

      <section className="manuscript">
        {importPending && (
          <div style={{ border: '1px solid var(--gold-saffron)', background: 'color-mix(in srgb, var(--gold-saffron) 12%, var(--paper))', padding: '10px 14px', borderRadius: 6, marginBottom: 12, fontSize: 13, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>这是一本「导入」的书，正文续写前需先完成 <strong>导入校对</strong>（复核分章/角色/伏笔/时间线并认定 last_committed_chapter）。</span>
            <Link to={'/novels/' + bookId + '/import-review'} className="ink-btn primary" style={{ margin: 0 }}>
              去导入校对 →
            </Link>
          </div>
        )}
        {error && <div style={{ color: 'var(--red-vermillion)', marginBottom: 10 }}>⚠️ {error}</div>}
        {module === 'state' ? (
          <div>
            <TrackingBoard bookId={bookId!} />
            {(emotion || rhythm) && (
              <div style={{ marginTop: 14 }}>
                <h4 className="serif" style={{ fontSize: 15 }}>节奏 / 情绪</h4>
                <div className="rail-block">
                  <div className="rb-title">节奏条带（eq across 章）</div>
                  {rhythm && <RhythmStrip curve={rhythm} />}
                </div>
                <div className="rail-block" style={{ marginTop: 10 }}>
                  <div className="rb-title">情绪曲线</div>
                  {emotion && <EmotionLine curve={emotion} />}
                </div>
              </div>
            )}
          </div>
        ) : module === 'pipeline' ? (
          <div style={{ padding: 8 }}>
            <Link to={`/novels/${bookId}/pipeline`} className="ink-btn primary">
              打开流程看板 →
            </Link>
          </div>
        ) : module === 'material' ? (
          <MaterialPanel bookId={bookId!} />
        ) : params.get('view') === 'characters' ? (
          <CharactersDualView
            bookId={bookId!}
            onOpenCard={(p) => {
              const next = new URLSearchParams(params);
              next.set('module', 'settings');
              next.delete('view');
              next.set('path', p);
              setParams(next);
            }}
          />
        ) : (
          <FileModule
            module={module}
            bookId={bookId!}
            filePath={filePath}
            tree={tree}
            onSaved={() => {
              api
                .tree(bookId!)
                .then((r) => setTree(r.tree))
                .catch(() => {});
            }}
          />
        )}
      </section>

      <aside className="tool-rail">
        <ToolRail
          bookId={bookId!}
          module={module}
          navigate={navigate}
          tree={tree}
          onRequestAiEdit={(path, mtime) => setAiEdit({ open: true, path, mtime })}
        />
      </aside>

      <SearchPanel open={searchOpen} onClose={() => setSearchOpen(false)} onOpenPath={openSearchPath} />

      {/* 工作台级 AI 编辑抽屉（右侧工具廊也走这里） */}
      <AIEditDrawer
        open={aiEdit.open}
        onClose={() => setAiEdit((s) => ({ ...s, open: false }))}
        bookId={bookId!}
        targetPath={aiEdit.path}
        mtime={aiEdit.mtime}
        onApplied={() => {
          api
            .tree(bookId!)
            .then((r) => setTree(r.tree))
            .catch(() => {});
        }}
      />
    </div>
  );
}

function iconFor(m: Module): string {
  switch (m) {
    case 'settings':
      return '❏';
    case 'outline':
      return '≡';
    case 'chapters':
      return '☰';
    case 'state':
      return '◈';
    case 'pipeline':
      return '▤';
    case 'material':
      return '◩';
      return '▤';
  }
}

function TreeNodes({
  nodes,
  currentPath,
  onPick,
}: {
  nodes: FileNode[];
  currentPath?: string | null;
  onPick: (path: string) => void;
}) {
  return (
    <>
      {nodes.map((n) =>
        n.type === 'dir' ? (
          <div key={n.path} className="tree-group">
            <div className="tree-item" style={{ fontWeight: 600, color: 'var(--ink-2)', cursor: 'default' }}>
              <span className="tree-icon">▾</span> {n.name}
            </div>
            {n.children && (
              <div className="tree-children">
                <TreeNodes nodes={n.children} currentPath={currentPath} onPick={onPick} />
              </div>
            )}
          </div>
        ) : (
          <div
            key={n.path}
            className={`tree-item ${currentPath === n.path ? 'active' : ''}`}
            onClick={() => onPick(n.path)}
            title={n.path}
          >
            <span className="tree-icon">·</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.name}</span>
          </div>
        ),
      )}
    </>
  );
}

function FileModule({
  module,
  bookId,
  filePath,
  onSaved,
  tree,
}: {
  module: Module;
  bookId: string;
  filePath?: string | null;
  onSaved: () => void;
  tree: FileNode[];
}) {
  const dir = module === 'chapters' ? '正文' : module === 'outline' ? '大纲' : module === 'settings' ? '设定' : '';
  // 候选 = 默认文件 + 树里该模块目录下已有 .md 文件（保证总能打开到已有内容）
  const candidates = useMemo(() => {
    const list: string[] = [];
    const defaults =
      module === 'chapters'
        ? ['正文/第001章_军宣新星.md']
        : module === 'outline'
          ? ['大纲/大纲.md']
          : module === 'settings'
            ? ['设定/题材定位.md']
            : [];
    list.push(...defaults);
    const walk = (nodes: FileNode[]): void => {
      for (const n of nodes) {
        if (n.type === 'dir') walk(n.children ?? []);
        else if (dir && n.path.startsWith(dir + '/') && n.path.endsWith('.md') && !list.includes(n.path)) list.push(n.path);
      }
    };
    walk(tree);
    return list;
  }, [module, tree]);
  return (
    <FileEditor
      bookId={bookId}
      filePath={filePath}
      defaultCandidates={candidates}
      onSaved={onSaved}
    />
  );
}

/**
 * 手稿文件编辑：读文件 → CodeMirror 编辑（草稿存 localStorage）→
 * 保存走 PUT /files（带 mtime 乐观锁）→ 可触发门禁；mtime 冲突提示。
 */
function FileEditor({
  bookId,
  filePath,
  defaultCandidates,
  onSaved,
}: {
  bookId: string;
  filePath?: string | null;
  defaultCandidates: string[];
  onSaved: () => void;
}) {
  const [activePath, setActivePath] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [mtime, setMtime] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const [lastSaveAt, setLastSaveAt] = useState<string | null>(null);
  const [gateResult, setGateResult] = useState<any>(null);
  const [gating, setGating] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [fallbackIdx, setFallbackIdx] = useState(0);
  // The file the user explicitly selected via URL (?path=); null when none selected.
  const explicitPath = filePath ?? null;


  // Adopt the selected file: on an explicit URL pick we switch to it and immediately clear
  // stale content so the editor never shows the previous chapter's text while the new one
  // loads; without an explicit pick we fall back to the first default candidate.
  useEffect(() => {
    const target = explicitPath ?? defaultCandidates[0] ?? null;
    setActivePath((prev) => (prev === target ? prev : target));
    setFallbackIdx(0);
    setContent('');
    setMtime(null);
    setLastSaveAt(null);
    setConflict(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [explicitPath]);
  // Load the content for the active path.
  useEffect(() => {
    if (!activePath) return;
    let cancelled = false;
    setLoading(true);
    setConflict(null);
    api
      .readFile(bookId, activePath)
      .then((r) => {
        if (cancelled) return;
        setContent(r.content);
        setMtime(r.mtime);
      })
      .catch((e) => {
        if (cancelled) return;
        const notFound = e?.status === 404;
        // Fall back to the next candidate ONLY when no file was explicitly picked (e.g. a
        // brand-new book whose hardcoded default chapter does not exist), so the workspace is
        // not blank. A chapter the user explicitly clicked must never be silently replaced
        // with a different one - show the missing-file error instead.
        if (notFound && !explicitPath && fallbackIdx < defaultCandidates.length - 1) {
          const next = defaultCandidates[fallbackIdx + 1];
          if (next) {
            setActivePath(next);
            setFallbackIdx(fallbackIdx + 1);
            return;
          }
        }
        setContent('');
        setConflict(notFound ? '\u6587\u4ef6\u4e0d\u5b58\u5728\uff1a' + activePath : (e?.message ?? String(e)));
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [bookId, activePath, explicitPath, fallbackIdx, defaultCandidates]);

  const save = useCallback(async () => {
    if (!activePath || saving) return;
    setSaving(true);
    setConflict(null);
    try {
      const r = await api.writeFile(bookId, activePath, content, mtime);
      setMtime(r.mtime);
      setLastSaveAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
      onSaved();
    } catch (e: any) {
      setConflict(e?.message ?? String(e));
      if (e?.status === 409) {
        // 冲突：放弃本地锁提示刷新
        setConflict('文件已被外部修改（mtime 冲突）。你本地草稿仍在草稿箱，请刷新后再合并。');
      }
    } finally {
      setSaving(false);
    }
  }, [bookId, activePath, content, mtime, saving, onSaved]);

  const runGates = useCallback(async () => {
    setGating(true);
    setGateResult(null);
    try {
      const r = await api.runGates(bookId);
      setGateResult(r);
    } catch (e: any) {
      setGateResult({ error: e?.message ?? String(e) });
    } finally {
      setGating(false);
    }
  }, [bookId]);

  if (!activePath) {
    return <div style={{ color: 'var(--ink-2)' }}>该书稿暂无正文文件可选。</div>;
  }

  const wordCount = content.replace(/\s/g, '').length;

  return (
    <div className="page-editor-wrap">
      <h2 className="page-title" style={{ fontSize: 18 }}>
        {activePath.split('/').pop()}
      </h2>
      <div className="page-sub">{activePath}</div>
      {loading && (
        <div className="mono" style={{ color: 'var(--ink-2)', fontSize: 12, margin: '4px 0 10px' }}>
          {'\u8f7d\u5165\u4e2d'}…
        </div>
      )}

      <div className="editor-toolbar">
        <button
          className="ink-btn primary"
          onClick={save}
          disabled={saving || loading}
          title="Ctrl/Cmd+S"
        >
          {saving ? '保存中…' : '✒ 保存'}
        </button>
        <button className="ink-btn" onClick={runGates} disabled={gating}>
          {gating ? '门禁运行中…' : '⚖ 保存并跑门禁'}
        </button>
        <button className="ink-btn" onClick={() => setAiOpen(true)} disabled={loading} title="AI 需求式编辑">
          ✨ AI 改稿
        </button>
        {lastSaveAt && (
          <span className="mono" style={{ color: 'var(--green-jade)', fontSize: 12 }}>
            已存 {lastSaveAt}
          </span>
        )}
        <span className="word-count">字数 {wordCount.toLocaleString()}</span>
      </div>

      {conflict && (
        <div
          style={{
            border: '1px solid var(--red-vermillion)',
            background: 'color-mix(in srgb, var(--red-vermillion) 8%, var(--paper))',
            padding: '10px 14px',
            borderRadius: 6,
            margin: '8px 0',
            fontSize: 13,
            color: 'var(--red-vermillion)',
          }}
        >
          <strong>朱批：</strong>
          {conflict}
          {conflict.includes('请刷新') && (
            <button
              className="ink-btn"
              style={{ marginLeft: 10, padding: '2px 10px', fontSize: 12 }}
              onClick={() => window.location.reload()}
            >
              重新载入
            </button>
          )}
        </div>
      )}

      <div className="editor-frame">
        <Suspense fallback={<div style={{ padding: 16, color: 'var(--ink-2)', fontSize: 13 }}>编辑器载入中…</div>}>
          <PageEditor
            value={content}
            draftKey={`${bookId}:${activePath}`}
            onChange={(v) => setContent(v)}
          />
        </Suspense>
      </div>

      {gateResult && <GateReportCard result={gateResult} />}

      <AIEditDrawer
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        bookId={bookId}
        targetPath={activePath}
        mtime={mtime}
        onApplied={(nm) => {
          setMtime(nm);
          api
            .readFile(bookId, activePath)
            .then((r) => { setContent(r.content); setMtime(r.mtime); onSaved(); })
            .catch(() => {});
        }}
      />
    </div>
  );
}

/** 右工具廊（webui-frontend P3）：门禁快报 + AI 编辑占位 */
function ToolRail({
  bookId,
  module,
  navigate,
  tree,
  onRequestAiEdit,
}: {
  bookId: string;
  module: Module;
  navigate: ReturnType<typeof useNavigate>;
  tree: FileNode[];
  onRequestAiEdit: (path: string, mtime: number | null) => void;
}) {
  const [audit, setAudit] = useState<any[]>([]);
  const [aiBusy, setAiBusy] = useState(false);

  useEffect(() => {
    api
      .audit()
      .then((r) => setAudit(r.items.slice(0, 6)))
      .catch(() => {});
  }, []);

  // 当前模块的首篇可编辑文件（AI 编辑目标）
  const moduleDir = module === 'chapters' ? '正文' : module === 'outline' ? '大纲' : module === 'settings' ? '设定' : null;
  const firstFile = useMemo(() => {
    if (!moduleDir || !tree.length) return null;
    const walk = (nodes: FileNode[]): string | null => {
      for (const n of nodes) {
        if (n.type === 'dir') { const r = walk(n.children ?? []); if (r) return r; }
        else if (n.path.startsWith(moduleDir + '/') && n.path.endsWith('.md')) return n.path;
      }
      return null;
    };
    return walk(tree);
  }, [tree, moduleDir]);

  const openAiEdit = async () => {
    if (!firstFile) { alert('当前模块还没有可编辑文件，先运行对应阶段产出。'); return; }
    setAiBusy(true);
    try {
      const f = await api.readFile(bookId, firstFile);
      onRequestAiEdit(firstFile, f.mtime);
    } catch (e: any) {
      onRequestAiEdit(firstFile, null);
    } finally {
      setAiBusy(false);
    }
  };

  return (
    <>
      <h5>{'\u5de5\u5177\u5eca \u00b7 '}{module === 'chapters' ? '正文' : module === 'outline' ? '大纲' : module === 'settings' ? '设定' : module === 'material' ? '素材' : '状态'}</h5>

      <div className="rail-block">
        <div className="rb-title">✒ AI 编辑</div>
        <div style={{ color: 'var(--ink-2)', fontSize: 13, lineHeight: 1.8 }}>
          对当前模块「{moduleDir ?? '正文/设定/大纲'}」内文件做需求式编辑（钩子/改开篇/压缩/去AI味…）。
          {'；目标：' + (firstFile ?? '（暂无）')}
        </div>
        <button className="ink-btn primary" style={{ width: '100%', marginTop: 8 }} onClick={openAiEdit} disabled={aiBusy}>
          {aiBusy ? '准备中…' : '✒ 由我改（打开 AI 编辑）'}
        </button>
      </div>

      <div className="rail-block">
        <div className="rb-title">
          门禁快报
          <button
            className="ink-btn"
            style={{ padding: '2px 8px', fontSize: 12, border: '1px solid var(--line)' }}
            onClick={() => {
              api
                .runGates(bookId)
                .then((r) => {
                  const el = document.querySelector<HTMLElement>('.editor-frame');
                  alert(`门禁完成：blocking=${r.blocking ? '有' : '无'}，见「正文」编辑区下方报告`);
                })
                .catch((e) => alert(e.message));
            }}
          >
            重跑
          </button>
        </div>
        <div style={{ color: 'var(--ink-2)', fontSize: 12.5, lineHeight: 1.7 }}>
          对整书「正文/」跑 ai-patterns + degeneration + outline-detail（M0 spawn 兜底）。
        </div>
      </div>

      <div className="rail-block">
        <div className="rb-title">最近留痕（audit）</div>
        {audit.length === 0 && <div style={{ color: 'var(--ink-2)', fontSize: 12.5 }}>暂无。</div>}
        {audit.map((a) => (
          <div key={a.id} className="audit-line">
            [{a.action}] {a.target} · {new Date(a.ts).toLocaleTimeString('zh-CN', { hour12: false })}
          </div>
        ))}
      </div>
    </>
  );
}
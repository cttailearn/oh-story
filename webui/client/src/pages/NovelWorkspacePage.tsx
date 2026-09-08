import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, BookDetail, FileNode } from '../api/client.ts';
import { PageEditor } from '../components/PageEditor.tsx';
import { GateReportCard } from '../components/GateReportCard.tsx';
import { TrackingBoard } from '../components/TrackingBoard.tsx';
import { CharactersDualView } from '../components/CharactersDualView.tsx';
import { AIEditDrawer } from '../components/AIEditDrawer.tsx';

type Module = 'settings' | 'outline' | 'chapters' | 'state' | 'pipeline';

/** P3 小说工作台：左结构树 + 中手稿 + 右工具廊 */
export function NovelWorkspacePage() {
  const { bookId } = useParams();
  const [params, setParams] = useSearchParams();
  const [book, setBook] = useState<BookDetail | null>(null);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [error, setError] = useState<string | null>(null);
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
  }, [bookId]);

  const moduleTabs: Array<[Module, string]> = [
    ['settings', '设定'],
    ['outline', '大纲'],
    ['chapters', '正文'],
    ['state', '状态'],
    ['pipeline', '流程'],
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
        {error && <div style={{ color: 'var(--red-vermillion)', marginBottom: 10 }}>⚠️ {error}</div>}
        {module === 'state' ? (
          <TrackingBoard bookId={bookId!} />
        ) : module === 'pipeline' ? (
          <div style={{ padding: 8 }}>
            <Link to={`/novels/${bookId}/pipeline`} className="ink-btn primary">
              打开流程看板 →
            </Link>
          </div>
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
        <ToolRail bookId={bookId!} module={module} navigate={navigate} />
      </aside>
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
}: {
  module: Module;
  bookId: string;
  filePath?: string | null;
  onSaved: () => void;
}) {
  const defaultCandidates =
    module === 'chapters'
      ? ['正文/第001章_军宣新星.md']
      : module === 'outline'
        ? ['大纲/大纲.md']
        : module === 'settings'
          ? ['设定/题材定位.md']
          : [];
  return (
    <FileEditor
      bookId={bookId}
      filePath={filePath}
      defaultCandidates={defaultCandidates}
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
  const [activePath, setActivePath] = useState<string | null>(filePath ?? defaultCandidates[0] ?? null);
  const [content, setContent] = useState('');
  const [mtime, setMtime] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const [lastSaveAt, setLastSaveAt] = useState<string | null>(null);
  const [gateResult, setGateResult] = useState<any>(null);
  const [gating, setGating] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);

  useEffect(() => {
    if (filePath) setActivePath(filePath);
  }, [filePath]);

  useEffect(() => {
    if (!activePath) return;
    let cancelled = false;
    setLoading(true);
    setLastSaveAt(null);
    setConflict(null);
    api
      .readFile(bookId, activePath)
      .then((r) => {
        if (cancelled) return;
        setContent(r.content);
        setMtime(r.mtime);
      })
      .catch((e) => {
        if (!cancelled) setConflict(e?.message ?? String(e));
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [bookId, activePath]);

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
        <PageEditor
          value={content}
          draftKey={`${bookId}:${activePath}`}
          onChange={(v) => setContent(v)}
        />
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
}: {
  bookId: string;
  module: Module;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const [audit, setAudit] = useState<any[]>([]);

  useEffect(() => {
    api
      .audit()
      .then((r) => setAudit(r.items.slice(0, 6)))
      .catch(() => {});
  }, []);

  return (
    <>
      <h5>工具廊 · {module === 'chapters' ? '正文' : module === 'outline' ? '大纲' : module === 'settings' ? '设定' : '状态'}</h5>

      <div className="rail-block">
        <div className="rb-title">✒ AI 编辑</div>
        <div style={{ color: 'var(--ink-2)', fontSize: 13, lineHeight: 1.8 }}>
          选中正文/设定中的段落，按 <span className="mono">Ctrl+E</span> 唤醒需求式编辑（M1 实装）。
        </div>
        <button className="ink-btn" style={{ width: '100%', marginTop: 8 }} disabled>
          （M1 开放）由我改
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

// 导入校对页（importing-existing §3，M4 打磨）：
// 分章可视清单（改名/合并/切分/删除，低置信标黄）→ 角色卡（置信度条/补注/忽略）→
// 伏笔（误报/留档）→ 时间线（候选事件）→ [开始续写] 认定 last_committed 并解锁 chapter（fail-closed）
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client.ts';

interface Cand {
  name: string;
  summary: string;
  confidence: number;
  evidence?: string[];
  state?: string;
}
interface ChapterRow {
  no: number;
  title: string;
  confidence: number;
}
interface ReviewStatus {
  pending: boolean;
  review: {
    chapters: ChapterRow[];
    characters: Cand[];
    foreshadow: Cand[];
    timeline: Cand[];
  } | null;
}

const confidenceColor = (c: number) => (c >= 0.6 ? 'var(--green-jade)' : c >= 0.5 ? 'var(--gold-saffron)' : 'var(--red-vermillion)');

export function ImportReviewPage() {
  const { bookId } = useParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<ReviewStatus | null>(null);
  const [bookName, setBookName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 本地编辑状态
  const [titleEdits, setTitleEdits] = useState<Record<number, string>>({});
  const [dropChapters, setDropChapters] = useState<Set<number>>(new Set());
  const [mergeInto, setMergeInto] = useState<Record<number, number | ''>>({});
  const [splitAt, setSplitAt] = useState<Record<number, string>>({});
  const [charDrop, setCharDrop] = useState<Set<string>>(new Set());
  const [charNotes, setCharNotes] = useState<Record<string, string>>({});
  const [foreDrop, setForeDrop] = useState<Set<string>>(new Set());
  const [tlDrop, setTlDrop] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!bookId) return;
    api
      .getBook(bookId)
      .then((b) => setBookName(b.name))
      .catch(() => {});
    api
      .importReviewStatus(bookId)
      .then((r) => {
        setStatus(r);
        if (r.pending === false && !r.review) setErr('该书当前不在「待校对」状态（已复核或非导入书）。');
      })
      .catch((e) => setErr(e?.message ?? String(e)));
  }, [bookId]);

  const chapters = useMemo(() => status?.review?.chapters ?? [], [status]);
  const lowConf = useMemo(() => chapters.filter((c) => c.confidence < 1).length, [chapters]);

  const toggle = (set: Set<string | number>, v: string | number, cur: Set<string | number>) => {
    const next = new Set(cur);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    return next;
  };

  const submit = useCallback(async () => {
    if (!bookId || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const chapterEdits: any[] = [];
      for (const c of chapters) {
        const item: any = { no: c.no };
        const t = titleEdits[c.no]?.trim();
        if (t) item.title = t;
        if (dropChapters.has(c.no)) item.drop = true;
        const mi = mergeInto[c.no];
        if (mi !== '' && mi !== undefined && mi !== c.no) item.mergeInto = Number(mi);
        const sp = Number(splitAt[c.no] ?? '');
        if (sp > 0) item.splitAt = sp;
        if (item.title || item.drop || item.mergeInto !== undefined || item.splitAt !== undefined) chapterEdits.push(item);
      }
      const r = await api.applyImportReview(bookId, {
        chapters: chapterEdits.length ? chapterEdits : undefined,
        characters: (status?.review?.characters ?? [])
          .filter((c) => charDrop.has(c.name) || charNotes[c.name])
          .map((c) => ({
            name: c.name,
            action: charDrop.has(c.name) ? 'drop' : 'keep',
            note: charNotes[c.name] || undefined,
          })),
        foreshadow: (status?.review?.foreshadow ?? [])
          .filter((f) => foreDrop.has(f.name))
          .map((f) => ({ id: f.name, action: 'drop' as const })),
        timeline: (status?.review?.timeline ?? [])
          .filter((t) => tlDrop.has(t.name))
          .map((t) => ({ id: t.name, action: 'drop' as const })),
        last_committed_chapter: chapters.length ? chapters.length : undefined,
      });
      if (r.ok) navigate(`/novels/${bookId}?module=chapters`, { state: { imported: true } });
    } catch (e: any) {
      setErr(e?.message ?? String(e));
      setBusy(false);
    }
  }, [bookId, busy, chapters, titleEdits, dropChapters, mergeInto, splitAt, charDrop, charNotes, foreDrop, tlDrop, status]);

  const charCands = status?.review?.characters ?? [];
  const foreCands = status?.review?.foreshadow ?? [];
  const tlCands = status?.review?.timeline ?? [];

  const ConfidenceBar = ({ c }: { c: number }) => (
    <span title={'置信度 ' + c}>
      <span
        style={{
          display: 'inline-block', width: 64, height: 6, borderRadius: 3,
          background: 'var(--line)', verticalAlign: 'middle', marginRight: 6,
        }}
      >
        <span
          style={{
            display: 'block', width: `${Math.round(c * 100)}%`, height: 6, borderRadius: 3,
            background: confidenceColor(c),
          }}
        />
      </span>
      <span className="mono" style={{ color: confidenceColor(c), fontSize: 11.5 }}>
        {(c * 100).toFixed(0)}%
      </span>
    </span>
  );

  return (
    <div style={{ maxWidth: 980 }}>
      <h1 className="serif">导入校对 · 《{bookName || '…'}》</h1>
      <p style={{ color: 'var(--ink-2)', fontSize: 13 }}>
        importing-existing.md §3 —— 校对不强制全改：可先认定章节直接续写，之后回头补档；但 <span className="mono">last_committed_chapter</span> 未认定前「正文续写」阶段被锁定（fail-closed）。
      </p>

      {err && <div style={{ color: 'var(--red-vermillion)', margin: '8px 0' }}>⚠️ {err}</div>}
      {!status && !err && <div style={{ color: 'var(--ink-2)' }}>载入中…</div>}

      {status && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '12px 0' }}>
          {[
            ['识别章节', chapters.length, 'var(--ink)'],
            ['低置信章', lowConf, lowConf > 0 ? 'var(--gold-saffron)' : 'var(--green-jade)'],
            ['主要角色', charCands.length, 'var(--ink)'],
            ['伏笔种子', foreCands.length, 'var(--ink)'],
            ['时间线', tlCands.length, 'var(--ink)'],
          ].map(([k, v, color]) => (
            <div key={k as string} className="rail-block" style={{ margin: 0, minWidth: 110 }}>
              <div className="rb-title">{k}</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: color as string }}>{v}</div>
            </div>
          ))}
        </div>
      )}

      {/* 1. 章节分界 */}
      <div className="rail-block">
        <div className="rb-title">① 章节分界（误切/合并/改名）——低置信标黄</div>
        {chapters.length === 0 && <div style={{ color: 'var(--ink-2)', fontSize: 13 }}>正文暂未拆出章节。</div>}
        {chapters.map((c, i) => (
          <div
            key={c.no}
            style={{
              display: 'grid', gridTemplateColumns: '52px 1fr 120px 90px', gap: 8, alignItems: 'center',
              padding: '7px 2px', borderBottom: '1px solid var(--line)', fontSize: 13,
              background: c.confidence < 1 ? 'color-mix(in srgb, var(--gold-saffron) 10%, var(--paper))' : undefined,
            }}
          >
            <span className="mono" style={{ color: 'var(--ink-2)' }}>#{i + 1}</span>
            <div>
              <span style={{ color: 'var(--ink)', fontFamily: 'var(--font-serif)' }}>
                第{c.no}章 {titleEdits[c.no]?.trim() || c.title || '（无题）'}
              </span>{' '}
              <ConfidenceBar c={c.confidence} />
            </div>
            <div style={{ display: 'flex', gap: 5 }}>
              <input
                placeholder="改名"
                value={titleEdits[c.no] ?? ''}
                onChange={(e) => setTitleEdits((m) => ({ ...m, [c.no]: e.target.value }))}
                style={inp}
              />
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <label style={{ fontSize: 12.5 }}>
                <input type="checkbox" checked={dropChapters.has(c.no)} onChange={() => setDropChapters((s) => toggle(s, c.no, s) as Set<number>)} /> 删除
              </label>
              <select value={mergeInto[c.no] ?? ''} onChange={(e) => setMergeInto((m) => ({ ...m, [c.no]: e.target.value === '' ? '' : Number(e.target.value) }))} style={inp2} title="合并到">
                <option value="">并入…</option>
                {chapters.filter((x) => x.no !== c.no).map((x) => (
                  <option key={x.no} value={x.no}>#{x.no}</option>
                ))}
              </select>
            </div>
          </div>
        ))}
        {lowConf > 0 && (
          <div style={{ fontSize: 12.5, color: 'var(--gold-saffron)', marginTop: 6 }}>
            ◈ {lowConf} 章为无锚/低置信拆分，建议把疑似误切的章「并入」前章，或用下方偏移「切分」纠正。
          </div>
        )}
      </div>

      {/* 2. 角色卡 */}
      <div className="rail-block" style={{ marginTop: 12 }}>
        <div className="rb-title">② 角色卡初稿（置信度 &lt;0.5 待校对）——补身份/目标或忽略</div>
        {charCands.length === 0 && <div style={{ color: 'var(--ink-2)', fontSize: 13 }}>未识别到角色候选。</div>}
        {charCands.map((c) => (
          <div key={c.name} style={{ display: 'grid', gridTemplateColumns: '190px 110px 1fr 70px', gap: 8, alignItems: 'center', padding: '7px 2px', borderBottom: '1px solid var(--line)', fontSize: 13 }}>
            <span style={{ fontFamily: 'var(--font-serif)', fontWeight: 600, color: charDrop.has(c.name) ? 'var(--ink-2)' : 'var(--ink)', textDecoration: charDrop.has(c.name) ? 'line-through' : undefined }}>
              {c.name}
            </span>
            <ConfidenceBar c={c.confidence} />
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                placeholder="补身份/目标（留空 = 保持导入初稿）"
                value={charNotes[c.name] ?? ''}
                onChange={(e) => setCharNotes((m) => ({ ...m, [c.name]: e.target.value }))}
                style={{ ...inp, flex: 1 }}
              />
              <span style={{ color: 'var(--ink-2)', fontSize: 11.5 }} title={(c.evidence ?? []).join(', ')}>
                首见：{(c.evidence ?? [])[0] ?? ''}
              </span>
            </div>
            <label style={{ fontSize: 12.5 }}>
              <input type="checkbox" checked={charDrop.has(c.name)} onChange={() => setCharDrop((s) => toggle(s, c.name, s) as Set<string>)} /> 忽略
            </label>
          </div>
        ))}
      </div>

      {/* 3. 伏笔 */}
      <div className="rail-block" style={{ marginTop: 12 }}>
        <div className="rb-title">③ 伏笔种子——标记「误报」或留档待确认</div>
        {foreCands.length === 0 && <div style={{ color: 'var(--ink-2)', fontSize: 13 }}>未识别到伏笔句式。</div>}
        {foreCands.map((f) => (
          <div key={f.name} style={{ display: 'grid', gridTemplateColumns: '46px 1fr 110px 70px', gap: 8, alignItems: 'center', padding: '6px 2px', borderBottom: '1px solid var(--line)', fontSize: 13 }}>
            <span className="mono" style={{ color: 'var(--ink-2)' }}>{f.name}</span>
            <span style={{ color: foreDrop.has(f.name) ? 'var(--ink-2)' : 'var(--ink)', textDecoration: foreDrop.has(f.name) ? 'line-through' : undefined }} title={(f.evidence ?? []).join(', ')}>
              {f.summary || '（摘要空）'}
            </span>
            <ConfidenceBar c={f.confidence} />
            <label style={{ fontSize: 12.5 }}>
              <input type="checkbox" checked={foreDrop.has(f.name)} onChange={() => setForeDrop((s) => toggle(s, f.name, s) as Set<string>)} /> 误报
            </label>
          </div>
        ))}
      </div>

      {/* 4. 时间线 */}
      <div className="rail-block" style={{ marginTop: 12 }}>
        <div className="rb-title">④ 时间线——高置信直接入，低置信列「候选事件」（可误报移除）</div>
        {tlCands.length === 0 && <div style={{ color: 'var(--ink-2)', fontSize: 13 }}>未识别到时间线候选。</div>}
        {tlCands.map((t) => (
          <div key={t.name} style={{ display: 'grid', gridTemplateColumns: '46px 1fr 110px 70px', gap: 8, alignItems: 'center', padding: '6px 2px', borderBottom: '1px solid var(--line)', fontSize: 13 }}>
            <span className="mono" style={{ color: 'var(--ink-2)' }}>{t.name}</span>
            <span style={{ color: tlDrop.has(t.name) ? 'var(--ink-2)' : 'var(--ink)', textDecoration: tlDrop.has(t.name) ? 'line-through' : undefined }}>
              {t.summary || t.state || ''}
            </span>
            <ConfidenceBar c={t.confidence} />
            <label style={{ fontSize: 12.5 }}>
              <input type="checkbox" checked={tlDrop.has(t.name)} onChange={() => setTlDrop((s) => toggle(s, t.name, s) as Set<string>)} /> 误报
            </label>
          </div>
        ))}
      </div>

      {status?.pending && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '16px 0' }}>
          <button className="ink-btn primary" onClick={submit} disabled={busy}>
            {busy ? '校对准…' : '✒ 开始续写（认定 last_committed：至第 ' + chapters.length + ' 章）'}
          </button>
          <span style={{ color: 'var(--ink-2)', fontSize: 12.5 }}>
            提交后锁定解除，进入正文阶段（可先写 {chapters.length + 1} 章，之后再回头补档）。
          </span>
        </div>
      )}
    </div>
  );
}

const inp: any = {
  width: '100%', padding: '3px 6px', fontSize: 12.5, border: '1px solid var(--line)',
  background: 'var(--paper)', color: 'var(--ink)', borderRadius: 3,
};
const inp2: any = {
  ...inp, width: 70, padding: '3px 4px',
};

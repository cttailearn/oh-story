// 单阶段执行器（agents-runtime §2.2 / process §6）：
// 组装 → 生成(Fake/Real) → 写产物 → 门禁 → 状态转移 → SSE
import { mkdirSync, writeFileSync, existsSync, renameSync, readdirSync, copyFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { AiRuntime } from '../ai/runtime.ts';
import type { StageDefinition, ProcessDefinition } from './types.ts';
import {
  ensureStageRows,
  startRun,
  markReview,
  markBlocked,
  updateJobUsage,
} from './state.ts';
import { assembleBundle, type ContextBundle, type PromptBlock } from '../agents/contexts/index.ts';
import { runFakeAgent, runRealAgent } from '../agents/execute.ts';
import { roleFor } from '../agents/roles.ts';
import { getConfig } from '../config/index.ts';
import { buildGateAdapters } from '../gates/registry.ts';
import { runGates, hasBlocking, summarize } from '../gates/runner.ts';
import type { GateReport } from '../gates/types.ts';
import { publishJob } from './sse.ts';
import type { DbHandle } from '../db/index.ts';

export interface StageRunOptions {
  db: DbHandle;
  ai: AiRuntime;
  def: ProcessDefinition;
  bookId: string;
  bookDir: string;
  bookName: string;
  stageId: string;
  fake?: boolean;
  userEdits?: Record<string, string>;
  fixBlocking?: string;
}

export interface StageRunResult {
  jobId: string;
  status: 'review' | 'blocked' | 'error';
  gateBlocking: boolean;
}

/** 进程内后台执行单阶段 */
export async function runStageJob(opts: StageRunOptions): Promise<StageRunResult> {
  const { db, def, bookId, stageId } = opts;
  const stage = def.stages.find((s) => s.id === stageId);
  if (!stage) throw new Error(`stage not found: ${stageId}`);
  ensureStageRows(db.db, bookId, def);

  const started = startRun({ db: db.db, def }, { bookId, stageId });
  const jobId = started.jobId;
  const revision = started.revision;
  if (started.reused) return { jobId, status: 'review', gateBlocking: false };

  publishJob(bookId, jobId, 'job:start', { stage: stageId, revision });
  try {
    return await runAndGate(opts, stage, revision, jobId);
  } catch (e: any) {
    publishJob(bookId, jobId, 'job:error', { code: 'INTERNAL', message: e?.message ?? String(e) });
    markBlocked({ db: db.db, def }, { bookId, stageId, revision, reason: e?.message ?? String(e) });
    db.db
      .prepare(`UPDATE jobs SET status='error', error=?, finished_at=? WHERE id=?`)
      .run(e?.message ?? String(e), new Date().toISOString(), jobId);
    return { jobId, status: 'error', gateBlocking: true };
  }
}

// 实时进程内后台执行
async function runAndGate(
  opts: StageRunOptions,
  stage: StageDefinition,
  revision: number,
  jobId: string,
): Promise<StageRunResult> {
  const { db, ai, def, bookId, bookDir, bookName } = opts;
  if (!opts.fake && !ai.hasAnyChannel()) {
    throw new Error('CHANNEL_UNCONFIGURED: 未配置任何渠道（设置页配置后即可真实生成）');
  }

  // 0) 预算熔断（agents-runtime §5.2）：本阶段已耗 >= stage_max_cents → 拒绝再跑
  const budget = getConfig().budget;
  if (!opts.fake && budget.stage_max_cents > 0) {
    const spent = db.db
      .prepare(`SELECT COALESCE(SUM(cost_cents),0) AS c FROM jobs WHERE book_id=? AND stage_id=?`)
      .get(bookId, stage.id) as { c: number };
    if (spent.c >= budget.stage_max_cents) {
      throw Object.assign(new Error(`BUDGET_EXCEEDED: 本阶段已用 ¥${(spent.c / 100).toFixed(2)} ≥ 上限 ¥${(budget.stage_max_cents / 100).toFixed(2)}（设置页调整）`), { code: 'BUDGET_EXCEEDED' });
    }
  }

  // 1) 组装 Context（含角色线块等，见 process §5）
  const role = roleFor(stage.entry.model_role || 'architect');
  const retryLimit = stage.retry_policy?.limit ?? def.defaults.retry_limit ?? 0;
  let bundle = await assembleBundle({ bookDir, stage: stage.entry, role: role.id, bookTitle: bookName });
  const revBase = opts.stageId === 'deslop' ? snapshotDeslopBase(opts.bookDir) : '';

  // 2) 生成→门禁 内循环（agents-runtime §2.2：有 blocking 且未超限 → 带报告重建重跑 ≤retry_limit）
  let attempts = 0;
  for (;;) {
    attempts++;
    publishJob(bookId, jobId, 'job:progress', { phase: 'generate', percent: 10, attempt: attempts });
    const genOpts = {
      bundle,
      onText: (t: string) => publishJob(bookId, jobId, 'job:progress', { phase: 'stream', text: t.slice(0, 200) }),
    };
    const result = opts.fake
      ? await runFakeAgent({ ...genOpts, model: { channelId: 'fake', modelId: 'fake' } })
      : await runRealAgent(ai, { ...genOpts, model: routeModel(stage.entry.model_role || 'architect') });
    updateJobUsage(db.db, jobId, {
      tokens_in: result.usage.input,
      tokens_out: result.usage.output,
      cost_cents: result.usage.cost_cents,
    });
    publishJob(bookId, jobId, 'job:progress', { phase: 'write-artifact', percent: 40 });

    // 3) 写产物（按 artifact.path 落盘）；deslop 已先存基稿
    const written = writeArtifact(opts, stage, revision, result.text);
    publishJob(bookId, jobId, 'job:progress', { phase: 'gates', percent: 60 });

    const reviewData = stage.id === 'chapter' ? buildReviewData(opts.bookDir, written, bookName) : undefined;
    const pendingTx = stage.gates.some((g) => g.name === 'tracking-commit' && g.on_commit)
      ? readPendingTrackingTx(opts.bookDir)
      : undefined;

    // 4) 门禁（顺序执行，blocking 命中即记，跑完全批再决策）
    const adapters = buildGateAdapters();
    const selected = adapters.filter((a) => stage.gates.some((g) => g.name === a.name));
    const reports = await runGates(
      db.db,
      selected,
      { bookDir, cwd: dirname(bookDir), args: { stage, written, revBase, reviewData, tx: pendingTx } },
      { bookId, stageId: stage.id, revision, jobId },
    );
    for (const r of reports) {
      publishJob(bookId, jobId, 'gate:batch', { gate: r.gate, ok: r.passed, blocking: r.blocking, warnings: r.warnings, attempt: attempts });
    }
    const blocked = hasBlocking(reports);

    // 5a) 全过 → review
    if (!blocked) {
      markReview({ db: db.db, def }, { bookId, stageId: stage.id, revision });
      const latestGates = summarize(reports);
      publishJob(bookId, jobId, 'job:review', {
        stage: stage.id,
        revision,
        attempts,
        latest_gates: latestGates,
        cost: { total_cents: result.usage.cost_cents },
      });
      return { jobId, status: 'review', gateBlocking: false };
    }

    // 5b) 有 blocking → 未超限则带报告重跑一次（重建 Agent、追加修复块）
    const reason = reports
      .filter((r) => r.blocking.length)
      .map((r) => r.gate + ':' + r.blocking.map((b) => b.rule).join(','))
      .join('; ');
    if (attempts >= retryLimit) {
      markBlocked({ db: db.db, def }, { bookId, stageId: stage.id, revision, reason });
      return { jobId, status: 'blocked', gateBlocking: true };
    }
    bundle = withFixBlock(bundle, reports, attempts, retryLimit);
    publishJob(bookId, jobId, 'job:progress', { phase: 'fix-rerun', percent: 75, attempt: attempts, blocking: reason });
  }
}

/** 门禁修复块：把 blocking 明细作为追加指令注入下一轮 Agent（重建，保证任务即上下文纯净） */
function withFixBlock(
  bundle: ContextBundle,
  reports: GateReport[],
  attempt: number,
  retryLimit: number,
): ContextBundle {
  const lines: string[] = [];
  let n = 0;
  for (const r of reports) {
    for (const b of r.blocking) {
      n++;
      lines.push('- [' + r.gate + '] ' + b.rule + '：' + b.evidence);
    }
  }
  const fixBlock: PromptBlock = {
    kind: 'task',
    title: '门禁修复要求（第 ' + attempt + '/' + retryLimit + ' 轮，' + n + ' 条 blocking）',
    text: '以下确定性门禁 blocking 尚未通过。请逐条修复后重新输出完整产物；不改动已确认的事实/编号，不放大无关内容。\n' + lines.join('\n'),
    tokens: lines.join('\n').length + 60,
  };
  const blocks = ([] as PromptBlock[]).concat(bundle.blocks, fixBlock);
  return {
    ...bundle,
    blocks,
    user_message: blocks.map((b) => '## ' + b.title + '\n' + b.text).join('\n\n'),
    budget: { ...bundle.budget, fix: fixBlock.tokens },
  };
}

/** 模型路由：角色 → config.model_routing → channel+model */
function routeModel(roleKey: string): { channelId: string; modelId: string } {
  const cfg = getConfig();
  const r = cfg.model_routing?.[roleKey];
  if (!r) throw new Error(`MODEL_ROUTING_MISSING: role ${roleKey} 未配置（设置页）`);
  return { channelId: r.channel, modelId: r.model };
}

/** 产物写盘（按 artifact.path；file-set 拆多文件：细纲按 ## 第NN章 分文件） */
/** 章节阶段：为 write-review-record 门禁机械生成三查数据（查2 由引擎占位，查1/查3 机械填充） */
function buildReviewData(bookDir: string, written: string[], bookName?: string): string | undefined {
  const chapters = written.filter((w) => /正文[\\/]第\d+章/.test(w));
  if (chapters.length === 0) return undefined;
  const nums = chapters.map((w) => {
    const mm = w.match(/第(\d+)章/);
    return mm && mm[1] ? parseInt(mm[1], 10) : 0;
  });
  const chapter = Math.max(0, ...nums) || 1;
  let lcc = 0;
  let rev = 0;
  try {
    const tp = join(bookDir, '追踪/_tracking-state.json');
    if (existsSync(tp)) {
      const t = JSON.parse(readFileSync(tp, 'utf8')) as { last_committed_chapter?: number; state_revision?: number };
      lcc = t.last_committed_chapter ?? 0;
      rev = t.state_revision ?? 0;
    }
  } catch {
    /* 无追踪状态则按 0 处理 */
  }
  const data = {
    chapter,
    chapter_name: String(bookName ?? '') + '·第' + chapter + '章',
    check1: { last_committed_chapter: lcc, state_revision: rev, ok: true, note: '机械填充（WebUI 引擎）' },
    check2: { items: [
      { item: '本章形如正文章节（自动生成三查记录，查2 由人工/Agent 在 M2 细化）', ok: true, note: '机械填充' },
    ] },
    check3: { ai_blocking: 0, deg_blocking: 0, note: '机械填充（引擎路径）' },
    conclusion: '完成',
  };
  const rel = '.story/review-data/review-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.json';
  const abs = join(bookDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return abs;
}

/** on_commit 通道：若书目录存在 .story/pending-tracking.json（由后续 AI 编辑/登记流程产出），交给 tracking-commit gate 提交 */
function readPendingTrackingTx(bookDir: string): string | undefined {
  try {
    const f = join(bookDir, '.story', 'pending-tracking.json');
    if (!existsSync(f)) return undefined;
    return readFileSync(f, 'utf8');
  } catch {
    return undefined;
  }
}

/** deslop 改写前：把现有 正文/ 章节快照到 .story/rev-base/（revision-duplicate 的原始对照） */
function snapshotDeslopBase(bookDir: string): string {
  const src = join(bookDir, '正文');
  if (!existsSync(src)) return '';
  const dest = join(bookDir, '.story', 'rev-base');
  try {
    mkdirSync(dest, { recursive: true });
    for (const f of readdirSync(src)) {
      if (!f.endsWith('.md')) continue;
      copyFileSync(join(src, f), join(dest, f));
    }
  } catch {
    return '';
  }
  return dest;
}

/** 产物写盘（按 artifact.path；file-set 拆多文件：细纲/正文 按「第N章」标题分文件） */
function writeArtifact(opts: StageRunOptions, stage: StageDefinition, revision: number, text: string): string[] {
  const { bookDir } = opts;
  const art = stage.artifact;
  if (art.kind === 'file-set' && /细纲|第%\d+d章.*\*\.md/.test(art.path)) {
    return writeFileSet(bookDir, art.path, text);
  }
  let rel: string;
  if (art.kind === 'record' || art.kind === 'file') {
    rel = resolveArtifactPath(art.path);
  } else {
    rel = firstResolvable(art.path) ?? `${stage.id}/产物.md`;
  }
  const abs = join(bookDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text.trimEnd() + '\n', 'utf8');
  return [rel];
}

/** 从 artifact 路径提取目标目录（避开 占位/集合/通配 后取最后一个 / 前的目录段） */
function artifactDirOf(spec: string): string {
  let s = spec.replace(/\$\{book\}\/?/, '');
  let marker = -1;
  for (const mark of ['%0', '*', '{']) {
    const i = s.indexOf(mark);
    if (i >= 0 && (marker < 0 || i < marker)) marker = i;
  }
  if (marker > 0) {
    const slash = s.lastIndexOf('/', marker);
    if (slash >= 0) return s.slice(0, slash) || '.story/artifacts';
    return '.story/artifacts';
  }
  const dir = s.split('/').slice(0, -1).join('/');
  return dir || '.story/artifacts';
}

/** 中文/数字大写 转阿拉伯数字（第N章） */
function cnToNum(raw: string): number {
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let total = 0;
  let section = 0;
  for (const ch of raw) {
    if (digits[ch] !== undefined) {
      section = section * 10 + digits[ch]!;
    } else if (ch === '十') {
      section = (section || 1) * 10;
    } else if (ch === '百') {
      section = (section || 1) * 100;
    } else if (ch === '千') {
      section = (section || 1) * 1000;
    } else if (ch === '万') {
      total += (section || 1) * 10000;
      section = 0;
    }
  }
  return total + section;
}

interface ChapterSection {
  num: number;
  title: string;
  body: string;
}

/** 按「第N章 标题」标题行把文本切成单章（兼容 123 与 一/十二/二十三 中文数字与任意层级 #） */
function splitChapters(text: string): ChapterSection[] {
  const lines = text.split(/\r?\n/);
  const headRe = /^#{1,6}\s*第([0-9]+|[零〇一二两三四五六七八九十百千万]+)章\s*(.*)$/;
  const out: ChapterSection[] = [];
  let cur: { num: number; title: string; body: string[] } | null = null;
  for (const line of lines) {
    const m = line.match(headRe);
    if (m) {
      if (cur) out.push({ num: cur.num, title: cur.title, body: cur.body.join('\n') });
      cur = { num: cnToNum(m[1]!), title: (m[2] ?? '').trim(), body: [] };
      continue;
    }
    if (cur) cur.body.push(line);
  }
  if (cur) out.push({ num: cur.num, title: cur.title, body: cur.body.join('\n') });
  return out;
}

/** 文件名安全化（中文标题可直接用，但剔除非法字符） */
function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\r\n]+/g, '').replace(/\.+$/, '').trim();
  return cleaned;
}

/** file-set 拆写：按「第N章」拆单章文件（正文/第NNN章_标题.md 或 大纲/细纲/第NNN章.md）；细纲额外写汇总 大纲/大纲.md */
function writeFileSet(bookDir: string, spec: string, text: string): string[] {
  const written: string[] = [];
  const isOutline = /细纲/.test(spec);
  const dir = isOutline ? '大纲/细纲' : artifactDirOf(spec);
  const chapters = splitChapters(text);

  if (chapters.length > 0) {
    for (const ch of chapters) {
      const num = String(ch.num).padStart(3, '0');
      const title = safeFileName(ch.title);
      const rel = isOutline
        ? `${dir}/第${num}章.md`
        : `${dir}/第${num}章${title ? '_' + title : ''}.md`;
      const abs = join(bookDir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      const heading = `# 第${num}章${ch.title ? ' ' + ch.title : ''}`;
      writeFileSync(abs, heading + '\n' + ch.body.trimEnd() + '\n', 'utf8');
      written.push(rel);
    }
  }

  if (isOutline) {
    // 细纲阶段同时落一份全集到 大纲/大纲.md
    const abs = join(bookDir, '大纲', '大纲.md');
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text.trimEnd() + '\n', 'utf8');
    written.push('大纲/大纲.md');
  }

  if (written.length === 0) {
    // 无分章且无汇总 → 整篇落到第一个可解析路径
    const rel = resolveArtifactPath(spec) || `${dir}/产物.md`;
    const abs = join(bookDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text.trimEnd() + '\n', 'utf8');
    written.push(rel);
  }
  return written;
}

function resolveArtifactPath(spec: string): string {
  // 简单解析 `${book}/...` 占位与 `{a.md, b.md}` 集合
  const min = spec.replace(/\$\{book\}\/?/, '');
  if (min.includes('{') && min.includes('}')) {
    const m = min.match(/^(.*?)\{(.*?)\}(.*)$/);
    if (m) {
      const head = m[1]!;
      const body = m[2]!;
      const tail = m[3] ?? '';
      return `${head}${body.split(',')[0]!.trim()}${tail}`;
    }
  }
  return min;
}

function firstResolvable(spec: string): string | null {
  const main = resolveArtifactPath(spec);
  return main.includes('*') ? null : main;
}

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
  markJobStatus,
  updateJobUsage,
} from './state.ts';
import { assembleBundle, type ContextBundle, type PromptBlock } from '../agents/contexts/index.ts';
import { runFakeAgent, runRealAgent } from '../agents/execute.ts';
import { roleFor } from '../agents/roles.ts';
import { getConfig } from '../config/index.ts';
import { buildGateAdapters, missingGateAdapters, SKILL_SCRIPTS_DIR } from '../gates/registry.ts';
import { runGates, hasBlocking, summarize } from '../gates/runner.ts';
import type { GateReport } from '../gates/types.ts';
import { publishJob } from './sse.ts';
import type { DbHandle } from '../db/index.ts';
import {
  ensureTrackingInitialized,
  writePendingTx,
  readPendingTx,
  clearPendingTx,
  hasTrackingState,
  trackingSummary,
} from './tracking.ts';
import { splitAgentOutput } from './agentOutput.ts';

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
  /** 真实 job 状态：复用既有在途 job 时如实回报 queued/running，不谎报 review */
  status: 'queued' | 'running' | 'review' | 'blocked' | 'error';
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
  if (started.reused) {
    const cur = db.db.prepare(`SELECT status FROM jobs WHERE id=?`).get(jobId) as
      | { status: StageRunResult['status'] }
      | undefined;
    return { jobId, status: cur?.status ?? 'running', gateBlocking: false };
  }
  // job 生命周期：queued → running →（review | error | killed）；缺失这一步会让 jobs 永远挂在 queued
  markJobStatus(db.db, jobId, 'running');

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

  // 0.5) 门禁可用性 fail-closed（修复：声明了却没有适配器 / skills/ 缺失时，阶段曾静默"全过"）
  const adapters = buildGateAdapters();
  const declaredGates = stage.gates.map((g) => g.name);
  const missing = missingGateAdapters(declaredGates);
  const hardMissing = missing.filter((n) => (stage.gates.find((g) => g.name === n)?.blocking ?? true) !== false);
  if (hardMissing.length > 0) {
    throw Object.assign(
      new Error(
        `GATE_UNAVAILABLE: 阶段 ${stage.id} 声明的门禁不可用：${hardMissing.join('、')}` +
          `（技能脚本目录：${SKILL_SCRIPTS_DIR || '未找到 skills/'}）—— 门禁不可用时拒绝放行，请确认仓库完整（skills/ 与 webui/ 同仓发布）`,
      ),
      { code: 'GATE_UNAVAILABLE' },
    );
  }
  if (missing.length > 0) {
    publishJob(bookId, jobId, 'job:progress', { phase: 'gate-missing', percent: 5, missing, soft: true });
  }

  // 0.6) 无 model_role 的阶段 = 确定性阶段（design §226：cover/export 不走文本 agent）
  if (!stage.entry.model_role) {
    return await runDeterministicStage(opts, stage, revision, jobId, adapters);
  }

  // 1) 组装 Context（含角色线块等，见 process §5）
  const role = roleFor(stage.entry.model_role || 'architect');
  const retryLimit = stage.retry_policy?.limit ?? def.defaults.retry_limit ?? 0;
  let bundle = await assembleBundle({ bookDir, stage: stage.entry, role: role.id, bookTitle: bookName });
  const revBase = opts.stageId === 'deslop' ? snapshotDeslopBase(opts.bookDir) : '';
  const hasTrackingGate = stage.gates.some((g) => g.name === 'tracking-commit');
  const hasReviewGate = stage.gates.some((g) => g.name === 'write-review-record');
  const selected = adapters.filter((a) => stage.gates.some((g) => g.name === a.name));

  // 2) 生成→门禁 内循环（agents-runtime §2.2：有 blocking 且未超限 → 带报告重建重跑 ≤retry_limit）
  let attempts = 0;
  for (;;) {
    attempts++;
    publishJob(bookId, jobId, 'job:progress', { phase: 'generate', percent: 10, attempt: attempts });
    const genOpts = {
      bundle,
      onText: (t: string) => publishJob(bookId, jobId, 'job:progress', { phase: 'stream', text: t.slice(0, 200) }),
    };
    const model = opts.fake
      ? { channelId: 'fake', modelId: 'fake' }
      : routeModel(stage.entry.model_role || 'architect');
    if (attempts === 1) {
      // 记录本次运行实际用的渠道/模型：成本面板的 by_model 靠它聚合（原先恒为空）
      db.db
        .prepare(`UPDATE jobs SET detail_json=? WHERE id=?`)
        .run(JSON.stringify({ channel: model.channelId, model: model.modelId, fake: !!opts.fake }), jobId);
    }
    const result = opts.fake
      ? await runFakeAgent({ ...genOpts, model, stageId: stage.id })
      : await runRealAgent(ai, { ...genOpts, model, stageId: stage.id });
    updateJobUsage(db.db, jobId, {
      tokens_in: result.usage.input,
      tokens_out: result.usage.output,
      cost_cents: result.usage.cost_cents,
    });
    publishJob(bookId, jobId, 'job:progress', { phase: 'write-artifact', percent: 40 });

    // 3) 切分 Agent 输出：正文落产物，控制块（追踪事务/三查载荷）单独处理
    //    —— 修复：此前整段（含 JSON）直接写进手稿，且三查由引擎机械伪造
    const out = splitAgentOutput(result.text);
    if (out.stripped > 0) {
      publishJob(bookId, jobId, 'job:progress', { phase: 'control-blocks', percent: 38, stripped: out.stripped });
    }
    const written = writeArtifact(opts, stage, revision, out.body);

    // 3.5) 追踪事务 → skills 契约路径 .story-txn/pending.json；并幂等初始化追踪状态
    let txJson = hasTrackingGate ? readPendingTx(bookDir) : undefined;
    if (hasTrackingGate) {
      if (out.tx) {
        writePendingTx(bookDir, out.tx);
        // 读回落盘内容：writePendingTx 会补齐 expected_state_revision（乐观锁），不能用原对象
        txJson = readPendingTx(bookDir) ?? JSON.stringify(out.tx);
        publishJob(bookId, jobId, 'job:progress', {
          phase: 'tracking-tx',
          percent: 55,
          chapter: (out.tx as any).chapter,
          mode: (out.tx as any).mode,
        });
      } else {
        publishJob(bookId, jobId, 'job:progress', { phase: 'tracking-tx-missing', percent: 55 });
      }
      if (!hasTrackingState(bookDir)) {
        const init = ensureTrackingInitialized({ bookDir, bookTitle: bookName });
        publishJob(bookId, jobId, 'job:progress', { phase: 'tracking-init', percent: 56, ok: init.ok, msg: init.msg });
      }
    }
    publishJob(bookId, jobId, 'job:progress', { phase: 'gates', percent: 60 });

    // 4) 门禁：先跑除 write-review-record 外的全部（三查记录必须在其余门禁全过后才写）
    const preAdapters = selected.filter((a) => a.name !== 'write-review-record');
    const reports = await runGates(
      db.db,
      preAdapters,
      { bookDir, cwd: dirname(bookDir), args: { stage, written, revBase, tx: txJson } },
      { bookId, stageId: stage.id, revision, jobId },
    );
    for (const r of reports) {
      publishJob(bookId, jobId, 'gate:batch', { gate: r.gate, ok: r.passed, blocking: r.blocking, warnings: r.warnings, attempt: attempts });
    }
    const blocked = hasBlocking(reports);

    // 5a) 全过 → 写三查记录（用真实门禁结果）→ review
    if (!blocked) {
      if (hasReviewGate) {
        const reviewAdapter = selected.find((a) => a.name === 'write-review-record');
        if (reviewAdapter) {
          // 三查载荷必须由 Agent 产出（查2/结论）；引擎只用真实状态与门禁结果补 查1/查3
          if (stage.id === 'chapter' && !out.review) {
            const reason3 = 'REVIEW_DATA_MISSING: 产物缺少写章三查载荷（约定 json 控制块 review.check2.items + conclusion）—— 不伪造三查记录';
            markBlocked({ db: db.db, def }, { bookId, stageId: stage.id, revision, reason: reason3 });
            markJobStatus(db.db, jobId, 'error', { error: reason3 });
            publishJob(bookId, jobId, 'job:error', { code: 'REVIEW_DATA_MISSING', message: reason3 });
            return { jobId, status: 'blocked', gateBlocking: true };
          }
          const reviewData = stage.id === 'chapter' ? buildReviewData(bookDir, written, bookName, reports, out.review) : undefined;
          const post = await runGates(
            db.db,
            [reviewAdapter],
            { bookDir, cwd: dirname(bookDir), args: { stage, written, revBase, reviewData } },
            { bookId, stageId: stage.id, revision, jobId },
          );
          for (const r of post) {
            publishJob(bookId, jobId, 'gate:batch', { gate: r.gate, ok: r.passed, blocking: r.blocking, warnings: r.warnings, attempt: attempts });
          }
          reports.push(...post);
          if (hasBlocking(post)) {
            const reason2 = post
              .filter((r) => r.blocking.length)
              .map((r) => r.gate + ':' + r.blocking.map((b) => b.rule).join(','))
              .join('; ');
            markBlocked({ db: db.db, def }, { bookId, stageId: stage.id, revision, reason: reason2 });
            markJobStatus(db.db, jobId, 'error', { error: 'GATE_BLOCKING: ' + reason2 });
            return { jobId, status: 'blocked', gateBlocking: true };
          }
        }
      }
      const tc = reports.find((r) => r.gate === 'tracking-commit');
      if (hasTrackingGate && tc?.passed) clearPendingTx(bookDir);

      markReview({ db: db.db, def }, { bookId, stageId: stage.id, revision });
      markJobStatus(db.db, jobId, 'review');
      const latestGates = summarize(reports);
      publishJob(bookId, jobId, 'job:review', {
        stage: stage.id,
        revision,
        attempts,
        latest_gates: latestGates,
        tracking: hasTrackingGate ? trackingSummary(bookDir) : undefined,
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
      markJobStatus(db.db, jobId, 'error', { error: 'GATE_BLOCKING: ' + reason });
      return { jobId, status: 'blocked', gateBlocking: true };
    }
    bundle = withFixBlock(bundle, reports, attempts, retryLimit);
    publishJob(bookId, jobId, 'job:progress', { phase: 'fix-rerun', percent: 75, attempt: attempts, blocking: reason });
  }
}

/**
 * 确定性阶段（无 model_role）：不调文本 agent，直接落产物 + 跑门禁。
 *   export → 调导出服务（markdown/txt…），产物落 交付/
 *   cover  → 图像生成尚未接入（skills/story-image）时 fail-closed，绝不伪造文本"封面"
 */
async function runDeterministicStage(
  opts: StageRunOptions,
  stage: StageDefinition,
  revision: number,
  jobId: string,
  adapters: ReturnType<typeof buildGateAdapters>,
): Promise<StageRunResult> {
  const { db, def, bookId, bookDir } = opts;
  const selected = adapters.filter((a) => stage.gates.some((g) => g.name === a.name));
  const fail = (reason: string): StageRunResult => {
    markBlocked({ db: db.db, def }, { bookId, stageId: stage.id, revision, reason });
    markJobStatus(db.db, jobId, 'error', { error: reason });
    publishJob(bookId, jobId, 'job:error', { code: 'DETERMINISTIC_STAGE_UNAVAILABLE', message: reason });
    return { jobId, status: 'blocked', gateBlocking: true };
  };

  if (stage.artifact.kind === 'image-set') {
    return fail(
      'IMAGE_GEN_NOT_IMPLEMENTED: 封面/角色图生成尚未接入（skills/story-image）。该阶段不会伪造文本产物；' +
        '请在设置页配置图像渠道，或对该阶段使用「跳过」。',
    );
  }

  let written: string[] = [];
  try {
    const { exportBook } = await import('../export/service.ts');
    const r = exportBook(db.db, { id: bookId, name: opts.bookName, dir: bookDir }, { format: 'markdown' });
    if (!r.ok) return fail('EXPORT_BLOCKED: ' + (r.stats.blocked ?? []).join('；'));
    written = [r.relPath];
    publishJob(bookId, jobId, 'job:progress', { phase: 'write-artifact', percent: 40, files: written });
  } catch (e: any) {
    return fail('EXPORT_FAILED: ' + String(e?.message ?? e));
  }

  const reports = await runGates(
    db.db,
    selected,
    { bookDir, cwd: dirname(bookDir), args: { stage, written, revBase: '' } },
    { bookId, stageId: stage.id, revision, jobId },
  );
  for (const r of reports) {
    publishJob(bookId, jobId, 'gate:batch', { gate: r.gate, ok: r.passed, blocking: r.blocking, warnings: r.warnings, attempt: 1 });
  }
  if (hasBlocking(reports)) {
    const reason = reports
      .filter((r) => r.blocking.length)
      .map((r) => r.gate + ':' + r.blocking.map((b) => b.rule).join(','))
      .join('; ');
    markBlocked({ db: db.db, def }, { bookId, stageId: stage.id, revision, reason });
    markJobStatus(db.db, jobId, 'error', { error: 'GATE_BLOCKING: ' + reason });
    return { jobId, status: 'blocked', gateBlocking: true };
  }
  markReview({ db: db.db, def }, { bookId, stageId: stage.id, revision });
  markJobStatus(db.db, jobId, 'review');
  publishJob(bookId, jobId, 'job:review', { stage: stage.id, revision, attempts: 1, latest_gates: summarize(reports), cost: { total_cents: 0 } });
  return { jobId, status: 'review', gateBlocking: false };
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
/**
 * 章节阶段：组装写章三查数据（skills workflow-chapter §13 / write-review-record.js 契约）
 *   查1：追踪状态（写前）—— 引擎从 追踪/_tracking-state.json + tracking-commit 门禁结果真实读取
 *   查2：细纲兑现差异（写后）—— **由 Agent 产出**（review.check2.items），引擎不代填
 *   查3：禁用词/退化门禁（写后）—— 引擎取本轮 ai-patterns / degeneration 的真实 blocking 数
 * 修复：此前三个查项全部写死 ok:true + conclusion:'完成'，门禁失败也照样写"本章完成"。
 */
function buildReviewData(
  bookDir: string,
  written: string[],
  bookName: string | undefined,
  reports: GateReport[],
  payload: import('./agentOutput.ts').ReviewPayload | null,
): string | undefined {
  const chapters = written.filter((w) => /正文[\\/]第\d+章/.test(w));
  if (chapters.length === 0) return undefined;
  const nums = chapters.map((w) => {
    const mm = w.match(/第(\d+)章/);
    return mm && mm[1] ? parseInt(mm[1], 10) : 0;
  });
  const chapter = payload?.chapter && payload.chapter > 0 ? payload.chapter : Math.max(0, ...nums) || 1;

  const summary = trackingSummary(bookDir);
  const tcReport = reports.find((r) => r.gate === 'tracking-commit');
  const blockingCount = (gate: string): number => {
    const r = reports.find((x) => x.gate === gate);
    return r ? r.blocking.length : 0;
  };
  const aiBlocking = blockingCount('ai-patterns');
  const degBlocking = blockingCount('degeneration');

  const check2Items = payload?.check2.items ?? [];
  const failedCheck2 = check2Items.filter((i) => i.ok === false);
  const conclusion =
    payload?.conclusion?.trim() ||
    (failedCheck2.length === 0 ? '完成' : '未完成（查2 存在未兑现项）');

  const data = {
    chapter,
    chapter_name: payload?.chapter_name ?? String(bookName ?? '') + '·第' + chapter + '章',
    check1: {
      last_committed_chapter: summary.last_committed_chapter,
      state_revision: summary.state_revision,
      ok: tcReport ? tcReport.passed : summary.exists,
      note: tcReport
        ? tcReport.passed
          ? 'tracking-commit ' + (tcReport.detail && (tcReport.detail as any).mode === 'commit' ? '提交通过' : '校验通过')
          : 'tracking-commit 未通过：' + (tcReport.blocking[0]?.evidence ?? '').slice(0, 120)
        : '本轮无 tracking-commit 门禁，按状态文件读取',
    },
    check2: {
      items: check2Items.map((i) => ({ item: i.item, ok: i.ok, note: i.note ?? (i.ok === undefined ? '未自评（人工复核）' : undefined) })),
      note: '查2 由 Agent 产出（引擎不做语义判定）',
    },
    check3: {
      ai_blocking: aiBlocking,
      deg_blocking: degBlocking,
      note: '取自本轮 ai-patterns / degeneration 门禁真实结果',
    },
    conclusion,
  };
  const rel = '.story/review-data/review-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.json';
  const abs = join(bookDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return abs;
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
  if (art.kind === 'file-set') {
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
    if (s[marker] === '{') {
      // file-set 集合：降级目录取 { 前缀（如 设定/{角色/*.md, 角色线/*.md} → 设定）
      return s.slice(0, marker).replace(/\/+$/, '') || '.story/artifacts';
    }
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
/** 文件块头（模型按 file-set 目标路径输出的分块）：### 《设定/角色/陆沉舟.md》 / ### 设定/文风.md / ## `大纲/卷纲/卷一.md` */
export function splitFileBlocks(text: string): Array<{ rel: string; body: string }> {
  const out: Array<{ rel: string; body: string[] }> = [];
  let cur: { rel: string; body: string[] } | null = null;
  const re = /^#{1,6}\s*[`《]?([^《》`\n]+?\.md)[`》]?\s*$/;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(re);
    if (m && looksLikeRel(m[1]!)) {
      if (cur) out.push(cur);
      cur = { rel: cleanRel(m[1]!), body: [] };
      continue;
    }
    if (cur) cur.body.push(line);
  }
  if (cur) out.push(cur!);
  return out.map((b) => ({ rel: b.rel, body: b.body.join('\n') }));
}

/** 相对路径合法性：中文/字母/数字/空格/._-/斜杠；含 /；非 .. 逃逸；非绝对路径 */
function looksLikeRel(p: string): boolean {
  const v = cleanRel(p);
  return (
    /^[\u4e00-\u9fff0-9A-Za-z_ .\\/\-]+$/.test(v) &&
    v.includes('/') &&
    !v.startsWith('/') &&
    !/^\.\.(\/|$)/.test(v) &&
    !/\/\.\.(\/|$)/.test(v)
  );
}

function cleanRel(p: string): string {
  return p.trim().replace(/^`+|`+$/g, '').replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * file-set 拆写（顺序）：
 *  1) 「file-block」分块头《<rel>.md》→ 各自落盘（设定/角色、设定/角色线、大纲/卷纲、大纲/细纲…）
 *  2) 「第N章」标题 → 正文/第NNN章_标题.md 或 大纲/细纲/第NNN章.md（细纲 + 汇总 大纲/大纲.md）
 *  3) 无分块 → 整篇落到第一个可解析路径
 */
function writeFileSet(bookDir: string, spec: string, text: string): string[] {
  const written: string[] = [];
  const isOutline = /细纲|卷纲|大纲/.test(spec);
  const dir = isOutline ? '大纲/细纲' : artifactDirOf(spec);
  const blocks = splitFileBlocks(text);

  if (blocks.length > 0) {
    for (const b of blocks) {
      if (!looksLikeRel(b.rel)) continue;
      const abs = join(bookDir, cleanRel(b.rel));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, b.body.trimStart().replace(/^#+\s*\n/, '').trimEnd() + '\n', 'utf8');
      written.push(cleanRel(b.rel));
    }
    // 大纲类：整篇额外汇总到 大纲/大纲.md（编辑器可直接浏览全套）
    if (isOutline) {
      const abs = join(bookDir, '大纲', '大纲.md');
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text.trimEnd() + '\n', 'utf8');
      written.push('大纲/大纲.md');
    }
    return written;
  }

  // 2) 「第N章」拆分（正文/细纲）
  const chapters = splitChapters(text);
  if (chapters.length > 0) {
    for (const ch of chapters) {
      const num = String(ch.num).padStart(3, '0');
      const title = safeFileName(ch.title);
      const rel = isOutline
        ? `${dir}/第${num}章.md`
        : `${dir}/第${num}章${title ? '_' + title : ''}.md`
      const abs = join(bookDir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      const heading = `# 第${num}章${ch.title ? ' ' + ch.title : ''}`;
      writeFileSync(abs, heading + '\n' + ch.body.trimEnd() + '\n', 'utf8');
      written.push(rel);
    }
    if (isOutline) {
      const abs = join(bookDir, '大纲', '大纲.md');
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text.trimEnd() + '\n', 'utf8');
      written.push('大纲/大纲.md');
    }
    return written;
  }

  // 3) 无分块 → 整篇落到第一个可解析路径
  const rel = firstResolvable(spec) || `${dir}/产物.md`;
  const abs = join(bookDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text.trimEnd() + '\n', 'utf8');
  written.push(rel);
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

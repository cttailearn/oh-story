// 单阶段执行器（agents-runtime §2.2 / process §6）：
// 组装 → 生成(Fake/Real) → 写产物 → 门禁 → 状态转移 → SSE
import { mkdirSync, writeFileSync, existsSync, renameSync } from 'node:fs';
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
import { assembleBundle, type ContextBundle } from '../agents/contexts/index.ts';
import { runFakeAgent, runRealAgent, type AgentResult } from '../agents/execute.ts';
import { roleFor } from '../agents/roles.ts';
import { getConfig } from '../config/index.ts';
import { buildGateAdapters } from '../gates/registry.ts';
import { runGates, hasBlocking, summarize } from '../gates/runner.ts';
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

  // 1) 组装 Context
  const role = roleFor(stage.entry.model_role || 'architect');
  const bundle = await assembleBundle({ bookDir, stage: stage.entry, role: role.id, bookTitle: bookName });

  // 2) 生成
  let result: AgentResult;
  publishJob(bookId, jobId, 'job:progress', { phase: 'generate', percent: 10 });
  if (opts.fake) {
    result = await runFakeAgent({ bundle, model: { channelId: 'fake', modelId: 'fake' }, onText: (t) =>
      publishJob(bookId, jobId, 'job:progress', { phase: 'stream', text: t.slice(0, 200) }) });
  } else {
    const routing = routeModel(stage.entry.model_role || 'architect');
    result = await runRealAgent(ai, { bundle, model: routing, onText: (t) =>
      publishJob(bookId, jobId, 'job:progress', { phase: 'stream', text: t.slice(0, 200) }) });
  }
  updateJobUsage(db.db, jobId, {
    tokens_in: result.usage.input,
    tokens_out: result.usage.output,
    cost_cents: result.usage.cost_cents,
  });
  publishJob(bookId, jobId, 'job:progress', { phase: 'write-artifact', percent: 40 });

  // 3) 写产物（按 artifact.path 落盘 demo 骨架）
  const written = writeArtifact(opts, stage, revision, result.text);
  publishJob(bookId, jobId, 'job:progress', { phase: 'gates', percent: 60 });

  // 4) 门禁
  const adapters = buildGateAdapters();
  const selected = adapters.filter((a) => stage.gates.some((g) => g.name === a.name));
  const reports = await runGates(
    db.db,
    selected,
    { bookDir, cwd: dirname(bookDir), args: { stage, written } },
    { bookId, stageId: stage.id, revision, jobId },
  );
  for (const r of reports) {
    publishJob(bookId, jobId, 'gate:batch', { gate: r.gate, ok: r.passed, blocking: r.blocking, warnings: r.warnings });
  }
  const blocked = hasBlocking(reports);

  // 5) 状态转移 + SSE
  if (blocked) {
    const reason = reports.filter((r) => r.blocking.length).map((r) => `${r.gate}:${r.blocking.map((b) => b.rule).join(',')}`).join('; ');
    markBlocked({ db: db.db, def }, { bookId, stageId: stage.id, revision, reason });
    return { jobId, status: 'blocked', gateBlocking: true };
  }

  markReview({ db: db.db, def }, { bookId, stageId: stage.id, revision });
  const latestGates = summarize(reports);
  publishJob(bookId, jobId, 'job:review', {
    stage: stage.id,
    revision,
    latest_gates: latestGates,
    cost: { total_cents: result.usage.cost_cents },
  });
  return { jobId, status: 'review', gateBlocking: false };
}

/** 模型路由：角色 → config.model_routing → channel+model */
function routeModel(roleKey: string): { channelId: string; modelId: string } {
  const cfg = getConfig();
  const r = cfg.model_routing?.[roleKey];
  if (!r) throw new Error(`MODEL_ROUTING_MISSING: role ${roleKey} 未配置（设置页）`);
  return { channelId: r.channel, modelId: r.model };
}

/** 产物写盘（按 artifact.path；file-set 拆多文件：细纲按 ## 第NN章 分文件） */
function writeArtifact(opts: StageRunOptions, stage: StageDefinition, revision: number, text: string): string[] {
  const { bookDir } = opts;
  const art = stage.artifact;
  if (art.kind === 'file-set' && /细纲|\*\.md/.test(art.path)) {
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

/** file-set 拆写：按 `## 第NNN章` 标题拆成细纲文件；同时写一份汇总到大纲.md */
function writeFileSet(bookDir: string, spec: string, text: string): string[] {
  const written: string[] = [];
  const chapters = text.split(/^##\s*第(\d+)章/m);
  // chapters: [head, num1, body1, num2, body2, ...]
  for (let i = 1; i < chapters.length; i += 2) {
    const num = chapters[i]!;
    const body = chapters[i + 1] ?? '';
    const rel = `大纲/细纲/第${num.padStart(3, '0')}章.md`;
    const abs = join(bookDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `# 第${num.padStart(3, '0')}章${body.trimEnd()}\n`, 'utf8');
    written.push(rel);
  }
  // 同时落一个汇总到 大纲/大纲.md
  const abs = join(bookDir, '大纲', '大纲.md');
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text.trimEnd() + '\n', 'utf8');
  written.push('大纲/大纲.md');
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

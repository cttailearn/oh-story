// 门禁登记表：gate name → adapter。有 TS 内联实现优先内联；否则原 .js spawn 兜底。
import type { GateAdapter, GateOptions, GateReport } from './types.ts';
import { makeSpawnGate, runProcess } from './spawn.ts';
import { existsSync, readdirSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as tc from './impl/tracking-commit.ts';
import * as am from './impl/author-memory-commit.ts';
import { normalizeBookFile } from './impl/normalize-punctuation.ts';
import { writeReviewRecord } from './impl/write-review-record.ts';
import { runDeliveryContract } from './impl/delivery-contract.ts';
import { scanCharacters, readRoleLine } from '../fs/roleLine.ts';
import { getConfig } from '../config/index.ts';
import { join as joinPath } from 'node:path';

/** 原技能包脚本目录（spawn 兜底目标）：从本文件向上找仓库根（含 skills/） */
function findRepoRoot(start: string): string {
  let cur = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(cur, 'skills', 'story-long-write', 'scripts'))) return cur;
    const parent = join(cur, '..');
    if (parent === cur) break;
    cur = parent;
  }
  return '';
}

const repoRoot = findRepoRoot(import.meta.dirname ?? process.cwd());
export const SKILL_SCRIPTS_DIR = existsSync(join(repoRoot, 'skills', 'story-long-write', 'scripts'))
  ? join(repoRoot, 'skills', 'story-long-write', 'scripts')
  : process.env.OH_STORY_SKILLS_DIR ?? '';

const aiPatternsParse = (json: any) => {
  const findings: any[] = Array.isArray(json?.findings) ? json.findings : [];
  const blocking = findings
    .filter((f) => f.severity === 'blocking')
    .map((f) => ({
      rule: f.type,
      level: 'blocking' as const,
      evidence: `${f.message}（${f.excerpt}）`,
      file: f.file,
      line: f.line,
    }));
  const warnings = findings
    .filter((f) => f.severity !== 'blocking')
    .map((f) => ({
      rule: f.type,
      level: 'warning' as const,
      evidence: `${f.message}（${f.excerpt}）`,
      file: f.file,
      line: f.line,
    }));
  return {
    passed: blocking.length === 0,
    blocking,
    warnings,
    value: { findings: findings.length, blocking: blocking.length },
  };
};

function register(name: string, spec: Omit<import('./spawn.ts').SpawnGateSpec, 'name'>): GateAdapter {
  return makeSpawnGate({ name, ...spec });
}

interface GateSpecExt {
  args?: string[];
  min?: number;
  max?: number;
}

/** 从 stage.gates 里取某命名的 GateSpec（含 args/min/max），未知类型安全 */
function gateSpecOf(stage: unknown, name: string): GateSpecExt {
  const gates = (stage as { gates?: Array<Record<string, unknown>> } | undefined)?.gates;
  if (!Array.isArray(gates)) return {};
  const spec = gates.find((g) => g?.name === name);
  if (!spec) return {};
  return {
    args: Array.isArray(spec.args) ? (spec.args as string[]) : undefined,
    min: typeof spec.min === 'number' ? spec.min : undefined,
    max: typeof spec.max === 'number' ? spec.max : undefined,
  };
}

export function buildGateAdapters(): GateAdapter[] {
  const scriptsDir = SKILL_SCRIPTS_DIR;
  const adapters: GateAdapter[] = [];
  if (scriptsDir) {
    adapters.push(
      register('ai-patterns', {
        script: join(scriptsDir, 'check-ai-patterns.js'),
        args: ['--check', '--json', '--fail-on=blocking'],
        parse: aiPatternsParse,
        collectInputs: (opts) => collectChapters(opts.bookDir),
      }),
      register('degeneration', {
        script: join(scriptsDir, 'check-degeneration.js'),
        args: ['--check', '--json', '--fail-on=blocking'],
        collectInputs: (opts) => collectChapters(opts.bookDir),
        parse: aiPatternsParse,
      }),
      register('outline-detail', {
        script: join(scriptsDir, 'check-outline-detail.js'),
        args: ['--check', '--json'],
        collectInputs: (opts) => collectOutlineChapterFiles(opts.bookDir),
        parse: (json: any) => {
          const rows = Array.isArray(json) ? json : [];
          const blocking = [];
          const warnings = [];
          for (const r of rows) {
            if (r?.error) { warnings.push({ rule: 'read-error', level: 'warning' as const, evidence: String(r.file) + ': ' + String(r.error) }); continue; }
            if (r?.thin && Array.isArray(r.missingHard)) {
              for (const fld of r.missingHard) blocking.push({ rule: 'missing-hard-field', level: 'blocking' as const, evidence: String(r.file) + ': 缺硬字段「' + String(fld) + '」', file: String(r.file ?? '') });
            }
            if (Array.isArray(r?.missingSoft)) for (const fld of r.missingSoft) warnings.push({ rule: 'missing-soft-field', level: 'warning' as const, evidence: String(r.file) + ': 按需字段「' + String(fld) + '」', file: String(r.file ?? '') });
            if (Array.isArray(r?.qualityWarnings)) for (const w of r.qualityWarnings) warnings.push({ rule: 'outline-lean', level: 'warning' as const, evidence: String(w), file: String(r.file ?? '') });
            if (Array.isArray(r?.detailWarnings)) for (const w of r.detailWarnings) warnings.push({ rule: 'outline-detail-hint', level: 'warning' as const, evidence: String(w), file: String(r.file ?? '') });
          }
          return {
            passed: blocking.length === 0,
            blocking,
            warnings,
            value: { checked: rows.length },
          };
        },
      }),
      register('chapter-consistency', {
        script: join(scriptsDir, 'check-chapter-consistency.js'),
        dynamicArgs: (opts) => ['--check', '--json', '--project', opts.bookDir],
        collectInputs: (opts) => [],
        parse: (json: any) => {
          const fails = Array.isArray(json?.issues) ? (json.issues as string[]) : [];
          const hints = Array.isArray(json?.hints) ? (json.hints as string[]) : [];
          return {
            passed: fails.length === 0,
            blocking: fails.map((f) => ({ rule: 'chapter-consistency', level: 'blocking' as const, evidence: f })),
            warnings: hints.map((h) => ({ rule: 'timeline-hint', level: 'warning' as const, evidence: h })),
            value: { checked: json?.checked ?? 0, fails: fails.length },
          };
        },
      }),
      register('project-consistency', {
        script: join(scriptsDir, 'check-project-consistency.js'),
        dynamicArgs: (opts) => {
          const spec = gateSpecOf(opts.args?.stage, 'project-consistency');
          const scopeArgs = Array.isArray(spec.args) ? spec.args : [];
          const scopeIdx = scopeArgs.indexOf('--scope');
          const scope = scopeIdx >= 0 && scopeArgs[scopeIdx + 1] ? String(scopeArgs[scopeIdx + 1]) : 'all';
          return ['--check', '--json', '--project', opts.bookDir, '--scope', scope];
        },
        collectInputs: (opts) => [],
        parse: (json: any) => {
          const all: string[] = [];
          if (json && typeof json === 'object') {
            for (const k of Object.keys(json)) {
              if (Array.isArray(json[k])) all.push(...(json[k] as string[]).map(String));
            }
          }
          return {
            passed: all.length === 0,
            blocking: all.map((x) => ({ rule: 'project-consistency', level: 'blocking' as const, evidence: x })),
            warnings: [],
            value: { scopes: json && typeof json === 'object' ? Object.keys(json) : [], fails: all.length },
          };
        },
      }),
      register('normalize-punctuation', {
        script: join(scriptsDir, 'normalize-punctuation.js'),
        args: ['--check'],
        collectInputs: (opts) => collectChapters(opts.bookDir),
      }),
      register('outline-copy', {
        script: join(scriptsDir, 'check-outline-copy.js'),
        args: ['--check', '--json'],
        collectInputs: (opts) => collectChapters(opts.bookDir),
        parse: (json: any) => {
          const rows = Array.isArray(json) ? json : [];
          const findings: Array<{ file: string; text: string }> = [];
          for (const r of rows) {
            if (Array.isArray(r.findings)) {
              for (const f of r.findings) {
                findings.push({ file: String(r.file ?? ''), text: 'L' + String(f.line) + ' 连续 ' + String(f.runLength) + ' 字「' + String(f.fragment) + '」' });
              }
            }
          }
          return {
            passed: findings.length === 0,
            blocking: findings.map((f) => ({ rule: 'outline-copy', level: 'blocking', evidence: f.text, file: f.file })),
            warnings: (rows.filter((r) => r.error)).map((r) => ({ rule: 'read-error', level: 'warning', evidence: String(r.file) + ': ' + String(r.error) })),
            value: { checked: rows.length, blocking: findings.length },
          };
        },
      }),
      register('write-review-record', {
        script: join(scriptsDir, 'write-review-record.js'),
        args: [],
        collectInputs: (opts) => [],
      }),
    );
  }
  // TS 内联优先（M1.6）：有实现就替换同名的 spawn 版
  const inline = buildInlineAdapters();
  for (const a of inline) {
    const idx = adapters.findIndex((x) => x.name === a.name);
    if (idx >= 0) adapters[idx] = a;
    else adapters.push(a);
  }
  return adapters;
}

/** M1.6 TS 内联实现（对拍绿后启用；无对应脚本时也可独立存在） */
export function buildInlineAdapters(): GateAdapter[] {
  return [
    {
      name: 'revision-duplicate',
      async run(opts: GateOptions): Promise<GateReport> {
        const started = Date.now();
        const spec = gateSpecOf(opts.args?.stage, 'revision-duplicate');
        const sArgs = Array.isArray(spec.args) ? spec.args : [];
        const modeIdx = sArgs.indexOf('--mode');
        const mode = (modeIdx >= 0 && sArgs[modeIdx + 1]) ? String(sArgs[modeIdx + 1]) : 'patch';
        const revBase = (opts.args?.revBase as string) || '';
        const written = Array.isArray(opts.args?.written) ? (opts.args.written as string[]) : [];
        if (!revBase || written.length === 0 || !SKILL_SCRIPTS_DIR) {
          return {
            gate: 'revision-duplicate',
            ok: true,
            passed: true,
            blocking: [],
            warnings: [{ rule: 'no-rev-base', level: 'warning', evidence: '缺少改写前基稿（revBase），无法机械校验改写残片；真实流程在改写前会保存基稿' }],
            value: { mode, checked: 0 },
            ran_ms: Date.now() - started,
            job_id: opts.jobId ?? null,
            stage_id: opts.stageId,
            revision: opts.revision ?? null,
          };
        }
        const script = join(SKILL_SCRIPTS_DIR, 'check-revision-duplicate.js');
        const blocking: Array<{ rule: string; level: 'blocking'; evidence: string; file?: string }> = [];
        const warnings: Array<{ rule: string; level: 'warning'; evidence: string; file?: string }> = [];
        let checked = 0;
        for (const w of written) {
          const base = String(w).split(/[\\/]/).pop() ?? String(w);
          const orig = join(revBase, base);
          if (!existsSync(orig)) continue;
          checked++;
          try {
            const res = await runProcess(process.execPath, [script, '--check', '--json', '--original', orig, '--revised', w, '--mode', mode], { cwd: opts.cwd, timeoutMs: 30000 });
            let json: any = null;
            try { json = JSON.parse(res.stdout); } catch { /* ignore */ }
            if (json) {
              if (Array.isArray(json.blocking)) {
                for (const b of json.blocking) blocking.push({ rule: String(b?.rule ?? 'rev-copy'), level: 'blocking', evidence: String(b?.evidence ?? ''), file: base });
              }
              if (Array.isArray(json.warnings)) {
                for (const ww of json.warnings) warnings.push({ rule: String(ww?.rule ?? 'rev-hint'), level: 'warning', evidence: String(ww?.evidence ?? ''), file: base });
              }
            } else if (res.code === 2) {
              warnings.push({ rule: 'rev-check-error', level: 'warning', evidence: (res.stderr || res.stdout).slice(0, 200) });
            }
          } catch (e) {
            warnings.push({ rule: 'rev-check-crash', level: 'warning', evidence: String((e as Error)?.message ?? e).slice(0, 200) });
          }
        }
        if (checked === 0) {
          warnings.push({ rule: 'no-pair-matched', level: 'warning', evidence: '未找到与基稿匹配的改写文件，跳过机械校验' });
        }
        return {
          gate: 'revision-duplicate',
          ok: blocking.length === 0,
          passed: blocking.length === 0,
          blocking,
          warnings,
          value: { mode, checked },
          ran_ms: Date.now() - started,
          job_id: opts.jobId ?? null,
          stage_id: opts.stageId,
          revision: opts.revision ?? null,
        };
      },
    },
    {
      name: 'char-count',
      async run(opts: GateOptions): Promise<GateReport> {
        const started = Date.now();
        const files = collectChapters(opts.bookDir);
        const spec = gateSpecOf(opts.args?.stage, 'char-count');
        const min = typeof spec.min === 'number' ? spec.min : 1800;
        const counts = files.map((f) => ({ file: f, chars: countProseChars(f) }));
        const under = counts.filter((cc) => cc.chars < min);
        const total = counts.reduce((s, cc) => s + cc.chars, 0);
        return {
          gate: 'char-count',
          ok: under.length === 0,
          passed: under.length === 0,
          blocking: under.map((cc) => ({ rule: 'char-count-too-short', level: 'blocking', evidence: cc.file.split(/[\\/]/).pop() + ': ' + cc.chars + ' 字 < ' + min + ' 字达标' })),
          warnings: [],
          value: { min, files: counts.length, under: under.length, total },
          detail: { counts },
          ran_ms: Date.now() - started,
          job_id: opts.jobId ?? null,
          stage_id: opts.stageId,
          revision: opts.revision ?? null,
        };
      },
    },
    {
      name: 'normalize-punctuation',
      async run(opts: GateOptions): Promise<GateReport> {
        const started = Date.now();
        const files = collectChapters(opts.bookDir);
        const failures: string[] = [];
        let rewritten = 0;
        for (const f of files) {
          try {
            const rel = f.split(/[\\/]/).slice(-2).join('/');
            const r = normalizeBookFile(opts.bookDir, rel);
            rewritten += r.rewritten;
          } catch (e: any) {
            failures.push(`${f}: ${e.message}`);
          }
        }
        return {
          gate: 'normalize-punctuation',
          ok: failures.length === 0,
          passed: failures.length === 0,
          blocking: failures.map((m) => ({ rule: 'write-failed', level: 'blocking' as const, evidence: m })),
          warnings: [],
          value: { rewritten, checked: files.length },
          detail: { atomic: true, rewritten, checked: files.length },
          ran_ms: Date.now() - started,
          job_id: opts.jobId ?? null,
          stage_id: opts.stageId,
          revision: opts.revision ?? null,
        };
      },
    },
    {
      name: 'write-review-record',
      async run(opts: GateOptions): Promise<GateReport> {
        const started = Date.now();
        // data 来自阶段产物（三查 JSON），M1.7 由 stageRunner 提供 args.data
        const args = (opts.args ?? {}) as { data?: string; reviewData?: string };
        const dataRel = args.reviewData ?? args.data;
        if (!dataRel) {
          return {
            gate: 'write-review-record',
            ok: true,
            passed: true,
            blocking: [],
            warnings: [{ rule: 'no-data', level: 'warning', evidence: '未提供 review.json，记录生成跳过' }],
            ran_ms: Date.now() - started,
            job_id: opts.jobId ?? null,
            stage_id: opts.stageId,
            revision: opts.revision ?? null,
          };
        }
        try {
          const r = await writeReviewRecord(['--project', opts.bookDir, '--data', dataRel], opts.cwd);
          return {
            gate: 'write-review-record',
            ok: true,
            passed: true,
            blocking: [],
            warnings: [],
            value: { token: r.token },
            detail: { file: r.file, linked: r.linked },
            ran_ms: Date.now() - started,
            job_id: opts.jobId ?? null,
            stage_id: opts.stageId,
            revision: opts.revision ?? null,
          };
        } catch (e: any) {
          return {
            gate: 'write-review-record',
            ok: false,
            passed: false,
            blocking: [{ rule: 'record-failed', level: 'blocking', evidence: e?.message ?? String(e) }],
            warnings: [],
            ran_ms: Date.now() - started,
            job_id: opts.jobId ?? null,
            stage_id: opts.stageId,
            revision: opts.revision ?? null,
          };
        }
      },
    },
    {
      name: 'tracking-commit',
      async run(opts: GateOptions): Promise<GateReport> {
        const started = Date.now();
        // tracking-commit: on_commit 时由 stageRunner 提供 pending 事务；否则仅 check
        const args = (opts.args ?? {}) as { tx?: string; onCommit?: boolean };
        try {
          let stdout: string;
          let code: number;
          if (args.tx) {
            const tmp = join(opts.bookDir, '.story-txn', `pending-${Date.now()}.json`);
            mkdirSync(join(opts.bookDir, '.story-txn'), { recursive: true });
            writeFileSync(tmp, args.tx, 'utf8');
            const r = await tc.runTrackingCommit(['commit', '--project', opts.bookDir, '--input', tmp], opts.cwd);
            code = r.code;
            stdout = r.stdout;
            try {
              unlinkSync(tmp);
            } catch {
              /* ignore */
            }
          } else {
            const r = await tc.runTrackingCommit(['check', '--project', opts.bookDir], opts.cwd);
            code = r.code;
            stdout = r.stdout;
          }
          const parsed = safeParseJson(stdout);
          const last = parsed?.last_committed_chapter ?? parsed?.commit?.last_committed_chapter ?? null;
          const rev = parsed?.state_revision ?? parsed?.commit?.state_revision ?? null;
          return {
            gate: 'tracking-commit',
            ok: code === 0,
            passed: code === 0,
            blocking: code === 0
              ? []
              : [{ rule: 'tracking-failed', level: 'blocking' as const, evidence: stdout.slice(0, 300) || 'check failed' }],
            warnings: [],
            value: { last_committed_chapter: last, state_revision: rev },
            detail: { commit: { last_committed_chapter: last, state_revision: rev }, mode: args.onCommit ? 'commit' : 'check' },
            ran_ms: Date.now() - started,
            job_id: opts.jobId ?? null,
            stage_id: opts.stageId,
            revision: opts.revision ?? null,
          };
        } catch (e: any) {
          return {
            gate: 'tracking-commit',
            ok: false,
            passed: false,
            blocking: [{ rule: 'tracking-crash', level: 'blocking', evidence: e?.message ?? String(e) }],
            warnings: [],
            ran_ms: Date.now() - started,
            job_id: opts.jobId ?? null,
            stage_id: opts.stageId,
            revision: opts.revision ?? null,
          };
        }
      },
    },
    {
      // delivery-contract：形态感知（短篇走 skills 契约 + 节数守恒；长篇走确定性交付校验）
      name: 'delivery-contract',
      async run(opts: GateOptions): Promise<GateReport> {
        const spec = gateSpecOf(opts.args?.stage, 'delivery-contract') as { min?: number; max?: number; sections?: number };
        return runDeliveryContract(opts, {
          script: join(SKILL_SCRIPTS_DIR, 'check-delivery-contract.js'),
          min: spec.min,
          max: spec.max,
          sections: typeof spec.sections === 'number' ? spec.sections : undefined,
        });
      },
    },
    {
      // imagegen-env：封面/角色图的生成环境自检（skills/story-image check-imagegen-env.sh 的 WebUI 等价物）
      // 非阻塞（定义里 blocking:false），但必须真的跑，而不是"声明了却没有适配器"被静默跳过。
      name: 'imagegen-env',
      async run(opts: GateOptions): Promise<GateReport> {
        const started = Date.now();
        const cfg = getConfig();
        const imageModels = cfg.channels
          .filter((c) => c.enabled !== false)
          .flatMap((c) => c.image_models ?? []);
        const hasCover = existsSync(joinPath(opts.bookDir, '封面'));
        const warnings: GateReport['warnings'] = [];
        if (!hasCover) {
          warnings.push({
            rule: 'no-cover-dir',
            level: 'warning',
            evidence: '本书尚无 封面/ 目录（cover 阶段未产出图片）',
          });
        }
        if (imageModels.length === 0) {
          warnings.push({
            rule: 'no-image-channel',
            level: 'warning',
            evidence: '未配置图像模型（设置页 → 渠道「获取模型」勾选图像模型后写入 image_models），cover 阶段无法生成封面/角色图',
          });
        }
        return {
          gate: 'imagegen-env',
          ok: warnings.length === 0,
          passed: warnings.length === 0,
          blocking: [],
          warnings,
          value: { image_models: imageModels.length, has_cover_dir: hasCover },
          ran_ms: Date.now() - started,
          job_id: opts.jobId ?? null,
          stage_id: opts.stageId,
          revision: opts.revision ?? null,
        };
      },
    },
    {
      // role-line-consistency：角色线阶段编号连续性 + 卡/线一致性（skills character-card-line §5）
      name: 'role-line-consistency',
      async run(opts: GateOptions): Promise<GateReport> {
        const started = Date.now();
        const blocking: GateReport['blocking'] = [];
        const warnings: GateReport['warnings'] = [];
        let checked = 0;
        for (const c of scanCharacters(opts.bookDir)) {
          if (!c.lineExists) {
            warnings.push({ rule: 'no-role-line', level: 'warning', evidence: `${c.name}：有角色卡但无角色线文件（${c.lineRel ?? '设定/角色线/*.md'}）` });
            continue;
          }
          checked++;
          const r = readRoleLine(opts.bookDir, c.name);
          if (!r.line || r.line.stages.length === 0) {
            warnings.push({ rule: 'empty-role-line', level: 'warning', evidence: `${c.name}：角色线文件无阶段小节` });
            continue;
          }
          const nos = r.line.stages.map((s) => s.no).sort((a, b) => a - b);
          for (let i = 0; i < nos.length; i++) {
            if (nos[i] !== i + 1) {
              blocking.push({
                rule: 'role-line-stage-sequence',
                level: 'blocking',
                evidence: `${c.name}：角色线阶段编号不连续（实际 ${nos.join(',')}，应 1..${Math.max(...nos)}）`,
              });
              break;
            }
          }
          if (new Set(nos).size !== nos.length) {
            blocking.push({ rule: 'role-line-stage-duplicate', level: 'blocking', evidence: `${c.name}：角色线阶段编号重复` });
          }
          const active = r.line.stages.filter((s) => s.status === 'active');
          if (active.length > 1) {
            blocking.push({ rule: 'role-line-multi-active', level: 'blocking', evidence: `${c.name}：同时有 ${active.length} 个 active 阶段（阶段 ${active.map((s) => s.no).join(',')}）` });
          }
        }
        return {
          gate: 'role-line-consistency',
          ok: blocking.length === 0,
          passed: blocking.length === 0,
          blocking,
          warnings,
          value: { checked },
          ran_ms: Date.now() - started,
          job_id: opts.jobId ?? null,
          stage_id: opts.stageId,
          revision: opts.revision ?? null,
        };
      },
    },
    {
      // author-memory：作者记忆状态完整性校验（skills/author_memory_commit.py check 的 TS 移植版）
      name: 'author-memory',
      async run(opts: GateOptions): Promise<GateReport> {
        const started = Date.now();
        const workspace = opts.cwd || opts.bookDir;
        const stateFile = am.memoryStatePath(workspace);
        if (!existsSync(stateFile)) {
          return {
            gate: 'author-memory',
            ok: true,
            passed: true,
            blocking: [],
            warnings: [{ rule: 'no-memory', level: 'warning', evidence: '工作区尚无 .story/作者记忆/_author-memory-state.json（未启用作者记忆）' }],
            value: { initialized: false },
            ran_ms: Date.now() - started,
            job_id: opts.jobId ?? null,
            stage_id: opts.stageId,
            revision: opts.revision ?? null,
          };
        }
        try {
          const r = am.commandCheck(workspace) as Record<string, unknown>;
          return {
            gate: 'author-memory',
            ok: true,
            passed: true,
            blocking: [],
            warnings: [],
            value: { initialized: true, ...r },
            ran_ms: Date.now() - started,
            job_id: opts.jobId ?? null,
            stage_id: opts.stageId,
            revision: opts.revision ?? null,
          };
        } catch (e: any) {
          return {
            gate: 'author-memory',
            ok: false,
            passed: false,
            blocking: [{ rule: 'author-memory-check', level: 'blocking', evidence: String(e?.message ?? e).slice(0, 300) }],
            warnings: [],
            value: { initialized: true },
            ran_ms: Date.now() - started,
            job_id: opts.jobId ?? null,
            stage_id: opts.stageId,
            revision: opts.revision ?? null,
          };
        }
      },
    },
  ];
}

/** 定义里声明但当前环境不可用的门禁（调用方必须 fail-closed，不得静默跳过） */
export function missingGateAdapters(declared: string[]): string[] {
  const have = new Set(buildGateAdapters().map((a) => a.name));
  return [...new Set(declared)].filter((n) => !have.has(n));
}

function safeParseJson(s: string): any {
  try {
    const first = s.trim();
    const start = first.indexOf('{');
    if (start < 0) return null;
    return JSON.parse(first.slice(start));
  } catch {
    return null;
  }
}

function countProseChars(file: string): number {
  let text = '';
  try {
    text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return 0;
  }
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join('')
    .replace(/\s/g, '').length;
}

function collectChapters(bookDir: string): string[] {
  const dir = join(bookDir, '正文');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f: string) => f.endsWith('.md') && /^第\d+章/.test(f))
    .map((f: string) => join(dir, f));
}

function collectOutlineChapterFiles(bookDir: string): string[] {
  const base = join(bookDir, '大纲');
  const out: string[] = [];
  for (const sub of ['细纲']) {
    const dir = join(base, sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.md')) out.push(join(dir, f));
    }
  }
  return out;
}

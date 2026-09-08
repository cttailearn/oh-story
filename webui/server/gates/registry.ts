// 门禁登记表：gate name → adapter。有 TS 内联实现优先内联；否则原 .js spawn 兜底。
import type { GateAdapter, GateOptions, GateReport } from './types.ts';
import { makeSpawnGate } from './spawn.ts';
import { existsSync, readdirSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import * as tc from './impl/tracking-commit.ts';
import { normalizeBookFile } from './impl/normalize-punctuation.ts';
import { writeReviewRecord } from './impl/write-review-record.ts';

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
      }),
      register('outline-detail', {
        script: join(scriptsDir, 'check-outline-detail.js'),
        args: ['--check', '--json', '--fail-on=blocking'],
        collectInputs: (opts) => collectOutlineChapterFiles(opts.bookDir),
      }),
      register('normalize-punctuation', {
        script: join(scriptsDir, 'normalize-punctuation.js'),
        args: ['--check'],
        collectInputs: (opts) => collectChapters(opts.bookDir),
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
        const args = (opts.args ?? {}) as { data?: string };
        const dataRel = args.data;
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
  ];
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

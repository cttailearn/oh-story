// 门禁登记表：gate name → adapter。M0 先全部走「原 .js spawn 兜底」；
// M1 起逐个替换为内联 TS 实现（见 impl/，对拍绿后才切换）。
import type { GateAdapter } from './types.ts';
import { makeSpawnGate } from './spawn.ts';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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
    );
  }
  return adapters;
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

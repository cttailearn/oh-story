// 原 .js 门禁脚本 spawn 兜底（standalone-webui §7.2：移植完成前用子进程跑原脚本）
import { spawn } from 'node:child_process';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { GateAdapter, GateOptions, GateReport } from './types.ts';

export interface SpawnGateSpec {
  name: string;
  /** 脚本绝对路径 */
  script: string;
  /** 默认 CLI 参数 */
  args?: string[];
  /** 动态 CLI 参数：按 opts（bookDir/stage args）生成，优先于静态 args */
  dynamicArgs?: (opts: GateOptions) => string[];
  /** 是否为 .js 脚本（node 运行） */
  kind?: 'node' | 'python';
  /** 解析 stdout JSON 为 GateReport 的钩子 */
  parse?: (json: any) => Pick<GateReport, 'passed' | 'blocking' | 'warnings' | 'value'> &
    Partial<Pick<GateReport, 'detail'>>;
  /** 输入文件的来源：bookDir 下哪些文件 */
  collectInputs?: (opts: GateOptions) => string[];
}

export function runProcess(cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      windowsHide: true,
      shell: false,
    });
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`gate spawn timeout (>${opts.timeoutMs}ms)`));
    }, opts.timeoutMs);
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr });
    });
  });
}

export const EXIT_CODES = {
  clean: 0,
  findings: 1,
  error: 2,
};

export function makeSpawnGate(spec: SpawnGateSpec): GateAdapter {
  return {
    name: spec.name,
    async run(opts: GateOptions): Promise<GateReport> {
      const started = Date.now();
      const inputs = spec.collectInputs ? spec.collectInputs(opts) : [];
      const cmd = spec.kind === 'python' ? 'python' : process.execPath;
      const args = [spec.script, ...(spec.dynamicArgs ? spec.dynamicArgs(opts) : spec.args ?? []), ...inputs];
      const res = await runProcess(cmd, args, {
        cwd: opts.cwd,
        timeoutMs: 60000,
      });
      const ran_ms = Date.now() - started;

      let json: any = null;
      if (spec.parse) {
        try {
          json = JSON.parse(res.stdout);
        } catch {
          /* not json */
        }
      }
      const fallback: GateReport = {
        gate: spec.name,
        ok: res.code !== EXIT_CODES.error,
        passed: res.code === EXIT_CODES.clean,
        blocking: [],
        warnings: [],
        detail: {
          exit: res.code,
          stdout: res.stdout.slice(0, 1200),
          stderr: res.stderr.slice(0, 800),
        },
        ran_ms,
        job_id: opts.jobId ?? null,
        stage_id: opts.stageId,
        revision: opts.revision ?? null,
      };
      if (spec.parse && json) {
        const p = spec.parse(json);
        return {
          ...fallback,
          ...p,
          gate: spec.name,
          ok: p.passed,
          passed: p.passed,
          ran_ms,
          job_id: opts.jobId ?? null,
          stage_id: opts.stageId,
          revision: opts.revision ?? null,
        };
      }
      return fallback;
    },
  };
}

/** 收集书目录下的正文 md 文件 */
export function collectBookChapters(opts: GateOptions): string[] {
  const dir = join(opts.bookDir, '正文');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f: string) => f.endsWith('.md'))
    .map((f: string) => join(dir, f))
    .filter((f: string) => statSync(f).isFile());
}

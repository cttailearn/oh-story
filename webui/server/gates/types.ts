// 门禁类型约定（standalone-webui §7.1）
export type GateSeverity = 'blocking' | 'warning';

export interface GateFinding {
  rule: string;
  level: GateSeverity;
  evidence: string;
  file?: string;
  line?: number;
  detail?: unknown;
  meta?: Record<string, unknown>;
}

export interface GateReport {
  gate: string;
  ok: boolean;
  passed: boolean;
  blocking: GateFinding[];
  warnings: GateFinding[];
  detail?: unknown;
  value?: unknown;
  ran_ms: number;
  job_id?: string | null;
  stage_id?: string;
  revision?: number | null;
}

export interface GateOptions {
  /** 书目录绝对路径 */
  bookDir: string;
  stageId?: string;
  revision?: number | null;
  jobId?: string | null;
  cwd: string;
  /** 附加参数（每 gate 自解释） */
  args?: Record<string, unknown>;
}

export interface GateAdapter {
  name: string;
  run(opts: GateOptions): Promise<GateReport>;
}

export type { GateSeverity as GateLevel };

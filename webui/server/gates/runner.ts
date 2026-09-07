// 门禁执行器：按 GateAdapter 顺序执行，落库 gate_runs，输出聚合报告（standalone-webui §7.1/§7.3）
import type { Database } from 'better-sqlite3';
import type { GateAdapter, GateOptions, GateReport } from './types.ts';

export interface GateRunResult {
  report: GateReport;
}

/**
 * 顺序执行 gates，全部落库。
 * 返回每个 gate 的报告。blocking 命中即阶段 blocked（由引擎层决策，此处仅产出）。
 */
export async function runGates(
  db: Database,
  adapters: GateAdapter[],
  opts: GateOptions,
  meta: { bookId: string; stageId: string; revision: number | null; jobId?: string | null },
): Promise<GateReport[]> {
  const reports: GateReport[] = [];
  for (const adapter of adapters) {
    const started = Date.now();
    let report: GateReport;
    try {
      report = await adapter.run({
        ...opts,
        stageId: meta.stageId,
        revision: meta.revision,
        jobId: meta.jobId ?? null,
      });
    } catch (e: any) {
      report = {
        gate: adapter.name,
        ok: false,
        passed: false,
        blocking: [
          {
            rule: 'gate-crash',
            level: 'blocking',
            evidence: String(e?.message ?? e),
          },
        ],
        warnings: [],
        ran_ms: Date.now() - started,
        stage_id: meta.stageId,
        revision: meta.revision,
        job_id: meta.jobId ?? null,
      };
    }
    // 落库
    db.prepare(
      `INSERT INTO gate_runs (book_id, stage_id, revision, job_id, gate, ok, blocking_json, warnings_json, detail_json, ran_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      meta.bookId,
      meta.stageId,
      meta.revision ?? 0,
      report.job_id ?? null,
      report.gate,
      report.passed ? 1 : 0,
      JSON.stringify(report.blocking),
      JSON.stringify(report.warnings),
      report.detail !== undefined ? JSON.stringify(report.detail) : null,
      report.ran_ms,
      new Date().toISOString(),
    );
    reports.push(report);
    // blocking 命中：按 fail-fast 语义短路后续 gates？§7.3 说任一 blocking 命中即 blocked。
    // 但为保留报告完整性，默认仍跑完全部 gates（由 opts.args?.failFast 控制）。
    if ((opts.args?.failFast as boolean) && !report.passed) break;
  }
  return reports;
}

/** 聚合判断：是否有 blocking */
export function hasBlocking(reports: GateReport[]): boolean {
  return reports.some((r) => r.blocking.length > 0);
}

/** 聚合成 api-contract §3.5 的 latest_gates 形态 */
export function summarize(reports: GateReport[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of reports) {
    out[r.gate] = {
      ok: r.passed,
      blocking: r.blocking,
      warnings: r.warnings,
      value: r.value ?? null,
      detail: r.detail ?? null,
      ran_ms: r.ran_ms,
    };
  }
  return out;
}

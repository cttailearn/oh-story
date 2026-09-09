// delivery-contract 门禁（形态感知）：
//   短篇（存在 正文.md）→ 调 skills 的 check-delivery-contract.js，节数取 小节大纲.md 的规划节数（节数守恒）
//   长篇（存在 正文/第N章*.md）→ 用导出服务的确定性校验（章节编号连续 + 非空），skills 的短篇契约不适用于长篇
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runProcess } from '../spawn.ts';
import type { GateOptions, GateReport } from '../types.ts';
import { plannedSectionsOf } from './plannedSections.ts';
import { collectChapters, verifyDelivery } from '../../export/service.ts';

export interface DeliveryContractSpec {
  script: string;
  min?: number;
  max?: number;
  /** 显式指定节数（优先级最高，便于测试/特殊项目） */
  sections?: number;
}

export async function runDeliveryContract(opts: GateOptions, spec: DeliveryContractSpec): Promise<GateReport> {
  const started = Date.now();
  const base = {
    gate: 'delivery-contract',
    ran_ms: 0,
    job_id: opts.jobId ?? null,
    stage_id: opts.stageId,
    revision: opts.revision ?? null,
  };
  const done = (
    r: Omit<GateReport, 'ran_ms' | 'job_id' | 'stage_id' | 'revision' | 'gate'>,
  ): GateReport => ({
    ...base,
    ...r,
    ran_ms: Date.now() - started,
  });

  const shortForm = existsSync(join(opts.bookDir, '正文.md'));
  if (!shortForm) {
    // 长篇交付：确定性校验（与导出服务同一口径，避免用短篇契约误判长篇）
    const chapters = collectChapters(opts.bookDir);
    const r = verifyDelivery(chapters);
    return done({
      ok: r.ok,
      passed: r.ok,
      blocking: r.blocking.map((b) => ({ rule: 'delivery-contract', level: 'blocking' as const, evidence: b })),
      warnings: r.warnings.map((w) => ({ rule: 'delivery-hint', level: 'warning' as const, evidence: w })),
      value: { shape: 'long', chapters: chapters.length },
      detail: { shape: 'long', chapters: chapters.length },
    });
  }

  // 短篇：节数守恒（正文节数 === 小节大纲规划节数）
  const planned = spec.sections ?? plannedSectionsOf(opts.bookDir).count;
  if (!planned || planned <= 0) {
    const reason = spec.sections ? 'sections 参数非法' : (plannedSectionsOf(opts.bookDir).reason ?? '无法确定规划节数');
    return done({
      ok: false,
      passed: false,
      blocking: [
        {
          rule: 'delivery-section-plan',
          level: 'blocking',
          evidence: reason + '；无法校验「节数守恒」（正文节数必须等于小节大纲规划节数），先补齐小节大纲再交付',
        },
      ],
      warnings: [],
      value: { shape: 'short', planned_sections: null },
    });
  }
  const min = typeof spec.min === 'number' ? spec.min : 500;
  const max = typeof spec.max === 'number' ? spec.max : 20000;
  const res = await runProcess(
    process.execPath,
    [spec.script, '--json', '--min-chars', String(min), '--max-chars', String(max), '--sections', String(planned), opts.bookDir],
    { cwd: opts.cwd, timeoutMs: 30000 },
  );
  let json: any = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    /* 非 JSON */
  }
  if (!json) {
    return done({
      ok: false,
      passed: false,
      blocking: [
        {
          rule: 'delivery-contract-crash',
          level: 'blocking',
          evidence: `check-delivery-contract 未返回 JSON（exit=${res.code}）：${(res.stderr || res.stdout).slice(0, 200)}`,
        },
      ],
      warnings: [],
      value: { shape: 'short', planned_sections: planned },
    });
  }
  const checks: any[] = Array.isArray(json.checks) ? json.checks : [];
  const failed = checks.filter((c) => c.ok === false);
  const hints = checks.filter((c) => c.ok === true && c.hint);
  const sectionCheck = checks.find((c) => c.id === 'delivery.section-count');
  return done({
    ok: !!json.ok && failed.length === 0,
    passed: !!json.ok && failed.length === 0,
    blocking: failed.map((c) => ({
      rule: String(c.id ?? 'delivery-contract'),
      level: 'blocking' as const,
      evidence: String(c.evidence ?? c.repair ?? ''),
    })),
    warnings: hints.map((c) => ({ rule: String(c.id ?? 'delivery-hint'), level: 'warning' as const, evidence: String(c.hint ?? c.evidence ?? '') })),
    value: {
      shape: 'short',
      planned_sections: planned,
      char_count: json.char_count ?? json.chars ?? null,
      section_evidence: sectionCheck?.evidence ?? null,
    },
    detail: { checks },
  });
}

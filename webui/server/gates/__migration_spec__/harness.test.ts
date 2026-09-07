// migration harness 骨架（standalone-webui §7.4）：Node 版 vs 原版对拍。
// M0 先装框架 + 一个可跑用例（ai-patterns spawn 兜底自证），M1 起逐个 TS 移植后在此对拍。
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildGateAdapters, SKILL_SCRIPTS_DIR } from '../registry.ts';

describe('gates migration harness（骨架）', () => {
  it('能找到原技能脚本目录', () => {
    expect(SKILL_SCRIPTS_DIR.length).toBeGreaterThan(0);
    expect(existsSync(join(SKILL_SCRIPTS_DIR, 'check-ai-patterns.js'))).toBe(true);
  });

  it('ai-patterns 门禁对 demo/长篇 正文产出结构化报告', async () => {
    const demoBook = join(process.cwd(), '..', 'demo', '长篇', '让你管账号，你高燃混剪炸全网');
    if (!existsSync(demoBook)) {
      // 允许在做单测时没有 demo 数据（跳过）
      console.warn('demo book 不存在，跳过（用于 CI 无 demo 场景）');
      return;
    }
    const adapters = buildGateAdapters().filter((a) => a.name === 'ai-patterns');
    expect(adapters.length).toBe(1);
    const report = await adapters[0]!.run({ bookDir: demoBook, cwd: process.cwd() });
    expect(report.gate).toBe('ai-patterns');
    expect(typeof report.passed).toBe('boolean');
    expect(Array.isArray(report.blocking)).toBe(true);
    expect(Array.isArray(report.warnings)).toBe(true);
    expect(report.ran_ms).toBeGreaterThanOrEqual(0);
  }, 30000);
});

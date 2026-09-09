// delivery-contract 门禁回归（修复 P0-A：短篇节数守恒；长篇不再误用短篇契约）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { runDeliveryContract } from './impl/delivery-contract.ts';
import { parsePlannedSections, plannedSectionsOf } from './impl/plannedSections.ts';

const SCRIPT = join(process.cwd(), '..', 'skills', 'story-short-write', 'scripts', 'check-delivery-contract.js');

let root: string;

function book(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function put(dir: string, rel: string, text: string): void {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, 'utf8');
}
const row = (i: number) => `开头 | 主事件${i} | 子事件A -> 子事件B -> 子事件C | 情绪 | 人物变化 | 因果链 | 读者获知 | 钩子 | 伏笔 | 动 | 中 | 800`;
const sectionText = (n: number) => {
  const parts: string[] = [];
  for (let i = 1; i <= n; i++) {
    parts.push('###' + i + '.');
    parts.push(('第' + i + '节正文内容，人物推进事件并承接上一节。').repeat(120));
  }
  return parts.join('\n');
};
const run = (bookDir: string, sections?: number) =>
  runDeliveryContract({ bookDir, cwd: root, stageId: 'write', revision: 1, jobId: 'j' } as any, {
    script: SCRIPT,
    sections,
  });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ohwebui-dc-'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('parsePlannedSections', () => {
  it('识别 pipe 行 / 显式总节数 / 小节标题', () => {
    expect(parsePlannedSections([row(1), row(2), row(3)].join('\n'))).toBe(3);
    expect(parsePlannedSections('# 小节大纲\n- 总节数：7\n')).toBe(7);
    expect(parsePlannedSections('### 第1节\n### 第2节\n')).toBe(2);
    expect(parsePlannedSections('没有可识别内容')).toBeNull();
  });
  it('plannedSectionsOf 缺文件返回 null + 原因', () => {
    const dir = book('no-outline');
    const r = plannedSectionsOf(dir);
    expect(r.count).toBeNull();
    expect(r.reason).toContain('小节大纲');
  });
});

describe('delivery-contract（短篇：节数守恒）', () => {
  it('正文节数 === 小节大纲规划节数 → 通过', async () => {
    const dir = book('short-ok');
    put(dir, '小节大纲.md', [row(1), row(2), row(3)].join('\n'));
    put(dir, '正文.md', sectionText(3));
    const r = await run(dir);
    expect(r.blocking, JSON.stringify(r.blocking)).toHaveLength(0);
    expect(r.passed).toBe(true);
    expect((r.value as any).shape).toBe('short');
    expect((r.value as any).planned_sections).toBe(3);
  });

  it('正文少写一节 → blocking（修复前硬编码 --sections 1，会反过来只放行单节）', async () => {
    const dir = book('short-short');
    put(dir, '小节大纲.md', [row(1), row(2), row(3)].join('\n'));
    put(dir, '正文.md', sectionText(2));
    const r = await run(dir);
    expect(r.passed).toBe(false);
    expect(r.blocking.map((b) => b.rule)).toContain('delivery.section-count');
  });

  it('缺 小节大纲.md → fail-closed（不得默认通过）', async () => {
    const dir = book('short-no-plan');
    put(dir, '正文.md', sectionText(3));
    const r = await run(dir);
    expect(r.passed).toBe(false);
    expect(r.blocking[0]!.rule).toBe('delivery-section-plan');
  });

  it('显式 sections 覆盖（便于特殊项目/测试）', async () => {
    const dir = book('short-explicit');
    put(dir, '正文.md', sectionText(1));
    const r = await run(dir, 1);
    expect(r.passed).toBe(true);
    expect((r.value as any).planned_sections).toBe(1);
  });
});

describe('delivery-contract（长篇：确定性交付校验）', () => {
  it('章节编号连续且非空 → 通过', async () => {
    const dir = book('long-ok');
    put(dir, '正文/第001章_开篇.md', '# 第001章 开篇\n\n' + '正文内容。'.repeat(60));
    put(dir, '正文/第002章_推进.md', '# 第002章 推进\n\n' + '正文内容。'.repeat(60));
    const r = await run(dir);
    expect(r.blocking).toHaveLength(0);
    expect((r.value as any).shape).toBe('long');
    expect((r.value as any).chapters).toBe(2);
  });

  it('章节缺号 → blocking', async () => {
    const dir = book('long-gap');
    put(dir, '正文/第001章_开篇.md', '# 第001章 开篇\n\n' + '正文内容。'.repeat(60));
    put(dir, '正文/第003章_跳号.md', '# 第003章 跳号\n\n' + '正文内容。'.repeat(60));
    const r = await run(dir);
    expect(r.passed).toBe(false);
    expect(r.blocking.map((b) => b.evidence).join('')).toContain('编号不连续');
  });

  it('无章节 → blocking', async () => {
    const dir = book('long-empty');
    const r = await run(dir);
    expect(r.passed).toBe(false);
    expect(r.blocking[0]!.evidence).toContain('无已写章节');
  });
});

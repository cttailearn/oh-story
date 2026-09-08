// 拆文工作台服务单测（teardown-module）：导入分章 + 确定性分析与模块单元
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importTeardownText, analyzeTeardown } from './service.ts';

let dir: string;
let bookDir: string;

const TEXT = '第一章 开局\n江晨走进演播室，雨幕如织，镜头前的灯陆续亮起。\n- 江晨：走入。\n\n第二章 任务\n系统发布了第一个任务，江晨按下确认。\n- 江晨：确认任务。\n\n第三章 反击\n江晨完成反击，观众沸腾。\n- 苏婉：点赞。';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohwebui-tear-'));
  bookDir = join(dir, 'book');
  mkdirSync(bookDir, { recursive: true });
});

afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('importTeardownText', () => {
  it('分章落盘 章节/ + 原文/ + _meta.json', () => {
    const r = importTeardownText(bookDir, '盘龙', TEXT, '盘龙');
    expect(r.chapters).toBe(3);
    const root = join(bookDir, '拆文库', '盘龙');
    expect(existsSync(join(root, '原文/原文.txt'))).toBe(true);
    const meta = JSON.parse(readFileSync(join(root, '_meta.json'), 'utf8'));
    expect(meta.chapter_count).toBe(3);
    const sums = readdirSync(join(root, '章节')).filter((f) => f.endsWith('_摘要.md'));
    expect(sums).toHaveLength(3);
  });
  it('空文本 → INVALID_INPUT', () => {
    expect(() => importTeardownText(bookDir, '空本', '   ')).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
});

describe('analyzeTeardown（确定性）', () => {
  it('产出 剧情/节奏·情绪·情节点·故事线 + 拆文报告 + 角色候选 + 可归档单元', () => {
    const { units, files } = analyzeTeardown(bookDir, '盘龙');
    const root = join(bookDir, '拆文库', '盘龙');
    for (const f of ['剧情/节奏.md', '剧情/情绪模块.md', '剧情/情节点.md', '剧情/故事线.md', '拆文报告.md']) {
      expect(existsSync(join(root, f)), f).toBe(true);
    }
    // 角色候选：从 ~ 行里抽 - 名： 前缀
    const roleFiles = readdirSync(join(root, '角色')).filter((f) => f.endsWith('.md'));
    expect(roleFiles.length).toBeGreaterThanOrEqual(1);
    // 钩子单元（结尾句非空的分章）
    expect(units.filter((u) => u.kind === 'plot').length).toBeGreaterThan(0);
    expect(units.some((u) => u.kind === 'rhythm')).toBe(true);
    expect(units.some((u) => u.kind === 'emotion')).toBe(true);
    expect(files.length).toBeGreaterThanOrEqual(5);
  });
  it('未导入就分析 → INVALID_INPUT', () => {
    expect(() => analyzeTeardown(bookDir, '未导入来')).toThrow();
  });
});

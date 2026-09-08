// 新建小说种子落盘单测（webui-frontend P2）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedNovelRequirements } from './seed.ts';

let dir: string;
let bookDir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohwebui-seed-'));
  bookDir = join(dir, 'book');
  mkdirSync(bookDir, { recursive: true });
});

afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('seedNovelRequirements', () => {
  it('需求表单 → 设定/题材定位.md + 文风.md', () => {
    const w = seedNovelRequirements(bookDir, {
      题材: '都市系统流', 类型: '长篇', 目标字数: 200000, 平台风格: '番茄',
      金手指: '短视频爆款预知', 核心卖点: '爽文', 一句话Idea: '重生军宣新人把废号做成顶流',
      keywords: ['打脸', '追妻'],
    }, '测试书');
    expect(w).toContain('设定/题材定位.md');
    expect(w).toContain('设定/文风.md');
    const t = readFileSync(join(bookDir, '设定/题材定位.md'), 'utf8');
    for (const k of ['主题材', '类型', '目标字数', '平台风格', '金手指', '核心卖点', '一句话Idea'])
      void k;
    expect(t).toContain('题材：都市系统流');
    expect(t).toContain('目标字数：200000');
    expect(t).toContain('一句话Idea：重生军宣新人把废号做成顶流');
    expect(t).toContain('关键词：打脸、追妻');
    expect(existsSync(join(bookDir, '设定/文风.md'))).toBe(true);
  });
  it('缺项字段不落行', () => {
    const w = seedNovelRequirements(bookDir, { 题材: '玄幻' }, '测试书2');
    expect(w.length).toBe(1); // 仅题材定位；文风已存在不重复写入
    const t = readFileSync(join(bookDir, '设定/题材定位.md'), 'utf8');
    expect(t).not.toContain('目标字数');
  });
});

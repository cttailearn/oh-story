// 角色线文件模型单测（character-card-line §2/§3）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseRoleLine,
  applyAdvance,
  activeStage,
  renderRoleLine,
  readRoleLine,
  writeRoleLine,
  scanCharacters,
} from '../fs/roleLine.ts';

let dir: string;
let bookDir: string;

const SAMPLE = [
  '# 角色线：江晨（军宣顶流传奇）',
  '## 弧线定义',
  '- 起点（读卡）：被低估的小透明',
  '## 阶段状态机',
  '### 阶段 1：从零起步（第1-8章）[状态: done]',
  '- 三层目标：内在=建立自信；外在=首支爆款；关系=与战友破冰',
  '- 验收：主角完成第一次作品兑现（✓第6章）',
  '- 渐变证据：第3章 首次尝试失败；第6章 数据反馈',
  '### 阶段 2：爆款确立→责任的重量（第9-30章）[状态: active]',
  '- 三层目标：内在=承担军宣责任；外在=破亿；关系=获得高层信任',
  '- 验收：借老兵故事让“责任的重量”落地',
  '### 阶段 3：顶流之路（第31-60章）[状态: planned]',
  '## 进度指针',
  '- 当前阶段：阶段 2（active）｜ 最近确认到：第 18 章',
  '## 审计结果（卷末由 role-line gate 回填）',
  '- v1：阶段1 验收通过（证据2条）；阶段2 进度正常',
];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohwebui-arc-'));
  bookDir = join(dir, 'book');
  mkdirSync(join(bookDir, '设定', '角色线'), { recursive: true });
  mkdirSync(join(bookDir, '设定', '角色'), { recursive: true });
  writeFileSync(join(bookDir, '设定', '角色线', '江晨.md'), SAMPLE.join('\n'), 'utf8');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseRoleLine', () => {
  it('解析 3 阶段 + 目标/验收/证据分行 + 进度指针 + 审计', () => {
    const line = parseRoleLine(SAMPLE.join('\n'), '江晨');
    expect(line.stages).toHaveLength(3);
    expect(line.stages[0]!.status).toBe('done');
    expect(line.stages[1]!.status).toBe('active');
    expect(line.stages[0]!.goals[0]).toContain('建立自信');
    const a = activeStage(line)!;
    expect(a.no).toBe(2);
    expect(line.progressPointer).toContain('阶段 2');
    expect(line.audit[0]).toContain('阶段1 验收通过');
  });
});

describe('applyAdvance + activeStage', () => {
  it('推进到阶段 3（done）→ 计数连续、指针更新、验收证据追加', () => {
    const line = parseRoleLine(SAMPLE.join('\n'), '江晨');
    const next = applyAdvance(line, { to_stage: 3, to_status: 'done', acceptance_done: ['第31章 成为平台顶流'], confirm_through_chapter: 36, note: '卷末收束' });
    expect(next.stages.map((s) => s.status)).toEqual(['done', 'done', 'done']);
    expect(next.stages[2]!.acceptance[0]).toContain('第31章');
    expect(next.progressPointer).toContain('第36 章');
    expect(activeStage(next)!.status).toBe('done');
  });
  it('active 推进：目标阶段 active、之前 done、之后 planned', () => {
    const line = parseRoleLine(SAMPLE.join('\n'), '江晨');
    const next = applyAdvance(line, { to_stage: 3, to_status: 'active' });
    expect(next.stages.map((s) => s.status)).toEqual(['done', 'done', 'active']);
    expect(activeStage(next)!.no).toBe(3);
  });
  it('render → re-parse 保持阶段与状态', () => {
    const line = parseRoleLine(SAMPLE.join('\n'), '江晨');
    const md = renderRoleLine(line);
    const back = parseRoleLine(md, '江晨');
    expect(back.stages.map((s) => s.status)).toEqual(line.stages.map((s) => s.status));
    expect(back.stages).toHaveLength(3);
  });
});

describe('文件 IO + scanCharacters', () => {
  it('writeRoleLine 落盘后 readRoleLine 可回读', () => {
    const line = parseRoleLine(SAMPLE.join('\n'), '江晨');
    writeRoleLine(bookDir, '江晨', line);
    const back = readRoleLine(bookDir, '江晨');
    expect(back.line).not.toBeNull();
    expect(back.line!.stages).toHaveLength(3);
  });
  it('scanCharacters 统计红线数与线关联', () => {
    writeFileSync(join(bookDir, '设定', '角色', '江晨.md'), '# 角色卡：江晨\n## 写作红线\n- 绝不当逃兵\n- 不背叛战友\n## 其它\n- ok', 'utf8');
    writeFileSync(join(bookDir, '设定', '角色', '路人甲.md'), '# 角色卡：路人甲\n- 无红线', 'utf8');
    const list = scanCharacters(bookDir);
    const jc = list.find((c) => c.name === '江晨')!;
    expect(jc.redLines).toBe(2);
    expect(jc.lineExists).toBe(true);
    const lj = list.find((c) => c.name === '路人甲')!;
    expect(lj.redLines).toBe(0);
    expect(lj.lineExists).toBe(false);
  });
});

// 拆文工作台服务（teardown-module.md）：导入原文 -> 分章 -> 确定性分析（无 API 成本）-> 拆文库落盘 + 模块化单元
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { splitChapters } from '../import/service.ts';

function tearRoot(bookDir: string, bookName: string): string {
  return join(bookDir, '拆文库', bookName);
}

function mkdirs(root: string, ...rel: string[]): void {
  for (const r of rel) mkdirSync(join(root, r), { recursive: true });
}

function summarize(no: number, title: string, body: string): { summary: string; hook: string; chars: number } {
  const lines = body.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const first = lines[0] ?? '';
  const last = lines[lines.length - 1] ?? '';
  return { summary: (first.slice(0, 60) || '（本章无明显开句）') + (lines.length > 1 ? '…' : ''), hook: last.slice(0, 40), chars: body.replace(/\s+/g, '').length };
}

export function importTeardownText(
  bookDir: string,
  bookName: string,
  text: string,
  sourceTitle?: string,
): { chapters: number; review: Array<{ no: number; title: string; range: string }> } {
  if (!text.trim()) throw Object.assign(new Error('空文本'), { code: 'INVALID_INPUT' });
  const chapters = splitChapters(text);
  if (chapters.length === 0) throw Object.assign(new Error('未识别到章节'), { code: 'INVALID_INPUT' });
  const root = tearRoot(bookDir, bookName);
  mkdirs(root, '原文', '章节');
  writeFileSync(join(root, '原文', '原文.txt'), text, 'utf8');
  const metaChapters: Record<number, { chars: number; first: string; last: string }> = {};
  for (const ch of chapters) {
    const s = summarize(ch.no, ch.title, ch.body);
    metaChapters[ch.no] = { chars: s.chars, first: s.summary, last: s.hook };
    const noPadded = String(ch.no).padStart(3, '0');
    writeFileSync(join(root, '章节', '第' + noPadded + '章_摘要.md'), '# 第' + ch.no + '章 摘要\n' + s.summary + '\n', 'utf8');
    writeFileSync(join(root, '章节', '第' + noPadded + '章_情节点.md'), '# 第' + ch.no + '章 情节点\n- hook: ' + (s.hook || '-') + '\n', 'utf8');
  }
  writeFileSync(join(root, '章节', '_meta.json'), JSON.stringify({ chapter_count: chapters.length, meta: metaChapters }, null, 2), 'utf8');
  writeFileSync(join(root, '_meta.json'), JSON.stringify({ source_title: sourceTitle ?? bookName, source_platform: '', imported_at: new Date().toISOString(), chapter_count: chapters.length, extracted_by: [], analyzed_by: [], module_library_ids: [] }, null, 2), 'utf8');
  return { chapters: chapters.length, review: chapters.map((c) => ({ no: c.no, title: c.title, range: c.anchor ? '锚点' : '分切' })) };
}

/** 中文人名候选：'- 名：...' 行抽取（拆文库原文人工标注或文本行高风险前缀裁剪） */
function extractNames(st: string): Array<{ name: string; count: number }> {
  const stop = new Set(['但是', '因为', '可以', '没有', '自己', '他们', '你们', '我们', '这个', '那个', '什么', '时候', '一个', '已经', '怎么', '还是', '就是', '不是', '知道', '看见', '以为', '一样', '这么', '那样', '然而', '于是', '现在', '所以', '虽然', '一定', '一种', '那些', '然后', '下来', '过去', '回来', '起来', '一直', '真的', '如果', '而且', '可是', '把', '被', '在', '有', '是', '不', '你', '我']);
  const counts = new Map<string, number>();
  for (const line of st.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s*([\u4e00-\u9fa5]{2,4})\s*[：:]/);
    if (m) { const n = m[1]!; if (!stop.has(n) && /^[\u4e00-\u9fa5]+$/.test(n)) counts.set(n, (counts.get(n) ?? 0) + 1); }
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 12);
}

export interface AnalyzeUnit {
  kind: 'plot' | 'rhythm' | 'emotion' | 'character-trait';
  title: string;
  body: string;
  tags?: string[];
  usable_for?: string[];
  source_path?: string;
}

export function analyzeTeardown(bookDir: string, bookName: string): { units: AnalyzeUnit[]; files: string[] } {
  const root = tearRoot(bookDir, bookName);
  const chDir = join(root, '章节');
  if (!existsSync(join(chDir, '_meta.json'))) throw Object.assign(new Error('先导入原文再拆解（缺 章节/_meta.json）'), { code: 'INVALID_INPUT' });
  let meta = { chapter_count: 0, meta: {} as Record<string, { chars: number; first: string; last: string }> };
  try { meta = JSON.parse(readFileSync(join(chDir, '_meta.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { /* ignore */ }
  const entries = Object.entries(meta.meta ?? {}).sort((a, b) => Number(a[0]) - Number(b[0]));
  mkdirs(root, '剧情', '角色', '设定');

  const units: AnalyzeUnit[] = [];
  const files: string[] = [];
  const rhythmLines: string[] = ['# 节奏（每章快慢条带）', ''];
  const emotionLines: string[] = ['# 情绪模块', ''];
  const plotLines: string[] = ['# 情节点', ''];
  const storyLines: string[] = ['# 故事线', ''];
  const allPlots: Array<{ no: number; hook: string; chars: number }> = [];
  const vals = entries.map(([, v]) => v?.chars ?? 0);
  const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 1;
  for (const [noStr, v] of entries) {
    const no = Number(noStr);
    const chars = v?.chars ?? 0;
    const ratio = avg ? chars / avg : 1;
    const label = ratio > 1.5 ? 'fast' : ratio < 0.7 ? 'slow' : 'steady';
    rhythmLines.push('- 第' + no + '章: ' + label);
    emotionLines.push('第' + no + '章 : 0');
    const hook = v?.last ?? '';
    allPlots.push({ no, hook, chars });
    plotLines.push('- 第' + no + '章: ' + (hook || '—'));
    storyLines.push('- 第' + no + '章：' + (v?.first ?? ''));
  }
  writeFileSync(join(root, '剧情/节奏.md'), rhythmLines.join('\n') + '\n', 'utf8');
  writeFileSync(join(root, '剧情/情绪模块.md'), emotionLines.join('\n') + '\n', 'utf8');
  writeFileSync(join(root, '剧情/情节点.md'), plotLines.join('\n') + '\n', 'utf8');
  writeFileSync(join(root, '剧情/故事线.md'), storyLines.join('\n') + '\n', 'utf8');
  const allText = readText(bookDir, bookName, '原文/原文.txt');
  const names = extractNames(allText);
  for (const n of names) {
    writeFileSync(join(root, '角色/' + n.name + '.md'), '# 角色（拆文）:' + n.name + '\n- 来源: ' + bookName + '（实例态，需人工精修）\n', 'utf8');
    files.push('角色/' + n.name + '.md');
  }
  const hard = allPlots.filter((p) => p.hook).slice(0, 5);
  for (const p of hard) units.push({ kind: 'plot', title: '第' + p.no + '章钩子', body: p.hook, tags: ['钩子'], source_path: '剧情/情节点.md' });
  units.push({ kind: 'rhythm', title: '全书节奏定位', body: rhythmLines.slice(1).join('\n'), tags: ['节奏'], source_path: '剧情/节奏.md' });
  units.push({ kind: 'emotion', title: '全书情绪曲线数据', body: emotionLines.slice(1).join('\n'), tags: ['情绪'], source_path: '剧情/情绪模块.md' });
  for (const n of names.slice(0, 4)) units.push({ kind: 'character-trait', title: '角色档案·' + n.name, body: '高频角色（' + n.count + ' 处）拆出。', tags: ['角色'], source_path: '角色/' + n.name + '.md' });

  const report = ['# 拆文报告：' + bookName, '', '- 章节数: ' + entries.length, '- 提取角色候选（高频）: ' + (names.map((n) => n.name).join('、') || '（无）'), '- 钩子单元（可入库）: ' + hard.length + ' 个', '- 拆解方式: 确定性启发式（AI 精化为 M4 增强）', ''];
  writeFileSync(join(root, '拆文报告.md'), report.join('\n') + '\n', 'utf8');

  files.push('剧情/节奏.md', '剧情/情绪模块.md', '剧情/情节点.md', '剧情/故事线.md', '拆文报告.md');
  return { units, files };
}

function readText(bookDir: string, bookName: string, rel: string): string {
  try { return readFileSync(join(tearRoot(bookDir, bookName), rel), 'utf8'); }
  catch { return ''; }
}

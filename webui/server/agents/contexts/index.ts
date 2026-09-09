// Context 组装器（agents-runtime §3 / process-definition §5）：glue 注册表 + 各组装器
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { StageEntry } from '../../engine/types.ts';
import { getTemplate, type TemplateDoc } from '../templates/index.ts';

export interface PromptBlock {
  kind: 'facts' | 'tracking' | 'memory' | 'knowledge' | 'task';
  title: string;
  text: string;
  tokens: number;
}

export interface ContextBundle {
  system: string;
  blocks: PromptBlock[];
  /** 拼好的用户消息（各块按序拼接） */
  user_message: string;
  /** 各块 token 估算 */
  budget: Record<string, number>;
}

export type ContextGlue = (opts: { bookDir: string; stage: StageEntry; role: string; bookTitle?: string }) => Promise<ContextBundle>;

function estTokens(text: string): number {
  return Math.ceil(text.length / 3); // 中文 1 token ≈ 0.75-1 字，粗略估算
}

/** 读书内文件（安全读取；不存在返回 ''） */
function readBookFile(bookDir: string, rel: string): string {
  const abs = join(bookDir, rel);
  if (!existsSync(abs)) return '';
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return '';
  }
}

function readingOrder(bookDir: string, sub: string, prefix = ''): string[] {
  const dir = join(bookDir, sub);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))
    .map((f) => `${prefix}${f}`);
}

const block = (kind: PromptBlock['kind'], title: string, text: string): PromptBlock => ({
  kind,
  title,
  text,
  tokens: estTokens(text),
});

/** context-intake：需求卡（题材定位文件） */
export async function buildIntake(opts: { bookDir: string; stage: StageEntry; role: string }): Promise<ContextBundle> {
  const tmpl = getTemplate(stageTemplateFor(opts.stage));
  const blocks: PromptBlock[] = [];
  const existing = readBookFile(opts.bookDir, '设定/题材定位.md');
  if (existing) {
    blocks.push(block('facts', '已有题材定位（追加/修订）', existing.slice(0, 3000)));
  }
  blocks.push(
    block(
      'task',
      '需求录入',
      `请按契约字段输出《设定/题材定位.md》：题材、类型、目标字数、平台风格、金手指、核心卖点、一句话Idea。` +
        (existing ? '\n保留已合理的内容，只补齐缺口。' : '\n全新创作，先列题材方向再填充。'),
    ),
  );
  return bundle(tmpl, blocks);
}

/** context-concept：世界观/金手指 */
export async function buildConcept(opts: { bookDir: string; stage: StageEntry; role: string }): Promise<ContextBundle> {
  const tmpl = getTemplate(stageTemplateFor(opts.stage));
  const blocks: PromptBlock[] = [];
  const topic = readBookFile(opts.bookDir, '设定/题材定位.md');
  if (topic) blocks.push(block('facts', '题材定位', topic.slice(0, 3000)));
  blocks.push(
    block(
      'task',
      '世界观/金手指',
      `产出《设定/世界观/*.md》与《设定/文风.md》《设定/关系.md》：力量体系/地理/组织/规则约束；金手指需有代价与成长。`,
    ),
  );
  return bundle(tmpl, blocks);
}

/** context-characters：人设（卡 + 线骨架） */
export async function buildCharacters(opts: { bookDir: string; stage: StageEntry; role: string }): Promise<ContextBundle> {
  const tmpl = getTemplate(stageTemplateFor(opts.stage));
  const blocks: PromptBlock[] = [];
  const conceptFiles = readingOrder(opts.bookDir, '设定/世界观', '设定/世界观/');
  for (const f of conceptFiles.slice(0, 3)) blocks.push(block('facts', f, readBookFile(opts.bookDir, f).slice(0, 2000)));
  const existingChars = readingOrder(opts.bookDir, '设定/角色', '设定/角色/');
  if (existingChars.length) {
    blocks.push(block('facts', `已有人设（${existingChars.length}）`, existingChars.join('、')));
  }
  blocks.push(
    block(
      'task',
      '角色卡 + 角色线骨架',
      `产出《设定/角色/*.md》角色卡（姓名/身份/目标/动机/能力/语言风格/关系）与《设定/角色线/*.md》弧线骨架（阶段 planned/active/done + 验收）。与已有角色去重；每个角色同时建卡与线骨架。` +
        `输出格式（严格）：每个文件单独成块：块头行写「### 《设定/角色/姓名.md》」或「### 《设定/角色线/姓名.md》」（行首无编号、无其它文字），下一行起为该文件全部内容，块间空一行。先输出所有角色卡块，再输出所有角色线块。禁止输出使用说明/模板/汇总段落，只输出文件块。`,
    ),
  );
  return bundle(tmpl, blocks);
}

/** context-outline：大纲（卷纲/细纲） */
export async function buildOutline(opts: { bookDir: string; stage: StageEntry; role: string }): Promise<ContextBundle> {
  const tmpl = getTemplate(stageTemplateFor(opts.stage));
  const blocks: PromptBlock[] = [];
  for (const rel of ['设定/题材定位.md', '设定/关系.md']) {
    const t = readBookFile(opts.bookDir, rel);
    if (t) blocks.push(block('facts', rel, t.slice(0, 2500)));
  }
  const chars = readingOrder(opts.bookDir, '设定/角色', '设定/角色/').slice(0, 5);
  if (chars.length) blocks.push(block('facts', '角色卡摘要', chars.join('、')));
  blocks.push(
    block(
      'task',
      '大纲',
      `产出《大纲/大纲.md》（首部必须含「全书体量与阶段总览」小节：全书体量约N万字、阶段0-M、每卷章数）、《大纲/卷纲/卷X.md》、《大纲/细纲/第NNN章.md》。` +
        `每章细纲必须且只能含以下13个硬字段（字段名照抄、逐条列出，内容充实非一句话）：核心事件 / 字数目标 / 阶段位置 / 单元ID/位置 / 目标情绪 / 主角目标/关键选择 / 本章禁止提前释放 / 内容概括（五段式） / 情节安排（多线） / 人物关系和出场顺序 / 情节细化（含预算合计） / 结尾设定和钩子 / 本章设定引用。` +
        `补充要求：目标情绪须写「前→后」状态；情节细化情节点数≥5且至少一条带 密/疏 标注；结尾设定写具体落点。` +
        `输出格式（严格）：每章/每卷/大纲各一个文件块：块头行「### 《大纲/细纲/第NNN章.md》」或「### 《大纲/卷纲/卷X.md》」或「### 《大纲/大纲.md》」（行首无编号），下一行起为该文件全部内容。先卷纲与大章大纲，再拍代表性章节（≥6章）细纲即可，不必写满全部章节。`,
    ),
  );
  return bundle(tmpl, blocks);
}

/** context-chapter：单章正文（含角色线块 —— process §5.3） */
export async function buildChapter(opts: { bookDir: string; stage: StageEntry; role: string; bookTitle?: string }): Promise<ContextBundle> {
  const tmpl = getTemplate(stageTemplateFor(opts.stage));
  const blocks: PromptBlock[] = [];
  // 题材定位 / 文风
  const style = readBookFile(opts.bookDir, '设定/文风.md') || readBookFile(opts.bookDir, '设定/题材定位.md');
  if (style) blocks.push(block('facts', '题材定位/文风', style.slice(0, 2500)));

  // 追踪状态（精选）
  const tracking = readBookFile(opts.bookDir, '追踪/_tracking-state.json');
  let trackingText = '（无追踪文件）';
  if (tracking) {
    try {
      const t = JSON.parse(tracking);
      const pick: string[] = [];
      if (t.context?.position) pick.push(`position=${JSON.stringify(t.context.position)}`);
      if (t.last_committed_chapter != null) pick.push(`last_committed_chapter=${t.last_committed_chapter}`);
      if (t.context?.next_chapter_commitments) pick.push(`next=${JSON.stringify(t.context.next_chapter_commitments)}`);
      if (Array.isArray(t.context?.continuity_risks) && t.context.continuity_risks.length) pick.push(`risks=${t.context.continuity_risks.join('；')}`);
      if (t.characters && typeof t.characters === 'object') {
        const names = Object.keys(t.characters);
        pick.push(`characters=${names.slice(0, 10).join('、')}`);
      }
      trackingText = pick.join('\n') || '（追踪状态为空）';
    } catch {
      trackingText = tracking.slice(0, 3000);
    }
  }
  blocks.push(block('tracking', '追踪状态（精选）', trackingText));

  // 细纲（本章）
  const keyOutline = readBookFile(opts.bookDir, '大纲/细纲/第001章.md') || readBookFile(opts.bookDir, '大纲/大纲.md');
  if (keyOutline) blocks.push(block('facts', '细纲/大纲线索', keyOutline.slice(0, 2500)));

  // 角色线块（涉场角色 active 阶段 —— character-card-line）
  const arcDir = join(opts.bookDir, '大纲/角色线');
  if (existsSync(arcDir)) {
    const arcs = readdirSync(arcDir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .slice(0, 4)
      .map((f) => readBookFile(opts.bookDir, `大纲/角色线/${f}`).slice(0, 1200));
    if (arcs.length) blocks.push(block('tracking', '角色线（涉场角色·active 阶段）', arcs.join('\n---\n')));
  }

  // 作者记忆
  const memoryDir = join(opts.bookDir, '.story/作者记忆');
  if (existsSync(memoryDir)) {
    const mem = readdirSync(memoryDir)
      .filter((f) => f.endsWith('.md'))
      .slice(0, 3)
      .map((f) => readBookFile(opts.bookDir, `.story/作者记忆/${f}`).slice(0, 800));
    if (mem.length) blocks.push(block('memory', '作者记忆', mem.join('\n')));
  }

  blocks.push(
    block(
      'task',
      '交付格式',
      `输出 markdown 正文一章（2000-2600 字，标题行形如「# 第001章 章名」）。` +
        `随后引擎将跑门禁：char-count≥1800、ai-patterns=0 blocking、tracking-commit 提交、写章三查落盘。\n\n` +
        `除正文外，必须再输出两个 json 代码块（引擎会自动剥离，不会写进手稿）：\n` +
        `1) 追踪事务（契约见 skills tracking-transaction）：{"tracking_tx":{"schema_version":1,"mode":"append","chapter":<本章号>,` +
        `"chapter_title":"<章名>","delta":{"result":"<本章结果一句话>","character_changes":[],"foreshadow_changes":[],"timeline_events":[],"constraints":[],"next_chapter_commitments":["<下一章承诺>"]},` +
        `"context":{"position":{"volume":"<卷名>","volume_start_chapter":1,"story_time":"<故事时间>","scene":"<场景>"},"long_term_constraints":[],"active_character_names":[],"continuity_risks":[]},"character_snapshots":{}}}\n` +
        `2) 写章三查（查2 由你判定，不得虚报）：{"review":{"chapter":<本章号>,"chapter_name":"<章名>","check2":{"items":[{"item":"<细纲要求项>","ok":true,"note":"<证据/差异>"}]},"conclusion":"完成"}}\n` +
        `注意：check2 必须逐条覆盖本章细纲的核心事件/情节点序列/禁止提前释放/结尾钩子；引擎只填查1（追踪状态）与查3（门禁真实结果），不会替你补查2。`,
    ),
  );
  return bundle(tmpl, blocks);
}

/** 通用兜底：intake 同构 */
export async function buildGeneric(opts: { bookDir: string; stage: StageEntry; role: string }): Promise<ContextBundle> {
  const tmpl = getTemplate(stageTemplateFor(opts.stage));
  const blocks: PromptBlock[] = [
    block(
      'task',
      '阶段任务',
      `按阶段 ${opts.stage.assemble} 产出对应产物。${opts.stage.instructions ?? ''}`.trim(),
    ),
  ];
  return bundle(tmpl, blocks);
}

function bundle(tmpl: TemplateDoc, blocks: PromptBlock[]): ContextBundle {
  const total = blocks.reduce((s, b) => s + b.tokens, 0);
  return {
    system: tmpl.system,
    blocks,
    user_message: blocks.map((b) => `## ${b.title}\n${b.text}`).join('\n\n'),
    budget: { system: estTokens(tmpl.system), blocks: total },
  };
}

/** assemble 键 → 组装器（业务 glue 注册表） */
export const CONTEXT_GLUES: Record<string, ContextGlue> = {
  'context-intake': buildIntake,
  'context-topic': buildIntake,
  'context-concept': buildConcept,
  'context-characters': buildCharacters,
  'context-outline': buildOutline,
  'context-chapter': buildChapter,
  'context-review': buildGeneric,
  'context-deslop': buildGeneric,
  'context-image': buildGeneric,
  'context-export': buildGeneric,
  'context-short-concept': buildGeneric,
  'context-short-write': buildGeneric,
};

export async function assembleBundle(opts: { bookDir: string; stage: StageEntry; role: string; bookTitle?: string }): Promise<ContextBundle> {
  const glue = CONTEXT_GLUES[opts.stage.assemble] ?? buildGeneric;
  return glue(opts);
}

function stageTemplateFor(stage: StageEntry): string {
  return stage.templates?.[0] ?? 'story-architect.md';
}

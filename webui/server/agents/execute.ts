// Agent 执行层：FakeAgent（demo/e2e 确定性产物）+ RealAgent（pi-ai Server+StreamFn）
import { Agent } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ContextBundle } from './contexts/index.ts';
import type { AiRuntime } from '../ai/runtime.ts';
import type { RoleSpec } from './roles.ts';

export interface AgentResult {
  text: string;
  usage: { input: number; output: number; cost_cents: number };
  fake: boolean;
}

export interface RunAgentParams {
  bundle: ContextBundle;
  model: { channelId: string; modelId: string };
  role?: RoleSpec;
  /** e2e/demo 时强制用假渠道 */
  fake?: boolean;
  onText?: (delta: string) => void;
}

const EMPTY_USAGE = { input: 0, output: 0, cost_cents: 0 };

/**
 * FakeAgent：不消耗上游，产出确定性的「最小合法产物」。
 * 用于 demo/假渠道 e2e：让全链路（Context→Agent→落盘→门禁→每步确认）无需真实模型即可走通。
 * 产物文本按 assemble 键模板生成，保证能过最小门禁（char-count 等）。
 */
export async function runFakeAgent(params: RunAgentParams): Promise<AgentResult> {
  const glue = params.bundle.blocks.find((b) => b.kind === 'task')?.title ?? 'task';
  const text = fakeArtifact(params.bundle, glue);
  for (const line of text.split('\n')) {
    params.onText?.(line + '\n');
  }
  return { text, usage: EMPTY_USAGE, fake: true };
}

function fakeArtifact(bundle: ContextBundle, taskTitle: string): string {
  // 依据 task 块标题选择骨架
  const all = bundle.blocks.map((b) => b.title).join(' | ');
  const isChapter =
    /正文|章节|章节写作|追踪状态/.test(all) || taskTitle.includes('交付格式');
  const isCharacters = /角色/.test(all);
  const isOutline = /大纲/.test(all);
  const isConcept = /世界观|金手指|题材/.test(all);

  if (isChapter) {
    let body = `# 第一章 开篇（fake 示例产物）\n\n`;
    const sentences = [
      '他走进演播室时，窗外正飘着细雨，楼下的灯一盏接一盏亮起来。',
      '江晨把稿子又看了一遍，那些被他反复打磨的字句落在纸上，像一块石头落了地。',
      '有人推门喊他，说导播在等。他合上文件夹，脚步声在走廊里起了回音。',
      '镜头前的灯亮了，他没有立刻开口，只是先看了一眼面前的提词器。',
      '台下的同事对他点头，他忽然觉得，这条路他确实走了很久。',
      '回家路上他接到一条消息，说昨晚那条视频的播放量翻了倍。',
      '他愣了几秒，随即笑了一下，把手机揣回兜里，脚步轻快了许多。',
      '这只是一个开始，他心里清楚。后面还有更长的路要走。',
    ];
    for (let i = 0; i < 96; i++) {
      body += `　　${sentences[i % sentences.length]}\n\n`;
    }
    body += `　　（此处为 demo 假产物，用于 e2e 验证门禁与确认链路；真实写作由 M1 真渠道产出。）\n`;
    return body;
  }
  if (isCharacters) {
    return [
      '# 江晨',
      '',
      '- 身份：主角（军宣文工团新人）',
      '- 目标：把废号做成顶流，实现军宣价值',
      '- 动机：证明自己/兑现承诺',
      '- 能力：短视频爆款预知（金手指）+ 天王唱功',
      '- 语言风格：口语化、果断',
      '- 成长弧线起点：被低估的小透明',
      '',
      '<!-- 角色线骨架（角色线/江晨.md） -->',
      '# 江晨·弧线「军宣顶流传奇」',
      '',
      '- 阶段1（planned）：从零起步（1-8章）',
      '- 阶段2（planned）：爆款确立→责任的重量（9-30章）',
      '- 验收：每阶段有可核对的剧情兑现点',
    ].join('\n');
  }
  if (isOutline) {
    let out = ['# 大纲（卷纲+细纲骨架）', '', '## 阶段总览（全书体量）', '- 全书体量：约 20 万字；阶段 0-5，每卷 4-8 章。', ''];
    const beats = ['开篇定调与首次任务', '意外爆红引来关注', '遭遇质疑与舆论反转', '关键抉择推动主线', '阶段性收束埋新钩子'];
    for (let i = 1; i <= 5; i++) {
      const n = String(i).padStart(3, '0');
      out.push(
        `## 第${n}章`,
        '',
        '- **核心事件**：主角${beats[i - 1]}。',
        '- **字数目标**：2200。',
        '- **阶段位置**：开局阶段（1-8章，共一卷）。',
        '- **单元ID/位置**：卷1-章${i}。',
        '- **目标情绪**：先抑后扬，结尾带期待。',
        '- **主角目标/关键选择**：认清现状并主动出击。',
        '- **本章禁止提前释放**：系统奖励来源。',
        '- **本章设定引用**：金手指-爆款预知；平台-短视频数据链。',
        '',
        '## 内容概括',
        `第${n}章：主角遭遇开局困境，借一个关键事件进入主线。`,
        '',
        '## 情节安排',
        '- 起：冲突露头；承：角色围拢；转：作品效果兑现；合：结尾钩子。',
        `- 情节点：${['找切入点', '完成首支视频', '数据反馈', '交锋', '新任务'][i - 1]}。`,
        '',
        '- **人物关系变化**：配角依情节推进陆续入场，关系由任务协作驱动。',
        '- **出场顺序**：主角先出场，配角依推进入场。',
        '- **情节细化**：情节节点≥5，逐步升级冲突。',
        '- **结尾设定**：留下下一章待解悬念（具体落点：新任务线索出现）。',
        '- **章尾钩子**：借任务升级引出下一章冲突。',
        '',
      );
    }
    return out.join('\n');
  }
  if (isConcept) {
    return [
      '# 世界观 / 金手指（草案）',
      '',
      '## 世界观',
      '- 背景：现代都市 + 文工团/军宣体系',
      '- 规则：作品真实效果驱动传播，不搞魔法值',
      '',
      '## 金手指',
      '- 短视频爆款预知：能隐隐感知哪种表达会爆，需靠实际数据验证，有冷却与代价',
      '',
      '## 文风要求',
      '- 口语化、爽点靠作品效果/数据/围观反应链兑现',
    ].join('\n');
  }

  // 默认（intake / 其它）
  return [
    `# ${taskTitle}（fake 示例产物）`,
    '',
    `- 题材：都市系统流（示例）`,
    '- 类型：长篇',
    '- 目标字数：200000',
    '- 平台风格：番茄',
    '- 金手指：短视频爆款预知',
    '- 核心卖点：爽文 / 追妻火葬场（示例）',
    '- 一句话Idea：（由真实模型补全）',
  ].join('\n');
}

/**
 * RealAgent：pi-ai 真调用。
 * 用法：assembleBundle → 这里用 pi Agent 跑一轮，取最终 assistant 文本。
 */
export async function runRealAgent(ai: AiRuntime, params: RunAgentParams): Promise<AgentResult> {
  const model = ai.modelFor(params.model.channelId, params.model.modelId);
  if (!model) {
    throw new Error(
      `MODEL_NOT_FOUND: channel=${params.model.channelId} model=${params.model.modelId}（设置页配置渠道与模型）`,
    );
  }
  const agent = new Agent({
    // 真渠道修复：Agent 不携带 model —— 一律用我们已解析的注册模型（忽略 Agent 传入的占位 model）
    streamFn: (_m: any, ctx: any, opts: any) => ai.streamSimple(model as any, ctx, opts as any),
    sessionId: `webui-${Date.now()}`,
    onPayload: params.onText ? (p) => params.onText?.(String((p as any)?.text ?? p)) : undefined,
  });
  agent.state.systemPrompt = params.bundle.system;
  await agent.prompt(params.bundle.user_message);

  // 等待空闲并取最终消息
  const final = (): AssistantMessage | undefined => {
    const msgs = agent.state.messages.filter((m) => m.role === 'assistant') as AssistantMessage[];
    return msgs[msgs.length - 1];
  };
  await agent.waitForIdle();
  const msg = final();

  // M4 打磨（真渠道端到端）：真实调用失败必须「看得见」——
  // pi-ai 会把网关 401/解析错误以 error 事件送达而非抛异常，这里显式检查并对空输出 fail-closed
  if ((agent.state as any).errorMessage) {
    throw new Error(`MODEL_CALL_FAILED: ${(agent.state as any).errorMessage}（channel=${params.model.channelId} model=${params.model.modelId}）`);
  }
  if (msg && msg.stopReason === 'error') {
    throw new Error(`MODEL_CALL_FAILED: ${(msg as any).errorMessage ?? 'gateway returned error'}`);
  }
  const text = (msg?.content ?? [])
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('\n');
  if (!text.trim()) {
    throw new Error(`MODEL_EMPTY_OUTPUT: 模型未产出任何文本（channel=${params.model.channelId} model=${params.model.modelId}）——检查渠道连通/api_key 后重跑；本次不落任何产物`);
  }
  const u = msg?.usage;
  return {
    text,
    usage: {
      input: u?.input ?? 0,
      output: u?.output ?? 0,
      cost_cents: u?.cost?.total ?? 0,
    },
    fake: false,
  };
}

export { EMPTY_USAGE };

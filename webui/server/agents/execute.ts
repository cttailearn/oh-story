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
  /**
   * 阶段 id —— fake 产物模板选择的**第一依据**。
   * 修复：仅靠上下文块标题启发式会在「设定/角色/*.md 已落盘」后把 outline 误判为 characters，
   * 导致 outline 阶段把角色卡写进 大纲/大纲.md，project-consistency 门禁必阻塞。
   */
  stageId?: string;
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
  const text = fakeArtifact(params.bundle, glue, params.stageId);
  for (const line of text.split('\n')) {
    params.onText?.(line + '\n');
  }
  return { text, usage: EMPTY_USAGE, fake: true };
}

function fakeArtifact(bundle: ContextBundle, taskTitle: string, stageId?: string): string {
  // 依据 task 块标题选择骨架；已知阶段 id 时以阶段为准（见 RunAgentParams.stageId 注释）
  const all = bundle.blocks.map((b) => b.title).join(' | ');
  const known = stageId
    ? ({ chapter: 'chapter', characters: 'characters', outline: 'outline', concept: 'concept' } as Record<string, string>)[
        stageId
      ]
    : undefined;
  const isChapter = known
    ? known === 'chapter'
    : /正文|章节|章节写作|追踪状态/.test(all) || taskTitle.includes('交付格式');
  const isCharacters = known ? known === 'characters' : /角色/.test(all);
  const isOutline = known ? known === 'outline' : /大纲/.test(all);
  const isConcept = known ? known === 'concept' : /世界观|金手指|题材/.test(all);

  if (isChapter) {
    let body = `# 第001章 开篇（fake 示例产物）\n\n`;
    // 组合生成不重复的句子：避免 degeneration 门禁（复读/同句≥3 次）把假产物判死，
    // 假渠道的用途是"能过最小门禁地跑通全链路"，因此正文必须无重复句。
    const who = ['江晨', '导播老周', '编导小许', '值班的保安', '同组的主播', '灯光师', '剪辑师小唐', '宣传处的干事'];
    const where = ['演播室', '走廊尽头', '剪辑间', '楼下的便利店', '会议室', '天台', '化妆间', '车库'];
    const what = [
      '把稿子又看了一遍，指尖在标题上停了停',
      '调低了监视器的亮度，画面里的噪点淡了下去',
      '把耳机摘下来，听见窗外有雨敲在铁皮上',
      '把水杯推到桌角，杯壁上的水痕慢慢洇开',
      '把时间轴往后拖了三格，又拖回原位',
      '在便签上写下一个数字，随即划掉',
      '把外套挂在椅背上，袖口还沾着雨',
      '把提词器的字号调大了一档',
    ];
    const tail = [
      '，说等会儿再定。',
      '，没有再多解释。',
      '，动作很轻。',
      '，像是在确认什么。',
      '，然后把门带上。',
      '，屋里安静了几秒。',
      '，屏幕上的进度条走到了底。',
      '，走廊里传来脚步声。',
    ];
    let n = 0;
    for (let a = 0; a < who.length; a++) {
      for (let b = 0; b < where.length; b++) {
        const s = who[a] + '在' + where[b] + what[(a + b) % what.length] + tail[(a * 3 + b) % tail.length];
        body += `　　${s}\n\n`;
        n++;
        if (n >= 96) break;
      }
      if (n >= 96) break;
    }
    body += `　　（此处为 demo 假产物，用于 e2e 验证门禁与确认链路；真实写作由 M1 真渠道产出。）\n`;
    // 控制块（引擎会剥离，不写入手稿）：追踪事务 + 写章三查载荷
    const tx = {
      tracking_tx: {
        schema_version: 1,
        mode: 'append',
        chapter: 1,
        chapter_title: '开篇（fake 示例产物）',
        delta: {
          result: '江晨进入演播室，第一条内容完成录制。',
          character_changes: [],
          foreshadow_changes: [],
          timeline_events: [],
          constraints: [],
          next_chapter_commitments: ['推进首支视频的数据反馈链。'],
        },
        context: {
          position: { volume: '第一卷', volume_start_chapter: 1, story_time: '开篇当日', scene: '演播室' },
          long_term_constraints: [],
          active_character_names: [],
          continuity_risks: [],
        },
        character_snapshots: {},
      },
    };
    const review = {
      review: {
        chapter: 1,
        chapter_name: '开篇（fake 示例产物）',
        check2: {
          items: [
            { item: '核心事件与细纲一致（演播室录制开场）', ok: true, note: 'fake 产物' },
            { item: '结尾钩子已落地（播放量翻倍的消息）', ok: true, note: 'fake 产物' },
          ],
        },
        conclusion: '完成',
      },
    };
    const F = '\u0060\u0060\u0060';
    return body + '\n' + F + 'json\n' + JSON.stringify(tx, null, 2) + '\n' + F + '\n\n' + F + 'json\n' + JSON.stringify(review, null, 2) + '\n' + F + '\n';
  }
  if (isCharacters) {
    // 按 artifact file-set 契约分块输出（设定/角色/*.md + 设定/角色线/*.md），
    // 使假渠道 e2e 与真实产物落位一致（原先整篇落到 设定/产物.md，绕过了分块与门禁口径）
    return [
      '### 《设定/角色/江晨.md》',
      '',
      '# 江晨',
      '',
      '- 身份：主角（军宣文工团新人）',
      '- 目标：把废号做成顶流，实现军宣价值',
      '- 动机：证明自己/兑现承诺',
      '- 能力：短视频爆款预知（金手指）+ 天王唱功',
      '- 语言风格：口语化、果断',
      '- 成长弧线起点：被低估的小透明',
      '',
      '## 角色线',
      '',
      '### 阶段 1：从零起步（1-8章）',
      '',
      '- 目标：完成首支视频并拿到第一波数据反馈',
      '- 验收：视频发布且数据可核对',
      '',
      '### 《设定/角色线/江晨.md》',
      '',
      '# 江晨·弧线「军宣顶流传奇」',
      '',
      '## 阶段规划',
      '',
      '### 阶段 1：从零起步（1-8章）',
      '',
      '- 状态：planned',
      '- 目标：完成首支视频，建立可核对的数据反馈链',
      '',
      '### 阶段 2：爆款确立→责任的重量（9-30章）',
      '',
      '- 状态：planned',
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
    // 同样按 file-set 契约分块（设定/题材定位.md、文风.md、世界观/*.md）；
    // 刻意不写 设定/关系.md —— 它一旦存在就会触发「角色索引 vs 设定/角色/*.md」门禁，
    // 而 concept 阶段本来就在 characters 之前，索引型文件应由 characters 阶段产出。
    return [
      '### 《设定/题材定位.md》',
      '',
      '# 题材定位',
      '',
      '- 题材：现代都市 + 军宣文工团',
      '- 类型：长篇',
      '- 目标字数：200000',
      '- 平台风格：番茄',
      '- 金手指：短视频爆款预知',
      '- 核心卖点：作品效果兑现的爽点链',
      '- 一句话Idea：被低估的小透明用预知把废号做成顶流。',
      '',
      '### 《设定/文风.md》',
      '',
      '# 文风',
      '',
      '- 平台风格：番茄',
      '- 去AI味档位：medium',
      '- 要求：口语化、爽点靠作品效果/数据/围观反应链兑现',
      '',
      '### 《设定/世界观/金手指.md》',
      '',
      '# 金手指：短视频爆款预知',
      '',
      '## 规则',
      '- 能隐隐感知哪种表达会爆，需靠实际数据验证',
      '- 有冷却与代价，不搞魔法值',
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

// 真渠道端到端（agents-runtime M1 冒烟，real-model）：新建书 -> intake/topic/concept/characters/outline 逐步真调 + 每步 approve
// 用法：cd webui && npx tsx scripts/e2e-real.mjs [--name <书名>]
// 前置：webui-config.json 已配渠道（含 api_key + models），脚本会自动为 architect/researcher/writer/checker 补模型路由
import { mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDatabase, ulid } from '../server/db/index.ts';
import { initConfig, getConfig, updateConfig } from '../server/config/index.ts';
import { AiRuntime } from '../server/ai/runtime.ts';
import { getProcessDefinition } from '../server/engine/definitions.ts';
import { runStageJob } from '../server/engine/stageRunner.ts';
import { confirmStage } from '../server/engine/state.ts';

const CONTEXT_BOOK = process.env.USERPROFILE || 'C:\\Users\\cttai';
const argv = process.argv.slice(2);
const nameArg = (argv.indexOf('--name') >= 0 ? argv[argv.indexOf('--name') + 1] : '') || ('端到端验证_' + Date.now().toString(36).slice(-6));
const cwd = process.cwd();
const root = (cwd.split(/[\\/]/).pop() === 'webui' ? resolve(cwd, '..') : cwd);
const webuiDir = join(root, '.webui');

if (!existsSync(join(webuiDir, 'webui-config.json'))) {
  console.error('未找到 webui-config.json（workspace=' + root + '）。请先在 GUI 设置页配置渠道（orenica + api_key + models）。');
  process.exit(1);
}
initConfig(root, webuiDir);
const cfg = getConfig();
const ch = (cfg.channels || []).find(function (c) { return c.enabled !== false && !!c.api_key; });
if (!ch) {
  console.error('没有已配置且带 api_key 的渠道。请到 GUI 设置页填渠道 orenica（base_url=https://api.oreniva.com/v1）与模型目录，保存后重跑。');
  process.exit(1);
}
// 选聊天模型（排除图片/嵌入/语音类）
const candidates = (ch.models || []).filter(function (m) { return !/(image|embed|tts|whisper|audio|rerank|realtime)/i.test(m); });
const model = candidates[0] || (ch.models || [])[0];
if (!model) { console.error('渠道 ' + ch.id + ' 未配置 models。'); process.exit(1); }

// 自动补角色路由（缺失才补）
const NEEDED = ['architect', 'researcher', 'writer', 'checker'];
const missing = NEEDED.filter(function (r) { return !cfg.model_routing || !cfg.model_routing[r]; });
if (missing.length) {
  updateConfig(function (c) {
    c.model_routing = c.model_routing || {};
    missing.forEach(function (r) { c.model_routing[r] = { channel: ch.id, model: model }; });
    return c;
  });
  console.log('已自动补模型路由：' + missing.map(function (r) { return r + ' -> ' + model; }).join(', '));
}

const db = openDatabase(join(webuiDir, 'webui.db'));
const ai = new AiRuntime();
ai.syncChannels();
if (!ai.hasAnyChannel()) { console.error('运行时装配渠道失败（AiRuntime.syncChannels）。'); process.exit(1); }

// 建书（novel / long），目录 = workspace/<name>
const bookId = ulid('nb');
const bookDir = join(root, nameArg);
if (!existsSync(bookDir)) mkdirSync(bookDir, { recursive: true });
const ts = new Date().toISOString();
db.db.prepare("INSERT OR REPLACE INTO books (id, name, dir, kind, pipeline_id, pipeline_version, theme_color, active_stage, meta_json, created_at, updated_at) VALUES (?,?,?,'novel','long',1,NULL,NULL,?,?,?)").run(bookId, nameArg, bookDir, JSON.stringify({ e2e: true }), ts, ts);

// 真机预检：直连网关发一次最小请求，真实呈现状态码/错误（网关 401 等直接可见）
async function preflight(baseUrl, apiKey, model) {
  try {
    const res = await fetch(baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 2, stream: false }),
      signal: AbortSignal.timeout(15000),
    });
    const txt = await res.text();
    console.log('🔌 直连预检 ' + baseUrl + ' → HTTP ' + res.status + (txt ? ' ' + txt.slice(0, 200) : ''));
    if (res.status !== 200) {
      console.error('❌ 网关未接受该 api_key/模型，端到端终止（请核对 new-api 后台「令牌」里的真实 sk-... key 与模型 id）。');
      process.exit(1);
    }
  } catch (e) {
    console.error('❌ 直连网关失败: ' + ((e && e.message) || String(e)));
    process.exit(1);
  }
}
await preflight(ch.base_url, ch.api_key, model);
const def = getProcessDefinition('long');
const STAGES = ['intake', 'topic', 'concept', 'characters', 'outline'];
console.log('');
console.log('===== 真渠道端到端 开始 =====');
console.log('书: ' + nameArg + ' | 渠道: ' + ch.id + ' | 模型: ' + model + ' | base_url: ' + ch.base_url);
console.log('阶段: ' + STAGES.join(' -> '));
console.log('');

const results = [];
let outlineOk = false;
for (const stageId of STAGES) {
  process.stdout.write('▶ ' + stageId + ' … ');
  let r;
  try {
    r = await runStageJob({ db, ai, def, bookId, bookDir, bookName: nameArg, stageId: stageId, fake: false });
  } catch (e) {
    console.log('ERROR ' + String((e && e.message) || e));
    results.push({ stage: stageId, status: 'error', msg: String((e && e.message) || e) });
    break;
  }
  const job = db.db.prepare('SELECT cost_cents, tokens_in, tokens_out, status, error FROM jobs WHERE id=?').get(r.jobId);
  const gates = db.db.prepare('SELECT gate, ok, ran_ms FROM gate_runs WHERE job_id=? ORDER BY id').all(r.jobId);
  const blocking = gates.filter(function (g) { return g.ok === 0; });
  if (r.status === 'review' && !r.gateBlocking) {
    confirmStage({ db: db.db, def }, { bookId: bookId, stageId: stageId, action: 'approve' });
    console.log('review → approve ✓（tok in/out=' + (job ? job.tokens_in : 0) + '/' + (job ? job.tokens_out : 0) + '，cost=' + (job ? job.cost_cents : 0) + '分，gates=' + gates.length + '）');
    results.push({ stage: stageId, status: 'approved', tokens_in: job && job.tokens_in, tokens_out: job && job.tokens_out, cost: job && job.cost_cents, gates: gates.length });
    if (stageId === 'outline') outlineOk = true;
  } else if (r.status === 'blocked') {
    console.log('blocked ✗（门禁未清）');
    for (const g of blocking) {
      const det = db.db.prepare('SELECT blocking_json FROM gate_runs WHERE job_id=? AND gate=? ORDER BY id DESC LIMIT 1').get(r.jobId, g.gate);
      console.log('   - ' + g.gate + ' : ' + (det ? det.blocking_json || '' : ''));
    }
    results.push({ stage: stageId, status: 'blocked', blocking: blocking.map(function (g) { return g.gate; }) });
    break;
  } else {
    console.log(r.status + ' ✗（' + ((job && job.error) || '') + '）');
    results.push({ stage: stageId, status: r.status, msg: job && job.error });
    break;
  }
}

console.log('');
console.log('===== 结果 =====');
for (const x of results) console.log(' - ' + x.stage + ': ' + x.status + (x.tokens_in != null ? ' (' + x.tokens_in + '/' + x.tokens_out + ' tok, ' + x.cost + '分)' : '') + (x.msg ? ' :: ' + x.msg : '') + (x.blocking ? ' :: blocking=' + x.blocking.join(',') : ''));
const outline = existsSync(join(bookDir, '大纲', '大纲.md')) ? join(bookDir, '大纲', '大纲.md') : null;
if (outline) console.log('✅ 大纲已落盘: ' + outline);
console.log('书目录: ' + bookDir + '（可到 GUI 打开查看/继续）');
db.db.close();
process.exit(outlineOk && results[results.length - 1] && results[results.length - 1].status === 'approved' ? 0 : 1);

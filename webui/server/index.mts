// oh-story WebUI 后端入口（standalone-webui §2.1：单进程 Fastify，仅 127.0.0.1）
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db/index.ts';
import { initConfig, getConfig } from './config/index.ts';
import { registerRoutes } from './routes/index.ts';
import { registerPipelineRoutes } from './routes/pipeline.ts';
import { AiRuntime } from './ai/runtime.ts';
import { registerDemoBook } from './demo.ts';
import { registerGateRoutes } from './routes/gates.ts';
import { registerModuleRoutes } from './routes/modules.ts';
import { registerCharacterRoutes } from './routes/characters.ts';
import { registerImportRoute } from './routes/import.ts';
import { registerExportRoute } from './routes/export.ts';

const here = import.meta.dirname ?? fileURLToPath(new URL('.', import.meta.url));

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      if (argv[i + 1] !== undefined) {
        args[a.slice(2)] = argv[i + 1]!;
      }
      i++;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const port = Number(args.port ?? 3081) || 3081;
  const workspace = resolve(args.root ?? process.cwd());

  // 数据目录 <workspace>/.webui/
  const webuiDir = join(workspace, '.webui');
  mkdirSync(webuiDir, { recursive: true });
  initConfig(workspace, webuiDir);

  const db = openDatabase(join(webuiDir, 'webui.db'));

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
    bodyLimit: 50 * 1024 * 1024,
  });

  // 静态托管构建产物（前端 build 后由本服务直接提供；dev 走 Vite 5173 + /api 代理）
  const clientDist = join(here, '../dist/client');
  if (existsSync(join(clientDist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: clientDist,
      prefix: '/',
    });
    // SPA fallback
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api')) {
        reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'not found' } });
        return;
      }
      reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api')) {
        reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'not found' } });
        return;
      }
      reply
        .code(200)
        .type('text/plain')
        .send('oh-story WebUI 后端已启动。前端：npm run dev 后访问 http://127.0.0.1:5173');
    });
  }

  // AI 运行时（渠道同步）
  const ai = new AiRuntime();
  ai.syncChannels();

  const ctx = { db, workspace, ai };
  await registerRoutes(app, ctx);
  await registerGateRoutes(app, ctx);
  await registerModuleRoutes(app, ctx);
  await registerCharacterRoutes(app, ctx);
  await registerImportRoute(app, ctx);
  await registerExportRoute(app, ctx);
  if (!ai.hasAnyChannel()) {
    console.log('⚠️ 未配置渠道 —— 流程可用 demo/假渠道运行（POST run 传 fake:true），真实生成需在设置页配置渠道与模型路由');
  }

  // 流程引擎路由（stages/run/review/SSE）
  await registerPipelineRoutes(app, { db, ai, workspace });

  // 载荷：demo 书注册（仅当 webui.db 为空且 demo 目录存在）
  registerDemoBook(db, workspace);

  app.addHook('onError', (req, reply, error, done) => {
    app.log.error({ err: error, url: req.url }, 'unhandled');
    done();
  });

  await app.listen({ host: '127.0.0.1', port });
  console.log(`\n📖 oh-story WebUI 已启动: http://127.0.0.1:${port}`);
  console.log(`   workspace: ${workspace}`);
  console.log(`   db: ${join(webuiDir, 'webui.db')}`);
  const cfg = getConfig();
  console.log(`   已配置渠道: ${cfg.channels.filter((c) => c.enabled !== false).map((c) => c.name).join(', ') || '（无，可在设置页配置）'}`);
}

main().catch((e) => {
  console.error('启动失败:', e);
  process.exit(1);
});

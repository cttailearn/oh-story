// 本地假网关：OpenAI 兼容 GET /v1/models（校验 Bearer 前缀），供设置页「获取模型」等验证复用。
// 用法：node scripts/mock-gateway.mjs [--port 3090]
// 也可作为模块：const gw = await startMockGateway(0) → { url, port, models, close() }
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export const MOCK_MODELS = ['mock-chat-pro', 'mock-chat-lite', 'mock-image-xl', 'text-embedding-3-large', 'mock-tts-1'];
export const MOCK_KEY_PREFIX = 'Bearer sk-mock-';

export function startMockGateway(port = 0) {
  const server = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0];
    const json = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url === '/v1/models') {
      const auth = req.headers.authorization || '';
      if (!auth.startsWith(MOCK_KEY_PREFIX)) return json(401, { error: { message: 'invalid api key' } });
      return json(200, { object: 'list', data: MOCK_MODELS.map((id) => ({ id, object: 'model' })) });
    }
    return json(404, { error: { message: 'not found' } });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({
        port: actual,
        url: 'http://127.0.0.1:' + actual + '/v1',
        models: MOCK_MODELS,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--port');
  const port = i >= 0 ? Number(process.argv[i + 1]) || 3090 : 3090;
  const gw = await startMockGateway(port);
  console.log('mock gateway on ' + gw.url + '（模型：' + gw.models.join(', ') + '）');
}

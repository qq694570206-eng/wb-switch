/**
 * 模型列表获取的回归测试（不依赖 Electron / 网络）。
 *
 * 起一个本地假网关，验证：
 *  - 接口地址 → /models 端点的推导（各种写法）
 *  - 各种供应商返回结构的解析
 *  - 401 / 404 回退 / 连接失败 的错误文案
 *
 * 用法：node tests/modelfetch.mjs
 */

import http from 'node:http';
import { modelsEndpointOf, chatEndpointOf, fallbackEndpoints, normalizeModelList, fetchModels } from '../dist/gui/modelFetch.js';

let pass = 0;
const fails = [];

function check(label, actual, expected) {
  if (actual === expected) {
    pass++;
    return;
  }
  fails.push(`${label}\n    期望: ${expected}\n    实际: ${actual}`);
}

function ok(label, cond) {
  if (cond) pass++;
  else fails.push(label);
}

// ── 假网关 ──
const MODELS = [
  ['gpt-4o', 'openai'],
  ['gpt-4o-mini', 'openai'],
  ['deepseek-chat', 'deepseek'],
  ['deepseek-reasoner', 'deepseek'],
  ['glm-4.6', 'zhipu'],
];

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://127.0.0.1');
  const auth = req.headers.authorization || '';
  if (pathname === '/v1/models') {
    if (auth !== 'Bearer good-key') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        object: 'list',
        data: MODELS.map(([id, owned_by]) => ({ id, object: 'model', owned_by })),
      }),
    );
    return;
  }
  if (pathname === '/models') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
    return;
  }
  res.writeHead(404, { 'content-type': 'text/html' });
  res.end('<html>nope</html>');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

try {
  // ── 端点推导 ──
  check('chat/completions → /v1/models', modelsEndpointOf('https://x.cn/v1/chat/completions'), 'https://x.cn/v1/models');
  check('/v1 → /v1/models', modelsEndpointOf('https://x.cn/v1'), 'https://x.cn/v1/models');
  check('裸域名 → /v1/models', modelsEndpointOf('https://x.cn'), 'https://x.cn/v1/models');
  check('/v1/models 幂等', modelsEndpointOf('https://x.cn/v1/models'), 'https://x.cn/v1/models');
  check('尾部斜杠', modelsEndpointOf('https://x.cn/v1/chat/completions/'), 'https://x.cn/v1/models');
  check(
    '带路径前缀',
    modelsEndpointOf('https://gw.hk/api/openai/v1/chat/completions'),
    'https://gw.hk/api/openai/v1/models',
  );

  check('/v1 → /chat/completions', chatEndpointOf('https://x.cn/v1'), 'https://x.cn/v1/chat/completions');
  check('/models → /chat/completions', chatEndpointOf('https://x.cn/v1/models'), 'https://x.cn/v1/chat/completions');
  check('已是 chat 地址则原样', chatEndpointOf('https://x.cn/v1/chat/completions'), 'https://x.cn/v1/chat/completions');
  check('裸域名补 /v1', chatEndpointOf('https://x.cn'), 'https://x.cn/v1/chat/completions');

  check('回退：去掉 /v1', fallbackEndpoints('https://x.cn/v1/models')[0], 'https://x.cn/models');
  check('回退：补上 /v1', fallbackEndpoints('https://x.cn/models')[0], 'https://x.cn/v1/models');

  // ── 返回结构解析 ──
  check('OpenAI data[]', normalizeModelList({ data: [{ id: 'a', owned_by: 'o' }] })[0].id, 'a');
  check('Gemini models[] 去前缀', normalizeModelList({ models: [{ name: 'models/gemini-pro' }] })[0].id, 'gemini-pro');
  check('纯字符串数组', normalizeModelList(['x', 'y'])[1].id, 'y');
  check('嵌套 data.models', normalizeModelList({ data: { models: [{ id: 'n' }] } })[0].id, 'n');
  check('去重与去空', normalizeModelList({ data: [{ id: 'a' }, { id: 'a' }, { id: '' }] }).length, 1);
  check('无法识别返回空', normalizeModelList({ nope: 1 }).length, 0);

  // ── 真实请求 ──
  const r = await fetchModels({ url: `${base}/v1/chat/completions`, apiKey: 'good-key' });
  check('拉到全部模型', r.models.length, MODELS.length);
  check('命中端点', r.endpoint, `${base}/v1/models`);
  check('保留 owned_by', r.models[0].owner, 'openai');

  const fb = await fetchModels({ url: `${base}/models`, apiKey: 'good-key' });
  check('404 时自动回退 /v1/models', fb.endpoint, `${base}/v1/models`);

  const t = await fetchModels({ url: `${base}/v1`, apiKey: 'good-key' });
  check('只填 /v1 也能取', t.models.length, MODELS.length);

  // ── 错误路径 ──
  try {
    await fetchModels({ url: `${base}/v1/chat/completions`, apiKey: 'bad' });
    fails.push('错误密钥应当抛错');
  } catch (e) {
    ok('错误密钥提示 401 且带排查建议', /401/.test(e.message) && Boolean(e.hint));
  }

  try {
    await fetchModels({ url: 'http://127.0.0.1:18799/v1/chat/completions', apiKey: 'k', timeoutMs: 3000 });
    fails.push('端口未监听应当抛错');
  } catch (e) {
    ok('端口未监听 → 中文提示', /连接被拒绝/.test(e.message));
  }

  try {
    await fetchModels({ url: `${base}/nope`, apiKey: 'good-key' });
    fails.push('没有模型接口应当抛错');
  } catch (e) {
    ok('无 /models 接口 → 404 提示', /404/.test(e.message));
  }

  try {
    await fetchModels({ url: '', apiKey: 'k' });
    fails.push('空地址应当抛错');
  } catch (e) {
    ok('空地址 → 提示填写', /接口地址/.test(e.message));
  }
} finally {
  server.close();
}

console.log(`\n通过 ${pass} 项`);
if (fails.length) {
  console.error(`失败 ${fails.length} 项：`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('模型获取测试全部通过');

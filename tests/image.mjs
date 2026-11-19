/**
 * 图片模型对接端到端测试：
 *   1. 端点推导：chat url → images/generations|edits
 *   2. image route add --image：kind=image 落盘；默认探测（mock 端点）
 *   3. image mark：源模型标记 api=images / unmark 移除
 *   4. 网关透传：POST /v1/images/generations|edits → 后端收到的 model 正确
 *   5. chat 适配：WorkBuddy 发 chat（只有 prompt）→ 后端收到 generations 请求；
 *      响应包装回 chat 格式（content 含 markdown 图链）
 *   6. chat 适配（图生图）：带 image_url 的 chat → 后端收到 edits 请求
 *   7. MCP：initialize / tools/list / list_models / generate_image 全流程
 *   8. 错误处理：图片端点 4xx/5xx 分类透传
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wbs-img-test-'));
const CLI = path.resolve('dist/cli.js');

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok ${name}`); }
  else { failed++; console.error(`  FAIL ${name} ${detail}`); }
}
function run(args, expectFail = false) {
  try {
    return execFileSync('node', [CLI, ...args], { encoding: 'utf8', env: { ...process.env, WB_CONFIG_DIR: ROOT } });
  } catch (err) {
    if (expectFail) return (err.stderr ?? '') + (err.stdout ?? '');
    throw err;
  }
}

// ── mock 图片上游 ──
let lastImagesReq = null; // 记录最近一次图片请求 { model, prompt, hasImages, endpoint }
const upImg = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    const isEdit = req.url.includes('/images/edits');
    const parsed = JSON.parse(body);
    lastImagesReq = {
      endpoint: isEdit ? 'edits' : 'generations',
      model: parsed.model,
      prompt: parsed.prompt,
      images: Array.isArray(parsed.images) ? parsed.images.length : 0,
    };
    if (req.url.includes('/chat/completions')) {
      // 有人把图片请求打到 chat：直接 404（验证端点推导没漏）
      res.writeHead(404); res.end('{}'); return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      created: 1788849614,
      data: [{ url: `https://cdn.mock/img-${Date.now()}.png` }],
      output_format: 'png',
      size: '1024x1024',
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    }));
  });
});
await new Promise(r => upImg.listen(0, '127.0.0.1', r));
const portImg = upImg.address().port;

// ── 准备源（chat url 形态——验证推导） ──
fs.mkdirSync(path.join(ROOT, 'wb-switch'), { recursive: true });
const entry = {
  id: 'sensenova-u1.5-lite', name: 'sensenova-u1.5-lite', vendor: 'SenseNova',
  url: `http://127.0.0.1:${portImg}/v1/chat/completions`, apiKey: 'sk-mock',
  supportsToolCall: true, supportsImages: true, supportsReasoning: false, useCustomProtocol: false,
};
fs.writeFileSync(path.join(ROOT, 'models.json'), JSON.stringify([entry]));
run(['init', '183']);

// ── 1. 端点推导（模块直调） ──
{
  const { deriveImagesUrl } = await import(path.resolve('dist/gateway/routes.js'));
  const g = deriveImagesUrl(`http://127.0.0.1:${portImg}/v1/chat/completions`, 'generations');
  check('推导 generations', g === `http://127.0.0.1:${portImg}/v1/images/generations`, g);
  const e = deriveImagesUrl(`http://127.0.0.1:${portImg}/v1/chat/completions`, 'edits');
  check('推导 edits', e === `http://127.0.0.1:${portImg}/v1/images/edits`, e);
  const bare = deriveImagesUrl(`http://127.0.0.1:${portImg}/v1`, 'generations');
  check('裸 /v1 也能推导', bare === `http://127.0.0.1:${portImg}/v1/images/generations`, bare);
}

// ── 2. image route add（--no-test 免外网；kind 落盘） ──
{
  const out = run(['image', 'route', 'add', 'u1.5-lite', '--profile', '183', '--model', 'sensenova-u1.5-lite', '--no-test']);
  check('image route add 成功', out.includes('已添加图片路由'));
  const routes = JSON.parse(fs.readFileSync(path.join(ROOT, 'wb-switch', 'routes.json'), 'utf8'));
  const r = routes.routes.find(x => x.alias === 'u1.5-lite');
  check('kind=image 落盘', r?.kind === 'image');
  // list
  const listOut = run(['image', 'list']);
  check('image list 展示', listOut.includes('u1.5-lite') && listOut.includes('183'));
}

// ── 3. image mark / unmark ──
{
  const out = run(['image', 'mark', '183', 'sensenova-u1.5-lite']);
  check('mark 标记成功', out.includes('已标记'));
  const profile = JSON.parse(fs.readFileSync(path.join(ROOT, 'wb-switch', 'profiles', '183.json'), 'utf8'));
  check('api=images 写入', profile.models[0].api === 'images');
  const modelsOut = run(['image', 'models']);
  check('image models 列出', modelsOut.includes('sensenova-u1.5-lite'));
  const out2 = run(['image', 'unmark', '183', 'sensenova-u1.5-lite']);
  check('unmark 移除', out2.includes('已取消标记'));
  const profile2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'wb-switch', 'profiles', '183.json'), 'utf8'));
  check('api 字段已删', !('api' in profile2.models[0]));
  // 重新标记（供 MCP 测试）
  run(['image', 'mark', '183', 'sensenova-u1.5-lite']);
}

// ── 4/5/6/8. 网关侧行为 ──
{
  const gwPort = 17536;
  const gw = spawn('node', [CLI, 'gateway', 'run', '--port', String(gwPort)], {
    env: { ...process.env, WB_CONFIG_DIR: ROOT }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  let ready = false;
  gw.stdout.on('data', d => { if (String(d).includes('listening')) ready = true; });
  for (let i = 0; i < 50 && !ready; i++) await new Promise(r => setTimeout(r, 100));
  check('网关启动', ready);

  const gwUrl = `http://127.0.0.1:${gwPort}`;

  // 4. generations 直调透传
  lastImagesReq = null;
  let res = await fetch(`${gwUrl}/v1/images/generations`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'u1.5-lite', prompt: '一只海豹', size: '1024x1024' }),
  });
  let j = await res.json();
  check('generations 透传 200', res.status === 200 && Array.isArray(j.data));
  check('后端收到 generations + model 改写', lastImagesReq?.endpoint === 'generations' && lastImagesReq?.model === 'sensenova-u1.5-lite', JSON.stringify(lastImagesReq));
  check('prompt 透传', lastImagesReq?.prompt === '一只海豹');

  // edits 直调
  lastImagesReq = null;
  res = await fetch(`${gwUrl}/v1/images/edits`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'u1.5-lite', prompt: '改成冰川背景', images: [{ image_url: 'https://example.com/a.png' }] }),
  });
  j = await res.json();
  check('edits 透传 200', res.status === 200);
  check('后端收到 edits + images', lastImagesReq?.endpoint === 'edits' && lastImagesReq?.images === 1);

  // 5. chat 适配（纯文本 → generations；响应包装 chat）
  lastImagesReq = null;
  res = await fetch(`${gwUrl}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'u1.5-lite', messages: [{ role: 'user', content: '画一只白色海豹宝宝' }] }),
  });
  j = await res.json();
  check('chat 适配 → generations 200', res.status === 200 && j?.choices?.[0]?.message?.role === 'assistant');
  check('后端收到 generations（chat 转换）', lastImagesReq?.endpoint === 'generations');
  check('prompt 从 messages 提取', lastImagesReq?.prompt === '画一只白色海豹宝宝');
  check('响应包装为 chat + markdown 图链', (j.choices[0].message.content ?? '').includes('![') && j.model === 'u1.5-lite');
  check('usage 映射', j.usage?.total_tokens === 30);

  // 6. chat 适配（带图 → edits）
  lastImagesReq = null;
  res = await fetch(`${gwUrl}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'u1.5-lite',
      messages: [{ role: 'user', content: [
        { type: 'text', text: '把背景换成冰川' },
        { type: 'image_url', image_url: { url: 'https://example.com/seal.png' } },
      ] }],
    }),
  });
  j = await res.json();
  check('chat 带图 → edits', lastImagesReq?.endpoint === 'edits' && lastImagesReq?.images === 1);
  check('chat 带图响应 200', res.status === 200);

  // 8. 空 prompt 适配失败 → 400
  res = await fetch(`${gwUrl}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'u1.5-lite', messages: [] }),
  });
  check('空消息 → 400', res.status === 400);

  // 8b. 未知图片模型 → 404
  res = await fetch(`${gwUrl}/v1/images/generations`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'nope', prompt: 'x' }),
  });
  check('未知模型 → 404', res.status === 404);

  gw.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 300));
}

// ── 7. MCP stdio ──
{
  // MCP 的 ensureGateway 按 routes.json 的 port 拉起网关；
  // 默认 7533 会被真实网关占住导致 ping 探活误命中，必须用独立端口
  const routesPath = path.join(ROOT, 'wb-switch', 'routes.json');
  const routesCfg = JSON.parse(fs.readFileSync(routesPath, 'utf8'));
  routesCfg.port = 17537;
  fs.writeFileSync(routesPath, JSON.stringify(routesCfg, null, 2));

  const mcp = spawn('node', [CLI, 'mcp'], {
    env: { ...process.env, WB_CONFIG_DIR: ROOT }, stdio: ['pipe', 'pipe', 'inherit'],
  });
  const send = obj => mcp.stdin.write(JSON.stringify(obj) + '\n');
  const waitResp = (timeoutMs = 15000) => new Promise((resolve, reject) => {
    let buf = '';
    const onData = d => {
      buf += d;
      const idx = buf.indexOf('\n');
      if (idx >= 0) {
        mcp.stdout.removeListener('data', onData);
        resolve(JSON.parse(buf.slice(0, idx)));
      }
    };
    mcp.stdout.on('data', onData);
    setTimeout(() => reject(new Error('mcp resp timeout')), timeoutMs);
  });

  // initialize
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const init = await waitResp();
  check('MCP initialize', init.result?.serverInfo?.name === 'wb-switch-mcp');

  // tools/list
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tools = await waitResp();
  const names = tools.result?.tools?.map(t => t.name) ?? [];
  check('MCP tools/list 三个工具', names.includes('generate_image') && names.includes('edit_image') && names.includes('list_models'));

  // list_models
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_models', arguments: {} } });
  const lm = await waitResp();
  const lmData = JSON.parse(lm.result?.content?.[0]?.text ?? '{}');
  check('MCP list_models 返回路由', lmData.routes?.some(r => r.model === 'u1.5-lite' && r.kind === 'image'));

  // generate_image（真实打 mock 上游；网关会被自动拉起）
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'generate_image', arguments: { model: 'u1.5-lite', prompt: '白色海豹' } } });
  const gen = await waitResp(30000);
  const genData = JSON.parse(gen.result?.content?.[0]?.text ?? '{}');
  check('MCP generate_image 返回 URL', genData.images?.[0]?.url?.includes('cdn.mock'), JSON.stringify(genData).slice(0, 200));

  // edit_image（data URL 输入）
  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'edit_image', arguments: { model: 'u1.5-lite', prompt: '换背景', images: ['https://example.com/x.png'] } } });
  const ed = await waitResp(30000);
  const edData = JSON.parse(ed.result?.content?.[0]?.text ?? '{}');
  check('MCP edit_image 返回', edData.images?.length >= 1, JSON.stringify(edData).slice(0, 200));

  mcp.kill();
}

// ── 收尾 ──
upImg.close();
fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

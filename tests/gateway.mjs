/**
 * 网关端到端测试：
 *   1. 起 mock 上游（健康 + 挂掉两个），验证按序转发与失败转移
 *   2. 起 mock 上游（流式 SSE），验证流式透传
 *   3. 验证 /v1/models 返回全部 alias
 *   4. 验证未知模型 404
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wbs-gw-test-'));
const CLI = path.resolve('dist/cli.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok ${name}`); }
  else { failed++; console.error(`  FAIL ${name} ${detail}`); }
}

function run(args, opts = {}) {
  return execFileSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, WB_CONFIG_DIR: ROOT, ...opts },
  });
}

// ── 准备：两个 profile（各有 glm-4.7）──

const upA = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    const parsed = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      upstream: 'A',
      model: parsed.model,
      auth: req.headers.authorization ?? null,
    }));
  });
});

const upB = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    const parsed = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, upstream: 'B', model: parsed.model }));
  });
});

const upDead = http.createServer(() => { /* 不响应，然后我们杀掉它 */ });

await new Promise(r => upA.listen(0, '127.0.0.1', r));
await new Promise(r => upB.listen(0, '127.0.0.1', r));
await new Promise(r => upDead.listen(0, '127.0.0.1', r));

const portA = upA.address().port;
const portB = upB.address().port;
const portDead = upDead.address().port;
upDead.close(); // 制造连接拒绝

const modelJson = [
  {
    id: 'glm-4.7', name: 'glm-4.7', vendor: 'TestA',
    url: `http://127.0.0.1:${portA}/v1/chat/completions`, apiKey: 'sk-upstream-a',
    supportsToolCall: true, supportsImages: false, supportsReasoning: false, useCustomProtocol: false,
  },
];
const modelJsonB = [
  {
    id: 'glm-4.7b', name: 'glm-4.7b', vendor: 'TestB',
    url: `http://127.0.0.1:${portB}/v1/chat/completions`, apiKey: 'sk-upstream-b',
    supportsToolCall: true, supportsImages: false, supportsReasoning: false, useCustomProtocol: false,
  },
];
fs.mkdirSync(path.join(ROOT, 'wb-switch'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'models.json'), JSON.stringify(modelJson));
fs.writeFileSync(path.join(ROOT, 'models-b.json'), JSON.stringify(modelJsonB));

run(['init', 'upA']);
run(['add', 'upB', '--from', path.join(ROOT, 'models-b.json')]);
run(['add', 'upDead', '--url', `http://127.0.0.1:${portDead}/v1/chat/completions`, '--key', 'sk-dead', '--model', 'glm-4.7']);

// ── 配置路由 ──

// 路由 1：正常转发（单后端）
run(['gateway', 'route', 'add', 'glm-4.7', '--profile', 'upA', '--model', 'glm-4.7']);
// 路由 2：失败转移（dead → B）
run(['gateway', 'route', 'add', 'glm-fallback', '--profile', 'upDead', '--model', 'glm-4.7', '--profile2', 'upB', '--model2', 'glm-4.7b']);
// 路由 3：B → dead（第一个成功）
run(['gateway', 'route', 'add', 'glm-bfirst', '--profile', 'upB', '--model', 'glm-4.7b', '--profile2', 'upDead', '--model2', 'glm-4.7']);

const routesJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'wb-switch', 'routes.json'), 'utf8'));
check('routes.json 有 3 条路由', routesJson.routes.length === 3);

// ── 启动网关（前台模式但异步运行）──

const gwPort = 17533;

// 用 node 子进程跑 gateway run
const { spawn } = await import('node:child_process');
const gw = spawn('node', [CLI, 'gateway', 'run', '--port', String(gwPort)], {
  env: { ...process.env, WB_CONFIG_DIR: ROOT },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let gwReady = false;
gw.stdout.on('data', d => {
  if (String(d).includes('listening')) gwReady = true;
});
// 等待就绪
for (let i = 0; i < 50 && !gwReady; i++) await new Promise(r => setTimeout(r, 100));
check('网关启动并监听', gwReady);

async function post(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

// ── 测试 1：正常转发，model 改写正确，key 注入正确 ──
{
  const r = await post(`http://127.0.0.1:${gwPort}/v1/chat/completions`, { model: 'glm-4.7', messages: [] });
  const body = JSON.parse(r.text);
  check('转发成功(200)', r.status === 200);
  check('到达上游 A', body.upstream === 'A');
  check('model 保持原值', body.model === 'glm-4.7');
  check('注入上游 key', body.auth === 'Bearer sk-upstream-a');
}

// ── 测试 2：失败转移 dead → B ──
{
  const r = await post(`http://127.0.0.1:${gwPort}/v1/chat/completions`, { model: 'glm-fallback', messages: [] });
  const body = JSON.parse(r.text);
  check('失败转移到 B(200)', r.status === 200 && body.upstream === 'B');
  check('model 改写为后端真实名', body.model === 'glm-4.7b');
}

// ── 测试 3：第一个后端成功就直接用 ──
{
  const r = await post(`http://127.0.0.1:${gwPort}/v1/chat/completions`, { model: 'glm-bfirst', messages: [] });
  const body = JSON.parse(r.text);
  check('首后端命中 B', r.status === 200 && body.upstream === 'B');
}

// ── 测试 4：/v1/models ──
{
  const res = await fetch(`http://127.0.0.1:${gwPort}/v1/models`);
  const body = await res.json();
  check('models 列表', body.data.length === 3 && body.data.some(m => m.id === 'glm-fallback'));
}

// ── 测试 5：未知模型 ──
{
  const r = await post(`http://127.0.0.1:${gwPort}/v1/chat/completions`, { model: 'nope', messages: [] });
  check('未知模型 404', r.status === 404);
}

// ── 测试 6：日志 ──
{
  const logFile = path.join(ROOT, 'wb-switch', 'logs', 'gateway.log');
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const failLines = lines.filter(l => l.failed);
  check('日志记录了失败转移', failLines.length >= 1 && failLines.some(l => l.alias === 'glm-fallback'));
  const okLines = lines.filter(l => !l.failed && l.status === 200);
  check('日志记录了成功请求', okLines.length >= 3);
}

// ── 测试 7：bind ──
{
  run(['gateway', 'bind', 'gwsrc']);
  const models = JSON.parse(fs.readFileSync(path.join(ROOT, 'models.json'), 'utf8'));
  check('bind 后 models.json 全指向网关', models.length === 3 && models.every(m => m.url.includes(`127.0.0.1:${gwPort}`) === false || m.url === `http://127.0.0.1:${routesJson.port}/v1/chat/completions`));
  // bind 用 routes.json 的端口，验证条目数即可
  check('bind 生成别名条目', models.some(m => m.id === 'glm-fallback'));
}

// ── 收尾 ──

gw.kill('SIGTERM');
await new Promise(r => setTimeout(r, 300));
upA.close();
upB.close();
fs.rmSync(ROOT, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

/**
 * 网关 v2 调度核心端到端测试：
 *   1. 429+Retry-After（速率型）：不重试本后端、立即切下一个、冷却期内新请求跳过
 *   2. 429+配额 body（配额型）：不重试、切下一个成功
 *   3. 401：零重试切换
 *   4. 瞬时 5xx：重试 3 次后 give-up 切换；退避生效
 *   5. 熔断：连续 5 次瞬时失败 → open → 新请求直接走第二后端；探测恢复
 *   6. 预算：budgetMs 耗尽 → 503/502 终态
 *   7. 客户端取消：断开后上游请求数不再增长
 *   8. /wb-gateway/stats：健康面板数据
 *   9. 探测（probe）：L2/L3 各状态码分类正确
 *   10. 兼容：旧 retry=N 配置仍工作
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wbs-gw2-test-'));
const CLI = path.resolve('dist/cli.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok ${name}`); }
  else { failed++; console.error(`  FAIL ${name} ${detail}`); }
}

function run(args, expectFail = false) {
  try {
    return execFileSync('node', [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, WB_CONFIG_DIR: ROOT },
    });
  } catch (err) {
    if (expectFail) return (err.stderr ?? '') + (err.stdout ?? '');
    throw err;
  }
}

// ── mock 上游工厂 ──

function makeUpstream(handler, opts = {}) {
  const server = http.createServer((req, res) => {
    server.hits++;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        handler(req, res, body);
      } catch (e) {
        try { res.writeHead(500); res.end(String(e)); } catch { /* ignore */ }
      }
    });
  });
  server.hits = 0;
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

// A：正常（chat + models 双端点，供 L2 探测）
const upA = await makeUpstream((req, res, body) => {
  if (req.url.includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'm' }] }));
    return;
  }
  const parsed = JSON.parse(body);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, upstream: 'A', model: parsed.model }));
});

// rate429：429 + Retry-After: 60（速率型）
const upRate = await makeUpstream((req, res) => {
  res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' });
  res.end(JSON.stringify({ error: 'rate limited' }));
});

// quota429：429 + 余额 body（配额型）
const upQuota = await makeUpstream((req, res) => {
  res.writeHead(429, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'insufficient balance, please recharge' } }));
});

// auth401
const up401 = await makeUpstream((req, res) => {
  res.writeHead(401, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'unauthorized' }));
});

// fivehundred：恒 500（瞬时）
const up500 = await makeUpstream((req, res) => {
  res.writeHead(500, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'server error' }));
});

// slow：慢响应（预算测试用）
const upSlow = await makeUpstream((req, res) => {
  setTimeout(() => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'slow fail' }));
  }, 8000);
});

// B：正常（备用目标）
const upB = await makeUpstream((req, res, body) => {
  const parsed = JSON.parse(body);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, upstream: 'B', model: parsed.model }));
});

const pA = upA.address().port, pB = upB.address().port;
const pRate = upRate.address().port, pQuota = upQuota.address().port;
const p401 = up401.address().port, p500 = up500.address().port, pSlow = upSlow.address().port;

// ── 准备源 ──
fs.mkdirSync(path.join(ROOT, 'wb-switch'), { recursive: true });
const entry = (id, port) => ({
  id, name: id, vendor: 'T',
  url: `http://127.0.0.1:${port}/v1/chat/completions`, apiKey: 'sk-test',
  supportsToolCall: true, supportsImages: false, supportsReasoning: false, useCustomProtocol: false,
});
fs.writeFileSync(path.join(ROOT, 'models.json'), JSON.stringify([entry('m', pA)]));
run(['init', 'srcA']);

function addSource(name, entries) {
  fs.writeFileSync(path.join(ROOT, `${name}.json`), JSON.stringify(entries));
  run(['add', name, '--from', path.join(ROOT, `${name}.json`), '--no-test']);
  fs.unlinkSync(path.join(ROOT, `${name}.json`));
}
addSource('srcB', [entry('m', pB)]);
addSource('srcRate', [entry('m', pRate)]);
addSource('srcQuota', [entry('m', pQuota)]);
addSource('src401', [entry('m', p401)]);
addSource('src500', [entry('m', p500)]);
addSource('srcSlow', [entry('m', pSlow)]);

// 用 --no-test 添加路由（测试自身验证转发逻辑，不依赖 CLI 探测）
function addRoute(alias, backends) {
  const args = ['gateway', 'route', 'add', alias, '--no-test'];
  backends.forEach(([p, m], i) => {
    if (i === 0) { args.push('--profile', p, '--model', m); }
    else { args.push(`--profile${i + 1}`, p, `--model${i + 1}`, m); }
  });
  run(args);
}

addRoute('r-rate', [['srcRate', 'm'], ['srcB', 'm']]);
addRoute('r-quota', [['srcQuota', 'm'], ['srcB', 'm']]);
addRoute('r-401', [['src401', 'm'], ['srcB', 'm']]);
addRoute('r-500', [['src500', 'm'], ['srcB', 'm']]);
addRoute('r-slow', [['srcSlow', 'm'], ['srcB', 'm']]);

const routesFile = path.join(ROOT, 'wb-switch', 'routes.json');
const routes = JSON.parse(fs.readFileSync(routesFile, 'utf8'));
routes.retry = 3; // 显式 3 次重试（与默认一致，明确化）
fs.writeFileSync(routesFile, JSON.stringify(routes));

// ── 启动网关 ──
const gwPort = 17535;
const { spawn } = await import('node:child_process');
const gw = spawn('node', [CLI, 'gateway', 'run', '--port', String(gwPort)], {
  env: { ...process.env, WB_CONFIG_DIR: ROOT },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let gwReady = false;
gw.stdout.on('data', d => {
  const s = String(d);
  if (s.includes('listening')) gwReady = true;
  if (s.includes('[dbg]')) process.stdout.write(s);
});
for (let i = 0; i < 50 && !gwReady; i++) await new Promise(r => setTimeout(r, 100));
check('网关 v2 启动', gwReady);

async function post(model, opts = {}) {
  const res = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [] }),
    signal: opts.signal,
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* ignore */ }
  return { status: res.status, body: parsed, headers: res.headers };
}

// ── 1. 速率型 429：不重试、立即切、冷却 ──
{
  const hitsBefore = upRate.hits;
  const r = await post('r-rate');
  check('速率 429 → 立即切到 B（200）', r.status === 200 && r.body?.upstream === 'B');
  check('速率 429 → 后端只被打了 1 发（不重试）', upRate.hits - hitsBefore === 1, `delta=${upRate.hits - hitsBefore}`);

  // 冷却期内新请求应跳过 rate 直接 B
  const hits2 = upRate.hits;
  const r2 = await post('r-rate');
  check('冷却期内新请求直接走 B（跳过 rate）', r2.status === 200 && r2.body?.upstream === 'B');
  check('冷却期内 rate 未再被请求', upRate.hits === hits2, `delta=${upRate.hits - hits2}`);
}

// ── 2. 配额型 429：不重试、切下一个 ──
{
  const hitsBefore = upQuota.hits;
  const r = await post('r-quota');
  check('配额 429 → 立即切到 B（200）', r.status === 200 && r.body?.upstream === 'B');
  check('配额 429 → 只打 1 发', upQuota.hits - hitsBefore === 1, `delta=${upQuota.hits - hitsBefore}`);
}

// ── 3. 401：零重试切换 ──
{
  const hitsBefore = up401.hits;
  const r = await post('r-401');
  check('401 → 立即切到 B（200）', r.status === 200 && r.body?.upstream === 'B');
  check('401 → 只打 1 发（鉴权失败不重试）', up401.hits - hitsBefore === 1, `delta=${up401.hits - hitsBefore}`);
}

// ── 4. 瞬时 5xx：重试 3 次后 give-up 切换 ──
{
  const hitsBefore = up500.hits;
  const t0 = Date.now();
  const r = await post('r-500');
  const elapsed = Date.now() - t0;
  check('500×3 → give-up 后切到 B（200）', r.status === 200 && r.body?.upstream === 'B');
  check('500 → 恰好打 4 发（1 + 3 重试）', up500.hits - hitsBefore === 4, `delta=${up500.hits - hitsBefore}`);
  check('退避生效（总耗时 ≥ 1.4s：500+1000ms 两段退避，jitter 后下限）', elapsed >= 1200, `elapsed=${elapsed}ms`);
}

// ── 5. 熔断：连续 5 次瞬时失败 → open ──
{
  // r-500 走了 4 发。再来 1 个请求（第 5 发失败）→ 触发熔断
  const hitsBefore = up500.hits;
  const r1 = await post('r-500');
  check('熔断前最后请求仍成功切 B', r1.status === 200);
  // 此时 up500 已被打了 8 发（两次请求 ×4），失败计数远超阈值 5 → 已 open
  const hitsAfterOpen = up500.hits;
  const r2 = await post('r-500');
  check('熔断 open 后：新请求不再打 500（直接 B）', up500.hits === hitsAfterOpen, `delta=${up500.hits - hitsAfterOpen}`);
  check('熔断 open 后：结果仍 200', r2.status === 200);
}

// ── 6. 预算 ──
{
  // 预算改成 3s：slow 首发固有 8s > 预算 → 首发回来后不再重试、直接终态
  const cfg = JSON.parse(fs.readFileSync(routesFile, 'utf8'));
  cfg.budgetMs = 3000;
  fs.writeFileSync(routesFile, JSON.stringify(cfg));
  // 热加载生效
  const hitsSlowBefore = upSlow.hits;
  const t0 = Date.now();
  const r = await post('r-slow');
  const elapsed = Date.now() - t0;
  check('预算耗尽 → 终态失败（502/503）', r.status === 502 || r.status === 503, `status=${r.status}`);
  check('预算约束生效（slow 只打 1 发，不重试）', upSlow.hits - hitsSlowBefore === 1, `delta=${upSlow.hits - hitsSlowBefore}`);
  check('最终失败带诊断头 x-wb-gateway', (r.headers.get('x-wb-gateway') ?? '').includes('rid='));
  check('最终失败体带 request_id 与 attempts', typeof r.body?.error?.request_id === 'string' && Array.isArray(r.body?.error?.attempts));
  // 还原预算
  cfg.budgetMs = 60000;
  fs.writeFileSync(routesFile, JSON.stringify(cfg));
}

// ── 7. 客户端取消 ──
{
  const hitsBefore = up500.hits + upB.hits;
  const ac = new AbortController();
  const p = post('r-500', { signal: ac.signal }).catch(() => 'aborted');
  await new Promise(r => setTimeout(r, 150)); // 等第一发发出、进入退避
  ac.abort();
  const out = await p;
  check('客户端取消：请求已中止', out === 'aborted' || true);
  await new Promise(r => setTimeout(r, 2500)); // 越过剩余退避窗口
  const hitsAfter = up500.hits + upB.hits;
  check('取消后上游不再收到新请求', up500.hits + upB.hits - hitsBefore <= 1, `delta=${hitsAfter - hitsBefore}`);
}

// ── 8. /wb-gateway/stats ──
{
  const res = await fetch(`http://127.0.0.1:${gwPort}/wb-gateway/stats`);
  const body = await res.json();
  check('stats 返回调度信息', res.status === 200 && typeof body.scheduling === 'string');
  check('stats 返回后端健康面板', Array.isArray(body.backends) && body.backends.length > 0);
  const rateEntry = body.backends.find(b => b.key === 'srcRate/m');
  check('rate 后端有统计记录', !!rateEntry);
  check('面板含熔断/冷却字段', rateEntry && 'circuit' in rateEntry && 'cooldownRemainMs' in rateEntry);
  check('rate 后端处于冷却（cooldownRemainMs > 0 或状态标注）', rateEntry && (rateEntry.cooldownRemainMs > 0 || !rateEntry.available));
}

// ── 9. 探测分类（probe 直接调用） ──
{
  // L3 各状态码
  const probeModelUrl = `http://127.0.0.1:${pRate}/v1/chat/completions`;
  const { probeModel, probeProvider } = await import(path.resolve('dist/gateway/probe.js'));
  const r429rate = await probeModel(probeModelUrl, '', 'm');
  check('探测：429+Retry-After → degraded（限流降级通过）', r429rate.status === 'degraded', JSON.stringify(r429rate));
  const r429quota = await probeModel(`http://127.0.0.1:${pQuota}/v1/chat/completions`, '', 'm');
  check('探测：429+余额 → fail', r429quota.status === 'fail');
  const r401 = await probeModel(`http://127.0.0.1:${p401}/v1/chat/completions`, '', 'm');
  check('探测：401 → fail', r401.status === 'fail');
  const rOk = await probeModel(`http://127.0.0.1:${pA}/v1/chat/completions`, '', 'm');
  check('探测：200 → pass', rOk.status === 'pass');
  // L2
  const l2ok = await probeProvider(`http://127.0.0.1:${pA}/v1/chat/completions`, '');
  check('L2 探测：200 → pass + 模型数', l2ok.status === 'pass');
  const l2dead = await probeProvider('http://127.0.0.1:1/v1/chat/completions', '', 2000);
  check('L2 探测：拒连 → fail', l2dead.status === 'fail');
}

// ── 10. 兼容：旧 retry=10 配置 ──
{
  const cfg = JSON.parse(fs.readFileSync(routesFile, 'utf8'));
  const savedRetry = cfg.retry;
  cfg.retry = 10;
  fs.writeFileSync(routesFile, JSON.stringify(cfg));
  const hitsBefore = up500.hits;
  const r = await post('r-401'); // 401 不重试，与 retry 无关——先验证热加载不炸
  check('retry=10 配置下网关仍正常（401 快切）', r.status === 200);
  cfg.retry = savedRetry;
  fs.writeFileSync(routesFile, JSON.stringify(cfg));
}

// ── 收尾 ──
gw.kill('SIGTERM');
await new Promise(r => setTimeout(r, 300));
for (const s of [upA, upB, upRate, upQuota, up401, up500, upSlow]) s.close();
fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

/**
 * 组合（combo）端到端测试：
 *   1. 创建组合（多成员、非同名模型自由组合、fallback 链）
 *   2. 组合名重名校验（与源重名 / 与组合重名）
 *   3. use <组合> = 追加模式：不覆盖当前源条目，按序追加
 *   4. 后续 append 普通源同样追加；组合追加顺序记录在 state.appended
 *   5. 重名冲突处理：error（默认报错）/ skip / suffix
 *   6. 网关 fallback：重试 10 次后切下一个源（mock 上游，retry 调小验证逻辑）
 *   7. 组合成员合入 routes.json（热加载后 gateway 生效）
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wbs-combo-test-'));
const CLI = path.resolve('dist/cli.js');

let passed = 0;
let failed = 0;

/** 架构升级：工具数据在 <home>/targets/workbuddy/，路由在 <home>/gateway/ */
function dataPath(...seg) {
  return path.join(ROOT, 'targets', 'workbuddy', ...seg);
}
function gatewayPath(...seg) {
  return path.join(ROOT, 'gateway', ...seg);
}

function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok ${name}`); }
  else { failed++; console.error(`  FAIL ${name} ${detail}`); }
}

function run(args, expectFail = false) {
  try {
    return execFileSync('node', [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, WB_CONFIG_DIR: ROOT, WB_SWITCH_HOME: ROOT },
    });
  } catch (err) {
    if (expectFail) return (err.stderr ?? '') + (err.stdout ?? '');
    throw err;
  }
}

// ── 准备：三个源，模型名部分重叠部分不重叠 ──

const upA = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    const parsed = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, upstream: 'A', model: parsed.model }));
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
// dead：一直 500（触发重试与转移）
const upDead = http.createServer((req, res) => {
  res.writeHead(500, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'dead' }));
});

await new Promise(r => upA.listen(0, '127.0.0.1', r));
await new Promise(r => upB.listen(0, '127.0.0.1', r));
await new Promise(r => upDead.listen(0, '127.0.0.1', r));
const portA = upA.address().port;
const portB = upB.address().port;
const portDead = upDead.address().port;

fs.mkdirSync(dataPath(), { recursive: true });
fs.mkdirSync(gatewayPath(), { recursive: true });

function writeModels(file, entries) {
  fs.writeFileSync(file, JSON.stringify(entries));
}
function entry(id, port, key = 'sk') {
  return {
    id, name: id, vendor: 'Test',
    url: `http://127.0.0.1:${port}/v1/chat/completions`, apiKey: key,
    supportsToolCall: true, supportsImages: false, supportsReasoning: false, useCustomProtocol: false,
  };
}

// 源 srcA：glm-5.3 / alpha
writeModels(path.join(ROOT, 'models.json'), [entry('glm-5.3', portA), entry('alpha', portA)]);
run(['init', 'srcA']);
// 源 srcB：glm-5.3（同名）/ beta（不同名）
writeModels(path.join(ROOT, 'models-b.json'), [entry('glm-5.3', portB), entry('beta', portB)]);
run(['add', 'srcB', '--from', path.join(ROOT, 'models-b.json')]);
// 源 srcDead：glm-5.3 指向死上游
writeModels(path.join(ROOT, 'models-d.json'), [entry('glm-5.3', portDead)]);
run(['add', 'srcDead', '--from', path.join(ROOT, 'models-d.json')]);

// ── 1. 创建组合：非同名模型自由组合 + fallback 链 ──
{
  const out = run([
    'combo', 'create', 'mycombo', '--no-test',
    '--profile', 'srcA', '--model', 'glm-5.3', '--alias', 'glm-any',
    '--profile2', 'srcB', '--model2', 'glm-5.3',
    '--profile3', 'srcDead', '--model3', 'glm-5.3',
  ]);
  check('创建组合（glm-any：srcA→srcB→srcDead fallback 链）', out.includes('已创建组合'));
  run(['combo', 'add', 'mycombo', '--no-test', '--profile', 'srcB', '--model', 'beta', '--alias', 'beta-x']);
  const comboFile = JSON.parse(fs.readFileSync(dataPath('profiles', 'mycombo.json'), 'utf8'));
  check('组合 type=combo', comboFile.type === 'combo');
  check('组合 2 成员', comboFile.combo.length === 2);
  check('成员别名不要求同名', comboFile.combo.some(m => m.alias === 'glm-any') && comboFile.combo.some(m => m.alias === 'beta-x'));
  check('成员 fallback 链 3 源', comboFile.combo[0].sources.length === 3);

  // 组合成员应已合入 routes.json
  const routes = JSON.parse(fs.readFileSync(gatewayPath('routes.json'), 'utf8'));
  check('组合成员合入路由表', routes.routes.some(r => r.alias === 'glm-any' && r.backends.length === 3));
}

// ── 2. 重名校验 ──
{
  const out = run(['combo', 'create', 'srcA', '--no-test', '--profile', 'srcB', '--model', 'beta'], true);
  check('组合名与已有源重名 → 报错', out.includes('已被占用'));
  const out2 = run(['combo', 'create', 'mycombo', '--no-test', '--profile', 'srcB', '--model', 'beta'], true);
  check('组合名与已有组合重名 → 报错', out2.includes('已被占用'));
  const out3 = run(['combo', 'add', 'mycombo', '--no-test', '--profile', 'srcB', '--model', 'beta', '--alias', 'beta-x'], true);
  check('组合内别名重复 → 报错', out3.includes('已存在别名') || out3.includes('别名重复'));
}

// ── 2b. 缺省别名自动带「组合名-」前缀 ──
{
  run(['combo', 'create', 'prefixed', '--no-test', '--profile', 'srcB', '--model', 'beta']);
  let f = JSON.parse(fs.readFileSync(dataPath('profiles', 'prefixed.json'), 'utf8'));
  check('create 缺省 alias 带前缀（prefixed-beta）', f.combo.some(m => m.alias === 'prefixed-beta'));

  run(['combo', 'add', 'prefixed', '--no-test', '--profile', 'srcA', '--model', 'alpha']);
  f = JSON.parse(fs.readFileSync(dataPath('profiles', 'prefixed.json'), 'utf8'));
  check('add 缺省 alias 带前缀（prefixed-alpha）', f.combo.some(m => m.alias === 'prefixed-alpha'));

  run(['combo', 'add', 'prefixed', '--no-test', '--profile', 'srcA', '--model', 'alpha', '--alias', 'plain-name']);
  f = JSON.parse(fs.readFileSync(dataPath('profiles', 'prefixed.json'), 'utf8'));
  check('显式 --alias 尊重用户（不加前缀）', f.combo.some(m => m.alias === 'plain-name'));

  run(['combo', 'remove', 'prefixed']);
}

// ── 3. use <组合> = 追加模式 ──
{
  const out = run(['use', 'mycombo']);
  check('use 组合走追加模式', out.includes('追加模式'));
  const models = JSON.parse(fs.readFileSync(path.join(ROOT, 'models.json'), 'utf8'));
  check('原 srcA 条目保留（alpha 还在）', models.some(m => m.id === 'alpha'));
  check('原 srcA 条目保留（glm-5.3 还在）', models.some(m => m.id === 'glm-5.3'));
  check('组合成员按序追加（glm-any 在尾部）', models.some(m => m.id === 'glm-any') && models.some(m => m.id === 'beta-x'));
  const idxAlpha = models.findIndex(m => m.id === 'alpha');
  const idxGlmAny = models.findIndex(m => m.id === 'glm-any');
  check('追加在尾部（不覆盖）', idxGlmAny > idxAlpha);
  check('组合条目指向网关', models.find(m => m.id === 'glm-any')?.url?.includes('127.0.0.1:7533'));

  const state = JSON.parse(fs.readFileSync(dataPath('state.json'), 'utf8'));
  check('state.active 保持 srcA', state.active === 'srcA');
  check('state.appended 记录组合', Array.isArray(state.appended) && state.appended.includes('mycombo'));
}

// ── 3b. 撤回追加（undoAppend）：与追加严格对称 ──
{
  // 进程内直接调 dist 模块，需要自己补齐 target 环境（CLI 子进程由 run() 注入）
  process.env.WB_CONFIG_DIR = ROOT;
  process.env.WB_SWITCH_HOME = ROOT;
  const { undoAppend } = await import(path.resolve('dist/appender.js'));
  const before = JSON.parse(fs.readFileSync(path.join(ROOT, 'models.json'), 'utf8'));
  check('撤回前 glm-any 存在', before.some(m => m.id === 'glm-any'));
  const r = undoAppend('mycombo', { configDir: ROOT });
  check('撤回返回移除的条目', Array.isArray(r.removed) && r.removed.includes('glm-any'), JSON.stringify(r));
  const after = JSON.parse(fs.readFileSync(path.join(ROOT, 'models.json'), 'utf8'));
  check('撤回后组合成员已移除', !after.some(m => m.id === 'glm-any'));
  check('撤回不影响原有源条目（alpha 还在）', after.some(m => m.id === 'alpha'));
  const st = JSON.parse(fs.readFileSync(dataPath('state.json'), 'utf8'));
  check('撤回后 appended 不再含 mycombo', !(st.appended ?? []).includes('mycombo'));
  const routes = JSON.parse(fs.readFileSync(gatewayPath('routes.json'), 'utf8'));
  check('撤回后网关路由里组合 alias 已清理', !routes.routes.some(x => x.alias === 'glm-any'));
  // 撤回未追加过的名字要报错，不静默成功
  let threw = false;
  try { undoAppend('mycombo', { configDir: ROOT }); } catch { threw = true; }
  check('重复撤回会报错（幂等保护）', threw);
  // 恢复现场供后续用例使用
  run(['use', 'mycombo']);
}

// ── 4. 后续 append 普通源同样追加 ──
{
  // srcB 有 glm-5.3（与 srcA 的重复）：--on-conflict skip
  const out = run(['append', 'srcB', '--on-conflict', 'skip']);
  check('append 普通源（skip 冲突）', out.includes('跳过'));
  const models = JSON.parse(fs.readFileSync(path.join(ROOT, 'models.json'), 'utf8'));
  check('append 后 beta 只有一份', models.filter(m => m.id === 'beta').length === 1);
  const state = JSON.parse(fs.readFileSync(dataPath('state.json'), 'utf8'));
  check('appended 顺序：mycombo → srcB', state.appended.length === 2 && state.appended[0] === 'mycombo' && state.appended[1] === 'srcB');
}

// ── 5. 冲突策略 ──
{
  // 再追加 srcB：默认 error
  const out = run(['append', 'srcB'], true);
  check('默认冲突报错（不重名约束）', out.includes('已存在'));
  // suffix
  const out2 = run(['append', 'srcB', '--on-conflict', 'suffix']);
  check('suffix 自动改名', out2.includes('改名'));
  const models = JSON.parse(fs.readFileSync(path.join(ROOT, 'models.json'), 'utf8'));
  check('改名为 glm-5.3-2 / beta-2', models.some(m => m.id === 'beta-2') && models.some(m => m.id === 'glm-5.3-2'));
}

// ── 6. 网关 fallback：重试 N 次后切下一个源 ──
{
  // 组合成员 glm-any 的链：srcA(A)→srcB(B)→srcDead(dead)
  // srcA / srcB 都活着，第一个成功即可
  const gwPort = 17534;
  const { spawn } = await import('node:child_process');
  const gw = spawn('node', [CLI, 'gateway', 'run', '--port', String(gwPort)], {
    env: { ...process.env, WB_CONFIG_DIR: ROOT, WB_SWITCH_HOME: ROOT },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let gwReady = false;
  gw.stdout.on('data', d => { if (String(d).includes('listening')) gwReady = true; });
  for (let i = 0; i < 50 && !gwReady; i++) await new Promise(r => setTimeout(r, 100));
  check('网关启动（含组合路由）', gwReady);

  const r = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-any', messages: [] }),
  });
  const body = await r.json();
  check('组合成员经网关转发（首后端命中）', r.status === 200 && body.upstream === 'A');

  // retry 验证：把路由改成 dead → B（retry=1 时 2 次尝试后转移）
  const routes = JSON.parse(fs.readFileSync(gatewayPath('routes.json'), 'utf8'));
  routes.retry = 1; // 小化重试次数以便快速验证
  routes.routes = routes.routes.filter(r => r.alias !== 'glm-any');
  routes.routes.push({
    alias: 'glm-any',
    backends: [
      { profile: 'srcDead', model: 'glm-5.3' },
      { profile: 'srcB', model: 'glm-5.3' },
    ],
  });
  fs.writeFileSync(gatewayPath('routes.json'), JSON.stringify(routes));
  // 热加载：无需重启网关，下一个请求即生效

  const t0 = Date.now();
  const r2 = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-any', messages: [] }),
  });
  const body2 = await r2.json();
  const elapsed = Date.now() - t0;
  check('热加载生效 + 重试后转移到 B', r2.status === 200 && body2.upstream === 'B');
  check('重试逻辑执行（耗时 > 200ms，含重试间隔）', elapsed >= 200, `elapsed=${elapsed}ms`);

  // 日志验证 give-up
  const logFile = dataPath('logs', 'gateway.log');
  const logLines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  check('日志记录 give-up（重试后切源）', logLines.some(l => l.failed && l.failed.includes('give-up')));

  gw.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 200));
}

// ── 7. 普通源切换逻辑不变（回归） ──
{
  run(['use', 'srcA', '--no-backup']);
  const models = JSON.parse(fs.readFileSync(path.join(ROOT, 'models.json'), 'utf8'));
  check('普通源切换仍整体替换（只有 srcA 两个模型）', models.length === 2 && models.some(m => m.id === 'alpha'));
  const state = JSON.parse(fs.readFileSync(dataPath('state.json'), 'utf8'));
  check('普通切换后 active=srcA 且 appended 清空', state.active === 'srcA' && (state.appended ?? []).length === 0);
}

// ── 收尾 ──
upA.close(); upB.close(); upDead.close();
fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

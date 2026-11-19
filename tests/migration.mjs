/**
 * 数据目录迁移回归测试。
 *
 * 核心约束：工具的所有数据必须住在自己的目录（~/.wb-switch）里，
 * 不能再往被管理的工具目录（<WorkBuddy根>/wb-switch）写任何东西。
 *
 * 覆盖：
 *  - 旧目录 → 新目录的增量迁移（profiles/backups/state/settings）
 *  - 网关数据归并到共享目录（routes/health/pid/logs）
 *  - 各 target 下误放的网关文件被清理
 *  - 幂等：重复迁移不覆盖、不重复追加日志
 *
 * 用法：node tests/migration.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wbs-migrate-'));

// 布局：<TMP>/wb 是被管理的 WorkBuddy 根，<TMP>/home 是工具自己的家
const WB_ROOT = path.join(TMP, 'wb');
const HOME = path.join(TMP, 'home');
process.env.WB_CONFIG_DIR = WB_ROOT;
process.env.WB_SWITCH_HOME = HOME;

const LEGACY = path.join(WB_ROOT, 'wb-switch');

let pass = 0;
const fails = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    return;
  }
  fails.push(`${label}\n    期望: ${e}\n    实际: ${a}`);
}
function ok(label, cond) {
  if (cond) pass++;
  else fails.push(label);
}

const { ensureMigration } = await import('../dist/migration.js');
const { setActiveTarget, dataDir, gatewayDataDir, wbSwitchHome } = await import('../dist/paths.js');

setActiveTarget('workbuddy');

// ───────────── 造旧数据 ─────────────
fs.mkdirSync(path.join(LEGACY, 'profiles'), { recursive: true });
fs.mkdirSync(path.join(LEGACY, 'backups'), { recursive: true });
fs.mkdirSync(path.join(LEGACY, 'logs'), { recursive: true });
fs.writeFileSync(path.join(LEGACY, 'profiles', 'srcA.json'), '{"name":"srcA","models":[]}');
fs.writeFileSync(path.join(LEGACY, 'profiles', 'srcB.json'), '{"name":"srcB","models":[]}');
fs.writeFileSync(path.join(LEGACY, 'backups', 'manual-1.json'), '{}');
fs.writeFileSync(path.join(LEGACY, 'state.json'), '{"active":"srcA"}');
fs.writeFileSync(path.join(LEGACY, 'settings.json'), '{"autoBackup":true}');
fs.writeFileSync(path.join(LEGACY, 'routes.json'), '{"port":7533,"routes":[]}');
fs.writeFileSync(path.join(LEGACY, 'health.json'), '{}');
fs.writeFileSync(path.join(LEGACY, 'gateway.out.log'), 'out-log-content\n');
fs.writeFileSync(path.join(LEGACY, 'gateway.err.log'), 'err-log-content\n');
fs.writeFileSync(
  path.join(LEGACY, 'logs', 'gateway.log'),
  '{"alias":"a","status":200}\n{"alias":"b","status":200}\n',
);

// 制造「按 target 误放」的网关文件（早期版本会这样）
const wbTarget = path.join(HOME, 'targets', 'workbuddy');
const cxTarget = path.join(HOME, 'targets', 'codex');
fs.mkdirSync(path.join(wbTarget, 'logs'), { recursive: true });
fs.mkdirSync(cxTarget, { recursive: true });
fs.writeFileSync(path.join(wbTarget, 'gateway.out.log'), 'stray-out\n');
fs.writeFileSync(path.join(cxTarget, 'gateway.err.log'), 'stray-err\n');
fs.writeFileSync(path.join(cxTarget, 'gateway.pid'), '99999\n');
fs.writeFileSync(path.join(wbTarget, 'logs', 'gateway.log'), '{"alias":"c","status":200}\n');

// ───────────── 1. 执行迁移 ─────────────
const rep = ensureMigration(WB_ROOT);
ok('报告为已迁移', rep.migrated === true);
ok('报告列出源快照', rep.items.some((i) => i.includes('源快照')));
ok('报告列出偏好设置', rep.items.some((i) => i.includes('偏好设置')));
ok('报告列出网关数据', rep.items.some((i) => i.includes('网关数据')));

// ───────────── 2. 源与备份到位 ─────────────
{
  const p = path.join(HOME, 'targets', 'workbuddy', 'profiles');
  ok('srcA 已迁', fs.existsSync(path.join(p, 'srcA.json')));
  ok('srcB 已迁', fs.existsSync(path.join(p, 'srcB.json')));
  ok('备份已迁', fs.existsSync(path.join(HOME, 'targets', 'workbuddy', 'backups', 'manual-1.json')));
  ok('state 已迁', fs.existsSync(path.join(HOME, 'targets', 'workbuddy', 'state.json')));
}

// ───────────── 3. settings 落在工具家根目录（全局，不分 target） ─────────────
{
  const f = path.join(HOME, 'settings.json');
  ok('settings 已迁到工具家', fs.existsSync(f));
  check('settings 内容保留', JSON.parse(fs.readFileSync(f, 'utf8')), { autoBackup: true });
}

// ───────────── 4. 网关数据归并到共享目录 ─────────────
{
  const gw = path.join(HOME, 'gateway');
  ok('routes 在共享目录', fs.existsSync(path.join(gw, 'routes.json')));
  ok('health 在共享目录', fs.existsSync(path.join(gw, 'health.json')));
  ok('out.log 在共享目录', fs.existsSync(path.join(gw, 'gateway.out.log')));
  ok('err.log 在共享目录', fs.existsSync(path.join(gw, 'gateway.err.log')));

  const log = path.join(gw, 'logs', 'gateway.log');
  ok('请求日志在共享目录', fs.existsSync(log));
  const text = fs.readFileSync(log, 'utf8');
  ok('旧日志行已并入', text.includes('"alias":"a"'));
  ok('target 内日志行已并入', text.includes('"alias":"c"'));
}

// ───────────── 5. target 下的网关文件被清理 ─────────────
{
  ok('workbuddy/gateway.out.log 已删', !fs.existsSync(path.join(wbTarget, 'gateway.out.log')));
  ok('codex/gateway.err.log 已删', !fs.existsSync(path.join(cxTarget, 'gateway.err.log')));
  ok('codex/gateway.pid 已删', !fs.existsSync(path.join(cxTarget, 'gateway.pid')));
  ok('workbuddy/logs 目录已删', !fs.existsSync(path.join(wbTarget, 'logs')));
}

// ───────────── 6. 幂等：重复迁移不加重复日志、不覆盖新数据 ─────────────
{
  // 模拟用户在新目录里改过 settings
  fs.writeFileSync(path.join(HOME, 'settings.json'), '{"autoBackup":false}');
  const logBefore = fs.readFileSync(path.join(HOME, 'gateway', 'logs', 'gateway.log'), 'utf8');

  ensureMigration(WB_ROOT);

  check(
    '重复迁移不覆盖用户改过的 settings',
    JSON.parse(fs.readFileSync(path.join(HOME, 'settings.json'), 'utf8')),
    { autoBackup: false },
  );
  const logAfter = fs.readFileSync(path.join(HOME, 'gateway', 'logs', 'gateway.log'), 'utf8');
  ok('重复迁移不重复追加日志', logAfter === logBefore);
  ok('日志无重复行', logAfter.split('\n').filter((l) => l.includes('"alias":"a"')).length === 1);
}

// ───────────── 7. 工具家目录结构正确 ─────────────
{
  check('wbSwitchHome', wbSwitchHome(), HOME);
  check('dataDir 指到 target 子目录', dataDir(WB_ROOT), path.join(HOME, 'targets', 'workbuddy'));
  check('gatewayDataDir 指到共享目录', gatewayDataDir(), path.join(HOME, 'gateway'));
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n迁移: ${pass} 项通过${fails.length ? `，${fails.length} 项失败` : ''}`);
if (fails.length) {
  console.log('\n失败项：');
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}

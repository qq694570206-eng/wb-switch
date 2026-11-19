/**
 * GUI 多目标工具回归测试（Service 层，不启动 Electron）。
 *
 * GUI 的 target 切换全靠这几个 service 函数，所以直接测它们：
 *  - getOverview 能按当前目标工具读出正确的配置与模型
 *  - listTargetTools 反映当前项
 *  - switchTargetTool 持久切换，且切换后视图随之变化
 *  - switchProfile 在 Codex 目标下写 TOML（不是 models.json）
 *
 * 用法：WB_SWITCH_HOME=<tmp> node tests/gui-targets.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wbs-gui-target-'));
process.env.WB_SWITCH_HOME = TMP;
process.env.WB_CONFIG_DIR = path.join(TMP, 'wb');
process.env.CODEX_HOME = path.join(TMP, 'codex');

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

// 造一份 WorkBuddy 配置 + 一个源
fs.mkdirSync(process.env.WB_CONFIG_DIR, { recursive: true });
fs.mkdirSync(path.join(TMP, 'targets', 'workbuddy', 'profiles'), { recursive: true });
const wbModels = [{ id: 'wb-model-a', url: 'https://a.example/v1', apiKey: 'k' }];
fs.writeFileSync(
  path.join(process.env.WB_CONFIG_DIR, 'models.json'),
  JSON.stringify(wbModels, null, 2),
);
fs.writeFileSync(
  path.join(TMP, 'targets', 'workbuddy', 'profiles', 'srcA.json'),
  JSON.stringify({ name: 'srcA', models: wbModels }),
);

// 造一份 Codex 配置 + 一个源
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
fs.writeFileSync(
  path.join(process.env.CODEX_HOME, 'config.toml'),
  'model = "gpt-old"\nmodel_provider = "openai"\n\n[mcp_servers.keep]\ncommand = "x"\n',
);
fs.mkdirSync(path.join(TMP, 'targets', 'codex', 'profiles'), { recursive: true });
fs.writeFileSync(
  path.join(TMP, 'targets', 'codex', 'profiles', 'srcC.json'),
  JSON.stringify({ name: 'srcC', models: [{ id: 'cx-a' }, { id: 'cx-b' }] }),
);

const {
  getOverview,
  listTargetTools,
  switchTargetTool,
  switchProfile,
} = await import('../dist/gui/service.js');
const { setActiveTarget, wbSwitchHome } = await import('../dist/paths.js');
const { readCurrentTarget } = await import('../dist/targets/index.js');

// 初始化：让模块级 target 与磁盘一致
setActiveTarget(readCurrentTarget(wbSwitchHome()));

// ───────────── 1. 默认是 WorkBuddy ─────────────
{
  const ov = getOverview('2.2.0');
  check('默认目标 id', ov.target.id, 'workbuddy');
  check('默认目标名', ov.target.name, 'WorkBuddy');
  check('WorkBuddy 配置路径', ov.modelsPath, path.join(process.env.WB_CONFIG_DIR, 'models.json'));
  check('WorkBuddy 源数', ov.profiles.length, 1);
  check('WorkBuddy 当前模型数', ov.currentModels?.length, 1);
  check('WorkBuddy 模型 id', ov.currentModels?.[0]?.id, 'wb-model-a');
}

// ───────────── 2. targets 列表 ─────────────
{
  const tl = listTargetTools();
  check('默认 current', tl.current, 'workbuddy');
  check('目标数量', tl.targets.length, 2);
  check('第一项是 WorkBuddy（优先级）', tl.targets[0].id, 'workbuddy');
  ok('current 标记正确', tl.targets[0].current === true && tl.targets[1].current === false);
  ok('都标记已安装', tl.targets.every((t) => t.installed));
}

// ───────────── 3. 切到 Codex ─────────────
{
  const r = switchTargetTool('codex');
  check('切换返回 current', r.current, 'codex');
  check('切换返回名称', r.name, 'Codex');
  check('落盘 current-target', readCurrentTarget(wbSwitchHome()), 'codex');

  const ov = getOverview('2.2.0');
  check('Codex 目标 id', ov.target.id, 'codex');
  check('Codex 配置路径', ov.modelsPath, path.join(process.env.CODEX_HOME, 'config.toml'));
  // Codex 的 readModels 只回当前生效的那一个模型
  check('Codex 当前模型数', ov.currentModels?.length, 1);
  check('Codex 当前模型 id', ov.currentModels?.[0]?.id, 'gpt-old');
  check('Codex 源库独立（只有 srcC）', ov.profiles.map((p) => p.name), ['srcC']);
}

// ───────────── 4. Codex 下切换源 → 必须写 TOML ─────────────
{
  const rep = switchProfile('srcC');
  check('切换写入 2 个模型', rep.modelCount, 2);
  ok('报告带 notes', Array.isArray(rep.notes) && rep.notes.length > 0);

  const toml = fs.readFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8');
  ok('默认模型改成源里第一个', toml.includes('model = "cx-a"'));
  ok('provider 指向 wb-switch', toml.includes('model_provider = "wb-switch"'));
  ok('wire_api=responses', toml.includes('wire_api = "responses"'));
  ok('【关键】用户原有 mcp_servers 保留', toml.includes('[mcp_servers.keep]'));
  ok('生成了 profile 文件', fs.existsSync(path.join(process.env.CODEX_HOME, 'cx-b.config.toml')));

  // 绝不能把 models.json 写到 Codex 目录
  ok('没有误写 models.json 到 Codex 目录', !fs.existsSync(path.join(process.env.CODEX_HOME, 'models.json')));
}

// ───────────── 5. 切回 WorkBuddy，状态独立 ─────────────
{
  switchTargetTool('workbuddy');
  const ov = getOverview('2.2.0');
  check('回到 WorkBuddy', ov.target.id, 'workbuddy');
  check('WorkBuddy 源没被 Codex 影响', ov.profiles.map((p) => p.name), ['srcA']);
  check('WorkBuddy 模型没被改', ov.currentModels?.[0]?.id, 'wb-model-a');

  // Codex 那边也还在
  switchTargetTool('codex');
  const ov2 = getOverview('2.2.0');
  check('Codex 源仍在', ov2.profiles.map((p) => p.name), ['srcC']);
  check('Codex 被切换过的模型持久化', ov2.currentModels?.[0]?.id, 'cx-a');
  switchTargetTool('workbuddy');
}

// ───────────── 6. 未知目标要报错 ─────────────
{
  let threw = false;
  try {
    switchTargetTool('not-a-tool');
  } catch {
    threw = true;
  }
  ok('未知目标被拒绝', threw);
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\nGUI targets: ${pass} 项通过${fails.length ? `，${fails.length} 项失败` : ''}`);
if (fails.length) {
  console.log('\n失败项：');
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}

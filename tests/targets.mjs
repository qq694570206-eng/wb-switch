/**
 * 多 target（WorkBuddy / Codex）回归测试。
 *
 * 重点验证「通用模型切换工具」的核心约束：
 *  - 目录隔离：不同 target 的源库互不干扰
 *  - Codex 写入不破坏用户原有 config.toml（mcp_servers / notify / 注释…）
 *  - TOML 定点编辑正确
 *  - 旧数据迁移幂等且增量补齐
 *
 * 用法：node tests/targets.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as T from '../dist/toml.js';
import { CodexTarget } from '../dist/targets/codex.js';
import { WorkBuddyTarget } from '../dist/targets/workbuddy.js';
import { listTargets, readCurrentTarget, writeCurrentTarget } from '../dist/targets/index.js';

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wbs-target-'));

try {
  // ───────────── 1. TOML 定点编辑 ─────────────

  const original = `# 用户注释
notify = [ "a", "b" ]
model = "gpt-5"
model_reasoning_effort = "medium"

[mcp_servers.idea]
command = "java"
args = [ "-x" ]

[mcp_servers.idea.env]
PORT = "1234"

[other]
key = "keep-me"
`;

  check('读顶层 model', T.readTopLevel(original).model, 'gpt-5');
  check('读顶层 effort', T.readTopLevel(original).model_reasoning_effort, 'medium');
  check('表数量', T.listTables(original).length, 3);
  check('读子表', T.readTable(original, 'mcp_servers.idea').command, 'java');

  let edited = T.setTopLevel(original, 'model', 'new-model');
  check('顶层键原地替换', T.readTopLevel(edited).model, 'new-model');
  ok('注释保留', edited.includes('# 用户注释'));
  ok('mcp_servers 保留', edited.includes('[mcp_servers.idea]'));
  ok('未知表保留', edited.includes('[other]') && edited.includes('keep-me'));

  edited = T.setTopLevel(edited, 'model_provider', 'wb');
  check('新增顶层键', T.readTopLevel(edited).model_provider, 'wb');

  edited = T.setTable(edited, 'model_providers.wb', {
    name: 'gw',
    base_url: 'http://127.0.0.1:7533/v1',
    wire_api: 'responses',
  });
  check('新表写入', T.readTable(edited, 'model_providers.wb').wire_api, 'responses');
  ok('mcp 仍在', edited.includes('[mcp_servers.idea]'));
  ok('注释仍在', edited.includes('# 用户注释'));

  // 更新已存在的表（不重复）
  edited = T.setTable(edited, 'model_providers.wb', { name: 'gw2', base_url: 'http://x/v1' });
  check('表更新生效', T.readTable(edited, 'model_providers.wb').name, 'gw2');
  check('表未重复', (edited.match(/\[model_providers\.wb\]/g) ?? []).length, 1);

  const removed = T.removeTable(edited, 'other');
  ok('删表生效', !removed.includes('[other]'));
  ok('删表不影响其它', removed.includes('[mcp_servers.idea]'));

  // ───────────── 2. Codex 适配器写入 ─────────────

  const codexHome = path.join(TMP, 'codex');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), original, 'utf8');

  const codex = new CodexTarget('http://127.0.0.1:7533/v1', codexHome);
  ok('Codex 已安装', codex.installed());
  check('Codex 配置路径', codex.configPath(), path.join(codexHome, 'config.toml'));

  const r = codex.writeModels([
    { id: 'ds-main-deepseek-v4-pro', name: 'x', url: '' },
    { id: 'fast-deepseek-v4.1-flash', name: 'y', url: '' },
  ]);
  check('写入模型数', r.modelCount, 2);

  const after = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
  check('默认模型=第一个', T.readTopLevel(after).model, 'ds-main-deepseek-v4-pro');
  check('provider 指向 wb-switch', T.readTopLevel(after).model_provider, 'wb-switch');
  check('provider wire_api=responses', T.readTable(after, 'model_providers.wb-switch').wire_api, 'responses');
  check('provider base_url', T.readTable(after, 'model_providers.wb-switch').base_url, 'http://127.0.0.1:7533/v1');
  ok('【关键】mcp_servers 未被破坏', after.includes('[mcp_servers.idea]'));
  ok('【关键】用户注释保留', after.includes('# 用户注释'));
  ok('【关键】notify 保留', after.includes('notify ='));

  // profile 文件（多模型切换）
  ok('生成第 1 个 profile', fs.existsSync(path.join(codexHome, 'ds-main-deepseek-v4-pro.config.toml')));
  ok('生成第 2 个 profile', fs.existsSync(path.join(codexHome, 'fast-deepseek-v4.1-flash.config.toml')));
  const prof = T.readTopLevel(fs.readFileSync(path.join(codexHome, 'ds-main-deepseek-v4-pro.config.toml'), 'utf8'));
  check('profile 的 model', prof.model, 'ds-main-deepseek-v4-pro');

  // 读回
  const readBack = codex.readModels();
  check('读回只有当前一个模型', readBack?.length, 1);
  check('读回模型 id', readBack?.[0]?.id, 'ds-main-deepseek-v4-pro');

  // ───────────── 3. WorkBuddy 适配器 ─────────────

  const wbRoot = path.join(TMP, 'workbuddy');
  fs.mkdirSync(wbRoot, { recursive: true });
  fs.writeFileSync(
    path.join(wbRoot, 'models.json'),
    JSON.stringify([{ id: 'old', url: 'https://old/v1' }], null, 2),
  );

  const wb = new WorkBuddyTarget(wbRoot);
  check('WB 读模型数', wb.readModels()?.length, 1);

  // 整体替换
  wb.writeModels([{ id: 'a' }, { id: 'b' }]);
  check('WB 整体替换', wb.readModels()?.map((m) => m.id), ['a', 'b']);

  // 追加模式：不覆盖已有
  wb.writeModels([{ id: 'b' }, { id: 'c' }], { merge: true });
  check('WB 追加去重', wb.readModels()?.map((m) => m.id), ['a', 'b', 'c']);

  // ───────────── 4. target 发现与当前项持久化 ─────────────

  const infos = listTargets({ workbuddyRoot: wbRoot });
  check('两个 target', infos.map((t) => t.id), ['workbuddy', 'codex']);
  check('workbuddy 排第一（优先级高）', infos[0].id, 'workbuddy');

  const dataDir = path.join(TMP, 'data');
  check('默认 target = workbuddy', readCurrentTarget(dataDir), 'workbuddy');
  writeCurrentTarget(dataDir, 'codex');
  check('切换后 = codex', readCurrentTarget(dataDir), 'codex');
  writeCurrentTarget(dataDir, 'workbuddy');
  check('切回 workbuddy', readCurrentTarget(dataDir), 'workbuddy');
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

// ───────────── 结果 ─────────────

console.log(`\ntargets: ${pass} 项通过${fails.length ? `，${fails.length} 项失败` : ''}`);
if (fails.length) {
  console.log('\n失败项：');
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}

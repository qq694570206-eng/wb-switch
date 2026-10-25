#!/usr/bin/env node
/**
 * wb-switch 冒烟测试
 *
 * 在临时目录中模拟一个 WorkBuddy 配置目录，逐项验证：
 *   - 配置解析与校验
 *   - 源的增删改查
 *   - 切换（含备份、原子写入、回读校验）
 *   - 风格保留（4 空格缩进 / CRLF 换行）
 *   - 错误码与失败时不留半成品
 *
 * 运行：npm test（会先编译）
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 可用参数或 WB_CLI 指定被测程序，例如：
//   node tests/smoke.mjs dist-exe/wb-switch.exe
//   WB_CLI=dist-exe/wb-switch.exe node tests/smoke.mjs
const target = process.argv[2] || process.env.WB_CLI;
const CLI = target ? path.resolve(target) : path.join(__dirname, '..', 'dist', 'cli.js');
const IS_EXE = CLI.toLowerCase().endsWith('.exe');

let pass = 0;
const failures = [];

function run(args, { cwd, env = {} } = {}) {
  return new Promise((resolve) => {
    execFile(
      IS_EXE ? CLI : process.execPath,
      IS_EXE ? [...args, '--ascii', '--no-color'] : [CLI, ...args, '--ascii', '--no-color'],
      {
        cwd,
        env: { ...process.env, ...env, NO_COLOR: '1' },
        timeout: 30000,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        resolve({
          code: err && typeof err.code === 'number' ? err.code : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

function assert(cond, label, extra = '') {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${label}`);
  } else {
    failures.push(`${label}${extra ? ` — ${extra}` : ''}`);
    console.log(`  \u2717 ${label}${extra ? ` — ${extra}` : ''}`);
  }
}

function tmpConfig(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wb-switch-test-${name}-`));
  return dir;
}

const MODELS_A = [
  {
    id: 'deepseek-flash',
    name: 'deepseek-flash',
    vendor: 'Custom',
    url: 'https://token.sensenova.cn/v1/chat/completions',
    apiKey: 'sk-aaaaaaaaaaaaaaaaaaaa',
    supportsToolCall: true,
    supportsImages: false,
    supportsReasoning: false,
    useCustomProtocol: false,
  },
  {
    id: 'glm-5.2',
    name: 'glm-5.2',
    vendor: 'Custom',
    url: 'https://token.sensenova.cn/v1/chat/completions',
    apiKey: 'sk-bbbbbbbbbbbbbbbbbbbb',
    supportsToolCall: true,
    supportsImages: false,
    supportsReasoning: false,
    useCustomProtocol: false,
  },
];

const MODELS_B = [
  {
    id: 'gpt-4o',
    name: 'gpt-4o',
    vendor: 'OpenAI',
    url: 'https://api.moyu.info/v1/chat/completions',
    apiKey: 'sk-cccccccccccccccccccc',
    supportsToolCall: true,
    supportsImages: true,
    supportsReasoning: false,
    useCustomProtocol: false,
  },
];

async function main() {
  // ── 1. init / list ──────────────────────────────────────────
  console.log('\n[1] init 与 list');
  const dirA = tmpConfig('init');
  fs.writeFileSync(path.join(dirA, 'models.json'), JSON.stringify(MODELS_A, null, 2) + '\n');
  const envA = { WB_CONFIG_DIR: dirA };

  let r = await run(['init', 'work'], { env: envA });
  assert(r.code === 0, 'init 成功', `code=${r.code} ${r.stderr}`);
  assert(fs.existsSync(path.join(dirA, 'wb-switch', 'profiles', 'work.json')), '生成源文件');

  r = await run(['list'], { env: envA });
  assert(r.code === 0 && r.stdout.includes('work'), 'list 显示源');
  assert(r.stdout.includes('当前'), 'list 标记当前源');

  // ── 2. add（非交互）与重复名保护 ────────────────────────────
  console.log('\n[2] add 与重名保护');
  r = await run(
    ['add', 'backup', '--url', 'https://api.moyu.info/v1/chat/completions', '--key', 'sk-cccccccccccccccccccc', '--model', 'gpt-4o', '--vendor', 'OpenAI'],
    { env: envA },
  );
  assert(r.code === 0, 'add 成功', r.stderr);
  r = await run(
    ['add', 'backup', '--url', 'https://api.moyu.info/v1/chat/completions', '--key', 'x'],
    { env: envA },
  );
  assert(r.code === 4, '重名返回退出码 4', `code=${r.code}`);

  // ── 3. 切换与备份 ──────────────────────────────────────────
  console.log('\n[3] 切换 / 备份 / 回读校验');
  r = await run(['use', 'backup'], { env: envA });
  assert(r.code === 0, 'use 成功', r.stderr);
  const afterSwitch = JSON.parse(fs.readFileSync(path.join(dirA, 'models.json'), 'utf8'));
  assert(afterSwitch.length === 1 && afterSwitch[0].id === 'gpt-4o', 'models.json 已替换为目标源内容');

  const backupDir = path.join(dirA, 'wb-switch', 'backups');
  const backups = fs.readdirSync(backupDir);
  assert(backups.some((f) => f.startsWith('models-')), '切换前生成备份');
  const backupContent = JSON.parse(fs.readFileSync(path.join(backupDir, backups[0]), 'utf8'));
  assert(backupContent.length === 2, '备份内容是切换前的配置');

  r = await run(['current'], { env: envA });
  assert(r.stdout.includes('backup'), 'current 显示当前源');

  // 幂等：重复切同一个源
  const before = fs.readFileSync(path.join(dirA, 'models.json'), 'utf8');
  r = await run(['use', 'backup'], { env: envA });
  assert(r.code === 0 && r.stdout.includes('已是'), '重复切换幂等', r.stdout.trim());
  assert(fs.readFileSync(path.join(dirA, 'models.json'), 'utf8') === before, '幂等切换不改动文件');

  // ── 4. dry-run 不落盘 ─────────────────────────────────────
  console.log('\n[4] dry-run');
  r = await run(['use', 'work', '-n'], { env: envA });
  assert(r.code === 0 && r.stdout.includes('演练'), 'dry-run 输出演练结果');
  assert(fs.readFileSync(path.join(dirA, 'models.json'), 'utf8') === before, 'dry-run 不修改文件');

  // ── 5. diff ───────────────────────────────────────────────
  console.log('\n[5] diff');
  r = await run(['diff', 'work'], { env: envA });
  assert(r.code === 0, 'diff 成功');
  assert(r.stdout.includes('deepseek-flash') && r.stdout.includes('gpt-4o'), 'diff 列出新增与移除');

  // ── 6. JSON 输出 ──────────────────────────────────────────
  console.log('\n[6] --json 输出');
  r = await run(['list', '--json'], { env: envA });
  const parsed = JSON.parse(r.stdout);
  assert(Array.isArray(parsed) && parsed.length === 2, 'list --json 可解析');
  assert(parsed.some((p) => p.active === true), 'JSON 含 active 标记');

  r = await run(['current', '--json'], { env: envA });
  const cur = JSON.parse(r.stdout);
  assert(cur.active === 'backup' && cur.modelCount === 1, 'current --json 字段正确');

  // ── 7. 风格保留（4 空格 + CRLF）────────────────────────────
  console.log('\n[7] 写入风格保留');
  const dirB = tmpConfig('style');
  fs.writeFileSync(path.join(dirB, 'models.json'), JSON.stringify(MODELS_B, null, 4).replace(/\n/g, '\r\n') + '\r\n');
  const envB = { WB_CONFIG_DIR: dirB };
  await run(['init', 'a'], { env: envB });
  fs.writeFileSync(
    path.join(dirB, 'wb-switch', 'profiles', 'b.json'),
    JSON.stringify({ name: 'b', models: MODELS_A }, null, 2),
  );
  r = await run(['use', 'b'], { env: envB });
  const styled = fs.readFileSync(path.join(dirB, 'models.json'), 'utf8');
  assert(r.code === 0, '切换成功（4空格/CRLF 场景）', r.stderr);
  assert(styled.includes('\r\n'), '保留 CRLF 换行');
  assert(/^ {4}\{/m.test(styled), '保留 4 空格缩进');
  assert(/^ {8}"id"/m.test(styled), '嵌套层级缩进正确（8 空格）');

  // ── 8. 还原 ───────────────────────────────────────────────
  console.log('\n[8] restore');
  r = await run(['restore', '1', '-y'], { env: envB });
  assert(r.code === 0, 'restore 成功', r.stderr);
  const restored = JSON.parse(fs.readFileSync(path.join(dirB, 'models.json'), 'utf8'));
  assert(restored[0].id === 'gpt-4o', 'restore 恢复原内容');

  // ── 9. 错误处理 ───────────────────────────────────────────
  console.log('\n[9] 错误处理');
  r = await run(['use', 'no-such'], { env: envA });
  assert(r.code === 4, '切换不存在的源 → 4', `code=${r.code}`);

  r = await run(['nonsense-cmd'], { env: envA });
  assert(r.code === 2, '未知命令 → 2', `code=${r.code}`);

  r = await run(['list'], { env: { WB_CONFIG_DIR: path.join(os.tmpdir(), 'wb-switch-does-not-exist-xyz') } });
  assert(r.code === 5, '配置目录不存在 → 5', `code=${r.code}`);

  const dirC = tmpConfig('bad');
  fs.writeFileSync(path.join(dirC, 'models.json'), '{ broken json');
  r = await run(['current'], { env: { WB_CONFIG_DIR: dirC } });
  assert(r.code === 3, '损坏 JSON → 3', `code=${r.code}`);

  // 结构错误
  fs.writeFileSync(path.join(dirC, 'models.json'), '{"a":1}');
  r = await run(['current'], { env: { WB_CONFIG_DIR: dirC } });
  assert(r.code === 3 && r.stderr.includes('数组'), '结构错误提示顶层应为数组');

  // 损坏状态下切换：必须保留原文件，不写坏
  const brokenText = '{ broken json';
  fs.writeFileSync(path.join(dirC, 'models.json'), brokenText);
  await run(['init', 'x'], { env: { WB_CONFIG_DIR: dirC } }); // 应失败（无法读当前配置）
  r = await run(['use', 'x'], { env: { WB_CONFIG_DIR: dirC } });
  assert(fs.readFileSync(path.join(dirC, 'models.json'), 'utf8') === brokenText, '失败时不破坏原文件');

  // 空源保护
  const dirD = tmpConfig('empty');
  fs.writeFileSync(path.join(dirD, 'models.json'), JSON.stringify(MODELS_A, null, 2));
  const envD = { WB_CONFIG_DIR: dirD };
  await run(['init', 'base'], { env: envD });
  fs.writeFileSync(path.join(dirD, 'wb-switch', 'profiles', 'empty.json'), JSON.stringify({ name: 'empty', models: [] }));
  r = await run(['use', 'empty'], { env: envD });
  assert(r.code === 4 && r.stderr.includes('空'), '空源拒绝切换', `code=${r.code}`);

  // 重复 id 校验
  const dirE = tmpConfig('dupid');
  fs.writeFileSync(path.join(dirE, 'models.json'), JSON.stringify([MODELS_A[0], MODELS_A[0]], null, 2));
  r = await run(['init', 'dup'], { env: { WB_CONFIG_DIR: dirE } });
  assert(r.code === 3 && r.stderr.includes('重复'), '重复 id 被拒绝', `code=${r.code}`);

  // 非法 URL
  r = await run(
    ['add', 'badurl', '--url', 'ftp://x/y', '--key', 'k'],
    { env: envA },
  );
  assert(r.code === 2, '非法 URL → 2', `code=${r.code}`);

  // ── 10. 源管理 ────────────────────────────────────────────
  console.log('\n[10] rename / remove / show / export');
  r = await run(['rename', 'backup', 'bk2'], { env: envA });
  assert(r.code === 0, 'rename 成功', r.stderr);
  r = await run(['current'], { env: envA });
  assert(r.stdout.includes('bk2'), 'rename 同步更新当前源指针');

  r = await run(['show', 'bk2'], { env: envA });
  assert(r.code === 0 && !r.stdout.includes('sk-cccccccccccccccccccc'), 'show 默认脱敏密钥');
  r = await run(['show', 'bk2', '--reveal'], { env: envA });
  assert(r.stdout.includes('sk-cccccccccccccccccccc'), 'show --reveal 显示完整密钥');

  const exportPath = path.join(dirA, 'exported.json');
  r = await run(['export', 'bk2', '-o', exportPath], { env: envA });
  assert(r.code === 0 && fs.existsSync(exportPath), 'export 写文件');

  r = await run(['import', exportPath, 'imported'], { env: envA });
  assert(r.code === 0, 'import 成功', r.stderr);

  r = await run(['remove', 'imported', '-y'], { env: envA });
  assert(r.code === 0, 'remove 成功', r.stderr);
  assert(
    fs.readdirSync(path.join(dirA, 'wb-switch', 'backups')).some((f) => f.startsWith('deleted-imported')),
    'remove 保留副本',
  );

  // ── 11. doctor ────────────────────────────────────────────
  console.log('\n[11] doctor');
  r = await run(['doctor'], { env: envA });
  assert(r.code === 0, 'doctor 健康时返回 0', `code=${r.code} ${r.stderr}`);
  r = await run(['doctor', '--json'], { env: envA });
  const doc = JSON.parse(r.stdout);
  assert(doc.ok === true && Array.isArray(doc.checks), 'doctor --json 结构正确');

  // ── 汇总 ─────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(52)}`);
  if (failures.length === 0) {
    console.log(`全部通过：${pass} 项断言`);
    process.exit(0);
  }
  console.log(`通过 ${pass} 项，失败 ${failures.length} 项：`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

main().catch((err) => {
  console.error('测试执行异常：', err);
  process.exit(1);
});

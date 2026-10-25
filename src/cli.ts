#!/usr/bin/env node
/**
 * wb-switch —— WorkBuddy 模型源切换工具（Windows / macOS / Linux 通用）
 *
 * 用法速览：
 *   wb-switch                      交互式选择并切换
 *   wb-switch list                 列出所有源
 *   wb-switch use <名称>           切换到指定源
 *   wb-switch current              显示当前源
 *   wb-switch add <名称>           新增源
 *   wb-switch remove <名称>        删除源
 *   wb-switch show <名称>          查看源内容
 *   wb-switch diff <名称>          与当前配置对比
 *   wb-switch init                 把当前配置存为第一个源
 *   wb-switch backup / restore     备份与还原
 *   wb-switch doctor               环境自检
 */

import path from 'node:path';
import fs from 'node:fs';
import { ConfigError, ExitCode, ProfileError, UsageError, WbError, describeError } from './errors.js';
import type { ModelEntry, Profile } from './types.js';
import { backupsDir, dataDir, modelsFile, profilesDir, resolveConfigRoot } from './paths.js';
import {
  deleteProfile,
  listProfileNames,
  listProfiles,
  loadProfile,
  profileExists,
  renameProfile,
  resolveProfileName,
  saveProfile,
  validateProfileName,
} from './profiles.js';
import { readState, setActive } from './state.js';
import {
  prepareRoot,
  readCurrentModels,
  switchTo,
  snapshotCurrent,
  restoreFromBackup,
} from './switcher.js';
import {
  hostOf,
  loadModels,
  maskKey,
  modelsEqual,
  summarize,
  validateModels,
} from './config.js';
import {
  assertWritable,
  backupFile,
  exists,
  isDir,
  listFiles,
  readJson,
  stringifyJson,
  writeFileAtomic,
} from './fsutil.js';
import {
  c,
  confirm,
  fail,
  heading,
  info,
  isInteractive,
  ok,
  pick,
  promptText,
  displayWidth,
  renderTable,
  sym,
  waitAnyKey,
  warn,
} from './ui.js';

const VERSION = '1.7.0';

// ─────────────────────────── 参数解析 ───────────────────────────

interface Args {
  positional: string[];
  flags: Map<string, string | boolean>;
  configDir?: string;
}

const BOOLEAN_FLAGS = new Set([
  'help',
  'version',
  'yes',
  'dry-run',
  'force',
  'json',
  'verbose',
  'quiet',
  'no-backup',
  'from-current',
  'switch',
  'reveal',
  'purge',
  'list',
  'purge',
  'no-color',
  'ascii',
  'pause',
  'no-pause',
  'about',
]);

const STRING_FLAGS = new Set([
  'config-dir',
  'description',
  'desc',
  'from',
  'url',
  'key',
  'model',
  'id',
  'vendor',
  'output',
  'name',
  'out',
]);

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const key = (eq >= 0 ? token.slice(2, eq) : token.slice(2)).toLowerCase();
      if (eq >= 0) {
        flags.set(key, token.slice(eq + 1));
        continue;
      }
      if (STRING_FLAGS.has(key)) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('-')) {
          throw new UsageError(`参数 --${key} 需要一个值。`);
        }
        flags.set(key, next);
        i++;
        continue;
      }
      flags.set(key, true);
      continue;
    }
    if (token.startsWith('-') && token.length > 1) {
      // 短参数可组合：-yf
      const chars = token.slice(1);
      for (const ch of chars) {
        switch (ch) {
          case 'h':
            flags.set('help', true);
            break;
          case 'V':
            flags.set('version', true);
            break;
          case 'y':
            flags.set('yes', true);
            break;
          case 'n':
            flags.set('dry-run', true);
            break;
          case 'f':
            flags.set('force', true);
            break;
          case 'v':
            flags.set('verbose', true);
            break;
          case 'q':
            flags.set('quiet', true);
            break;
          case 'd':
          case 'o': {
            const val = argv[i + 1];
            if (!val) throw new UsageError(`参数 -${ch} 需要一个值。`);
            flags.set(ch === 'd' ? 'config-dir' : 'output', val);
            i++;
            break;
          }
          default:
            throw new UsageError(`未知参数：-${ch}`, '运行 wb-switch help 查看全部用法。');
        }
      }
      continue;
    }
    positional.push(token);
  }

  const cfg = flags.get('config-dir');
  return { positional, flags, configDir: typeof cfg === 'string' ? cfg : undefined };
}

const has = (a: Args, k: string) => a.flags.has(k) && a.flags.get(k) !== false;
const str = (a: Args, k: string): string | undefined => {
  const v = a.flags.get(k);
  return typeof v === 'string' ? v : undefined;
};

// ─────────────────────────── 帮助 ───────────────────────────

function printHelp(): void {
  const b = (s: string) => c.bold(s);
  const g = (s: string) => c.gray(s);
  process.stdout.write(`
${b('wb-switch')} ${g(`v${VERSION}`)} — WorkBuddy 模型源切换工具

${b('用法')}
  wb-switch                        ${g('交互式选择源并立即切换')}
  wb-switch <名称>                 ${g('直接切换到指定源（简写）')}
  wb-switch use <名称>             ${g('切换到指定源')}
  wb-switch list                   ${g('列出全部源，标记当前源')}
  wb-switch current                ${g('显示当前生效的源')}
  wb-switch show <名称>            ${g('查看某个源的模型明细')}
  wb-switch diff <名称>            ${g('对比源与当前 models.json 的差异')}

${b('源管理')}
  wb-switch init [名称]            ${g('把当前 models.json 保存为第一个源（默认名 default）')}
  wb-switch add <名称>             ${g('新增源（交互式，或配合 --url/--key 非交互）')}
  wb-switch rename <旧> <新>       ${g('重命名源')}
  wb-switch remove <名称>          ${g('删除源（默认移入 backups 以便恢复）')}
  wb-switch export [名称]          ${g('导出源为 JSON（默认输出到 stdout）')}
  wb-switch import <文件> [名称]   ${g('从 JSON 文件导入源')}

${b('备份与自检')}
  wb-switch backup                 ${g('立即备份当前 models.json')}
  wb-switch backups                ${g('查看历史备份')}
  wb-switch restore [备份文件]     ${g('还原 models.json（缺省选最新备份）')}
  wb-switch doctor                 ${g('检查配置目录、文件与环境是否正常')}

${b('常用选项')}
  -d, --config-dir <目录>          ${g('指定 WorkBuddy 配置目录（默认 %USERPROFILE%\\.workbuddy）')}
  -y, --yes                        ${g('跳过确认')}
  -n, --dry-run                    ${g('只演算不写入')}
  -f, --force                      ${g('内容一致时也强制重写')}
  -v, --verbose                    ${g('输出更多细节')}
      --json                       ${g('以 JSON 输出（便于脚本调用）')}
      --no-backup                  ${g('切换时不备份（不推荐）')}
      --no-color / --ascii         ${g('禁用颜色 / 使用纯 ASCII 符号')}
  -h, --help                       ${g('显示帮助')}
  -V, --version                    ${g('显示版本')}

${b('新增源的参数形式')}
  wb-switch add <名称> --from-current           ${g('以当前配置为模板新建源')}
  wb-switch add <名称> --from <文件.json>       ${g('从文件导入模型列表')}
  wb-switch add <名称> --url <地址> --key <密钥> [--model <模型ID>] [--vendor <厂商>] [--switch]

${b('示例')}
  ${g('# 首次使用：把当前配置存成源')}
  wb-switch init work

  ${g('# 再存一份备用网关')}
  wb-switch add backup --url https://api.example.com/v1/chat/completions --key sk-xxx --model gpt-4o --switch

  ${g('# 日常切换（不带参数即出现选择器）')}
  wb-switch
`);
}

function printVersion(): void {
  process.stdout.write(`wb-switch ${VERSION}\n`);
}

// ─────────────────────────── 公共辅助 ───────────────────────────

function root(a: Args): string {
  return a.configDir ? path.resolve(a.configDir) : resolveConfigRoot();
}

function requireRoot(a: Args): string {
  const r = root(a);
  prepareRoot(r);
  return r;
}

function jsonOut(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

/** 相对时间描述 */
function ago(iso?: string | null): string {
  if (!iso) return '-';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '-';
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(t).toLocaleDateString('zh-CN');
}

// ─────────────────────────── 命令：list ───────────────────────────

function cmdList(a: Args): number {
  const r = requireRoot(a);
  const state = readState(r);
  let current: ModelEntry[] | null = null;
  try {
    current = readCurrentModels(r);
  } catch {
    current = null;
  }

  const names = listProfileNames(r);
  if (names.length === 0) {
    if (has(a, 'json')) {
      jsonOut([]);
      return ExitCode.OK;
    }
    info('还没有任何源。');
    process.stdout.write(
      `  ${c.gray('执行')} wb-switch init ${c.gray('把当前 models.json 保存为第一个源，或')} wb-switch add <名称>\n`,
    );
    return ExitCode.OK;
  }

  const profiles = listProfiles(r, current, state.active);

  if (has(a, 'json')) {
    jsonOut(
      profiles.map((p) => ({
        name: p.name,
        description: p.description,
        models: p.modelCount,
        vendors: p.vendors,
        hosts: p.hosts,
        active: p.active,
        inSync: p.inSync,
        createdAt: p.createdAt,
      })),
    );
    return ExitCode.OK;
  }

  const verbose = has(a, 'verbose');
  const columns = [
    {
      header: '',
      cell: (p: (typeof profiles)[number]) =>
        p.active ? c.green(sym.active) : c.gray(sym.inactive),
      maxWidth: 2,
    },
    {
      header: '名称',
      cell: (p: (typeof profiles)[number]) => (p.active ? c.bold(c.cyan(p.name)) : p.name),
      maxWidth: 28,
    },
    { header: '模型', align: 'right' as const, cell: (p: (typeof profiles)[number]) => String(p.modelCount), maxWidth: 4 },
    { header: '厂商', cell: (p: (typeof profiles)[number]) => p.vendors.join(',') || '-', maxWidth: 18 },
    { header: '主机', cell: (p: (typeof profiles)[number]) => p.hosts.join(', ') || '-', maxWidth: 42 },
    {
      header: '状态',
      cell: (p: (typeof profiles)[number]) =>
        p.active ? c.green('当前') : p.inSync ? c.yellow('与当前一致') : c.gray('—'),
      maxWidth: 12,
    },
  ];

  if (verbose) {
    columns.splice(3, 0, {
      header: '描述',
      cell: (p: (typeof profiles)[number]) => p.description || '-',
      maxWidth: 24,
    });
  }

  heading(`共 ${profiles.length} 个源${state.active ? c.gray(` · 当前：${state.active}`) : ''}`);
  process.stdout.write(renderTable(profiles, columns) + '\n');

  if (!state.active) {
    process.stdout.write(
      `\n${c.gray('提示：尚未通过 wb-switch 切换过；直接运行')} wb-switch ${c.gray('可交互选择。')}\n`,
    );
  } else {
    const activeExists = names.some((n) => n.toLowerCase() === state.active!.toLowerCase());
    if (!activeExists) {
      warn(`记录的当前源「${state.active}」已不存在，可能是被手动删除了。`);
    } else if (current === null) {
      warn('models.json 不存在，当前配置可能已被清空。');
    }
  }
  return ExitCode.OK;
}

// ─────────────────────────── 命令：current ───────────────────────────

function cmdCurrent(a: Args): number {
  const r = requireRoot(a);
  const state = readState(r);
  const file = modelsFile(r);
  const hasModels = exists(file);

  let models: ModelEntry[] | null = null;
  let parseError: string | null = null;
  if (hasModels) {
    try {
      models = loadModels(file);
    } catch (err) {
      parseError = describeError(err);
    }
  }

  // 校验 state 指向的源是否真的与磁盘一致
  let drift = false;
  if (state.active && models) {
    try {
      const p = loadProfile(r, state.active);
      drift = !modelsEqual(p.models, models);
    } catch {
      drift = true;
    }
  }

  if (has(a, 'json')) {
    jsonOut({
      active: state.active,
      updatedAt: state.updatedAt,
      modelsFile: file,
      modelCount: models?.length ?? 0,
      models: (models ?? []).map((m) => ({
        id: m.id,
        vendor: m.vendor,
        host: hostOf(m.url),
        apiKey: maskKey(m.apiKey),
      })),
      drift,
      parseError,
    });
    return parseError ? ExitCode.CONFIG : ExitCode.OK;
  }

  if (!hasModels) {
    warn(`当前没有 models.json：${file}`);
    process.stdout.write(`  ${c.gray('WorkBuddy 会使用内置/登录态模型。执行')} wb-switch ${c.gray('可恢复某个源。')}\n`);
    return ExitCode.OK;
  }
  if (parseError) {
    fail(`models.json 解析失败：${parseError}`);
    return ExitCode.CONFIG;
  }

  heading('当前配置');
  process.stdout.write(`  源      ${state.active ? c.bold(c.cyan(state.active)) : c.gray('(未通过 wb-switch 切换)')}\n`);
  process.stdout.write(`  文件    ${file}\n`);
  process.stdout.write(`  模型数  ${models?.length ?? 0}\n`);
  if (state.updatedAt) process.stdout.write(`  切换于  ${ago(state.updatedAt)} ${c.gray(`(${state.updatedAt})`)}\n`);

  if (models && models.length) {
    process.stdout.write(
      '\n' +
        renderTable(models, [
          { header: 'ID', cell: (m: ModelEntry) => m.id, maxWidth: 24 },
          { header: '名称', cell: (m: ModelEntry) => String(m.name ?? '-'), maxWidth: 24 },
          { header: '厂商', cell: (m: ModelEntry) => String(m.vendor ?? '-'), maxWidth: 14 },
          { header: '主机', cell: (m: ModelEntry) => hostOf(m.url), maxWidth: 40 },
          { header: '密钥', cell: (m: ModelEntry) => c.gray(maskKey(m.apiKey)), maxWidth: 20 },
        ]) +
        '\n',
    );
  }

  if (drift) {
    warn('当前 models.json 与记录的源内容不一致（可能被 WorkBuddy 界面修改过）。');
    process.stdout.write(
      `  ${c.gray('用')} wb-switch diff ${state.active} ${c.gray('查看差异，或')} wb-switch add <新名> --from-current ${c.gray('另存为新源。')}\n`,
    );
  }
  return ExitCode.OK;
}

// ─────────────────────────── 命令：show ───────────────────────────

function cmdShow(a: Args): number {
  const r = requireRoot(a);
  const name = a.positional[1];
  if (!name) throw new UsageError('用法：wb-switch show <名称>');
  const realName = resolveProfileName(r, name);
  const p = loadProfile(r, realName);
  const reveal = has(a, 'reveal');

  if (has(a, 'json')) {
    jsonOut({
      ...p,
      models: p.models.map((m) => ({ ...m, apiKey: reveal ? m.apiKey : maskKey(m.apiKey) })),
    });
    return ExitCode.OK;
  }

  heading(`源：${realName}`);
  if (p.description) process.stdout.write(`  描述    ${p.description}\n`);
  if (p.origin) {
    process.stdout.write(
      `  来源    ${p.origin.type === 'current' ? '当前配置快照' : p.origin.type === 'file' ? `导入 ${p.origin.path ?? ''}` : '手工创建'}\n`,
    );
    process.stdout.write(`  创建    ${ago(p.origin.createdAt)}\n`);
  }
  const { hosts, vendors } = summarize(p.models);
  process.stdout.write(`  模型数  ${p.models.length}\n`);
  process.stdout.write(`  厂商    ${vendors.join(', ') || '-'}\n`);
  process.stdout.write(`  主机    ${hosts.join(', ') || '-'}\n`);

  if (p.models.length) {
    process.stdout.write('\n');
    process.stdout.write(
      renderTable(p.models, [
        { header: 'ID', cell: (m: ModelEntry) => m.id, maxWidth: 24 },
        { header: '名称', cell: (m: ModelEntry) => String(m.name ?? '-'), maxWidth: 22 },
        { header: '厂商', cell: (m: ModelEntry) => String(m.vendor ?? '-'), maxWidth: 12 },
        { header: '地址', cell: (m: ModelEntry) => String(m.url ?? '-'), maxWidth: 44 },
        {
          header: '密钥',
          cell: (m: ModelEntry) => (reveal ? String(m.apiKey ?? '-') : c.gray(maskKey(m.apiKey))),
          maxWidth: 24,
        },
      ]) + '\n',
    );
    const flagsCol = p.models.map((m) => {
      const on: string[] = [];
      if (m.supportsToolCall) on.push('工具调用');
      if (m.supportsImages) on.push('图像');
      if (m.supportsReasoning) on.push('推理');
      return `${m.id}: ${on.join('/') || '—'}`;
    });
    if (has(a, 'verbose')) {
      process.stdout.write('\n' + flagsCol.map((s) => `  ${c.gray(s)}`).join('\n') + '\n');
    }
  } else {
    warn('该源没有任何模型条目。');
  }
  if (!reveal) {
    process.stdout.write(`\n${c.gray('密钥已脱敏；加 --reveal 可显示完整密钥。')}\n`);
  }
  return ExitCode.OK;
}

// ─────────────────────────── 命令：use ───────────────────────────

function cmdUse(a: Args, nameArg?: string): number {
  const r = requireRoot(a);
  const name = nameArg ?? a.positional[1];
  if (!name) throw new UsageError('用法：wb-switch use <名称>');
  const dryRun = has(a, 'dry-run');

  const result = switchTo(name, {
    configDir: r,
    dryRun,
    noBackup: has(a, 'no-backup'),
    force: has(a, 'force'),
  });

  if (has(a, 'json')) {
    jsonOut({
      active: result.platform.active,
      profile: result.profile.name,
      target: result.target,
      backup: result.backup,
      identical: result.identical,
      models: result.profile.models.length,
      dryRun,
    });
    return ExitCode.OK;
  }

  const { hosts, vendors } = summarize(result.profile.models);

  if (dryRun) {
    heading('演练结果（未写入）');
    process.stdout.write(`  将切换至  ${c.bold(c.cyan(result.profile.name))}\n`);
    process.stdout.write(`  写入文件  ${result.target}\n`);
    process.stdout.write(`  模型数    ${result.profile.models.length} ${c.gray(`(${vendors.join(', ') || '-'})`)}\n`);
    process.stdout.write(`  主机      ${hosts.join(', ') || '-'}\n`);
    if (result.identical) process.stdout.write(`  ${c.yellow('注意：与当前配置内容一致，实际切换将只更新记录。')}\n`);
    return ExitCode.OK;
  }

  if (result.identical) {
    ok(`当前已是「${c.bold(c.cyan(result.profile.name))}」，配置内容一致（${result.profile.models.length} 个模型）。`);
  } else {
    ok(`已切换到「${c.bold(c.cyan(result.profile.name))}」 ${c.gray(`(${result.profile.models.length} 个模型 · ${vendors.join(', ') || '-'})`)}`);
    process.stdout.write(`  ${c.gray('写入')} ${result.target}\n`);
    if (result.backup) process.stdout.write(`  ${c.gray('备份')} ${result.backup}\n`);
    process.stdout.write(`  ${c.gray('主机')} ${hosts.join(', ') || '-'}\n`);
  }

  process.stdout.write(
    `\n${c.yellow('提示')} WorkBuddy 会缓存当前模型配置，切换后请在应用内重新打开对话，或重启 WorkBuddy 使其生效。\n`,
  );
  return ExitCode.OK;
}

// ─────────────────────────── 命令：交互式切换 ───────────────────────────

async function cmdInteractive(a: Args): Promise<number> {
  const r = requireRoot(a);
  const names = listProfileNames(r);

  if (names.length === 0) {
    info('还没有任何源。先创建第一个：');
    const defaultName = 'default';
    const name = await promptText('源名称', { default: defaultName, required: true });
    return cmdInit(a, name);
  }

  const state = readState(r);
  let current: ModelEntry[] | null = null;
  try {
    current = readCurrentModels(r);
  } catch {
    current = null;
  }
  const profiles = listProfiles(r, current, state.active);
  const initialIndex = Math.max(
    profiles.findIndex((p) => p.active),
    0,
  );

  const idx = await pick(
    profiles.map((p) => ({
      label: p.name,
      detail: [
        `${p.modelCount} 个模型`,
        p.vendors.join(',') || '',
        p.hosts[0] ?? '',
        p.active ? c.green('← 当前') : p.inSync ? c.yellow('内容一致') : '',
      ]
        .filter(Boolean)
        .join(' · '),
      marked: p.active,
    })),
    {
      title: `选择要启用的源${state.active ? c.gray(`  当前：${state.active}`) : ''}`,
      initialIndex,
    },
  );

  if (idx === null) {
    info('已取消。');
    return ExitCode.OK;
  }
  const chosen = profiles[idx]!;
  if (chosen.active) {
    info(`「${chosen.name}」已是当前源，无需切换。`);
    return ExitCode.OK;
  }
  return cmdUse({ ...a, positional: ['use', chosen.name] }, chosen.name);
}

// ─────────────────────────── 命令：init ───────────────────────────

function cmdInit(a: Args, nameArg?: string): number {
  const r = requireRoot(a);
  const name = nameArg ?? a.positional[1] ?? 'default';
  const realName = validateProfileName(name);

  if (profileExists(r, realName) && !has(a, 'force')) {
    throw new ProfileError(`源已存在：${realName}`, '换个名称，或加 --force 覆盖。');
  }

  const profile = snapshotCurrent(r, realName, str(a, 'description') ?? str(a, 'desc'));
  saveProfile(r, profile);
  setActive(r, realName, readState(r).lastBackup ?? null);

  if (has(a, 'json')) {
    jsonOut({ created: realName, models: profile.models.length });
    return ExitCode.OK;
  }
  ok(`已把当前配置保存为源「${c.bold(c.cyan(realName))}」 ${c.gray(`(${profile.models.length} 个模型)`)}`);
  process.stdout.write(`  ${c.gray('位置')} ${path.join(profilesDir(r), realName + '.json')}\n`);
  process.stdout.write(`\n${c.gray('下一步：')}wb-switch list ${c.gray('查看全部源')}\n`);
  return ExitCode.OK;
}

// ─────────────────────────── 命令：add ───────────────────────────

async function cmdAdd(a: Args): Promise<number> {
  const r = requireRoot(a);
  let name = a.positional[1];
  const fromCurrent = has(a, 'from-current');
  const fromFile = str(a, 'from');
  const url = str(a, 'url');
  const key = str(a, 'key');
  const modelId = str(a, 'model') ?? str(a, 'id');
  const vendor = str(a, 'vendor');
  const description = str(a, 'description') ?? str(a, 'desc');

  if (!name) {
    if (!isInteractive()) {
      throw new UsageError('缺少源名称。用法：wb-switch add <名称> [--from-current | --from <文件> | --url <地址> --key <密钥>]');
    }
    name = await promptText('源名称', { required: true });
  }
  const realName = validateProfileName(name);
  if (profileExists(r, realName) && !has(a, 'force')) {
    throw new ProfileError(`源已存在：${realName}`, '换个名称，或加 --force 覆盖。');
  }

  // 1) 指定了外部文件
  if (fromFile) {
    const file = path.resolve(fromFile);
    if (!exists(file)) throw new ConfigError(`文件不存在：${file}`);
    const data = readJson<unknown>(file);
    const models = validateModels(
      Array.isArray(data) ? data : (data as { models?: unknown })?.models,
      path.basename(file),
    );
    return finishAdd(a, r, {
      name: realName,
      description,
      origin: { type: 'file', path: file, createdAt: new Date().toISOString() },
      models,
    });
  }

  // 2) 以当前配置为模板
  if (fromCurrent) {
    const models = readCurrentModels(r);
    if (!models)
      throw new ConfigError(
        '当前没有 models.json 可作为模板。',
        '改用 --url/--key 手工创建，或先在 WorkBuddy 中添加模型。',
      );
    return finishAdd(a, r, {
      name: realName,
      description,
      origin: { type: 'current', path: modelsFile(r), createdAt: new Date().toISOString() },
      models,
    });
  }

  // 3) 命令行给出 url/key（非交互）
  if (url) {
    const model = buildEntry({
      id: modelId ?? realName,
      url,
      apiKey: key ?? '',
      vendor: vendor ?? 'Custom',
      name: modelId ?? realName,
    });
    return finishAdd(a, r, {
      name: realName,
      description,
      origin: { type: 'manual', createdAt: new Date().toISOString() },
      models: [model],
    });
  }

  // 4) 交互式向导
  if (!isInteractive()) {
    throw new UsageError(
      '非交互环境下需要提供 --url 与 --key，或用 --from-current / --from <文件>。',
    );
  }
  info('按提示填写模型信息（直接回车使用默认值）');
  const entryUrl = await promptText('接口地址 (url)', {
    default: 'https://api.example.com/v1/chat/completions',
    required: true,
    validate: (v) => (/^https?:\/\//i.test(v) ? null : '请以 http:// 或 https:// 开头'),
  });
  const entryKey = await promptText('API Key', { required: false });
  const entryModel = await promptText('模型 ID', { default: realName, required: true });
  const entryVendor = await promptText('厂商 (vendor)', { default: 'Custom' });
  const entryDesc = description ?? (await promptText('描述（可留空）', { required: false }));
  const toolCall = await confirm('支持工具调用 (supportsToolCall)？', { default: true });
  const images = await confirm('支持图像输入 (supportsImages)？', { default: false });
  const reasoning = await confirm('支持推理 (supportsReasoning)？', { default: false });

  const entry: ModelEntry = {
    id: entryModel,
    name: entryModel,
    vendor: entryVendor || 'Custom',
    url: entryUrl,
    apiKey: entryKey,
    supportsToolCall: toolCall,
    supportsImages: images,
    supportsReasoning: reasoning,
    useCustomProtocol: false,
  };

  return finishAdd(a, r, {
    name: realName,
    description: entryDesc || undefined,
    origin: { type: 'manual', createdAt: new Date().toISOString() },
    models: [entry],
  });
}

function buildEntry(input: { id: string; name: string; url: string; apiKey: string; vendor: string }): ModelEntry {
  if (!/^https?:\/\//i.test(input.url)) {
    throw new UsageError(`接口地址不合法：${input.url}`, '需以 https:// 开头。');
  }
  return {
    id: input.id,
    name: input.name,
    vendor: input.vendor,
    url: input.url,
    apiKey: input.apiKey,
    supportsToolCall: true,
    supportsImages: false,
    supportsReasoning: false,
    useCustomProtocol: false,
  };
}

function finishAdd(a: Args, r: string, profile: Profile): number {
  saveProfile(r, profile);
  if (has(a, 'json')) {
    jsonOut({ created: profile.name, models: profile.models.length });
  } else {
    ok(`已创建源「${c.bold(c.cyan(profile.name))}」 ${c.gray(`(${profile.models.length} 个模型)`)}`);
    const { hosts } = summarize(profile.models);
    if (hosts.length) process.stdout.write(`  ${c.gray('主机')} ${hosts.join(', ')}\n`);
  }
  if (has(a, 'switch')) {
    return cmdUse({ ...a, positional: ['use', profile.name] }, profile.name);
  }
  if (!has(a, 'json')) {
    process.stdout.write(`\n${c.gray('启用它：')}wb-switch use ${profile.name}\n`);
  }
  return ExitCode.OK;
}

// ─────────────────────────── 命令：remove / rename ───────────────────────────

async function cmdRemove(a: Args): Promise<number> {
  const r = requireRoot(a);
  const query = a.positional[1];
  if (!query) throw new UsageError('用法：wb-switch remove <名称>');
  const realName = resolveProfileName(r, query);
  const state = readState(r);
  const isActive = state.active?.toLowerCase() === realName.toLowerCase();

  if (!has(a, 'yes')) {
    if (!isInteractive()) {
      throw new UsageError('非交互环境删除源需要加 -y 确认。');
    }
    if (isActive) {
      warn(`「${realName}」正是当前生效的源，删除后 models.json 不会被改动，但将失去回滚依据。`);
    }
    const go = await confirm(`确定删除源「${realName}」？`, { default: false });
    if (!go) {
      info('已取消。');
      return ExitCode.OK;
    }
  }

  const kept = deleteProfile(r, realName, has(a, 'purge'));
  if (isActive) setActive(r, null, state.lastBackup ?? null);

  if (has(a, 'json')) {
    jsonOut({ removed: realName, keptAt: kept });
    return ExitCode.OK;
  }
  ok(`已删除源「${realName}」。`);
  if (kept) process.stdout.write(`  ${c.gray('副本保留在')} ${kept}\n`);
  return ExitCode.OK;
}

function cmdRename(a: Args): number {
  const r = requireRoot(a);
  const oldQ = a.positional[1];
  const newName = a.positional[2];
  if (!oldQ || !newName) throw new UsageError('用法：wb-switch rename <旧名称> <新名称>');
  const oldName = resolveProfileName(r, oldQ);
  const state = readState(r);
  renameProfile(r, oldName, validateProfileName(newName));
  if (state.active?.toLowerCase() === oldName.toLowerCase()) {
    setActive(r, validateProfileName(newName), state.lastBackup ?? null);
  }
  ok(`已重命名「${oldName}」→「${newName}」。`);
  return ExitCode.OK;
}

// ─────────────────────────── 命令：diff ───────────────────────────

function cmdDiff(a: Args): number {
  const r = requireRoot(a);
  const query = a.positional[1];
  if (!query) throw new UsageError('用法：wb-switch diff <名称>');
  const realName = resolveProfileName(r, query);
  const profile = loadProfile(r, realName);
  const current = readCurrentModels(r);

  if (current === null) {
    warn('当前没有 models.json，无法比较。');
    return ExitCode.OK;
  }
  if (modelsEqual(current, profile.models)) {
    ok(`「${realName}」与当前 models.json 完全一致。`);
    return ExitCode.OK;
  }

  const curMap = new Map(current.map((m) => [m.id, m]));
  const newMap = new Map(profile.models.map((m) => [m.id, m]));
  const added = profile.models.filter((m) => !curMap.has(m.id));
  const removed = current.filter((m) => !newMap.has(m.id));
  const changed: { id: string; fields: string[] }[] = [];
  for (const [id, next] of newMap) {
    const prev = curMap.get(id);
    if (!prev) continue;
    const fields: string[] = [];
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
    for (const k of keys) {
      if (k === 'apiKey') {
        if (String(prev.apiKey ?? '') !== String(next.apiKey ?? '')) fields.push('apiKey');
        continue;
      }
      if (JSON.stringify(prev[k]) !== JSON.stringify(next[k])) fields.push(k);
    }
    if (fields.length) changed.push({ id, fields });
  }

  if (has(a, 'json')) {
    jsonOut({
      profile: realName,
      added: added.map((m) => m.id),
      removed: removed.map((m) => m.id),
      changed,
    });
    return ExitCode.OK;
  }

  heading(`差异：当前 models.json ${sym.arrow} 源「${realName}」`);
  if (added.length) {
    process.stdout.write(`  ${c.green('+ 新增')} ${added.map((m) => m.id).join(', ')}\n`);
  }
  if (removed.length) {
    process.stdout.write(`  ${c.red('- 移除')} ${removed.map((m) => m.id).join(', ')}\n`);
  }
  if (changed.length) {
    process.stdout.write(`  ${c.yellow('~ 修改')}\n`);
    for (const ch of changed) {
      process.stdout.write(`      ${ch.id}: ${ch.fields.join(', ')}\n`);
      for (const f of ch.fields) {
        const prev = curMap.get(ch.id)?.[f];
        const next = newMap.get(ch.id)?.[f];
        if (f === 'apiKey') {
          process.stdout.write(`        ${c.gray(maskKey(String(prev ?? '')))} ${sym.arrow} ${c.gray(maskKey(String(next ?? '')))}\n`);
        } else {
          process.stdout.write(`        ${c.gray(JSON.stringify(prev))} ${sym.arrow} ${JSON.stringify(next)}\n`);
        }
      }
    }
  }
  const unchanged = profile.models.filter((m) => curMap.has(m.id) && !changed.some((c2) => c2.id === m.id));
  if (unchanged.length && has(a, 'verbose')) {
    process.stdout.write(`  ${c.gray(`= 未变 ${unchanged.map((m) => m.id).join(', ')}`)}\n`);
  }
  return ExitCode.OK;
}

// ─────────────────────────── 命令：backup / backups / restore ───────────────────────────

function cmdBackup(a: Args): number {
  const r = requireRoot(a);
  const file = modelsFile(r);
  if (!exists(file)) {
    warn(`当前没有 models.json 可备份：${file}`);
    return ExitCode.CONFIG;
  }
  const target = backupFile(file, backupsDir(r), 'models');
  if (has(a, 'json')) {
    jsonOut({ backup: target });
    return ExitCode.OK;
  }
  ok(`已备份 ${c.gray(path.basename(file))} ${sym.arrow} ${c.gray(target ?? '')}`);
  return ExitCode.OK;
}

function backupList(r: string): { file: string; path: string; size: number; mtime: Date }[] {
  return listFiles(backupsDir(r), '.json')
    .map((p) => {
      try {
        const st = fs.statSync(p);
        return { file: path.basename(p), path: p, size: st.size, mtime: st.mtime };
      } catch {
        return null;
      }
    })
    .filter((x): x is { file: string; path: string; size: number; mtime: Date } => x !== null)
    .sort((x, y) => y.mtime.getTime() - x.mtime.getTime());
}

function cmdBackups(a: Args): number {
  const r = requireRoot(a);
  const list = backupList(r);
  if (has(a, 'json')) {
    jsonOut(list.map((b) => ({ file: b.file, size: b.size, mtime: b.mtime.toISOString() })));
    return ExitCode.OK;
  }
  if (list.length === 0) {
    info(`还没有备份。备份目录：${backupsDir(r)}`);
    return ExitCode.OK;
  }
  heading(`共 ${list.length} 个备份 ${c.gray(backupsDir(r))}`);
  process.stdout.write(
    renderTable(list.slice(0, 30), [
      { header: '#', align: 'right', cell: (_b, i) => String(i + 1), maxWidth: 3 },
      { header: '文件', cell: (b) => b.file, maxWidth: 52 },
      { header: '大小', align: 'right', cell: (b) => `${Math.max(1, Math.round(b.size / 1024))}KB`, maxWidth: 6 },
      { header: '时间', cell: (b) => `${b.mtime.toLocaleString('zh-CN')}`, maxWidth: 20 },
      { header: '', cell: (b) => c.gray(ago(b.mtime.toISOString())), maxWidth: 12 },
    ]) + '\n',
  );
  process.stdout.write(`\n${c.gray('还原：')}wb-switch restore <文件名或完整路径>\n`);
  return ExitCode.OK;
}

async function cmdRestore(a: Args): Promise<number> {
  const r = requireRoot(a);
  const arg = a.positional[1];
  let target: string | null = null;

  if (arg) {
    target = exists(arg) ? path.resolve(arg) : path.join(backupsDir(r), arg);
    if (!exists(target)) {
      // 支持按序号：restore 1
      const n = Number.parseInt(arg, 10);
      const list = backupList(r);
      if (Number.isFinite(n) && n >= 1 && n <= list.length) target = list[n - 1]!.path;
    }
  } else {
    const list = backupList(r);
    if (list.length === 0) {
      throw new ConfigError('没有可用备份。', `备份目录为空：${backupsDir(r)}`);
    }
    if (isInteractive() && list.length > 1) {
      const idx = await pick(
        list.slice(0, 20).map((b) => ({
          label: b.file,
          detail: `${b.mtime.toLocaleString('zh-CN')} · ${Math.max(1, Math.round(b.size / 1024))}KB`,
        })),
        { title: '选择要还原的备份', initialIndex: 0 },
      );
      if (idx === null) {
        info('已取消。');
        return ExitCode.OK;
      }
      target = list[idx]!.path;
    } else {
      target = list[0]!.path;
    }
  }

  if (!target || !exists(target)) {
    throw new ConfigError('找不到指定的备份文件。', '用 wb-switch backups 查看可用备份。');
  }

  const models = validateModels(readJson<unknown>(target), path.basename(target));
  if (!has(a, 'yes')) {
    if (!isInteractive()) throw new UsageError('非交互环境还原需要加 -y 确认。');
    warn(`即将用 ${path.basename(target)}（${models.length} 个模型）覆盖当前 models.json。`);
    const go = await confirm('继续？', { default: false });
    if (!go) {
      info('已取消。');
      return ExitCode.OK;
    }
  }

  // 覆盖前再备份一次当前文件
  const file = modelsFile(r);
  const safety = backupFile(file, backupsDir(r), 'models-before-restore');
  const restored = restoreFromBackup(r, target);
  if (has(a, 'json')) {
    jsonOut({ restored: path.basename(target), models: models.length, safety });
    return ExitCode.OK;
  }
  ok(`已还原 ${c.gray(path.basename(target))}（${models.length} 个模型）`);
  if (safety) process.stdout.write(`  ${c.gray('还原前的配置已备份')} ${safety}\n`);
  process.stdout.write(
    restored.active
      ? `  ${c.gray('当前源已回填为')} ${c.cyan(restored.active)}\n`
      : `  ${c.gray('该内容未匹配任何源，当前源指针已清空。')}\n`,
  );
  return ExitCode.OK;
}

// ─────────────────────────── 命令：export / import ───────────────────────────

function cmdExport(a: Args): number {
  const r = requireRoot(a);
  const query = a.positional[1];
  let name = query;
  if (!name) {
    const state = readState(r);
    if (!state.active) throw new UsageError('未指定源，且当前没有激活的源。用法：wb-switch export <名称>');
    name = state.active;
  }
  const realName = resolveProfileName(r, name);
  const profile = loadProfile(r, realName);
  const content = stringifyJson(profile, { indent: 2, trailingNewline: true, eol: '\n' });
  const out = str(a, 'output') ?? str(a, 'out');

  if (out) {
    const target = path.resolve(out);
    writeFileAtomic(target, content);
    ok(`已导出「${realName}」${sym.arrow}${target}`);
  } else {
    process.stdout.write(content);
  }
  return ExitCode.OK;
}

function cmdImport(a: Args): number {
  const r = requireRoot(a);
  const file = a.positional[1];
  if (!file) throw new UsageError('用法：wb-switch import <文件> [名称]');
  const abs = path.resolve(file);
  if (!exists(abs)) throw new ConfigError(`文件不存在：${abs}`);

  const data = readJson<unknown>(abs);
  const isProfile = Boolean(data) && !Array.isArray(data) && Array.isArray((data as { models?: unknown }).models);
  const name =
    a.positional[2] ??
    (isProfile ? String((data as { name?: string }).name ?? path.basename(abs, '.json')) : path.basename(abs, '.json'));
  const realName = validateProfileName(name);
  if (profileExists(r, realName) && !has(a, 'force')) {
    throw new ProfileError(`源已存在：${realName}`, '换个名称，或加 --force 覆盖。');
  }
  const models = validateModels(
    isProfile ? (data as { models: unknown }).models : data,
    path.basename(abs),
  );
  saveProfile(r, {
    name: realName,
    description: isProfile ? (data as { description?: string }).description : undefined,
    origin: { type: 'file', path: abs, createdAt: new Date().toISOString() },
    models,
  });
  ok(`已导入源「${c.bold(c.cyan(realName))}」 ${c.gray(`(${models.length} 个模型)`)}`);
  return ExitCode.OK;
}

// ─────────────────────────── 命令：doctor ───────────────────────────

type CheckLevel = 'ok' | 'warn' | 'fail';
interface DoctorCheck {
  name: string;
  level: CheckLevel;
  detail: string;
}

function cmdDoctor(a: Args): number {
  const r = a.configDir ? path.resolve(a.configDir) : resolveConfigRoot();
  const checks: DoctorCheck[] = [];
  const push = (name: string, level: CheckLevel, detail: string) =>
    checks.push({ name, level, detail });

  // 1. 配置根目录
  if (!isDir(r)) {
    push('配置目录', 'fail', `不存在：${r}`);
    return reportDoctor(a, checks, r);
  }
  push('配置目录', 'ok', r);

  // 2. 数据目录可写
  try {
    assertWritable(dataDir(r));
    push('数据目录', 'ok', `可写 ${dataDir(r)}`);
  } catch (err) {
    push('数据目录', 'fail', describeError(err));
  }

  // 3. models.json
  const file = modelsFile(r);
  let diskModels: ModelEntry[] | null = null;
  if (!exists(file)) {
    push('models.json', 'warn', '不存在（WorkBuddy 将使用内置/登录态模型）');
  } else {
    try {
      const models = loadModels(file);
      diskModels = models;
      const noKey = models.filter((m) => !m.apiKey).length;
      push(
        'models.json',
        noKey > 0 ? 'warn' : 'ok',
        `${models.length} 个模型${noKey ? `，${noKey} 个未设置 apiKey` : ''}`,
      );
      const dup = new Map<string, number>();
      for (const m of models) {
        const h = hostOf(m.url);
        if (h !== '-') dup.set(h, (dup.get(h) ?? 0) + 1);
      }
      for (const [h, n] of dup) {
        if (n > 1) push('地址重复', 'warn', `${h} 出现 ${n} 次（多模型共用一个网关时正常）`);
      }
    } catch (err) {
      push('models.json', 'fail', describeError(err));
    }
  }

  // 4. 源目录与完整性
  const names = listProfileNames(r);
  if (names.length === 0) {
    push('源数量', 'warn', '还没有源，执行 wb-switch init 创建第一个');
  } else {
    push('源数量', 'ok', `${names.length} 个：${names.join(', ')}`);
    const broken: string[] = [];
    for (const n of names) {
      try {
        loadProfile(r, n);
      } catch (err) {
        broken.push(`${n}（${describeError(err)}）`);
      }
    }
    push('源完整性', broken.length ? 'fail' : 'ok', broken.length ? broken.join('; ') : '全部可读');
  }

  // 5. state 与磁盘一致性
  const state = readState(r);
  if (!state.active) {
    push('当前源', 'warn', '未设置（尚未通过 wb-switch 切换过）');
  } else {
    const hit = names.find((n) => n.toLowerCase() === state.active!.toLowerCase());
    if (!hit) {
      push('当前源', 'fail', `指针指向不存在的源「${state.active}」`);
    } else if (diskModels === null) {
      push('当前源', 'warn', `「${hit}」，但 models.json 不存在`);
    } else {
      try {
        const p = loadProfile(r, hit);
        const same = modelsEqual(p.models, diskModels);
        push(
          '当前源',
          same ? 'ok' : 'warn',
          same
            ? `「${hit}」与磁盘一致（${p.models.length} 个模型）`
            : `「${hit}」与磁盘内容不一致（可能被界面改过）`,
        );
      } catch (err) {
        push('当前源', 'fail', describeError(err));
      }
    }
  }

  // 6. 备份
  const bks = backupList(r);
  push(
    '备份',
    bks.length ? 'ok' : 'warn',
    bks.length ? `${bks.length} 个，最新 ${bks[0]!.file}` : '暂无备份（首次切换时会自动备份）',
  );

  // 7. 运行环境
  push('Node', 'ok', process.version);
  push(
    '终端',
    isInteractive() ? 'ok' : 'warn',
    isInteractive() ? '交互式，选择器可用' : '非交互，需用 wb-switch use <名称> 直接指定',
  );

  return reportDoctor(a, checks, r);
}

function reportDoctor(a: Args, checks: DoctorCheck[], r: string): number {
  const fails = checks.filter((k) => k.level === 'fail');
  const warns = checks.filter((k) => k.level === 'warn');

  if (has(a, 'json')) {
    jsonOut({
      configDir: r,
      ok: fails.length === 0,
      checks: checks.map((k) => ({ name: k.name, level: k.level, detail: k.detail })),
    });
    return fails.length ? ExitCode.CONFIG : ExitCode.OK;
  }

  heading(`环境自检 ${c.gray(r)}`);
  const width = Math.max(...checks.map((k) => displayWidth(k.name))) + 2;
  for (const k of checks) {
    const mark =
      k.level === 'ok' ? c.green(sym.ok) : k.level === 'warn' ? c.yellow('!') : c.red(sym.fail);
    const gap = ' '.repeat(Math.max(1, width - displayWidth(k.name)));
    process.stdout.write(`  ${mark} ${k.name}${gap}${c.gray(k.detail)}\n`);
  }

  process.stdout.write('\n');
  if (fails.length === 0 && warns.length === 0) {
    ok('一切正常。');
    return ExitCode.OK;
  }
  if (fails.length === 0) {
    ok(`${checks.length - warns.length} 项正常，${warns.length} 项提示。`);
    return ExitCode.OK;
  }
  fail(`${fails.length} 项异常${warns.length ? `，${warns.length} 项提示` : ''}。`);
  for (const k of fails) process.stdout.write(`  ${c.gray('-')} ${k.name}：${k.detail}\n`);
  return ExitCode.CONFIG;
}

// ─────────────────────────── 主入口 ───────────────────────────

async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    return handleError(err, false);
  }

  if (has(args, 'help') && args.positional.length === 0) {
    printHelp();
    return ExitCode.OK;
  }
  if (has(args, 'version')) {
    printVersion();
    return ExitCode.OK;
  }

  const [cmd, ...rest] = args.positional;

  try {
    switch (cmd) {
      case undefined:
        return await cmdInteractive(args);
      case 'help':
      case '--help':
        printHelp();
        return ExitCode.OK;
      case 'version':
        printVersion();
        return ExitCode.OK;
      case 'list':
      case 'ls':
        return cmdList(args);
      case 'current':
      case 'status':
        return cmdCurrent(args);
      case 'use':
      case 'switch':
      case 'set':
        return cmdUse(args, rest[0]);
      case 'show':
      case 'cat':
        return cmdShow(args);
      case 'diff':
      case 'compare':
        return cmdDiff(args);
      case 'init':
        return cmdInit(args);
      case 'add':
      case 'new':
        return await cmdAdd(args);
      case 'remove':
      case 'rm':
      case 'delete':
        return await cmdRemove(args);
      case 'rename':
      case 'mv':
        return cmdRename(args);
      case 'backup':
        return cmdBackup(args);
      case 'backups':
      case 'history':
        return cmdBackups(args);
      case 'restore':
        return await cmdRestore(args);
      case 'export':
        return cmdExport(args);
      case 'import':
        return cmdImport(args);
      case 'doctor':
      case 'check':
        return cmdDoctor(args);
      default: {
        // 未识别的命令：若恰好是源名，则当作切换
        const r = a2root(args);
        if (isDir(r)) {
          const names = listProfileNames(r);
          if (names.some((n) => n.toLowerCase() === cmd.toLowerCase())) {
            return cmdUse({ ...args, positional: ['use', cmd] }, cmd);
          }
          const prefixed = names.filter((n) => n.toLowerCase().startsWith(cmd.toLowerCase()));
          if (prefixed.length === 1) {
            return cmdUse({ ...args, positional: ['use', prefixed[0]!] }, prefixed[0]!);
          }
        }
        throw new UsageError(`未知命令：${cmd}`, '运行 wb-switch help 查看全部用法。');
      }
    }
  } catch (err) {
    return handleError(err, has(args, 'verbose'));
  }
}

function a2root(a: Args): string {
  return a.configDir ? path.resolve(a.configDir) : resolveConfigRoot();
}

function handleError(err: unknown, verbose: boolean): number {
  if (err instanceof WbError) {
    fail(err.message);
    if (err.hint) process.stderr.write(`  ${c.gray(err.hint)}\n`);
    return err.code;
  }
  if (err instanceof Error) {
    fail(err.message);
    if (verbose && err.stack) process.stderr.write(c.gray(err.stack) + '\n');
    else process.stderr.write(`  ${c.gray('加 -v 查看详细堆栈。')}\n`);
    return ExitCode.GENERAL;
  }
  fail(String(err));
  return ExitCode.GENERAL;
}

// 顶层兜底：保证未捕获异常也有可读输出
process.on('uncaughtException', (err) => {
  fail(`未捕获异常：${err.message}`);
  process.exit(ExitCode.GENERAL);
});
process.on('unhandledRejection', (reason) => {
  fail(`未处理的异步错误：${describeError(reason)}`);
  process.exit(ExitCode.GENERAL);
});

process.title = 'wb-switch';

/**
 * 双击 exe 运行时，Windows 会在进程结束后立刻关闭控制台窗口。
 * 因此「无参数运行」（= 双击进入交互模式）时，无论成功还是出错，
 * 都等待一次按键再退出，避免用户看不到报错。--no-pause 可关闭。
 */
const RAW_ARGS = process.argv.slice(2);
const IS_BARE_RUN = RAW_ARGS.length === 0;

async function pauseIfNeeded(code: number): Promise<void> {
  if (!IS_BARE_RUN) return;
  if (!isInteractive()) return;
  await waitAnyKey(code === 0 ? '\n按任意键退出…' : '\n出错了，按任意键退出…');
}

main(RAW_ARGS)
  .then(async (code) => {
    await pauseIfNeeded(code);
    process.exitCode = code;
  })
  .catch(async (err) => {
    const code = handleError(err, RAW_ARGS.includes('-v') || RAW_ARGS.includes('--verbose'));
    await pauseIfNeeded(code);
    process.exitCode = code;
  });

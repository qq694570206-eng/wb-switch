/**
 * 追加模式：选中组合 / 追加普通源时的 models.json 写入策略。
 *
 * 与普通切换（switchTo，整体替换）并存且互不影响：
 *   - 普通源切换逻辑**完全不变**：switchTo 依旧整体替换 models.json 并置 active
 *   - 组合与追加源走 appendTo：保留 models.json 里已有的全部条目，
 *     把新条目按顺序追加在尾部；state.appended 记录追加顺序
 *
 * 重名处理（WorkBuddy 不支持重名）：
 *   - 被追加条目的 id 若已存在于 models.json：
 *       默认报错并中止（--on-conflict error）
 *       --on-conflict skip   跳过该条目
 *       --on-conflict suffix 自动改名（id-2、id-3…）后追加
 */

import path from 'node:path';
import { ConfigError, EnvError, ProfileError } from './errors.js';
import type { ModelEntry, Profile } from './types.js';
import { assertWritable, exists, isDir } from './fsutil.js';
import { dataDir, modelsFile, resolveConfigRoot } from './paths.js';
import { loadModels, saveModels } from './config.js';
import { loadProfile } from './profiles.js';
import { appendToState } from './state.js';
import { mergeComboIntoRoutes, readRoutes } from './gateway/routes.js';

export type ConflictPolicy = 'error' | 'skip' | 'suffix';

export interface AppendOptions {
  configDir?: string;
  /** id 冲突处理：error（默认）/ skip / suffix */
  onConflict?: ConflictPolicy;
  /** 追加后把组合成员合入网关路由表（默认 true，保持网关可用） */
  syncRoutes?: boolean;
}

export interface AppendResult {
  /** 追加的源/组合名 */
  name: string;
  /** 本次追加进去的条目 */
  added: ModelEntry[];
  /** 因冲突被跳过的条目 */
  skipped: ModelEntry[];
  /** 自动改名的条目（原名 → 新名） */
  renamed: { from: string; to: string }[];
  /** 追加后的 models.json 总条目数 */
  total: number;
  /** 追加顺序（含本次） */
  appended: string[];
}

/** 组合条目的真实可用形态：指向本地网关（走 fallback 链） */
function comboEntry(alias: string): ModelEntry {
  return {
    id: alias,
    name: alias,
    vendor: 'wb-combo',
    url: 'http://127.0.0.1:7533/v1/chat/completions',
    apiKey: 'wb-gateway',
    supportsToolCall: true,
    supportsImages: false,
    supportsReasoning: false,
    useCustomProtocol: false,
  };
}

function gatewayPort(root: string): number {
  return readRoutes(root).port;
}

/**
 * 选中组合：把组合成员按序追加到 models.json 尾部。
 * 不覆盖、不删除任何现有条目；组合成员同时合入网关路由表。
 */
export function useCombo(name: string, options: AppendOptions = {}): AppendResult {
  const root = options.configDir ? path.resolve(options.configDir) : resolveConfigRoot();
  prepareAppendRoot(root);

  const profile = loadProfile(root, name);
  if (profile.type !== 'combo' || !Array.isArray(profile.combo)) {
    throw new ProfileError(
      `「${profile.name}」不是组合，不能按组合选中。`,
      `普通源请用 wb-switch use ${name}（整体替换模式）。`,
    );
  }

  const port = gatewayPort(root);
  const target = modelsFile(root);
  const current = exists(target) ? loadModels(target) : [];

  // 组合成员的 models.json 条目统一指向网关（alias 即模型名）
  const wanted: ModelEntry[] = profile.combo.map(m => ({ ...comboEntry(m.alias), url: `http://127.0.0.1:${port}/v1/chat/completions` }));

  const { merged, added, skipped, renamed } = mergeEntries(current, wanted, options.onConflict ?? 'error');

  saveModels(target, merged);

  // 组合成员合入路由表（网关侧 fallback 链）
  if (options.syncRoutes !== false) {
    mergeComboIntoRoutes(root, profile);
  }

  // state：追加而非替换 active
  const state = appendToState(root, profile.name);

  return {
    name: profile.name,
    added,
    skipped,
    renamed,
    total: merged.length,
    appended: state.appended ?? [profile.name],
  };
}

/**
 * 追加一个普通源：保留现有条目，把该源的模型按序追加在尾部。
 * 与 use <名>（整体替换）并存：append 是纯增量。
 */
export function appendProfile(name: string, options: AppendOptions = {}): AppendResult {
  const root = options.configDir ? path.resolve(options.configDir) : resolveConfigRoot();
  prepareAppendRoot(root);

  const profile = loadProfile(root, name);
  if (profile.type === 'combo') {
    // 组合走 useCombo（条目需指向网关）
    return useCombo(profile.name, options);
  }

  const target = modelsFile(root);
  const current = exists(target) ? loadModels(target) : [];
  const { merged, added, skipped, renamed } = mergeEntries(current, profile.models, options.onConflict ?? 'error');
  saveModels(target, merged);

  const state = appendToState(root, profile.name);

  return {
    name: profile.name,
    added,
    skipped,
    renamed,
    total: merged.length,
    appended: state.appended ?? [profile.name],
  };
}

/** 追加多个源/组合（顺序 = 参数顺序） */
export function appendMany(names: string[], options: AppendOptions = {}): AppendResult[] {
  return names.map(n => appendProfile(n, options));
}

// ─────────────────────────── 内部 ───────────────────────────

function mergeEntries(
  current: ModelEntry[],
  wanted: ModelEntry[],
  policy: ConflictPolicy,
): { merged: ModelEntry[]; added: ModelEntry[]; skipped: ModelEntry[]; renamed: { from: string; to: string }[] } {
  const existingIds = new Set(current.map(m => m.id));
  const added: ModelEntry[] = [];
  const skipped: ModelEntry[] = [];
  const renamed: { from: string; to: string }[] = [];
  const merged = [...current];

  for (const entry of wanted) {
    if (!existingIds.has(entry.id)) {
      merged.push(entry);
      existingIds.add(entry.id);
      added.push(entry);
      continue;
    }
    if (policy === 'skip') {
      skipped.push(entry);
      continue;
    }
    if (policy === 'suffix') {
      let i = 2;
      let candidate = `${entry.id}-${i}`;
      while (existingIds.has(candidate)) {
        i++;
        candidate = `${entry.id}-${i}`;
      }
      const next = { ...entry, id: candidate, name: candidate };
      merged.push(next);
      existingIds.add(candidate);
      added.push(next);
      renamed.push({ from: entry.id, to: candidate });
      continue;
    }
    // policy === 'error'
    throw new ConfigError(
      `追加失败：模型 id「${entry.id}」已存在（WorkBuddy 不支持重名）。`,
      '可选：--on-conflict skip 跳过冲突条目，或 --on-conflict suffix 自动改名（如 ' + entry.id + '-2）。',
    );
  }

  return { merged, added, skipped, renamed };
}

function prepareAppendRoot(root: string): void {
  if (!isDir(root)) {
    throw new EnvError(
      `WorkBuddy 配置目录不存在：${root}`,
      '请确认路径正确；Windows 默认路径为 C:\\Users\\<用户名>\\.workbuddy。',
    );
  }
  assertWritable(dataDir(root));
}

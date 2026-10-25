/**
 * 切换逻辑（核心）。
 *
 * 一次切换的完整步骤（与 ccswitch 的 global switch 思路一致）：
 *   1. 校验目标源存在且结构合法
 *   2. 备份当前 models.json（时间戳命名，失败则中止）
 *   3. 原子写入目标源的模型列表
 *   4. 回读校验写入结果
 *   5. 更新 state.json 的 active 指针
 *
 * 任何一步失败都会保留备份，不会留下半截配置。
 */

import path from 'node:path';
import { ConfigError, EnvError, ProfileError } from './errors.js';
import type { ModelEntry, Profile, SwitchState } from './types.js';
import {
  assertWritable,
  backupFile,
  exists,
  isDir,
  readJson,
  writeFileAtomic,
  detectFormat,
  stringifyJson,
} from './fsutil.js';
import { backupsDir, dataDir, modelsFile, resolveConfigRoot } from './paths.js';
import { loadModels, modelsEqual, saveModels, validateModels } from './config.js';
import { findMatchingProfile, loadProfile, resolveProfileName, listProfileNames } from './profiles.js';
import { readState, setActive } from './state.js';

export interface SwitchOptions {
  /** 只演算不写入 */
  dryRun?: boolean;
  /** 跳过备份（不推荐） */
  noBackup?: boolean;
  /** 内容已一致时仍然重写文件 */
  force?: boolean;
  /** 自定义配置根目录 */
  configDir?: string;
}

export interface SwitchResult {
  profile: Profile;
  /** 实际写入的文件 */
  target: string;
  /** 备份文件路径（未备份为 null） */
  backup: string | null;
  platform: SwitchState;
  /** 内容是否与切换前一致 */
  identical: boolean;
  /** 切换前是否已有 models.json */
  hadPrevious: boolean;
  previousModelCount: number;
}

/** 校验运行环境：目录存在且可写 */
export function prepareRoot(root: string): void {
  if (!isDir(root)) {
    throw new EnvError(
      `WorkBuddy 配置目录不存在：${root}`,
      '请确认路径正确；Windows 默认路径为 C:\\Users\\<用户名>\\.workbuddy。',
    );
  }
  assertWritable(dataDir(root));
}

/** 读取当前 models.json；不存在返回 null（不报错） */
export function readCurrentModels(root: string): ModelEntry[] | null {
  const file = modelsFile(root);
  if (!exists(file)) return null;
  return loadModels(file);
}

/** 执行切换 */
export function switchTo(nameOrQuery: string, options: SwitchOptions = {}): SwitchResult {
  const root = options.configDir ? path.resolve(options.configDir) : resolveConfigRoot();
  prepareRoot(root);

  const names = listProfileNames(root);
  if (names.length === 0) {
    throw new ProfileError(
      '还没有任何源可供切换。',
      '先执行 wb-switch init（把当前配置保存为首个源），或 wb-switch add <名称>。',
    );
  }

  const realName = resolveProfileName(root, nameOrQuery);
  const profile = loadProfile(root, realName);
  if (profile.models.length === 0) {
    throw new ProfileError(
      `源「${realName}」是空的（没有任何模型条目），切换后 WorkBuddy 将无可用的自定义模型。`,
      `请先编辑该源：wb-switch show ${realName}，或删除后重建。`,
    );
  }

  const target = modelsFile(root);
  const current = readCurrentModels(root);
  const identical = current !== null && modelsEqual(current, profile.models);

  if (identical && !options.force) {
    // 内容一致时仍更新指针，保证 state 与实际一致
    const state = setActive(root, realName, readState(root).lastBackup ?? null);
    return {
      profile,
      target,
      backup: null,
      platform: state,
      identical: true,
      hadPrevious: true,
      previousModelCount: current?.length ?? 0,
    };
  }

  if (options.dryRun) {
    return {
      profile,
      target,
      backup: null,
      platform: readState(root),
      identical,
      hadPrevious: current !== null,
      previousModelCount: current?.length ?? 0,
    };
  }

  // 备份当前配置
  let backup: string | null = null;
  if (!options.noBackup) {
    backup = backupFile(target, backupsDir(root), `models-${safeLabel(realName)}`);
  }

  // 写入目标配置
  try {
    if (current === null) {
      // 之前没有 models.json，直接按标准格式创建
      writeFileAtomic(target, stringifyJson(profile.models, detectFormat(target)));
    } else {
      saveModels(target, profile.models);
    }
  } catch (err) {
    if (backup) {
      throw new ConfigError(
        `写入失败，已保留备份：${backup}\n原因：${(err as Error).message}`,
        `可执行 wb-switch restore "${backup}" 还原。`,
      );
    }
    throw err;
  }

  // 回读校验，确保落盘内容正确
  let written: ModelEntry[] | null = null;
  try {
    written = loadModels(target);
  } catch (err) {
    if (backup) restoreFromBackup(root, backup);
    throw new ConfigError(
      `写入后校验失败，已${backup ? '自动还原备份' : '中止'}：${(err as Error).message}`,
      backup ? `备份位置：${backup}` : undefined,
    );
  }

  if (written === null || !modelsEqual(written, profile.models)) {
    if (backup) restoreFromBackup(root, backup);
    throw new ConfigError(
      `写入后内容与源不一致，已${backup ? '自动还原备份' : '中止'}。`,
      '可能是磁盘写入异常或文件被其它程序占用，请重试。',
    );
  }

  const state = setActive(root, realName, backup ? path.basename(backup) : null);

  return {
    profile,
    target,
    backup,
    platform: state,
    identical: false,
    hadPrevious: current !== null,
    previousModelCount: current?.length ?? 0,
  };
}

function safeLabel(name: string): string {
  return name.replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 32);
}

/** 从备份文件还原 models.json；若内容命中某个源，则回填当前源指针 */
export function restoreFromBackup(root: string, backupPath: string): { active: string | null } {
  if (!exists(backupPath)) {
    throw new ConfigError(`备份文件不存在：${backupPath}`);
  }
  const data = readJson<unknown>(backupPath);
  const models = validateModels(data, path.basename(backupPath));
  saveModels(modelsFile(root), models);
  const matched = findMatchingProfile(root, models);
  setActive(root, matched, path.basename(backupPath));
  return { active: matched };
}

/** 把当前 models.json 保存为源 */
export function snapshotCurrent(
  root: string,
  name: string,
  description?: string,
): Profile {
  prepareRoot(root);
  const file = modelsFile(root);
  if (!exists(file)) {
    throw new ConfigError(
      `当前没有 models.json：${file}`,
      '请先在 WorkBuddy 中添加至少一个模型，或使用 wb-switch add 手工创建源。',
    );
  }
  const models = loadModels(file);
  return {
    name,
    description,
    origin: { type: 'current', path: file, createdAt: new Date().toISOString() },
    models,
  };
}

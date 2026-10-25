/**
 * 源（profile）存储管理。
 *
 * 布局：
 *   <configRoot>/wb-switch/profiles/<safeName>.json   —— 每个源一份快照
 *   <configRoot>/wb-switch/state.json                  —— 当前激活源指针
 *   <configRoot>/wb-switch/backups/                    —— 切换前备份 & 删除的源
 *
 * 每个源文件内容：
 * { "name": "...", "description": "...", "origin": {...}, "models": [ ... ] }
 */

import fs from 'node:fs';
import path from 'node:path';
import { ProfileError } from './errors.js';
import type { Profile, ProfileSummary } from './types.js';
import {
  ensureDir,
  exists,
  listFiles,
  moveFile,
  readJson,
  stringifyJson,
  timestamp,
  writeFileAtomic,
} from './fsutil.js';
import { backupsDir, profilesDir, safeFileName } from './paths.js';
import { canonical, modelsEqual, summarize, validateModels } from './config.js';

/** 源名称合法性校验 */
export function validateProfileName(name: string): string {
  const n = name.trim();
  if (!n) throw new ProfileError('源名称不能为空。');
  if (n.length > 64) throw new ProfileError('源名称过长（最多 64 个字符）。');
  if (/[<>:"/\\|?*\u0000-\u001F]/.test(n)) {
    throw new ProfileError(
      `源名称包含非法字符："${n}"。`,
      '名称中不能出现 < > : " / \\ | ? * 等字符。',
    );
  }
  return n;
}

function profilePath(root: string, name: string): string {
  return path.join(profilesDir(root), `${safeFileName(name)}.json`);
}

/** 列出所有源名称（按字母序） */
export function listProfileNames(root: string): string[] {
  const dir = profilesDir(root);
  return listFiles(dir, '.json')
    .map((p) => {
      try {
        const data = readJson<Profile>(p);
        return typeof data?.name === 'string' && data.name ? data.name : path.basename(p, '.json');
      } catch {
        return path.basename(p, '.json');
      }
    })
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

/** 读取单个源 */
export function loadProfile(root: string, name: string): Profile {
  const file = profilePath(root, name);
  if (!exists(file)) {
    throw new ProfileError(
      `源不存在：${name}`,
      '用 wb-switch list 查看全部源，或 wb-switch add 新建。',
    );
  }
  const data = readJson<Partial<Profile>>(file);
  const models = validateModels(data.models, `源「${name}」`);
  return {
    name: typeof data.name === 'string' && data.name ? data.name : name,
    description: typeof data.description === 'string' ? data.description : undefined,
    origin: data.origin,
    models,
  };
}

/** 写入源（新增或覆盖） */
export function saveProfile(root: string, profile: Profile): void {
  const dir = profilesDir(root);
  ensureDir(dir);
  const file = profilePath(root, profile.name);
  writeFileAtomic(file, stringifyJson(profile, { indent: 2, trailingNewline: true, eol: '\n' }));
}

/** 源是否已存在（大小写不敏感） */
export function profileExists(root: string, name: string): boolean {
  return listProfileNames(root).some((n) => n.toLowerCase() === name.trim().toLowerCase());
}

/**
 * 按名称解析源，支持：
 *  - 精确匹配（大小写不敏感）
 *  - 唯一前缀匹配（如 use ds → deepseek）
 * 返回真实名称；无法唯一确定时抛错。
 */
export function resolveProfileName(root: string, query: string): string {
  const names = listProfileNames(root);
  if (names.length === 0) {
    throw new ProfileError(
      '还没有任何源。',
      '先执行 wb-switch init 把当前 models.json 保存为第一个源。',
    );
  }
  const q = query.trim();
  const exact = names.find((n) => n.toLowerCase() === q.toLowerCase());
  if (exact) return exact;

  const prefixed = names.filter((n) => n.toLowerCase().startsWith(q.toLowerCase()));
  if (prefixed.length === 1) return prefixed[0]!;
  if (prefixed.length > 1) {
    throw new ProfileError(
      `源名称「${q}」不唯一，候选：${prefixed.join(', ')}`,
      '请给出更完整的名称。',
    );
  }

  const contains = names.filter((n) => n.toLowerCase().includes(q.toLowerCase()));
  if (contains.length === 1) return contains[0]!;

  throw new ProfileError(
    `找不到源：${q}`,
    `可用源：${names.join(', ')}`,
  );
}

/**
 * 删除源。默认保留一份副本到 backups/deleted-*，避免误删后无法恢复。
 * purge=true 时同时清理该副本。
 */
export function deleteProfile(root: string, name: string, purge = false): string | null {
  const file = profilePath(root, name);
  if (!exists(file)) {
    throw new ProfileError(`源不存在：${name}`);
  }
  let kept: string | null = null;
  if (!purge) {
    const bdir = backupsDir(root);
    ensureDir(bdir);
    kept = path.join(bdir, `deleted-${safeFileName(name)}-${timestamp()}.json`);
    moveFile(file, kept);
  } else {
    try {
      fs.unlinkSync(file);
    } catch (err) {
      throw new ProfileError(`删除失败：${name}（${(err as Error).message}）`);
    }
  }
  return kept;
}

/** 重命名源（同时更新 state 指针由调用方负责） */
export function renameProfile(root: string, oldName: string, newName: string): void {
  const src = profilePath(root, oldName);
  if (!exists(src)) throw new ProfileError(`源不存在：${oldName}`);
  if (profileExists(root, newName)) throw new ProfileError(`源已存在：${newName}`);
  const profile = loadProfile(root, oldName);
  profile.name = validateProfileName(newName);
  saveProfile(root, profile);
  try {
    fs.unlinkSync(src);
  } catch {
    /* 旧文件删除失败不致命 */
  }
}

/** 生成展示用的源列表 */
export function listProfiles(
  root: string,
  currentModels: import('./types.js').ModelEntry[] | null,
  activeName: string | null,
): ProfileSummary[] {
  return listProfileNames(root).map((name) => {
    let profile: Profile | null = null;
    try {
      profile = loadProfile(root, name);
    } catch {
      profile = null;
    }
    const models = profile?.models ?? [];
    const { hosts, vendors } = summarize(models);
    return {
      name,
      description: profile?.description,
      modelCount: models.length,
      vendors,
      hosts,
      active: activeName !== null && activeName.toLowerCase() === name.toLowerCase(),
      createdAt: profile?.origin?.createdAt,
      inSync: currentModels !== null && profile !== null && modelsEqual(models, currentModels),
    };
  });
}

/** 判断源内容是否与给定模型列表一致 */
export function isSameAs(profile: Profile, models: import('./types.js').ModelEntry[]): boolean {
  return canonical(profile.models) === canonical(models);
}

/** 在所有源中查找与给定模型列表内容一致的源（用于还原后回填当前源指针） */
export function findMatchingProfile(
  root: string,
  models: import('./types.js').ModelEntry[],
): string | null {
  const target = canonical(models);
  for (const name of listProfileNames(root)) {
    try {
      const p = loadProfile(root, name);
      if (canonical(p.models) === target) return name;
    } catch {
      /* 跳过损坏的源 */
    }
  }
  return null;
}

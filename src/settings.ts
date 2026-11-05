/**
 * 用户偏好设置（settings.json）。
 *
 * 目前只有一项：切换前是否把当前 models.json 归档到 backups/。
 * 默认 **关闭**——切换不再自动堆备份，需要留档时用 `wb-switch backup`
 * 或界面上的「立即备份」。
 *
 * 注意：关掉自动备份不影响失败回滚。switchTo 会另建一份临时快照，
 * 写入校验通过后立即删除，失败时用它还原。
 */

import { exists, readJson, stringifyJson, ensureDir, writeFileAtomic } from './fsutil.js';
import { dataDir, settingsFile } from './paths.js';

export interface Settings {
  /** 切换前是否归档备份到 backups/ */
  autoBackup: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  autoBackup: false,
};

export function readSettings(root: string): Settings {
  const file = settingsFile(root);
  if (!exists(file)) return { ...DEFAULT_SETTINGS };
  try {
    const raw = readJson<Partial<Settings>>(file);
    return {
      autoBackup: typeof raw.autoBackup === 'boolean' ? raw.autoBackup : DEFAULT_SETTINGS.autoBackup,
    };
  } catch {
    // 设置文件损坏不该阻塞切换，回落默认值
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeSettings(root: string, patch: Partial<Settings>): Settings {
  const next: Settings = { ...readSettings(root), ...patch };
  ensureDir(dataDir(root));
  writeFileAtomic(settingsFile(root), stringifyJson(next, { indent: 2, trailingNewline: true, eol: '\n' }));
  return next;
}

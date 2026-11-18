/**
 * 激活状态（state.json）读写。
 *
 * { "active": "deepseek", "updatedAt": "2026-10-24T14:45:00.000Z", "lastBackup": "models-...json" }
 */

import { exists, readJson, stringifyJson, ensureDir, writeFileAtomic } from './fsutil.js';
import { dataDir, stateFile } from './paths.js';
import type { SwitchState } from './types.js';

const EMPTY: SwitchState = { active: null, updatedAt: null, lastBackup: null };

export function readState(root: string): SwitchState {
  const file = stateFile(root);
  if (!exists(file)) return { ...EMPTY };
  try {
    const data = readJson<Partial<SwitchState>>(file);
    return {
      active: typeof data.active === 'string' && data.active ? data.active : null,
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null,
      lastBackup: typeof data.lastBackup === 'string' ? data.lastBackup : null,
      appended: Array.isArray(data.appended) ? data.appended.filter((x): x is string => typeof x === 'string') : undefined,
    };
  } catch {
    // 状态文件损坏不应阻塞主流程，视为未切换
    return { ...EMPTY };
  }
}

export function writeState(root: string, state: SwitchState): void {
  ensureDir(dataDir(root));
  writeFileAtomic(stateFile(root), stringifyJson(state, { indent: 2, trailingNewline: true, eol: '\n' }));
}

export function setActive(root: string, name: string | null, lastBackup?: string | null): SwitchState {
  const prev = readState(root);
  const next: SwitchState = {
    active: name,
    updatedAt: new Date().toISOString(),
    lastBackup: lastBackup !== undefined ? lastBackup : prev.lastBackup ?? null,
  };
  writeState(root, next);
  return next;
}

/** 追加模式：记录一次「组合/源追加」，active 与 appended 均不被覆盖 */
export function appendToState(root: string, name: string): SwitchState {
  const prev = readState(root);
  const appended = new Set(prev.appended ?? []);
  // 去重：重复追加同一组合/源时保持原位置（先到先得）
  if (!appended.has(name)) appended.add(name);
  const next: SwitchState = {
    ...prev,
    appended: [...appended],
    updatedAt: new Date().toISOString(),
  };
  writeState(root, next);
  return next;
}

/** 追加模式：从追加列表移除一项（用于 undo / remove append） */
export function removeFromAppended(root: string, name: string): SwitchState {
  const prev = readState(root);
  const appended = (prev.appended ?? []).filter(x => x !== name);
  const next: SwitchState = {
    ...prev,
    appended,
    updatedAt: new Date().toISOString(),
  };
  writeState(root, next);
  return next;
}

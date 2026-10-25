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

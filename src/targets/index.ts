/**
 * Target 注册表：发现、选择、持久化「当前目标工具」。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { TargetAdapter, TargetInfo } from './types.js';
import { WorkBuddyTarget } from './workbuddy.js';
import { CodexTarget } from './codex.js';

export type { TargetAdapter, TargetInfo, ApplyResult } from './types.js';

export type TargetId = 'workbuddy' | 'codex';

/** 全部已支持的 target id（顺序即优先级） */
export const TARGET_IDS: TargetId[] = ['workbuddy', 'codex'];

export interface TargetOptions {
  /** WorkBuddy 配置根覆盖（--config-dir） */
  workbuddyRoot?: string;
  /** 网关地址（Codex 用） */
  gatewayBase?: string;
  /** 工具自身数据目录（用于存 current-target.json） */
  wbSwitchDataDir?: string;
}

/** 创建全部 target 实例 */
export function createTargets(opts: TargetOptions = {}): TargetAdapter[] {
  return [
    new WorkBuddyTarget(opts.workbuddyRoot),
    new CodexTarget(opts.gatewayBase ?? 'http://127.0.0.1:7533/v1'),
  ];
}

/** 按 id 取一个 target */
export function getTarget(id: string, opts: TargetOptions = {}): TargetAdapter {
  const all = createTargets(opts);
  const found = all.find((t) => t.id === id);
  if (!found) {
    throw new Error(
      `未知目标工具「${id}」。可用：${all.map((t) => `${t.id}(${t.name})`).join('、')}`,
    );
  }
  return found;
}

/** 列出全部 target 的展示信息 */
export function listTargets(opts: TargetOptions = {}): TargetInfo[] {
  return createTargets(opts).map((t) => t.describe());
}

/** current-target.json 路径 */
function currentFile(dataDir: string): string {
  return path.join(dataDir, 'current-target.json');
}

/** 读取当前选中的 target id（缺省 workbuddy，保持向后兼容） */
export function readCurrentTarget(dataDir: string): TargetId {
  try {
    const file = currentFile(dataDir);
    if (!fs.existsSync(file)) return 'workbuddy';
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { target?: string };
    const id = data.target;
    if (id && TARGET_IDS.includes(id as TargetId)) return id as TargetId;
    return 'workbuddy';
  } catch {
    return 'workbuddy';
  }
}

/** 写入当前 target */
export function writeCurrentTarget(dataDir: string, id: TargetId): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = currentFile(dataDir);
  fs.writeFileSync(file, JSON.stringify({ target: id, updatedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
}

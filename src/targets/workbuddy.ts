/**
 * WorkBuddy 适配器。
 *
 * 配置：<root>/models.json —— 一个模型条目数组。
 * 这是 wb-switch 的原生目标，行为与旧版完全一致（整体替换 / 追加）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelEntry } from '../types.js';
import type { ApplyResult, TargetAdapter, TargetInfo } from './types.js';
import { expandPath, writeFileAtomicSafe } from './types.js';

/** WorkBuddy 配置根目录（可用环境变量覆盖，兼容旧行为） */
export function workbuddyRoot(): string {
  const fromEnv =
    process.env.WB_CONFIG_DIR?.trim() ||
    process.env.WORKBUDDY_HOME?.trim() ||
    process.env.WORKBUDDY_CONFIG_DIR?.trim();
  if (fromEnv) return path.resolve(expandPath(fromEnv));
  return path.join(os.homedir(), '.workbuddy');
}

export class WorkBuddyTarget implements TargetAdapter {
  readonly id = 'workbuddy';
  readonly name = 'WorkBuddy';
  readonly format = 'json-array' as const;
  readonly protocol = 'chat' as const;

  constructor(private overrideRoot?: string) {}

  /** 配置根目录（GUI/CLI 的 --config-dir 可覆盖） */
  root(): string {
    return this.overrideRoot ? path.resolve(this.overrideRoot) : workbuddyRoot();
  }

  configPath(): string {
    return path.join(this.root(), 'models.json');
  }

  installed(): boolean {
    const root = this.root();
    if (!fs.existsSync(root)) return false;
    // 有 models.json 就算装过；否则有其它 WorkBuddy 特征目录也算
    if (fs.existsSync(this.configPath())) return true;
    return fs.existsSync(path.join(root, 'config'));
  }

  readModels(): ModelEntry[] | null {
    const file = this.configPath();
    if (!fs.existsSync(file)) return null;
    try {
      const text = fs.readFileSync(file, 'utf8').trim();
      if (!text) return [];
      const data = JSON.parse(text) as unknown;
      if (Array.isArray(data)) return data as ModelEntry[];
      // 少数版本可能包一层 { models: [...] }
      if (data && typeof data === 'object' && Array.isArray((data as { models?: unknown }).models)) {
        return (data as { models: ModelEntry[] }).models;
      }
      return [];
    } catch {
      return null;
    }
  }

  writeModels(models: ModelEntry[], options: { merge?: boolean } = {}): ApplyResult {
    const file = this.configPath();
    let out = models;
    const notes: string[] = [];

    if (options.merge) {
      const current = this.readModels() ?? [];
      const byId = new Map(current.map((m) => [m.id, m]));
      let added = 0;
      for (const m of models) {
        if (!byId.has(m.id)) {
          byId.set(m.id, m);
          added++;
        }
      }
      out = [...byId.values()];
      notes.push(`追加 ${added} 个模型（共 ${out.length} 个）`);
    }

    writeFileAtomicSafe(file, JSON.stringify(out, null, 2) + '\n');
    return { file, modelCount: out.length, notes };
  }

  describe(): TargetInfo {
    return {
      id: this.id,
      name: this.name,
      configPath: this.configPath(),
      format: this.format,
      protocol: this.protocol,
      installed: this.installed(),
      hint: 'WorkBuddy 桌面/CLI，models.json 为模型条目数组',
    };
  }
}

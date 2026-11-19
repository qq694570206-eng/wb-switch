/**
 * Target（目标工具）适配器。
 *
 * wb-switch 从「WorkBuddy 专用」升级为「通用模型切换工具」：
 * 每个被支持的工具（WorkBuddy / Codex / …）都是一个 Target，
 * 由适配器负责：
 *   - 定位配置文件
 *   - 读取当前生效的模型列表（统一成 ModelEntry[]）
 *   - 写出选中的源/组合
 *   - 备份/还原
 *
 * 上层（switcher / combo / GUI）只跟 ModelEntry[] 打交道，
 * 不关心目标工具的具体格式（JSON 数组 / TOML / env 变量…）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelEntry } from '../types.js';
export type { ModelEntry };

/** 目标工具描述 */
export interface TargetInfo {
  /** 内部 id，用于 CLI --target 与数据目录名 */
  id: string;
  /** 展示名 */
  name: string;
  /** 配置文件路径 */
  configPath: string;
  /** 配置文件格式 */
  format: 'json-array' | 'toml' | 'json-env';
  /** 该工具使用的协议 */
  protocol: 'chat' | 'responses';
  /** 是否检测到已安装 */
  installed: boolean;
  /** 简短说明 */
  hint?: string;
}

/** 切换结果 */
export interface ApplyResult {
  /** 写入的文件 */
  file: string;
  /** 写入的模型数 */
  modelCount: number;
  /** 额外提示（如需要重启） */
  notes: string[];
}

/** 一个目标工具的适配器 */
export interface TargetAdapter {
  readonly id: string;
  /** 展示名 */
  readonly name: string;
  /** 配置格式 */
  readonly format: TargetInfo['format'];
  /** 原生协议 */
  readonly protocol: 'chat' | 'responses';

  /** 配置文件路径（按环境变量解析） */
  configPath(): string;

  /** 是否已安装/有配置 */
  installed(): boolean;

  /** 读取当前配置里的模型列表；文件不存在返回 null */
  readModels(): ModelEntry[] | null;

  /**
   * 把一份源/组合写成该工具的「当前配置」。
   * options.merge=true 表示追加模式（保留已有条目）。
   */
  writeModels(models: ModelEntry[], options?: { merge?: boolean }): ApplyResult;

  /** 补充信息（界面展示用） */
  describe(): TargetInfo;
}

/** 展开 ~ 与环境变量 */
export function expandPath(input: string): string {
  let p = input;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(2));
  p = p.replace(/%([^%]+)%/g, (_m, name: string) => process.env[name] ?? `%${name}%`);
  p = p.replace(/\$\{([^}]+)\}/g, (_m, name: string) => process.env[name] ?? '');
  return p;
}

/** 读取 JSON 文件（容错） */
export function readJsonFile<T>(file: string): T | null {
  if (!fs.existsSync(file)) return null;
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    if (!text) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** 原子写文件 */
export function writeFileAtomicSafe(file: string, content: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

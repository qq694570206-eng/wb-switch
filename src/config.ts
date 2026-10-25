/**
 * models.json 的解析、校验与写回。
 *
 * 结构：模型条目数组
 * [
 *   {
 *     "id": "deepseek-flash",
 *     "name": "deepseek-flash",
 *     "vendor": "Custom",
 *     "url": "https://token.sensenova.cn/v1/chat/completions",
 *     "apiKey": "sk-...",
 *     "supportsToolCall": true,
 *     "supportsImages": false,
 *     "supportsReasoning": false,
 *     "useCustomProtocol": false
 *   }
 * ]
 */

import { ConfigError } from './errors.js';
import type { ModelEntry } from './types.js';
import { detectFormat, readJson, readText, stringifyJson, writeFileAtomic } from './fsutil.js';

/** 读取并校验 models.json */
export function loadModels(file: string): ModelEntry[] {
  const data = readJson<unknown>(file);
  return validateModels(data, file);
}

/** 校验结构，返回规范化后的条目（保留未知字段） */
export function validateModels(data: unknown, source = 'models.json'): ModelEntry[] {
  if (!Array.isArray(data)) {
    throw new ConfigError(
      `${source} 的顶层结构应为数组，实际为 ${typeName(data)}。`,
      'models.json 应形如 [ { "id": "...", "url": "...", "apiKey": "..." } ]。',
    );
  }

  const seen = new Set<string>();
  const models: ModelEntry[] = [];

  data.forEach((item, idx) => {
    const where = `${source} 第 ${idx + 1} 项`;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new ConfigError(`${where} 不是对象（实际为 ${typeName(item)}）。`);
    }
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : undefined;
    if (!id) {
      throw new ConfigError(`${where} 缺少字符串类型的 "id" 字段。`);
    }
    if (seen.has(id)) {
      throw new ConfigError(
        `${source} 中存在重复的模型 id："${id}"。`,
        '请修改重复条目的 id（id 为模型唯一标识）。',
      );
    }
    seen.add(id);

    if (typeof obj.url === 'string' && obj.url.trim()) {
      assertUrlLike(obj.url.trim(), `${where}（id=${id}）的 url`);
    }
    if (obj.apiKey !== undefined && typeof obj.apiKey !== 'string') {
      throw new ConfigError(`${where}（id=${id}）的 "apiKey" 应为字符串。`);
    }

    // 保留全部字段（含未知字段），仅对 id 做 trim 规范化
    models.push({ ...(obj as ModelEntry), id });
  });

  return models;
}

function assertUrlLike(url: string, label: string): void {
  if (!/^https?:\/\//i.test(url)) {
    throw new ConfigError(
      `${label} 不是 http(s) 地址："${url}"。`,
      '自定义网关地址需以 https:// 开头，例如 https://api.example.com/v1/chat/completions。',
    );
  }
  try {
    // eslint-disable-next-line no-new
    new URL(url);
  } catch {
    throw new ConfigError(`${label} 不是合法 URL："${url}"。`);
  }
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** 写入 models.json，尽量沿用原文件的缩进与换行风格 */
export function saveModels(file: string, models: ModelEntry[]): void {
  const fmt = detectFormat(file);
  writeFileAtomic(file, stringifyJson(models, fmt));
}

/** 判断两份模型列表内容是否一致（忽略字段顺序） */
export function modelsEqual(a: ModelEntry[], b: ModelEntry[]): boolean {
  return canonical(a) === canonical(b);
}

/** 规范化 JSON 字符串，用于比较 */
export function canonical(models: ModelEntry[]): string {
  return JSON.stringify(sortValue(models));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = sortValue(obj[key]);
    return out;
  }
  return value;
}

/** 读取原始文本（用于「是否被外部修改」的判断） */
export function readModelsText(file: string): string {
  return readText(file);
}

/** 脱敏 API Key：保留前 6 位与后 4 位 */
export function maskKey(key?: string): string {
  if (!key) return '(未设置)';
  const k = key.trim();
  if (!k) return '(空)';
  if (k.length <= 8) return `${k.slice(0, 2)}${'*'.repeat(Math.max(k.length - 2, 1))}`;
  if (k.length < 12) return `${k.slice(0, 3)}${'*'.repeat(k.length - 5)}${k.slice(-2)}`;
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

/** 从 url 中提取 host，便于列表展示 */
export function hostOf(url?: string): string {
  if (!url) return '-';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 汇总一个模型列表涉及的 host 与 vendor */
export function summarize(models: ModelEntry[]): { hosts: string[]; vendors: string[] } {
  const hosts = new Set<string>();
  const vendors = new Set<string>();
  for (const m of models) {
    if (m.url) hosts.add(hostOf(m.url));
    if (m.vendor) vendors.add(String(m.vendor));
  }
  return { hosts: [...hosts].sort(), vendors: [...vendors].sort() };
}

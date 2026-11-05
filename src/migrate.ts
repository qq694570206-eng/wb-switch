/**
 * 旧格式迁移 & 外部源导入。
 *
 * 两个核心入口：
 *   1) migrateFromSourcesJson —— 把旧 wbs(Python) 的 sources.json 转成 profiles/*.json
 *   2) importFromCcSwitch      —— 把 CC Switch SQLite 里的 provider 转成 profiles/*.json
 *
 * 两者共用 buildModelsFromSource()：url + apiKey + modelIds → ModelEntry[]
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { ConfigError } from './errors.js';
import type { ModelEntry, Profile } from './types.js';
import { exists, readJson } from './fsutil.js';
import { dataDir, profilesDir, resolveConfigRoot, safeFileName } from './paths.js';
import { listProfileNames, saveProfile, validateProfileName } from './profiles.js';

// ── 公共类型 ──

/** 旧 sources.json 里的单条源记录 */
export interface LegacySource {
  name: string;
  url: string;
  apiKey: string;
  knownModels?: string[];
}

/** 导入结果 */
export interface ImportResult {
  /** 成功导入的源名 */
  imported: string[];
  /** 因同名跳过的源名 */
  skipped: string[];
  /** 导入失败的源名 + 原因 */
  failed: { name: string; reason: string }[];
  /** 总数 */
  total: number;
}

// ── 公共：把 url + apiKey + modelIds 组成 ModelEntry[] ──

/**
 * 把一个外部源（url + apiKey + 已知模型 id 列表）转成 models.json 格式的条目数组。
 * 如果 modelIds 为空，生成一个占位条目（id = 源名），保证切换后不空。
 */
export function buildModelsFromSource(
  name: string,
  url: string,
  apiKey: string,
  modelIds: string[] = [],
): ModelEntry[] {
  if (!url || !apiKey) {
    throw new ConfigError(
      `源「${name}」缺少 url 或 apiKey，无法生成模型条目。`,
      '请补全后再导入。',
    );
  }

  const ids = modelIds.filter((m) => typeof m === 'string' && m.trim());
  const finalIds = ids.length > 0 ? ids : [name];

  return finalIds.map((mid) => ({
    id: mid,
    name: mid,
    vendor: 'Custom',
    url,
    apiKey,
    supportsToolCall: true,
    supportsImages: false,
    supportsReasoning: false,
    useCustomProtocol: false,
  }));
}

/** 根据 URL 猜测源名（移植自 wbs guess_name） */
export function guessName(url: string): string {
  const u = url.toLowerCase();
  const hints: [string, string][] = [
    ['agnes', 'agnes'],
    ['openrouter', 'openrouter'],
    ['sensenova', 'sensenova'],
    ['dignal', 'dignal'],
    ['deepseek', 'deepseek'],
    ['openai', 'openai'],
    ['anthropic', 'anthropic'],
    ['moonshot', 'moonshot'],
    ['kimi', 'kimi'],
    ['zhipu', 'zhipu'],
    ['glm', 'zhipu'],
    ['siliconflow', 'siliconflow'],
    ['together', 'together'],
    ['groq', 'groq'],
    ['modelscope', 'modelscope'],
    ['wusrouter', 'wusrouter'],
    ['tokenrouter', 'tokenrouter'],
    ['chatanywhere', 'chatanywhere'],
    ['aipaibox', 'aipaibox'],
  ];
  for (const [keyword, name] of hints) {
    if (u.includes(keyword)) return name;
  }
  try {
    const host = new URL(url).hostname || 'unknown';
    return host.split('.')[0] || 'source';
  } catch {
    return 'source';
  }
}

// ── 1) sources.json 迁移 ──

/**
 * 读取旧 sources.json，兼容三种格式：
 *   - 顶层 list（wbs Python 版）
 *   - { sources: [...] } 或 { profiles: [...] }
 *   - 顶层 dict（key 为源名）
 */
export function readLegacySources(filePath: string): LegacySource[] {
  if (!exists(filePath)) return [];

  const data = readJson<unknown>(filePath);

  // 顶层 list
  if (Array.isArray(data)) {
    return (data as LegacySource[]).filter((s) => s && s.name && s.url && s.apiKey);
  }

  // dict 包装
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const list = (obj.sources ?? obj.profiles ?? obj.list) as unknown;
    if (Array.isArray(list)) {
      return (list as LegacySource[]).filter((s) => s && s.name && s.url && s.apiKey);
    }
    // 顶层 dict：key 为源名
    const out: LegacySource[] = [];
    for (const [key, val] of Object.entries(obj)) {
      if (val && typeof val === 'object') {
        const v = val as Partial<LegacySource>;
        if (v.url && v.apiKey) {
          out.push({ name: v.name ?? key, url: v.url, apiKey: v.apiKey, knownModels: v.knownModels });
        }
      }
    }
    return out;
  }

  return [];
}

/**
 * 找旧 sources.json 的路径。
 * 先看 <configRoot>/wb-switch/sources.json，再看 <configRoot>/wb-switch/profiles/sources.json。
 */
export function findLegacySourcesJson(root?: string): string | null {
  const r = root ?? resolveConfigRoot();
  const candidates = [
    path.join(dataDir(r), 'sources.json'),
    path.join(profilesDir(r), 'sources.json'),
  ];
  for (const p of candidates) {
    if (exists(p)) return p;
  }
  return null;
}

/**
 * 把旧 sources.json 里的源批量导入为 profiles/*.json。
 *
 * @param filePath 旧 sources.json 路径；不传则自动查找
 * @param overwrite 同名源是否覆盖（默认跳过）
 */
export function migrateFromSourcesJson(
  filePath?: string,
  overwrite = false,
): ImportResult & { legacyPath: string | null } {
  const root = resolveConfigRoot();
  const legacyPath = filePath ?? findLegacySourcesJson(root);

  if (!legacyPath) {
    return { imported: [], skipped: [], failed: [], total: 0, legacyPath: null };
  }

  const sources = readLegacySources(legacyPath);
  const result = batchImport(root, sources, overwrite, { legacyPath });
  return { ...result, legacyPath };
}

// ── 2) CC Switch 导入 ──

/** CC Switch provider 记录（从 SQLite 查出来的字段子集） */
export interface CcSwitchProvider {
  name: string;
  appType: string;
  url: string;
  apiKey: string;
  apiFormat: string; // anthropic / openai_chat / openai_responses
  knownModels: string[];
  current: boolean;
}

/** CC Switch SQLite 数据库默认路径 */
export function ccSwitchDbPath(): string {
  return path.join(
    process.env.HOME || process.env.USERPROFILE || '~',
    '.cc-switch',
    'cc-switch.db',
  );
}

/**
 * 从 CC Switch SQLite 读 provider 列表。
 * 不依赖 better-sqlite3；直接用 sqlite3 命令行（macOS/Linux 自带或 brew install sqlite）。
 *
 * @param appTypes 筛选 app_type（如 ['claude','codex']）；不传 = 全部
 */
export function readCcSwitchProviders(appTypes?: string[]): CcSwitchProvider[] {
  const dbPath = ccSwitchDbPath();
  if (!exists(dbPath)) return [];

  // 用 sqlite3 CLI 查询，输出 JSON

  const tableCheck = execSync(`sqlite3 "${dbPath}" ".tables"`, { encoding: 'utf-8' });
  if (!tableCheck.includes('providers')) return [];

  // 查询所有 provider 的 settings_config（JSON 字符串）和 metadata
  const where =
    appTypes && appTypes.length > 0
      ? `WHERE app_type IN (${appTypes.map((t) => `'${t.replace(/'/g, "''")}'`).join(',')})`
      : '';

  const sql = `SELECT name, app_type, settings_config, meta, is_current FROM providers ${where} ORDER BY app_type, name`;

  let rows: { name: string; app_type: string; settings_config: string; meta: string; is_current: number }[];
  try {
    const raw = execSync(`sqlite3 -json "${dbPath}" "${sql.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
    });
    rows = JSON.parse(raw || '[]');
  } catch {
    // sqlite3 不支持 -json 或命令失败，退回逐行
    const raw = execSync(`sqlite3 -separator $'\t' "${dbPath}" "${sql.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
    });
    rows = raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = line.split('\t');
        return {
          name: parts[0] ?? '',
          app_type: parts[1] ?? '',
          settings_config: parts[2] ?? '',
          meta: parts[3] ?? '{}',
          is_current: parts[4] === '1' ? 1 : 0,
        };
      });
  }

  const out: CcSwitchProvider[] = [];
  for (const row of rows) {
    const parsed = parseCcSettings(row.app_type, row.settings_config, row.meta);
    if (parsed.url && parsed.apiKey) {
      out.push({
        name: row.name,
        appType: row.app_type,
        url: parsed.url,
        apiKey: parsed.apiKey,
        apiFormat: parsed.apiFormat,
        knownModels: parsed.knownModels,
        current: row.is_current === 1,
      });
    }
  }

  return out;
}

/** 从 CC Switch 的 settings_config / metadata 里提取 url + key + format */
function parseCcSettings(
  appType: string,
  settingsConfig: string,
  metadata: string,
): { url: string; apiKey: string; apiFormat: string; knownModels: string[]; current: boolean } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let settings: any = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let meta: any = {};

  try {
    settings = JSON.parse(settingsConfig || '{}');
  } catch {
    /* settings_config 可能是 TOML 或空 */
  }
  try {
    meta = JSON.parse(metadata || '{}');
  } catch {
    /* ignore */
  }

  // 不同 app_type 的存储方式不同
  if (appType === 'codex') {
    // codex 的 config 是 TOML，settings_config.env 可能有 base_url
    const env = (settings.env ?? {}) as Record<string, string>;
    const configStr = typeof settings.config === 'string' ? settings.config : '';
    let url = env.ANTHROPIC_BASE_URL || env.OPENAI_BASE_URL || '';
    // 从 TOML 正则提取 base_url
    if (!url && configStr) {
      const m = configStr.match(/base_url\s*=\s*["']([^"']+)["']/);
      if (m) url = m[1];
    }
    const apiKey = env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY || '';
    return { url, apiKey, apiFormat: 'openai_chat', knownModels: [], current: false };
  }

  if (appType === 'opencode') {
    const options = (settings.options ?? {}) as Record<string, string>;
    return {
      url: options.baseURL || '',
      apiKey: options.apiKey || '',
      apiFormat: options.apiFormat || 'openai_chat',
      knownModels: [],
      current: false,
    };
  }

  // claude / claude-desktop / gemini: env 里取
  const env = (settings.env ?? (settings as Record<string, unknown>)) as Record<string, string>;
  const url =
    env.ANTHROPIC_BASE_URL ||
    env.GOOGLE_GEMINI_BASE_URL ||
    env.CLAUDE_BASE_URL ||
    '';
  const apiKey =
    env.ANTHROPIC_AUTH_TOKEN ||
    env.ANTHROPIC_API_KEY ||
    env.GOOGLE_GEMINI_API_KEY ||
    env.CLAUDE_API_KEY ||
    '';

  // 从 env 里提取已知模型名
  const knownModels: string[] = [];
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_DEFAULT_.*_MODEL|CLAUDE_MODEL|GEMINI_MODEL)$/.test(key)) {
      const v = env[key];
      if (typeof v === 'string' && v) knownModels.push(v);
    }
  }

  const isAnthropic = appType === 'claude' || appType === 'claude-desktop' || appType === 'gemini';
  const apiFormat = appType === 'gemini' ? 'gemini' : isAnthropic ? 'anthropic' : 'openai_chat';

  return { url, apiKey, apiFormat, knownModels: [...new Set(knownModels)], current: false };
}

/**
 * 把 CC Switch 的 provider 批量导入为 profiles。
 *
 * @param appTypes 筛选 app_type
 * @param overwrite 同名覆盖
 * @param onlyNames 只导入这些名字的 provider（不传 = 全部）
 */
export function importFromCcSwitch(
  appTypes?: string[],
  overwrite = false,
  onlyNames?: string[],
): ImportResult {
  const root = resolveConfigRoot();
  const wanted = onlyNames && onlyNames.length ? new Set(onlyNames) : null;
  const providers = readCcSwitchProviders(appTypes).filter(
    (p) => !wanted || wanted.has(p.name),
  );

  // 转成 LegacySource 格式复用 batchImport
  const sources: LegacySource[] = providers.map((p) => ({
    name: p.name,
    url: p.url,
    apiKey: p.apiKey,
    knownModels: p.knownModels,
  }));

  return batchImport(root, sources, overwrite, { tag: 'CC Switch' });
}

// ── 公共：批量导入 ──

function batchImport(
  root: string,
  sources: LegacySource[],
  overwrite: boolean,
  meta?: { legacyPath?: string; tag?: string },
): ImportResult {
  const existing = new Set(listProfileNames(root).map((n) => n.toLowerCase()));
  const imported: string[] = [];
  const skipped: string[] = [];
  const failed: { name: string; reason: string }[] = [];

  for (const src of sources) {
    try {
      const name = validateProfileName(src.name);

      if (existing.has(name.toLowerCase()) && !overwrite) {
        skipped.push(name);
        continue;
      }

      const models = buildModelsFromSource(name, src.url, src.apiKey, src.knownModels);

      const profile: Profile = {
        name,
        description: meta?.tag ? `从 ${meta.tag} 导入` : undefined,
        origin: {
          type: 'file',
          path: meta?.legacyPath ?? '',
          createdAt: new Date().toISOString(),
        },
        models,
      };

      saveProfile(root, profile);
      existing.add(name.toLowerCase());
      imported.push(name);
    } catch (err) {
      failed.push({ name: src.name, reason: (err as Error).message });
    }
  }

  return { imported, skipped, failed, total: sources.length };
}

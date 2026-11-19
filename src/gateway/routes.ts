/**
 * 网关路由表（routes.json）。
 *
 * 设计原则：**零智能，只查表**。
 *   - WorkBuddy 侧每个模型名（alias）只出现一次，指向本地网关，天然解决
 *     「同名模型不能重复配置」的限制。
 *   - 每条路由是一个 alias + 有序后端列表；后端引用现有 profiles 里的
 *     模型条目（profile 名 + 模型 id），按顺序尝试，失败自动落到下一个。
 *
 * 布局：<configRoot>/wb-switch/routes.json
 * {
 *   "port": 7533,
 *   "routes": [
 *     {
 *       "alias": "glm-4.7",
 *       "backends": [
 *         { "profile": "183", "model": "glm-4.7" },
 *         { "profile": "openrouter", "model": "z-ai/glm-4.7" }
 *       ]
 *     }
 *   ]
 * }
 */

import path from 'node:path';
import { ConfigError, UsageError } from '../errors.js';
import { exists, readJson, stringifyJson, writeFileAtomic, ensureDir } from '../fsutil.js';
import { dataDir } from '../paths.js';
import { loadProfile, listProfileNames } from '../profiles.js';
import { maskKey } from '../config.js';

/** 默认监听端口（避开 GUI 常用的 7532） */
export const DEFAULT_GATEWAY_PORT = 7533;

/** 失败时单后端重试次数（仍失败才切下一个源） */
export const DEFAULT_RETRY = 10;

export interface RouteBackend {
  /** 引用的源（profile）名称 */
  profile: string;
  /** 该源内的模型 id */
  model: string;
}

export interface RouteEntry {
  /** WorkBuddy 里看到的模型名（全局唯一） */
  alias: string;
  /**
   * 路由类型：
   *   - chat（缺省）：OpenAI Chat 端点（/v1/chat/completions）
   *   - image：图片生成/编辑端点（/v1/images/generations|edits，
   *     SenseNova U1.5 等 OpenAI Images 兼容供应商）
   */
  kind?: 'chat' | 'image';
  /** 有序后端列表，按顺序尝试 */
  backends: RouteBackend[];
}

export interface RoutesFile {
  port: number;
  /** 单后端瞬时类重试次数（重试完仍失败再切下一个源）；默认 10，v2 调度默认 3 */
  retry?: number;
  /** v2 调度模式：priority（默认，健康优先按序）/ round-robin（轮转分摊） */
  scheduling?: 'priority' | 'round-robin';
  /** v2 全链时间预算（ms）；缺省 60000 */
  budgetMs?: number;
  routes: RouteEntry[];
}

export function routesFile(root: string): string {
  return path.join(dataDir(root), 'routes.json');
}

/** 读路由表；不存在则返回空表（端口默认） */
export function readRoutes(root: string): RoutesFile {
  const file = routesFile(root);
  if (!exists(file)) return { port: DEFAULT_GATEWAY_PORT, retry: DEFAULT_RETRY, routes: [] };
  const raw = readJson<Partial<RoutesFile>>(file);
  const port =
    typeof raw.port === 'number' && raw.port >= 1 && raw.port <= 65535
      ? Math.floor(raw.port)
      : DEFAULT_GATEWAY_PORT;
  const retry =
    typeof raw.retry === 'number' && raw.retry >= 0 && raw.retry <= 100
      ? Math.floor(raw.retry)
      : DEFAULT_RETRY;
  // v2 调度配置（透传给网关运行时；缺省由网关侧兜底）
  const scheduling = raw.scheduling === 'round-robin' ? 'round-robin' : 'priority';
  const budgetMs =
    typeof raw.budgetMs === 'number' && raw.budgetMs > 1000 ? Math.floor(raw.budgetMs) : undefined;
  const routes = Array.isArray(raw.routes) ? raw.routes.filter(r => r && typeof r === 'object') : [];
  const seen = new Set<string>();
  const entries: RouteEntry[] = [];
  for (const r of routes as unknown[]) {
    const obj = r as Partial<RouteEntry>;
    const alias = typeof obj.alias === 'string' ? obj.alias.trim() : '';
    if (!alias || seen.has(alias)) continue; // 重复 / 空 alias 直接忽略
    const backends = Array.isArray(obj.backends) ? obj.backends : [];
    const kind = obj.kind === 'image' ? 'image' : 'chat';
    entries.push({ alias, kind, backends: backends.filter(b => b && typeof b === 'object') as RouteBackend[] });
    seen.add(alias);
  }
  return { port, retry, scheduling, budgetMs, routes: entries };
}

/**
 * 图片端点推导：从 chat/completions URL 推导 images 端点。
 *   https://host/v1/chat/completions → https://host/v1/images/generations
 * 兼容已存的裸 /v1、/v1/chat/completions、/v1/completions 形态。
 */
export function deriveImagesUrl(chatUrl: string, kind: 'generations' | 'edits'): string {
  let u = chatUrl.replace(/\/+$/, '');
  u = u.replace(/\/chat\/completions$/, '');
  u = u.replace(/\/completions$/, '');
  // 现在应到 /v1（或没有 /v1）
  if (!/\/v\d+$/.test(u)) u += '/v1';
  return `${u}/images/${kind}`;
}

/** 校验 alias 合法性 */
export function validateAlias(alias: string): string {
  const a = alias.trim();
  if (!a) throw new UsageError('别名（alias）不能为空。');
  if (/\s/.test(a)) throw new UsageError(`别名不能包含空白字符："${a}"。`);
  if (a.length > 96) throw new UsageError('别名过长（最多 96 字符）。');
  return a;
}

/** 写路由表 */
export function writeRoutes(root: string, file: RoutesFile): void {
  ensureDir(dataDir(root));
  writeFileAtomic(routesFile(root), stringifyJson(file, { indent: 2, trailingNewline: true, eol: '\n' }));
}

/**
 * 把组合（combo）成员合入路由表：组合每个成员 alias 一条路由，
 * sources 即按序 fallback 链（与手写 routes.json 完全同构）。
 * 已存在的同名 alias 覆盖（组合是最新意图）。
 */
export function mergeComboIntoRoutes(root: string, comboPath: import('../types.js').Profile): RoutesFile {
  const file = readRoutes(root);
  const members = comboPath.combo ?? [];
  for (const m of members) {
    file.routes = file.routes.filter(r => r.alias !== m.alias);
    file.routes.push({ alias: m.alias, backends: m.sources.map(s => ({ profile: s.profile, model: s.model })) });
  }
  file.routes.sort((a, b) => a.alias.localeCompare(b.alias, 'zh-CN'));
  writeRoutes(root, file);
  return file;
}

/** 从路由表移除一组 alias（删除组合成员/组合时同步清理路由） */
export function removeAliasesFromRoutes(root: string, aliases: string[]): RoutesFile {
  const file = readRoutes(root);
  const set = new Set(aliases.map(a => a.trim()));
  file.routes = file.routes.filter(r => !set.has(r.alias));
  writeRoutes(root, file);
  return file;
}

/** 新增一条路由；alias 已存在则报错（或 force 覆盖） */
export function addRoute(
  root: string,
  alias: string,
  backends: RouteBackend[],
  options: { force?: boolean; kind?: 'chat' | 'image' } = {},
): RoutesFile {
  const norm = validateAlias(alias);
  const file = readRoutes(root);
  if (file.routes.some(r => r.alias === norm) && !options.force) {
    throw new ConfigError(
      `路由别名已存在：${norm}`,
      '换个别名，或用 --force 覆盖已有路由。',
    );
  }
  if (backends.length === 0) throw new UsageError('至少需要一个后端（--profile <源> --模型ID>）。');
  file.routes = file.routes.filter(r => r.alias !== norm);
  file.routes.push({ alias: norm, kind: options.kind === 'image' ? 'image' : undefined, backends });
  file.routes.sort((a, b) => a.alias.localeCompare(b.alias, 'zh-CN'));
  writeRoutes(root, file);
  return file;
}

/** 删除一条路由；不存在返回 false */
export function removeRoute(root: string, alias: string): boolean {
  const file = readRoutes(root);
  const before = file.routes.length;
  file.routes = file.routes.filter(r => r.alias !== alias.trim());
  if (file.routes.length === before) return false;
  writeRoutes(root, file);
  return true;
}

/** 展开路由表：把 profile/model 引用解析成实际的上游地址与密钥 */
export interface ResolvedBackend {
  profile: string;
  model: string;
  url: string;
  apiKey: string;
  /** 解析失败原因（url/密钥缺失等） */
  error?: string;
}

export function resolveBackends(
  root: string,
  backends: RouteBackend[],
  _options: { kind?: 'chat' | 'image' } = {},
): ResolvedBackend[] {
  // 注意：这里始终返回源里保存的 chat url；图片端点推导统一由
  // server.forwardOnce 按 imagesMode 处理（避免双重推导）。
  return backends.map(b => {
    try {
      const profile = loadProfile(root, b.profile);
      const entry = profile.models.find(m => m.id === b.model);
      if (!entry) {
        return { profile: b.profile, model: b.model, url: '', apiKey: '', error: `源「${b.profile}」中没有模型 ${b.model}` };
      }
      if (!entry.url) {
        return { profile: b.profile, model: b.model, url: '', apiKey: '', error: `模型 ${b.model} 未配置 url` };
      }
      return {
        profile: b.profile,
        model: b.model,
        url: entry.url,
        apiKey: String(entry.apiKey ?? ''),
      };
    } catch (err) {
      return { profile: b.profile, model: b.model, url: '', apiKey: '', error: (err as Error).message };
    }
  });
}

/** 校验整个路由表，返回问题列表（空 = 全部可用） */
export function lintRoutes(root: string): { alias: string; problems: string[] }[] {
  const file = readRoutes(root);
  const problems: { alias: string; problems: string[] }[] = [];
  const names = new Set(listProfileNames(root).map(n => n.toLowerCase()));
  for (const r of file.routes) {
    const errs: string[] = [];
    if (r.backends.length === 0) errs.push('没有后端');
    for (const b of r.backends) {
      if (!names.has(b.profile.toLowerCase())) {
        errs.push(`源「${b.profile}」不存在（可用：${[...names].join(', ') || '无'}）`);
        continue;
      }
      try {
        const profile = loadProfile(root, b.profile);
        const m = profile.models.find(x => x.id === b.model);
        if (!m) errs.push(`源「${b.profile}」没有模型 ${b.model}`);
        else if (!m.url) errs.push(`${b.profile}/${b.model} 缺 url`);
        else if (!m.apiKey) errs.push(`${b.profile}/${b.model} 缺 apiKey（匿名上游可忽略）`);
      } catch (err) {
        errs.push((err as Error).message);
      }
    }
    if (errs.length) problems.push({ alias: r.alias, problems: errs });
  }
  return problems;
}

/** 生成指向网关的 models.json 条目列表（bind 用） */
export function buildGatewayModels(file: RoutesFile, port: number): import('../types.js').ModelEntry[] {
  return file.routes.map(r => ({
    id: r.alias,
    name: r.alias,
    vendor: 'wb-gateway',
    // 图片模型也统一指向 chat 端点：网关会在 chat 适配层把请求转成 images 调用，
    // WorkBuddy 侧零改动（聊天框里 @ 该模型发 prompt 即可生图）
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    apiKey: 'wb-gateway',
    supportsToolCall: true,
    supportsImages: r.kind === 'image' ? true : false,
    supportsReasoning: false,
    useCustomProtocol: false,
  }));
}

/** 脱敏展示用 */
export function describeBackend(b: ResolvedBackend): string {
  const where = b.error ? b.error : `${b.profile}/${b.model}`;
  return `${where} ${b.url ? `· ${hostOf(b.url)}` : ''} ${b.apiKey ? `· key ${maskKey(b.apiKey)}` : ''}`.trim();
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

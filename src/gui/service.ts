/**
 * GUI 服务层。
 *
 * 把 CLI 的核心能力包装成「纯函数 + 普通对象返回值」，供 IPC 直接调用。
 * 刻意不 import electron，这样可以在普通 Node 环境里跑自动化测试。
 *
 * 所有函数只做两件事之一：
 *  - 读：返回可 JSON 序列化的视图对象
 *  - 写：复用 switcher/profiles 中已有的原子写与备份逻辑，不重复实现
 */

import fs from 'node:fs';
import path from 'node:path';
import { describeError } from '../errors.js';
import type { ModelEntry, Profile, ProfileSummary, SwitchState } from '../types.js';
import { startProxy, type ProtocolKind, type ProxyModelConfig } from './proxy.js';
import { hostOf, loadModels, modelsEqual, validateModels } from '../config.js';
import { backupFile, exists, isDir, listFiles } from '../fsutil.js';
import { backupsDir, dataDir, modelsFile, profilesDir, resolveConfigRoot } from '../paths.js';
import {
  deleteProfile,
  listProfileNames,
  listProfiles,
  loadProfile,
  profileExists,
  renameProfile,
  resolveProfileName,
  saveProfile,
  validateProfileName,
} from '../profiles.js';
import { readState, setActive } from '../state.js';
import {
  prepareRoot,
  readCurrentModels,
  restoreFromBackup,
  snapshotCurrent,
  switchTo,
} from '../switcher.js';
import { chatEndpointOf, fetchModels, type FetchModelsResult } from './modelFetch.js';
import { VENDOR_TEMPLATES, findTemplate, type VendorTemplate, type TemplateModel } from './templates.js';

/** 供 UI 展示的模型条目（含脱敏信息与主机名） */
export interface ModelView {
  id: string;
  name: string;
  vendor: string;
  url: string;
  host: string;
  apiKey: string;
  keyMasked: string;
  supportsToolCall: boolean;
  supportsImages: boolean;
  supportsReasoning: boolean;
  useCustomProtocol: boolean;
  /** 未知字段，编辑时原样保留 */
  extra: Record<string, unknown>;
}

export interface ProfileDetail {
  name: string;
  description: string;
  origin: { type: string; path?: string; createdAt: string } | null;
  models: ModelView[];
  active: boolean;
  inSync: boolean;
  filePath: string;
}

export interface Overview {
  configRoot: string;
  modelsPath: string;
  dataPath: string;
  backupsPath: string;
  rootExists: boolean;
  hasModels: boolean;
  /** 当前磁盘上的 models.json 解析结果；解析失败为 null */
  currentModels: ModelView[] | null;
  currentError: string | null;
  profiles: ProfileSummary[];
  state: SwitchState;
  backupCount: number;
  appVersion: string;
}

export interface BackupView {
  file: string;
  path: string;
  size: number;
  mtime: string;
  /** 从文件名猜测用途 */
  kind: 'switch' | 'restore' | 'deleted' | 'other';
}

export interface DoctorCheck {
  name: string;
  level: 'ok' | 'warn' | 'fail';
  detail: string;
}

export interface DoctorReport {
  configRoot: string;
  ok: boolean;
  checks: DoctorCheck[];
}

export interface SwitchReport {
  name: string;
  identical: boolean;
  backup: string | null;
  modelCount: number;
  previousModelCount: number;
  updatedAt: string | null;
}

/** 统一把异常转成可直接展示的字符串 */
function errText(err: unknown): string {
  return describeError(err);
}

export function getRoot(): string {
  return resolveConfigRoot();
}

export function toModelView(m: ModelEntry): ModelView {
  const known = new Set([
    'id',
    'name',
    'vendor',
    'url',
    'apiKey',
    'supportsToolCall',
    'supportsImages',
    'supportsReasoning',
    'useCustomProtocol',
  ]);
  const extra: Record<string, unknown> = {};
  for (const k of Object.keys(m)) {
    if (!known.has(k)) extra[k] = m[k];
  }
  return {
    id: String(m.id ?? ''),
    name: String(m.name ?? m.id ?? ''),
    vendor: String(m.vendor ?? ''),
    url: String(m.url ?? ''),
    host: hostOf(typeof m.url === 'string' ? m.url : undefined),
    apiKey: String(m.apiKey ?? ''),
    keyMasked: maskKeyGui(String(m.apiKey ?? '')),
    supportsToolCall: m.supportsToolCall === true,
    supportsImages: m.supportsImages === true,
    supportsReasoning: m.supportsReasoning === true,
    useCustomProtocol: m.useCustomProtocol === true,
    extra,
  };
}

/** 与 CLI 保持一致的脱敏规则 */
export function maskKeyGui(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return `${key.slice(0, 2)}${'*'.repeat(Math.max(key.length - 2, 1))}`;
  if (key.length < 12) return `${key.slice(0, 3)}${'*'.repeat(key.length - 5)}${key.slice(-2)}`;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

/** 把 UI 编辑后的模型视图转回 models.json 结构 */
export function fromModelView(v: ModelView): ModelEntry {
  const out: ModelEntry = { ...(v.extra ?? {}), id: v.id.trim() } as ModelEntry;
  if (v.name.trim()) out.name = v.name.trim();
  if (v.vendor.trim()) out.vendor = v.vendor.trim();
  if (v.url.trim()) out.url = v.url.trim();
  if (v.apiKey.trim()) out.apiKey = v.apiKey.trim();
  out.supportsToolCall = v.supportsToolCall;
  out.supportsImages = v.supportsImages;
  out.supportsReasoning = v.supportsReasoning;
  out.useCustomProtocol = v.useCustomProtocol;
  return out;
}

function backupKind(file: string): BackupView['kind'] {
  if (file.startsWith('deleted-')) return 'deleted';
  if (file.includes('before-restore')) return 'restore';
  if (file.startsWith('models-')) return 'switch';
  return 'other';
}

export function listBackups(root = getRoot()): BackupView[] {
  return listFiles(backupsDir(root), '.json')
    .map((p) => {
      try {
        const st = fs.statSync(p);
        return {
          file: path.basename(p),
          path: p,
          size: st.size,
          mtime: st.mtime.toISOString(),
          kind: backupKind(path.basename(p)),
        };
      } catch {
        return null;
      }
    })
    .filter((x): x is BackupView => x !== null)
    .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
}

export function getOverview(appVersion = '1.0.0'): Overview {
  const root = getRoot();
  const rootExists = isDir(root);
  const mFile = modelsFile(root);

  let currentModels: ModelView[] | null = null;
  let currentError: string | null = null;
  if (!rootExists) {
    currentError = `配置目录不存在：${root}`;
  } else if (!exists(mFile)) {
    currentError = null;
  } else {
    try {
      currentModels = readCurrentModels(root)!.map(toModelView);
    } catch (err) {
      currentError = errText(err);
    }
  }

  const state = rootExists ? readState(root) : { active: null, updatedAt: null, lastBackup: null };

  let profiles: ProfileSummary[] = [];
  if (rootExists) {
    try {
      profiles = listProfiles(
        root,
        currentModels ? currentModels.map(fromModelView) : null,
        state.active,
      );
    } catch {
      profiles = [];
    }
  }

  return {
    configRoot: root,
    modelsPath: mFile,
    dataPath: dataDir(root),
    backupsPath: backupsDir(root),
    rootExists,
    hasModels: exists(mFile),
    currentModels,
    currentError,
    profiles,
    state,
    backupCount: rootExists ? listBackups(root).length : 0,
    appVersion,
  };
}

export function getProfile(nameOrQuery: string): ProfileDetail {
  const root = getRoot();
  const realName = resolveProfileName(root, nameOrQuery);
  const p = loadProfile(root, realName);
  const current = readCurrentModels(root);
  const state = readState(root);
  return {
    name: p.name,
    description: p.description ?? '',
    origin: p.origin
      ? { type: p.origin.type, path: p.origin.path, createdAt: p.origin.createdAt }
      : null,
    models: p.models.map(toModelView),
    active: state.active?.toLowerCase() === realName.toLowerCase(),
    inSync: current !== null && modelsEqual(p.models, current),
    filePath: path.join(profilesDir(root), `${realName}.json`),
  };
}

export function switchProfile(nameOrQuery: string, force = false): SwitchReport {
  const root = getRoot();
  prepareRoot(root);
  const res = switchTo(nameOrQuery, { configDir: root, force });
  return {
    name: res.profile.name,
    identical: res.identical,
    backup: res.backup,
    modelCount: res.profile.models.length,
    previousModelCount: res.previousModelCount,
    updatedAt: res.platform.updatedAt,
  };
}

/** 把当前 models.json 存为新源，并设为当前源（与 CLI init 行为一致） */
export function createFromCurrent(name: string, description = ''): { name: string; modelCount: number } {
  const root = getRoot();
  prepareRoot(root);
  const realName = validateProfileName(name);
  if (profileExists(root, realName)) {
    throw new Error(`源已存在：${realName}`);
  }
  const profile = snapshotCurrent(root, realName, description || undefined);
  if (profile.models.length === 0) {
    throw new Error('当前 models.json 没有任何模型，无法保存为源。');
  }
  saveProfile(root, profile);
  setActive(root, realName, readState(root).lastBackup ?? null);
  return { name: realName, modelCount: profile.models.length };
}

export interface ManualProfileInput {
  name: string;
  description?: string;
  models: ModelView[];
}

/** 手工新建源（不切换） */
export function createManual(input: ManualProfileInput): { name: string; modelCount: number } {
  const root = getRoot();
  prepareRoot(root);
  const realName = validateProfileName(input.name);
  if (profileExists(root, realName)) {
    throw new Error(`源已存在：${realName}`);
  }
  const models = validateModels(
    input.models.map(fromModelView),
    `源「${realName}」`,
  );
  if (models.length === 0) throw new Error('至少要有一个模型条目。');
  const profile: Profile = {
    name: realName,
    description: input.description?.trim() || undefined,
    origin: { type: 'manual', createdAt: new Date().toISOString() },
    models,
  };
  saveProfile(root, profile);
  return { name: realName, modelCount: models.length };
}

// ─────────────────────── 从网关获取模型 ───────────────────────

export interface ConnectionSuggestion {
  /** 对话接口地址（用户可改） */
  url: string;
  apiKey: string;
  vendor: string;
  /** 来源说明，用于界面提示「已带入 XXX 的地址与密钥」 */
  from: string;
}

/**
 * 猜一个可用于「获取模型」的连接：优先给定源的第一个带 url+apiKey 的模型，
 * 否则退回磁盘上 models.json 的第一个。找不到返回 null。
 */
export function suggestConnection(profileName?: string): ConnectionSuggestion | null {
  const root = getRoot();

  const pick = (models: ModelEntry[], from: string): ConnectionSuggestion | null => {
    const hit = models.find((m) => m.url && m.apiKey);
    if (!hit) return null;
    return {
      url: String(hit.url),
      apiKey: String(hit.apiKey),
      vendor: String(hit.vendor || 'Custom'),
      from,
    };
  };

  if (profileName) {
    try {
      const real = resolveProfileName(root, profileName);
      const p = loadProfile(root, real);
      const hit = pick(p.models, `源「${p.name}」`);
      if (hit) return hit;
    } catch {
      /* 源不存在或损坏，继续兜底 */
    }
  }

  try {
    const cur = readCurrentModels(root);
    if (cur) {
      const hit = pick(cur, '当前 models.json');
      if (hit) return hit;
    }
  } catch {
    /* 解析失败，当作没有 */
  }
  return null;
}

/** 拉取网关的模型列表。失败抛 ModelFetchError（带 hint） */
export function fetchRemoteModels(input: {
  url: string;
  apiKey: string;
  timeoutMs?: number;
  proxyUrl?: string;
}): Promise<FetchModelsResult> {
  return fetchModels(input);
}

export interface ComposeModelsInput {
  /** 用户填的接口地址（任意形态，内部会推导成 /chat/completions） */
  url: string;
  apiKey: string;
  vendor?: string;
  /** 勾选要写入的模型 id */
  ids: string[];
  flags?: {
    supportsToolCall?: boolean;
    supportsImages?: boolean;
    supportsReasoning?: boolean;
    useCustomProtocol?: boolean;
  };
}

/** 把「网关 + 勾选的 id」组装成可写入 models.json 的模型列表 */
export function composeModelsFromRemote(input: ComposeModelsInput): ModelView[] {
  const chatUrl = chatEndpointOf(input.url);
  const vendor = (input.vendor || 'Custom').trim() || 'Custom';
  const apiKey = input.apiKey.trim();
  const f = input.flags ?? {};
  return input.ids
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) =>
      toModelView({
        id,
        name: id,
        vendor,
        url: chatUrl,
        apiKey,
        supportsToolCall: f.supportsToolCall ?? true,
        supportsImages: f.supportsImages ?? false,
        supportsReasoning: f.supportsReasoning ?? false,
        useCustomProtocol: f.useCustomProtocol ?? false,
      }),
    );
}

/** 把模板的模型列表 + Key 组装成 ModelView[]（保留每模型的默认能力） */
export function composeModelsFromTemplate(
  templateId: string,
  apiKey: string,
  selectedIds: string[],
): ModelView[] {
  const t = findTemplate(templateId);
  if (!t) throw new Error(`找不到模板：${templateId}`);
  const url = chatEndpointOf(t.baseUrl);
  const key = apiKey.trim();
  const byId = new Map(t.models.map((m: TemplateModel) => [m.id, m]));
  return selectedIds
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => {
      const tm = byId.get(id);
      return toModelView({
        id,
        name: id,
        vendor: t.vendor,
        url,
        apiKey: key,
        supportsToolCall: tm?.supportsToolCall ?? true,
        supportsImages: tm?.supportsImages ?? false,
        supportsReasoning: tm?.supportsReasoning ?? false,
        useCustomProtocol: false,
      });
    });
}

/** 获取全部模板列表（给界面展示） */
export function listTemplates(): VendorTemplate[] {
  return VENDOR_TEMPLATES;
}

/** 保存源的模型改动；若该源正是当前源，同步写入 models.json */export function saveProfileModels(
  name: string,
  models: ModelView[],
  description?: string,
): { synced: boolean; modelCount: number } {
  const root = getRoot();
  const realName = resolveProfileName(root, name);
  const prev = loadProfile(root, realName);
  const next = validateModels(models.map(fromModelView), `源「${realName}」`);
  if (next.length === 0) throw new Error('源至少要保留一个模型。');

  saveProfile(root, {
    ...prev,
    name: realName,
    description: description !== undefined ? description.trim() || undefined : prev.description,
    models: next,
  });

  const state = readState(root);
  const isActive = state.active?.toLowerCase() === realName.toLowerCase();
  if (isActive) {
    // 用切换逻辑写盘，自带备份与回读校验
    switchTo(realName, { configDir: root, force: true });
    return { synced: true, modelCount: next.length };
  }
  return { synced: false, modelCount: next.length };
}

export function removeProfile(name: string): { name: string; keptCopy: string | null } {
  const root = getRoot();
  const realName = resolveProfileName(root, name);
  const state = readState(root);
  const kept = deleteProfile(root, realName);
  if (state.active?.toLowerCase() === realName.toLowerCase()) {
    // 源被删掉后指针失效，清空以避免 doctor 报错
    setActive(root, null, state.lastBackup ?? null);
  }
  return { name: realName, keptCopy: kept };
}

export function renameProfileTo(oldName: string, newName: string): { from: string; to: string } {
  const root = getRoot();
  const from = resolveProfileName(root, oldName);
  const to = validateProfileName(newName);
  if (from.toLowerCase() === to.toLowerCase()) return { from, to: from };
  if (profileExists(root, to)) throw new Error(`源已存在：${to}`);
  renameProfile(root, from, to);
  const state = readState(root);
  if (state.active?.toLowerCase() === from.toLowerCase()) {
    setActive(root, to, state.lastBackup ?? null);
  }
  return { from, to };
}

export function exportProfile(name: string, dest: string): { file: string; modelCount: number } {
  const root = getRoot();
  const realName = resolveProfileName(root, name);
  const profile = loadProfile(root, realName);
  fs.writeFileSync(dest, `${JSON.stringify(profile.models, null, 2)}\n`, 'utf8');
  return { file: dest, modelCount: profile.models.length };
}

/** 从外部 models.json 导入为新源 */
export function importProfile(file: string, name: string): { name: string; modelCount: number } {
  const root = getRoot();
  prepareRoot(root);
  const realName = validateProfileName(name);
  if (profileExists(root, realName)) throw new Error(`源已存在：${realName}`);
  const models = loadModels(file);
  if (models.length === 0) throw new Error('该文件里没有任何模型条目。');
  saveProfile(root, {
    name: realName,
    description: `导入自 ${path.basename(file)}`,
    origin: { type: 'file', path: file, createdAt: new Date().toISOString() },
    models,
  });
  return { name: realName, modelCount: models.length };
}

export function restoreBackup(fileName: string): { active: string | null; safety: string | null } {
  const root = getRoot();
  prepareRoot(root);
  const target = path.join(backupsDir(root), path.basename(fileName));
  if (!exists(target)) throw new Error(`备份文件不存在：${fileName}`);
  const safety = backupFile(modelsFile(root), backupsDir(root), 'models-before-restore');
  const res = restoreFromBackup(root, target);
  return { active: res.active, safety };
}

export function runDoctor(): DoctorReport {
  const root = getRoot();
  const checks: DoctorCheck[] = [];
  const push = (name: string, level: DoctorCheck['level'], detail: string) =>
    checks.push({ name, level, detail });

  if (!isDir(root)) {
    push('配置目录', 'fail', `不存在：${root}`);
    return { configRoot: root, ok: false, checks };
  }
  push('配置目录', 'ok', root);

  try {
    prepareRoot(root);
    push('写入权限', 'ok', dataDir(root));
  } catch (err) {
    push('写入权限', 'fail', errText(err));
  }

  const mFile = modelsFile(root);
  let diskModels: ModelEntry[] | null = null;
  if (!exists(mFile)) {
    push('models.json', 'warn', '不存在（WorkBuddy 会使用内置/登录态模型）');
  } else {
    try {
      diskModels = readCurrentModels(root);
      const noKey = (diskModels ?? []).filter((m) => !m.apiKey).length;
      push(
        'models.json',
        noKey > 0 ? 'warn' : 'ok',
        `${diskModels?.length ?? 0} 个模型${noKey ? `，${noKey} 个未设置 apiKey` : ''}`,
      );
    } catch (err) {
      push('models.json', 'fail', errText(err));
    }
  }

  const names = listProfileNames(root);
  if (names.length === 0) {
    push('源', 'warn', '还没有源，用「保存当前配置」创建第一个');
  } else {
    const broken: string[] = [];
    for (const n of names) {
      try {
        loadProfile(root, n);
      } catch (err) {
        broken.push(`${n}（${errText(err)}）`);
      }
    }
    push('源', broken.length ? 'fail' : 'ok', broken.length ? broken.join('; ') : `${names.length} 个，全部可读`);
  }

  const state = readState(root);
  if (!state.active) {
    push('当前源', 'warn', '未设置');
  } else {
    const hit = names.find((n) => n.toLowerCase() === state.active!.toLowerCase());
    if (!hit) {
      push('当前源', 'fail', `指向不存在的源「${state.active}」`);
    } else if (diskModels === null) {
      push('当前源', 'warn', `「${hit}」，但 models.json 不存在`);
    } else {
      const p = loadProfile(root, hit);
      const same = modelsEqual(p.models, diskModels);
      push(
        '当前源',
        same ? 'ok' : 'warn',
        same ? `「${hit}」与磁盘一致（${p.models.length} 个模型）` : `「${hit}」与磁盘内容不一致（可能在界面里改过）`,
      );
    }
  }

  const bks = listBackups(root);
  push('备份', bks.length ? 'ok' : 'warn', bks.length ? `${bks.length} 个` : '暂无备份');

  // 密钥安全检查：源文件含明文 apiKey，提醒用户注意文件权限
  const hasKeys = (diskModels ?? []).some((m) => m.apiKey);
  const profileFiles = names.length;
  if (hasKeys || profileFiles > 0) {
    push(
      '密钥安全',
      'warn',
      `API Key 以明文存储在 models.json 和源文件中，注意不要将这些文件提交到公开仓库或分享给他人`,
    );
  }

  return {
    configRoot: root,
    ok: checks.every((c) => c.level !== 'fail'),
    checks,
  };
}

// ─────────────────────────── 协议转换代理 ───────────────────────────

let proxyState: { port: number; stop: () => void; models: Map<string, ProxyModelConfig> } | null = null;

/**
 * 检测模型需要的协议类型。
 * 根据 url 域名推断：
 *   api.anthropic.com → anthropic
 *   generativelanguage.googleapis.com → gemini
 *   其它 → openai（直通）
 */
export function detectProtocol(url: string): ProtocolKind {
  const u = url.toLowerCase();
  if (u.includes('anthropic.com')) return 'anthropic';
  if (u.includes('generativelanguage.googleapis.com')) return 'gemini';
  return 'openai';
}

/**
 * 启动协议转换代理。
 *
 * 扫描当前 models.json，对每个模型检测协议：
 *   - openai → 直通，不需要代理
 *   - anthropic / gemini → 需要代理翻译
 *
 * 如果有需要翻译的模型，启动本地代理，返回代理地址。
 * WorkBuddy 只需要把需要翻译的模型的 url 改为代理地址。
 *
 * @param proxyUrl 可选的出站代理地址
 * @returns 代理信息（端口、代理 url），如果不需要代理返回 null
 */
export async function startProtocolProxy(proxyUrl?: string): Promise<{
  port: number;
  proxyBaseUrl: string;
  needsProxy: string[];
} | null> {
  // 先停旧的
  if (proxyState) {
    proxyState.stop();
    proxyState = null;
  }

  const root = getRoot();
  const mFile = modelsFile(root);
  if (!fs.existsSync(mFile)) return null;
  const models = loadModels(mFile);

  const routeTable = new Map<string, ProxyModelConfig>();
  const needsProxy: string[] = [];

  for (const m of models) {
    if (!m.url || !m.apiKey) continue;
    const proto = detectProtocol(m.url);
    if (proto === 'openai') continue; // 直通，不需要代理
    routeTable.set(m.id, {
      modelId: m.id,
      targetUrl: m.url,
      apiKey: m.apiKey,
      protocol: proto,
    });
    needsProxy.push(m.id);
  }

  if (needsProxy.length === 0) return null;

  const envProxy = proxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
  const { port, stop } = await startProxy({
    port: 0, // 自动选端口
    models: routeTable,
    proxyUrl: envProxy,
  });

  proxyState = { port, stop, models: routeTable };

  return {
    port,
    proxyBaseUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
    needsProxy,
  };
}

/** 停止协议代理 */
export function stopProtocolProxy(): void {
  if (proxyState) {
    proxyState.stop();
    proxyState = null;
  }
}

/** 查询代理状态 */
export function getProxyStatus(): { running: boolean; port: number; models: string[] } {
  if (!proxyState) return { running: false, port: 0, models: [] };
  return {
    running: true,
    port: proxyState.port,
    models: [...proxyState.models.keys()],
  };
}

/**
 * 生成「代理模式」的 models.json：
 * 对需要翻译的模型，把 url 替换为本地代理地址。
 * 不需要翻译的模型保持原样。
 */
export function getProxiedModelsJson(proxyBaseUrl: string): ModelEntry[] {
  const root = getRoot();
  const mFile = modelsFile(root);
  if (!fs.existsSync(mFile)) return [];
  const models = loadModels(mFile);
  return models.map((m) => {
    const proto = detectProtocol(m.url || '');
    if (proto === 'openai') return m; // 原样
    // 替换 url 为代理地址
    return { ...m, url: proxyBaseUrl };
  });
}

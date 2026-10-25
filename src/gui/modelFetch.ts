/**
 * 从模型网关拉取可用模型列表。
 *
 * 只依赖标准 fetch（Node 18+ / Electron 主进程），不引入第三方库。
 * 目标：把用户在「新建源」里填的那一条接口地址，翻译成 /models 端点，
 * 拉回模型清单供界面搜索、勾选。
 *
 * 兼容的返回形态（各家网关五花八门）：
 *   { data: [{ id, owned_by }] }        OpenAI / 大多数中转站
 *   { models: [{ name }] }              Ollama / Gemini 风格
 *   { data: { models: [...] } }         少数聚合网关
 *   [ "gpt-4o", "gpt-4o-mini" ]         极简实现
 */

export interface RemoteModel {
  /** 写进 models.json 的 id */
  id: string;
  /** 供应商/归属，来自网关的 owned_by 等字段，可能为空 */
  owner: string;
}

export interface FetchModelsResult {
  /** 实际请求的端点，便于界面显示与排错 */
  endpoint: string;
  /** 拉取耗时（毫秒） */
  elapsedMs: number;
  models: RemoteModel[];
}

export class ModelFetchError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'ModelFetchError';
    this.hint = hint;
  }
}

const MAX_MODELS = 2000;

function trimEnd(s: string): string {
  return s.replace(/\/+$/, '');
}

/**
 * 由用户填写的接口地址推导 /models 端点。
 *   https://x/v1/chat/completions → https://x/v1/models
 *   https://x/v1                  → https://x/v1/models
 *   https://x                     → https://x/v1/models
 *   https://x/v1/models           → 原样
 */
export function modelsEndpointOf(input: string): string {
  const u = new URL(input.trim());
  let p = trimEnd(u.pathname);
  p = p.replace(/\/(chat\/)?completions$/i, '');
  p = p.replace(/\/(messages|responses|embeddings|models\/generate)$/i, '');
  if (p === '') p = '/v1';
  if (!/\/models$/i.test(p)) p = `${p}/models`;
  u.pathname = p;
  u.search = '';
  u.hash = '';
  return trimEnd(u.toString());
}

/**
 * 由用户填写的接口地址推导对话端点（写进 models.json 的 url）。
 *   https://x/v1            → https://x/v1/chat/completions
 *   https://x/v1/models     → https://x/v1/chat/completions
 *   https://x/v1/chat/completions → 原样
 */
export function chatEndpointOf(input: string): string {
  const u = new URL(input.trim());
  let p = trimEnd(u.pathname);
  u.search = '';
  u.hash = '';
  if (/\/chat\/completions$/i.test(p)) {
    u.pathname = p;
    return trimEnd(u.toString());
  }
  p = p.replace(/\/models$/i, '');
  p = p.replace(/\/(messages|responses)$/i, '');
  if (p === '') p = '/v1';
  u.pathname = `${p}/chat/completions`;
  return trimEnd(u.toString());
}

/** 备选端点：某些网关只暴露 /models 或只暴露 /v1/models，404 时换一个再试 */
export function fallbackEndpoints(endpoint: string): string[] {
  const out: string[] = [];
  try {
    const u = new URL(endpoint);
    if (/\/v1\/models$/i.test(u.pathname)) {
      const alt = new URL(u.toString());
      alt.pathname = u.pathname.replace(/\/v1\/models$/i, '/models');
      out.push(trimEnd(alt.toString()));
    } else if (/\/models$/i.test(u.pathname)) {
      const alt = new URL(u.toString());
      alt.pathname = u.pathname.replace(/\/models$/i, '/v1/models');
      out.push(trimEnd(alt.toString()));
    }
  } catch {
    /* 忽略 */
  }
  return out;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** 把各种形态的返回统一成 RemoteModel[]，去重、去空、保持服务器顺序 */
export function normalizeModelList(data: unknown): RemoteModel[] {
  let list: unknown = data;

  if (list && typeof list === 'object' && !Array.isArray(list)) {
    const obj = list as Record<string, unknown>;
    if (Array.isArray(obj.data)) list = obj.data;
    else if (Array.isArray(obj.models)) list = obj.models;
    else if (obj.data && typeof obj.data === 'object') {
      const inner = obj.data as Record<string, unknown>;
      if (Array.isArray(inner.models)) list = inner.models;
      else if (Array.isArray(inner.data)) list = inner.data;
    } else if (Array.isArray(obj.result)) list = obj.result;
  }

  if (!Array.isArray(list)) return [];

  const seen = new Set<string>();
  const out: RemoteModel[] = [];

  for (const item of list) {
    let id = '';
    let owner = '';
    if (typeof item === 'string') {
      id = item.trim();
    } else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      id = pickString(o, ['id', 'model', 'name', 'slug', 'model_name']);
      owner = pickString(o, ['owned_by', 'owner', 'provider', 'publisher', 'organization']);
    }
    if (!id) continue;
    // Gemini 风格 "models/gemini-2.5-pro" 去掉前缀
    id = id.replace(/^models\//i, '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, owner });
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

interface AttemptResult {
  models?: RemoteModel[];
  status?: number;
  error?: string;
  body?: string;
}

async function requestModels(
  endpoint: string,
  apiKey: string,
  timeoutMs: number,
  dispatcher?: unknown,
): Promise<AttemptResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const fetchOpts: Record<string, unknown> = {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'x-api-key': apiKey,
        Accept: 'application/json',
      },
      signal: controller.signal,
    };
    // 代理：undici 的 ProxyAgent 通过 dispatcher 传给 fetch
    if (dispatcher) (fetchOpts as { dispatcher?: unknown }).dispatcher = dispatcher;

    const res = await fetch(endpoint, fetchOpts as Parameters<typeof fetch>[1]);

    const text = await res.text();
    if (!res.ok) {
      return { status: res.status, body: text.slice(0, 400) };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        error: '返回内容不是 JSON（地址可能指向了网页或需要登录）',
        body: text.slice(0, 200),
      };
    }
    return { models: normalizeModelList(parsed) };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string; errors?: { code?: string }[] } };
    if (e.name === 'AbortError' || /aborted/i.test(e.message || '')) {
      return { error: `请求超时（${Math.round(timeoutMs / 1000)} 秒）` };
    }
    // undici 把底层错误塞在 cause 里，DNS 失败时还可能是 AggregateError
    const codes = new Set<string>();
    if (e.cause?.code) codes.add(e.cause.code);
    for (const c of e.cause?.errors ?? []) if (c?.code) codes.add(c.code);
    const hay = `${e.message || ''} ${[...codes].join(' ')}`;
    if (hay.includes('ENOTFOUND')) return { error: '域名解析失败，检查地址是否写错' };
    if (hay.includes('ECONNREFUSED')) return { error: '连接被拒绝，网关可能未启动或端口不对' };
    if (hay.includes('ECONNRESET')) return { error: '连接被重置，网关可能中断了请求' };
    if (hay.includes('ETIMEDOUT')) return { error: '连接超时，检查网络或代理' };
    if (hay.includes('CERT_HAS_EXPIRED')) return { error: 'HTTPS 证书已过期' };
    if (
      hay.includes('UNABLE_TO_VERIFY_LEAF_SIGNATURE') ||
      hay.includes('SELF_SIGNED_CERT_IN_CHAIN') ||
      hay.includes('DEPTH_ZERO_SELF_SIGNED_CERT')
    ) {
      return { error: 'HTTPS 证书不受信任（自签名证书）' };
    }
    if (hay.includes('ENOTFOUND') || /getaddrinfo/i.test(hay)) {
      return { error: '域名解析失败，检查地址是否写错' };
    }
    return { error: e.message || '网络请求失败' };
  } finally {
    clearTimeout(timer);
  }
}

function explainStatus(status: number, body: string): ModelFetchError {
  const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 160);
  const tail = snippet ? `：${snippet}` : '';
  if (status === 401) {
    return new ModelFetchError(
      '密钥无效或未授权（HTTP 401）',
      '检查 Key 是否填错、有无空格，或该 Key 无读取模型的权限。',
    );
  }
  if (status === 403) {
    return new ModelFetchError(`无权访问模型列表（HTTP 403）${tail}`, '该 Key 可能被限制了作用域。');
  }
  if (status === 404) {
    return new ModelFetchError(
      `这个地址没有模型列表接口（HTTP 404）${tail}`,
      '确认地址形如 https://网关/v1/chat/completions',
    );
  }
  if (status === 429) {
    return new ModelFetchError('请求太频繁被限流（HTTP 429）', '稍等几秒再试。');
  }
  if (status >= 500) {
    return new ModelFetchError(`网关返回错误（HTTP ${status}）${tail}`, '这是对方服务的临时故障，稍后再试。');
  }
  return new ModelFetchError(`获取失败（HTTP ${status}）${tail}`);
}

export async function fetchModels(opts: {
  url: string;
  apiKey: string;
  timeoutMs?: number;
  proxyUrl?: string;
}): Promise<FetchModelsResult> {
  const url = (opts.url || '').trim();
  const apiKey = (opts.apiKey || '').trim();
  if (!url) throw new ModelFetchError('请先填写接口地址');
  if (!/^https?:\/\//i.test(url)) {
    throw new ModelFetchError('接口地址需以 http:// 或 https:// 开头');
  }
  let primary: string;
  try {
    primary = modelsEndpointOf(url);
  } catch {
    throw new ModelFetchError('接口地址格式不对，无法解析');
  }
  if (!apiKey) throw new ModelFetchError('请先填写 API Key', '部分网关允许空 Key，但绝大多数需要。');

  const timeoutMs = opts.timeoutMs ?? 20_000;
  const started = Date.now();
  const candidates = [primary, ...fallbackEndpoints(primary)];

  // 代理：优先用户在界面设的，其次环境变量 HTTP_PROXY / HTTPS_PROXY
  const proxyUrl = (opts.proxyUrl || '').trim() ||
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy || '';
  let dispatcher: unknown = undefined;
  if (proxyUrl) {
    try {
      // undici 作为 electron 的间接依赖，运行时可用
      const { ProxyAgent } = require('undici') as typeof import('undici');
      dispatcher = new ProxyAgent({ uri: proxyUrl });
    } catch {
      /* undici 不可用时降级为无代理直连 */
    }
  }

  let lastErr: ModelFetchError | null = null;
  for (const endpoint of candidates) {
    const r = await requestModels(endpoint, apiKey, timeoutMs, dispatcher);
    if (r.models) {
      if (r.models.length === 0) {
        throw new ModelFetchError(
          '网关返回了空列表',
          `端点可访问但没有模型：${endpoint}`,
        );
      }
      return { endpoint, elapsedMs: Date.now() - started, models: r.models };
    }
    if (r.error) throw new ModelFetchError(r.error);
    if (r.status === 404) {
      // 换下一个候选端点再试
      lastErr = explainStatus(404, r.body ?? '');
      continue;
    }
    throw explainStatus(r.status ?? 0, r.body ?? '');
  }
  throw lastErr ?? new ModelFetchError('获取失败');
}

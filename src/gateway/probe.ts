/**
 * 连通性测试（probe）：
 *   L2 租户测试 —— GET {base}/v1/models（15s 超时）：验证网络 + 鉴权
 *   L3 模型测试 —— POST chat/completions max_tokens=1（15s 超时）：验证模型可用
 *
 * 结果缓存：wb-switch/health.json（TTL 1h），避免重复烧钱。
 *   200 → pass；429 → pass（degraded，限流中但鉴权/模型均通）
 *   401/403 → fail（鉴权）；404 → fail（无此模型）；超时/网络 → fail（不可达）
 *
 * CLI 接入：
 *   add --url --key          默认 L2（--no-test 跳过 / --force 失败仍保存）
 *   combo add / route add    默认 L3（同上）
 *   health check [目标]      手动复测并刷新缓存
 */

import http from 'node:http';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import { exists, readJson, stringifyJson, writeFileAtomic } from '../fsutil.js';
import { dataDir } from '../paths.js';
import type { ModelEntry } from '../types.js';

export type ProbeStatus = 'pass' | 'degraded' | 'fail';

export interface ProbeResult {
  status: ProbeStatus;
  /** pass=200；degraded=429；fail 时为错误码或 0（网络） */
  code: number;
  reason: string;
  testedAt: string;
  /** L2 顺带回填的模型数 */
  models?: number;
}

export interface HealthCache {
  [key: string]: {
    status: ProbeStatus;
    code: number;
    reason: string;
    testedAt: string;
    models?: number;
  };
}

const PROBE_TIMEOUT_MS = 15_000;
const HEALTH_TTL_MS = 60 * 60_000; // 1h

export function healthFile(root: string): string {
  return path.join(dataDir(root), 'health.json');
}

export function readHealth(root: string): HealthCache {
  const file = healthFile(root);
  if (!exists(file)) return {};
  try {
    return readJson<HealthCache>(file);
  } catch {
    return {};
  }
}

export function writeHealth(root: string, cache: HealthCache): void {
  writeFileAtomic(healthFile(root), stringifyJson(cache, { indent: 2, trailingNewline: true, eol: '\n' }));
}

export function updateHealth(root: string, key: string, r: ProbeResult): HealthCache {
  const cache = readHealth(root);
  cache[key] = { status: r.status, code: r.code, reason: r.reason, testedAt: r.testedAt, models: r.models };
  writeHealth(root, cache);
  return cache;
}

/** 缓存命中（新鲜且 pass/degraded）才算「已验证」 */
export function cachedOk(root: string, key: string): boolean {
  const entry = readHealth(root)[key];
  if (!entry) return false;
  if (Date.now() - Date.parse(entry.testedAt) > HEALTH_TTL_MS) return false;
  return entry.status === 'pass' || entry.status === 'degraded';
}

// ─────────────────────────── 探测实现 ───────────────────────────

/** L2：租户连通性（GET /v1/models） */
export async function probeProvider(url: string, apiKey: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  // 从 chat/completions 或 /v1 裸地址推导 models 端点
  const base = deriveModelsUrl(url);
  const testedAt = new Date().toISOString();
  try {
    const res = await fetchRaw(base, apiKey, timeoutMs);
    if (res.status === 200) {
      let models: number | undefined;
      try {
        const data = JSON.parse(res.body) as { data?: unknown[] };
        if (Array.isArray(data.data)) models = data.data.length;
      } catch { /* 列表解析失败不影响 pass */ }
      return { status: 'pass', code: 200, reason: '连通正常', testedAt, models };
    }
    if (res.status === 401 || res.status === 403) {
      return { status: 'fail', code: res.status, reason: `鉴权失败（${res.status}）`, testedAt };
    }
    if (res.status === 404) {
      return { status: 'fail', code: 404, reason: '端点不存在（/v1/models 404，可能非 OpenAI 兼容网关）', testedAt };
    }
    return { status: 'fail', code: res.status, reason: `HTTP ${res.status}`, testedAt };
  } catch (err) {
    return { status: 'fail', code: 0, reason: `不可达：${(err as Error).message}`, testedAt };
  }
}

/** L3：模型可用性（POST chat/completions max_tokens=1） */
export async function probeModel(url: string, apiKey: string, modelId: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  const testedAt = new Date().toISOString();
  const body = JSON.stringify({
    model: modelId,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
    stream: false,
  });
  try {
    const res = await fetchRaw(url, apiKey, timeoutMs, { method: 'POST', body });
    if (res.status === 200) {
      return { status: 'pass', code: 200, reason: '模型可用', testedAt };
    }
    if (res.status === 429) {
      const quotaHit = /quota|balance|insufficient|exceeded_current_quota|billing|recharge|欠费|余额/i.test(res.body);
      if (quotaHit) {
        return { status: 'fail', code: 429, reason: '配额/余额不足', testedAt };
      }
      return { status: 'degraded', code: 429, reason: '限流中（鉴权与模型均验证通过）', testedAt };
    }
    if (res.status === 401 || res.status === 403) {
      return { status: 'fail', code: res.status, reason: `鉴权失败（${res.status}）`, testedAt };
    }
    if (res.status === 404) {
      return { status: 'fail', code: 404, reason: `该源没有模型 ${modelId}（404）`, testedAt };
    }
    if (res.status >= 500) {
      return { status: 'fail', code: res.status, reason: `上游错误（${res.status}）`, testedAt };
    }
    return { status: 'fail', code: res.status, reason: `HTTP ${res.status}`, testedAt };
  } catch (err) {
    return { status: 'fail', code: 0, reason: `不可达：${(err as Error).message}`, testedAt };
  }
}

// ─────────────────────────── 内部 ───────────────────────────

function deriveModelsUrl(chatUrl: string): string {
  // .../v1/chat/completions → .../v1/models；.../v1 → .../v1/models
  const u = chatUrl.replace(/\/+$/, '');
  if (u.endsWith('/chat/completions')) return u.slice(0, -'/chat/completions'.length) + '/models';
  if (u.endsWith('/completions')) return u.slice(0, -'/completions'.length) + '/models';
  if (u.endsWith('/models')) return u;
  return u + '/models';
}

interface RawResponse {
  status: number;
  body: string;
}

function fetchRaw(url: string, apiKey: string, timeoutMs: number, init?: { method?: string; body?: string }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const isTls = target.protocol === 'https:';
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'content-length': String(init?.body?.length ?? 0),
    };
    if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;

    const req = (isTls ? httpsRequest : http.request)(
      {
        protocol: target.protocol as 'http:' | 'https:',
        hostname: target.hostname,
        port: target.port || (isTls ? 443 : 80),
        path: target.pathname + target.search,
        method: init?.method ?? 'GET',
        headers,
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end(init?.body ?? '');
  });
}

/** 从 profile 的模型条目推导探测目标（取该源第一个模型做 L3） */
export function firstModelOf(models: ModelEntry[]): ModelEntry | null {
  return models[0] ?? null;
}

/**
 * 网关服务器：OpenAI 兼容的本地反向代理（v2 调度核心）。
 *
 * 设计原则：**零智能配置 + 运行时自愈**。
 *   - 调度：priority（用户配置顺序，跳过不健康后端）/ round-robin（可选）
 *   - 失败分类重试：瞬时类指数退避重试；速率 429 冷却切源；配额/鉴权长冷却切源
 *   - 预算：全链 budgetMs（默认 60s），耗尽立即最终失败
 *   - 取消传播：客户端断开 → 中止重试循环与上游请求
 *   - 熔断：连续瞬时失败 → open 冷却 → half-open 探测 → 恢复
 *   - 并发：per-backend inflight 信号量（超限排队，超时跳过该后端）
 *   - 可观测：request_id 贯穿、attempt 级日志、/wb-gateway/stats、最终失败诊断头
 *
 * 非目标：协议转换、意图路由、脱敏（WorkBuddy 是 OpenAI 兼容客户端）。
 */

import http from 'node:http';
import { request as httpsRequest } from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readRoutes, resolveBackends, type RouteEntry, type ResolvedBackend } from './routes.js';
import { BackendHealthTable, DEFAULT_HEALTH_CONFIG } from './health.js';

export interface GatewayOptions {
  root: string;
  port?: number;
  host?: string;
  logDir?: string;
}

interface LogLine {
  ts: string;
  rid: string;
  alias: string;
  backend: string;
  status: number;
  ms: number;
  bytes: number;
  attempt?: number;
  outcome?: 'ok' | 'switched' | 'exhausted' | 'aborted' | 'final';
  failed?: string;
}

const LOG_NAME = 'gateway.log';
const MAX_BODY = 64 * 1024 * 1024;

/** 单后端瞬时类重试上限（不含首次，即最多 1+N 次尝试） */
const TRANSIENT_RETRIES = 3;
/** 首字节超时（ms）：连接 + 等响应头 */
const FIRST_BYTE_TIMEOUT_MS = 15_000;
/** 全链默认预算（ms） */
const DEFAULT_BUDGET_MS = 60_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 8_000;
const JITTER = 0.3;
/** per-backend inflight 上限 */
const DEFAULT_MAX_INFLIGHT = 6;
const QUEUE_TIMEOUT_MS = 30_000;

/** 失败分类结果 */
type FailureClass =
  | { kind: 'transient'; status: number; detail: string }
  | { kind: 'rate'; retryAfterMs?: number; detail: string }
  | { kind: 'quota'; detail: string }
  | { kind: 'auth'; detail: string }
  | { kind: 'client'; status: number; detail: string };

export function startGatewayServer(options: GatewayOptions): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const { root } = options;
    const bootRoutes = readRoutes(root);
    const port = options.port ?? bootRoutes.port;
    const host = options.host ?? '127.0.0.1';
    const logDir = options.logDir ?? path.join(root, 'wb-switch', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, LOG_NAME);

    if (bootRoutes.routes.length === 0) {
      reject(new Error('路由表为空：先执行 wb-switch gateway route add 配置至少一条路由。'));
      return;
    }

    const cfgRef = { cfg: resolveRuntimeConfig(bootRoutes) };
    const health = new BackendHealthTable(DEFAULT_HEALTH_CONFIG);
    const rrCursors = new Map<string, number>();

    let lastGoodRoutes: RouteEntry[] = bootRoutes.routes;
    let lastGoodRaw: { retry?: number; scheduling?: unknown; budgetMs?: unknown; routes: RouteEntry[] } = { ...bootRoutes };
    const loadRouteMap = (): { routeMap: Map<string, RouteEntry>; cfg: RuntimeConfig } => {
      try {
        const file = readRoutes(root);
        const map = new Map<string, RouteEntry>();
        for (const r of file.routes) map.set(r.alias, r);
        lastGoodRoutes = file.routes;
        lastGoodRaw = { ...file };
        cfgRef.cfg = resolveRuntimeConfig(file); // budget/scheduling 同步热加载
        return { routeMap: map, cfg: cfgRef.cfg };
      } catch {
        const map = new Map<string, RouteEntry>();
        for (const r of lastGoodRoutes) map.set(r.alias, r);
        return { routeMap: map, cfg: cfgRef.cfg };
      }
    };

    const writeLog = (line: LogLine) => {
      try {
        fs.appendFileSync(logFile, JSON.stringify(line) + '\n');
      } catch {
        /* 日志失败不影响转发 */
      }
    };

    const server = http.createServer((req, res) => {
      void handle(req, res).catch(err => {
        try {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: `wb-gateway: 内部错误：${(err as Error).message}` } }));
          } else {
            res.end();
          }
        } catch { /* ignore */ }
      });
    });

    server.on('error', reject);
    server.listen(port, host, () => {
      const c = cfgRef.cfg;
      console.log(`[wb-gateway] listening on http://${host}:${port} · ${bootRoutes.routes.length} routes · scheduling=${c.scheduling} · retry=${c.transientRetries} · budget=${c.budgetMs}ms · log ${logFile}`);
      resolve(server);
    });

    server.on('close', () => console.log('[wb-gateway] closed'));

    async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
      const rid = crypto.randomUUID().slice(0, 8);
      const started = Date.now();
      const url = req.url ?? '/';
      const { routeMap, cfg } = loadRouteMap();

      if (url === '/healthz' || url === '/wb-gateway/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, routes: routeMap.size, ts: now() }));
        return;
      }

      if (req.method === 'GET' && (url === '/wb-gateway/stats' || url === '/wb-gateway/stats/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ts: now(),
          routes: routeMap.size,
          scheduling: cfg.scheduling,
          budgetMs: cfg.budgetMs,
          backends: health.snapshot(),
        }));
        return;
      }

      if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/')) {
        const models = [...routeMap.keys()].sort().map(id => ({ id, object: 'model', owned_by: 'wb-gateway' }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: models }));
        return;
      }

      const isChat = req.method === 'POST' && (url.endsWith('/chat/completions') || url.endsWith('/completions'));
      if (!isChat) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `wb-gateway: 不支持的路径 ${url}` } }));
        return;
      }

      let body: Buffer;
      try {
        body = await readBody(req);
      } catch (err) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `body 读取失败：${(err as Error).message}` } }));
        return;
      }

      let model = '';
      try {
        const parsed = JSON.parse(body.toString('utf8')) as { model?: unknown };
        model = typeof parsed.model === 'string' ? parsed.model : '';
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'body 不是合法 JSON' } }));
        return;
      }

      const route = routeMap.get(model);
      if (!route) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: { message: `wb-gateway: 未知模型 "${model}"。可用：${[...routeMap.keys()].sort().join(', ')}` },
        }));
        return;
      }

      // ── 客户端取消传播 ──
      let clientGone = false;
      res.on('close', () => { clientGone = true; });

      const backends = resolveBackends(root, route.backends);
      const usable = backends.filter(b => !b.error);
      if (usable.length === 0) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: { message: `wb-gateway: 路由 "${route.alias}" 的后端全部不可用`, detail: backends.map(b => b.error) },
        }));
        return;
      }

      // ── 调度排序 ──
      const ordered = scheduleBackends(route, usable, cfg.scheduling, rrCursors, health);

      // ── 主循环 ──
      const deadline = started + cfg.budgetMs;
      const attemptsLog: string[] = [];
      let lastFailure = '';

      for (let i = 0; i < ordered.length; i++) {
        if (clientGone) {
          writeLog({ ts: now(), rid, alias: route.alias, backend: '-', status: 0, ms: Date.now() - started, bytes: 0, outcome: 'aborted', failed: 'client closed' });
          return;
        }
        if (Date.now() > deadline) {
          attemptsLog.push('budget-exhausted');
          writeFinalFailure(res, rid, route.alias, attemptsLog, `预算 ${cfg.budgetMs}ms 耗尽`);
          writeLog({ ts: now(), rid, alias: route.alias, backend: '-', status: 503, ms: Date.now() - started, bytes: 0, outcome: 'exhausted', failed: 'budget' });
          return;
        }

        const backend = ordered[i]!;
        const bKey = `${backend.profile}/${backend.model}`;
        const isLast = i === ordered.length - 1;

        health.tryEnterHalfOpen(bKey);
        if (!health.acquireProbeSlot(bKey)) {
          attemptsLog.push(`${bKey}:probing`);
          continue;
        }

        const gotSlot = await acquireInflight(health, bKey, deadline);
        if (!gotSlot) {
          attemptsLog.push(`${bKey}:queue-timeout`);
          health.releaseProbeSlot(bKey);
          continue;
        }

        try {
          const maxAttempts = 1 + cfg.transientRetries;
          let attemptFailure = '';

          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (clientGone) break;
            if (Date.now() >= deadline) break;

            const result = await forwardOnce(req, body, backend, res, isLast, rid, route.alias, started, attempt, writeLog);
            if (result.outcome === 'ok') {
              health.recordOk(bKey, Date.now() - started);
              attemptsLog.push(`${bKey}:ok`);
              health.releaseProbeSlot(bKey);
              return;
            }
            if (result.outcome === 'final') {
              attemptsLog.push(`${bKey}:${result.detail ?? 'final'}`);
              health.releaseProbeSlot(bKey);
              return; // 最终失败已回复客户端
            }

            const fc = result.failure!;
            attemptFailure = `${fc.kind}:${fc.detail}`;
            recordFailureToHealth(health, bKey, fc);

            // 非瞬时类：不重试本后端，立即切换
            if (fc.kind !== 'transient') {
              attemptsLog.push(`${bKey}:${fc.kind}`);
              break;
            }
            // 瞬时类还有次数：退避后重试
            if (attempt < maxAttempts && !clientGone && Date.now() < deadline) {
              const delay = backoffMs(attempt);
              await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
            }
          }

          if (clientGone) {
            writeLog({ ts: now(), rid, alias: route.alias, backend: bKey, status: 0, ms: Date.now() - started, bytes: 0, outcome: 'aborted', failed: 'client closed' });
            health.releaseProbeSlot(bKey);
            return;
          }

          if (!isLast) {
            writeLog({
              ts: now(), rid, alias: route.alias, backend: bKey, status: 0,
              ms: Date.now() - started, bytes: 0, outcome: 'switched',
              failed: `give-up (${attemptFailure}) → next`,
            });
          }
          lastFailure = attemptFailure;
        } finally {
          health.endInflight(bKey);
        }
      }

      writeFinalFailure(res, rid, route.alias, attemptsLog.length ? attemptsLog : ['no-attempt'], lastFailure || 'all backends failed');
      writeLog({ ts: now(), rid, alias: route.alias, backend: '-', status: 502, ms: Date.now() - started, bytes: 0, outcome: 'exhausted', failed: lastFailure });
    }

    // ─────────────────────────── 转发一次 ───────────────────────────

    interface ForwardResult {
      outcome: 'ok' | 'final' | 'retry';
      failure?: FailureClass;
      detail?: string;
    }

    async function forwardOnce(
      req: http.IncomingMessage,
      body: Buffer,
      backend: ResolvedBackend,
      res: http.ServerResponse,
      isLast: boolean,
      rid: string,
      alias: string,
      started: number,
      attempt: number,
      writeLog: (l: LogLine) => void,
    ): Promise<ForwardResult> {
      const target = new URL(backend.url);
      const isTls = target.protocol === 'https:';
      const backendLabel = `${backend.profile}/${backend.model}`;
      const bKey = backendLabel;

      let outBody: Buffer;
      try {
        const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
        parsed.model = backend.model;
        outBody = Buffer.from(JSON.stringify(parsed), 'utf8');
      } catch {
        outBody = body;
      }

      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        const key = k.toLowerCase();
        if (['host', 'authorization', 'content-length', 'connection', 'transfer-encoding', 'keep-alive', 'accept-encoding'].includes(key)) continue;
        if (typeof v === 'string') headers[key] = v;
        else if (Array.isArray(v)) headers[key] = v.join(', ');
      }
      headers['content-type'] = String(req.headers['content-type'] ?? 'application/json');
      headers['content-length'] = String(outBody.length);
      if (backend.apiKey) headers['authorization'] = `Bearer ${backend.apiKey}`;

      return new Promise<ForwardResult>(resolvePromise => {
        let settled = false;
        const finish = (r: ForwardResult) => {
          if (!settled) { settled = true; resolvePromise(r); }
        };

        const upstreamReq = (isTls ? httpsRequest : http.request)(
          {
            protocol: target.protocol as 'http:' | 'https:',
            hostname: target.hostname,
            port: target.port || (isTls ? 443 : 80),
            path: target.pathname + target.search,
            method: req.method,
            headers,
          },
          upstreamRes => {
            const status = upstreamRes.statusCode ?? 502;
            const retryAfter = parseRetryAfter(upstreamRes.headers['retry-after']);

            // 先「偷看」错误体再决定消费方式：
            //   失败（非 2xx）→ 缓存整个 body 后分类处理
            //   成功（2xx）→ 不缓冲，直接流式透传（不能在 end 之后再挂监听）
            if (status < 200 || status >= 300) {
              const chunks: Buffer[] = [];
              upstreamRes.on('data', (c: Buffer) => chunks.push(c));
              upstreamRes.on('end', () => {
                const errBody = Buffer.concat(chunks).toString('utf8');
                const fc = classifyFailure(status, errBody, retryAfter);

                if (fc && !isLast) {
                  writeLog({
                    ts: now(), rid, alias, backend: backendLabel, status,
                    ms: Date.now() - started, bytes: 0, attempt,
                    failed: `${fc.kind}${fc.detail ? ': ' + fc.detail : ''}`,
                  });
                  finish({ outcome: 'retry', failure: fc });
                  return;
                }

                if (fc) {
                  // isLast 且失败：透传原始错误 + 诊断头
                  try {
                    res.setHeader('x-wb-gateway', `rid=${rid},attempts=${attempt},backend=${backendLabel},class=${fc.kind}`);
                    res.writeHead(status, { 'Content-Type': String(upstreamRes.headers['content-type'] ?? 'application/json') });
                    res.end(errBody || JSON.stringify({ error: { message: `upstream ${status}` } }));
                  } catch { /* ignore */ }
                  writeLog({
                    ts: now(), rid, alias, backend: backendLabel, status,
                    ms: Date.now() - started, bytes: Buffer.byteLength(errBody), attempt,
                    outcome: 'final', failed: `${fc.kind}`,
                  });
                  finish({ outcome: 'final', failure: fc, detail: `${fc.kind}(${status})` });
                  return;
                }

                // 不可分类的非 2xx（理论到这里都是 fail 类）：透传
                try {
                  res.writeHead(status, { 'Content-Type': String(upstreamRes.headers['content-type'] ?? 'application/json') });
                  res.end(errBody);
                } catch { /* ignore */ }
                finish({ outcome: 'ok' });
              });
              return;
            }

            // ── 成功（2xx）：直接流式透传 ──
            const outHeaders: Record<string, string | string[]> = {};
            for (const [k, v] of Object.entries(upstreamRes.headers)) {
              const key = k.toLowerCase();
              if (['connection', 'transfer-encoding', 'keep-alive'].includes(key)) continue;
              if (key === 'content-length' && upstreamRes.headers['transfer-encoding']) continue;
              outHeaders[k] = v as string | string[];
            }
            try {
              res.writeHead(status, outHeaders);
            } catch { /* ignore */ }

            let bytes = 0;
            let streamFailed = false;
            upstreamRes.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
              try {
                if (!res.write(chunk)) upstreamRes.pause(); // 背压
              } catch { upstreamRes.pause(); }
            });
            res.on('drain', () => upstreamRes.resume());
            upstreamRes.on('end', () => {
              try { res.end(); } catch { /* ignore */ }
              if (streamFailed) health.recordFail(bKey, 'stream', 'mid-stream');
              writeLog({ ts: now(), rid, alias, backend: backendLabel, status, ms: Date.now() - started, bytes, outcome: 'ok' });
              finish({ outcome: 'ok' });
            });
            upstreamRes.on('error', err => {
              streamFailed = true;
              // 流已开始：不可重放。SSE 补发显式 error 事件后断流
              try {
                const isSSE = String(upstreamRes.headers['content-type'] ?? '').includes('text/event-stream');
                if (isSSE && !res.writableEnded) {
                  res.write(`data: ${JSON.stringify({ error: { message: `wb-gateway: 上游流中断：${err.message}`, rid } })}\n\n`);
                }
                res.end();
              } catch { /* ignore */ }
              health.recordFail(bKey, 'stream', err.message);
              writeLog({
                ts: now(), rid, alias, backend: backendLabel, status, ms: Date.now() - started, bytes,
                outcome: 'ok', failed: `stream error: ${err.message}`,
              });
              finish({ outcome: 'ok' }); // 已尽力交付，不切换
            });
            // 客户端断开：停止透传（中止上游流）
            res.on('close', () => {
              if (!res.writableEnded) {
                streamFailed = true;
                try { upstreamRes.destroy(); } catch { /* ignore */ }
              }
            });
          },
        );

        // 首字节超时
        upstreamReq.setTimeout(FIRST_BYTE_TIMEOUT_MS, () => {
          upstreamReq.destroy(new Error(`first-byte timeout ${FIRST_BYTE_TIMEOUT_MS}ms`));
        });

        upstreamReq.on('error', err => {
          const msg = err instanceof Error ? err.message : String(err);
          writeLog({
            ts: now(), rid, alias, backend: backendLabel, status: 0,
            ms: Date.now() - started, bytes: 0, attempt, failed: `network: ${msg}`,
          });
          finish({ outcome: 'retry', failure: { kind: 'transient', status: 0, detail: msg } });
        });

        upstreamReq.end(outBody);
      });
    }

    // ─────────────────────────── 辅助 ───────────────────────────

    function scheduleBackends(
      route: RouteEntry,
      usable: ResolvedBackend[],
      scheduling: 'priority' | 'round-robin',
      cursors: Map<string, number>,
      ht: BackendHealthTable,
    ): ResolvedBackend[] {
      if (scheduling === 'round-robin') {
        const cur = cursors.get(route.alias) ?? 0;
        cursors.set(route.alias, cur + 1);
        const start = cur % usable.length;
        return [...usable.slice(start), ...usable.slice(0, start)];
      }
      // priority：健康优先；冷却/熔断中的后端仅在「无健康后端可用」时兜底
      const healthy: ResolvedBackend[] = [];
      const cooling: ResolvedBackend[] = [];
      for (const b of usable) {
        const key = `${b.profile}/${b.model}`;
        ht.tryEnterHalfOpen(key);
        if (ht.isAvailable(key)) healthy.push(b);
        else cooling.push(b);
      }
      // 有健康后端就不碰冷却后端——避免明知限流还去打（需求：避免重复请求/超限）
      return healthy.length > 0 ? healthy : cooling;
    }

    async function acquireInflight(ht: BackendHealthTable, key: string, deadline: number): Promise<boolean> {
      const t0 = Date.now();
      for (;;) {
        if (ht.inflightOf(key) < DEFAULT_MAX_INFLIGHT) {
          ht.beginInflight(key);
          return true;
        }
        if (Date.now() - t0 > QUEUE_TIMEOUT_MS || Date.now() > deadline) return false;
        await sleep(50);
      }
    }

    function writeFinalFailure(
      res: http.ServerResponse,
      rid: string,
      alias: string,
      attempts: string[],
      reason: string,
    ): void {
      if (res.headersSent) {
        try { res.end(); } catch { /* ignore */ }
        return;
      }
      try {
        res.setHeader('x-wb-gateway', `rid=${rid},attempts=${attempts.map(a => a.replace(/,/g, ';')).join('|')}`);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            message: `wb-gateway: 全部后端失败（${reason}）`,
            request_id: rid,
            attempts,
          },
        }));
      } catch { /* ignore */ }
    }
  });
}

// ─────────────────────────── 模块级辅助 ───────────────────────────

interface RuntimeConfig {
  scheduling: 'priority' | 'round-robin';
  transientRetries: number;
  budgetMs: number;
}

function resolveRuntimeConfig(file: { retry?: number; scheduling?: unknown; budgetMs?: unknown }): RuntimeConfig {
  let transientRetries = TRANSIENT_RETRIES;
  if (typeof file.retry === 'number' && file.retry >= 0) {
    transientRetries = Math.min(Math.floor(file.retry), 20);
  }
  const scheduling = file.scheduling === 'round-robin' ? 'round-robin' : 'priority';
  const budgetMs = typeof file.budgetMs === 'number' && file.budgetMs > 1000 ? Math.floor(file.budgetMs) : DEFAULT_BUDGET_MS;
  return { scheduling, transientRetries, budgetMs };
}
export { resolveRuntimeConfig };

/** 失败分类：null = 成功 */
function classifyFailure(status: number, errBody: string, retryAfterMs?: number): FailureClass | null {
  if (status >= 200 && status < 300) return null;
  if (status === 429) {
    const quotaHit = /quota|balance|insufficient|exceeded_current_quota|billing|recharge|欠费|余额/i.test(errBody);
    if (quotaHit || (retryAfterMs !== undefined && retryAfterMs > 60_000)) {
      return { kind: 'quota', detail: `429 quota${retryAfterMs ? ` (retry-after ${Math.round(retryAfterMs / 1000)}s)` : ''}` };
    }
    return { kind: 'rate', retryAfterMs, detail: `429 rate${retryAfterMs ? ` (retry-after ${Math.round(retryAfterMs / 1000)}s)` : ''}` };
  }
  if (status === 401 || status === 403) {
    return { kind: 'auth', detail: `${status}` };
  }
  if (status >= 500 || status === 408) {
    return { kind: 'transient', status, detail: `upstream ${status}` };
  }
  return { kind: 'client', status, detail: `upstream ${status}` };
}

function parseRetryAfter(v: string | string[] | undefined): number | undefined {
  if (!v) return undefined;
  const raw = (Array.isArray(v) ? v[0] : v) ?? '';
  const s = Number.parseFloat(raw);
  if (Number.isFinite(s)) return s <= 100 ? s * 1000 : s; // 秒（>100 视为已换算的 ms，兼容非标实现）
  const d = Date.parse(raw);
  if (!Number.isNaN(d)) return Math.max(0, d - Date.now());
  return undefined;
}

function recordFailureToHealth(ht: BackendHealthTable, key: string, fc: FailureClass): void {
  switch (fc.kind) {
    case 'transient': ht.recordFail(key, 'transient', fc.detail); break;
    case 'rate': ht.recordFail(key, 'rate', fc.detail, fc.retryAfterMs); break;
    case 'quota': ht.recordFail(key, 'quota', fc.detail); break;
    case 'auth': ht.recordFail(key, 'auth', fc.detail); break;
    case 'client': ht.recordFail(key, 'client', fc.detail); break;
  }
}

function backoffMs(attempt: number): number {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
  const jitter = 1 + (Math.random() * 2 - 1) * JITTER;
  return Math.round(base * jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function now(): string {
  return new Date().toISOString();
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        reject(new Error(`body 超过 ${Math.round(MAX_BODY / 1024 / 1024)}MB`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function gatewayLogDir(root: string): string {
  return path.join(root, 'wb-switch', 'logs');
}

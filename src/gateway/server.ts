/**
 * 网关服务器：OpenAI 兼容的本地反向代理。
 *
 * 职责刻意保持最小（零智能，只查表）：
 *   1. 收到 /v1/chat/completions 请求 → 读 body 里的 model 字段查路由表
 *   2. 按 backends 顺序尝试转发：改写 model 与 Authorization，其余原样透传
 *   3. 连接失败 / 5xx / 429 → 自动试下一个后端；流式已开始则不再切换
 *   4. GET /v1/models → 返回全部 alias
 *   5. 每个请求写一行日志（alias → backend · 状态码 · 耗时），日志代替智能
 *
 * 非目标：协议转换（Anthropic/Gemini）、意图路由、脱敏、用量统计。
 * WorkBuddy 是 OpenAI 兼容客户端，网关只需要说 OpenAI 方言。
 */

import http from 'node:http';
import { request as httpsRequest } from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { readRoutes, resolveBackends, type RouteEntry } from './routes.js';
import { readSettings } from '../settings.js';

export interface GatewayOptions {
  root: string;
  port?: number;
  host?: string;
  /** 日志文件目录；默认 <root>/wb-switch/logs */
  logDir?: string;
}

interface LogLine {
  ts: string;
  alias: string;
  backend: string;
  status: number;
  ms: number;
  bytes: number;
  failed?: string;
}

const LOG_NAME = 'gateway.log';

/** 预估 body 上限：64MB，超限直接 413 */
const MAX_BODY = 64 * 1024 * 1024;

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

    // 热加载：每个请求重读 routes.json——路由/组合变更即时生效，无需重启网关。
    // routes.json 是原子写的小文件，读取代价可忽略。
    const loadRouteMap = (): { routeMap: Map<string, RouteEntry>; retry: number } => {
      try {
        const file = readRoutes(root);
        const map = new Map<string, RouteEntry>();
        for (const r of file.routes) map.set(r.alias, r);
        return { routeMap: map, retry: file.retry ?? 10 };
      } catch {
        // 读取失败（如写一半）时退回上次成功快照，绝不因配置文件抖动断流
        const map = new Map<string, RouteEntry>();
        for (const r of lastGoodRoutes) map.set(r.alias, r);
        return { routeMap: map, retry: lastGoodRetry };
      }
    };
    let lastGoodRoutes: RouteEntry[] = bootRoutes.routes;
    let lastGoodRetry = bootRoutes.retry ?? 10;

    const writeLog = (line: LogLine) => {
      try {
        fs.appendFileSync(logFile, JSON.stringify(line) + '\n');
      } catch {
        /* 日志失败不影响转发 */
      }
    };

    const server = http.createServer((req, res) => {
      void handle(req, res, { root, port, writeLog, loadRouteMap });
    });

    server.on('error', reject);
    server.listen(port, host, () => {
      console.log(`[wb-gateway] listening on http://${host}:${port} · ${bootRoutes.routes.length} routes · hot-reload on · log ${logFile}`);
      resolve(server);
    });

    server.on('close', () => {
      console.log('[wb-gateway] closed');
    });

    async function handle(
      req: http.IncomingMessage,
      res: http.ServerResponse,
      ctx: {
        root: string;
        port: number;
        writeLog: (line: LogLine) => void;
        loadRouteMap: () => { routeMap: Map<string, RouteEntry>; retry: number };
      },
    ): Promise<void> {
      const started = Date.now();
      const url = req.url ?? '/';
      const { routeMap, retry } = ctx.loadRouteMap();

      // 健康检查
      if (url === '/healthz' || url === '/wb-gateway/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, routes: routeMap.size, retry, ts: new Date().toISOString() }));
        return;
      }

      // 模型列表：返回全部 alias
      if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/')) {
        const models = [...routeMap.keys()].sort().map(id => ({ id, object: 'model', owned_by: 'wb-gateway' }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: models }));
        return;
      }

      // 聊天与补全：按 model 查表转发
      const isChat = req.method === 'POST' && (url.endsWith('/chat/completions') || url.endsWith('/completions'));
      if (!isChat) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `wb-gateway: 不支持的路径 ${url}` } }));
        return;
      }

      // 读 body
      let body: Buffer;
      try {
        body = await readBody(req);
      } catch (err) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `body 读取失败：${(err as Error).message}` } }));
        return;
      }

      // 提取 model
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

      const backends = resolveBackends(ctx.root, route.backends);
      const usable = backends.filter(b => !b.error);
      if (usable.length === 0) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: { message: `wb-gateway: 路由 "${route.alias}" 的后端全部不可用`, detail: backends.map(b => b.error) },
        }));
        return;
      }

      // 逐个后端尝试：每个后端先重试 retry 次（含首次共 retry+1 次尝试），
      // 仍失败才切下一个源。重试只发生在「还没开始回包」的阶段——
      // 一旦流式响应开始（headers 已发），中途失败只断流不转移（客户端可自行重发）。
      let lastFailure = '';
      for (let i = 0; i < usable.length; i++) {
        const backend = usable[i]!;
        const isLast = i === usable.length - 1;
        const attempts = isLast ? 1 : Math.max(1, retry + 1);
        let attemptFailure = '';
        for (let attempt = 1; attempt <= attempts; attempt++) {
          const result = await forwardOnce(req, body, backend, res, isLast, {
            alias: route.alias,
            started,
            writeLog: ctx.writeLog,
            attempt,
          });
          if (result === 'done') return;
          if (result === 'fail-final') return;
          attemptFailure = result;
          // 重试间隔：200ms 线性递增，避免打爆上游
          if (attempt < attempts) await new Promise(r => setTimeout(r, Math.min(200 * attempt, 2000)));
        }
        if (!isLast) {
          ctx.writeLog({
            ts: new Date().toISOString(),
            alias: route.alias,
            backend: `${backend.profile}/${backend.model}`,
            status: 0,
            ms: Date.now() - started,
            bytes: 0,
            failed: `give-up after ${attempts} attempts (${attemptFailure}) → next source`,
          });
        }
        lastFailure = attemptFailure;
      }
      // 理论上到不了这里（isLast 时必返回）
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `wb-gateway: 全部后端失败：${lastFailure}` } }));
    }

    /**
     * 转发一次。返回：
     *   'done'       —— 已成功响应（或最终失败已回复客户端）
     *   'fail-final' —— 已把最后一个后端的错误回复给客户端
     *   其他字符串    —— 失败原因（可重试 / 可继续尝试下一个后端）
     */
    async function forwardOnce(
      req: http.IncomingMessage,
      body: Buffer,
      backend: { profile: string; model: string; url: string; apiKey: string },
      res: http.ServerResponse,
      isLast: boolean,
      meta: { alias: string; started: number; writeLog: (line: LogLine) => void; attempt: number },
    ): Promise<'done' | 'fail-final' | string> {
      const target = new URL(backend.url);
      const isTls = target.protocol === 'https:';

      // 改写 body 里的 model 为后端真实模型名
      let outBody: Buffer;
      try {
        const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
        parsed.model = backend.model;
        outBody = Buffer.from(JSON.stringify(parsed), 'utf8');
      } catch {
        outBody = body;
      }

      // 透传请求头（去掉 hop-by-hop 与 host/authorization/content-length）
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

      const backendLabel = `${backend.profile}/${backend.model}`;

      return new Promise<'done' | 'fail-final' | string>(resolvePromise => {
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

            // 可重试状态：连接成功但后端报错（5xx / 401 / 403 / 429）。
            // 非 last 后端 → 返回失败原因，由外层决定重试还是切下一个源。
            const retryable = status >= 500 || status === 401 || status === 403 || status === 429;
            if (retryable && !isLast) {
              // 读完丢弃响应，尝试下一个
              upstreamRes.resume();
              meta.writeLog({
                ts: new Date().toISOString(),
                alias: meta.alias,
                backend: backendLabel,
                status,
                ms: Date.now() - meta.started,
                bytes: 0,
                failed: `upstream ${status} (attempt ${meta.attempt})`,
              });
              resolvePromise(`upstream ${status} from ${backendLabel}`);
              return;
            }

            // 成功或最后一个后端：原样透传
            const outHeaders: Record<string, string | string[]> = {};
            for (const [k, v] of Object.entries(upstreamRes.headers)) {
              const key = k.toLowerCase();
              if (['connection', 'transfer-encoding', 'keep-alive'].includes(key)) continue;
              if (key === 'content-length' && upstreamRes.headers['transfer-encoding']) continue;
              outHeaders[k] = v as string | string[];
            }

            res.writeHead(status, outHeaders);

            let bytes = 0;
            upstreamRes.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
              res.write(chunk);
            });
            upstreamRes.on('end', () => {
              res.end();
              meta.writeLog({
                ts: new Date().toISOString(),
                alias: meta.alias,
                backend: backendLabel,
                status,
                ms: Date.now() - meta.started,
                bytes,
              });
              resolvePromise('done');
            });
            upstreamRes.on('error', err => {
              try { res.end(); } catch { /* ignore */ }
              meta.writeLog({
                ts: new Date().toISOString(),
                alias: meta.alias,
                backend: backendLabel,
                status,
                ms: Date.now() - meta.started,
                bytes,
                failed: `stream error: ${err.message}`,
              });
              resolvePromise('done');
            });
          },
        );

        upstreamReq.setTimeout(3 * 60 * 1000, () => {
          upstreamReq.destroy(new Error('upstream timeout (3min)'));
        });

        upstreamReq.on('error', err => {
          const msg = err instanceof Error ? err.message : String(err);
          meta.writeLog({
            ts: new Date().toISOString(),
            alias: meta.alias,
            backend: backendLabel,
            status: 0,
            ms: Date.now() - meta.started,
            bytes: 0,
            failed: msg,
          });
          if (isLast) {
            if (!res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: { message: `wb-gateway: 上游请求失败：${msg}` } }));
            } else {
              try { res.end(); } catch { /* ignore */ }
            }
            resolvePromise('fail-final');
          } else {
            resolvePromise(`network: ${msg}`);
          }
        });

        upstreamReq.end(outBody);
      });
    }
  });
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

/** 供 CLI/守护进程复用：默认配置根目录 */
export function gatewayLogDir(root: string): string {
  return path.join(root, 'wb-switch', 'logs');
}

export function readSettingsSafe(root: string): { autoBackup: boolean } {
  try {
    return readSettings(root);
  } catch {
    return { autoBackup: false };
  }
}

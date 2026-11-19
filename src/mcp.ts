/**
 * MCP server（stdio JSON-RPC 2.0）：把 wb-switch 图片能力暴露为标准 MCP 工具，
 * 供 WorkBuddy 或其它 agent 直接调用（免写 HTTP 客户端代码）。
 *
 * 工具清单：
 *   generate_image  文生图（model/prompt/size/format/watermark/...）
 *   edit_image      图片编辑（图生图，支持本地文件/URL/data URL，自动转 data URL）
 *   list_models     列出网关全部路由（含 kind 标注）
 *
 * 启动方式：
 *   wbs mcp                          # stdio 模式（MCP client 拉起）
 *   配置到 WorkBuddy 的 mcp.json：见 README
 *
 * 行为约定（与 wb-switch 现有调用方式一致）：
 *   - 复用网关调度（熔断/分类重试/预算），自动拉起网关
 *   - 默认 response_format=url（结果含 24h 临时 URL）；
 *     save=true 时自动下载图片落盘并返回本地绝对路径
 *   - 图片编辑的输入支持本地文件（自动转 base64 data URL）
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDaemonStatus, startDaemon, pingGateway } from './gateway/daemon.js';
import { readRoutes } from './gateway/routes.js';
import { resolveConfigRoot } from './paths.js';
import { VERSION } from './version.js';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

// ─────────────────────────── stdio 读写 ───────────────────────────

function write(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function writeResult(id: number | string | null, result: unknown): void {
  write({ jsonrpc: '2.0', id, result });
}

function writeError(id: number | string | null, code: number, message: string): void {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

// ─────────────────────────── 网关 ───────────────────────────

async function ensureGateway(root: string): Promise<number | null> {
  const status = getDaemonStatus(root);
  if (status.running && status.port && (await pingGateway(status.port))) return status.port;
  const { port } = startDaemon(root);
  for (let i = 0; i < 40; i++) {
    if (await pingGateway(port)) return port;
    await new Promise(r => setTimeout(r, 150));
  }
  return null;
}

async function callImages(
  root: string,
  endpoint: 'generations' | 'edits',
  payload: Record<string, unknown>,
): Promise<{ ok: true; json: any } | { ok: false; error: string }> {
  const port = await ensureGateway(root);
  if (!port) return { ok: false, error: '网关无法启动（wbs gateway status 排查）' };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/images/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* ignore */ }
    if (res.status !== 200) {
      const msg = json?.error?.message ?? text.slice(0, 300) ?? `HTTP ${res.status}`;
      return { ok: false, error: msg };
    }
    return { ok: true, json };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ─────────────────────────── 图片下载落盘 ───────────────────────────

async function downloadImage(url: string, saveDir: string, fmt: string): Promise<string> {
  fs.mkdirSync(saveDir, { recursive: true });
  const ext = fmt === 'jpeg' ? 'jpg' : fmt || 'png';
  const name = `wb-image-${Date.now()}.${ext}`;
  const file = path.join(saveDir, name);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(file, buf);
  return file;
}

// ─────────────────────────── 工具实现 ───────────────────────────

const TOOL_DEF_GENERATE = {
  name: 'generate_image',
  description: '文生图：文本 prompt 生成图片（SenseNova U1.5 等 OpenAI Images 兼容模型，经 wb-switch 网关路由与故障转移）。返回图片 URL（24 小时有效）或本地文件路径（save=true 时自动下载）。',
  inputSchema: {
    type: 'object',
    properties: {
      model: { type: 'string', description: '网关里的图片模型别名（先 image route add 配置），如 sensenova-u1.5-lite' },
      prompt: { type: 'string', description: '图像描述（建议中文，模型会自动润色）' },
      size: { type: 'string', description: '尺寸 WxH，32 的倍数，512-4096。常用：1024x1024、2048x2048（1:1 2K）、2720x1536（16:9 2K）' },
      format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: '输出格式（默认 png）' },
      watermark: { type: 'boolean', description: '是否加官方水印（默认 true）' },
      prompt_extend: { type: 'boolean', description: '提示词自动润色（默认 true）' },
      save: { type: 'boolean', description: 'true=自动下载图片到本地并返回绝对路径（默认 false，返回 24h URL）' },
      save_dir: { type: 'string', description: 'save=true 时的保存目录（默认 ~/.workbuddy/wb-switch/images）' },
    },
    required: ['model', 'prompt'],
  },
};

const TOOL_DEF_EDIT = {
  name: 'edit_image',
  description: '图片编辑（图生图）：输入 1-5 张图片 + 编辑指令，改写图片。支持本地文件路径 / http(s) URL / data URL（本地文件自动转 base64）。',
  inputSchema: {
    type: 'object',
    properties: {
      model: { type: 'string', description: '网关里的图片模型别名' },
      prompt: { type: 'string', description: '编辑指令（描述要改什么，未提及的尽量保留）' },
      images: { type: 'array', items: { type: 'string' }, description: '图片列表：第 1 张为主编辑图，最多 5 张；支持本地路径/URL/data URL' },
      size: { type: 'string', description: '尺寸，默认 auto（自动适配主图）' },
      format: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
      watermark: { type: 'boolean' },
      save: { type: 'boolean', description: 'true=下载到本地返回路径' },
      save_dir: { type: 'string' },
    },
    required: ['model', 'prompt', 'images'],
  },
};

const TOOL_DEF_LIST = {
  name: 'list_models',
  description: '列出 wb-switch 网关的全部模型路由（chat 与图片模型，含后端 fallback 链与类型标注）。',
  inputSchema: { type: 'object', properties: {} },
};

function defaultSaveDir(root: string): string {
  return path.join(root, 'wb-switch', 'images');
}

function resolveImageInput(input: string): string {
  if (/^https?:\/\//i.test(input) || input.startsWith('data:')) return input;
  const file = path.resolve(input);
  if (!fs.existsSync(file)) throw new Error(`图片不存在：${input}`);
  const ext = path.extname(file).toLowerCase().replace('.', '') || 'png';
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  return `data:image/${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

async function handleGenerate(root: string, params: Record<string, unknown>): Promise<unknown> {
  const model = String(params.model ?? '');
  const prompt = String(params.prompt ?? '');
  if (!model || !prompt) throw new Error('model 与 prompt 必填');

  const payload: Record<string, unknown> = {
    model, prompt,
    response_format: params.save ? 'url' : 'url',
  };
  if (typeof params.size === 'string') payload.size = params.size;
  if (typeof params.format === 'string') payload.output_format = params.format;
  if (typeof params.watermark === 'boolean') payload.watermark = params.watermark;
  if (typeof params.prompt_extend === 'boolean') payload.prompt_extend = params.prompt_extend;

  const result = await callImages(root, 'generations', payload);
  if (!result.ok) throw new Error(result.error);

  const items = result.json?.data ?? [];
  const fmt = result.json?.output_format ?? String(params.format ?? 'png');
  const saveDir = typeof params.save_dir === 'string' ? params.save_dir : defaultSaveDir(root);

  const out: unknown[] = [];
  for (const it of items) {
    if (it.url) {
      if (params.save === true) {
        const file = await downloadImage(it.url, saveDir, fmt);
        out.push({ path: file, url: it.url });
      } else {
        out.push({ url: it.url, note: 'URL 24 小时有效；save=true 可自动落盘' });
      }
    } else if (it.b64_json) {
      out.push({ b64: it.b64_json.slice(0, 100) + '…', note: 'base64（过长截断；建议 save/url 模式）' });
    }
  }
  return { images: out, usage: result.json?.usage, size: result.json?.size, format: fmt };
}

async function handleEdit(root: string, params: Record<string, unknown>): Promise<unknown> {
  const model = String(params.model ?? '');
  const prompt = String(params.prompt ?? '');
  const rawImages = Array.isArray(params.images) ? (params.images as unknown[]) : [];
  if (!model || !prompt || rawImages.length === 0) throw new Error('model、prompt、images 必填');

  const imageUrls = rawImages.slice(0, 5).map(x => resolveImageInput(String(x)));
  const payload: Record<string, unknown> = {
    model, prompt,
    images: imageUrls.map(u => ({ image_url: u })),
    response_format: 'url',
  };
  if (typeof params.size === 'string') payload.size = params.size;
  if (typeof params.format === 'string') payload.output_format = params.format;
  if (typeof params.watermark === 'boolean') payload.watermark = params.watermark;

  const result = await callImages(root, 'edits', payload);
  if (!result.ok) throw new Error(result.error);

  const items = result.json?.data ?? [];
  const fmt = result.json?.output_format ?? String(params.format ?? 'png');
  const saveDir = typeof params.save_dir === 'string' ? params.save_dir : defaultSaveDir(root);

  const out: unknown[] = [];
  for (const it of items) {
    if (it.url) {
      if (params.save === true) {
        const file = await downloadImage(it.url, saveDir, fmt);
        out.push({ path: file, url: it.url });
      } else {
        out.push({ url: it.url, note: 'URL 24 小时有效' });
      }
    } else if (it.b64_json) {
      out.push({ b64: it.b64_json.slice(0, 100) + '…', note: 'base64 截断' });
    }
  }
  return { images: out, usage: result.json?.usage, format: fmt };
}

function handleList(root: string): unknown {
  const file = readRoutes(root);
  return {
    routes: file.routes.map(r => ({
      model: r.alias,
      kind: r.kind ?? 'chat',
      backends: r.backends.map(b => `${b.profile}/${b.model}`),
    })),
    scheduling: file.scheduling ?? 'priority',
  };
}

// ─────────────────────────── 主循环 ───────────────────────────

export async function runMcpServer(options: { configDir?: string } = {}): Promise<void> {
  const root = options.configDir ? path.resolve(options.configDir) : resolveConfigRoot();

  const input = process.stdin;
  let buffer = '';
  input.setEncoding('utf8');

  input.on('data', chunk => {
    buffer += chunk;
    // 按行分帧（MCP stdio 用 LSP 分帧也常见，这里兼容两种：直接 JSON 行 + LSP Content-Length）
    // 简化：MCP 官方 stdio 是换行分帧的 JSON-RPC
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      void dispatch(line, root);
    }
  });

  // 生命周期保持
  return new Promise(() => {});
}

async function dispatch(line: string, root: string): Promise<void> {
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(line) as JsonRpcRequest;
  } catch {
    writeError(null, -32700, 'Parse error');
    return;
  }
  const id = req.id ?? null;

  switch (req.method) {
    case 'initialize':
      writeResult(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'wb-switch-mcp', version: VERSION },
      });
      return;
    case 'notifications/initialized':
    case 'initialized':
      // 通知不回包
      return;
    case 'ping':
      writeResult(id, {});
      return;
    case 'tools/list':
      writeResult(id, { tools: [TOOL_DEF_GENERATE, TOOL_DEF_EDIT, TOOL_DEF_LIST] });
      return;
    case 'tools/call': {
      const name = String((req.params as { name?: unknown } | undefined)?.name ?? '');
      const args = ((req.params as { arguments?: unknown } | undefined)?.arguments ?? {}) as Record<string, unknown>;
      try {
        let result: unknown;
        if (name === 'generate_image') result = await handleGenerate(root, args);
        else if (name === 'edit_image') result = await handleEdit(root, args);
        else if (name === 'list_models') result = handleList(root);
        else {
          writeError(id, -32602, `未知工具：${name}`);
          return;
        }
        writeResult(id, { content: [{ type: 'json', text: JSON.stringify(result, null, 2) }] });
      } catch (err) {
        // 工具执行失败：MCP 约定 isError=true 的 content 返回
        writeResult(id, {
          content: [{ type: 'text', text: `工具执行失败：${(err as Error).message}` }],
          isError: true,
        });
      }
      return;
    }
    default:
      writeError(id, -32601, `未知方法：${req.method}`);
  }
}

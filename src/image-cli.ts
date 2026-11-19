/**
 * 图片命令组：wb-switch image <sub>。
 *
 *   image list                          列出图片模型路由
 *   image route add <别名> --profile <源> --model <模型ID> [--profile2 ...]
 *                                        添加图片路由（kind=image，走 /v1/images/*）
 *   image mark <源> <模型ID> [--rm]      手动标记/取消标记源内模型为图片模型
 *                                        （导入模型列表后标记用；写入 profile 的 api 字段）
 *   image models [源]                    列出源内标记为图片的模型
 *   image gen <别名> <prompt> [--size WxH] [--format png|jpeg|webp] [--url|--b64] [--no-watermark]
 *                                        直接生图（自动拉起网关）
 *   image edit <别名> <prompt> --image <图片URL|文件> [--image2 ...]
 *                                        图片编辑（图生图，最多 5 张）
 *
 * SenseNova U1.5（OpenAI Images 兼容）：端点 /v1/images/generations|edits，
 * Bearer 鉴权与 chat 同 key —— 因此配置只需 endpoint + apiKey（复用现有源）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { c, fail, heading, ok, warn } from './ui.js';
import { addRoute, readRoutes, removeRoute, routesFile, validateAlias, type RouteBackend } from './gateway/routes.js';
import { getDaemonStatus, startDaemon, pingGateway } from './gateway/daemon.js';
import { loadProfile, listProfileNames, saveProfile } from './profiles.js';
import { probeModel, updateHealth } from './gateway/probe.js';
import type { Args } from './gateway/cli-bridge.js';
import { resolveConfigRoot } from './paths.js';

const has = (a: Args, k: string) => a.flags.has(k) && a.flags.get(k) !== false;
const str = (a: Args, k: string): string | undefined => {
  const v = a.flags.get(k);
  return typeof v === 'string' ? v : undefined;
};
const many = (a: Args, k: string): string[] => {
  const out: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const v = str(a, i === 1 ? k : `${k}${i}`);
    if (v) out.push(v);
  }
  return out;
};

function jsonOut(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

export async function cmdImage(args: Args): Promise<number> {
  const sub = args.positional[1];
  const root = args.configDir ? path.resolve(args.configDir) : resolveConfigRoot();

  switch (sub) {
    case 'list':
    case 'ls':
      return cmdList(args, root);
    case 'route':
      return cmdRoute(args, root);
    case 'mark':
    case 'unmark':
      return cmdMark(args, root, sub === 'unmark');
    case 'models':
      return cmdModels(args, root);
    case 'gen':
    case 'generate':
      return await cmdGen(args, root);
    case 'edit':
      return await cmdEdit(args, root);
    default:
      fail(`未知 image 子命令：${sub ?? '(空)'}`);
      process.stderr.write('可用：list route mark models gen edit\n');
      return 2;
  }
}

// ─────────────────────────── list ───────────────────────────

function cmdList(args: Args, root: string): number {
  const file = readRoutes(root);
  const images = file.routes.filter(r => r.kind === 'image');
  if (images.length === 0) {
    warn('还没有图片模型路由。');
    process.stdout.write(`  ${c.gray('添加：')} wb-switch image route add <别名> --profile <源> --model <模型ID>\n`);
    process.stdout.write(`  ${c.gray('SenseNova 示例：')} wb-switch image route add sensenova-u1.5-lite --profile 183 --model sensenova-u1.5-lite\n`);
    return 0;
  }
  if (has(args, 'json')) {
    jsonOut(images);
    return 0;
  }
  heading(`图片模型路由（${images.length} 条）`);
  for (const r of images) {
    process.stdout.write(`  ${c.bold(c.cyan(r.alias))}\n`);
    r.backends.forEach((b, i) => {
      const mark = i === 0 ? c.green('①') : c.gray(String(i + 1));
      process.stdout.write(`    ${mark} ${b.profile}${c.gray('/')}${b.model}\n`);
    });
  }
  return 0;
}

// ─────────────────────────── route add/remove ───────────────────────────

function cmdRoute(args: Args, root: string): number | Promise<number> {
  const action = args.positional[2];
  if (action === 'add') return cmdRouteAdd(args, root);
  if (action === 'remove' || action === 'rm') return cmdRouteRemove(args, root);
  fail(`用法：wb-switch image route add|remove ...`);
  return 2;
}

async function cmdRouteAdd(args: Args, root: string): Promise<number> {
  const alias = args.positional[3];
  if (!alias) {
    fail('用法：wb-switch image route add <别名> --profile <源> --model <模型ID> [--profile2 <源> --model2 <模型ID>]');
    return 2;
  }
  validateAlias(alias);

  const backends: RouteBackend[] = [];
  for (let i = 1; i <= 5; i++) {
    const p = str(args, i === 1 ? 'profile' : `profile${i}`);
    const m = str(args, i === 1 ? 'model' : `model${i}`);
    if (!p && !m) continue;
    if (!p || !m) {
      fail(`后端需要成对提供 --profile 与 --model（收到 profile=${p ?? '无'} model=${m ?? '无'}）。`);
      return 2;
    }
    backends.push({ profile: p, model: m });
  }
  if (backends.length === 0) {
    fail('至少需要一个后端（--profile <源> --model <模型ID>）。');
    return 2;
  }

  // L3 探测（图片端点）：默认开启
  if (!has(args, 'no-test')) {
    let allPass = true;
    for (const b of backends) {
      try {
        const profile = loadProfile(root, b.profile);
        const entry = profile.models.find(x => x.id === b.model);
        if (!entry?.url) continue;
        // 图片端点探测：直接试 generations（空 prompt 会 400，说明端点/鉴权通）
        const { deriveImagesUrl } = await import('./gateway/routes.js');
        const imagesUrl = deriveImagesUrl(entry.url, 'generations');
        process.stdout.write(`  ${c.gray('测试图片端点')} ${b.profile}/${b.model} …\n`);
        const r = await probeModel(imagesUrl, String(entry.apiKey ?? ''), b.model);
        // 400（prompt 校验失败）说明端点存在且鉴权通过
        if (r.status === 'fail' && r.code === 400) {
          process.stdout.write(`    ${c.green('✓')} 端点可达（鉴权通过）\n`);
          updateHealth(root, `${b.profile}/${b.model}`, { ...r, status: 'pass', reason: '图片端点可达' });
          continue;
        }
        updateHealth(root, `${b.profile}/${b.model}`, r);
        if (r.status === 'pass') process.stdout.write(`    ${c.green('✓')} ${r.reason}\n`);
        else if (r.status === 'degraded') process.stdout.write(`    ${c.yellow('△')} ${r.reason}\n`);
        else {
          process.stdout.write(`    ${c.red('✗')} ${r.reason}\n`);
          allPass = false;
        }
      } catch (err) {
        process.stdout.write(`    ${c.red('✗')} ${(err as Error).message}\n`);
        allPass = false;
      }
    }
    if (!allPass && !has(args, 'force')) {
      fail('存在测试未通过的图片端点。修正后重试，或 --force 强制 / --no-test 跳过。');
      return 1;
    }
  }

  try {
    addRoute(root, alias, backends, { force: has(args, 'force'), kind: 'image' });
  } catch (err) {
    fail((err as Error).message);
    return 1;
  }
  if (has(args, 'json')) {
    jsonOut({ added: alias, kind: 'image', backends });
    return 0;
  }
  ok(`已添加图片路由 ${c.bold(c.cyan(alias))}（${backends.length} 个后端 · kind=image）。`);
  for (const b of backends) process.stdout.write(`  ${c.gray('→')} ${b.profile}/${b.model}\n`);
  process.stdout.write(`\n${c.gray('生图')} wb-switch image gen ${alias} "<prompt>"\n`);
  process.stdout.write(`${c.gray('聊天框使用')} bind 后在 WorkBuddy 选择 ${alias} 发 prompt 即可\n`);
  return 0;
}

function cmdRouteRemove(args: Args, root: string): number {
  const alias = args.positional[3];
  if (!alias) {
    fail('用法：wb-switch image route remove <别名>');
    return 2;
  }
  const removed = removeRoute(root, alias);
  if (!removed) {
    warn(`没有别名 ${alias} 的路由。`);
    return 1;
  }
  ok(`已删除路由 ${alias}。`);
  return 0;
}

// ─────────────────────────── mark（源模型标记为图片模型） ───────────────────────────

/**
 * mark/unmark：在源 profile 的模型条目上写 api: "images" 字段。
 * 导入模型列表（fetch/import）后，用本命令把 U1.5 等标记为图片模型，
 * 后续 image route add / MCP list_models 以此过滤。
 */
function cmdMark(args: Args, root: string, unmark: boolean): number {
  const profileName = args.positional[2];
  const modelId = args.positional[3];
  if (!profileName || (!modelId && !has(args, 'all'))) {
    fail('用法：wb-switch image mark <源> <模型ID> [--all]（取消：image unmark <源> <模型ID>）');
    return 2;
  }

  let profile;
  try {
    profile = loadProfile(root, profileName);
  } catch (err) {
    fail((err as Error).message);
    return 1;
  }

  const targets = has(args, 'all')
    ? profile.models.filter(m => /u1\.5|image|imagen|dall|diffusion|mj|midjourney|banana|seedream|sora/i.test(m.id))
    : profile.models.filter(m => m.id === modelId);
  if (targets.length === 0) {
    fail(`源「${profile.name}」里没有匹配的模型${has(args, 'all') ? '' : `：${modelId}`}。`);
    return 1;
  }

  for (const m of targets) {
    if (unmark) delete (m as Record<string, unknown>).api;
    else (m as Record<string, unknown>).api = 'images';
  }
  saveProfile(root, profile);

  if (has(args, 'json')) {
    jsonOut({ profile: profile.name, unmark, models: targets.map(m => m.id) });
    return 0;
  }
  ok(`已${unmark ? '取消标记' : '标记'}源「${profile.name}」的 ${targets.length} 个模型为图片模型：`);
  for (const m of targets) process.stdout.write(`  ${unmark ? c.gray('−') : c.green('✓')} ${m.id}\n`);
  return 0;
}

// ─────────────────────────── models（列出标记的图片模型） ───────────────────────────

function cmdModels(args: Args, root: string): number {
  const profileName = args.positional[2];
  const names = profileName ? [profileName] : listProfileNames(root);
  const out: { profile: string; model: string; url?: string }[] = [];
  for (const n of names) {
    try {
      const p = loadProfile(root, n);
      for (const m of p.models) {
        if ((m as Record<string, unknown>).api === 'images') out.push({ profile: p.name, model: m.id, url: m.url });
      }
    } catch { /* skip */ }
  }
  if (out.length === 0) {
    warn('还没有标记为图片模型的条目。');
    process.stdout.write(`  ${c.gray('标记：')} wb-switch image mark <源> <模型ID>（--all 自动按名字识别）\n`);
    return 0;
  }
  if (has(args, 'json')) {
    jsonOut(out);
    return 0;
  }
  heading(`图片模型（${out.length} 个）`);
  for (const it of out) process.stdout.write(`  ${c.bold(it.model)} ${c.gray(`· ${it.profile}`)}\n`);
  return 0;
}

// ─────────────────────────── gen / edit（直调网关） ───────────────────────────

/** 确保网关在跑：没跑则自动启动（等探活通过） */
async function ensureGateway(root: string): Promise<number | null> {
  const status = getDaemonStatus(root);
  if (status.running && status.port && await pingGateway(status.port)) return status.port;
  const { port } = startDaemon(root);
  for (let i = 0; i < 40; i++) {
    if (await pingGateway(port)) return port;
    await new Promise(r => setTimeout(r, 150));
  }
  return null;
}

function resolveImageInput(input: string): string {
  // 本地文件 → data URL（编辑接口要求 data:image/...;base64, 前缀）
  if (/^https?:\/\//i.test(input) || input.startsWith('data:')) return input;
  const file = path.resolve(input);
  if (!fs.existsSync(file)) {
    throw new Error(`图片不存在：${input}（支持 http(s) URL、data: URL 或本地文件路径）`);
  }
  const ext = path.extname(file).toLowerCase().replace('.', '') || 'png';
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  const b64 = fs.readFileSync(file).toString('base64');
  return `data:image/${mime};base64,${b64}`;
}

async function callImages(
  root: string,
  alias: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; json: any; text: string } | { error: string }> {
  const port = await ensureGateway(root);
  if (!port) return { error: '网关无法启动（wb-switch gateway status 排查）' };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: alias, ...payload }),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* ignore */ }
    return { status: res.status, json, text };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

async function cmdGen(args: Args, root: string): Promise<number> {
  const alias = args.positional[2];
  const prompt = args.positional.slice(3).join(' ');
  if (!alias || !prompt) {
    fail('用法：wb-switch image gen <别名> "<prompt>" [--size 1024x1024] [--format png] [--url] [--b64] [--no-watermark]');
    return 2;
  }

  const payload: Record<string, unknown> = { prompt };
  const size = str(args, 'size');
  if (size) payload.size = size;
  const fmt = str(args, 'format') ?? str(args, 'output-format');
  if (fmt) payload.output_format = fmt;
  payload.response_format = has(args, 'b64') ? 'b64_json' : 'url';
  if (has(args, 'no-watermark')) payload.watermark = false;
  if (has(args, 'no-extend')) payload.prompt_extend = false;

  const result = await callImages(root, alias, payload);
  if ('error' in result) {
    fail(result.error);
    return 1;
  }
  if (result.status !== 200) {
    fail(`生成失败（HTTP ${result.status}）：${(result.json?.error?.message ?? result.text).slice?.(0, 300) ?? result.text}`);
    return 1;
  }
  if (has(args, 'json')) {
    jsonOut(result.json);
    return 0;
  }
  const data = result.json?.data ?? [];
  if (data.length === 0) {
    warn('上游未返回图片数据。');
    return 1;
  }
  ok(`已生成 ${data.length} 张图片：`);
  for (const it of data) {
    if (it.url) process.stdout.write(`  ${c.cyan(it.url)}\n`);
    else if (it.b64_json) process.stdout.write(`  ${c.gray(`(base64 ${it.b64_json.length} 字符，--json 查看完整数据)`)}\n`);
  }
  process.stdout.write(`\n${c.gray('URL 24 小时有效；需要落盘可加 --b64 后重定向处理，或用 MCP 工具 generate_image（自动保存文件）')}\n`);
  return 0;
}

async function cmdEdit(args: Args, root: string): Promise<number> {
  const alias = args.positional[2];
  const prompt = args.positional.slice(3).join(' ');
  const images = many(args, 'image');
  if (!alias || !prompt || images.length === 0) {
    fail('用法：wb-switch image edit <别名> "<指令>" --image <URL|文件> [--image2 ...] [--size auto]');
    return 2;
  }

  let imageUrls: string[];
  try {
    imageUrls = images.map(resolveImageInput);
  } catch (err) {
    fail((err as Error).message);
    return 1;
  }

  const payload: Record<string, unknown> = {
    prompt,
    images: imageUrls.slice(0, 5).map(u => ({ image_url: u })),
  };
  const size = str(args, 'size');
  if (size) payload.size = size;
  const fmt = str(args, 'format') ?? str(args, 'output-format');
  if (fmt) payload.output_format = fmt;
  payload.response_format = has(args, 'b64') ? 'b64_json' : 'url';
  if (has(args, 'no-watermark')) payload.watermark = false;

  // edits 走网关的 /v1/images/edits
  const port = await ensureGateway(root);
  if (!port) {
    fail('网关无法启动');
    return 1;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/images/edits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: alias, ...payload }),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* ignore */ }
    if (res.status !== 200) {
      fail(`编辑失败（HTTP ${res.status}）：${(json?.error?.message ?? text).slice?.(0, 300) ?? text}`);
      return 1;
    }
    if (has(args, 'json')) {
      jsonOut(json);
      return 0;
    }
    const data = json?.data ?? [];
    ok(`已编辑生成 ${data.length} 张图片：`);
    for (const it of data) {
      if (it.url) process.stdout.write(`  ${c.cyan(it.url)}\n`);
      else if (it.b64_json) process.stdout.write(`  ${c.gray(`(base64 ${it.b64_json.length} 字符)`)}\n`);
    }
    return 0;
  } catch (err) {
    fail((err as Error).message);
    return 1;
  }
}

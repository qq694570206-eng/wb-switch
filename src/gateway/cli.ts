/**
 * 网关命令组：wb-switch gateway <sub>。
 *
 * 子命令：
 *   status                 查看运行状态
 *   start [--port N]      后台启动网关（独立进程）
 *   stop                  停止网关
 *   restart               重启
 *   run                    前台运行（launchd / 调试用）
 *   routes                查看路由表
 *   route add <alias> --profile <源> --model <模型> [--profile2 ...]  添加路由
 *   route remove <alias>  删除路由
 *   lint                   校验路由表（引用的源/模型是否存在）
 *   bind [源名]            生成指向网关的 models.json 快照源并切换
 *   logs [--lines N]      查看请求日志
 *   install / uninstall   安装/卸载 launchd 开机自启（macOS）
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { c, fail, heading, ok, warn } from '../ui.js';
import {
  addRoute,
  buildGatewayModels,
  lintRoutes,
  readRoutes,
  removeRoute,
  resolveBackends,
  routesFile,
  validateAlias,
  type RouteBackend,
} from './routes.js';
import {
  getDaemonStatus,
  startDaemon,
  stopDaemon,
  writeLaunchdPlist,
  removeLaunchdPlist,
  launchdPlistPath,
  pingGateway,
} from './daemon.js';
import { startGatewayServer, gatewayLogDir } from './server.js';
import { saveProfile, profileExists } from '../profiles.js';
import { setActive, readState } from '../state.js';
import { switchTo } from '../switcher.js';
import type { Args } from './cli-bridge.js';
import { resolveConfigRoot } from '../paths.js';

const has = (a: Args, k: string) => a.flags.has(k) && a.flags.get(k) !== false;
const str = (a: Args, k: string): string | undefined => {
  const v = a.flags.get(k);
  return typeof v === 'string' ? v : undefined;
};

function jsonOut(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

export async function cmdGateway(args: Args): Promise<number> {
  const sub = args.positional[1];
  const root = args.configDir ? path.resolve(args.configDir) : resolveConfigRoot();

  switch (sub) {
    case undefined:
    case 'status':
      return cmdStatus(args, root);
    case 'start':
      return cmdStart(args, root);
    case 'stop':
      return await cmdStop(args, root);
    case 'restart':
      return await cmdRestart(args, root);
    case 'run':
      return await cmdRun(args, root);
    case 'routes':
    case 'route':
      return cmdRoutes(args, root);    case 'lint':
      return cmdLint(args, root);
    case 'bind':
      return await cmdBind(args, root);
    case 'logs':
      return cmdLogs(args, root);
    case 'install':
      return cmdInstall(args, root);
    case 'uninstall':
      return await cmdUninstall(args, root);
    default:
      if (sub === 'route' || sub === 'routes') return cmdRoutes(args, root);
      fail(`未知 gateway 子命令：${sub}`);
      process.stderr.write('可用：status start stop restart run routes lint bind logs install uninstall\n');
      return 2;
  }
}

// ─────────────────────────── status ───────────────────────────

async function cmdStatus(args: Args, root: string): Promise<number> {
  const status = getDaemonStatus(root);
  const routes = readRoutes(root);
  let alive = false;
  if (status.port) alive = await pingGateway(status.port);
  if (has(args, 'json')) {
    jsonOut({ ...status, port: status.port, responding: alive, routes: routes.routes.length });
    return 0;
  }
  heading('网关状态');
  process.stdout.write(`  进程     ${status.running ? c.green(`运行中 (pid ${status.pid})`) : c.gray('未运行')}\n`);
  process.stdout.write(`  端口     ${status.port ?? '-'} ${alive ? c.green('· 探活成功') : status.running ? c.yellow('· 探活失败') : ''}\n`);
  process.stdout.write(`  路由数   ${routes.routes.length}\n`);
  process.stdout.write(`  路由表   ${routesFile(root)}\n`);
  process.stdout.write(`  日志     ${path.join(gatewayLogDir(root), 'gateway.log')}\n`);
  process.stdout.write(`  launchd  ${status.launchd ? c.green(`已安装 (${status.plistPath})`) : c.gray('未安装（可选开机自启：gateway install）')}\n`);
  return 0;
}

// ─────────────────────────── start / stop / restart ───────────────────────────

function cmdStart(args: Args, root: string): number {
  const port = str(args, 'port') ? Number.parseInt(str(args, 'port')!, 10) : undefined;
  try {
    const { pid, port: usedPort } = startDaemon(root, { port });
    if (has(args, 'json')) {
      jsonOut({ started: true, pid, port: usedPort });
      return 0;
    }
    ok(`网关已启动（pid ${pid}，端口 ${usedPort}）。`);
    process.stdout.write(`  ${c.gray('WorkBuddy 侧地址')} http://127.0.0.1:${usedPort}/v1/chat/completions\n`);
    process.stdout.write(`  ${c.gray('查看路由')} wb-switch gateway routes\n`);
    return 0;
  } catch (err) {
    fail((err as Error).message);
    return 1;
  }
}

async function cmdStop(_args: Args, root: string): Promise<number> {
  const result = await stopDaemon(root);
  if (result.stopped) {
    ok(result.detail);
    return 0;
  }
  warn(result.detail);
  return 0;
}

async function cmdRestart(args: Args, root: string): Promise<number> {
  await stopDaemon(root);
  return cmdStart(args, root);
}

// ─────────────────────────── run（前台） ───────────────────────────

async function cmdRun(args: Args, root: string): Promise<number> {
  const routes = readRoutes(root);
  const portEnv = process.env.WB_GATEWAY_PORT;
  const portFlag = str(args, 'port') ? Number.parseInt(str(args, 'port')!, 10) : undefined;
  const port = portFlag ?? (portEnv ? Number.parseInt(portEnv, 10) : undefined) ?? routes.port;

  if (routes.routes.length === 0) {
    fail('路由表为空：先执行 wb-switch gateway route add 配置路由。');
    return 1;
  }
  const server = await startGatewayServer({ root, port });
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  // 守护模式下保持运行
  await new Promise(() => {});
  return 0;
}

// ─────────────────────────── routes ───────────────────────────

function cmdRoutes(args: Args, root: string): number {
  // route add / route remove 走这里
  const action = args.positional[2];
  if (action === 'add') return cmdRouteAdd(args, root);
  if (action === 'remove' || action === 'rm' || action === 'delete') return cmdRouteRemove(args, root);

  const file = readRoutes(root);
  if (file.routes.length === 0) {
    warn('路由表为空。');
    process.stdout.write(`  ${c.gray('添加：')} wb-switch gateway route add <别名> --profile <源> --model <模型ID> [--profile2 <源> --model2 <模型ID>]\n`);
    return 0;
  }
  if (has(args, 'json')) {
    jsonOut(file);
    return 0;
  }
  heading(`路由表（${file.routes.length} 条 · 端口 ${file.port}）`);
  for (const r of file.routes) {
    process.stdout.write(`  ${c.bold(c.cyan(r.alias))}\n`);
    r.backends.forEach((b, i) => {
      const mark = i === 0 ? c.green('①') : c.gray(String(i + 1));
      process.stdout.write(`    ${mark} ${b.profile}${c.gray('/')}${b.model}\n`);
    });
  }
  process.stdout.write(`\n${c.gray('位置')} ${routesFile(root)}\n`);
  return 0;
}

function cmdRouteAdd(args: Args, root: string): number {
  const alias = args.positional[3];
  if (!alias) {
    fail('用法：wb-switch gateway route add <别名> --profile <源> --model <模型ID> [--profile2 <源> --model2 <模型ID>]');
    return 2;
  }
  validateAlias(alias);

  // 支持多组后端：--profile/--model、--profile2/--model2、--profile3/--model3
  const backends: RouteBackend[] = [];
  const groups: { profile?: string; model?: string }[] = [
    { profile: str(args, 'profile'), model: str(args, 'model') },
  ];
  for (let i = 2; i <= 5; i++) {
    const p = str(args, `profile${i}`);
    const m = str(args, `model${i}`);
    if (p || m) groups.push({ profile: p, model: m });
  }
  for (const g of groups) {
    if (!g.profile || !g.model) {
      fail(`后端需要成对提供 --profile <源> 与 --model <模型ID>（收到 profile=${g.profile ?? '无'} model=${g.model ?? '无'}）。`);
      return 2;
    }
    backends.push({ profile: g.profile, model: g.model });
  }

  // 立即校验引用是否有效（源存在、模型存在）
  const resolved = resolveBackends(root, backends);
  const bad = resolved.filter(b => b.error);
  if (bad.length > 0) {
    fail('后端引用无效：');
    for (const b of bad) process.stderr.write(`  ${c.gray('!')} ${b.profile}/${b.model}：${b.error}\n`);
    return 1;
  }

  try {
    addRoute(root, alias, backends, { force: has(args, 'force') });
  } catch (err) {
    fail((err as Error).message);
    return 1;
  }
  if (has(args, 'json')) {
    jsonOut({ added: alias, backends });
    return 0;
  }
  ok(`已添加路由 ${c.bold(c.cyan(alias))}（${backends.length} 个后端）。`);
  for (const b of backends) process.stdout.write(`  ${c.gray('→')} ${b.profile}/${b.model}\n`);
  process.stdout.write(`\n${c.gray('生效需重启网关：')} wb-switch gateway restart\n`);
  return 0;
}

function cmdRouteRemove(args: Args, root: string): number {
  const alias = args.positional[3];
  if (!alias) {
    fail('用法：wb-switch gateway route remove <别名>');
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

// ─────────────────────────── lint ───────────────────────────

function cmdLint(args: Args, root: string): number {
  const problems = lintRoutes(root);
  if (has(args, 'json')) {
    jsonOut({ ok: problems.length === 0, problems });
    return problems.length ? 1 : 0;
  }
  if (problems.length === 0) {
    const file = readRoutes(root);
    ok(`路由表全部有效（${file.routes.length} 条）。`);
    return 0;
  }
  warn(`发现 ${problems.length} 条路由有问题：`);
  for (const p of problems) {
    process.stdout.write(`  ${c.red('!')} ${p.alias}\n`);
    for (const e of p.problems) process.stdout.write(`      ${c.gray(e)}\n`);
  }
  return 1;
}

// ─────────────────────────── bind ───────────────────────────

async function cmdBind(args: Args, root: string): Promise<number> {
  const file = readRoutes(root);
  if (file.routes.length === 0) {
    fail('路由表为空，无法生成网关源。先 gateway route add 添加路由。');
    return 1;
  }
  const name = args.positional[2] ?? 'gateway';
  if (profileExists(root, name) && !has(args, 'force')) {
    fail(`源「${name}」已存在。换名或加 --force 覆盖。`);
    return 1;
  }

  const models = buildGatewayModels(file, file.port);
  saveProfile(root, {
    name,
    description: `wb-gateway 路由源（${file.routes.length} 条别名 · 127.0.0.1:${file.port}）`,
    origin: { type: 'manual', createdAt: new Date().toISOString() },
    models,
  });

  if (!has(args, 'no-switch')) {
    const result = switchTo(name, { configDir: root });
    if (has(args, 'json')) {
      jsonOut({ bound: name, models: models.length, active: result.platform.active });
      return 0;
    }
    ok(`已生成并切换到网关源「${name}」（${models.length} 个别名 → http://127.0.0.1:${file.port}）。`);
    process.stdout.write(`  ${c.gray('提示')} WorkBuddy 会缓存模型配置，重新打开对话或重启后生效。\n`);
    return 0;
  }

  if (has(args, 'json')) {
    jsonOut({ bound: name, models: models.length });
    return 0;
  }
  ok(`已生成网关源「${name}」（${models.length} 个别名）。用 wb-switch use ${name} 切换。`);
  return 0;
}

// ─────────────────────────── logs ───────────────────────────

function cmdLogs(args: Args, root: string): number {
  const logFile = path.join(gatewayLogDir(root), 'gateway.log');
  const lines = str(args, 'lines') ? Number.parseInt(str(args, 'lines')!, 10) : 30;
  if (!fs.existsSync(logFile)) {
    warn(`还没有日志：${logFile}`);
    return 0;
  }
  const content = fs.readFileSync(logFile, 'utf8').trimEnd().split('\n');
  const tail = content.slice(-Math.max(1, lines));
  for (const line of tail) {
    try {
      const e = JSON.parse(line) as {
        ts: string; alias: string; backend: string; status: number; ms: number; bytes: number; failed?: string;
      };
      const time = e.ts.slice(11, 19);
      const stat = e.failed ? c.red(`FAIL(${e.failed})`) : c.green(String(e.status));
      const size = e.bytes > 1024 ? `${(e.bytes / 1024).toFixed(1)}KB` : `${e.bytes}B`;
      process.stdout.write(`${c.gray(time)} ${c.cyan(e.alias)} → ${e.backend} ${stat} ${c.gray(`${e.ms}ms ${size}`)}\n`);
    } catch {
      process.stdout.write(line + '\n');
    }
  }
  process.stdout.write(`\n${c.gray('日志文件')} ${logFile}\n`);
  return 0;
}

// ─────────────────────────── install / uninstall（launchd） ───────────────────────────

function cmdInstall(args: Args, root: string): number {
  if (process.platform !== 'darwin') {
    fail('开机自启目前只支持 macOS（launchd）。Windows 请用任务计划程序，Linux 用 systemd。');
    return 1;
  }
  const routes = readRoutes(root);
  const port = str(args, 'port') ? Number.parseInt(str(args, 'port')!, 10) : routes.port;
  const plist = writeLaunchdPlist(root, port);
  // 加载并立即启动
  const r = spawn('launchctl', ['unload', plist], { stdio: 'ignore' });
  r.on('close', () => {
    const r2 = spawn('launchctl', ['load', '-w', plist], { stdio: 'ignore' });
    r2.on('close', () => {
      ok(`已安装 launchd 开机自启并启动网关。`);
      process.stdout.write(`  ${c.gray('plist')} ${plist}\n`);
      process.stdout.write(`  ${c.gray('端口')} ${port}\n`);
      process.stdout.write(`  ${c.gray('卸载')} wb-switch gateway uninstall\n`);
    });
  });
  return 0;
}

async function cmdUninstall(_args: Args, root: string): Promise<number> {
  if (process.platform !== 'darwin') {
    fail('仅支持 macOS。');
    return 1;
  }
  const plist = launchdPlistPath();
  if (!fs.existsSync(plist)) {
    warn('未安装 launchd 自启。');
    return 0;
  }
  await new Promise<void>(resolve => {
    const r = spawn('launchctl', ['unload', '-w', plist], { stdio: 'ignore' });
    r.on('close', () => resolve());
    r.on('error', () => resolve());
  });
  removeLaunchdPlist();
  await stopDaemon(root);
  ok('已卸载 launchd 自启并停止网关。');
  return 0;
}

/**
 * 网关守护进程管理：start / stop / status + launchd 开机自启（macOS）。
 *
 * 形态：独立 CLI 子命令（wb-switch gateway start），与 Electron 应用解耦。
 * start = 后台 spawn 一个 `gateway run` 子进程（detached），pid 落盘；
 * stop  = 读 pid 发 SIGTERM，等待退出，清理 pid 文件。
 * launchd = 生成 ~/Library/LaunchAgents/cn.workbuddy.wb-switch.gateway.plist，
 *           开机自启 + 崩溃自动拉起（KeepAlive）。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exists, removeQuietly, writeFileAtomic, ensureDir } from '../fsutil.js';
import { dataDir } from '../paths.js';
import { readRoutes } from './routes.js';

export interface DaemonStatus {
  running: boolean;
  pid: number | null;
  port: number | null;
  /** launchd 是否接管（macOS） */
  launchd: boolean;
  plistPath: string | null;
}

export function pidFile(root: string): string {
  return path.join(dataDir(root), 'gateway.pid');
}

export function readPid(root: string): number | null {
  const file = pidFile(root);
  if (!exists(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** 探测 pid 是否存活 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 对本地端口做一次 HTTP 探活 */
export function pingGateway(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise(resolve => {
    const req = fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(timeoutMs) })
      .then(r => resolve(r.ok))
      .catch(() => resolve(false));
    return req;
  });
}

export function getDaemonStatus(root: string): DaemonStatus {
  const pid = readPid(root);
  const routes = safeReadRoutes(root);
  const launchdInfo = launchdPlistInfo();
  let running = false;
  if (pid !== null && isAlive(pid)) running = true;
  return {
    running,
    pid: running ? pid : null,
    port: routes?.port ?? null,
    launchd: launchdInfo.installed,
    plistPath: launchdInfo.path,
  };
}

function safeReadRoutes(root: string): { port: number } | null {
  try {
    return readRoutes(root);
  } catch {
    return null;
  }
}

/** 后台启动网关：spawn 自身（node dist/cli.js gateway run --daemon） */
export function startDaemon(root: string, options: { port?: number } = {}): { pid: number; port: number } {
  const routes = readRoutes(root);
  if (routes.routes.length === 0) {
    throw new Error('路由表为空：先执行 wb-switch gateway route add 配置路由。');
  }
  const existing = readPid(root);
  if (existing !== null && isAlive(existing)) {
    throw new Error(`网关已在运行（pid ${existing}）。如需重启：wb-switch gateway restart。`);
  }
  const port = options.port ?? routes.port;

  const entry = process.argv[1] ?? '';
  const isCli = entry.endsWith('cli.js') || entry.endsWith('wb-switch');
  const args = isCli
    ? [entry, 'gateway', 'run']
    : [path.join(path.dirname(entry), 'cli.js'), 'gateway', 'run'];

  const out = fs.openSync(path.join(dataDir(root), 'gateway.out.log'), 'a');
  const err = fs.openSync(path.join(dataDir(root), 'gateway.err.log'), 'a');
  ensureDir(dataDir(root));

  const child: ChildProcess = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', out, err],
    env: { ...process.env, WB_GATEWAY_PORT: String(port), WB_CONFIG_DIR: root },
  });
  child.unref();
  fs.closeSync(out);
  fs.closeSync(err);

  const pid = child.pid;
  if (!pid) throw new Error('启动网关进程失败（未取得 pid）。');
  writeFileAtomic(pidFile(root), String(pid));
  return { pid, port };
}

/** 停止网关：优先 pid；launchd 接管时提示用 launchctl */
export async function stopDaemon(root: string): Promise<{ stopped: boolean; detail: string }> {
  const pid = readPid(root);
  if (pid === null) {
    return { stopped: false, detail: '网关未在运行。' };
  }
  if (!isAlive(pid)) {
    removeQuietly(pidFile(root));
    return { stopped: false, detail: `pid ${pid} 已退出，清理了 pid 文件。` };
  }
  process.kill(pid, 'SIGTERM');
  // 最多等 5 秒
  for (let i = 0; i < 50; i++) {
    if (!isAlive(pid)) {
      removeQuietly(pidFile(root));
      return { stopped: true, detail: `已停止 pid ${pid}。` };
    }
    await new Promise(r => setTimeout(r, 100));
  }
  process.kill(pid, 'SIGKILL');
  removeQuietly(pidFile(root));
  return { stopped: true, detail: `pid ${pid} 5 秒未退出，已 SIGKILL。` };
}

// ─────────────────────────── launchd（macOS） ───────────────────────────

const LAUNCHD_LABEL = 'cn.workbuddy.wb-switch.gateway';

export function launchdPlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

export function launchdPlistInfo(): { installed: boolean; path: string } {
  const p = launchdPlistPath();
  return { installed: exists(p), path: p };
}

export function writeLaunchdPlist(root: string, port: number): string {
  const entry = process.argv[1] ?? '';
  const cliJs = entry.endsWith('cli.js') ? entry : path.join(path.dirname(entry), 'cli.js');
  const nodeBin = process.execPath;
  const logDir = path.join(dataDir(root), 'logs');
  ensureDir(logDir);

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodeBin)}</string>
    <string>${escapeXml(cliJs)}</string>
    <string>gateway</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>WB_CONFIG_DIR</key>
    <string>${escapeXml(root)}</string>
    <key>WB_GATEWAY_PORT</key>
    <string>${port}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(dataDir(root), 'gateway.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(dataDir(root), 'gateway.err.log'))}</string>
</dict>
</plist>
`;
  const target = launchdPlistPath();
  ensureDir(path.dirname(target));
  writeFileAtomic(target, plist);
  return target;
}

export function removeLaunchdPlist(): boolean {
  const p = launchdPlistPath();
  if (!exists(p)) return false;
  removeQuietly(p);
  return true;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

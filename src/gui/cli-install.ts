/**
 * CLI / MCP 安装与配置（GUI 与主进程共用）。
 *
 * 背景：
 *   - 打包后的 app.asar 内带 cli/wb-switch（esbuild 单文件、零依赖）；
 *   - app 启动时把它装进 PATH 目录，终端可直接 `wb-switch`；
 *   - 但 MCP 客户端拉子进程时不继承终端 PATH（可能连 node 都找不到），
 *     所以同时写入 `wb-switch-mcp` 启动器（自解析 node），
 *     mcp.json 指向启动器的绝对路径即可稳定连上。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mcpLauncherScript from '../../assets/wb-switch-mcp.sh';

/** CLI / 启动器的候选安装目录（按优先级） */
export function cliTargetDirs(): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.workbuddy/binaries/node/cli-connector-packages/bin'),
    path.join(home, '.workbuddy/bin'),
  ];
}

/** 已存在的第一个候选目录（找不到返回 null） */
export function resolveInstallDir(): string | null {
  const dirs = cliTargetDirs();
  for (const [i, dir] of dirs.entries()) {
    try {
      // 首选目录必须已存在（避免凭空造一个 PATH 外的目录）；兜底目录允许创建
      if (i === 0 && !fs.existsSync(dir)) continue;
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      /* 不可写，试下一个 */
    }
  }
  return null;
}

/** 写入 MCP 启动器（内容随包内置，幂等） */
export function writeMcpLauncher(dir: string): string | null {
  if (process.platform === 'win32') return null; // Windows 直接跑 wb-switch.cmd
  try {
    const dest = path.join(dir, 'wb-switch-mcp');
    const content = Buffer.from(mcpLauncherScript, 'utf8');
    try {
      if (fs.readFileSync(dest).equals(content)) return dest;
    } catch {
      /* 不存在，继续写 */
    }
    fs.writeFileSync(dest, content);
    fs.chmodSync(dest, 0o755);
    return dest;
  } catch {
    return null;
  }
}

/** 把内置 CLI 单文件装进 PATH 目录（幂等），返回安装路径 */
export function installCliFromBundle(bundlePath: string): string | null {
  try {
    if (!fs.existsSync(bundlePath)) return null;
    const dir = resolveInstallDir();
    if (!dir) return null;
    const dest = path.join(dir, 'wb-switch');
    const content = fs.readFileSync(bundlePath);
    let same = false;
    try {
      same = fs.readFileSync(dest).equals(content);
    } catch {
      /* 不存在 */
    }
    if (!same) {
      fs.writeFileSync(dest, content);
      fs.chmodSync(dest, 0o755);
    }
    writeMcpLauncher(dir); // 旧版本可能没装过启动器，每次确保存在
    return dest;
  } catch {
    return null;
  }
}

// ───────────────────────────── MCP 配置 ─────────────────────────────

const MCP_SERVER_NAME = 'wb-switch-image';

export interface McpStatus {
  serverName: string;
  /** ~/.workbuddy/mcp.json */
  mcpJsonPath: string;
  /** 启动器路径（配置里应指向它） */
  launcherPath: string;
  launcherExists: boolean;
  /** 当前配置里的 command（没配置为 null） */
  configuredCommand: string | null;
  /** 配置指向启动器且文件存在 */
  ok: boolean;
  /** 一句话状态说明 */
  hint: string;
}

function mcpJsonPath(): string {
  return path.join(os.homedir(), '.workbuddy', 'mcp.json');
}

function launcherPathFor(dir: string): string {
  return path.join(dir, 'wb-switch-mcp');
}

function readMcpJson(): Record<string, unknown> {
  const p = mcpJsonPath();
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/** 读取 MCP 接入状态（不修改任何文件） */
export function getMcpStatus(): McpStatus {
  const dir = resolveInstallDir() ?? cliTargetDirs()[0] ?? path.join(os.homedir(), '.workbuddy/bin');
  const launcherPath = launcherPathFor(dir);
  const launcherExists = fs.existsSync(launcherPath);
  const json = readMcpJson();
  const servers = (json.mcpServers ?? {}) as Record<string, { command?: string }>;
  const configuredCommand = servers[MCP_SERVER_NAME]?.command ?? null;
  const ok = launcherExists && configuredCommand === launcherPath;

  let hint: string;
  if (!launcherExists) hint = '启动器尚未安装：点击「写入 MCP 配置」自动补齐';
  else if (!configuredCommand) hint = 'mcp.json 里还没有 wb-switch-image，点击写入即可';
  else if (!ok) hint = 'mcp.json 指向的路径与当前安装位置不一致，点击写入可修正';
  else hint = '配置正确，MCP 客户端重启后即可调用';

  return {
    serverName: MCP_SERVER_NAME,
    mcpJsonPath: mcpJsonPath(),
    launcherPath,
    launcherExists,
    configuredCommand,
    ok,
    hint,
  };
}

/** 写入 / 修复 MCP 配置（合并其它 server，不覆盖） */
export function installMcpConfig(): McpStatus {
  const dir = resolveInstallDir();
  if (!dir) {
    const st = getMcpStatus();
    return { ...st, ok: false, hint: '找不到可写目录，无法安装启动器' };
  }
  writeMcpLauncher(dir);

  const p = mcpJsonPath();
  const json = readMcpJson();
  const servers = (json.mcpServers ?? {}) as Record<string, unknown>;
  servers[MCP_SERVER_NAME] = {
    command: launcherPathFor(dir),
    args: ['mcp'],
  };
  json.mcpServers = servers;

  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
  return getMcpStatus();
}

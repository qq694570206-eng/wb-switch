/**
 * 路径解析。
 *
 * 关键点（Windows）：
 *  - 默认配置根目录为 %USERPROFILE%\.workbuddy（即 C:\Users\<user>\.workbuddy）
 *  - 支持通过环境变量覆盖，便于测试与多实例：
 *      WB_CONFIG_DIR   —— 直接指定 WorkBuddy 配置目录（最高优先级）
 *      WORKBUDDY_HOME  —— 同上，兼容旧写法
 *  - 本工具自身的数据放在 <configRoot>\wb-switch\ 下，不改动 WorkBuddy 的其它文件
 */

import os from 'node:os';
import path from 'node:path';

/** WorkBuddy 配置根目录 */
export function resolveConfigRoot(): string {
  const fromEnv =
    process.env.WB_CONFIG_DIR?.trim() ||
    process.env.WORKBUDDY_HOME?.trim() ||
    process.env.WORKBUDDY_CONFIG_DIR?.trim();

  if (fromEnv) return path.resolve(expandHome(fromEnv));
  return path.join(os.homedir(), '.workbuddy');
}

/** 展开路径中的 ~ 与 %VAR%（Windows） */
export function expandHome(input: string): string {
  let p = input;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    p = path.join(os.homedir(), p.slice(2));
  }
  // Windows 的 %USERPROFILE% 形式（bash 下不会被展开，这里补上）
  p = p.replace(/%([^%]+)%/g, (_m, name: string) => process.env[name] ?? `%${name}%`);
  return p;
}

/** 受管的模型配置文件 */
export function modelsFile(root = resolveConfigRoot()): string {
  return path.join(root, 'models.json');
}

/** 本工具的数据目录 */
export function dataDir(root = resolveConfigRoot()): string {
  return path.join(root, 'wb-switch');
}

/** 源快照目录 */
export function profilesDir(root = resolveConfigRoot()): string {
  return path.join(dataDir(root), 'profiles');
}

/** 备份目录 */
export function backupsDir(root = resolveConfigRoot()): string {
  return path.join(dataDir(root), 'backups');
}

/** 激活状态文件 */
export function stateFile(root = resolveConfigRoot()): string {
  return path.join(dataDir(root), 'state.json');
}

/** 把任意字符串安全化为合法的 Windows 文件名 */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_') // Windows 非法字符
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '_')
    .replace(/[. ]+$/, '');
  // Windows 保留设备名
  const reserved =
    /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(cleaned) ? `_${cleaned}` : cleaned;
  return reserved || '_';
}

/**
 * 路径解析（多目标工具版）。
 *
 * wb-switch 现在是「通用模型切换工具」，同时管理多个目标工具
 * （WorkBuddy / Codex / …）。目录布局：
 *
 *   ~/.wb-switch/                     ← 工具自己的家（WB_SWITCH_HOME 可覆盖）
 *     current-target.json             ← 当前选中的目标工具
 *     settings.json                   ← 全局设置
 *     targets/
 *       workbuddy/
 *         profiles/                   ← 该工具的源快照
 *         backups/                    ← 该工具的备份
 *         state.json                  ← 该工具的激活状态
 *       codex/…
 *     gateway/                        ← 网关（多个 target 共享）
 *       routes.json
 *
 * 与旧版的关系：
 *   旧数据在 <WorkBuddy配置根>/wb-switch/ ，首次运行会自动迁移到
 *   ~/.wb-switch/targets/workbuddy/ ，源与组合一个都不丢。
 *
 * 兼容性：所有函数仍接受 root 参数（WorkBuddy 配置根），
 * target 由 setActiveTarget() 指定的模块级状态决定，
 * 这样 56 处调用点无需改动。
 */

import os from 'node:os';
import path from 'node:path';

/** 当前生效的 target id（由 CLI/GUI 启动时 setActiveTarget 设置） */
let activeTargetId = 'workbuddy';

/** 设置当前 target（影响 dataDir 系列函数的落点） */
export function setActiveTarget(id: string): void {
  activeTargetId = id || 'workbuddy';
}

/** 读取当前 target id */
export function getActiveTargetId(): string {
  return activeTargetId;
}

/** 工具自己的家目录 */
export function wbSwitchHome(): string {
  const fromEnv = process.env.WB_SWITCH_HOME?.trim();
  if (fromEnv) return path.resolve(expandHome(fromEnv));
  return path.join(os.homedir(), '.wb-switch');
}

/** WorkBuddy 配置根目录（被管理的文件所在处，不是本工具的数据） */
export function resolveConfigRoot(): string {
  const fromEnv =
    process.env.WB_CONFIG_DIR?.trim() ||
    process.env.WORKBUDDY_HOME?.trim() ||
    process.env.WORKBUDDY_CONFIG_DIR?.trim();

  if (fromEnv) return path.resolve(expandHome(fromEnv));
  return path.join(os.homedir(), '.workbuddy');
}

/** 展开路径中的 ~ 与 %VAR% */
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

/** 受管的模型配置文件（WorkBuddy 的 models.json；其它 target 见各自适配器） */
export function modelsFile(root = resolveConfigRoot()): string {
  return path.join(root, 'models.json');
}

/**
 * 某个 target 的数据目录。
 * root 参数保留是为了兼容旧调用点（旧版此函数返回 <root>/wb-switch）。
 */
export function dataDir(_root = resolveConfigRoot()): string {
  return path.join(wbSwitchHome(), 'targets', activeTargetId);
}

/** 所有 target 的数据根 */
export function targetsDataRoot(): string {
  return path.join(wbSwitchHome(), 'targets');
}

/** 网关共享数据目录（跨 target） */
export function gatewayDataDir(): string {
  return path.join(wbSwitchHome(), 'gateway');
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

/** 用户偏好设置（全局，不分 target） */
export function settingsFile(_root = resolveConfigRoot()): string {
  return path.join(wbSwitchHome(), 'settings.json');
}

/**
 * 回滚快照目录。
 *
 * 与 backups/ 区别：这里只放「写入失败时用来还原」的临时副本，切换成功即删除，
 * 不参与 backups / restore 的历史列表。
 */
export function rollbackDir(root = resolveConfigRoot()): string {
  return path.join(dataDir(root), '.rollback');
}

/** 旧版数据目录（<WorkBuddy根>/wb-switch），用于一次性迁移 */
export function legacyDataDir(root = resolveConfigRoot()): string {
  return path.join(root, 'wb-switch');
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

/**
 * 旧数据迁移：<WorkBuddy根>/wb-switch/  →  ~/.wb-switch/targets/workbuddy/
 *
 * 触发时机：任何命令启动时（ensureMigration）。规则：
 *  - 旧目录不存在 → 跳过
 *  - 增量为王：只复制新目录里**还没有**的文件，绝不覆盖已有内容
 *    （这样用户在新目录里改过的源不会被旧数据回滚，也能补齐漏迁的文件）
 *  - 迁移后旧目录保留不删（用户可自行清理，或回滚）
 */

import fs from 'node:fs';
import path from 'node:path';
import { dataDir, gatewayDataDir, legacyDataDir, resolveConfigRoot, wbSwitchHome } from './paths.js';

export interface MigrationReport {
  /** 是否执行了迁移 */
  migrated: boolean;
  /** 迁移的条目描述（用于提示用户） */
  items: string[];
  /** 旧目录 */
  from: string;
  /** 新目录 */
  to: string;
  /** 跳过原因 */
  skipped?: string;
}

/** 递归复制目录（只补缺失文件，不覆盖） */
function copyDirIfMissing(from: string, to: string): number {
  if (!fs.existsSync(from)) return 0;
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      n += copyDirIfMissing(src, dst);
    } else if (!fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
      n++;
    }
  }
  return n;
}

/** 执行一次迁移检查（幂等 + 增量补齐） */
export function ensureMigration(root = resolveConfigRoot()): MigrationReport {
  const from = legacyDataDir(root);
  const home = wbSwitchHome();
  const to = dataDir(root); // 注意：此时 activeTarget 应为 workbuddy

  const report: MigrationReport = { migrated: false, items: [], from, to };

  if (!fs.existsSync(from)) {
    report.skipped = '旧目录不存在';
    return report;
  }

  fs.mkdirSync(home, { recursive: true });

  // 1) profiles（只补缺失）
  const nProfiles = copyDirIfMissing(path.join(from, 'profiles'), path.join(to, 'profiles'));
  if (nProfiles) report.items.push(`源快照 ${nProfiles} 个`);

  // 2) backups（只补缺失）
  const nBackups = copyDirIfMissing(path.join(from, 'backups'), path.join(to, 'backups'));
  if (nBackups) report.items.push(`备份 ${nBackups} 个`);

  // 3) state.json
  const oldState = path.join(from, 'state.json');
  const newState = path.join(to, 'state.json');
  if (fs.existsSync(oldState) && !fs.existsSync(newState)) {
    fs.copyFileSync(oldState, newState);
    report.items.push('激活状态');
  }

  // 4) 网关数据（routes.json / health.json 等）：迁到共享目录
  const gwTo = gatewayDataDir();
  for (const f of ['routes.json', 'health.json']) {
    const src = path.join(from, f);
    const dst = path.join(gwTo, f);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      fs.mkdirSync(gwTo, { recursive: true });
      fs.copyFileSync(src, dst);
      if (!report.items.includes('网关路由')) report.items.push('网关路由');
    }
  }

  report.migrated = report.items.length > 0;
  if (!report.migrated) report.skipped = '旧目录没有可迁移的数据';
  return report;
}

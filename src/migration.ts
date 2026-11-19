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
import { dataDir, gatewayDataDir, legacyDataDir, resolveConfigRoot, targetsDataRoot, wbSwitchHome } from './paths.js';

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

  // 4) settings.json（全局设置，不分 target）
  const oldSettings = path.join(from, 'settings.json');
  const newSettings = path.join(home, 'settings.json');
  if (fs.existsSync(oldSettings) && !fs.existsSync(newSettings)) {
    fs.copyFileSync(oldSettings, newSettings);
    report.items.push('偏好设置');
  }

  // 5) 网关数据：路由/健康/日志都放共享目录（网关跨 target）
  const gwTo = gatewayDataDir();
  fs.mkdirSync(gwTo, { recursive: true });
  for (const f of ['routes.json', 'health.json', 'gateway.out.log', 'gateway.err.log']) {
    const src = path.join(from, f);
    const dst = path.join(gwTo, f);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
      if (!report.items.includes('网关数据')) report.items.push('网关数据');
    }
  }
  // 历史请求日志：合并进共享 logs（追加，不覆盖）
  const oldLog = path.join(from, 'logs', 'gateway.log');
  const newLog = path.join(gwTo, 'logs', 'gateway.log');
  if (fs.existsSync(oldLog)) {
    try {
      fs.mkdirSync(path.dirname(newLog), { recursive: true });
      if (!fs.existsSync(newLog)) {
        fs.copyFileSync(oldLog, newLog);
        if (!report.items.includes('网关数据')) report.items.push('网关数据');
      } else {
        const add = fs.readFileSync(oldLog, 'utf8');
        const have = fs.readFileSync(newLog, 'utf8');
        // 只补旧文件里新目录还没有的行，避免重复
        const haveLines = new Set(have.split('\n'));
        const extra = add.split('\n').filter((l) => l.trim() && !haveLines.has(l));
        if (extra.length) {
          fs.appendFileSync(newLog, extra.join('\n') + '\n');
          if (!report.items.includes('网关数据')) report.items.push('网关数据');
        }
      }
    } catch {
      /* 日志迁移失败不影响主流程 */
    }
  }

  // 6) MCP 图片（旧版存在 <根>/wb-switch/images）
  const nImages = copyDirIfMissing(path.join(from, 'images'), path.join(to, 'images'));
  if (nImages) report.items.push(`图片 ${nImages} 个`);

  // 7) 各 target 目录里误放的网关文件（早期版本曾按 target 分开放）
  cleanStrayGatewayFiles(report);

  report.migrated = report.items.length > 0;
  if (!report.migrated) report.skipped = '旧目录没有可迁移的数据';
  return report;
}

/**
 * 清理「按 target 误放」的网关文件。
 *
 * 网关是跨 target 共享的，pid/日志一度被写进 targets/<id>/ 下，
 * 导致同一份网关状态出现多份。这里把它们归并到共享目录后删掉。
 */
function cleanStrayGatewayFiles(report: MigrationReport): void {
  const targetsRoot = targetsDataRoot();
  if (!fs.existsSync(targetsRoot)) return;
  const gwTo = gatewayDataDir();
  let cleaned = 0;
  for (const entry of fs.readdirSync(targetsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(targetsRoot, entry.name);
    for (const f of ['gateway.pid', 'gateway.out.log', 'gateway.err.log']) {
      const p = path.join(dir, f);
      if (!fs.existsSync(p)) continue;
      try {
        // pid 文件只保留共享目录那份（正在运行的网关写在那里）
        fs.rmSync(p);
        cleaned++;
      } catch {
        /* 占用中就先留着 */
      }
    }
    // target 内的 logs/ 目录也归并到共享 logs
    const tLog = path.join(dir, 'logs', 'gateway.log');
    if (fs.existsSync(tLog)) {
      try {
        const shared = path.join(gwTo, 'logs', 'gateway.log');
        fs.mkdirSync(path.dirname(shared), { recursive: true });
        const add = fs.readFileSync(tLog, 'utf8');
        const have = fs.existsSync(shared) ? fs.readFileSync(shared, 'utf8') : '';
        const haveLines = new Set(have.split('\n'));
        const extra = add.split('\n').filter((l) => l.trim() && !haveLines.has(l));
        if (extra.length) fs.appendFileSync(shared, extra.join('\n') + '\n');
        fs.rmSync(path.join(dir, 'logs'), { recursive: true, force: true });
        cleaned++;
      } catch {
        /* 忽略 */
      }
    }
  }
  if (cleaned) report.items.push(`归并网关文件 ${cleaned} 处`);
}

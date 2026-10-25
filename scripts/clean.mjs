/**
 * 清理构建产物，只保留可交付的 exe 和源码。
 *
 * 默认清理：
 *   build/                 中间产物（bundle、SEA blob、截图）
 *   dist/                  tsc 编译输出（CLI 版，可重新 npm run build）
 *   dist-exe/              命令行版 exe（可重新 npm run build:exe）
 *   dist-app/win-unpacked/ 解压版目录（可重新 npm run build:portable）
 *   dist-app/builder-debug.yml
 *   release/               历史遗留目录
 *
 * 保留：dist-app/*-portable.exe（成品）、assets/、src/、docs/、node_modules/
 *
 * 用法：
 *   node scripts/clean.mjs            # 清产物
 *   node scripts/clean.mjs --all      # 连 node_modules 一起清（下次构建需重新 npm install）
 *   node scripts/clean.mjs --dry-run  # 只报告将删除什么
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const all = argv.includes('--all');

const targets = [
  'build',
  'dist',
  'dist-exe',
  path.join('dist-app', 'win-unpacked'),
  'release',
  path.join('dist-app', 'builder-debug.yml'),
];

if (all) targets.push('node_modules');

function sizeOf(p) {
  try {
    const st = fs.lstatSync(p);
    if (!st.isDirectory()) return st.size;
    let total = 0;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      total += sizeOf(path.join(p, e.name));
    }
    return total;
  } catch {
    return 0;
  }
}

function mb(n) {
  return n >= 1024 * 1024 * 1024
    ? `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
    : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

let removed = 0;
for (const rel of targets) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const size = sizeOf(abs);
  if (dryRun) {
    console.log(`  将删除 ${rel.padEnd(26)} ${mb(size)}`);
    removed += size;
    continue;
  }
  try {
    fs.rmSync(abs, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    console.log(`  ✓ 删除 ${rel.padEnd(26)} ${mb(size)}`);
    removed += size;
  } catch (err) {
    console.log(
      `  ! 跳过 ${rel}（${err.code ?? err.message}，被占用）\n` +
        `    常见原因：程序正在运行、杀软正在扫描。关掉程序或重启后再运行一次 npm run clean。`,
    );
  }
}

console.log(
  `\n${dryRun ? '预计释放' : '已释放'} ${mb(removed)}。` +
    (dryRun ? '' : '需要时可用 npm run build / build:portable 重新生成。'),
);

#!/usr/bin/env node
/**
 * install-cli.mjs —— 把 wb-switch CLI 打成自包含单文件并安装进 PATH
 *
 * 产物：一个零依赖、不依赖仓库 node_modules 的单文件可执行脚本，
 *      安装到 PATH 内用户可写目录，供 MCP 等场景直接 `wb-switch` 调用，
 *      免去 mcp.json 里的绝对路径。
 *
 * 用法：node scripts/install-cli.mjs [目标目录]
 *   目标目录默认按序探测（取第一个存在且可写的）：
 *     1. ~/.workbuddy/binaries/node/cli-connector-packages/bin  （WorkBuddy 连接器 bin，在 PATH）
 *     2. ~/.workbuddy/bin                                        （workbuddy 用户 bin）
 *     3. /usr/local/bin                                          （需要 sudo，默认不尝试）
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(repoRoot, 'dist', 'cli.js');
if (!fs.existsSync(entry)) {
  console.error('dist/cli.js 不存在，请先执行 npx tsc');
  process.exit(1);
}

const candidates = [
  path.join(os.homedir(), '.workbuddy/binaries/node/cli-connector-packages/bin'),
  path.join(os.homedir(), '.workbuddy/bin'),
  '/usr/local/bin',
];
const targetDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : candidates.find((d) => {
      try {
        fs.accessSync(d, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    });
if (!targetDir) {
  console.error('未找到可写的安装目录，请手动指定：node scripts/install-cli.mjs <目录>');
  process.exit(1);
}
if (!process.argv[2] && targetDir !== candidates[0]) {
  console.warn(`提示：首选目录不可用，降级安装到 ${targetDir}`);
}

// ── esbuild 自包含打包 ──
const esbuild = path.join(repoRoot, 'node_modules/.bin/esbuild');
const bundled = execFileSync(
  esbuild,
  [
    entry,
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${entry}.bundle.tmp.js`,
    '--log-level=warning',
  ],
  { cwd: repoRoot, encoding: 'utf8' },
);
if (bundled.trim()) console.log(bundled);

const dest = path.join(targetDir, 'wb-switch');
// esbuild 会保留入口的 shebang 并置于首行，单文件可直接执行
fs.copyFileSync(`${entry}.bundle.tmp.js`, dest);
fs.rmSync(`${entry}.bundle.tmp.js`, { force: true });
fs.chmodSync(dest, 0o755);

console.log(`已安装：${dest}`);
// PATH 校验
const inPath = process.env.PATH?.split(path.delimiter).includes(targetDir);
console.log(inPath ? '目标目录已在 PATH 中，可直接运行 wb-switch' : `警告：${targetDir} 不在 PATH 中，请自行加入`);

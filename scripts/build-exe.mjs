#!/usr/bin/env node
/**
 * 把 wb-switch 打包成单文件 Windows exe（内嵌 Node 运行时，目标机器无需安装 Node）。
 *
 * 方案：Node 官方 SEA（Single Executable Application）+ esbuild
 *   1. esbuild 把 src/ 打成单个 CJS bundle
 *   2. node --experimental-sea-config 生成注入用 blob
 *   3. 复制本机 node.exe 作为宿主
 *   4. postject 把 blob 注入宿主 exe
 *   5. resedit 写入图标与版本信息（资源管理器属性页）
 *
 * 相比 pkg 的优势：完全走本机 Node 二进制，无需联网下载运行时，也不会触发
 * 「从源码编译 Node」的失败路径。
 *
 * 用法：
 *   npm run build:exe                 # win-x64（跟随本机 Node）
 *   node scripts/build-exe.mjs --no-icon
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist-exe');
const BUILD_DIR = path.join(ROOT, 'build');
const BUNDLE = path.join(BUILD_DIR, 'wb-switch.cjs');
const BLOB = path.join(BUILD_DIR, 'sea-prep.blob');
const SEA_CONFIG = path.join(BUILD_DIR, 'sea-config.json');
const ICON = path.join(ROOT, 'assets', 'icon.ico');
const EXE = path.join(OUT_DIR, 'wb-switch.exe');

const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const argv = process.argv.slice(2);
const withIcon = !argv.includes('--no-icon');
const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const step = (msg) => console.log(`\n\u001b[36m==> ${msg}\u001b[0m`);
const run = (args, opts = {}) => {
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: ROOT, ...opts });
  if (r.status !== 0) {
    console.error(`\n\u001b[31m失败\u001b[0m ${args.slice(0, 3).join(' ')}…`);
    process.exit(r.status ?? 1);
  }
};

// ── 0. 前置检查 ──
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 20) {
  console.error(`Node 版本过低：${process.version}（SEA 需要 >= 20）`);
  process.exit(1);
}
fs.mkdirSync(BUILD_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

// ── 1. Bundle ──
step('打包 JavaScript（esbuild）');
await build({
  entryPoints: [path.join(ROOT, 'src/cli.ts')],
  bundle: true,
  platform: 'node',
  target: `node${nodeMajor}`,
  format: 'cjs',
  outfile: BUNDLE,
  minify: true,
  legalComments: 'none',
  banner: { js: `/* wb-switch v${pkgJson.version} — WorkBuddy 模型源切换工具 */` },
  logLevel: 'warning',
});
console.log(`   bundle: ${(fs.statSync(BUNDLE).size / 1024).toFixed(0)} KB`);

// ── 2. 生成 SEA blob ──
step('生成 SEA blob');
fs.writeFileSync(
  SEA_CONFIG,
  JSON.stringify(
    {
      main: BUNDLE,
      output: BLOB,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    },
    null,
    2,
  ),
);
run(['--experimental-sea-config', SEA_CONFIG]);
console.log(`   blob: ${(fs.statSync(BLOB).size / 1024).toFixed(0)} KB`);

// ── 3. 复制宿主 exe ──
step('复制 Node 宿主');
fs.rmSync(EXE, { force: true });
fs.copyFileSync(process.execPath, EXE);
console.log(`   宿主: ${process.execPath}`);
console.log(`   版本: ${process.version}`);

// ── 4. 注入 blob ──
step('注入运行时（postject）');
run([
  path.join(ROOT, 'node_modules/postject/dist/cli.js'),
  EXE,
  'NODE_SEA_BLOB',
  BLOB,
  '--sentinel-fuse',
  SEA_FUSE,
]);

// ── 5. 写入图标与版本信息 ──
if (withIcon) {
  step('生成图标并写入资源');
  if (!fs.existsSync(ICON)) run([path.join(__dirname, 'make-icon.mjs'), ICON]);
  run([path.join(__dirname, 'apply-resources.mjs'), EXE, ICON]);
}

// ── 6. 校验 ──
step('校验产物');
const size = fs.statSync(EXE).size;
const ver = spawnSync(EXE, ['--version'], { encoding: 'utf8' });
if (ver.status !== 0) {
  console.error('exe 无法运行：', ver.stderr || ver.stdout);
  process.exit(1);
}
console.log(`   路径: ${EXE}`);
console.log(`   大小: ${(size / 1024 / 1024).toFixed(1)} MB`);
console.log(`   自检: ${ver.stdout.trim()}`);

console.log(`\n\u001b[32m✓ 完成\u001b[0m  ${EXE}`);
console.log(`  双击即可使用；也可在命令行调用：wb-switch.exe <命令>`);
console.log(`  提示：单文件已内嵌 Node ${process.version}，目标机器无需安装 Node。\n`);

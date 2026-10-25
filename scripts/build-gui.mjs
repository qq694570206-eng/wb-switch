/**
 * 构建桌面应用的 app 目录（build/app）。
 *
 * 产物结构：
 *   build/app/
 *     package.json
 *     main.cjs          —— 主进程（esbuild 打包，含全部 core 逻辑）
 *     preload.cjs       —— 预加载脚本
 *     renderer/         —— 界面（HTML/CSS/JS，直接拷贝）
 *     icon.ico          —— 从 assets/icon.ico 复制
 *
 * 之后由 scripts/build-app.mjs 把这个目录装进 Electron 运行时。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'build', 'app');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else fs.copyFileSync(src, dest);
  }
}

console.log('· 清理 build/app');
rmrf(APP);
fs.mkdirSync(APP, { recursive: true });

console.log('· 打包主进程');
await esbuild.build({
  entryPoints: [path.join(ROOT, 'src/gui/main.ts')],
  outfile: path.join(APP, 'main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  sourcemap: false,
  minify: false,
  logLevel: 'warning',
});

console.log('· 打包预加载脚本');
await esbuild.build({
  entryPoints: [path.join(ROOT, 'src/gui/preload.ts')],
  outfile: path.join(APP, 'preload.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  sourcemap: false,
  logLevel: 'warning',
});

console.log('· 拷贝界面资源');
copyDir(path.join(ROOT, 'src/gui/renderer'), path.join(APP, 'renderer'));

const icon = path.join(ROOT, 'assets', 'icon.ico');
if (fs.existsSync(icon)) fs.copyFileSync(icon, path.join(APP, 'icon.ico'));

console.log('· 写入 package.json');
fs.writeFileSync(
  path.join(APP, 'package.json'),
  `${JSON.stringify(
    {
      name: 'wb-switch',
      productName: 'wb-switch',
      version: pkg.version,
      description: 'WorkBuddy 模型源切换工具',
      main: 'main.cjs',
      author: 'wb-switch',
      license: 'MIT',
    },
    null,
    2,
  )}\n`,
  'utf8',
);

const size = (f) => (fs.statSync(f).size / 1024).toFixed(0);
console.log(`✓ 完成：main.cjs ${size(path.join(APP, 'main.cjs'))} KB`);

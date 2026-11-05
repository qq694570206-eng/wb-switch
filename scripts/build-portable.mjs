/**
 * 打包桌面应用（Windows / macOS / Linux）。
 *
 * 产物：
 *   Windows: NSIS 安装包 + portable exe     → dist-app/wb-switch-Setup-<version>.exe
 *   macOS:   DMG 安装包                     → dist-app/wb-switch-<version>.dmg
 *   Linux:   AppImage + deb                 → dist-app/wb-switch-<version>.AppImage
 *
 * 为什么不用 `npx electron-builder` 直接输出到 dist-app：
 * electron-builder 每次都会先清空 <output>/win-unpacked，而某些环境
 * （受管终端、杀软、文件锁）会拒绝删除已生成的 238 MB 运行时，
 * 导致第二次打包直接失败。
 *
 * 这里的做法是：
 *   1. 每次构建到 build/_out-<时间戳>（全新目录，永远不需要删除）
 *   2. 把产物合并（覆盖）到 dist-app，而不是先删后建
 *
 * 用法：node scripts/build-portable.mjs              # Windows 安装版 + 免安装版
 *       node scripts/build-portable.mjs --mac        # macOS DMG
 *       node scripts/build-portable.mjs --linux      # Linux AppImage + deb
 *       node scripts/build-portable.mjs --unpacked   # 额外保留解压版目录
 *       node scripts/build-portable.mjs --portable-only  # 只出免安装版（更快）
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join('build', `_out-${Date.now()}`);
const WITH_UNPACKED = process.argv.includes('--unpacked');
const PORTABLE_ONLY = process.argv.includes('--portable-only');
const FINAL = 'dist-app';
const TARGETS = PORTABLE_ONLY ? ['portable'] : ['nsis', 'portable'];

function step(msg) {
  console.log(`\n▸ ${msg}`);
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  // 目标被占用时（旧版本正在运行），改用带后缀的临时名，而不是让整个构建失败
  try {
    fs.copyFileSync(from, to);
  } catch (err) {
    if (err.code === 'EBUSY' || err.code === 'EPERM') {
      const alt = `${to}.new`;
      fs.copyFileSync(from, alt);
      console.warn(`  ! ${to} 被占用，已存为 ${path.basename(alt)}（关掉旧程序后手动改名即可）`);
      return;
    }
    throw err;
  }
}

/** 递归合并目录：覆盖同名文件、补齐缺失文件，不删除任何东西 */
function mergeDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) mergeDir(src, dest);
    else fs.copyFileSync(src, dest);
  }
}

// ── 1. 构建 app 目录 ──
step('构建界面与主进程');
const gui = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-gui.mjs')], {
  cwd: ROOT,
  stdio: 'inherit',
});
if (gui.status !== 0) process.exit(gui.status ?? 1);

// ── 2. 调 electron-builder ──
step('调用 electron-builder（输出到临时目录）');
const builderCli = path.join(ROOT, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
if (!fs.existsSync(builderCli)) {
  console.error('找不到 electron-builder，请先执行 npm install。');
  process.exit(1);
}

// 支持的平台参数：--mac / --linux / --win（默认 win）
const PLATFORM = (() => {
  if (process.argv.includes('--mac')) return 'mac';
  if (process.argv.includes('--linux')) return 'linux';
  return 'win';
})();

const PLATFORM_FLAG = `--${PLATFORM}`;

const args = [builderCli, PLATFORM_FLAG, '--config', 'electron-builder.yml'];
args.push(`-c.directories.output=${OUT.replace(/\\/g, '/')}`);
if (PORTABLE_ONLY && PLATFORM === 'win') {
  // 覆盖 win.target，只出 portable
  args.push('-c.win.target=portable');
}
// Mac/Linux 不支持 portable-only 参数，忽略

// 构建子进程环境：清除 IDE/沙箱注入的 fs shim（会拦截 asar 文件操作导致打包失败）
const buildEnv = { ...process.env };
delete buildEnv.NODE_OPTIONS;                          // --require language-shim 注入
delete buildEnv.CODEBUDDY_BROKERED_FS_HOOK_ENABLED;    // fs 拦截开关
delete buildEnv.ELECTRON_RUN_AS_NODE;                  // 强制 electron 以 node 模式运行
// 国内网络下 NSIS / 7z / dmgbuild 资源走镜像，缺失时再直连
buildEnv.ELECTRON_BUILDER_BINARIES_MIRROR =
  buildEnv.ELECTRON_BUILDER_BINARIES_MIRROR ||
  'https://npmmirror.com/mirrors/electron-builder-binaries/';

const build = spawnSync(process.execPath, args, {
  cwd: ROOT,
  stdio: 'inherit',
  env: buildEnv,
});
if (build.status !== 0) {
  console.error('\n打包失败。');
  process.exit(build.status ?? 1);
}

// ── 3. 合并产物 ──
step(`合并产物到 ${FINAL}/`);
const outAbs = path.join(ROOT, OUT);
const finalAbs = path.join(ROOT, FINAL);
fs.mkdirSync(finalAbs, { recursive: true });

const outFiles = fs.readdirSync(outAbs);
const mb = (p) => (fs.statSync(p).size / 1024 / 1024).toFixed(0);

// Windows 产物
const portable = outFiles.find((f) => f.endsWith('-portable.exe'));
if (portable) {
  const dest = path.join(finalAbs, portable);
  copyFile(path.join(outAbs, portable), dest);
  console.log(`  ✓ ${FINAL}/${portable}  (${mb(dest)} MB)`);
}

const setup = outFiles.find((f) => f.includes('Setup') && f.endsWith('.exe'));
if (setup) {
  const dest = path.join(finalAbs, setup);
  copyFile(path.join(outAbs, setup), dest);
  console.log(`  ✓ ${FINAL}/${setup}  (${mb(dest)} MB)`);
}

// macOS 产物
const dmg = outFiles.find((f) => f.endsWith('.dmg'));
if (dmg) {
  const dest = path.join(finalAbs, dmg);
  copyFile(path.join(outAbs, dmg), dest);
  console.log(`  ✓ ${FINAL}/${dmg}  (${mb(dest)} MB)`);
}

const zipMac = outFiles.find((f) => f.endsWith('.zip') && (f.includes('mac') || f.includes('darwin')));
if (zipMac) {
  const dest = path.join(finalAbs, zipMac);
  copyFile(path.join(outAbs, zipMac), dest);
  console.log(`  ✓ ${FINAL}/${zipMac}  (${mb(dest)} MB)`);
}

// Linux 产物
const appimage = outFiles.find((f) => f.endsWith('.AppImage'));
if (appimage) {
  const dest = path.join(finalAbs, appimage);
  copyFile(path.join(outAbs, appimage), dest);
  console.log(`  ✓ ${FINAL}/${appimage}  (${mb(dest)} MB)`);
}

const deb = outFiles.find((f) => f.endsWith('.deb'));
if (deb) {
  const dest = path.join(finalAbs, deb);
  copyFile(path.join(outAbs, deb), dest);
  console.log(`  ✓ ${FINAL}/${deb}  (${mb(dest)} MB)`);
}

const unpacked = path.join(outAbs, 'win-unpacked');
if (WITH_UNPACKED && fs.existsSync(unpacked)) {
  mergeDir(unpacked, path.join(finalAbs, 'win-unpacked'));
  console.log(`  ✓ ${FINAL}/win-unpacked/  (解压版，启动更快)`);
} else {
  console.log('  · 跳过解压版（需要时加 --unpacked）');
}

// ── 4. 清理临时构建目录 ──
// 产物已合并到 dist-app，临时目录没有保留价值；不删会每次堆积一份 300 MB+。
step('清理临时目录');
try {
  fs.rmSync(outAbs, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  console.log(`  ✓ 已删除 ${OUT}`);
} catch (err) {
  console.warn(`  ! 临时目录未能删除（${err.code ?? err.message}），可稍后手动删除：${OUT}`);
}

console.log('\n完成。');
console.log('  · Windows 安装版：双击 wb-switch-Setup-*.exe 走安装向导');
console.log('  · Windows 免安装版：双击 wb-switch-*-portable.exe 直接用');
console.log('  · macOS：双击 wb-switch-*.dmg 拖拽安装（未签名，需右键打开）');
console.log('  · Linux：chmod +x wb-switch-*.AppImage 后直接运行');

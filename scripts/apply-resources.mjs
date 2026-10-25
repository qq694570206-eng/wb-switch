#!/usr/bin/env node
/**
 * 给已生成的 exe 写入 Windows 资源：图标 + 版本信息。
 *
 * 用 resedit（纯 JS 的 PE 资源编辑器）实现，不依赖 rcedit 等外部工具。
 * 用法：node scripts/apply-resources.mjs <exe> <ico>
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { NtExecutable, NtExecutableResource, Resource, Data } = require('resedit');

const exePath = process.argv[2];
const icoPath = process.argv[3];
if (!exePath || !fs.existsSync(exePath)) {
  console.error(`找不到 exe：${exePath}`);
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkgJson.version;
const [maj, min, patch] = version.split('.').map((n) => Number.parseInt(n, 10) || 0);

const buf = fs.readFileSync(exePath);
const exe = NtExecutable.from(buf, { ignoreCert: true });
const res = NtExecutableResource.from(exe);

// ── 图标 ──
if (icoPath && fs.existsSync(icoPath)) {
  const iconFile = Data.IconFile.from(fs.readFileSync(icoPath));
  const icons = iconFile.icons.map((i) => i.data);

  const groups = Resource.IconGroupEntry.fromEntries(res.entries);
  if (groups.length > 0) {
    for (const g of groups) {
      Resource.IconGroupEntry.replaceIconsForResource(
        res.entries,
        g.id,
        g.lang,
        icons,
      );
    }
    console.log(`   图标: 替换 ${groups.length} 个图标组（${icons.length} 张）`);
  } else {
    Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, icons);
    console.log(`   图标: 新建图标组（${icons.length} 张）`);
  }
}

// ── 版本信息 ──
// 先删除宿主（node.exe）原有的版本资源，否则会残留两套资源，
// Windows 属性页可能读到旧的那套，出现「版本对但描述为空」。
const VERSION_RESOURCE_TYPE = 16;
for (let i = res.entries.length - 1; i >= 0; i--) {
  if (res.entries[i].type === VERSION_RESOURCE_TYPE) res.entries.splice(i, 1);
}

const vi = Resource.VersionInfo.createEmpty();
// createEmpty() 会带一个 lang=0 的空字符串表，Windows 解析该表会失败，
// 导致属性页的「产品名称/说明」全部为空，因此显式指定语言并移除 0 号表。
vi.lang = 2052; // 以简体中文为主语言，属性页优先显示中文描述
vi.setFileVersion(maj, min, patch, 0, 2052);
vi.setProductVersion(maj, min, patch, 0, 2052);

const strings = {
  CompanyName: 'wb-switch',
  FileDescription: 'WorkBuddy 模型源切换工具',
  FileVersion: `${version}.0`,
  InternalName: 'wb-switch',
  LegalCopyright: 'MIT License',
  OriginalFilename: 'wb-switch.exe',
  ProductName: 'wb-switch',
  ProductVersion: `${version}.0`,
  Comments: '在多个模型源（API 网关）之间切换 WorkBuddy 的 models.json',
};

const LANGS = [
  { lang: 2052, codepage: 1200 }, // zh-CN（主）
  { lang: 1033, codepage: 1200 }, // en-US
];
for (const l of LANGS) vi.setStringValues(l, strings, true);
vi.removeAllStringValues({ lang: 0, codepage: 1200 }, true);
vi.replaceAvailableLanguages(LANGS);

vi.outputToResourceEntries(res.entries);

res.outputResource(exe);
fs.writeFileSync(exePath, Buffer.from(exe.generate()));
console.log(`   版本: ${version} · 资源写入完成`);

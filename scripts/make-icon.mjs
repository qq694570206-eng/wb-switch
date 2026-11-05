#!/usr/bin/env node
/**
 * 生成 wb-switch 图标（512×512，PNG + ICO）。
 * 纯 Node 实现：手写像素缓冲 → PNG（zlib）→ ICO 容器。
 *
 * macOS 需要 ≥512×512 的图标用于 .icns 生成。
 * Windows ICO 内嵌 256×256 PNG（Vista+ 支持），同时保留 512×512 PNG 源文件。
 *
 * 图形：深色圆角方块 + 藍白双向箭头（表示「切换」）。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const S = 512; // 画布尺寸（满足 macOS ≥512 要求）

// ── 画布 ──
const buf = Buffer.alloc(S * S * 4); // RGBA

const setPx = (x, y, [r, g, b], a = 255) => {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  const srcA = a / 255;
  const dstA = buf[i + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA === 0) return;
  buf[i] = Math.round((r * srcA + buf[i] * dstA * (1 - srcA)) / outA);
  buf[i + 1] = Math.round((g * srcA + buf[i + 1] * dstA * (1 - srcA)) / outA);
  buf[i + 2] = Math.round((b * srcA + buf[i + 2] * dstA * (1 - srcA)) / outA);
  buf[i + 3] = Math.round(outA * 255);
};

/** 圆角矩形（含抗锯齿的简单距离场） */
const roundRect = (x0, y0, w, h, r, color, alpha = 255) => {
  const x1 = x0 + w;
  const y1 = y0 + h;
  for (let y = Math.floor(y0) - 1; y <= Math.ceil(y1) + 1; y++) {
    for (let x = Math.floor(x0) - 1; x <= Math.ceil(x1) + 1; x++) {
      const cx = Math.min(Math.max(x + 0.5, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y + 0.5, y0 + r), y1 - r);
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - r;
      const cov = Math.min(1, Math.max(0, 0.5 - d));
      if (cov > 0) setPx(x, y, color, Math.round(alpha * cov));
    }
  }
};

/** 三角形（箭头头部），按重心坐标判断内外 */
const triangle = (p1, p2, p3, color, alpha = 255) => {
  const minX = Math.floor(Math.min(p1[0], p2[0], p3[0])) - 1;
  const maxX = Math.ceil(Math.max(p1[0], p2[0], p3[0])) + 1;
  const minY = Math.floor(Math.min(p1[1], p2[1], p3[1])) - 1;
  const maxY = Math.ceil(Math.max(p1[1], p2[1], p3[1])) + 1;
  const sign = (a, b, c) => (a[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (a[1] - c[1]);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const p = [x + 0.5, y + 0.5];
      const d1 = sign(p, p1, p2);
      const d2 = sign(p, p2, p3);
      const d3 = sign(p, p3, p1);
      const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
      const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
      if (!(hasNeg && hasPos)) setPx(x, y, color, alpha);
    }
  }
};

// ── 绘制（坐标 = 原图 × 2）──
const BG = [23, 32, 45]; // #17202D 深蓝灰
const BG2 = [30, 42, 58]; // 轻微渐变提亮
const TOP = [147, 197, 253]; // #93C5FD 浅蓝（上箭头）
const BOT = [96, 165, 250]; // #60A5FA 蓝（下箭头）

// 背景圆角方块
roundRect(16, 16, S - 32, S - 32, 112, BG);
// 顶部渐变条（简单叠加）
for (let y = 16; y < 264; y++) {
  const a = Math.round(((264 - y) / 248) * 26);
  roundRect(16, y, S - 32, 2.4, 0, BG2, a);
}
// 边框
roundRect(16, 16, S - 32, S - 32, 112, [59, 130, 246], 70);

// 上箭头：右向（浅蓝）
roundRect(112, 184, 216, 44, 22, TOP);
triangle([328, 152], [328, 260], [408, 206], TOP);

// 下箭头：左向（蓝）
roundRect(184, 288, 216, 44, 22, BOT);
triangle([184, 256], [184, 364], [104, 310], BOT);

// ── PNG 编码 ──
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc32 = (b) => {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
};

const encodePng = (size, srcBuf) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // 每行前置 filter byte 0
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    srcBuf.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

// 512×512 PNG（供 macOS .icns 生成用）
const png512 = encodePng(S, buf);

// 256×256 PNG（嵌入 ICO，Windows Vista+ 用）
// 通过最近邻降采样
const S256 = 256;
const buf256 = Buffer.alloc(S256 * S256 * 4);
for (let y = 0; y < S256; y++) {
  for (let x = 0; x < S256; x++) {
    const sx = Math.floor(x * S / S256);
    const sy = Math.floor(y * S / S256);
    const si = (sy * S + sx) * 4;
    const di = (y * S256 + x) * 4;
    buf256[di] = buf[si];
    buf256[di + 1] = buf[si + 1];
    buf256[di + 2] = buf[si + 2];
    buf256[di + 3] = buf[si + 3];
  }
}
const png256 = encodePng(S256, buf256);

// ── ICO 容器（单张 256×256 PNG）──
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(1, 4); // count

const entry = Buffer.alloc(16);
entry[0] = 0; // width 256
entry[1] = 0; // height 256
entry[2] = 0; // palette
entry[3] = 0; // reserved
entry.writeUInt16LE(1, 4); // planes
entry.writeUInt16LE(32, 6); // bpp
entry.writeUInt32LE(png256.length, 8);
entry.writeUInt32LE(6 + 16, 12); // offset

const ico = Buffer.concat([header, entry, png256]);

// ── 写出文件 ──
const assetsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
fs.mkdirSync(assetsDir, { recursive: true });

// icon.png — 512×512，供 macOS 用
const pngPath = path.join(assetsDir, 'icon.png');
fs.writeFileSync(pngPath, png512);
console.log(`PNG 已生成：${pngPath}（${(png512.length / 1024).toFixed(1)} KB，512×512）`);

// icon.ico — 256×256，供 Windows 用
const icoArg = process.argv[2];
if (icoArg) {
  fs.writeFileSync(icoArg, ico);
  console.log(`ICO 已生成：${icoArg}（${(ico.length / 1024).toFixed(1)} KB，256×256）`);
} else {
  const icoPath = path.join(assetsDir, 'icon.ico');
  fs.writeFileSync(icoPath, ico);
  console.log(`ICO 已生成：${icoPath}（${(ico.length / 1024).toFixed(1)} KB，256×256）`);
}

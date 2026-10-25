#!/usr/bin/env node
/**
 * 生成 wb-switch 的 ICO 图标（256×256，PNG 压缩，Vista+ 支持）。
 * 纯 Node 实现：手写像素缓冲 → PNG（zlib）→ ICO 容器。
 *
 * 图形：深色圆角方块 + 蓝白双向箭头（表示「切换」）。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const S = 256;

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

// ── 绘制 ──
const BG = [23, 32, 45]; // #17202D 深蓝灰
const BG2 = [30, 42, 58]; // 轻微渐变提亮
const TOP = [147, 197, 253]; // #93C5FD 浅蓝（上箭头）
const BOT = [96, 165, 250]; // #60A5FA 蓝（下箭头）

// 背景圆角方块
roundRect(8, 8, S - 16, S - 16, 56, BG);
// 顶部渐变条（简单叠加）
for (let y = 8; y < 132; y++) {
  const a = Math.round(((132 - y) / 124) * 26);
  roundRect(8, y, S - 16, 1.2, 0, BG2, a);
}
// 边框
roundRect(8, 8, S - 16, S - 16, 56, [59, 130, 246], 70);

// 上箭头：右向（浅蓝）
roundRect(56, 92, 108, 22, 11, TOP);
triangle([164, 76], [164, 130], [204, 103], TOP);

// 下箭头：左向（蓝）
roundRect(92, 144, 108, 22, 11, BOT);
triangle([92, 128], [92, 182], [52, 155], BOT);

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

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

// 每行前置 filter byte 0
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

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
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(6 + 16, 12); // offset

const ico = Buffer.concat([header, entry, png]);

const out =
  process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'icon.ico');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, ico);
console.log(`图标已生成：${out}（${(ico.length / 1024).toFixed(1)} KB）`);

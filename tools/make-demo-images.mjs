#!/usr/bin/env node
/**
 * 生成「本地预览」用的演示图片（零依赖：只用 node:zlib 手写 PNG）。
 *
 * 为什么要自己画：本地预览要在**不连阿里云**的前提下把相册页面填满，
 * 才能看出网格、灯箱、「更多」面板的真实效果。用真实照片既不该进仓库，
 * 也无法在离线下取得。
 *
 * 输出目录 demo/images/。图片是**确定的**（同一份代码永远生成同样的字节），
 * 所以直接提交进仓库，别人 clone 下来不用跑本脚本也能预览。
 *
 * 用法：node tools/make-demo-images.mjs [--force]
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "demo", "images");

const WIDTH = 1280;
const HEIGHT = 720;

/** 每张演示图：文件名、色相、地平线位置、光球位置 */
export const DEMO_IMAGES = [
  { name: "demo-01.png", hue: 205, horizon: 0.60, orbX: 0.72, orbY: 0.26, hills: 3 },
  { name: "demo-02.png", hue: 268, horizon: 0.66, orbX: 0.24, orbY: 0.22, hills: 2 },
  { name: "demo-03.png", hue: 22, horizon: 0.58, orbX: 0.50, orbY: 0.30, hills: 4 },
  { name: "demo-04.png", hue: 168, horizon: 0.70, orbX: 0.80, orbY: 0.18, hills: 2 },
  { name: "demo-05.png", hue: 320, horizon: 0.63, orbX: 0.34, orbY: 0.24, hills: 3 },
  { name: "demo-06.png", hue: 96, horizon: 0.55, orbX: 0.62, orbY: 0.32, hills: 5 },
  { name: "demo-07.png", hue: 236, horizon: 0.68, orbX: 0.16, orbY: 0.20, hills: 3 },
  { name: "demo-08.png", hue: 44, horizon: 0.61, orbX: 0.44, orbY: 0.28, hills: 4 },
];

// ---------------------------------------------------------------------------
// 最小 PNG 编码器（8-bit RGB，filter 0）
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** @param rgbAt (x, y) => [r, g, b]，分量 0-255 */
function encodePng(width, height, rgbAt) {
  const raw = Buffer.allocUnsafe((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // 每行的 filter 类型：0 = None
    for (let x = 0; x < width; x++) {
      const [r, g, b] = rgbAt(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// 画一张"风景"占位图：渐变天空 + 光球 + 山脊 + 地面
// ---------------------------------------------------------------------------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function hslToRgb(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const seg = Math.floor(hue / 60) % 6;
  const [r, g, b] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][seg];
  return [
    Math.round(clamp(r + m, 0, 1) * 255),
    Math.round(clamp(g + m, 0, 1) * 255),
    Math.round(clamp(b + m, 0, 1) * 255),
  ];
}

/** 一条由若干正弦叠加而成的山脊线（不需要随机数，够用且完全确定） */
function ridgeY(x01, seed, base, amplitude) {
  const a = Math.sin(x01 * (3 + seed) * Math.PI + seed * 1.7);
  const b = Math.sin(x01 * (7 + seed * 2) * Math.PI + seed * 0.9) * 0.5;
  const c = Math.sin(x01 * 13 * Math.PI + seed * 2.3) * 0.22;
  return base - amplitude * (a + b + c) * 0.5;
}

function renderImage(spec) {
  const horizonY = Math.round(HEIGHT * spec.horizon);
  const orbX = Math.round(WIDTH * spec.orbX);
  const orbY = Math.round(HEIGHT * spec.orbY);
  const orbR = 54;
  // 光球周围的柔光半径
  const glowR = orbR * 3.4;

  return encodePng(WIDTH, HEIGHT, (x, y) => {
    const x01 = x / WIDTH;
    const y01 = y / HEIGHT;

    // ---- 天空：自下而上变暗，色相取自本图 ----
    if (y <= horizonY) {
      const t = clamp(y / horizonY, 0, 1); // 0=顶部 1=地平线
      const baseL = 0.20 + 0.32 * t;
      const [r, g, b] = hslToRgb(spec.hue, 0.45, baseL);

      // 光球 + 柔光
      const d = Math.hypot(x - orbX, y - orbY);
      if (d < orbR) {
        const [or_, og, ob] = hslToRgb(spec.hue + 42, 0.55, 0.9);
        return [or_, og, ob];
      }
      if (d < glowR) {
        const k = Math.pow(1 - (d - orbR) / (glowR - orbR), 2.2) * 0.55;
        const [or_, og, ob] = hslToRgb(spec.hue + 42, 0.6, 0.82);
        return [
          Math.round(r + (or_ - r) * k),
          Math.round(g + (og - g) * k),
          Math.round(b + (ob - b) * k),
        ];
      }
      return [r, g, b];
    }

    // ---- 地面 + 山脊 ----
    // 山脊越靠后的越亮（越远越受天光影响）
    let ridge = horizonY;
    for (let i = 0; i < spec.hills; i++) {
      const seed = i + 1;
      const base = horizonY + i * 8;
      const amplitude = 92 - i * 14;
      ridge = Math.max(ridge, ridgeY(x01, seed, base, amplitude));
    }
    if (y < ridge) {
      // 山谷处仍然露出天空
      const t = clamp(y / horizonY, 0, 1);
      return hslToRgb(spec.hue, 0.42, 0.18 + 0.3 * t);
    }

    // 地面：越往下越暗
    const groundT = clamp((y - ridge) / Math.max(1, HEIGHT - ridge), 0, 1);
    const l = 0.16 - 0.1 * groundT;
    const sat = 0.3 + 0.1 * groundT;
    void y01;
    return hslToRgb(spec.hue - 18, sat, clamp(l, 0.03, 0.3));
  });
}

// ---------------------------------------------------------------------------

function main() {
  const force = process.argv.includes("--force");
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let written = 0;
  let skipped = 0;
  for (const spec of DEMO_IMAGES) {
    const file = path.join(OUT_DIR, spec.name);
    if (!force && fs.existsSync(file)) {
      skipped++;
      continue;
    }
    fs.writeFileSync(file, renderImage(spec));
    written++;
  }
  console.log(
    `演示图片：写入 ${written} 张，跳过 ${skipped} 张（已存在）→ ${path.relative(ROOT, OUT_DIR)}/`,
  );
}

// 只有直接运行本文件时才生成；被测试 import 时只取 DEMO_IMAGES
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

#!/usr/bin/env node
/**
 * 图片文件头尺寸解析的测试（修「尺寸未知」）。
 *
 * 用真实文件头构造样本，PNG 那份是**真正可被解码的图**（由 zlib 生成，
 * 并可用 macOS `sips` 交叉验证），其余格式只需头部字段正确即可覆盖解析分支。
 *
 * 用法：node tools/image-size-test.mjs
 */

import assert from "node:assert/strict";
import zlib from "node:zlib";
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  resolve: { alias: { "@": new URL("../src", import.meta.url).pathname } },
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: "custom",
  logLevel: "error",
  optimizeDeps: { noDiscovery: true, include: [] },
});
const { readImageSize } = await server.ssrLoadModule("/src/lib/imageSize.ts");

// ---- 构造样本 ---------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
};

function makePng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // truecolor
  const raw = Buffer.alloc(height * (1 + width * 3));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0;
    for (let x = 0; x < width; x++) {
      raw[p++] = (x * 4) & 0xff;
      raw[p++] = (y * 4) & 0xff;
      raw[p++] = 0x80;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** GIF89a：逻辑屏幕描述符小端 */
function makeGif(w, h) {
  const b = Buffer.alloc(13);
  b.write("GIF89a", 0, "ascii");
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
}

/** JPEG：SOI + APP0(JFIF) + SOF0，宽高写在 SOF0 里（大端） */
function makeJpeg(w, h) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0; // SOF0
  sof.writeUInt16BE(17, 2); // 段长
  sof[4] = 8; // 精度
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  sof[9] = 3; // 分量数
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

/** WebP VP8X：宽高各 24 位、存的是「值 - 1」 */
function makeWebpVp8x(w, h) {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(22, 4);
  b.write("WEBP", 8, "ascii");
  b.write("VP8X", 12, "ascii");
  b.writeUInt32LE(10, 16);
  b[24] = (w - 1) & 0xff;
  b[25] = ((w - 1) >> 8) & 0xff;
  b[26] = ((w - 1) >> 16) & 0xff;
  b[27] = (h - 1) & 0xff;
  b[28] = ((h - 1) >> 8) & 0xff;
  b[29] = ((h - 1) >> 16) & 0xff;
  return b;
}

// ---- 断言 -------------------------------------------------------------------

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`);
  }
};

console.log("【1】PNG（本站真实格式：VRChat 截图）");
check("64×64 圆整尺寸", () =>
  assert.deepEqual(readImageSize(makePng(64, 64)), { width: 64, height: 64 }));
check("非正方形 1920×1080", () =>
  assert.deepEqual(readImageSize(makePng(1920, 1080)), { width: 1920, height: 1080 }));
check("竖图 1080×1920", () =>
  assert.deepEqual(readImageSize(makePng(1080, 1920)), { width: 1080, height: 1920 }));
check("2048×1440（VRChat 常用档位）", () =>
  assert.deepEqual(readImageSize(makePng(2048, 1440)), { width: 2048, height: 1440 }));

console.log("\n【2】其它格式");
check("GIF 320×240", () => assert.deepEqual(readImageSize(makeGif(320, 240)), { width: 320, height: 240 }));
check("JPEG 800×600（跳过 APP0 找到 SOF0）", () =>
  assert.deepEqual(readImageSize(makeJpeg(800, 600)), { width: 800, height: 600 }));
check("WebP(VP8X) 500×400", () =>
  assert.deepEqual(readImageSize(makeWebpVp8x(500, 400)), { width: 500, height: 400 }));

console.log("\n【3】不认识的输入不应抛错，返回 null");
check("空数组", () => assert.equal(readImageSize(new Uint8Array(0)), null));
check("纯文本", () => assert.equal(readImageSize(new TextEncoder().encode("not an image")), null));
check("只有 PNG 签名没有 IHDR", () =>
  assert.equal(readImageSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), null));
check("被截断的 PNG（只有前 12 字节）", () =>
  assert.equal(readImageSize(makePng(64, 64).subarray(0, 12)), null));

await server.close();
console.log(`\n======= 通过 ${pass} / 失败 ${fail} =======`);
process.exit(fail ? 1 : 0);

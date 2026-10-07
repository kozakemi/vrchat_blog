#!/usr/bin/env node
/**
 * 相册「上传一张图」的端到端冒烟测试。
 *
 * 它加载的是 **src/ 下的真实模块**（经 Vite ssrLoadModule 注入 import.meta.env），
 * 不是复制一份逻辑，因此能真实验证：
 *   albumCrypto.encryptPlaintextToParts
 *   → ossUpload.resolvePutSignedUrl / putObjectWithSignedUrl
 *   → albumManifestFetch.fetchExistingManifestForMerge
 *   → albumManifestFetch.buildMergedManifest（生产用的同一个纯函数）
 *   → 清单写回 → 回读校验 → 经签名 URL 取回密文 → AES-GCM 解密 → SHA-256 比对
 *
 * 注意：这会**真实写入生产 OSS**（密文对象 + 清单），因此：
 *   - 默认 dry-run，只打印计划；
 *   - 必须显式 `--confirm-write` 才执行；
 *   - 执行时先按**原始字节**备份线上清单，结束后按原始字节还原并删除测试对象。
 *
 * 用法：
 *   node tools/album-upload-smoke.mjs                  # dry-run
 *   node tools/album-upload-smoke.mjs --confirm-write  # 真跑，跑完自动清理
 *
 * 依赖本地未入库的 keys/oss.json 与 keys/<user>.admin.json。
 * 已知局限：Node 里没有 CORS，浏览器侧的跨域 PUT 预检无法在此覆盖；真实 UI 流程仍需人工点一次。
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "vite";

const CONFIRM = process.argv.includes("--confirm-write");
const root = process.cwd();

// ---------------------------------------------------------------------------
// 生成一张确定性的小 PNG（自带 CRC32，用 macOS sips 交叉验证合法性）
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makePng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  const raw = Buffer.alloc(height * (1 + width * 3));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      raw[p++] = (x * 4) & 0xff;
      raw[p++] = (y * 4) & 0xff;
      raw[p++] = 0x80;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const step = (s) => console.log(`\n── ${s}`);
const ok = (s) => console.log(`   ✓ ${s}`);
const warn = (s) => console.log(`   ⚠️ ${s}`);

// ---------------------------------------------------------------------------
// 载入真实模块
// ---------------------------------------------------------------------------

// 开发模式下 lib 会把 OSS 域名改写成 /dev-oss-proxy/<host>/...（交给 Vite 代理）。
// Node 里没有代理，这里用同规则的 fetch 包装补上，使真实代码无需改动即可跑通。
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  const m = url.match(/^\/dev-oss-proxy\/([^/]+)(\/.*)$/);
  if (m) return realFetch(`https://${m[1]}${m[2]}`, init);
  return realFetch(input, init);
};

const server = await createServer({
  root,
  logLevel: "error",
  server: { middlewareMode: true },
  appType: "custom",
});

const load = (p) => server.ssrLoadModule(p);
const albumCrypto = await load("/src/lib/albumCrypto.ts");
const ossUpload = await load("/src/lib/ossUpload.ts");
const manifestFetch = await load("/src/lib/albumManifestFetch.ts");
const signFetch = await load("/src/lib/ossSignFetch.ts");
const keyFileLib = await load("/src/lib/keyFile.ts");

// ---------------------------------------------------------------------------
// 凭据与素材
// ---------------------------------------------------------------------------

const ossJson = JSON.parse(fs.readFileSync(path.join(root, "keys", "oss.json"), "utf8"));
const ossCfg = {
  oss_access_key_id: ossJson.OSS_ACCESS_KEY_ID,
  oss_access_key_secret: ossJson.OSS_ACCESS_KEY_SECRET,
  oss_endpoint: ossJson.OSS_ENDPOINT,
  oss_bucket_name: ossJson.OSS_BUCKET_NAME,
};

const admin = keyFileLib.parseKeyFileJson(
  fs.readFileSync(path.join(root, "keys", "kozakemi.admin.json"), "utf8"),
);
const zone = admin.zones.find((z) => z.zoneId === "public-v1");
if (!zone) throw new Error("本机密钥文件里没有 public-v1，无法测试");

const ZONE_ID = zone.zoneId;
const ASSETS_PREFIX = "albums/assets/";
const MANIFEST_KEY = manifestFetch.getManifestObjectKey();

const png = makePng(64, 64);
const pngPath = "/tmp/album-upload-smoke.png";
fs.writeFileSync(pngPath, png);
let sipsDims = "(sips 不可用)";
try {
  sipsDims = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", pngPath], {
    encoding: "utf8",
  })
    .trim()
    .replace(/\s+/g, " ");
} catch {
  /* 忽略 */
}

const assetId = albumCrypto.newAssetId();
const ossKey = `${ASSETS_PREFIX}${assetId}.bin`;

step("准备");
console.log(`   清单对象键 : ${MANIFEST_KEY}`);
console.log(`   Zone       : ${ZONE_ID}`);
console.log(`   测试图片   : ${png.length} B, sha256=${sha256(png).slice(0, 16)}…`);
console.log(`   sips 校验  : ${sipsDims}`);
console.log(`   目标密文键 : ${ossKey}`);

if (!CONFIRM) {
  console.log("\n[dry-run] 未加 --confirm-write，不做任何写入。");
  await server.close();
  process.exit(0);
}

/** 直接按对象键取回清单**原始字节**，用于精确备份与还原 */
async function fetchManifestRaw() {
  const signed = await signFetch.fetchSignedUrlForOssObject(MANIFEST_KEY);
  const res = await fetch(signed, { cache: "no-store" });
  if (!res.ok) throw new Error(`拉取清单原文失败：HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const cleanup = { manifestRestored: false, objectDeleted: false };

// ---------------------------------------------------------------------------
// 1. 按原始字节备份线上清单
// ---------------------------------------------------------------------------

step("1. 按原始字节备份线上清单");
const beforeRaw = await fetchManifestRaw();
const beforeSha = sha256(beforeRaw);
const beforeTopKeys = Object.keys(JSON.parse(beforeRaw.toString("utf8")));
ok(`${beforeRaw.length} B, sha256=${beforeSha.slice(0, 16)}…, 顶层字段=[${beforeTopKeys.join(", ")}]`);

const before = await manifestFetch.fetchExistingManifestForMerge();
if (before.status !== "ok") throw new Error("现有清单不可读，中止（避免污染线上数据）");
ok(`归一化读出 ${before.payload.assets.length} 条`);

try {
  // -------------------------------------------------------------------------
  // 2. 加密（真实 albumCrypto）
  // -------------------------------------------------------------------------
  step("2. AES-256-GCM 加密（albumCrypto.encryptPlaintextToParts）");
  const mime = "image/png";
  const parts = await albumCrypto.encryptPlaintextToParts(
    png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
    ZONE_ID,
    assetId,
    mime,
    zone.keyB64,
  );
  const cipherBytes = parts.cipherBytes;
  const row = {
    assetId,
    zoneId: ZONE_ID,
    originalName: "SMOKE-TEST_upload.png",
    relPath: "SMOKE-TEST/SMOKE-TEST_upload.png",
    mime,
    size: cipherBytes.byteLength,
    nonceB64: parts.nonceB64,
    cipherFile: ossKey,
    aad: JSON.parse(parts.aadJson),
  };
  ok(`密文 ${cipherBytes.byteLength} B（原图 ${png.length} B，膨胀 ${cipherBytes.byteLength - png.length} B = GCM tag）`);
  console.log(`   AAD: ${parts.aadJson}`);

  // -------------------------------------------------------------------------
  // 3. 浏览器内 OSS 预签名 + PUT 密文（真实 ossUpload）
  // -------------------------------------------------------------------------
  step("3. 预签名并上传密文（ossUpload.resolvePutSignedUrl + putObjectWithSignedUrl）");
  const putUrl = await ossUpload.resolvePutSignedUrl(ossKey, ossCfg, "application/octet-stream");
  ok(`拿到 PUT 预签名：${putUrl.split("?")[0]}`);
  await ossUpload.putObjectWithSignedUrl(putUrl, cipherBytes, "application/octet-stream");
  ok("密文 PUT 成功");

  // -------------------------------------------------------------------------
  // 4. 用生产纯函数合并清单并写回
  // -------------------------------------------------------------------------
  step("4. 合并并写回清单（manifestFetch.buildMergedManifest —— 生产同一个函数）");
  const { doc, previousCount, mergedCount } = manifestFetch.buildMergedManifest(
    before,
    [row],
    new Date().toISOString(),
  );
  const docTopKeys = Object.keys(doc);
  const dropped = beforeTopKeys.filter((k) => !docTopKeys.includes(k));
  ok(`合并结果 ${previousCount} + 1 = ${mergedCount} 条`);
  ok(`顶层字段 [${docTopKeys.join(", ")}]；相比原文丢失字段：${dropped.length ? dropped.join(", ") : "无 ✅"}`);
  if (dropped.length) throw new Error(`合并丢了顶层字段：${dropped.join(", ")}`);

  const manifestPutUrl = await ossUpload.resolvePutSignedUrl(MANIFEST_KEY, ossCfg, "application/json");
  await ossUpload.putObjectWithSignedUrl(
    manifestPutUrl,
    new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }),
    "application/json",
  );
  ok("已写回清单");

  // -------------------------------------------------------------------------
  // 5. 回读校验（真实 fetchExistingManifestForMerge）
  // -------------------------------------------------------------------------
  step("5. 回读校验");
  const after = await manifestFetch.fetchExistingManifestForMerge();
  if (after.status !== "ok") throw new Error("回读失败");
  const afterIds = new Set(after.payload.assets.map((a) => a.assetId));
  const lost = [...doc.assets.map((a) => a.assetId)].filter((id) => !afterIds.has(id));
  if (lost.length) throw new Error(`回读发现丢失 ${lost.length} 条：${lost.slice(0, 3).join(", ")}`);
  ok(`回读 ${afterIds.size} 条，原有 ${previousCount} 条一条未丢，新条目在场`);
  const extraKept = Object.keys(after.payload.extra ?? {});
  ok(`回读到的顶层额外字段：[${extraKept.join(", ")}]`);

  // -------------------------------------------------------------------------
  // 6. 走开放签名服务取回密文并解密（真实 ossSignFetch + WebCrypto）
  // -------------------------------------------------------------------------
  step("6. 取回密文并解密（模拟相册页读取路径）");
  const signedUrl = await signFetch.fetchSignedUrlForOssObject(ossKey);
  const fetched = Buffer.from(await (await fetch(signedUrl, { cache: "no-store" })).arrayBuffer());
  ok(`经签名 URL 取回 ${fetched.length} B`);

  const key = await albumCrypto.importAesGcmKey(zone.keyB64, ["decrypt"]);
  const plain = Buffer.from(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: albumCrypto.base64ToBytes(row.nonceB64),
        additionalData: new TextEncoder().encode(JSON.stringify(row.aad)),
      },
      key,
      fetched,
    ),
  );
  const same = sha256(plain) === sha256(png);
  ok(`解密后 ${plain.length} B，sha256 与原图一致：${same ? "是 ✅" : "否 ❌"}`);
  ok(`解密结果 PNG 魔数正确：${plain.subarray(0, 8).toString("hex") === "89504e470d0a1a0a"}`);
  if (!same) throw new Error("解密结果与原图不一致，上传链路有问题");
} finally {
  // -------------------------------------------------------------------------
  // 7. 清理：先按原始字节还原清单（保证相册立刻恢复原状），再删测试对象
  // -------------------------------------------------------------------------
  step("7. 清理");
  try {
    const restoreUrl = await ossUpload.resolvePutSignedUrl(MANIFEST_KEY, ossCfg, "application/json");
    await ossUpload.putObjectWithSignedUrl(restoreUrl, beforeRaw, "application/json");
    const nowRaw = await fetchManifestRaw();
    cleanup.manifestRestored = sha256(nowRaw) === beforeSha;
    ok(
      cleanup.manifestRestored
        ? `清单已按原始字节还原：sha256 一致（${beforeSha.slice(0, 16)}…）`
        : `⚠️ 清单 sha256 不一致：期望 ${beforeSha.slice(0, 16)}…，实际 ${sha256(nowRaw).slice(0, 16)}…`,
    );
  } catch (e) {
    console.log(`   ✗ 清单还原失败：${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const OSS = (await import("ali-oss")).default;
    const client = new OSS({
      region: "oss-cn-beijing",
      accessKeyId: ossCfg.oss_access_key_id,
      accessKeySecret: ossCfg.oss_access_key_secret,
      bucket: ossCfg.oss_bucket_name,
      secure: true,
    });
    await client.delete(ossKey);
    cleanup.objectDeleted = true;
    ok(`已删除测试对象 ${ossKey}`);
  } catch (e) {
    warn(`测试对象删除失败（已成孤儿对象，不影响相册）：${ossKey}`);
    console.log(`      ${e instanceof Error ? e.message : String(e)}`);
  }

  await server.close();
}

console.log(
  `\n======= 清单按原始字节还原=${cleanup.manifestRestored ? "成功" : "失败"}，测试对象删除=${
    cleanup.objectDeleted ? "成功" : "失败/跳过"
  } =======`,
);
process.exit(cleanup.manifestRestored ? 0 : 1);

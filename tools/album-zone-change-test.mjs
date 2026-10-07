#!/usr/bin/env node
/**
 * 「修改照片归属 Zone」的回归测试（内存 OSS 桩，不联网、不读线上密钥、不碰线上数据）。
 *
 * 这个功能比删除更危险：删除只是少一张，而"换区"要**重新加密整张照片**。
 * 所以测试重点锁死的是「任何一步失败都还能看」以及「绝不就地覆盖」：
 *
 *   1. 顺序：先传新对象 → 再改清单 → 最后删旧对象。反序会毁掉唯一可用的密文。
 *   2. 新对象键**必须不同于**旧对象键（就地覆盖 = 清单写入失败即永久不可读）。
 *   3. 清单写入失败 / 回读校验不通过时，**旧密文一个字都不能删**。
 *   4. 参数不合法（同 Zone、缺密钥、清单里没有这条）时**不发生任何网络副作用**。
 *   5. 明文条目迁移后必须清掉 `file` 字段（读取路径里 file 优先于 cipherFile，
 *      残留会让页面继续去取那个刚被删掉的明文对象）。
 *
 * 用法：node tools/album-zone-change-test.mjs
 */

import assert from "node:assert/strict";
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  resolve: { alias: { "@": new URL("../src", import.meta.url).pathname } },
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: "custom",
  logLevel: "error",
  optimizeDeps: { noDiscovery: true, include: [] },
});

const config = {
  oss_access_key_id: "test-id",
  oss_access_key_secret: "test-secret",
  oss_endpoint: "oss-cn-beijing.aliyuncs.com",
  oss_bucket_name: "test-bucket",
};

const MANIFEST_KEY = "albums/manifest.json";

const manifestMod = await server.ssrLoadModule("/src/lib/albumManifestFetch.ts");
const zoneChangeMod = await server.ssrLoadModule("/src/lib/albumZoneChange.ts");
const cryptoMod = await server.ssrLoadModule("/src/lib/albumCrypto.ts");
const fpMod = await server.ssrLoadModule("/src/lib/keyFingerprint.ts");
const signMod = await server.ssrLoadModule("/src/lib/ossSignFetch.ts");

const { buildManifestWithReplacedAsset } = manifestMod;
const { changeAlbumAssetZone } = zoneChangeMod;
const {
  ALBUM_ASSETS_PREFIX,
  base64ToBytes,
  encryptPlaintextToParts,
  generateZoneKeyB64,
} = cryptoMod;
const { keyFingerprintB64 } = fpMod;

const OLD_CIPHER_KEY = "albums/assets/a_test.bin";

// ---------------------------------------------------------------------------
// 内存 OSS 桩
// ---------------------------------------------------------------------------

/** objects: Map<string, string | Uint8Array>；清单存字符串，密文/明文存字节 */
let objects;
let ops;
/** (key) => boolean：命中的 PUT 返回 403 */
let putFailWhen;
/** 命中的 PUT 假装成功但不落盘（用于"写入被吞"） */
let putSwallowWhen;
/** (key) => boolean：命中的 DELETE 返回 403 */
let deleteFailWhen;
/** 清单 PUT 落盘时强行把 file 字段塞回去（模拟"写入没按预期生效"） */
let injectFileOnManifestPut;

function reset() {
  objects = new Map();
  ops = [];
  putFailWhen = null;
  putSwallowWhen = null;
  deleteFailWhen = null;
  injectFileOnManifestPut = false;
}
reset();

globalThis.fetch = async (input, init = {}) => {
  const raw = typeof input === "string" ? input : input.url;
  const url = new URL(raw, "https://test.local");

  // 签名服务：?file=<key>
  if (url.searchParams.has("file")) {
    return new Response(
      JSON.stringify({
        signedUrl: `https://test-bucket.oss-cn-beijing.aliyuncs.com/${url.searchParams.get("file")}`,
      }),
      { status: 200 },
    );
  }

  const key = decodeURIComponent(url.pathname.replace(/^\/dev-oss-proxy\/[^/]+/, "").slice(1));
  const method = (init.method ?? "GET").toUpperCase();

  if (method === "PUT") {
    ops.push(`PUT ${key}`);
    if (putFailWhen?.(key)) return new Response("Denied", { status: 403 });
    if (putSwallowWhen?.(key)) return new Response(null, { status: 200 });

    const body = init.body;
    let value;
    if (typeof body === "string") value = body;
    else if (body instanceof Uint8Array) value = new Uint8Array(body);
    else if (body && typeof body.text === "function") value = await body.text();
    else value = String(body);

    if (injectFileOnManifestPut && key === MANIFEST_KEY && typeof value === "string") {
      const doc = JSON.parse(value);
      doc.assets = doc.assets.map((a) =>
        a.assetId === "a_test" ? { ...a, file: "albums/leftover.png" } : a,
      );
      value = JSON.stringify(doc, null, 2);
    }
    objects.set(key, value);
    return new Response(null, { status: 200 });
  }

  if (method === "DELETE") {
    ops.push(`DELETE ${key}`);
    if (deleteFailWhen?.(key)) return new Response("Denied", { status: 403 });
    objects.delete(key);
    return new Response(null, { status: 204 });
  }

  ops.push(`GET ${key}`);
  const v = objects.get(key);
  if (v === undefined) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
  return new Response(v, { status: 200 });
};

// ---------------------------------------------------------------------------
// 密钥与加解密工具
// ---------------------------------------------------------------------------

const ZONE_A = { zoneId: "zone-a", keyB64: generateZoneKeyB64() };
const ZONE_B = { zoneId: "zone-b", keyB64: generateZoneKeyB64() };
const BOTH = [ZONE_A, ZONE_B];
assert.notEqual(ZONE_A.keyB64, ZONE_B.keyB64, "两把测试密钥必须不同");

const MIME = "image/png";
const PLAINTEXT = "PLAINTEXT-IMAGE-BYTES-0123456789";

/** 用真实 WebCrypto 做一次真正的 AES-256-GCM 加密 */
async function encryptFor(zone, assetId, plainBytes) {
  const { nonceB64, cipherBytes, aadJson } = await encryptPlaintextToParts(
    plainBytes.slice().buffer,
    zone.zoneId,
    assetId,
    MIME,
    zone.keyB64,
  );
  return { nonceB64, cipherBytes, aad: JSON.parse(aadJson) };
}

async function decryptWith(keyB64, cipherBytes, nonceB64, aad) {
  const key = await crypto.subtle.importKey("raw", base64ToBytes(keyB64), { name: "AES-GCM" }, false, [
    "decrypt",
  ]);
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(nonceB64),
      additionalData: new TextEncoder().encode(JSON.stringify(aad)),
    },
    key,
    cipherBytes,
  );
  return new Uint8Array(plain);
}

const bytesOf = (s) => new TextEncoder().encode(s);
const textOf = (b) => new TextDecoder().decode(b);

const manifestOf = () => JSON.parse(objects.get(MANIFEST_KEY));
const assetRow = (id) => manifestOf().assets.find((a) => a.assetId === id);
const idsOf = () => manifestOf().assets.map((a) => a.assetId);
const writeOps = () => ops.filter((o) => o.startsWith("PUT") || o.startsWith("DELETE"));
const hasDelete = () => ops.some((o) => o.startsWith("DELETE"));

/**
 * 传给被测函数的资源对象 —— 直接从清单里取，与界面上的真实调用方式一致
 * （关键是 aad 也要带上，生产里它一直存在）。
 */
const targetAsset = () => {
  const row = assetRow("a_test");
  if (!row) throw new Error("测试内部错误：清单里没有 a_test，请确认 seedCipher() 已调用");
  return {
    assetId: row.assetId,
    zoneId: row.zoneId,
    mime: row.mime,
    cipherFile: row.cipherFile,
    nonceB64: row.nonceB64,
    aad: row.aad,
    originalName: row.originalName,
    relPath: row.relPath,
  };
};

/**
 * 种一份三张照片的清单：a_before（陪跑）、a_test（迁移目标）、a_after（陪跑）。
 * a_test 用 ZONE_A 真实加密，并带上 takenAt / world / width 等"与加密无关、必须存活"的字段。
 */
async function seedCipher() {
  reset();
  signMod.invalidateSignedUrlCacheForObjectKey(MANIFEST_KEY);
  const enc = await encryptFor(ZONE_A, "a_test", bytesOf(PLAINTEXT));
  const doc = {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    assetsBasePath: "/albums/",
    customFlag: true,
    assets: [
      { assetId: "a_before", zoneId: ZONE_A.zoneId, cipherFile: "albums/assets/a_before.bin" },
      {
        assetId: "a_test",
        zoneId: ZONE_A.zoneId,
        originalName: "VRChat_test.png",
        relPath: "2026-01/VRChat_test.png",
        mime: MIME,
        size: enc.cipherBytes.byteLength,
        nonceB64: enc.nonceB64,
        cipherFile: OLD_CIPHER_KEY,
        aad: enc.aad,
        keyFp: "oldfp000",
        takenAt: "2026-03-26T00:42:53.000Z",
        world: { worldId: "wrld_abc", worldName: "Test World" },
        width: 1920,
        height: 1080,
        customField: 42,
      },
      { assetId: "a_after", zoneId: ZONE_A.zoneId, cipherFile: "albums/assets/a_after.bin" },
    ],
  };
  objects.set(MANIFEST_KEY, JSON.stringify(doc, null, 2));
  objects.set("albums/assets/a_before.bin", bytesOf("BEFORE"));
  objects.set("albums/assets/a_after.bin", bytesOf("AFTER"));
  objects.set(OLD_CIPHER_KEY, enc.cipherBytes);
}

/** 种一条**未加密的明文**条目：只有 file，没有 cipherFile / nonceB64 */
function seedPlaintext() {
  reset();
  signMod.invalidateSignedUrlCacheForObjectKey(MANIFEST_KEY);
  const doc = {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    assets: [
      {
        assetId: "a_plain",
        zoneId: ZONE_A.zoneId,
        file: "albums/a_plain.png",
        mime: MIME,
        originalName: "plain.png",
        takenAt: "2026-02-02T02:02:02.000Z",
      },
    ],
  };
  objects.set(MANIFEST_KEY, JSON.stringify(doc, null, 2));
  objects.set("albums/a_plain.png", bytesOf(PLAINTEXT));
}

const PLAIN_ASSET = {
  assetId: "a_plain",
  zoneId: ZONE_A.zoneId,
  file: "albums/a_plain.png",
  mime: MIME,
};

let pass = 0;
let fail = 0;
const test = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`);
  }
};

// ---------------------------------------------------------------------------

console.log("【1】纯函数：原地替换清单条目");
await test("替换目标、保持位置、保留其它条目与顶层额外字段", () => {
  const existing = {
    status: "ok",
    payload: {
      schemaVersion: 1,
      extra: { assetsBasePath: "/albums/", customFlag: true },
      assets: [{ assetId: "a" }, { assetId: "b" }, { assetId: "c" }],
    },
  };
  const { doc, replacedCount, totalCount } = buildManifestWithReplacedAsset(
    existing,
    "b",
    { assetId: "b", zoneId: "new" },
    "NOW",
  );
  assert.equal(replacedCount, 1);
  assert.equal(totalCount, 3, "替换不增不减");
  assert.deepEqual(doc.assets.map((x) => x.assetId), ["a", "b", "c"], "顺序必须保持");
  assert.equal(doc.assets[1].zoneId, "new");
  assert.equal(doc.assetsBasePath, "/albums/");
  assert.equal(doc.customFlag, true);
  assert.equal(doc.generatedAt, "NOW");
});
await test("找不到目标 id → replacedCount = 0，清单内容不变", () => {
  const existing = {
    status: "ok",
    payload: { schemaVersion: 1, extra: {}, assets: [{ assetId: "a" }] },
  };
  const { doc, replacedCount } = buildManifestWithReplacedAsset(
    existing,
    "zzz",
    { assetId: "zzz" },
    "NOW",
  );
  assert.equal(replacedCount, 0);
  assert.deepEqual(doc.assets, [{ assetId: "a" }]);
});
await test("assetId 缺失的异常条目原样保留", () => {
  const existing = {
    status: "ok",
    payload: { schemaVersion: 1, extra: {}, assets: [{ cipherFile: "x.bin" }, { assetId: "a" }] },
  };
  const { doc, replacedCount } = buildManifestWithReplacedAsset(
    existing,
    "a",
    { assetId: "a", zoneId: "z" },
    "NOW",
  );
  assert.equal(replacedCount, 1);
  assert.equal(doc.assets.length, 2, "不能因为替换而丢掉异常条目");
});

console.log("\n【2】正常迁移：密文 → 密文");
await test("清单指向、Zone、密钥指纹全部更新，条数与顺序不变", async () => {
  await seedCipher();
  const report = await changeAlbumAssetZone(config, targetAsset(), ZONE_B.zoneId, BOTH);
  assert.equal(report.fromZoneId, ZONE_A.zoneId);
  assert.equal(report.toZoneId, ZONE_B.zoneId);
  assert.equal(report.fromPlaintext, false);
  assert.equal(report.warning, undefined);
  assert.deepEqual(idsOf(), ["a_before", "a_test", "a_after"], "顺序与条数必须不变");
  const row = assetRow("a_test");
  assert.equal(row.zoneId, ZONE_B.zoneId);
  assert.equal(row.cipherFile, report.newObjectKey);
  assert.notEqual(row.keyFp, "oldfp000", "keyFp 必须更新为新密钥的指纹");
  assert.equal(row.keyFp, await keyFingerprintB64(ZONE_B.keyB64));
  assert.equal(row.file, undefined, "不该残留 file 字段");
  assert.equal(manifestOf().assetsBasePath, "/albums/", "顶层额外字段必须保留");
  assert.equal(manifestOf().customFlag, true);
});
await test("新密文能用新 Zone 密钥 + 新 AAD 解回原文", async () => {
  await seedCipher();
  const report = await changeAlbumAssetZone(config, targetAsset(), ZONE_B.zoneId, BOTH);
  const row = assetRow("a_test");
  const plain = await decryptWith(ZONE_B.keyB64, objects.get(row.cipherFile), row.nonceB64, row.aad);
  assert.equal(textOf(plain), PLAINTEXT);
  assert.deepEqual(row.aad, { v: 1, zoneId: ZONE_B.zoneId, assetId: "a_test", mime: MIME });
  assert.equal(row.size, objects.get(row.cipherFile).byteLength);
  assert.equal(report.newSize, row.size);
});
await test("新密文用旧 Zone 密钥解不开（确实换了钥匙，而不是改了个标签）", async () => {
  await seedCipher();
  await changeAlbumAssetZone(config, targetAsset(), ZONE_B.zoneId, BOTH);
  const row = assetRow("a_test");
  await assert.rejects(
    () => decryptWith(ZONE_A.keyB64, objects.get(row.cipherFile), row.nonceB64, row.aad),
    "旧密钥不该能解开新密文",
  );
});
await test("与加密无关的字段必须存活：takenAt / world / width / height / 自定义字段", async () => {
  await seedCipher();
  await changeAlbumAssetZone(config, targetAsset(), ZONE_B.zoneId, BOTH);
  const row = assetRow("a_test");
  assert.equal(row.takenAt, "2026-03-26T00:42:53.000Z");
  assert.deepEqual(row.world, { worldId: "wrld_abc", worldName: "Test World" });
  assert.equal(row.width, 1920);
  assert.equal(row.height, 1080);
  assert.equal(row.customField, 42);
  assert.equal(row.originalName, "VRChat_test.png");
  assert.equal(row.relPath, "2026-01/VRChat_test.png");
});
await test("旧密文被删除，且没有误删其它对象", async () => {
  await seedCipher();
  const report = await changeAlbumAssetZone(config, targetAsset(), ZONE_B.zoneId, BOTH);
  assert.deepEqual(report.removedObjectKeys, [OLD_CIPHER_KEY]);
  assert.deepEqual(report.orphanObjectKeys, []);
  assert.equal(objects.has(OLD_CIPHER_KEY), false);
  assert.equal(objects.has(report.newObjectKey), true);
  assert.equal(objects.has("albums/assets/a_before.bin"), true, "不能误删陪跑对象");
  assert.equal(objects.has("albums/assets/a_after.bin"), true);
});
await test("执行顺序：传新对象 → 改清单 → 删旧对象（顺序反了会毁掉唯一可用的密文）", async () => {
  await seedCipher();
  const report = await changeAlbumAssetZone(config, targetAsset(), ZONE_B.zoneId, BOTH);
  const putNew = ops.indexOf(`PUT ${report.newObjectKey}`);
  const putManifest = ops.indexOf(`PUT ${MANIFEST_KEY}`);
  const delOld = ops.indexOf(`DELETE ${OLD_CIPHER_KEY}`);
  assert.notEqual(putNew, -1, "应当上传过新对象");
  assert.notEqual(putManifest, -1, "应当改写过清单");
  assert.notEqual(delOld, -1, "应当删过旧对象");
  assert.ok(putNew < putManifest, `新对象(${putNew}) 必须早于清单(${putManifest})`);
  assert.ok(putManifest < delOld, `清单(${putManifest}) 必须早于删旧对象(${delOld})`);
});
await test("新对象键绝不等于旧对象键（即使旧键恰好就是「assetId.目标指纹.bin」）", async () => {
  // 极端情况：旧对象键正好等于按通常规则算出来的新键。
  // 此时若不动脑筋照拼，就会写到正在被读取的那个对象上 —— 就地覆盖。
  const fpB = await keyFingerprintB64(ZONE_B.keyB64);
  await seedCipher();
  const colliding = `${ALBUM_ASSETS_PREFIX}a_test.${fpB}.bin`;
  objects.set(colliding, objects.get(OLD_CIPHER_KEY));

  const doc = manifestOf();
  doc.assets = doc.assets.map((a) => (a.assetId === "a_test" ? { ...a, cipherFile: colliding } : a));
  objects.set(MANIFEST_KEY, JSON.stringify(doc, null, 2));

  const report = await changeAlbumAssetZone(
    config,
    { ...targetAsset(), cipherFile: colliding },
    ZONE_B.zoneId,
    BOTH,
  );
  assert.notEqual(report.newObjectKey, colliding, "必须换一个键，绝不能就地覆盖");
  const row = assetRow("a_test");
  assert.equal(row.cipherFile, report.newObjectKey);
  const plain = await decryptWith(ZONE_B.keyB64, objects.get(row.cipherFile), row.nonceB64, row.aad);
  assert.equal(textOf(plain), PLAINTEXT, "迁移后仍要能解回原文");
  assert.equal(objects.has(colliding), false, "旧对象仍应被清理掉");
});

console.log("\n【3】明文条目迁移：顺便加密");
await test("明文 → 密文：file 字段必须清掉，且新密文可解回原文", async () => {
  seedPlaintext();
  const report = await changeAlbumAssetZone(config, PLAIN_ASSET, ZONE_B.zoneId, BOTH);
  assert.equal(report.fromPlaintext, true);
  const row = assetRow("a_plain");
  assert.equal(
    row.file,
    undefined,
    "读取路径里 file 优先于 cipherFile，残留会导致页面去读已删掉的明文对象",
  );
  assert.equal(row.zoneId, ZONE_B.zoneId);
  assert.equal(row.cipherFile, report.newObjectKey);
  const plain = await decryptWith(ZONE_B.keyB64, objects.get(row.cipherFile), row.nonceB64, row.aad);
  assert.equal(textOf(plain), PLAINTEXT);
  assert.equal(row.takenAt, "2026-02-02T02:02:02.000Z", "无关键字段应存活");
});
await test("明文 → 密文：旧明文对象被删除（否则等于没收窄成功）", async () => {
  seedPlaintext();
  await changeAlbumAssetZone(config, PLAIN_ASSET, ZONE_B.zoneId, BOTH);
  assert.equal(objects.has("albums/a_plain.png"), false);
});
await test("明文迁移不需要旧 Zone 的密钥（手里只有目标 Zone 也能加密）", async () => {
  seedPlaintext();
  const report = await changeAlbumAssetZone(config, PLAIN_ASSET, ZONE_B.zoneId, [ZONE_B]);
  assert.equal(report.toZoneId, ZONE_B.zoneId);
  assert.equal(assetRow("a_plain").zoneId, ZONE_B.zoneId);
});

console.log("\n【4】参数不合法：必须在动手之前就拒绝（零副作用）");
await test("目标 Zone 与当前相同 → 抛错，且没有任何网络请求", async () => {
  await seedCipher();
  ops = [];
  await assert.rejects(
    () => changeAlbumAssetZone(config, targetAsset(), ZONE_A.zoneId, BOTH),
    /已经属于/,
  );
  assert.deepEqual(ops, [], "不该发出任何请求");
});
await test("目标 Zone 不在密钥文件里 → 抛错，零副作用", async () => {
  await seedCipher();
  ops = [];
  await assert.rejects(
    () => changeAlbumAssetZone(config, targetAsset(), "zone-missing", BOTH),
    /没有 Zone「zone-missing」/,
  );
  assert.deepEqual(ops, []);
});
await test("没有旧 Zone 的密钥（解不开）→ 抛错，零副作用", async () => {
  await seedCipher();
  ops = [];
  await assert.rejects(
    () => changeAlbumAssetZone(config, targetAsset(), ZONE_B.zoneId, [ZONE_B]),
    /没有 Zone「zone-a」的密钥/,
  );
  assert.deepEqual(ops, []);
});
await test("清单里找不到这条 → 抛错，且绝不先上传新对象", async () => {
  await seedCipher();
  // 先拿到资源对象（模拟"用户已经打开了这张照片"），再从清单里把它删掉
  // （模拟"另一个标签页同时改动了清单"）。
  const asset = targetAsset();
  const doc = manifestOf();
  doc.assets = doc.assets.filter((a) => a.assetId !== "a_test");
  objects.set(MANIFEST_KEY, JSON.stringify(doc, null, 2));
  ops = [];
  await assert.rejects(
    () => changeAlbumAssetZone(config, asset, ZONE_B.zoneId, BOTH),
    /找不到这条照片/,
  );
  assert.deepEqual(writeOps(), [], "不该产生任何写入或删除");
  assert.equal(objects.has(OLD_CIPHER_KEY), true, "原密文必须完好");
});
await test("解密失败（清单记录的 Zone 与实际加密密钥不符）→ 抛错，且不上传任何东西", async () => {
  // 把密文换成用 B 加密的，清单却仍然声称属于 zone-a —— 正是"用错密钥上传"的现场。
  const encB = await encryptFor(ZONE_B, "a_test", bytesOf(PLAINTEXT));
  await seedCipher();
  objects.set(OLD_CIPHER_KEY, encB.cipherBytes);
  ops = [];
  await assert.rejects(
    () => changeAlbumAssetZone(config, targetAsset(), ZONE_B.zoneId, BOTH),
    /解密失败/,
  );
  assert.deepEqual(writeOps(), [], "解不开就不该有任何写入");
});

console.log("\n【5】失败时的可恢复性（本功能的安全核心）");
await test("新对象上传失败 → 抛错，清单未改，旧密文仍在（照片照常能看）", async () => {
  await seedCipher();
  putFailWhen = (k) => k.startsWith(`${ALBUM_ASSETS_PREFIX}a_test.`);
  await assert.rejects(() => changeAlbumAssetZone(config, targetAsset(), ZONE_B.zoneId, BOTH));
  putFailWhen = null;
  assert.equal(assetRow("a_test").zoneId, ZONE_A.zoneId, "清单不该被动过");
  assert.equal(objects.has(OLD_CIPHER_KEY), true, "旧密文必须还在");
  assert.equal(ops.includes(`PUT ${MANIFEST_KEY}`), false, "不该写清单");
});
await test("清单写入失败 → 抛错，但**旧密文一个字都不能删**", async () => {
  await seedCipher();
  putFailWhen = (k) => k === MANIFEST_KEY;
  await assert.rejects(() => changeAlbumAssetZone(config, targetAsset(), ZONE_B.zoneId, BOTH));
  putFailWhen = null;
  assert.equal(assetRow("a_test").zoneId, ZONE_A.zoneId, "清单还是旧的");
  assert.equal(objects.has(OLD_CIPHER_KEY), true, "旧密文必须还在，否则照片永久不可读");
  assert.equal(hasDelete(), false, "绝不允许发出任何 DELETE");
});
await test("清单写入被吞（回读发现 Zone 没变）→ 抛错，且旧密文仍然保留", async () => {
  await seedCipher();
  putSwallowWhen = (k) => k === MANIFEST_KEY;
  await assert.rejects(
    () => changeAlbumAssetZone(config, targetAsset(), ZONE_B.zoneId, BOTH),
    /归属 Zone 还是/,
  );
  putSwallowWhen = null;
  assert.equal(objects.has(OLD_CIPHER_KEY), true);
  assert.equal(hasDelete(), false);
});
await test("回读发现仍残留 file 字段 → 抛错（否则页面会去读那个即将被删的明文对象）", async () => {
  await seedCipher();
  injectFileOnManifestPut = true;
  await assert.rejects(
    () => changeAlbumAssetZone(config, targetAsset(), ZONE_B.zoneId, BOTH),
    /残留 file 直链/,
  );
  injectFileOnManifestPut = false;
  assert.equal(hasDelete(), false, "校验没过就不该删旧对象");
});
await test("旧密文删不掉 → 不抛错，返回 warning 并点明旧文件仍可用旧密钥解开", async () => {
  await seedCipher();
  deleteFailWhen = (k) => k === OLD_CIPHER_KEY;
  const report = await changeAlbumAssetZone(config, targetAsset(), ZONE_B.zoneId, BOTH);
  deleteFailWhen = null;
  assert.deepEqual(report.orphanObjectKeys, [OLD_CIPHER_KEY]);
  assert.deepEqual(report.removedObjectKeys, []);
  assert.match(report.warning ?? "", /仍然可以用「zone-a」的密钥解开/);
  assert.match(report.warning ?? "", /OSS 控制台手动删除/);
  assert.equal(assetRow("a_test").zoneId, ZONE_B.zoneId, "迁移本身必须已经成功");
  assert.equal(objects.has(OLD_CIPHER_KEY), true);
});

reset();
await server.close();
console.log(`\n======= 通过 ${pass} / 失败 ${fail} =======`);
process.exit(fail ? 1 : 0);

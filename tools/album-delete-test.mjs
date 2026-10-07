#!/usr/bin/env node
/**
 * 管理员删除照片的回归测试（内存 OSS 桩，不联网、不读密钥、不碰线上数据）。
 *
 * 重点锁死四件事：
 *   1. **执行顺序**：必须先改清单、后删密文。反序会在清单里留下悬空引用（相册裂图）。
 *   2. 删对象失败（如浏览器 DELETE 预检被拒）时，清单已改好 → 只留孤儿对象，且要如实报告。
 *   3. 对象本就不在（404）时幂等成功。
 *   4. 清单读不到时**直接中止**，绝不改写、也绝不删对象。
 *
 * 用法：node tools/album-delete-test.mjs
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

let objects;
let ops;
let readStatus;
let deleteStatus;
let networkFailure;
/** 只让 DELETE 失败：真实浏览器里"CORS 未放行 DELETE"就是这个形状（清单读写仍然正常） */
let deleteNetworkFailure;
/** 只让 PUT 失败，用于探测用例 */
let putStatus;
let putNetworkFailure;
function reset() {
  objects = new Map();
  ops = [];
  readStatus = null;
  deleteStatus = 200;
  networkFailure = false;
  deleteNetworkFailure = false;
  putStatus = 200;
  putNetworkFailure = false;
}
reset();

globalThis.fetch = async (input, init = {}) => {
  if (networkFailure) throw new TypeError("fetch failed");
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
    if (putNetworkFailure) throw new TypeError("fetch failed");
    if (putStatus !== 200) return new Response("Denied", { status: putStatus });
    const body = init.body && typeof init.body.text === "function" ? await init.body.text() : String(init.body);
    objects.set(key, body);
    return new Response(null, { status: 200 });
  }

  if (method === "DELETE") {
    ops.push(`DELETE ${key}`);
    if (deleteNetworkFailure) throw new TypeError("fetch failed");
    if (deleteStatus !== 200) return new Response("Denied", { status: deleteStatus });
    if (!objects.has(key)) {
      return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
    }
    objects.delete(key);
    return new Response(null, { status: 204 });
  }

  ops.push(`GET ${key}`);
  if (readStatus) return new Response("Read error", { status: readStatus });
  return objects.has(key)
    ? new Response(objects.get(key), { status: 200 })
    : new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
};

const manifestMod = await server.ssrLoadModule("/src/lib/albumManifestFetch.ts");
const deleteMod = await server.ssrLoadModule("/src/lib/albumDelete.ts");
const uploadMod = await server.ssrLoadModule("/src/lib/ossUpload.ts");
const signMod = await server.ssrLoadModule("/src/lib/ossSignFetch.ts");
const { buildManifestWithoutAssets, fetchExistingManifestForMerge } = manifestMod;
const { deleteAlbumAsset } = deleteMod;
const { probeUploadAccess } = uploadMod;

/** 种一份含两条的清单：a_keep + a_del，并保留 assetsBasePath 这个顶层额外字段 */
function seed() {
  reset();
  signMod.invalidateSignedUrlCacheForObjectKey(MANIFEST_KEY);
  const doc = {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    assetsBasePath: "/albums/",
    assets: [
      { assetId: "a_keep", zoneId: "public-v1", cipherFile: "albums/assets/a_keep.bin", originalName: "keep.png" },
      { assetId: "a_del", zoneId: "public-v1", cipherFile: "albums/assets/a_del.bin", originalName: "del.png" },
    ],
  };
  objects.set(MANIFEST_KEY, JSON.stringify(doc, null, 2));
  objects.set("albums/assets/a_keep.bin", "KEEP");
  objects.set("albums/assets/a_del.bin", "DEL");
  return doc;
}

const TARGET = { assetId: "a_del", cipherFile: "albums/assets/a_del.bin", originalName: "del.png" };
const manifestOf = () => JSON.parse(objects.get(MANIFEST_KEY));
const idsOf = () => manifestOf().assets.map((a) => a.assetId);

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

console.log("【1】纯函数：从清单移除条目");
await test("移除目标并保留其它条目与顶层额外字段", () => {
  const existing = {
    status: "ok",
    payload: {
      schemaVersion: 1,
      generatedAt: "x",
      extra: { assetsBasePath: "/albums/", customFlag: true },
      assets: [{ assetId: "a" }, { assetId: "b" }],
    },
  };
  const { doc, removedCount, remainingCount } = buildManifestWithoutAssets(existing, ["a"], "NOW");
  assert.equal(removedCount, 1);
  assert.equal(remainingCount, 1);
  assert.deepEqual(doc.assets.map((x) => x.assetId), ["b"]);
  assert.equal(doc.assetsBasePath, "/albums/");
  assert.equal(doc.customFlag, true);
  assert.equal(doc.generatedAt, "NOW");
});
await test("缺少 assetId 的异常条目一律保留（宁可不删也不误删）", () => {
  const existing = {
    status: "ok",
    payload: { schemaVersion: 1, extra: {}, assets: [{ assetId: "a" }, { cipherFile: "x.bin" }] },
  };
  const { doc, removedCount } = buildManifestWithoutAssets(existing, ["a"], "NOW");
  assert.equal(removedCount, 1);
  assert.equal(doc.assets.length, 1);
});
await test("目标不在清单里时 removedCount = 0", () => {
  const existing = { status: "ok", payload: { schemaVersion: 1, extra: {}, assets: [{ assetId: "a" }] } };
  assert.equal(buildManifestWithoutAssets(existing, ["zzz"], "NOW").removedCount, 0);
});

console.log("\n【2】正常删除");
await test("清单移除 + 密文删除，且只影响目标", async () => {
  seed();
  const report = await deleteAlbumAsset(config, TARGET);
  assert.equal(report.manifestWritten, true);
  assert.equal(report.remainingCount, 1);
  assert.equal(report.objectDeleted, true);
  assert.equal(report.objectAlreadyGone, false);
  assert.equal(report.warning, undefined);
  assert.deepEqual(idsOf(), ["a_keep"]);
  assert.equal(manifestOf().assetsBasePath, "/albums/", "顶层额外字段必须保留");
  assert.equal(objects.has("albums/assets/a_del.bin"), false);
  assert.equal(objects.has("albums/assets/a_keep.bin"), true, "不能误删其它对象");
});
await test("执行顺序：先写清单、后删密文 ← 顺序反了会留下悬空引用", async () => {
  seed();
  await deleteAlbumAsset(config, TARGET);
  const putIdx = ops.indexOf(`PUT ${MANIFEST_KEY}`);
  const delIdx = ops.indexOf("DELETE albums/assets/a_del.bin");
  assert.notEqual(putIdx, -1, "应当写过清单");
  assert.notEqual(delIdx, -1, "应当删过密文");
  assert.ok(putIdx < delIdx, `清单写入(${putIdx}) 必须早于密文删除(${delIdx})`);
});

console.log("\n【3】异常路径");
await test("密文本就不在（404）→ 幂等成功", async () => {
  seed();
  objects.delete("albums/assets/a_del.bin");
  const report = await deleteAlbumAsset(config, TARGET);
  // 注意：真实 OSS 的 DeleteObject 对不存在的对象返回 204（幂等），不会给 404。
  // 这里桩故意回 404，用来覆盖"服务端确实回报不存在"这一分支；生产上不依赖它。
  assert.equal(report.objectAlreadyGone, true);
  assert.equal(report.objectDeleted, false);
  assert.equal(report.warning, undefined);
  assert.deepEqual(idsOf(), ["a_keep"]);
});
await test("删除被拒（403，模拟 CORS 未放行 DELETE）→ 相册已移除，但如实报告孤儿对象", async () => {
  seed();
  deleteStatus = 403;
  const report = await deleteAlbumAsset(config, TARGET);
  assert.deepEqual(idsOf(), ["a_keep"], "清单必须已经改好，否则相册会留裂图");
  assert.equal(report.objectDeleted, false);
  assert.match(report.warning ?? "", /孤儿/);
  assert.equal(objects.has("albums/assets/a_del.bin"), true);
});
await test("删除时网络层直接失败（真实浏览器里 DELETE 预检被拒就是这样）→ 不抛出，转为警告", async () => {
  seed();
  deleteNetworkFailure = true;
  const report = await deleteAlbumAsset(config, TARGET);
  deleteNetworkFailure = false;
  assert.equal(report.manifestWritten, true, "清单应已改好");
  assert.equal(report.objectDeleted, false);
  assert.match(report.warning ?? "", /孤儿|CORS/);
  assert.deepEqual(idsOf(), ["a_keep"]);
});
await test("清单读不到（500）→ 中止，且绝不删除任何对象", async () => {
  seed();
  readStatus = 500;
  await assert.rejects(() => deleteAlbumAsset(config, TARGET), /读取现有相册失败|读取现有清单失败/);
  readStatus = null;
  assert.equal(ops.some((o) => o.startsWith("DELETE")), false, "不允许发出任何 DELETE");
  assert.equal(objects.has("albums/assets/a_del.bin"), true);
  assert.deepEqual(idsOf(), ["a_keep", "a_del"], "清单不应被改写");
});
await test("assetId 已不在清单里 → 不改清单，但仍删除对象（保证彻底删除幂等）", async () => {
  seed();
  const doc = manifestOf();
  doc.assets = doc.assets.filter((a) => a.assetId !== "a_del");
  objects.set(MANIFEST_KEY, JSON.stringify(doc, null, 2));
  const report = await deleteAlbumAsset(config, TARGET);
  assert.equal(report.manifestWritten, false);
  assert.equal(report.remainingCount, 1);
  assert.equal(report.objectDeleted, true);
  assert.equal(ops.includes(`PUT ${MANIFEST_KEY}`), false, "没变化就不该写清单");
});
await test("条目没有 OSS 对象（只有本地 src）→ 不报错，给出说明", async () => {
  seed();
  const report = await deleteAlbumAsset(config, {
    assetId: "a_src",
    file: null,
    cipherFile: null,
  });
  assert.equal(report.objectKey, null);
  assert.match(report.warning ?? "", /没有可删除的 OSS 对象/);
});

console.log("\n【4】上传通道探测（probeUploadAccess：先探明再批量上传）");
await test("通道正常：探测成功且探针对象被清理", async () => {
  seed();
  const probe = await probeUploadAccess(config);
  assert.equal(probe.ok, true, probe.message);
  assert.equal(probe.cleanedUp, true);
  assert.equal(
    objects.has("albums/assets/__preflight__.bin"),
    false,
    "探针对象应当已被删除，不能留下垃圾",
  );
  assert.deepEqual(idsOf(), ["a_keep", "a_del"], "探测不得改动清单");
});
await test("写入被拒（PUT 403）→ 明确报失败，不留下探针", async () => {
  seed();
  putStatus = 403;
  const probe = await probeUploadAccess(config);
  putStatus = 200;
  assert.equal(probe.ok, false);
  assert.match(probe.message, /上传通道不可用/);
  assert.equal(objects.has("albums/assets/__preflight__.bin"), false);
});
await test("预检被拒（网络层直接失败，真实浏览器里就是这样）→ 提示去看预检状态", async () => {
  seed();
  putNetworkFailure = true;
  const probe = await probeUploadAccess(config);
  putNetworkFailure = false;
  assert.equal(probe.ok, false);
  assert.match(probe.message, /oss-upload-cors|停用/);
});
await test("未配置凭据 → 直接报缺配置", async () => {
  seed();
  const probe = await probeUploadAccess(null);
  assert.equal(probe.ok, false);
  assert.match(probe.message, /尚未配置/);
});
await test("可用但探针删不掉 → 仍然算可用，并如实提示残留", async () => {
  seed();
  deleteStatus = 403;
  const probe = await probeUploadAccess(config);
  deleteStatus = 200;
  assert.equal(probe.ok, true, "删除失败不该影响'通道可用'的结论");
  assert.equal(probe.cleanedUp, false);
  assert.match(probe.message, /删除失败/);
});

reset();
await server.close();
console.log(`\n======= 通过 ${pass} / 失败 ${fail} =======`);
process.exit(fail ? 1 : 0);

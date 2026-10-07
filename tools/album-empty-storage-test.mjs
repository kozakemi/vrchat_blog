#!/usr/bin/env node
// 使用真实应用模块和内存 OSS，不读取密钥、不修改线上数据。
import assert from "node:assert/strict";
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  resolve: { alias: { "@": new URL("../src", import.meta.url).pathname } },
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: "custom",
  logLevel: "error",
});
const originalFetch = globalThis.fetch;
const config = {
  oss_access_key_id: "test-id",
  oss_access_key_secret: "test-secret",
  oss_endpoint: "oss-cn-beijing.aliyuncs.com",
  oss_bucket_name: "test-bucket",
};
let objects;
let writes;
let readStatus;
let putStatus;
let networkFailure;
let discardWrites;
let signStatus;
function reset() {
  objects = new Map();
  writes = [];
  readStatus = null;
  putStatus = 200;
  networkFailure = false;
  discardWrites = false;
  signStatus = 200;
}
reset();
globalThis.fetch = async (input, init = {}) => {
  if (networkFailure) throw new TypeError("fetch failed");
  const raw = typeof input === "string" ? input : input.url;
  const url = new URL(raw, "https://test.local");
  if (url.searchParams.has("file")) {
    return new Response(JSON.stringify({
      signedUrl: `https://test-bucket.oss-cn-beijing.aliyuncs.com/${url.searchParams.get("file")}`,
    }), { status: signStatus });
  }
  const key = decodeURIComponent(url.pathname.replace(/^\/dev-oss-proxy\/[^/]+/, "").slice(1));
  if (init.method === "PUT") {
    writes.push(key);
    if (putStatus !== 200) return new Response("Denied", { status: putStatus });
    if (!discardWrites) objects.set(key, init.body instanceof Blob ? await init.body.text() : init.body);
    return new Response(null, { status: 200 });
  }
  if (readStatus) return new Response("Read error", { status: readStatus });
  return objects.has(key)
    ? new Response(objects.get(key), { status: 200 })
    : new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
};

try {
  const manifest = await server.ssrLoadModule("/src/lib/albumManifestFetch.ts");
  const storage = await server.ssrLoadModule("/src/lib/albumStorage.ts");
  const upload = await server.ssrLoadModule("/src/lib/ossUpload.ts");
  const signing = await server.ssrLoadModule("/src/lib/ossSignFetch.ts");
  const key = manifest.getManifestObjectKey();
  const test = async (name, run) => {
    reset();
    signing.invalidateSignedUrlCacheForObjectKey(key);
    await run();
    console.log(`✓ ${name}`);
  };

  await test("空桶展示空相册，读取不创建对象", async () => {
    assert.deepEqual((await manifest.fetchAlbumManifestOrThrow()).assets, []);
    assert.equal(objects.size, 0);
    assert.deepEqual(writes, []);
  });
  await test("空桶首次上传自动创建清单及资源前缀，合并后可回读", async () => {
    await storage.ensureAlbumStorageInitialized(config);
    assert.deepEqual(JSON.parse(objects.get(key)).assets, []);
    const assetKey = "albums/assets/test.bin";
    await upload.putObjectWithSignedUrl(
      await upload.resolvePutSignedUrl(assetKey, config), new Uint8Array([1, 2, 3]), "application/octet-stream",
    );
    const row = { assetId: "test", cipherFile: assetKey };
    const { doc, previousCount } = manifest.buildMergedManifest(
      await manifest.fetchExistingManifestForMerge(), [row], new Date().toISOString(),
    );
    assert.equal(previousCount, 0);
    await upload.putObjectWithSignedUrl(
      await upload.resolvePutSignedUrl(key, config, "application/json"),
      new Blob([JSON.stringify(doc)]), "application/json",
    );
    assert.deepEqual((await manifest.fetchAlbumManifestOrThrow()).assets, [row]);
    assert.equal(objects.size, 2);
    const writesBefore = writes.length;
    await storage.ensureAlbumStorageInitialized(config);
    assert.equal(writes.length, writesBefore);
  });
  await test("已有清单不会重建或丢失扩展字段", async () => {
    const original = JSON.stringify({ schemaVersion: 1, assets: [{ assetId: "old" }], custom: "keep" });
    objects.set(key, original);
    await storage.ensureAlbumStorageInitialized(config);
    assert.equal(objects.get(key), original);
    assert.deepEqual(writes, []);
  });
  for (const status of [403, 500]) {
    await test(`HTTP ${status} 不按空桶处理且不写入`, async () => {
      readStatus = status;
      await assert.rejects(manifest.fetchAlbumManifestOrThrow(), new RegExp(String(status)));
      await assert.rejects(storage.ensureAlbumStorageInitialized(config), new RegExp(String(status)));
      assert.deepEqual(writes, []);
    });
  }
  for (const invalid of ["<html>error</html>", "{", '{"wrong":[]}']) {
    await test("损坏清单不覆盖", async () => {
      objects.set(key, invalid);
      await assert.rejects(storage.ensureAlbumStorageInitialized(config));
      assert.equal(objects.get(key), invalid);
      assert.deepEqual(writes, []);
    });
  }
  await test("网络失败不初始化", async () => {
    networkFailure = true;
    await assert.rejects(storage.ensureAlbumStorageInitialized(config));
    assert.deepEqual(writes, []);
  });
  await test("签名服务 404 不误判为桶为空", async () => {
    signStatus = 404;
    await assert.rejects(storage.ensureAlbumStorageInitialized(config), /404/);
    assert.deepEqual(writes, []);
  });
  await test("初始化 PUT 失败向上报告，不继续上传", async () => {
    putStatus = 403;
    await assert.rejects(storage.ensureAlbumStorageInitialized(config), /403/);
    assert.equal(objects.size, 0);
  });
  await test("初始化后必须能回读清单", async () => {
    discardWrites = true;
    await assert.rejects(storage.ensureAlbumStorageInitialized(config), /初始化后仍不可读取/);
  });
} finally {
  globalThis.fetch = originalFetch;
  await server.close();
}

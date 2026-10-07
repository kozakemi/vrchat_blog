#!/usr/bin/env node
/**
 * 相册 Zone 权限判定的回归测试（不联网、不读密钥、不写任何数据）。
 *
 * 起因是一个真实缺陷：私有区（如 vault-v1）的照片，在换成"只含公开区"的
 * 密钥文件后仍然显示。根因有两条，本测试逐条锁死：
 *   1. 查解密缓存排在鉴权之前 —— 缓存里放的是**已解密的明文**；
 *   2. 缓存是模块级 Map，退出登录/换密钥后依然存活。
 *
 * 用法：node tools/album-access-test.mjs
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

const access = await server.ssrLoadModule("/src/lib/albumAccess.ts");
const blob = await server.ssrLoadModule("/src/lib/albumBlobCache.ts");

const { checkAssetAccess, filterAccessibleAssets } = access;
const {
  albumBlobCacheSize,
  blobCacheObjectKey,
  clearAlbumBlobCache,
  getAuthorizedCachedBlobUrl,
  putAlbumBlobUrl,
  sessionFingerprint,
  syncAlbumBlobCacheToSession,
} = blob;

const PUBLIC_ZONES = [
  { zoneId: "public-v1", keyB64: "cHVibGljLWtleS0zMi1ieXRlcy1sb25nISEhISE=", comment: "公开区" },
];
const FULL_ZONES = [
  ...PUBLIC_ZONES,
  { zoneId: "vault-v1", keyB64: "dmF1bHQta2V5LTMyLWJ5dGVzLWxvbmchISEhISE=", comment: "核心区" },
];

const VAULT_ASSET = {
  assetId: "a_vault",
  zoneId: "vault-v1",
  cipherFile: "albums/assets/a_vault.bin",
};
const PUBLIC_ASSET = {
  assetId: "a_public",
  zoneId: "public-v1",
  cipherFile: "albums/assets/a_public.bin",
};
const LEGACY_PLAINTEXT = { assetId: "a_legacy", file: "VRChat/old.png" };

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

console.log("【1】单资源权限判定");
check("公开区资源 + 公开区密钥 → 允许", () =>
  assert.equal(checkAssetAccess(PUBLIC_ASSET, PUBLIC_ZONES).allowed, true));
check("私有区资源 + 只有公开区密钥 → 拒绝", () => {
  const d = checkAssetAccess(VAULT_ASSET, PUBLIC_ZONES);
  assert.equal(d.allowed, false);
  assert.match(d.reason, /vault-v1/);
});
check("私有区资源 + 含私有区密钥 → 允许，并取到该区密钥", () => {
  const d = checkAssetAccess(VAULT_ASSET, FULL_ZONES);
  assert.equal(d.allowed, true);
  assert.equal(d.zoneKeyB64, FULL_ZONES[1].keyB64);
});
check("空密钥会话 → 拒绝", () => assert.equal(checkAssetAccess(VAULT_ASSET, []).allowed, false));
check("密文资源缺 zoneId → 拒绝（无从判断归属）", () =>
  assert.equal(
    checkAssetAccess({ assetId: "x", cipherFile: "albums/assets/x.bin" }, FULL_ZONES).allowed,
    false,
  ));
check("声明了 Zone 的明文资源同样受约束 → 拒绝", () =>
  assert.equal(
    checkAssetAccess({ assetId: "y", zoneId: "vault-v1", file: "a/b.png" }, PUBLIC_ZONES).allowed,
    false,
  ));
check("早期格式：无 Zone 的明文资源 → 允许", () => {
  const d = checkAssetAccess(LEGACY_PLAINTEXT, PUBLIC_ZONES);
  assert.equal(d.allowed, true);
  assert.equal(d.zoneKeyB64, null);
});

console.log("\n【2】列表过滤（避免连文件名/时间都暴露）");
check("只保留有权资源", () => {
  const out = filterAccessibleAssets([VAULT_ASSET, PUBLIC_ASSET, LEGACY_PLAINTEXT], PUBLIC_ZONES);
  assert.deepEqual(
    out.map((a) => a.assetId),
    ["a_public", "a_legacy"],
  );
});
check("含私有区密钥时全部保留", () =>
  assert.equal(filterAccessibleAssets([VAULT_ASSET, PUBLIC_ASSET], FULL_ZONES).length, 2));

console.log("\n【3】解密缓存不得绕过鉴权（本次漏洞的回归测试）");
clearAlbumBlobCache();
check("先把私有区图片放进缓存（模拟用管理员密钥看过）", () => {
  putAlbumBlobUrl(blobCacheObjectKey(VAULT_ASSET), "blob:fake-vault-plaintext", {
    width: 1920,
    height: 1080,
  });
  assert.equal(albumBlobCacheSize(), 1);
});
check("换成只有公开区的密钥后，缓存不再被取用 ← 修复前此处会泄露", () =>
  assert.equal(getAuthorizedCachedBlobUrl(VAULT_ASSET, PUBLIC_ZONES), undefined));
check("空会话下同样取不到", () => assert.equal(getAuthorizedCachedBlobUrl(VAULT_ASSET, []), undefined));
check("持有私有区密钥时才允许命中缓存", () =>
  assert.equal(
    getAuthorizedCachedBlobUrl(VAULT_ASSET, FULL_ZONES)?.objectUrl,
    "blob:fake-vault-plaintext",
  ));
check("命中缓存时同时带回解析结果（尺寸不再退化为未知）", () => {
  const hit = getAuthorizedCachedBlobUrl(VAULT_ASSET, FULL_ZONES);
  assert.equal(hit?.meta?.width, 1920);
  assert.equal(hit?.meta?.height, 1080);
});

console.log("\n【4】会话变化必须整体作废缓存");
check("同一会话反复同步 → 缓存保留", () => {
  clearAlbumBlobCache();
  const fp = sessionFingerprint("kozakemi", FULL_ZONES);
  syncAlbumBlobCacheToSession(fp);
  putAlbumBlobUrl("albums/assets/a_x.bin", "blob:fake-x");
  syncAlbumBlobCacheToSession(fp);
  assert.equal(albumBlobCacheSize(), 1);
});
check("换成别的密钥文件 → 缓存清空", () => {
  syncAlbumBlobCacheToSession(sessionFingerprint("kozakemi", PUBLIC_ZONES));
  assert.equal(albumBlobCacheSize(), 0);
});
check("退出登录（空会话）→ 缓存清空", () => {
  putAlbumBlobUrl("albums/assets/a_y.bin", "blob:fake-y");
  assert.equal(albumBlobCacheSize(), 1);
  syncAlbumBlobCacheToSession(sessionFingerprint(undefined, undefined));
  assert.equal(albumBlobCacheSize(), 0);
});
check("显式 clearAlbumBlobCache() → 缓存清空", () => {
  putAlbumBlobUrl("albums/assets/a_z.bin", "blob:fake-z");
  clearAlbumBlobCache();
  assert.equal(albumBlobCacheSize(), 0);
});
check("会话指纹区分不同密钥（同 zoneId 不同 keyB64）", () => {
  const a = sessionFingerprint("u", [{ zoneId: "z", keyB64: "AAA=" }]);
  const b = sessionFingerprint("u", [{ zoneId: "z", keyB64: "BBB=" }]);
  assert.notEqual(a, b);
});

console.log("\n【5】缓存主键");
check("有 file 时用 file", () =>
  assert.equal(blobCacheObjectKey({ file: " a/b.png ", cipherFile: "c.bin" }), "a/b.png"));
check("无 file 时用 cipherFile", () =>
  assert.equal(blobCacheObjectKey({ cipherFile: " c.bin " }), "c.bin"));
check("都没有则为空串", () => assert.equal(blobCacheObjectKey({}), ""));

clearAlbumBlobCache();
await server.close();

console.log(`\n======= 通过 ${pass} / 失败 ${fail} =======`);
process.exit(fail ? 1 : 0);

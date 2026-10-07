#!/usr/bin/env node
/**
 * 明文 Blob 缓存的回归测试（`src/lib/albumBlobCache.ts`）。
 *
 * 这个缓存里存的是**解密后的明文图片**，所以它的两个属性都不是"优化"，而是正确性问题：
 *
 *   1. **内存按字节封顶**。早先只按「180 张」封顶，而线上相册是 157 张共 466 MB
 *      （平均 2.97 MB/张）—— 滚完一遍就是 ~500 MB 常驻内存，移动端会被直接杀掉标签页。
 *      这里同时验证字节闸门、LRU 顺序、以及"单张超大图不会被立刻扔掉"（否则会变成
 *      存进去就淘汰的无限重下循环）。
 *   2. **并发取同一张图只下载一次**。同一张图可能同时挂在网格卡片与灯箱大图里，
 *      两边查缓存都 miss；不去重就会把 3 MB 的密文下两遍，而且后完成的会覆盖缓存条目，
 *      让先完成那条的 Blob URL 再也没人回收（泄漏到页面关闭）。
 *
 * 另外锁住一条安全不变量：**会话在下载/解密途中变化时，那份属于旧会话的明文
 * 绝不能落进新会话的缓存**（否则就是"用管理员密钥看过的私密照片，换成公开区密钥
 * 后仍从缓存显示"那类漏洞的翻版）。
 *
 * 用法：node tools/album-blob-cache-test.mjs
 */

import assert from "node:assert/strict";
import { createServer } from "vite";

// 记录 revoke 调用：Node 没有 URL.revokeObjectURL，装一个桩才能断言"回收了没有"
const revoked = [];
globalThis.URL.revokeObjectURL = (objectUrl) => revoked.push(objectUrl);

const server = await createServer({
  configFile: false,
  resolve: { alias: { "@": new URL("../src", import.meta.url).pathname } },
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: "custom",
  logLevel: "error",
  optimizeDeps: { noDiscovery: true, include: [] },
});

const mod = await server.ssrLoadModule("/src/lib/albumBlobCache.ts");
const {
  albumBlobCacheBytes,
  albumBlobCacheSize,
  albumBlobInFlightCount,
  clearAlbumBlobCache,
  getAuthorizedCachedBlobUrl,
  loadAlbumBlobUrlOnce,
  putAlbumBlobUrl,
  removeAlbumBlobUrl,
} = mod;

const MB = 1024 * 1024;
/** 与实现里的 BLOB_BYTES_MAX 保持一致（改实现时这里也要改，测试会提醒你） */
const BYTES_MAX = 128 * MB;
/** 线上真实均值：157 张共 465.9 MB */
const AVG_IMAGE = 2.97 * MB;

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

const reset = () => {
  clearAlbumBlobCache();
  revoked.length = 0;
};
const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * 某个对象键是否还在缓存里。
 * 用 `file` 而不是 `cipherFile` 传键：没有声明 zoneId 的条目会被视为有权查看，
 * 于是不必构造会话就能探测缓存（这正是 getAuthorizedCachedBlobUrl 的鉴权分支）。
 */
const cached = (objectKey) =>
  Boolean(getAuthorizedCachedBlobUrl({ assetId: "probe", file: objectKey }, []));

// ---------------------------------------------------------------------------

console.log("【1】内存按字节封顶（而不是只按张数）");
await test("★ 灌入线上体量（157 张 × 2.97 MB）后，占用必须停在字节上限内", () => {
  reset();
  for (let i = 0; i < 157; i++) {
    putAlbumBlobUrl(`albums/assets/a_${i}.bin`, `blob:${i}`, undefined, AVG_IMAGE);
  }
  const bytes = albumBlobCacheBytes();
  assert.ok(
    bytes <= BYTES_MAX,
    `占用 ${(bytes / MB).toFixed(1)} MB 超过上限 ${BYTES_MAX / MB} MB —— 这就是"标签页被系统杀掉"的来源`,
  );
  // 上限 / 均值 ≈ 43 张，允许少量出入
  assert.ok(
    albumBlobCacheSize() >= 40 && albumBlobCacheSize() <= 46,
    `保留条数 ${albumBlobCacheSize()} 不合理（预期约 43）`,
  );
  console.log(
    `      → 157 张灌完只留 ${albumBlobCacheSize()} 张、${(bytes / MB).toFixed(1)} MB ` +
      `（改前是 157 张 ≈ ${((157 * AVG_IMAGE) / MB).toFixed(0)} MB）`,
  );
});
await test("字节账目与逐条相加一致（不会算漏导致淘汰失效）", () => {
  reset();
  putAlbumBlobUrl("albums/assets/x1.bin", "blob:x1", undefined, 10 * MB);
  putAlbumBlobUrl("albums/assets/x2.bin", "blob:x2", undefined, 20 * MB);
  assert.equal(albumBlobCacheBytes(), 30 * MB);
  removeAlbumBlobUrl("albums/assets/x1.bin");
  assert.equal(albumBlobCacheBytes(), 20 * MB, "删掉一条要把它占的字节减掉");
  clearAlbumBlobCache();
  assert.equal(albumBlobCacheBytes(), 0);
  assert.equal(albumBlobCacheSize(), 0);
});
await test("淘汰顺序是最久未使用优先（保留最近用到的）", () => {
  reset();
  // 60 × 3 MB = 180 MB > 上限 128 MB → 一定会淘汰
  for (let i = 0; i < 60; i++) {
    putAlbumBlobUrl(`albums/assets/lru_${i}.bin`, `blob:${i}`, undefined, 3 * MB);
  }
  assert.ok(albumBlobCacheSize() < 60, "已经超过字节上限，必须淘汰过");
  assert.ok(albumBlobCacheBytes() <= BYTES_MAX);
  assert.equal(cached("albums/assets/lru_0.bin"), false, "最久未使用的应当已被淘汰");
  assert.equal(cached("albums/assets/lru_59.bin"), true, "最近写入的必须还在");
});
await test("单张就超过字节上限时仍然保留它（否则是「存进去立刻被扔掉」的无限重下）", () => {
  reset();
  putAlbumBlobUrl("albums/assets/huge.bin", "blob:huge", undefined, 200 * MB);
  assert.equal(albumBlobCacheSize(), 1, "唯一的条目不能被淘汰，否则每次取图都要重下");
  assert.equal(albumBlobCacheBytes(), 200 * MB, "占用如实记账（界面上不可见，但排查要看）");

  // 再塞正常图：超大的那张变成最久未使用，会被淘汰，占用回到上限内
  for (let i = 0; i < 50; i++) {
    putAlbumBlobUrl(`albums/assets/n_${i}.bin`, `blob:n${i}`, undefined, 2 * MB);
  }
  assert.equal(cached("albums/assets/huge.bin"), false, "超大条目应当在有替代品后被淘汰");
  assert.ok(albumBlobCacheBytes() <= BYTES_MAX, `占用 ${(albumBlobCacheBytes() / MB).toFixed(1)} MB 应回到上限内`);
  assert.equal(cached("albums/assets/n_49.bin"), true);
});
await test("条数闸门仍然生效（180 张的兜底）", () => {
  reset();
  for (let i = 0; i < 300; i++) {
    putAlbumBlobUrl(`albums/assets/t_${i}.bin`, `blob:t${i}`, undefined, 1024); // 总量远小于字节上限
  }
  assert.ok(albumBlobCacheSize() <= 180, `条数 ${albumBlobCacheSize()} 超过 180 的兜底`);
});

console.log("\n【2】同键重复写入不能泄漏旧的 Blob URL");
await test("同一对象键写两次 → 旧 URL 被 revoke", () => {
  reset();
  putAlbumBlobUrl("albums/assets/same.bin", "blob:first", undefined, MB);
  putAlbumBlobUrl("albums/assets/same.bin", "blob:second", undefined, MB);
  assert.deepEqual(revoked, ["blob:first"], "被顶掉的 URL 必须回收");
  assert.equal(albumBlobCacheBytes(), MB, "字节不能重复计");
});

console.log("\n【3】并发取同一张图只下载一次");
await test("★ 同一 objectKey 的两个并发调用，producer 只跑一次", async () => {
  reset();
  let runs = 0;
  const producer = () => {
    runs++;
    return new Promise((resolve) => setTimeout(() => resolve({ objectUrl: "blob:shared", bytes: 3 * MB }), 5));
  };
  const [a, b] = await Promise.all([
    loadAlbumBlobUrlOnce("albums/assets/p.bin", producer),
    loadAlbumBlobUrlOnce("albums/assets/p.bin", producer),
  ]);
  assert.equal(runs, 1, `producer 跑了 ${runs} 次 —— 等于把 3 MB 的密文下了两遍`);
  assert.equal(a.objectUrl, b.objectUrl, "两个调用方必须拿到同一个 Blob URL");
  assert.equal(albumBlobCacheSize(), 1);
  assert.equal(albumBlobCacheBytes(), 3 * MB);
});
await test("不同 objectKey 的并发互不影响，各跑一次", async () => {
  reset();
  let runs = 0;
  const producer = (url) => () => {
    runs++;
    return Promise.resolve({ objectUrl: url, bytes: MB });
  };
  await Promise.all([
    loadAlbumBlobUrlOnce("albums/assets/k1.bin", producer("blob:k1")),
    loadAlbumBlobUrlOnce("albums/assets/k2.bin", producer("blob:k2")),
  ]);
  assert.equal(runs, 2);
  assert.equal(albumBlobCacheSize(), 2);
});
await test("完成之后是缓存命中，producer 不再执行", async () => {
  reset();
  let runs = 0;
  const producer = () => {
    runs++;
    return Promise.resolve({ objectUrl: "blob:once", bytes: MB });
  };
  await loadAlbumBlobUrlOnce("albums/assets/once.bin", producer);
  const again = await loadAlbumBlobUrlOnce("albums/assets/once.bin", producer);
  assert.equal(runs, 1, "第二次应当直接命中缓存");
  assert.equal(again.objectUrl, "blob:once");
  assert.equal(again.bytes, MB, "命中缓存也要带上体积，界面与统计都要用");
});
await test("producer 失败后 in-flight 必须清掉，否则永远重试不了", async () => {
  reset();
  let runs = 0;
  const bad = () => {
    runs++;
    return Promise.reject(new Error("boom"));
  };
  await assert.rejects(() => loadAlbumBlobUrlOnce("albums/assets/bad.bin", bad), /boom/);
  await tick();
  assert.equal(albumBlobInFlightCount(), 0, "失败的任务留在 in-flight 表里会让这个键永久卡死");
  await assert.rejects(() => loadAlbumBlobUrlOnce("albums/assets/bad.bin", bad), /boom/);
  assert.equal(runs, 2, "第二次应当真的重新尝试");
});
await test("in-flight 期间缓存里还没有东西（不会把半成品暴露给别处）", async () => {
  reset();
  let release;
  const p = loadAlbumBlobUrlOnce(
    "albums/assets/wait.bin",
    () => new Promise((r) => { release = r; }),
  );
  await tick();
  assert.equal(albumBlobCacheSize(), 0);
  assert.equal(albumBlobInFlightCount(), 1);
  release({ objectUrl: "blob:wait", bytes: MB });
  await p;
  assert.equal(albumBlobCacheSize(), 1);
  assert.equal(albumBlobInFlightCount(), 0);
});

console.log("\n【4】会话在途中变化：旧会话的明文绝不能进新会话的缓存");
await test("★ 下载/解密途中清空缓存（=换会话）→ 结果作废、URL 被回收、不入缓存", async () => {
  reset();
  let release;
  const pending = loadAlbumBlobUrlOnce(
    "albums/assets/epoch.bin",
    () => new Promise((r) => { release = r; }),
  );
  await tick();

  clearAlbumBlobCache(); // 换密钥文件 / 退出登录
  release({ objectUrl: "blob:stale-session-plaintext", bytes: 5 * MB });

  await assert.rejects(() => pending, /会话已变化/);
  assert.ok(
    revoked.includes("blob:stale-session-plaintext"),
    "作废的明文 Blob 必须被 revoke，不能留在内存里",
  );
  assert.equal(albumBlobCacheSize(), 0, "上一个会话的明文绝不能落进新会话的缓存");
  assert.equal(albumBlobCacheBytes(), 0);
});
await test("换会话后再取同一张图 → 重新跑 producer，拿到新会话的结果", async () => {
  reset();
  await loadAlbumBlobUrlOnce("albums/assets/re.bin", () =>
    Promise.resolve({ objectUrl: "blob:old", bytes: MB }),
  );
  clearAlbumBlobCache();
  const fresh = await loadAlbumBlobUrlOnce("albums/assets/re.bin", () =>
    Promise.resolve({ objectUrl: "blob:new", bytes: MB }),
  );
  assert.equal(fresh.objectUrl, "blob:new");
  assert.equal(albumBlobCacheSize(), 1);
});

console.log("\n【5】不传体积时的降级（老调用点与假 URL）");
await test("bytes 缺省按 0 记，不抛错、也不影响命中", () => {
  reset();
  putAlbumBlobUrl("albums/assets/nobytes.bin", "blob:nobytes");
  assert.equal(albumBlobCacheBytes(), 0, "无体积可算时按 0，只会让字节闸门少算一点");
  assert.equal(albumBlobCacheSize(), 1);
});
await test("空对象键直接拒绝，不会污染缓存", async () => {
  reset();
  await assert.rejects(() => loadAlbumBlobUrlOnce("   ", () => Promise.resolve({ objectUrl: "blob:x" })));
  assert.equal(albumBlobCacheSize(), 0);
});

reset();
delete globalThis.URL.revokeObjectURL;
await server.close();
console.log(`\n======= 通过 ${pass} / 失败 ${fail} =======`);
process.exit(fail ? 1 : 0);

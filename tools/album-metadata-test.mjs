#!/usr/bin/env node
/**
 * 「解析结果合并」的回归测试（不联网）。
 *
 * 背景：这段合并此前内联在 React 组件里，用 `{ takenAt, world }` **重建**对象，
 * 把 width/height/encrypted/decryptKeyFp 全部丢掉——功能其实跑通了，只是结果被扔了，
 * 于是界面上"尺寸"和"本次解密密钥指纹"永远显示未知。同一个坑已踩过两次，故加此测试。
 *
 * 关键守则：**只要有一个字段被漏掉（合并漏掉、或等价判断漏掉），这里就会红。**
 *
 * 用法：node tools/album-metadata-test.mjs
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
const { mergeResolvedMetadata, resolvedMetadataEquals } = await server.ssrLoadModule(
  "/src/lib/albumResolvedMeta.ts",
);

/** 一次典型的"密文解密成功"解析结果 */
const CIPHER_RESULT = {
  takenAt: "2026-02-08T00:14:21.901",
  width: 1920,
  height: 1080,
  encrypted: true,
  decryptKeyFp: "3444785c",
  world: { worldId: "wrld_abc", worldName: "某世界" },
};

let pass = 0;
let fail = 0;
const test = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`);
  }
};

console.log("【1】合并不能丢字段（这正是此前显示「未解密/未知」的原因）");
test("首次合并：所有字段都写进去", () => {
  const out = mergeResolvedMetadata(undefined, CIPHER_RESULT);
  assert.equal(out.width, 1920);
  assert.equal(out.height, 1080);
  assert.equal(out.encrypted, true);
  assert.equal(out.decryptKeyFp, "3444785c");
  assert.equal(out.takenAt, CIPHER_RESULT.takenAt);
  assert.deepEqual(out.world, CIPHER_RESULT.world);
});
test("后续只带 takenAt 的解析不会抹掉尺寸与指纹", () => {
  const first = mergeResolvedMetadata(undefined, CIPHER_RESULT);
  const second = mergeResolvedMetadata(first, { takenAt: "2026-02-08T00:14:21.901" });
  assert.equal(second.width, 1920, "width 被抹掉了");
  assert.equal(second.height, 1080, "height 被抹掉了");
  assert.equal(second.encrypted, true, "encrypted 被抹掉了");
  assert.equal(second.decryptKeyFp, "3444785c", "decryptKeyFp 被抹掉了");
});
test("新值优先：重新解密得到不同指纹时应覆盖", () => {
  const first = mergeResolvedMetadata(undefined, CIPHER_RESULT);
  const out = mergeResolvedMetadata(first, { decryptKeyFp: "aabbccdd", encrypted: true });
  assert.equal(out.decryptKeyFp, "aabbccdd");
  assert.equal(out.width, 1920, "未提供的字段应保留");
});
test("明文对象：encrypted=false 必须被认真写入，而不是当成空值", () => {
  const out = mergeResolvedMetadata(undefined, { encrypted: false, width: 64, height: 64 });
  assert.equal(out.encrypted, false);
  assert.equal(out.decryptKeyFp, undefined);
});
test("world 缺省时补 null（而非 undefined）", () => {
  const out = mergeResolvedMetadata(undefined, {});
  assert.equal(out.world.worldId, null);
  assert.equal(out.world.worldName, null);
});
test("takenAt 为空串时沿用旧值", () => {
  const out = mergeResolvedMetadata({ takenAt: "OLD" }, { takenAt: "" });
  assert.equal(out.takenAt, "OLD");
});

console.log("\n【2】等价判断必须覆盖每一个字段（漏一个就会导致更新被跳过）");
test("完全相同 → 等价", () => {
  const a = mergeResolvedMetadata(undefined, CIPHER_RESULT);
  assert.equal(resolvedMetadataEquals(a, mergeResolvedMetadata(undefined, CIPHER_RESULT)), true);
});
const FIELD_MUTATIONS = [
  ["takenAt", { takenAt: "别的" }],
  ["width", { width: 2048 }],
  ["height", { height: 1440 }],
  ["encrypted", { encrypted: false }],
  ["decryptKeyFp", { decryptKeyFp: "deadbeef" }],
  ["world.worldId", { world: { worldId: "wrld_other", worldName: "某世界" } }],
  ["world.worldName", { world: { worldId: "wrld_abc", worldName: "别的世界" } }],
];
for (const [label, patch] of FIELD_MUTATIONS) {
  test(`改变 ${label} 后必须判定为"不等"（否则界面不会更新）`, () => {
    const a = mergeResolvedMetadata(undefined, CIPHER_RESULT);
    const b = mergeResolvedMetadata(a, patch);
    assert.equal(
      resolvedMetadataEquals(a, b),
      false,
      `字段 ${label} 没有参与等价判断，改动它不会触发界面更新`,
    );
  });
}
test("未记录的 old 与新结果比较：不同即不等", () => {
  assert.equal(resolvedMetadataEquals(undefined, mergeResolvedMetadata(undefined, CIPHER_RESULT)), false);
});

await server.close();
console.log(`\n======= 通过 ${pass} / 失败 ${fail} =======`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
/**
 * 「Zone 显示开关」的回归测试（纯内存，不联网、不碰浏览器）。
 *
 * 这个功能**只是界面筛选**，所以测试要锁死的不是"能不能筛掉"，而是两件更容易做错的事：
 *
 *   1. **开关永远不能把无权资源放出来。** 判定链是「先鉴权（filterAccessibleAssets）、
 *      后筛选（applyZoneVisibility）」，第二层只做减法。哪怕存储里把 vault-v1 写成
 *      true，没有该密钥的会话也不该多看到一张。
 *   2. **存储里不能出现密钥字节。** 作用域只用「用户名 + Zone id 集合」区分密钥文件，
 *      不需要把 keyB64 再抄一份到 localStorage。
 *
 * 另外覆盖：默认全可见、损坏数据不崩、隐私模式下静默降级、老条目（无 zoneId）不受控。
 *
 * 用法：node tools/zone-visibility-test.mjs
 */

import assert from "node:assert/strict";
import { createServer } from "vite";

// ---- localStorage 桩（必须在调用任何函数之前装好）--------------------------
class MemoryStorage {
  #map = new Map();
  get length() {
    return this.#map.size;
  }
  getItem(key) {
    return this.#map.has(key) ? this.#map.get(key) : null;
  }
  setItem(key, value) {
    this.#map.set(String(key), String(value));
  }
  removeItem(key) {
    this.#map.delete(key);
  }
  clear() {
    this.#map.clear();
  }
  key(i) {
    return [...this.#map.keys()][i] ?? null;
  }
  /** 测试用：直接读原始字符串 */
  raw(key) {
    return this.#map.get(key) ?? null;
  }
}

globalThis.localStorage = new MemoryStorage();

const server = await createServer({
  configFile: false,
  resolve: { alias: { "@": new URL("../src", import.meta.url).pathname } },
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: "custom",
  logLevel: "error",
  optimizeDeps: { noDiscovery: true, include: [] },
});

const visMod = await server.ssrLoadModule("/src/lib/zoneVisibility.ts");
const accessMod = await server.ssrLoadModule("/src/lib/albumAccess.ts");
const localMod = await server.ssrLoadModule("/src/lib/localStore.ts");

const {
  ZONE_VISIBILITY_STORAGE_KEY,
  applyZoneVisibility,
  buildZoneFilterOptions,
  clearZoneVisibility,
  countAssetsByZone,
  isZoneVisible,
  loadZoneVisibility,
  saveZoneVisibility,
  zoneVisibilityScope,
} = visMod;
const { filterAccessibleAssets } = accessMod;

const PUBLIC_KEY = "qIbccWS8pHQB4jIGWO8Q4woXShP6NlQeXsbaAe3KXFM=";
const VAULT_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const ZONES_ADMIN = [
  { zoneId: "public-v1", keyB64: PUBLIC_KEY, comment: "公开区" },
  { zoneId: "vault-v1", keyB64: VAULT_KEY, comment: "核心区" },
];
const ZONES_GUEST = [{ zoneId: "public-v1", keyB64: PUBLIC_KEY }];

const ASSETS = [
  { assetId: "a_pub1", zoneId: "public-v1" },
  { assetId: "a_pub2", zoneId: "public-v1" },
  { assetId: "a_vault", zoneId: "vault-v1" },
  { assetId: "a_legacy" }, // 老条目：没有 zoneId
];

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

/** 每个用例都从干净的 localStorage 开始，避免互相影响 */
function resetStorage() {
  globalThis.localStorage = new MemoryStorage();
}

// ---------------------------------------------------------------------------

console.log("【1】作用域：按「用户名 + Zone 集合」隔离");
await test("同一用户 + 同一 Zone 集合 → 同一作用域", () => {
  const a = zoneVisibilityScope("Kozakemi", ZONES_ADMIN);
  const b = zoneVisibilityScope("Kozakemi", [...ZONES_ADMIN].reverse());
  assert.equal(a, b, "Zone 顺序不应影响作用域");
});
await test("Zone 集合不同 / 用户名不同 → 作用域不同", () => {
  const base = zoneVisibilityScope("Kozakemi", ZONES_ADMIN);
  assert.notEqual(base, zoneVisibilityScope("Kozakemi", ZONES_GUEST));
  assert.notEqual(base, zoneVisibilityScope("Guest", ZONES_ADMIN));
  assert.notEqual(base, zoneVisibilityScope(undefined, ZONES_ADMIN));
});
await test("作用域里不含任何密钥字节（不该把 keyB64 抄进 localStorage）", () => {
  const scope = zoneVisibilityScope("Kozakemi", ZONES_ADMIN);
  assert.equal(scope.includes(PUBLIC_KEY), false);
  assert.equal(scope.includes(VAULT_KEY), false);
  assert.equal(scope.includes("qIbccWS8"), false);
  assert.match(scope, /^Kozakemi\|public-v1,vault-v1$/);
});
await test("保存之后，落盘的整份内容里也没有密钥字节", () => {
  resetStorage();
  const scope = zoneVisibilityScope("Kozakemi", ZONES_ADMIN);
  saveZoneVisibility(scope, { "public-v1": false, "vault-v1": true });
  const raw = globalThis.localStorage.raw(ZONE_VISIBILITY_STORAGE_KEY);
  assert.ok(raw, "应当写入了存储");
  assert.equal(raw.includes(PUBLIC_KEY), false, "存储内容不该含公开区密钥");
  assert.equal(raw.includes(VAULT_KEY), false, "存储内容不该含核心区密钥");
});

console.log("\n【2】默认值：没设置过就是全部显示");
await test("没有存储时，所有 Zone 都是可见的", () => {
  resetStorage();
  const vis = loadZoneVisibility(zoneVisibilityScope("Kozakemi", ZONES_ADMIN), ZONES_ADMIN);
  assert.deepEqual(vis, { "public-v1": true, "vault-v1": true });
  assert.equal(isZoneVisible(vis, "public-v1"), true);
});
await test("isZoneVisible：默认可见，只有显式 false 才隐藏", () => {
  assert.equal(isZoneVisible({}, "public-v1"), true, "没记录 → 可见");
  assert.equal(isZoneVisible({ "public-v1": true }, "public-v1"), true);
  assert.equal(isZoneVisible({ "public-v1": false }, "public-v1"), false);
  assert.equal(isZoneVisible({ "public-v1": false }, "other-v1"), true, "其它 Zone 不受影响");
});
await test("没有 zoneId 的老条目不受开关控制（不属于任何 Zone）", () => {
  const vis = { "public-v1": false, "vault-v1": false };
  assert.equal(isZoneVisible(vis, undefined), true);
  assert.equal(isZoneVisible(vis, null), true);
  assert.equal(isZoneVisible(vis, ""), true);
  assert.equal(isZoneVisible(vis, "  "), true);
});

console.log("\n【3】保存与读回");
await test("关掉一个 Zone 后能读回同样的状态", () => {
  resetStorage();
  const scope = zoneVisibilityScope("Kozakemi", ZONES_ADMIN);
  saveZoneVisibility(scope, { "public-v1": true, "vault-v1": false });

  const vis = loadZoneVisibility(scope, ZONES_ADMIN);
  assert.equal(vis["vault-v1"], false);
  assert.equal(vis["public-v1"], true);
  assert.equal(isZoneVisible(vis, "vault-v1"), false);
});
await test("clearZoneVisibility 之后回到「默认全可见」", () => {
  resetStorage();
  const scope = zoneVisibilityScope("Kozakemi", ZONES_ADMIN);
  saveZoneVisibility(scope, { "public-v1": false, "vault-v1": false });
  clearZoneVisibility(scope);
  const vis = loadZoneVisibility(scope, ZONES_ADMIN);
  assert.deepEqual(vis, { "public-v1": true, "vault-v1": true });
});
await test("存储里残留的陌生 Zone 会被丢弃（不串味到别的密钥文件）", () => {
  resetStorage();
  const adminScope = zoneVisibilityScope("Kozakemi", ZONES_ADMIN);
  saveZoneVisibility(adminScope, { "public-v1": true, "vault-v1": false });

  // 换成只有公开区的密钥文件：作用域不同，读出来一定是全新默认值
  const guestScope = zoneVisibilityScope("Kozakemi", ZONES_GUEST);
  const guestVis = loadZoneVisibility(guestScope, ZONES_GUEST);
  assert.deepEqual(guestVis, { "public-v1": true }, "不该继承上一条记录里的隐藏设置");
  assert.equal("vault-v1" in guestVis, false, "不再持有的 Zone 不该出现在结果里");
});
await test("同一个作用域下，存储里多余的 zoneId 不会影响结果", () => {
  resetStorage();
  const scope = zoneVisibilityScope("Kozakemi", ZONES_GUEST);
  saveZoneVisibility(scope, { "public-v1": true, "ghost-v1": false });
  const vis = loadZoneVisibility(scope, ZONES_GUEST);
  assert.deepEqual(vis, { "public-v1": true });
});

console.log("\n【4】安全性：开关只能做减法，永远不能放出无权资源");
await test("没有 vault-v1 密钥的会话：即使开关写着 true，也看不到 vault 的照片", () => {
  const accessible = filterAccessibleAssets(ASSETS, ZONES_GUEST);
  assert.deepEqual(
    accessible.map((a) => a.assetId),
    ["a_pub1", "a_pub2", "a_legacy"],
    "鉴权层先挡住 vault",
  );

  // 恶意/损坏的开关：把 vault 显式设为 true
  const vis = { "public-v1": true, "vault-v1": true };
  const shown = applyZoneVisibility(accessible, vis);
  assert.equal(
    shown.some((a) => a.zoneId === "vault-v1"),
    false,
    "开关层不能凭空多出资源",
  );
  assert.deepEqual(shown.map((a) => a.assetId), ["a_pub1", "a_pub2", "a_legacy"]);
});
await test("关掉全部 Zone 只能得到空集合，不会得到更多", () => {
  const accessible = filterAccessibleAssets(ASSETS, ZONES_ADMIN);
  const shown = applyZoneVisibility(accessible, { "public-v1": false, "vault-v1": false });
  assert.deepEqual(shown.map((a) => a.assetId), ["a_legacy"], "只剩不受控的老条目");
});
await test("applyZoneVisibility 的结果一定是子集（逐项枚举）", () => {
  const accessible = filterAccessibleAssets(ASSETS, ZONES_ADMIN);
  const combinations = [
    {},
    { "public-v1": true, "vault-v1": true },
    { "public-v1": true, "vault-v1": false },
    { "public-v1": false, "vault-v1": true },
    { "public-v1": false, "vault-v1": false },
  ];
  for (const vis of combinations) {
    const shown = applyZoneVisibility(accessible, vis);
    assert.ok(shown.length <= accessible.length, "条目数不可能变多");
    for (const a of shown) {
      assert.ok(
        accessible.includes(a),
        `输出的每一项都必须来自输入集合（${a.assetId}）`,
      );
    }
  }
});

console.log("\n【5】降级：存储不可用或内容损坏时都不能崩");
await test("localStorage 抛错（隐私模式）→ 默认全可见，且保存不抛", () => {
  globalThis.localStorage = {
    getItem() {
      throw new Error("SecurityError: localStorage is disabled");
    },
    setItem() {
      throw new Error("SecurityError: localStorage is disabled");
    },
    removeItem() {
      throw new Error("SecurityError: localStorage is disabled");
    },
  };
  assert.equal(localMod.isLocalStorageAvailable(), false);
  const scope = zoneVisibilityScope("Kozakemi", ZONES_ADMIN);
  const vis = loadZoneVisibility(scope, ZONES_ADMIN);
  assert.deepEqual(vis, { "public-v1": true, "vault-v1": true }, "读不到就当全可见");
  saveZoneVisibility(scope, { "public-v1": false, "vault-v1": true }); // 不应抛
  clearZoneVisibility(scope); // 不应抛
});
await test("完全没有 localStorage（SSR / Node）→ 同样安全降级", () => {
  delete globalThis.localStorage;
  assert.equal(localMod.isLocalStorageAvailable(), false);
  const scope = zoneVisibilityScope("Kozakemi", ZONES_ADMIN);
  assert.deepEqual(loadZoneVisibility(scope, ZONES_ADMIN), {
    "public-v1": true,
    "vault-v1": true,
  });
  saveZoneVisibility(scope, { "public-v1": false });
  globalThis.localStorage = new MemoryStorage();
});
await test("存储内容损坏（不是合法 JSON）→ 当没有设置过", () => {
  resetStorage();
  globalThis.localStorage.setItem(ZONE_VISIBILITY_STORAGE_KEY, "{ 这不是 JSON");
  const vis = loadZoneVisibility(zoneVisibilityScope("Kozakemi", ZONES_ADMIN), ZONES_ADMIN);
  assert.deepEqual(vis, { "public-v1": true, "vault-v1": true });
});
await test("存储内容结构不对（数组 / 非布尔值）→ 忽略坏字段，不崩", () => {
  resetStorage();
  globalThis.localStorage.setItem(ZONE_VISIBILITY_STORAGE_KEY, JSON.stringify([1, 2, 3]));
  assert.deepEqual(
    loadZoneVisibility(zoneVisibilityScope("Kozakemi", ZONES_ADMIN), ZONES_ADMIN),
    { "public-v1": true, "vault-v1": true },
    "整份是数组时按没有设置处理",
  );

  globalThis.localStorage.setItem(
    ZONE_VISIBILITY_STORAGE_KEY,
    JSON.stringify({ "Kozakemi|public-v1,vault-v1": { "public-v1": "yes", "vault-v1": false } }),
  );
  const vis = loadZoneVisibility(zoneVisibilityScope("Kozakemi", ZONES_ADMIN), ZONES_ADMIN);
  assert.equal(vis["public-v1"], true, "非布尔值应当被忽略，退回默认可见");
  assert.equal(vis["vault-v1"], false, "合法字段照常生效");
});
await test("作用域数量超上限时裁掉最旧的，且最新的仍然可用", () => {
  resetStorage();
  const scopes = [];
  for (let i = 0; i < 12; i++) {
    const zones = [{ zoneId: `zone-${i}`, keyB64: PUBLIC_KEY }];
    const scope = zoneVisibilityScope("u", zones);
    scopes.push({ scope, zones });
    saveZoneVisibility(scope, { [`zone-${i}`]: false });
  }
  const latest = scopes[scopes.length - 1];
  const oldest = scopes[0];
  const latestZoneId = latest.zones[0].zoneId;
  assert.equal(
    loadZoneVisibility(latest.scope, latest.zones)[latestZoneId],
    false,
    "最新的记录必须还在",
  );
  assert.equal(
    loadZoneVisibility(oldest.scope, oldest.zones)["zone-0"],
    true,
    "最旧的记录应已被裁掉，退回默认可见",
  );
});

console.log("\n【6】计数");
await test("countAssetsByZone：按 Zone 统计，忽略没有 zoneId 的条目", () => {
  const counts = countAssetsByZone(ASSETS);
  assert.equal(counts.get("public-v1"), 2);
  assert.equal(counts.get("vault-v1"), 1);
  assert.equal(counts.has(""), false);
  assert.equal(counts.size, 2);
});
await test("计数用的是「有权查看」的集合 → 关掉一个 Zone 之后它仍然可被重新打开", () => {
  const accessible = filterAccessibleAssets(ASSETS, ZONES_ADMIN);
  const vis = { "public-v1": true, "vault-v1": false };
  const shown = applyZoneVisibility(accessible, vis);
  assert.equal(shown.length, 3, "被关掉的那 1 张不显示");
  // 若计数用的是 shown，vault-v1 会变成 0 条而被界面隐藏，就再也打不开了
  assert.equal(countAssetsByZone(accessible).get("vault-v1"), 1);
});

console.log("\n【7】界面开关列表：只列「确实有照片」的 Zone");
await test("0 张的 Zone 不列出（勾了也没反应，列出来只会让人以为坏了）", () => {
  const accessible = [
    { assetId: "p1", zoneId: "public-v1" },
    { assetId: "p2", zoneId: "public-v1" },
  ];
  const opts = buildZoneFilterOptions(ZONES_ADMIN, accessible, {});
  assert.deepEqual(opts.map((o) => o.zoneId), ["public-v1"]);
  assert.equal(opts[0].count, 2);
});
await test("复现线上那份清单的形状：164 张全在公开区 → 只给一个开关，整排隐藏", () => {
  const bigPublic = Array.from({ length: 164 }, (_, i) => ({
    assetId: `p${i}`,
    zoneId: "public-v1",
  }));
  const opts = buildZoneFilterOptions(ZONES_ADMIN, bigPublic, {});
  assert.equal(opts.length, 1, "没有可切换的对象，界面据此不显示整排开关");
  assert.equal(opts[0].count, 164);
});
await test("一旦私密区有了照片，第二个开关会自己出现", () => {
  const withVault = [
    ...Array.from({ length: 164 }, (_, i) => ({ assetId: `p${i}`, zoneId: "public-v1" })),
    { assetId: "v1", zoneId: "vault-v1" },
  ];
  const opts = buildZoneFilterOptions(ZONES_ADMIN, withVault, {});
  assert.deepEqual(opts.map((o) => o.zoneId), ["public-v1", "vault-v1"]);
  assert.deepEqual(opts.map((o) => o.count), [164, 1]);
});
await test("★ 不变量：被勾选关掉的 Zone 只要有照片，就仍在列表里（否则再也打不开）", () => {
  const opts = buildZoneFilterOptions(ZONES_ADMIN, ASSETS, { "public-v1": true, "vault-v1": false });
  const vault = opts.find((o) => o.zoneId === "vault-v1");
  assert.ok(vault, "计数若改用「勾选后」的集合，这里会变成 0 条而被过滤掉");
  assert.equal(vault.count, 1, "计数不受勾选状态影响");
  assert.equal(vault.visible, false);
});
await test("只持有一个 Zone 且它有照片时只列一项", () => {
  const opts = buildZoneFilterOptions(ZONES_GUEST, ASSETS, {});
  assert.equal(opts.length, 1);
  assert.equal(opts[0].zoneId, "public-v1");
});
await test("没有会话时不列任何项（不崩）", () => {
  assert.deepEqual(buildZoneFilterOptions(undefined, ASSETS, {}), []);
  assert.deepEqual(buildZoneFilterOptions([], ASSETS, {}), []);
});
await test("comment 原样带出（界面用作悬停提示）", () => {
  const opts = buildZoneFilterOptions(ZONES_ADMIN, ASSETS, {});
  assert.equal(opts.find((o) => o.zoneId === "public-v1").comment, "公开区");
  assert.equal(opts.find((o) => o.zoneId === "vault-v1").comment, "核心区");
});
await test("没有 zoneId 的老条目不计入任何 Zone 的计数", () => {
  const opts = buildZoneFilterOptions(ZONES_ADMIN, ASSETS, {});
  const total = opts.reduce((n, o) => n + o.count, 0);
  assert.equal(total, ASSETS.filter((a) => a.zoneId).length, "a_legacy 不该被算进任何 Zone");
});

delete globalThis.localStorage;
await server.close();
console.log(`\n======= 通过 ${pass} / 失败 ${fail} =======`);
process.exit(fail ? 1 : 0);

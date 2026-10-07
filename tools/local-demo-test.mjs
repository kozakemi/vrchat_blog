#!/usr/bin/env node
/**
 * 「本地预览」（npm run local）的一致性测试。
 *
 * 这个演示环境的价值全在"开箱就能看"上，而它最容易坏的方式是**数据和配置对不上**：
 * 清单里的图片文件不存在、清单里的 Zone 在演示密钥里没有、.env.demo 没生效导致
 * 前端仍然去请求函数计算……这些都不会报错，只会让页面空白，很难查。
 * 所以这里把每一处对应关系都钉住：
 *
 *   1. .env.demo 里的 `VITE_OSS_SIGN_ENDPOINT=off` 真的被 mode=demo 读到了；
 *   2. 关掉签名服务后 getOssSignEndpoint() 返回 null（清单才会走同源直链）；
 *   3. 不设该变量时默认值不受影响（哨兵不能把线上配置一起关掉）；
 *   4. 清单是合法的、能用 normalizeAlbumManifestPayload 解析；
 *   5. 清单里每条都用 `src` 指向一个确实会被生成的演示图，且不含 file / cipherFile
 *      （否则就会去要签名、离线必然失败）；
 *   6. 清单里出现的每个 zoneId 都在演示密钥里，反之亦然；
 *   7. 演示密钥能通过 validateKeyFile，且带 admin 角色（这样删除/改 Zone 按钮可见）；
 *   8. 用演示密钥鉴权时，8 条全部可见；只有公开区时恰好剩 5 条
 *      —— 这个差值就是界面上 Zone 开关能观察到的效果。
 *
 * 用法：node tools/local-demo-test.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, loadEnv } from "vite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEMO_MANIFEST = path.join(ROOT, "demo", "manifest.json");
const DEMO_KEY = path.join(ROOT, "demo", "key.json");
const DEMO_CONFIG = path.join(ROOT, "vite.config.demo.ts");

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const manifest = readJson(DEMO_MANIFEST);
const demoKey = readJson(DEMO_KEY);

const loadModules = async (mode, configFile) => {
  const server = await createServer({
    root: ROOT,
    configFile,
    mode,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    logLevel: "error",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const signMod = await server.ssrLoadModule("/src/lib/ossSignFetch.ts");
  const manifestMod = await server.ssrLoadModule("/src/lib/albumManifestFetch.ts");
  const accessMod = await server.ssrLoadModule("/src/lib/albumAccess.ts");
  const keyMod = await server.ssrLoadModule("/src/lib/keyFile.ts");
  return { server, signMod, manifestMod, accessMod, keyMod };
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

// demo 模式的模块图与默认模式各建一次
const demoEnv = await loadModules("demo", DEMO_CONFIG);
const devEnv = await loadModules("development", undefined);

console.log("【1】配置：签名服务在演示模式下被关掉");
await test(".env.demo 被 mode=demo 读到，值为 off", () => {
  const env = loadEnv("demo", ROOT, "VITE_");
  assert.equal(
    env.VITE_OSS_SIGN_ENDPOINT,
    "off",
    "vite --mode demo 应当加载 .env.demo",
  );
});
await test("off 哨兵生效：getOssSignEndpoint() 返回 null（清单才走同源直链）", () => {
  assert.equal(demoEnv.signMod.getOssSignEndpoint(), null);
});
await test("默认模式不受影响：没设该变量时仍用函数计算地址", () => {
  const ep = devEnv.signMod.getOssSignEndpoint();
  assert.ok(ep && ep.startsWith("https://"), `默认应为函数计算地址，实际 ${ep}`);
  assert.match(ep, /fcapp\.run$/);
});
await test("哨兵只认 off/none/-/0/false，不误伤正常地址与默认值", () => {
  const { resolveSignEndpointFrom, isSignEndpointDisabled } = demoEnv.signMod;
  const DEFAULT_EP = "https://vrchat-oss-wdmpygkprb.cn-beijing.fcapp.run";

  // 关闭
  for (const v of ["off", "OFF", " off ", "none", "-", "0", "false", "False"]) {
    assert.equal(resolveSignEndpointFrom(v), "", `「${v}」应当表示关闭`);
    assert.equal(isSignEndpointDisabled(v), true, `「${v}」应当被判为关闭`);
  }
  // 没写 = 用默认（不能把线上的签名服务一起关掉）
  for (const v of [undefined, "", "   "]) {
    assert.equal(resolveSignEndpointFrom(v), DEFAULT_EP, `「${String(v)}」应当回落默认地址`);
    assert.equal(isSignEndpointDisabled(v), false);
  }
  // 正常地址原样使用
  for (const v of ["https://my-sign.example.com", "http://10.0.0.2:9000/"]) {
    assert.equal(resolveSignEndpointFrom(v), v);
    assert.equal(isSignEndpointDisabled(v), false);
  }
});

console.log("\n【2】演示清单：结构合法、能被前端解析");
await test("清单是合法 JSON，含 assets 数组且标了 demo: true", () => {
  assert.equal(manifest.demo, true, "应明确标记为演示数据");
  assert.ok(Array.isArray(manifest.assets), "缺少 assets 数组");
  assert.ok(manifest.assets.length >= 6, "演示图太少，看不出网格效果");
});
await test("normalizeAlbumManifestPayload 能解析出全部条目", () => {
  const payload = demoEnv.manifestMod.normalizeAlbumManifestPayload(manifest);
  assert.equal(payload.assets.length, manifest.assets.length);
  assert.equal(payload.schemaVersion, 1);
});
await test("每条都有渲染与界面所需的字段", () => {
  for (const a of manifest.assets) {
    for (const field of ["assetId", "zoneId", "src", "originalName", "takenAt", "mime"]) {
      assert.ok(a[field], `${a.assetId ?? "?"} 缺少 ${field}`);
    }
    assert.equal(typeof a.width, "number", `${a.assetId} 缺少 width（「更多」面板会显示"尺寸未知"）`);
    assert.equal(typeof a.height, "number", `${a.assetId} 缺少 height`);
    assert.ok(a.world?.worldId, `${a.assetId} 缺少 world.worldId（按世界分组要看它）`);
    assert.ok(a.world?.worldName, `${a.assetId} 缺少 world.worldName`);
    assert.match(a.takenAt, /^\d{4}-\d{2}-\d{2}T/, `${a.assetId} 的 takenAt 不是 ISO 形式`);
  }
});
await test("assetId 唯一", () => {
  const ids = manifest.assets.map((a) => a.assetId);
  assert.equal(new Set(ids).size, ids.length);
});
await test("**不含 file / cipherFile**：否则会去要签名、离线必然失败", () => {
  for (const a of manifest.assets) {
    assert.equal(a.file, undefined, `${a.assetId} 不该有 file`);
    assert.equal(a.cipherFile, undefined, `${a.assetId} 不该有 cipherFile`);
    assert.equal(a.nonceB64, undefined, `${a.assetId} 不该有 nonceB64`);
  }
});
await test("时间跨度足够，按时间排序能看出顺序", () => {
  const ts = manifest.assets.map((a) => Date.parse(a.takenAt));
  assert.ok(ts.every(Number.isFinite), "takenAt 必须都可解析");
  assert.ok(new Set(manifest.assets.map((a) => a.world.worldId)).size >= 2, "至少要有两个世界分组");
});

console.log("\n【3】演示图片：清单指向的每一张都会被生成");
await test("每条 src 都对应生成器里的一个条目", async () => {
  const { DEMO_IMAGES } = await import("./make-demo-images.mjs");
  const generated = new Set(DEMO_IMAGES.map((s) => `/demo/${s.name}`));
  for (const a of manifest.assets) {
    assert.ok(generated.has(a.src), `${a.assetId} 的 src=${a.src} 不在生成器清单里`);
  }
});
await test("生成器里的每张图都被清单用到了（不留孤儿）", async () => {
  const { DEMO_IMAGES } = await import("./make-demo-images.mjs");
  const used = new Set(manifest.assets.map((a) => a.src));
  for (const spec of DEMO_IMAGES) {
    assert.ok(used.has(`/demo/${spec.name}`), `${spec.name} 生成了却没有被任何条目引用`);
  }
});
await test("src 都是同源绝对路径（本地预览不依赖任何外网域名）", () => {
  for (const a of manifest.assets) {
    assert.match(a.src, /^\/demo\/[A-Za-z0-9._-]+$/, `${a.assetId} 的 src 形式不对：${a.src}`);
  }
});

console.log("\n【4】演示密钥：能通过校验、能解开清单里的全部条目");
await test("validateKeyFile 通过，且是管理员（删除/改 Zone 按钮才可见）", () => {
  const err = demoEnv.keyMod.validateKeyFile(demoKey);
  assert.equal(err, null, `演示密钥应当合法：${err}`);
  assert.equal(demoEnv.keyMod.isAdminKeyFile(demoKey), true);
});
await test("两个 Zone 的密钥互不相同，且都解出 32 字节", () => {
  const keys = demoKey.zones.map((z) => z.keyB64);
  assert.equal(new Set(keys).size, keys.length, "两个 Zone 不该共用同一把密钥");
  for (const z of demoKey.zones) {
    const bytes = Buffer.from(z.keyB64, "base64");
    assert.equal(bytes.length, 32, `${z.zoneId} 的密钥不是 32 字节`);
  }
});
await test("public-v1 的密钥与 src/config/public-zones.json 一致（演示要贴近线上）", () => {
  const publicZones = readJson(path.join(ROOT, "src/config/public-zones.json"));
  const want = publicZones.zones.find((z) => z.zoneId === "public-v1");
  const got = demoKey.zones.find((z) => z.zoneId === "public-v1");
  assert.ok(want && got, "两边都应存在 public-v1");
  assert.equal(got.keyB64, want.keyB64);
});
await test("清单里的 zoneId 与演示密钥里的 Zone 一一对应", () => {
  const inManifest = new Set(manifest.assets.map((a) => a.zoneId));
  const inKey = new Set(demoKey.zones.map((z) => z.zoneId));
  for (const id of inManifest) {
    assert.ok(inKey.has(id), `清单里的 Zone「${id}」不在演示密钥里 → 这些照片会看不见`);
  }
  for (const id of inKey) {
    assert.ok(inManifest.has(id), `演示密钥里的 Zone「${id}」在清单里没有照片`);
  }
});

console.log("\n【5】端到端：这套数据确实能看出 Zone 开关的效果");
await test("用演示密钥鉴权 → 8 条全部可见", () => {
  const visible = demoEnv.accessMod.filterAccessibleAssets(manifest.assets, demoKey.zones);
  assert.equal(visible.length, manifest.assets.length);
});
await test("只有公开区（注册用户的处境）→ 恰好剩 5 条", () => {
  const publicOnly = demoKey.zones.filter((z) => z.zoneId === "public-v1");
  const visible = demoEnv.accessMod.filterAccessibleAssets(manifest.assets, publicOnly);
  const vaultCount = manifest.assets.filter((a) => a.zoneId === "demo-vault-v1").length;
  assert.equal(visible.length, manifest.assets.length - vaultCount);
  assert.ok(vaultCount > 0, "演示数据里必须有一个非公开的 Zone，否则看不到开关效果");
  assert.ok(
    manifest.assets.length - visible.length >= 2,
    "非公开区的照片太少，勾掉开关时看不出差别",
  );
});
await test("关掉演示私密区 → 每个世界分组各少一张（界面上的可见效果）", async () => {
  const visMod = await demoEnv.server.ssrLoadModule("/src/lib/zoneVisibility.ts");
  const accessible = demoEnv.accessMod.filterAccessibleAssets(manifest.assets, demoKey.zones);
  const shown = visMod.applyZoneVisibility(accessible, { "public-v1": true, "demo-vault-v1": false });

  const countByWorld = (list) => {
    const m = new Map();
    for (const a of list) m.set(a.world.worldId, (m.get(a.world.worldId) ?? 0) + 1);
    return m;
  };
  const before = countByWorld(accessible);
  const after = countByWorld(shown);
  for (const [worldId, n] of before) {
    assert.equal(after.get(worldId), n - 1, `世界 ${worldId} 应当正好少一张`);
  }
});

await demoEnv.server.close();
await devEnv.server.close();
console.log(`\n======= 通过 ${pass} / 失败 ${fail} =======`);
process.exit(fail ? 1 : 0);

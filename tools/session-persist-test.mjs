#!/usr/bin/env node
/**
 * 登录态持久化的回归测试：模拟"刷新页面"。
 *
 * 做法：先用一个 Vite server 加载 store 并写入会话，**关掉它**，再用一个全新的
 * Vite server 加载同一个 store —— 新 server 拥有全新的模块图，等价于浏览器刷新
 * 后重新加载 JS。若此时读不到会话，就是持久化真的坏了。
 *
 * 全程使用内存里的 localStorage 桩，不碰浏览器也不联网。
 *
 * 用法：node tools/session-persist-test.mjs
 */

import assert from "node:assert/strict";
import { createServer } from "vite";

// ---- localStorage 桩 --------------------------------------------------------
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
}

const STORAGE_KEY = "td_key_session_v1";
const session = {
  username: "Kozakemi",
  zones: [
    { zoneId: "public-v1", keyB64: "qIbccWS8pHQB4jIGWO8Q4woXShP6NlQeXsbaAe3KXFM=", comment: "公开区" },
    { zoneId: "vault-v1", keyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", comment: "核心区" },
  ],
  roles: ["admin"],
  isAdmin: true,
};

async function loadStore() {
  const server = await createServer({
    configFile: false,
    resolve: { alias: { "@": new URL("../src", import.meta.url).pathname } },
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    logLevel: "error",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const mod = await server.ssrLoadModule("/src/store/sessionAuthStore.ts");
  return { server, store: mod.useSessionAuthStore, key: mod.SESSION_STORAGE_KEY, mod };
}

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

// ---- 场景 1：写入会话 → "刷新" → 仍在 --------------------------------------
await test("写入后换一份全新模块图（=刷新页面）应能读回会话", async () => {
  globalThis.localStorage = new MemoryStorage();

  const a = await loadStore();
  assert.equal(a.store.getState().keySession, null, "初始应为未登录");
  a.store.getState().setKeySession(session);
  const raw = globalThis.localStorage.getItem(a.key);
  assert.ok(raw, `应当已写入 localStorage（键 ${STORAGE_KEY}）`);
  assert.equal(a.key, STORAGE_KEY, "localStorage 键名不应变化");
  await a.server.close();

  // 全新模块图 = 刷新
  const b = await loadStore();
  const restored = b.store.getState().keySession;
  await b.server.close();

  assert.ok(restored, "刷新后应当仍是登录态，实际为 null");
  assert.equal(restored.username, session.username);
  assert.equal(restored.isAdmin, true);
  assert.deepEqual(
    restored.zones.map((z) => z.zoneId).sort(),
    ["public-v1", "vault-v1"],
  );
  // 密钥必须原样带回来，否则相册解不开图
  assert.equal(
    restored.zones.find((z) => z.zoneId === "public-v1").keyB64,
    session.zones[0].keyB64,
  );
});

// ---- 场景 2：退出登录后刷新仍是未登录 --------------------------------------
await test("退出登录（置 null）后刷新应保持未登录", async () => {
  globalThis.localStorage = new MemoryStorage();
  const a = await loadStore();
  a.store.getState().setKeySession(session);
  a.store.getState().setKeySession(null);
  await a.server.close();

  const b = await loadStore();
  const restored = b.store.getState().keySession;
  await b.server.close();
  assert.equal(restored, null);
});

// ---- 场景 3：损坏数据不应让页面崩，按未登录处理 ----------------------------
await test("localStorage 内容损坏 → 按未登录处理，且不抛错", async () => {
  globalThis.localStorage = new MemoryStorage();
  globalThis.localStorage.setItem(STORAGE_KEY, "{ 这不是合法 JSON");
  const a = await loadStore();
  assert.equal(a.store.getState().keySession, null);
  await a.server.close();
});

await test("结构不对（zones 不是数组）→ 按未登录处理", async () => {
  globalThis.localStorage = new MemoryStorage();
  globalThis.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ state: { keySession: { username: "x", zones: "oops" } }, version: 0 }),
  );
  const a = await loadStore();
  assert.equal(a.store.getState().keySession, null);
  await a.server.close();
});

// ---- 场景 4：localStorage 本身不可用（Safari 隐私模式 / 禁用 Cookie）--------
await test("localStorage 抛错时不应崩溃：应当如实报出持久化不可用", async () => {
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
  const a = await loadStore();
  // 不能崩：仍然要能正常读状态
  assert.equal(a.store.getState().keySession, null);
  // 写入也不能抛
  a.store.getState().setKeySession(session);
  assert.equal(typeof a.mod.isSessionPersistenceAvailable, "function", "应导出可用性探测函数");
  assert.equal(
    a.mod.isSessionPersistenceAvailable(),
    false,
    "localStorage 不可用时应报告 false，供界面提示使用者",
  );
  await a.server.close();
});

await test("localStorage 可用时应报告 true", async () => {
  globalThis.localStorage = new MemoryStorage();
  const a = await loadStore();
  assert.equal(a.mod.isSessionPersistenceAvailable(), true);
  await a.server.close();
});

console.log(`\n======= 通过 ${pass} / 失败 ${fail} =======`);
process.exit(fail ? 1 : 0);

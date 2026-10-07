#!/usr/bin/env node
/**
 * 密钥指纹的正确性与交叉校验（不联网、不解密）。
 *
 * 指纹的用途是让人一眼比对"上传时用的密钥"与"现在解密用的密钥"是否同一把，
 * 所以它必须满足两点：同密钥同值、不同密钥不同值。此外这里还做一项**跨文件校验**：
 * 注册发放的公开区密钥，是否真的就是管理员密钥文件里 public-v1 的那一把——
 * 若不一致，注册用户会拿到一把解不开任何照片的密钥，而这在界面上很难看出来。
 *
 * 用法：node tools/key-fingerprint-test.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  resolve: { alias: { "@": new URL("../src", import.meta.url).pathname } },
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: "custom",
  logLevel: "error",
  optimizeDeps: { noDiscovery: true, include: [] },
});
const { keyFingerprintB64 } = await server.ssrLoadModule("/src/lib/keyFingerprint.ts");

/** 独立实现（Node crypto），用于交叉验证浏览器端 WebCrypto 的结果 */
const referenceFingerprint = (b64) =>
  crypto.createHash("sha256").update(Buffer.from(b64.trim(), "base64")).digest("hex").slice(0, 8);

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

const KEY_A = "qIbccWS8pHQB4jIGWO8Q4woXShP6NlQeXsbaAe3KXFM=";
const KEY_B = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

console.log("【1】指纹本身的性质");
await test("输出为 8 位小写十六进制", async () => {
  const fp = await keyFingerprintB64(KEY_A);
  assert.match(fp, /^[0-9a-f]{8}$/);
});
await test("确定性：同一密钥多次计算一致", async () => {
  assert.equal(await keyFingerprintB64(KEY_A), await keyFingerprintB64(KEY_A));
});
await test("区分度：不同密钥得到不同指纹", async () => {
  assert.notEqual(await keyFingerprintB64(KEY_A), await keyFingerprintB64(KEY_B));
});
await test("与 Node crypto 独立实现一致（交叉验证 WebCrypto 路径）", async () => {
  assert.equal(await keyFingerprintB64(KEY_A), referenceFingerprint(KEY_A));
  assert.equal(await keyFingerprintB64(KEY_B), referenceFingerprint(KEY_B));
});
await test("容忍首尾空白", async () => {
  assert.equal(await keyFingerprintB64(`  ${KEY_A}  `), await keyFingerprintB64(KEY_A));
});

console.log("\n【2】跨文件校验：注册发放的公开区密钥 == 管理员密钥里的同名 Zone");
if (!fs.existsSync("keys")) {
  console.log("  跳过（本机没有 keys/ 目录）");
} else {
  const adminFiles = fs.readdirSync("keys").filter((f) => f.endsWith(".admin.json"));
  const publicConfig = JSON.parse(fs.readFileSync("src/config/public-zones.json", "utf8"));
  for (const zone of publicConfig.zones) {
    await test(`public-zones.json 的「${zone.zoneId}」与各 admin 密钥文件中的同名 Zone 是同一把密钥`, async () => {
      const pubFp = await keyFingerprintB64(zone.keyB64);
      const mismatched = [];
      for (const f of adminFiles) {
        const d = JSON.parse(fs.readFileSync(`keys/${f}`, "utf8"));
        const z = d.zones.find((x) => x.zoneId === zone.zoneId);
        if (!z) continue; // 该密钥文件不含这个 Zone，属正常
        const fp = await keyFingerprintB64(z.keyB64);
        if (fp !== pubFp) mismatched.push(`${f}(${fp})`);
      }
      assert.equal(
        mismatched.length,
        0,
        `配置里的指纹为 ${pubFp}，但以下密钥文件不一致：${mismatched.join(", ")}。` +
          "这会导致注册用户拿到的密钥解不开用管理员密钥上传的照片。",
      );
    });
  }
  console.log(`  （已比对 ${adminFiles.length} 个 admin 密钥文件）`);
}

await server.close();
console.log(`\n======= 通过 ${pass} / 失败 ${fail} =======`);
process.exit(fail ? 1 : 0);

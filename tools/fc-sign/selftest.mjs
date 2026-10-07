#!/usr/bin/env node
/**
 * tools/fc-sign/handler.mjs 的离线自测。
 *
 * 三重校验，**不产生任何写操作**：
 *   1. 对象键白名单/路径校验分支
 *   2. PUT / GET 签名与 ali-oss 的 signatureUrl 逐字节比对
 *   3. 用自己算出的签名真实 GET 一次 OSS（验证签名被 OSS 接受）
 *   4. 事件解析兼容性（多种 FC 传入形态）
 *   5. handler 各分支行为
 *
 * 前置：仓库根目录 keys/oss.json（含 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET /
 * OSS_ENDPOINT / OSS_BUCKET_NAME），该文件已被 .gitignore 忽略。
 *
 * 用法：node tools/fc-sign/selftest.mjs
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const keyFile = path.join(root, "keys", "oss.json");
if (!fs.existsSync(keyFile)) {
  console.error(`找不到 ${keyFile}（需要 OSS 凭据才能自测）`);
  process.exit(1);
}

const oss = JSON.parse(fs.readFileSync(keyFile, "utf8"));
process.env.OSS_ACCESS_KEY_ID = oss.OSS_ACCESS_KEY_ID;
process.env.OSS_ACCESS_KEY_SECRET = oss.OSS_ACCESS_KEY_SECRET;
process.env.OSS_ENDPOINT = oss.OSS_ENDPOINT;
process.env.OSS_BUCKET_NAME = oss.OSS_BUCKET_NAME;

const { signOssUrl, validateObjectKey, getQueryParams, handler } = await import(
  new URL("./handler.mjs", import.meta.url).href
);

const cfg = {
  accessKeyId: oss.OSS_ACCESS_KEY_ID,
  accessKeySecret: oss.OSS_ACCESS_KEY_SECRET,
  bucket: oss.OSS_BUCKET_NAME,
  endpoint: oss.OSS_ENDPOINT,
  expiresSec: 300,
};

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${extra ? `  ${extra}` : ""}`);
};

console.log("【1】对象键校验");
check("albums/manifest.json 通过", validateObjectKey("albums/manifest.json", ["albums/"]) === null);
check("albums/assets/a_x.bin 通过", validateObjectKey("albums/assets/a_x.bin", ["albums/"]) === null);
check("白名单外前缀被拒", validateObjectKey("VRChat/x.png", ["albums/"]) !== null);
check("../ 穿越被拒", validateObjectKey("albums/../../x", ["albums/"]) !== null);
check("空路径段 // 被拒", validateObjectKey("albums//x", ["albums/"]) !== null);
check("前导 / 被拒", validateObjectKey("/albums/x", ["albums/"]) !== null);
check("控制字符被拒", validateObjectKey("albums/a\u0000b", ["albums/"]) !== null);
check("超长被拒", validateObjectKey(`albums/${"a".repeat(600)}`, ["albums/"]) !== null);

console.log("\n【2】签名与 ali-oss 逐字节比对");
/**
 * 逐字节比对的前提是两边算出同一个 Expires。
 * ali-oss 用**真实时钟**决定 Expires，而这里还要动态导入它（耗时可达数百毫秒），
 * 于是「先取 fixed、再调 ali」之间极易跨过整秒 → Expires 差 1 → 签名必然不等。
 * 早期版本只冻结 Date.now，结果本测试在 19/21 与 21/21 之间随机跳（实测约五成）。
 *
 * 现在的做法：先用真实时钟问 ali-oss 要一个 Expires，再把时钟钉到
 * `(它的 Expires - 900)` 秒，使自研签名器算出**完全相同**的 Expires。
 * 这样不依赖任何一方读的是哪个时钟，比对结果是确定性的。
 */
function withFrozenDate(ms, fn) {
  const Real = Date;
  class FrozenDate extends Real {
    constructor(...args) {
      if (args.length === 0) super(ms);
      else super(...args);
    }
    static now() {
      return ms;
    }
  }
  globalThis.Date = FrozenDate;
  try {
    return fn();
  } finally {
    globalThis.Date = Real;
  }
}

const objectKey = "albums/assets/probe.bin";
const contentType = "application/octet-stream";
{
  const OSS = (await import("ali-oss")).default;
  const client = new OSS({
    region: "oss-cn-beijing",
    accessKeyId: cfg.accessKeyId,
    accessKeySecret: cfg.accessKeySecret,
    bucket: cfg.bucket,
    secure: true,
  });

  const sig = (u) => decodeURIComponent(new URL(u).searchParams.get("Signature") ?? "");
  const exp = (u) => new URL(u).searchParams.get("Expires");

  const theoPut = client.signatureUrl(objectKey, {
    method: "PUT",
    expires: 900,
    "Content-Type": contentType,
  });
  const aliPutExpires = Number(exp(theoPut));
  const minePut = withFrozenDate((aliPutExpires - 900) * 1000, () =>
    signOssUrl(cfg, { objectKey, method: "PUT", contentType, expiresSec: 900 }),
  );

  const theoGet = client.signatureUrl(objectKey, { expires: 900 });
  const aliGetExpires = Number(exp(theoGet));
  const mineGet = withFrozenDate((aliGetExpires - 900) * 1000, () =>
    signOssUrl(cfg, { objectKey, method: "GET", expiresSec: 900 }),
  );

  check(
    "PUT Expires 与 ali-oss 一致",
    exp(minePut.signedUrl) === exp(theoPut),
    `${exp(minePut.signedUrl)}/${exp(theoPut)}`,
  );
  check(
    "PUT Signature 一致",
    sig(minePut.signedUrl) === sig(theoPut),
    `sig=${sig(minePut.signedUrl).slice(0, 12)}/${sig(theoPut).slice(0, 12)}`,
  );
  check(
    "GET Signature 一致",
    sig(mineGet.signedUrl) === sig(theoGet),
    `sig=${sig(mineGet.signedUrl).slice(0, 12)}/${sig(theoGet).slice(0, 12)}`,
  );
}

console.log("\n【3】真实 GET 打桶");
const signed = signOssUrl(cfg, { objectKey: "albums/manifest.json", method: "GET", expiresSec: 300 });
const res = await fetch(signed.signedUrl, { cache: "no-store" });
const bytes = new Uint8Array(await res.arrayBuffer());
check("OSS 接受自算签名", res.status === 200, `http=${res.status} bytes=${bytes.byteLength}`);
check("返回内容为清单 JSON", new TextDecoder().decode(bytes).includes('"assets"'));

console.log("\n【4】事件解析");
check("queryParameters 形态", getQueryParams({ queryParameters: { file: "a/b" } }).file === "a/b");
check(
  "原始 HTTP 字符串形态",
  getQueryParams("GET /?file=albums%2Fmanifest.json&put=1 HTTP/1.1\r\nHost: x").put === "1",
);
check("rawPath 带查询串形态", getQueryParams({ rawPath: "/?file=z" }).file === "z");
check(
  "requestContext.http.path 形态",
  getQueryParams({ requestContext: { http: { path: "/?file=q" } } }).file === "q",
);

console.log("\n【5】handler 分支");
const health = await handler({ queryParameters: { health: "1" } });
check("health=1 → 200 且如实上报", health.statusCode === 200 && JSON.parse(health.body).configured === true);
const putOff = await handler({ queryParameters: { put: "1", file: "albums/x.bin" } });
check("PUT 默认关闭 → 403", putOff.statusCode === 403);
const noFile = await handler({ queryParameters: {} });
check("缺 file → 400", noFile.statusCode === 400);
const badKey = await handler({ queryParameters: { file: "VRChat/secret.png" } });
check("越界前缀 → 400 且不签名", badKey.statusCode === 400 && !badKey.body.includes("signedUrl"));
const okGet = await handler({ queryParameters: { file: "albums/manifest.json" } });
check("正常 GET → 200", okGet.statusCode === 200 && JSON.parse(okGet.body).signedUrl.startsWith("https://"));

console.log(`\n======= 通过 ${pass} / 失败 ${fail} =======`);
process.exit(fail ? 1 : 0);

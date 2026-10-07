#!/usr/bin/env node
// 默认只检查；--apply 备份现有规则后，补齐线上所需的最小 CORS 规则。
//
// 需要放行两个方法：
//   PUT    —— 管理页上传密文与清单
//   DELETE —— 管理员删除照片（会先改清单，再删 OSS 上的密文对象）
// 只放行 GET/PUT 时表现为「能上传、能浏览，但删不掉」：浏览器的 DELETE 预检会被直接拒掉。
import fs from "node:fs/promises";
import OSS from "ali-oss";

const origin = "https://vrchat.kozakemi.top";
/** 需要放行的「方法 + 请求头」组合 */
const REQUIRED = [
  { method: "PUT", header: "Content-Type" },
  { method: "DELETE", header: "Content-Type" },
];

const config = JSON.parse(await fs.readFile(new URL("../keys/oss.json", import.meta.url), "utf8"));
const endpoint = config.OSS_ENDPOINT.replace(/^https?:\/\//, "").split("/")[0];
const client = new OSS({
  endpoint: `https://${endpoint}`,
  accessKeyId: config.OSS_ACCESS_KEY_ID,
  accessKeySecret: config.OSS_ACCESS_KEY_SECRET,
  bucket: config.OSS_BUCKET_NAME,
  secure: true,
});
const asArray = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);

const { rules } = await client.getBucketCORS(config.OSS_BUCKET_NAME);
const covers = (rule, req) =>
  asArray(rule.allowedOrigin).some((v) => v === origin || v === "*") &&
  asArray(rule.allowedMethod).includes(req.method) &&
  asArray(rule.allowedHeader).some((v) => v === "*" || v.toLowerCase() === req.header.toLowerCase());

const missing = REQUIRED.filter((req) => !rules.some((rule) => covers(rule, req)));

if (missing.length) {
  console.log(`缺少 ${origin} 的以下跨域支持：${missing.map((m) => m.method).join(", ")}`);
  if (process.argv.includes("--apply")) {
    // 先落盘备份；备份失败就不修改远端配置。
    const backup = new URL(`../keys/oss-cors-backup-${Date.now()}.json`, import.meta.url);
    await fs.writeFile(backup, JSON.stringify(rules, null, 2), { flag: "wx" });
    await client.putBucketCORS(config.OSS_BUCKET_NAME, [
      ...rules,
      ...missing.map((m) => ({
        allowedOrigin: origin,
        allowedMethod: m.method,
        allowedHeader: m.header,
        exposeHeader: "ETag",
        maxAgeSeconds: "600",
      })),
    ]);
    console.log("已保留原规则并补齐所需规则；原配置备份于 keys/。");
  } else {
    console.log("运行 node tools/oss-upload-cors.mjs --apply 修复。");
  }
}

// 逐项做一次真实预检，确认浏览器视角下确实可用
let allAccepted = true;
for (const req of REQUIRED) {
  const response = await fetch(
    `https://${config.OSS_BUCKET_NAME}.${endpoint}/albums/manifest.json`,
    {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": req.method,
        "Access-Control-Request-Headers": req.header.toLowerCase(),
      },
    },
  );
  const allowOrigin = response.headers.get("access-control-allow-origin");
  const allowMethods = asArray(response.headers.get("access-control-allow-methods")?.split(/\s*,\s*/));
  const allowHeaders = asArray(
    response.headers.get("access-control-allow-headers")?.toLowerCase().split(/\s*,\s*/),
  );
  const accepted =
    response.ok &&
    allowOrigin === origin &&
    allowMethods.includes(req.method) &&
    allowHeaders.includes(req.header.toLowerCase());
  console.log(`线上 ${req.method.padEnd(6)} 预检：HTTP ${response.status}，${accepted ? "通过" : "未通过"}`);
  if (!accepted) allAccepted = false;
}

if (!allAccepted) process.exitCode = 1;

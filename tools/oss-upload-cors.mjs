#!/usr/bin/env node
// 默认只检查；--apply 备份现有规则后补充线上上传所需的最小 CORS 规则。
import fs from "node:fs/promises";
import OSS from "ali-oss";

const origin = "https://vrchat.kozakemi.top";
const config = JSON.parse(await fs.readFile(new URL("../keys/oss.json", import.meta.url), "utf8"));
const endpoint = config.OSS_ENDPOINT.replace(/^https?:\/\//, "").split("/")[0];
const client = new OSS({
  endpoint: `https://${endpoint}`,
  accessKeyId: config.OSS_ACCESS_KEY_ID,
  accessKeySecret: config.OSS_ACCESS_KEY_SECRET,
  bucket: config.OSS_BUCKET_NAME,
  secure: true,
});
const asArray = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
const { rules } = await client.getBucketCORS(config.OSS_BUCKET_NAME);
const covered = rules.some((rule) =>
  asArray(rule.allowedOrigin).some((v) => v === origin || v === "*") &&
  asArray(rule.allowedMethod).includes("PUT") &&
  asArray(rule.allowedHeader).some((v) => v === "*" || v.toLowerCase() === "content-type"),
);
if (!covered) {
  console.log(`缺少 ${origin} 的 PUT / Content-Type 跨域支持。`);
  if (process.argv.includes("--apply")) {
    // 先落盘备份；备份失败就不修改远端配置。
    const backup = new URL(`../keys/oss-cors-backup-${Date.now()}.json`, import.meta.url);
    await fs.writeFile(backup, JSON.stringify(rules, null, 2), { flag: "wx" });
    await client.putBucketCORS(config.OSS_BUCKET_NAME, [...rules, {
      allowedOrigin: origin,
      allowedMethod: "PUT",
      allowedHeader: "Content-Type",
      exposeHeader: "ETag",
      maxAgeSeconds: "600",
    }]);
    console.log("已保留原规则并添加上传规则；原配置备份于 keys/。");
  } else {
    console.log("运行 node tools/oss-upload-cors.mjs --apply 修复。");
  }
}
const response = await fetch(`https://${config.OSS_BUCKET_NAME}.${endpoint}/albums/manifest.json`, {
  method: "OPTIONS",
  headers: {
    Origin: origin,
    "Access-Control-Request-Method": "PUT",
    "Access-Control-Request-Headers": "content-type",
  },
});
const accepted = response.ok && response.headers.get("access-control-allow-origin") === origin &&
  asArray(response.headers.get("access-control-allow-methods")?.split(/\s*,\s*/)).includes("PUT") &&
  asArray(response.headers.get("access-control-allow-headers")?.toLowerCase().split(/\s*,\s*/)).includes("content-type");
console.log(`线上 PUT 预检：HTTP ${response.status}，${accepted ? "通过" : "未通过"}`);
if (!accepted) process.exitCode = 1;

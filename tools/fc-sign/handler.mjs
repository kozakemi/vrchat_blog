/**
 * 阿里云函数计算（FC 3.0）— OSS 临时签名服务
 * ============================================================================
 * 用途：给相册页/管理页换取 OSS 对象的**临时访问 URL**，避免桶内对象公开可读。
 *
 * 线上现状（2026-10-07 实测 vrchat-oss-wdmpygkprb.cn-beijing.fcapp.run）：
 *   - `?file=<key>`                  → 200 {signedUrl, expire_in}      ✅ 现役能力
 *   - `?put=1&key=<key>`             → 400 {"error":"缺少 file 参数"}  ❌ PUT 签名已移除
 *   - `?put=1&file=<key>`            → 与纯 GET 签名逐字节相同          ❌ 并非 PUT 签名
 *   - HTTP 触发器 CORS: Allow-Methods = GET,OPTIONS（无 PUT）
 *
 * 本文件相比线上版本加固三点：
 *   1. 对象键白名单/路径校验（默认只允许 albums/ 前缀），杜绝为任意 Key 签名；
 *   2. 零依赖（只用 node:crypto），单文件即可部署，无需安装 ali-oss；
 *   3. PUT 签名改为「默认关闭、需显式开启且必须带 token」，避免重开任意人可写的写入面。
 *
 * 部署与自测见同目录 README.md。
 */

import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const DEFAULTS = {
  bucket: "vrchat-png",
  endpoint: "oss-cn-beijing.aliyuncs.com",
  expiresSec: 300,
  maxKeyLen: 512,
  allowedPrefixes: ["albums/"],
};

const MAX_EXPIRES_SEC = 3600;

function env(name) {
  const v = process.env[name];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function getConfig() {
  const accessKeyId = env("OSS_ACCESS_KEY_ID");
  const accessKeySecret = env("OSS_ACCESS_KEY_SECRET");
  if (!accessKeyId || !accessKeySecret) {
    throw new Error("函数环境变量缺少 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET");
  }
  const endpoint = (env("OSS_ENDPOINT") || DEFAULTS.endpoint)
    .replace(/^https?:\/\//i, "")
    .split("/")[0];
  return {
    accessKeyId,
    accessKeySecret,
    bucket: env("OSS_BUCKET_NAME") || DEFAULTS.bucket,
    endpoint,
    // 逗号分隔；设为 "-" 表示不做前缀限制（不建议）
    allowedPrefixes: parsePrefixes(env("ALLOWED_KEY_PREFIXES")),
    // PUT 签名开关：只有显式设置为 1 且配置了 PUT_TOKEN 才生效
    putEnabled: env("ALLOW_PUT_SIGN") === "1",
    putToken: env("PUT_TOKEN"),
    expiresSec: clampExpires(Number(env("SIGN_EXPIRES_SEC") || DEFAULTS.expiresSec)),
  };
}

function parsePrefixes(raw) {
  if (!raw) return DEFAULTS.allowedPrefixes;
  if (raw.trim() === "-") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function clampExpires(n) {
  if (!Number.isFinite(n) || n <= 0) return DEFAULTS.expiresSec;
  return Math.min(Math.floor(n), MAX_EXPIRES_SEC);
}

// ---------------------------------------------------------------------------
// 对象键校验
// ---------------------------------------------------------------------------

/**
 * 返回错误描述；`null` 表示通过。
 * 这里刻意用「白名单前缀 + 逐段校验」而不是黑名单正则：
 * 对象键会直接进 OSS 签名与 URL，任何歧义都可能导致越权签名。
 */
export function validateObjectKey(key, allowedPrefixes) {
  if (typeof key !== "string" || !key) return "file 不能为空";
  if (key.length > DEFAULTS.maxKeyLen) return `file 过长（>${DEFAULTS.maxKeyLen}）`;
  if (key !== key.trim()) return "file 首尾含空白字符";
  if (key.startsWith("/")) return "file 不能以 / 开头";
  if (key.includes("\\")) return "file 不能包含反斜杠";
  if (/[\u0000-\u001f\u007f]/.test(key)) return "file 含控制字符";
  if (key.includes("//")) return "file 不能包含空路径段";

  const segments = key.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    return "file 含 . / .. 等非法路径段";
  }

  const prefixes = allowedPrefixes ?? DEFAULTS.allowedPrefixes;
  if (prefixes.length && !prefixes.some((p) => key.startsWith(p))) {
    return `file 不在允许的前缀内（${prefixes.join(", ")}）`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// OSS Signature V1（仅用 node:crypto，无需 ali-oss）
// ---------------------------------------------------------------------------

function encodeObjectKeyForPath(key) {
  // 逐段编码：保留 / 作为路径分隔符，避免出现 %2F
  return key.split("/").map(encodeURIComponent).join("/");
}

/**
 * 生成 OSS 临时签名 URL。
 *
 * stringToSign = VERB \n Content-MD5 \n Content-Type \n Expires \n CanonicalizedResource
 * CanonicalizedResource = /<bucket>/<objectKey>
 *
 * 说明：这里**不**附加 `response-content-disposition` 之类的覆盖参数。
 * 那类参数属于 sub-resource，必须一并计入 CanonicalizedResource 才能签对；
 * 而本站图片都是 fetch() 成 Blob 再展示，Content-Disposition 完全不参与渲染，
 * 省掉它可以避开一整类签名错误。
 *
 * 对 PUT 而言，调用方后续发出的 PUT 请求必须携带**完全相同**的 Content-Type，
 * 否则 OSS 返回 403（浏览器通常只显示 Load failed）。
 */
export function signOssUrl(config, { objectKey, method = "GET", contentType = "", expiresSec }) {
  const expires = Math.floor(Date.now() / 1000) + clampExpires(Number(expiresSec ?? config.expiresSec));
  const verb = String(method).toUpperCase();
  const stringToSign = [verb, "", contentType, String(expires), `/${config.bucket}/${objectKey}`].join("\n");
  const signature = crypto
    .createHmac("sha1", config.accessKeySecret)
    .update(stringToSign, "utf8")
    .digest("base64");

  const query = [
    `OSSAccessKeyId=${encodeURIComponent(config.accessKeyId)}`,
    `Expires=${expires}`,
    `Signature=${encodeURIComponent(signature)}`,
  ].join("&");

  return {
    signedUrl: `https://${config.bucket}.${config.endpoint}/${encodeObjectKeyForPath(objectKey)}?${query}`,
    expire_in: expires - Math.floor(Date.now() / 1000),
  };
}

// ---------------------------------------------------------------------------
// 事件解析：兼容 FC 的几种传入形态
// ---------------------------------------------------------------------------

function parseQueryString(qs) {
  const out = {};
  if (!qs) return out;
  const s = qs.startsWith("?") ? qs.slice(1) : qs;
  for (const pair of s.split("&")) {
    if (!pair) continue;
    const i = pair.indexOf("=");
    const k = decodeURIComponent(i < 0 ? pair : pair.slice(0, i));
    const v = i < 0 ? "" : decodeURIComponent(pair.slice(i + 1).replace(/\+/g, " "));
    out[k] = v;
  }
  return out;
}

function fromRawHttp(text) {
  // 形如 "GET /path?query=1 HTTP/1.1\r\nHost: ..."
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const m = firstLine.match(/^\S+\s+(\S+)/);
  if (!m) return {};
  const qIndex = m[1].indexOf("?");
  return qIndex < 0 ? {} : parseQueryString(m[1].slice(qIndex + 1));
}

/** 从各种可能的 event 形态里取出 query 参数 */
export function getQueryParams(event) {
  let e = event;
  if (typeof e === "string") return fromRawHttp(e);
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(e)) return fromRawHttp(e.toString("utf8"));
  if (!e || typeof e !== "object") return {};

  // API 网关 / FC 3.0 HTTP 触发器风格
  if (e.queryParameters && typeof e.queryParameters === "object") {
    const out = {};
    for (const [k, v] of Object.entries(e.queryParameters)) {
      out[k] = Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "");
    }
    return out;
  }
  // 其它常见字段
  for (const field of ["rawQueryString", "queryString"]) {
    if (typeof e[field] === "string" && e[field]) return parseQueryString(e[field]);
  }
  for (const field of ["rawPath", "path"]) {
    if (typeof e[field] === "string" && e[field].includes("?")) {
      return parseQueryString(e[field].slice(e[field].indexOf("?") + 1));
    }
  }
  const httpPath = e.requestContext?.http?.path;
  if (typeof httpPath === "string" && httpPath.includes("?")) {
    return parseQueryString(httpPath.slice(httpPath.indexOf("?") + 1));
  }
  // 事件体里塞了完整原始请求
  if (typeof e.body === "string" && /^[A-Z]+\s+\S+\s+HTTP\//.test(e.body)) {
    return fromRawHttp(e.body);
  }
  return {};
}

// ---------------------------------------------------------------------------
// 响应
// ---------------------------------------------------------------------------

/**
 * 注意：CORS 响应头由「HTTP 触发器」的配置统一下发（线上响应里能看到
 * `Access-Control-Max-Age` 等，连 400/204 都带），函数内**不要**重复设置，
 * 否则可能出现重复头。若将来重新开放 PUT，必须同时把触发器的
 * Access-Control-Allow-Methods 改成 `GET,PUT,OPTIONS`。
 */
function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8" },
    isBase64Encoded: false,
    body: JSON.stringify(payload),
  };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export const handler = async (event) => {
  const q = getQueryParams(event);

  if (q.health === "1") {
    let cfg = null;
    try {
      cfg = getConfig();
    } catch {
      /* 未配置也照样回报，便于排查 */
    }
    return json(200, {
      ok: true,
      configured: Boolean(cfg),
      bucket: cfg?.bucket ?? null,
      allowedPrefixes: cfg?.allowedPrefixes ?? null,
      putSignEnabled: Boolean(cfg?.putEnabled && cfg?.putToken),
      now: new Date().toISOString(),
    });
  }

  let cfg;
  try {
    cfg = getConfig();
  } catch (e) {
    return json(500, { error: e instanceof Error ? e.message : String(e) });
  }

  // --- PUT 签名（默认关闭；开启后必须带正确 token）---
  if (q.put === "1") {
    if (!cfg.putEnabled) {
      return json(403, { error: "本服务未开启 PUT 签名（如需开启请设置环境变量 ALLOW_PUT_SIGN=1）" });
    }
    if (!cfg.putToken) {
      return json(500, { error: "ALLOW_PUT_SIGN=1 但未配置 PUT_TOKEN，拒绝签名" });
    }
    if (!q.token || !timingSafeEqualStr(q.token, cfg.putToken)) {
      return json(401, { error: "token 缺失或不正确" });
    }
    const key = q.file ?? q.key;
    const bad = validateObjectKey(key, cfg.allowedPrefixes);
    if (bad) return json(400, { error: `非法 file 参数：${bad}` });

    const contentType = q.content_type || "application/octet-stream";
    const signed = signOssUrl(cfg, { objectKey: key, method: "PUT", contentType });
    return json(200, { ...signed, content_type: contentType });
  }

  // --- GET 签名（相册公开读取，无需 token）---
  const key = q.file;
  if (key === undefined) return json(400, { error: "缺少 file 参数" });
  const bad = validateObjectKey(key, cfg.allowedPrefixes);
  if (bad) return json(400, { error: `非法 file 参数：${bad}` });

  const signed = signOssUrl(cfg, { objectKey: key, method: "GET" });
  return json(200, signed);
};

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export default handler;

/**
 * 如果你的函数是「HTTP 函数」形态（handler 收到 (req, res) 而非 event），
 * 用下面这个包装替换 export const handler：
 *
 * export async function httpHandler(req, res) {
 *   const q = req.queries ?? parseQueryString(String(req.url ?? "").split("?")[1] ?? "");
 *   const result = await handler({ queryParameters: q });
 *   res.setHeader("content-type", "application/json; charset=utf-8");
 *   res.status(result.statusCode);
 *   res.send(result.body);
 * }
 */

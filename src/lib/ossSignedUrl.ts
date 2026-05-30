/** 函数计算若返回「相对路径 + 查询串」形式的签名链接，浏览器会按当前站点 origin 解析（变成 localhost），须补全为 Bucket 根 URL */
export const DEFAULT_SIGNED_URL_ORIGIN =
  import.meta.env.VITE_OSS_SIGNED_URL_ORIGIN?.trim() ||
  "https://vrchat-png.oss-cn-beijing.aliyuncs.com";

/** 由 Bucket 名 + Endpoint 拼出外网访问根（用于相对签名 URL 补全） */
export function ossBucketPublicOrigin(bucket: string, endpoint: string): string {
  const ep = endpoint.replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
  const b = bucket.trim();
  if (!b) return DEFAULT_SIGNED_URL_ORIGIN.replace(/\/+$/, "");
  if (/^oss-[a-z0-9-]+\.aliyuncs\.com$/i.test(ep)) {
    return `https://${b}.${ep}`;
  }
  if (ep.startsWith(`${b}.`)) {
    return `https://${ep}`;
  }
  return DEFAULT_SIGNED_URL_ORIGIN.replace(/\/+$/, "");
}

/** 与相册页签名 URL 规则一致，供 GET/PUT 共用 */
export function normalizeSignedUrl(value: string): string {
  let s = value.trim();
  if (
    (s.startsWith("`") && s.endsWith("`")) ||
    (s.startsWith("\"") && s.endsWith("\"")) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/^`/, "").replace(/`$/, "");
  if (s.startsWith("http://vrchat-png.oss-cn-beijing.aliyuncs.com/")) {
    s = s.replace("http://", "https://");
  }
  return s;
}

/**
 * 将签名服务返回的链接规范为绝对 HTTPS URL（相对路径会拼到 VITE_OSS_SIGNED_URL_ORIGIN / 默认 Bucket 域名）。
 * 若签名服务误把链接写成当前站点（localhost），仍改写为 Bucket 域名 + 同一路径与查询串。
 */
export function resolveSignedUrlToAbsolute(signedUrl: string, bucketOriginOverride?: string): string {
  let s = normalizeSignedUrl(signedUrl);
  const bucketOrigin = (bucketOriginOverride || DEFAULT_SIGNED_URL_ORIGIN).replace(/\/+$/, "");
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const h = u.hostname.toLowerCase();
      if (h === "localhost" || h === "127.0.0.1") {
        return `${bucketOrigin}${u.pathname}${u.search}`;
      }
      return s;
    } catch {
      return s;
    }
  }
  if (s.startsWith("//")) return `https:${s}`;
  if (s.startsWith("/")) return `${bucketOrigin}${s}`;
  if (s.length > 0) return `${bucketOrigin}/${s}`;
  return s;
}

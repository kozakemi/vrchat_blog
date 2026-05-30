import { resolveSignedUrlToAbsolute } from "@/lib/ossSignedUrl";

/** 开发代理路径前缀：/dev-oss-proxy/<oss-hostname>/object/path */
export const DEV_OSS_PROXY_PREFIX = "/dev-oss-proxy";

/**
 * 开发模式下将 OSS 外网域名改写为 Vite 同源代理路径（见 vite.config.ts），
 * 避免浏览器对 oss.aliyuncs.com 发起跨域 PUT/GET 时被 CORS 拦截。
 * 生产构建返回已补全的绝对 URL，不经代理。
 */
export function rewriteOssUrlForDevFetch(url: string): string {
  const absolute = resolveSignedUrlToAbsolute(url);
  if (!import.meta.env.DEV) return absolute;
  try {
    const u = new URL(absolute);
    return `${DEV_OSS_PROXY_PREFIX}/${u.hostname}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

/**
 * 开发模式下将 OSS 外网域名改写为 Vite 同源代理前缀（见 vite.config.ts server.proxy），
 * 避免浏览器对 oss.aliyuncs.com 发起跨域 PUT/GET 时被 CORS 拦截。
 * 生产构建不受影响。
 */
const HOST_TO_PREFIX: Record<string, string> = {
  "vrchat-png.oss-cn-beijing.aliyuncs.com": "/dev-oss-proxy/vrchat-png",
  "vrchat-img.oss-cn-beijing.aliyuncs.com": "/dev-oss-proxy/vrchat-img",
};

export function rewriteOssUrlForDevFetch(url: string): string {
  if (!import.meta.env.DEV) return url;
  try {
    const u = new URL(url);
    const prefix = HOST_TO_PREFIX[u.hostname.toLowerCase()];
    if (!prefix) return url;
    return `${prefix}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

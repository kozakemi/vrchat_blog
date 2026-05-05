/**
 * 相册清单 URL。
 * 1. 若设置 VITE_ALBUM_MANIFEST_URL（任意模式均生效）：开发与生产都请求该地址（清单仅在 OSS 时推荐写入 .env / .env.local）。
 * 2. 未设置且为开发：当前 dev server 下的 public/albums/manifest.json。
 * 3. 未设置且为生产构建结果：部署站点同源的 albums/manifest.json（须随 public 发布；否则易拿到 index.html）。
 */
export function getAlbumManifestUrl(): string {
  const env = import.meta.env.VITE_ALBUM_MANIFEST_URL?.trim();
  if (env) return env;
  if (import.meta.env.DEV && typeof window !== "undefined") {
    return new URL("albums/manifest.json", window.location.href).href;
  }
  return new URL("albums/manifest.json", import.meta.env.BASE_URL).toString();
}

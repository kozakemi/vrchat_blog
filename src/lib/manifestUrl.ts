/**
 * 返回「直链」清单地址（仅在不走函数计算签名时使用，见 albumManifestFetch）。
 * - 有效 VITE_ALBUM_MANIFEST_URL：须为完整 http(s) URL；错误值如 `/`、仅路径会被忽略，避免 URL 构造抛错。
 * - 否则：开发为 public/albums/manifest.json；生产为相对站点同源的 albums/manifest.json。
 */
export function getOptionalDirectManifestUrl(): string | undefined {
  const raw = import.meta.env.VITE_ALBUM_MANIFEST_URL?.trim();
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol === "http:" || u.protocol === "https:") return u.href;
  } catch {
    /* 无效则忽略 */
  }
  return undefined;
}

export function getAlbumManifestUrl(): string {
  const direct = getOptionalDirectManifestUrl();
  if (direct) return direct;
  if (import.meta.env.DEV && typeof window !== "undefined") {
    return new URL("albums/manifest.json", window.location.href).href;
  }
  if (typeof window !== "undefined") {
    const base = import.meta.env.BASE_URL ?? "./";
    try {
      return new URL("albums/manifest.json", new URL(base, window.location.href)).href;
    } catch {
      return new URL("albums/manifest.json", window.location.href).href;
    }
  }
  return new URL("albums/manifest.json", import.meta.env.BASE_URL).toString();
}

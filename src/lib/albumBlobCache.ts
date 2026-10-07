import { checkAssetAccess, type AccessCheckAsset } from "@/lib/albumAccess";
import type { KeyFileZoneV1 } from "@/lib/keyFile";

/** 缓存里连同 Blob URL 一起保存的解析结果（宽高/拍摄时间/世界） */
export type CachedAssetMeta = {
  takenAt?: string;
  width?: number;
  height?: number;
  world?: {
    worldId?: string | null;
    worldName?: string | null;
  };
};

type BlobUrlCacheEntry = {
  objectUrl: string;
  meta?: CachedAssetMeta;
  createdAt: number;
  lastUsedAt: number;
};

/** 控制内存：最多缓存 N 张解码后的 Blob URL（不影响 UI，只影响性能/内存） */
const BLOB_URL_CACHE_MAX = 180;

/**
 * 解密后图片的 Blob URL 缓存。
 *
 * ⚠️ 这里缓存的是**明文图片**，因此它必须被当作"带权限的数据"看待：
 * - 查缓存之前必须先过 `checkAssetAccess`；
 * - 会话（密钥）变化时必须整体作废并 revoke。
 *
 * 历史缺陷正是这两点都没做：缓存查询排在鉴权之前，且模块级 Map 在退出登录、
 * 换用低权限密钥后依然存活 —— 于是用管理员密钥看过的私有照片，
 * 在切换成只有公开区的密钥文件后仍会从缓存里显示出来。
 */
const cache = new Map<string, BlobUrlCacheEntry>();

/** 缓存归属的会话指纹；与当前会话不一致时必须整体清空 */
let cacheFingerprint: string | null = null;

function safeRevoke(objectUrl: string): void {
  // Node 环境下 URL.revokeObjectURL 可能不存在，或对未注册的 URL 抛错（测试用假 URL）
  if (typeof URL.revokeObjectURL !== "function") return;
  try {
    URL.revokeObjectURL(objectUrl);
  } catch {
    /* 忽略：仅影响内存回收，不影响功能 */
  }
}

/** 资源对应的 OSS 对象键（缓存主键） */
export function blobCacheObjectKey(asset: {
  file?: string | null;
  cipherFile?: string | null;
}): string {
  return asset.file?.trim() || asset.cipherFile?.trim() || "";
}

/**
 * 会话指纹：用户名 + 每个 Zone 的 id 与密钥。
 * 任何一项变化（换密钥文件、加解密钥、退出登录）都会得到不同指纹。
 */
export function sessionFingerprint(
  username: string | undefined,
  zones: KeyFileZoneV1[] | undefined,
): string {
  if (!zones?.length) return `${username ?? ""}|`;
  const parts = zones.map((z) => `${z.zoneId}:${z.keyB64}`).sort();
  return `${username ?? ""}|${parts.join(";")}`;
}

/** 会话变化时清空缓存；首次调用只记录基线（此时页面刚加载，缓存本来就是空的） */
export function syncAlbumBlobCacheToSession(fingerprint: string): void {
  if (cacheFingerprint === null) {
    cacheFingerprint = fingerprint;
    return;
  }
  if (cacheFingerprint !== fingerprint) clearAlbumBlobCache(fingerprint);
}

export function clearAlbumBlobCache(nextFingerprint: string | null = null): void {
  for (const entry of cache.values()) safeRevoke(entry.objectUrl);
  cache.clear();
  cacheFingerprint = nextFingerprint;
}

/**
 * 取"已鉴权"的缓存结果：**先判定权限，再查缓存**。
 * 顺序反过来就是上面的真实漏洞，不要把这两步调换。
 *
 * 连同 meta 一起返回：命中缓存时会跳过解密与解析，
 * 若不把当时解析出的宽高等一起带回来，重组清单后会退化成"尺寸未知"。
 */
export function getAuthorizedCachedBlobUrl(
  asset: AccessCheckAsset,
  zones: KeyFileZoneV1[] | undefined,
): { objectUrl: string; meta?: CachedAssetMeta } | undefined {
  if (!checkAssetAccess(asset, zones).allowed) return undefined;
  const objectKey = blobCacheObjectKey(asset);
  if (!objectKey) return undefined;
  const entry = cache.get(objectKey);
  if (!entry) return undefined;
  entry.lastUsedAt = Date.now();
  return { objectUrl: entry.objectUrl, meta: entry.meta };
}

export function putAlbumBlobUrl(
  objectKey: string,
  objectUrl: string,
  meta?: CachedAssetMeta,
): void {
  if (!objectKey) return;
  cache.set(objectKey, { objectUrl, meta, createdAt: Date.now(), lastUsedAt: Date.now() });
  evictIfNeeded();
}

/** 按最久未使用淘汰，避免长列表把内存吃满 */
function evictIfNeeded(): void {
  if (cache.size <= BLOB_URL_CACHE_MAX) return;
  const items = [...cache.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
  const removeCount = Math.max(1, cache.size - BLOB_URL_CACHE_MAX);
  for (let i = 0; i < removeCount; i++) {
    const [key, entry] = items[i];
    safeRevoke(entry.objectUrl);
    cache.delete(key);
  }
}

/** 仅供测试与排查：当前缓存条数 */
export function albumBlobCacheSize(): number {
  return cache.size;
}

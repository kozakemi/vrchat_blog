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
  /** 明文体积（字节）。缓存里存的是**解密后的明文**，所以内存占用就是它 */
  bytes: number;
  createdAt: number;
  lastUsedAt: number;
};

/** 取图结果（带明文体积，供字节闸门统计） */
export type LoadedAlbumBlob = {
  objectUrl: string;
  meta?: CachedAssetMeta;
  bytes: number;
};

/**
 * 缓存上限：两道闸门同时生效。
 *
 * - `BLOB_URL_CACHE_MAX`：条数，兜底；
 * - `BLOB_BYTES_MAX`：**字节数，主约束**。
 *
 * 为什么必须有字节闸门：这里缓存的是**解密后的明文**，而 VRChat 截图动辄 2–10 MB。
 * 早先只按「180 张」封顶，而线上当时的相册是 157 张共 466 MB（平均 2.97 MB/张）——
 * 也就是滚完一遍就是 ~500 MB 常驻内存，移动端很容易被系统直接杀掉标签页。
 * 条数上限看起来在"控制内存"，其实控制不了内存。
 */
const BLOB_URL_CACHE_MAX = 180;
const BLOB_BYTES_MAX = 128 * 1024 * 1024;

/** 当前缓存占用的明文总字节数（淘汰依据，也供排查用） */
let totalBytes = 0;

/**
 * 缓存代次：会话变化时 +1。
 * 用来作废**正在进行中**的取图 —— 若在下载/解密途中换了会话，
 * 那份明文属于上一个会话，绝不能落进新会话的缓存。
 */
let cacheEpoch = 0;

/** 正在进行中的取图，按对象键共享（见 loadAlbumBlobUrlOnce） */
const inFlight = new Map<string, { id: number; promise: Promise<LoadedAlbumBlob> }>();
let inFlightSeq = 0;

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
  totalBytes = 0;
  // 代次 +1：让进行中的取图作废，否则它完成时会把上一个会话的明文写进新会话的缓存
  cacheEpoch++;
  inFlight.clear();
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

/**
 * 写入缓存。
 *
 * ⚠️ 页面代码**不要直接调用它** —— 用 `loadAlbumBlobUrlOnce`。那里做了并发去重，
 * 并保证「一个对象键只对应一个 Blob URL、且由缓存负责 revoke」。
 * 保留导出是给测试与既有调用点用的。
 *
 * @param bytes 明文体积。不传按 0 计（假 URL 无体积可算）——只会让字节闸门少算一点，
 *              不影响正确性。
 */
export function putAlbumBlobUrl(
  objectKey: string,
  objectUrl: string,
  meta?: CachedAssetMeta,
  bytes = 0,
): void {
  const key = objectKey.trim();
  if (!key) return;

  const previous = cache.get(key);
  if (previous) {
    // 同键重复写入：旧 URL 已经没人引用了，必须回收，否则就是泄漏
    safeRevoke(previous.objectUrl);
    totalBytes -= previous.bytes;
  }

  const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  cache.set(key, { objectUrl, meta, bytes: size, createdAt: Date.now(), lastUsedAt: Date.now() });
  totalBytes += size;
  evictIfNeeded();
}

/** 按最久未使用淘汰，直到同时满足条数与字节两道闸门 */
function evictIfNeeded(): void {
  if (cache.size <= BLOB_URL_CACHE_MAX && totalBytes <= BLOB_BYTES_MAX) return;

  const items = [...cache.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
  for (const [key, entry] of items) {
    // 永远保留最后写入的那一条：单张就超过字节上限时（例如一张 200 MB 的图），
    // 若把它也淘汰掉，就成了"存进去立刻被扔掉"的无限重下循环。
    if (cache.size <= 1) break;
    if (cache.size <= BLOB_URL_CACHE_MAX && totalBytes <= BLOB_BYTES_MAX) break;
    safeRevoke(entry.objectUrl);
    cache.delete(key);
    totalBytes -= entry.bytes;
  }
  if (totalBytes < 0) totalBytes = 0;
}

/**
 * **取图的唯一入口**：先查缓存，miss 就把 `producer` 跑一次并写进缓存；
 * 同一个对象键的并发调用共享同一个 Promise。
 *
 * 由它统一负责两件事：
 *
 * 1. **并发去重**。同一张图可能同时挂在网格卡片与灯箱大图里，两边查缓存都是 miss。
 *    不去重就会签名两次、把整张密文（平均 3 MB）下载两遍。
 * 2. **只有一个写入者**。于是同一个对象键永远只对应一个 Blob URL，且由缓存持有、
 *    由缓存负责 revoke。早先由各调用方自己 put，后完成的会覆盖前一条，
 *    先完成那条的 URL 就再也没人回收，泄漏到页面关闭。
 *
 * ⚠️ 调用方**必须先过 `checkAssetAccess`**：本函数只认缓存、不认权限。
 * 顺序反过来，就是那个"用管理员密钥看过的私密照片，换成公开区密钥后仍从缓存显示"的漏洞。
 */
export function loadAlbumBlobUrlOnce(
  objectKey: string,
  producer: () => Promise<{ objectUrl: string; meta?: CachedAssetMeta; bytes?: number }>,
): Promise<LoadedAlbumBlob> {
  const key = objectKey.trim();
  if (!key) return Promise.reject(new Error("缺少对象键，无法取图"));

  const cached = cache.get(key);
  if (cached) {
    cached.lastUsedAt = Date.now();
    return Promise.resolve({ objectUrl: cached.objectUrl, meta: cached.meta, bytes: cached.bytes });
  }

  const pending = inFlight.get(key);
  if (pending) return pending.promise;

  const id = ++inFlightSeq;
  const epoch = cacheEpoch;
  const promise: Promise<LoadedAlbumBlob> = producer().then((result) => {
    if (epoch !== cacheEpoch) {
      // 途中会话变了：这份明文属于上一个会话，回收掉、也不要写进缓存
      safeRevoke(result.objectUrl);
      throw new Error("会话已变化，本次取图结果已作废");
    }
    const bytes = Number(result.bytes) > 0 ? Number(result.bytes) : 0;
    putAlbumBlobUrl(key, result.objectUrl, result.meta, bytes);
    return { objectUrl: result.objectUrl, meta: result.meta, bytes };
  });

  inFlight.set(key, { id, promise });
  const cleanup = () => {
    // 只清理自己那一份，别把后来者的任务误删（例如中途换过会话）
    const current = inFlight.get(key);
    if (current?.id === id) inFlight.delete(key);
  };
  void promise.then(cleanup, cleanup);

  return promise;
}

/**
 * 丢弃单个对象的缓存。
 * 删除照片后必须调用：否则已解密的明文会继续留在内存里，
 * 万一之后又写入同键对象（例如重新上传），可能显示上一份内容。
 */
export function removeAlbumBlobUrl(objectKey: string): void {
  const key = objectKey.trim();
  const entry = cache.get(key);
  if (!entry) return;
  safeRevoke(entry.objectUrl);
  cache.delete(key);
  totalBytes -= entry.bytes;
  if (totalBytes < 0) totalBytes = 0;
}

/** 仅供测试与排查：当前缓存条数 */
export function albumBlobCacheSize(): number {
  return cache.size;
}

/** 仅供测试与排查：当前缓存的明文总字节数 */
export function albumBlobCacheBytes(): number {
  return totalBytes;
}

/** 仅供测试与排查：正在进行中的取图数量 */
export function albumBlobInFlightCount(): number {
  return inFlight.size;
}

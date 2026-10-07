import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { checkAssetAccess, filterAccessibleAssets } from "@/lib/albumAccess";
import {
  blobCacheObjectKey,
  getAuthorizedCachedBlobUrl,
  putAlbumBlobUrl,
  removeAlbumBlobUrl,
  sessionFingerprint,
  syncAlbumBlobCacheToSession,
} from "@/lib/albumBlobCache";
import { base64ToBytes, buildAadJson, importAesGcmKey } from "@/lib/albumCrypto";
import { deleteAlbumAsset } from "@/lib/albumDelete";
import { fetchAlbumManifestOrThrow } from "@/lib/albumManifestFetch";
import {
  mergeResolvedMetadata,
  resolvedMetadataEquals,
  type AssetResolvedMetadata,
} from "@/lib/albumResolvedMeta";
import { readImageSize, readU32BE } from "@/lib/imageSize";
import { keyFingerprintB64 } from "@/lib/keyFingerprint";
import { rewriteOssUrlForDevFetch } from "@/lib/ossDevProxy";
import { fetchSignedUrlForOssObject, invalidateSignedUrlCacheForObjectKey } from "@/lib/ossSignFetch";
import { loadOssConfigFromSession } from "@/lib/ossUploadConfig";
import { cn } from "@/lib/utils";
import { AlertCircle, Download, Trash2 } from "lucide-react";
import { useSessionAuthStore } from "@/store/sessionAuthStore";

type AlbumViewMode = "time" | "world";

type AlbumAsset = {
  assetId: string;
  zoneId?: string | null;
  originalName?: string | null;
  relPath?: string | null;
  // OSS 对象路径（用于签名换取临时可访问 URL）
  // 例如：VRChat/2026-01/VRChat_....png
  file?: string;
  // 加密资源的 OSS 对象键（管理员上传生成的 .bin）
  cipherFile?: string | null;
  nonceB64?: string | null;
  aad?: {
    v?: number;
    zoneId?: string;
    assetId?: string;
    mime?: string;
  } | null;
  // 兼容：本地/静态路径（开发阶段可用）
  src?: string | null;
  mime?: string;
  width?: number;
  height?: number;
  /** 上传时写入清单的密钥指纹（老数据没有） */
  keyFp?: string | null;
  /** 读取时解析出来：这条是不是密文、以及实际用于解密的密钥指纹 */
  encrypted?: boolean;
  decryptKeyFp?: string;
  takenAt?: string; // ISO8601（无时区也可）
  world?: {
    worldId?: string | null;
    worldName?: string | null;
  };
};

type AlbumManifest = {
  schemaVersion: number;
  generatedAt?: string;
  assets: AlbumAsset[];
};

const EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
};

/** 下载文件名：优先用原始文件名（用户认得），否则用 assetId + 按 MIME 推断的后缀 */
function downloadFilename(asset: AlbumAsset) {
  const base = asset.originalName?.split("/").pop()?.trim();
  if (base) return base;
  const mime = (asset.mime ?? asset.aad?.mime ?? "").toLowerCase();
  return `${asset.assetId}${EXT_BY_MIME[mime] ?? ""}`;
}

function toTs(iso?: string) {
  if (!iso) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

function formatTs(ts: number) {
  if (!Number.isFinite(ts) || ts <= 0) return "时间未知";
  const d = new Date(ts);
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function parseTakenAtFromName(name?: string | null) {
  if (!name) return undefined;
  const base = name.split("/").pop() ?? name;
  const m = base.match(
    /^VRChat_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.(\d{3})_/,
  );
  if (!m) return undefined;
  const [, y, mo, d, hh, mm, ss, ms] = m;
  return `${y}-${mo}-${d}T${hh}:${mm}:${ss}.${ms}`;
}

function inferTakenAt(asset: AlbumAsset) {
  return (
    asset.takenAt ||
    parseTakenAtFromName(asset.originalName) ||
    parseTakenAtFromName(asset.relPath) ||
    parseTakenAtFromName(asset.file) ||
    parseTakenAtFromName(asset.src ?? undefined)
  );
}

function pickXmpField(xml: string, tagName: string) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<[^>]*${escaped}[^>]*>([^<]+)</[^>]*${escaped}>`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

async function inflateDeflateRaw(bytes: Uint8Array) {
  if (typeof DecompressionStream === "undefined") return null;
  try {
    const ds = new DecompressionStream("deflate");
    const writer = ds.writable.getWriter();
    await writer.write(bytes);
    await writer.close();
    const ab = await new Response(ds.readable).arrayBuffer();
    return new Uint8Array(ab);
  } catch {
    return null;
  }
}

async function extractPngXmp(bytes: Uint8Array) {
  if (bytes.length < 8) return null;
  const pngSig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < pngSig.length; i++) {
    if (bytes[i] !== pngSig[i]) return null;
  }

  let offset = 8;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  while (offset + 12 <= bytes.length) {
    const length = readU32BE(bytes, offset);
    const type = decoder.decode(bytes.slice(offset + 4, offset + 8));
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) break;

    const data = bytes.slice(dataStart, dataEnd);
    if (type === "tEXt") {
      const zero = data.indexOf(0);
      if (zero > 0) {
        const keyword = decoder.decode(data.slice(0, zero));
        if (keyword === "XML:com.adobe.xmp" || keyword === "xmp") {
          return decoder.decode(data.slice(zero + 1));
        }
      }
    }

    if (type === "iTXt") {
      const zero = data.indexOf(0);
      if (zero > 0) {
        const keyword = decoder.decode(data.slice(0, zero));
        if (keyword === "XML:com.adobe.xmp" || keyword === "xmp") {
          let p = zero + 1;
          const compressionFlag = data[p];
          p += 1;
          p += 1; // compression method
          const langEnd = data.indexOf(0, p);
          if (langEnd < 0) return null;
          p = langEnd + 1;
          const transEnd = data.indexOf(0, p);
          if (transEnd < 0) return null;
          p = transEnd + 1;
          const payload = data.slice(p);
          const xmlBytes =
            compressionFlag === 1 ? ((await inflateDeflateRaw(payload)) ?? payload) : payload;
          return decoder.decode(xmlBytes);
        }
      }
    }

    offset = dataEnd + 4;
  }
  return null;
}

async function resolveMetadataFromPlainBytes(asset: AlbumAsset, bytes: Uint8Array) {
  const mime = asset.mime?.toLowerCase() ?? "";
  const size = readImageSize(bytes);
  const out: AssetResolvedMetadata = {
    takenAt: inferTakenAt(asset),
    ...(size ? { width: size.width, height: size.height } : {}),
  };
  const isPng =
    mime.includes("png") ||
    (bytes.length >= 4 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47);
  if (!isPng) return out;

  const xmp = await extractPngXmp(bytes);
  if (!xmp) return out;

  const takenAt = pickXmpField(xmp, "CreateDate") || pickXmpField(xmp, "xmp:CreateDate");
  const worldId = pickXmpField(xmp, "WorldID");
  const worldName = pickXmpField(xmp, "WorldDisplayName");

  return {
    ...out,
    takenAt: takenAt || out.takenAt,
    world: {
      worldId: worldId || null,
      worldName: worldName || null,
    },
  };
}

async function fetchAsBlobUrl(asset: AlbumAsset, signedUrl: string, mimeFallback?: string) {
  // OSS 防盗链若配置「不允许空 Referer」，使用 no-referrer 会不带 Referer → 403。
  // strict-origin-when-cross-origin：跨域请求只发送当前页面的 origin（如 https://vrchat.kozakemi.top），
  // 需与控制台 Referer 白名单一致；本地 localhost 开发时请在白名单中加入对应来源或临时允许空 Referer。
  const res = await fetch(rewriteOssUrlForDevFetch(signedUrl), {
    cache: "no-store",
    referrerPolicy: "strict-origin-when-cross-origin",
  });
  if (!res.ok) throw new Error(`图片请求失败：HTTP ${res.status}`);
  const mime = res.headers.get("content-type") || mimeFallback || "application/octet-stream";
  const bytes = new Uint8Array(await res.arrayBuffer());
  const meta = await resolveMetadataFromPlainBytes(asset, bytes);
  const blob = new Blob([bytes], { type: mime });
  // 有些浏览器/环境下 blob.type 可能为空，这里强制补齐 mime
  const fixedBlob = blob.type ? blob : new Blob([blob], { type: mime });
  // 明文对象：完全没有加密，也没有任何密钥参与
  return { objectUrl: URL.createObjectURL(fixedBlob), meta: { ...meta, encrypted: false } };
}

async function fetchCipherBlobUrl(
  asset: AlbumAsset,
  signedUrl: string,
  zoneKeyB64: string,
  nonceB64: string,
  aadJson: string,
  mimeFallback?: string,
) {
  const res = await fetch(rewriteOssUrlForDevFetch(signedUrl), {
    cache: "no-store",
    referrerPolicy: "strict-origin-when-cross-origin",
  });
  if (!res.ok) throw new Error(`密文请求失败：HTTP ${res.status}`);

  const cipherBytes = new Uint8Array(await res.arrayBuffer());
  const iv = base64ToBytes(nonceB64);
  const aadBytes = new TextEncoder().encode(aadJson);
  const key = await importAesGcmKey(zoneKeyB64, ["decrypt"]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: aadBytes },
    key,
    cipherBytes,
  );

  const plainBytes = new Uint8Array(plain);
  const meta = await resolveMetadataFromPlainBytes(asset, plainBytes);
  const blob = new Blob([plainBytes], { type: mimeFallback || "application/octet-stream" });
  // 能走到这里说明 GCM 认证通过 —— 数学上证明了加密时用的就是这把密钥，
  // 因此记下它的指纹，供详情面板与清单里的 keyFp 比对。
  return {
    objectUrl: URL.createObjectURL(blob),
    meta: { ...meta, encrypted: true, decryptKeyFp: await keyFingerprintB64(zoneKeyB64) },
  };
}

function useAssetImageUrl(
  asset: AlbumAsset,
  refreshToken = 0,
  onResolvedMetadata?: (assetId: string, meta: AssetResolvedMetadata) => void,
) {
  const file = asset.file?.trim();
  const cipherFile = asset.cipherFile?.trim();
  const fallback = asset.src ?? undefined; // 兼容本地路径（如果还存在）
  const [url, setUrl] = useState<string | undefined>(undefined);
  const keySession = useSessionAuthStore((s) => s.keySession);

  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    const objectKey = blobCacheObjectKey(asset);

    if (!file && !cipherFile) {
      setUrl(fallback);
      return;
    }

    // 1) 先鉴权：没有对应 Zone 密钥就既不查缓存、也不下载。
    //    这两步的顺序绝不能反——缓存里存的是**已解密的明文图片**。
    //    先前置查缓存，会导致"用管理员密钥看过的私有照片，在换成只有公开区的
    //    密钥文件后仍从缓存里显示出来"，也就是私有区照片对无权身份可见。
    const access = checkAssetAccess(asset, keySession?.zones);
    if (!access.allowed) {
      console.warn(`[album] 跳过无权资源 ${asset.assetId}：${access.reason}`);
      setUrl(undefined);
      return;
    }

    // 2) 已鉴权后才允许命中 Blob URL 缓存（避免重复下载）
    const cached = getAuthorizedCachedBlobUrl(asset, keySession?.zones);
    if (cached) {
      setUrl(cached.objectUrl);
      // 把当初解析出的元数据一并回填，否则重进相册（清单重载会清空
      // resolvedMetaById）时会因命中缓存而跳过解析，尺寸又变回"未知"
      if (cached.meta) onResolvedMetadata?.(asset.assetId, cached.meta);
      return;
    }

    // 3) 先拿签名 URL，再 fetch 成 blob，最后转成 ObjectURL 给 <img>
    setUrl(undefined);
    const run = async () => {
      if (file) {
        const signed = await fetchSignedUrlForOssObject(file);
        if (!signed) throw new Error("获取签名URL失败");
        return fetchAsBlobUrl(asset, signed, asset.mime);
      }

      if (!cipherFile) throw new Error("缺少可读取的对象键");
      if (!access.zoneKeyB64) throw new Error(`缺少 Zone「${asset.zoneId ?? "?"}」的解密密钥`);
      if (!asset.nonceB64?.trim()) throw new Error("密文资源缺少 nonceB64");

      const signed = await fetchSignedUrlForOssObject(cipherFile);
      if (!signed) throw new Error("获取密文临时URL失败");

      const aadJson =
        asset.aad && typeof asset.aad === "object"
          ? JSON.stringify(asset.aad)
          : buildAadJson(asset.zoneId, asset.assetId, asset.mime || "application/octet-stream");

      return fetchCipherBlobUrl(
        asset,
        signed,
        access.zoneKeyB64,
        asset.nonceB64,
        aadJson,
        asset.mime || asset.aad?.mime || undefined,
      );
    };

    void run()
      .then(({ objectUrl, meta }) => {
        if (cancelled) {
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          return;
        }

        putAlbumBlobUrl(objectKey, objectUrl, meta);
        setUrl(objectUrl);
        if (meta) onResolvedMetadata?.(asset.assetId, meta);
      })
      .catch((e) => {
        if (cancelled) return;
        // 不打断 UI，保底用 fallback（若存在）
        console.warn("[album] fetchSignedUrl/fetch blob failed:", e);
        setUrl(fallback);
      });

    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [
    file,
    cipherFile,
    fallback,
    refreshToken,
    asset.assetId,
    asset.zoneId,
    asset.nonceB64,
    asset.mime,
    asset.aad,
    keySession?.zones,
    onResolvedMetadata,
  ]);

  return url;
}

export default function Album() {
  const keySession = useSessionAuthStore((s) => s.keySession);
  const [mode, setMode] = useState<AlbumViewMode>("time");
  const [manifest, setManifest] = useState<AlbumManifest | null>(null);
  const [resolvedMetaById, setResolvedMetaById] = useState<Record<string, AssetResolvedMetadata>>({});
  const [error, setError] = useState<string | null>(null);

  // lightbox
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [isInfoOpen, setIsInfoOpen] = useState(false);
  /** 大图当前的 Blob URL，供「下载」使用；换图或关闭灯箱时清空 */
  const [activeBlobUrl, setActiveBlobUrl] = useState<string | undefined>(undefined);

  // 管理员删除（仅 isAdmin 可见）：deleteTarget 非空即弹出确认框
  const [deleteTarget, setDeleteTarget] = useState<AlbumAsset | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /** 非空表示"部分成功"，确认框改为只展示说明 */
  const [deleteResult, setDeleteResult] = useState<string | null>(null);

  // 轻量提示（复制到剪贴板）
  const [toast, setToast] = useState<string | null>(null);

  // 渐进渲染（每批加载 60 张）
  const BATCH_SIZE = 60;
  const [visibleCount, setVisibleCount] = useState(BATCH_SIZE);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setResolvedMetaById({});
    fetchAlbumManifestOrThrow()
      .then((data) => {
        if (cancelled) return;
        setManifest(data as AlbumManifest);
        setVisibleCount(BATCH_SIZE);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // 界面只给普通访客看得懂的话，具体原因留在控制台便于排查
        console.warn("[album] 加载相册清单失败:", e);
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [BATCH_SIZE]);

  /**
   * 会话变化（退出登录 / 换密钥文件）时必须丢弃已解密的图片。
   * 缓存里存的是明文，跨会话复用等于让上一份密钥解出的照片继续可见。
   */
  const sessionKey = sessionFingerprint(keySession?.username, keySession?.zones);
  useEffect(() => {
    syncAlbumBlobCacheToSession(sessionKey);
  }, [sessionKey]);

  /**
   * 只渲染当前身份有权查看的资源。
   * 不能直接把清单里的 assets 全渲染出来：无权资源的**文件名、拍摄时间、世界名**
   * 会照样出现在页面上——图片解不开，但元数据已经泄露了。
   */
  const accessibleAssets = useMemo(
    () => filterAccessibleAssets(manifest?.assets ?? [], keySession?.zones),
    [manifest, keySession?.zones],
  );
  const hiddenCount = (manifest?.assets.length ?? 0) - accessibleAssets.length;

  const timeSorted = useMemo(() => {
    const assets = accessibleAssets;
    return [...assets]
      .map((a) => {
        const extra = resolvedMetaById[a.assetId];
        const merged: AlbumAsset = {
          ...a,
          ...extra,
          world: extra?.world ?? a.world,
          takenAt: extra?.takenAt ?? inferTakenAt(a),
        };
        return { ...merged, _takenAtTs: toTs(merged.takenAt) };
      })
      .sort((a, b) => b._takenAtTs - a._takenAtTs);
  }, [accessibleAssets, resolvedMetaById]);

  const handleResolvedMetadata = useMemo(
    () => (assetId: string, meta: AssetResolvedMetadata) => {
      setResolvedMetaById((prev) => {
        const cur = prev[assetId];
        // 逐字段合并（见 albumResolvedMeta）：早先这里只重建 takenAt/world，
        // 把 width/height/encrypted/decryptKeyFp 全丢了，
        // 导致"尺寸"与"本次解密密钥指纹"永远显示未知。
        const next = mergeResolvedMetadata(cur, meta);
        if (resolvedMetadataEquals(cur, next)) return prev;
        return { ...prev, [assetId]: next };
      });
    },
    [],
  );

  const indexById = useMemo(() => {
    const map = new Map<string, number>();
    timeSorted.forEach((a, idx) => map.set(a.assetId, idx));
    return map;
  }, [timeSorted]);

  const visibleTimeAssets = useMemo(() => {
    return timeSorted.slice(0, Math.min(visibleCount, timeSorted.length));
  }, [timeSorted, visibleCount]);

  const worldGroups = useMemo(() => {
    const map = new Map<
      string,
      { worldId: string; worldName: string; latestTs: number; items: (AlbumAsset & { _takenAtTs: number })[] }
    >();

    for (const a of timeSorted) {
      const worldId = a.world?.worldId || "unknown";
      const worldName =
        a.world?.worldName || (worldId === "unknown" ? "未知世界 / 待填写" : worldId);

      const g =
        map.get(worldId) ?? ({
          worldId,
          worldName,
          latestTs: Number.NEGATIVE_INFINITY,
          items: [],
        } as const);

      const next = {
        ...g,
        items: [...g.items, a],
        latestTs: Math.max(g.latestTs, a._takenAtTs),
      };
      map.set(worldId, next);
    }

    return [...map.values()].sort((a, b) => b.latestTs - a.latestTs);
  }, [timeSorted]);

  // 时间模式：触底加载更多（不改变现有网格样式，只减少一次性渲染数量）
  useEffect(() => {
    if (mode !== "time") return;
    const root = scrollRef.current;
    const target = loadMoreRef.current;
    if (!root || !target) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const first = entries[0];
        if (!first?.isIntersecting) return;
        setVisibleCount((prev) => {
          if (prev >= timeSorted.length) return prev;
          return Math.min(prev + BATCH_SIZE, timeSorted.length);
        });
      },
      {
        root,
        rootMargin: "800px 0px",
        threshold: 0,
      },
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [mode, timeSorted.length, BATCH_SIZE]);

  // lightbox key handler
  useEffect(() => {
    if (activeIndex === null) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActiveIndex(null);
      if (e.key === "ArrowLeft") {
        setActiveIndex((idx) => {
          if (idx === null) return idx;
          return (idx - 1 + timeSorted.length) % timeSorted.length;
        });
      }
      if (e.key === "ArrowRight") {
        setActiveIndex((idx) => {
          if (idx === null) return idx;
          return (idx + 1) % timeSorted.length;
        });
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeIndex, timeSorted.length]);

  const active = activeIndex === null ? null : timeSorted[activeIndex];
  /** 当前会话是否持有这条资源的 Zone 密钥（详情面板用） */
  const activeZoneKeyOk = active ? checkAssetAccess(active, keySession?.zones).allowed : false;
  const activeObjectKey = active ? active.cipherFile?.trim() || active.file?.trim() || "" : "";

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 1600);
    return () => window.clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    // 切换图片或关闭 lightbox 时，默认关闭“更多信息”，并清掉上一张的下载地址
    setIsInfoOpen(false);
    setActiveBlobUrl(undefined);
  }, [activeIndex]);

  useEffect(() => {
    if (!isInfoOpen || !active) return;
    // 排查"是否用错密钥上传"时，把关键字段打到控制台，便于直接复制。
    // 只依赖 isInfoOpen/activeIndex，避免每次渲染都刷屏。
    console.info("[album] 图片诊断", {
      assetId: active.assetId,
      归属Zone: active.zoneId ?? null,
      当前会话持有该区密钥: activeZoneKeyOk,
      加密方式:
        active.encrypted === undefined
          ? "尚未解密"
          : active.encrypted
            ? "密文（AES-256-GCM）"
            : "明文对象（未加密）",
      上传时密钥指纹: active.keyFp ?? null,
      本次解密密钥指纹: active.decryptKeyFp ?? null,
      指纹一致:
        active.keyFp && active.decryptKeyFp ? active.keyFp === active.decryptKeyFp : null,
      OSS对象键: activeObjectKey || null,
      尺寸: active.width && active.height ? `${active.width}×${active.height}` : null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInfoOpen, activeIndex]);

  /** 只有 blob: URL 才能可靠地"另存为"；跨域的 src 兜底会被浏览器忽略 download */
  const canDownloadActive = Boolean(activeBlobUrl?.startsWith("blob:"));

  /** 删除后重新拉取清单（保留已解析的元数据与当前分页位置，只更新条目） */
  async function refetchManifest() {
    try {
      const data = await fetchAlbumManifestOrThrow();
      setManifest(data as AlbumManifest);
    } catch (e) {
      console.warn("[album] 删除后重新加载清单失败:", e);
    }
  }

  /**
   * 确认删除：先从清单移除，再删 OSS 密文（顺序由 deleteAlbumAsset 保证）。
   * 这是不可恢复操作，所以必须由使用者显式确认后才调用。
   */
  async function confirmDelete() {
    if (!deleteTarget) return;
    const cfg = loadOssConfigFromSession();
    if (!cfg) {
      setDeleteError("需要先在「相册管理」页保存 OSS 上传配置，删除请求才能签名。");
      return;
    }

    setDeleting(true);
    setDeleteError(null);
    try {
      const objectKey = deleteTarget.cipherFile?.trim() || deleteTarget.file?.trim() || "";
      const report = await deleteAlbumAsset(cfg, deleteTarget);

      // 立刻丢掉已解密的明文，避免它继续留在内存里
      if (objectKey) removeAlbumBlobUrl(objectKey);

      if (report.warning) {
        // 部分成功：留在弹窗里展示，别用 1.6 秒就消失的 toast
        setDeleteResult(report.warning);
        await refetchManifest();
        return;
      }

      setDeleteTarget(null);
      setActiveIndex(null);
      await refetchManifest();
      setToast(report.objectAlreadyGone ? "这张照片已删除（密文此前已不存在）" : "已删除这张照片");
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }

  /** 下载当前大图：直接复用已解密并展示中的 Blob URL，不重新下载 */
  function downloadActiveImage() {
    if (!active || !activeBlobUrl || !canDownloadActive) {
      setToast("图片还没准备好，请稍后再试");
      return;
    }
    const a = document.createElement("a");
    a.href = activeBlobUrl;
    a.download = downloadFilename(active);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setToast("已开始下载");
  }

  async function copyText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setToast(`${label}已复制`);
    } catch {
      // 兼容极少数环境
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        ta.style.top = "-9999px";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        setToast(`${label}已复制`);
      } catch {
        setToast("复制失败");
      }
    }
  }

  // 准入的唯一依据：真的持有密钥会话。
  // 旧实现用一个独立的 sessionStorage 标记判断，会出现「标记还在、密钥已丢」的情况
  // （刷新页面后就是如此）→ 相册渲染出来却一张都解不开，而且不会回到登录页。
  if (!keySession) {
    return <Navigate to="/" replace state={{ needKey: true }} />;
  }

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-black/20">
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/30 via-black/10 to-black/40" />

      <header className="relative z-10 flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Link
            to="/"
            className="shrink-0 rounded-xl border border-white/20 bg-black/20 px-3 py-2 text-sm font-extrabold text-white/90 backdrop-blur hover:bg-black/30"
          >
            返回
          </Link>
          <div className="min-w-0">
            <div className="text-sm font-extrabold tracking-wide text-white/90">相册</div>
            <div className="truncate text-[11px] font-bold text-white/55">{keySession.username}</div>
          </div>
          {keySession?.isAdmin ? (
            <Link
              to="/album-admin"
              className="ml-1 shrink-0 rounded-xl border border-amber-400/35 bg-amber-500/15 px-3 py-1.5 text-[11px] font-extrabold text-amber-100/95 hover:bg-amber-500/25"
            >
              管理
            </Link>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2 rounded-2xl border border-white/15 bg-black/15 p-1 backdrop-blur">
          <button
            type="button"
            onClick={() => setMode("time")}
            className={cn(
              "rounded-2xl px-3 py-2 text-xs font-extrabold tracking-wide text-white/80",
              mode === "time" && "bg-white/15 text-white",
            )}
          >
            按时间
          </button>
          <button
            type="button"
            onClick={() => setMode("world")}
            className={cn(
              "rounded-2xl px-3 py-2 text-xs font-extrabold tracking-wide text-white/80",
              mode === "world" && "bg-white/15 text-white",
            )}
          >
            按世界
          </button>
        </div>
      </header>

      <main ref={scrollRef} className="relative z-10 flex-1 overflow-auto px-4 pb-6">
        <div className="mx-auto w-full max-w-6xl">
          {error ? (
            <div
              className="mt-4 rounded-2xl border border-red-400/30 bg-red-950/30 p-4 text-sm text-red-100"
              title={error}
            >
              相册暂时打不开，请稍后再试。
              <div className="mt-1 text-xs text-red-200/70">如果一直这样，请联系站长。</div>
            </div>
          ) : null}

          {!manifest && !error ? (
            <div className="mt-10 text-center text-sm font-bold text-white/70">正在加载相册…</div>
          ) : null}

          {manifest ? (
            <>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-white/70">
                <div>
                  共 <span className="font-extrabold text-white/90">{accessibleAssets.length}</span> 张
                  {hiddenCount > 0 ? (
                    <span className="ml-2 text-white/45">
                      （另有 {hiddenCount} 张不在当前身份的权限内）
                    </span>
                  ) : null}
                </div>
              </div>

              {accessibleAssets.length === 0 ? (
                <div className="mt-10 text-center text-sm font-bold text-white/70">
                  {hiddenCount > 0
                    ? "这里的照片不在当前身份的权限内。"
                    : "相册暂无照片，管理员上传后会自动显示。"}
                </div>
              ) : null}

              {mode === "time" ? (
                <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {visibleTimeAssets.map((a) => (
                    <button
                      key={a.assetId}
                      type="button"
                      onClick={() => setActiveIndex(indexById.get(a.assetId) ?? 0)}
                      className="group overflow-hidden rounded-2xl border border-white/10 bg-white/5 shadow-[0_18px_60px_rgba(0,0,0,0.35)]"
                      title={a.world?.worldName ?? a.world?.worldId ?? "世界未知"}
                    >
                      <div className="relative aspect-[4/3] w-full bg-black/20">
                        <TimeCardImage asset={a} onResolvedMetadata={handleResolvedMetadata} />
                      </div>
                      <div className="flex flex-col gap-0.5 px-3 py-2 text-left">
                        <div className="truncate text-[11px] font-extrabold text-white/85">
                          {formatTs(a._takenAtTs)}
                        </div>
                        <span
                          role="button"
                          tabIndex={0}
                          className="truncate text-left text-[11px] text-white/60 hover:text-white/85"
                          title="点击复制世界名称/ID"
                          onClick={(e) => {
                            // 外层卡片是 button，这里不能再嵌套 button
                            e.preventDefault();
                            e.stopPropagation();
                            const name = a.world?.worldName?.trim();
                            const id = a.world?.worldId?.trim();
                            if (name) {
                              void copyText(name, "世界名称");
                              return;
                            }
                            if (id) {
                              void copyText(id, "WorldID");
                              return;
                            }
                            setToast("无世界信息可复制");
                          }}
                          onKeyDown={(e) => {
                            if (e.key !== "Enter" && e.key !== " ") return;
                            e.preventDefault();
                            e.stopPropagation();
                            const name = a.world?.worldName?.trim();
                            const id = a.world?.worldId?.trim();
                            if (name) {
                              void copyText(name, "世界名称");
                              return;
                            }
                            if (id) {
                              void copyText(id, "WorldID");
                              return;
                            }
                            setToast("无世界信息可复制");
                          }}
                        >
                          {a.world?.worldName ?? (a.world?.worldId ? a.world.worldId : "世界未知")}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="mt-4 flex flex-col gap-3">
                  {worldGroups.map((g) => (
                    <details
                      key={g.worldId}
                      className="rounded-2xl border border-white/10 bg-white/5 shadow-[0_18px_60px_rgba(0,0,0,0.28)]"
                      open={g.worldId !== "unknown"}
                    >
                      <summary className="cursor-pointer list-none select-none px-4 py-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            <button
                              type="button"
                              className="block w-full truncate text-left text-sm font-extrabold text-white/90 hover:text-white"
                              title="点击复制世界名称"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                if (g.worldName) void copyText(g.worldName, "世界名称");
                              }}
                            >
                              {g.worldName}
                            </button>
                            <button
                              type="button"
                              className="block w-full truncate text-left text-[11px] text-white/60 hover:text-white/85"
                              title="点击复制 WorldID"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                if (g.worldId && g.worldId !== "unknown") {
                                  void copyText(g.worldId, "WorldID");
                                  return;
                                }
                                setToast("WorldID 为空（待填写）");
                              }}
                            >
                              {g.worldId === "unknown" ? "WorldID 为空（待填写）" : g.worldId}
                            </button>
                          </div>
                          <div className="flex items-center gap-3 text-[11px] text-white/70">
                            <div>
                              {g.items.length} 张
                            </div>
                            <div className="hidden sm:block">
                              最新：{formatTs(g.latestTs)}
                            </div>
                          </div>
                        </div>
                      </summary>
                      <div className="grid grid-cols-2 gap-3 px-4 pb-4 pt-1 sm:grid-cols-3 lg:grid-cols-4">
                        {g.items.map((a) => {
                          const idx = indexById.get(a.assetId) ?? 0;
                          return (
                            <button
                              key={a.assetId}
                              type="button"
                              onClick={() => setActiveIndex(idx)}
                              className="group overflow-hidden rounded-2xl border border-white/10 bg-black/10"
                            >
                              <div className="relative aspect-[4/3] w-full bg-black/20">
                                <TimeCardImage asset={a} onResolvedMetadata={handleResolvedMetadata} />
                              </div>
                              <div className="px-3 py-2 text-left text-[11px] font-extrabold text-white/80">
                                {formatTs(a._takenAtTs)}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </details>
                  ))}
                </div>
              )}
            </>
          ) : null}

          {manifest && mode === "time" ? (
            <div ref={loadMoreRef} className="h-10" aria-hidden="true" />
          ) : null}
        </div>
      </main>

      {active ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setActiveIndex(null)}
        >
          <div
            className="relative w-full max-w-6xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2 pb-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-extrabold text-white/90">
                  {formatTs(active._takenAtTs)}
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <button
                    type="button"
                    className="truncate text-left text-xs text-white/60 hover:text-white/85"
                    title="点击复制世界名称"
                    onClick={() => {
                      const name = active.world?.worldName?.trim();
                      if (!name) return setToast("无世界名称可复制");
                      void copyText(name, "世界名称");
                    }}
                  >
                    {active.world?.worldName ?? "世界未知"}
                  </button>
                  <button
                    type="button"
                    className="truncate text-left text-xs text-white/60 hover:text-white/85"
                    title="点击复制 WorldID"
                    onClick={() => {
                      const id = active.world?.worldId?.trim();
                      if (!id) return setToast("无 WorldID 可复制");
                      void copyText(id, "WorldID");
                    }}
                  >
                    {active.world?.worldId ? `WorldID: ${active.world.worldId}` : "WorldID: -"}
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="rounded-xl border border-white/20 bg-white/5 px-3 py-2 text-xs font-extrabold text-white/85 hover:bg-white/10 disabled:opacity-40"
                  title="保存这张图片到本地"
                  aria-label="下载图片"
                  disabled={!canDownloadActive}
                  onClick={downloadActiveImage}
                >
                  <span className="inline-flex items-center gap-2">
                    <Download className="h-4 w-4" aria-hidden="true" />
                    下载
                  </span>
                </button>
                <button
                  type="button"
                  className="rounded-xl border border-white/20 bg-white/5 px-3 py-2 text-xs font-extrabold text-white/85 hover:bg-white/10"
                  title="查看更多图片信息"
                  aria-label="查看更多图片信息"
                  onClick={() => setIsInfoOpen((v) => !v)}
                >
                  <span className="inline-flex items-center gap-2">
                    <AlertCircle className="h-4 w-4" aria-hidden="true" />
                    更多
                  </span>
                </button>
                {keySession?.isAdmin ? (
                  <button
                    type="button"
                    className="rounded-xl border border-red-400/40 bg-red-500/15 px-3 py-2 text-xs font-extrabold text-red-100 hover:bg-red-500/25"
                    title="删除这张照片（不可恢复）"
                    aria-label="删除照片"
                    onClick={() => {
                      setDeleteError(null);
                      setDeleteResult(null);
                      setDeleteTarget(active);
                    }}
                  >
                    <span className="inline-flex items-center gap-2">
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                      删除
                    </span>
                  </button>
                ) : null}
                <button
                  type="button"
                  className="rounded-xl border border-white/20 bg-white/5 px-3 py-2 text-xs font-extrabold text-white/85 hover:bg-white/10"
                  onClick={() =>
                    setActiveIndex((idx) => {
                      if (idx === null) return idx;
                      return (idx - 1 + timeSorted.length) % timeSorted.length;
                    })
                  }
                >
                  上一张 ←
                </button>
                <button
                  type="button"
                  className="rounded-xl border border-white/20 bg-white/5 px-3 py-2 text-xs font-extrabold text-white/85 hover:bg-white/10"
                  onClick={() =>
                    setActiveIndex((idx) => {
                      if (idx === null) return idx;
                      return (idx + 1) % timeSorted.length;
                    })
                  }
                >
                  下一张 →
                </button>
                <button
                  type="button"
                  className="rounded-xl border border-white/20 bg-white/5 px-3 py-2 text-xs font-extrabold text-white/85 hover:bg-white/10"
                  onClick={() => setActiveIndex(null)}
                >
                  关闭 Esc
                </button>
              </div>
            </div>

            {isInfoOpen ? (
              <div className="mb-3 rounded-2xl border border-white/10 bg-white/5 p-3 text-xs text-white/80">
                <div className="flex flex-wrap gap-x-6 gap-y-2">
                  <div>
                    <span className="text-white/60">文件名：</span>
                    <span className="font-extrabold break-all">{active.originalName ?? "未知"}</span>
                  </div>
                  <div>
                    <span className="text-white/60">尺寸：</span>
                    <span className="font-extrabold">
                      {active.width && active.height ? `${active.width}×${active.height}` : "未知"}
                    </span>
                  </div>
                  <div>
                    <span className="text-white/60">拍摄时间：</span>
                    <span className="font-extrabold">{active.takenAt ?? "未知"}</span>
                  </div>
                  {/* ---- 以下为排查"是否用错密钥上传"所需的诊断信息 ---- */}
                  <div>
                    <span className="text-white/60">归属 Zone：</span>
                    <span className="font-extrabold">{active.zoneId ?? "（未声明）"}</span>
                    <span
                      className={activeZoneKeyOk ? "ml-2 text-emerald-200/90" : "ml-2 text-rose-200/90"}
                    >
                      {activeZoneKeyOk ? "当前会话持有该区密钥" : "当前会话没有该区密钥"}
                    </span>
                  </div>
                  <div>
                    <span className="text-white/60">加密方式：</span>
                    <span className="font-extrabold">
                      {active.encrypted === undefined
                        ? "尚未解密，未知"
                        : active.encrypted
                          ? "AES-256-GCM 密文"
                          : "明文对象（未加密）"}
                    </span>
                  </div>
                  <div>
                    <span className="text-white/60">上传时密钥指纹：</span>
                    <span className="font-extrabold">{active.keyFp ?? "（清单未记录）"}</span>
                  </div>
                  <div>
                    <span className="text-white/60">本次解密密钥指纹：</span>
                    <span className="font-extrabold">{active.decryptKeyFp ?? "（未解密）"}</span>
                  </div>
                  {active.keyFp && active.decryptKeyFp ? (
                    <div
                      className={
                        active.keyFp === active.decryptKeyFp
                          ? "text-emerald-200/90"
                          : "text-rose-200/90"
                      }
                    >
                      {active.keyFp === active.decryptKeyFp
                        ? "✓ 加密与解密用的是同一把密钥"
                        : "⚠️ 加密与解密用的不是同一把密钥（清单记录与实际不符）"}
                    </div>
                  ) : null}
                  {active.encrypted === false ? (
                    <div className="text-amber-200/90">
                      ⚠️ 这条是明文对象：没有加密，任何知道该对象键的人都能取到原图
                    </div>
                  ) : null}
                  <div>
                    <span className="text-white/60">OSS 对象键：</span>
                    <span className="font-extrabold break-all">{activeObjectKey || "（无）"}</span>
                  </div>
                  <div>
                    <span className="text-white/60">相对路径：</span>
                    <span className="font-extrabold break-all">{active.relPath ?? "（未记录）"}</span>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/30">
              <ActiveImage
                asset={active}
                onResolvedMetadata={handleResolvedMetadata}
                onBlobUrlChange={setActiveBlobUrl}
              />
            </div>
          </div>
        </div>
      ) : null}

      {deleteTarget ? (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="删除照片"
          onClick={() => {
            if (deleting) return;
            setDeleteTarget(null);
            setDeleteResult(null);
            setDeleteError(null);
          }}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-red-400/30 bg-zinc-900/95 p-4 text-sm text-white/90 shadow-[0_18px_60px_rgba(0,0,0,0.5)]"
            onClick={(e) => e.stopPropagation()}
          >
            {deleteResult ? (
              <>
                <div className="text-sm font-extrabold text-amber-200">删除未完全完成</div>
                <p className="mt-2 text-xs leading-relaxed text-white/75">{deleteResult}</p>
                <div className="mt-4 flex justify-end">
                  <button
                    type="button"
                    className="rounded-xl border border-white/20 bg-white/5 px-4 py-2 text-xs font-extrabold text-white/85 hover:bg-white/10"
                    onClick={() => {
                      setDeleteTarget(null);
                      setDeleteResult(null);
                    }}
                  >
                    关闭
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="text-sm font-extrabold text-red-100">确认删除这张照片？</div>
                <p className="mt-2 break-all text-xs text-white/70">
                  {downloadFilename(deleteTarget)}
                </p>
                <p className="mt-3 text-xs leading-relaxed text-amber-200/90">
                  会同时删除 OSS 上的密文文件，
                  <strong className="text-amber-100">删除后无法恢复</strong>
                  （存储桶未开启版本控制）。请确认没有其他地方还需要它。
                </p>
                {deleteError ? (
                  <p className="mt-3 rounded-lg border border-rose-400/30 bg-rose-950/40 px-3 py-2 text-xs leading-relaxed text-rose-100">
                    {deleteError}
                  </p>
                ) : null}
                <div className="mt-4 flex justify-end gap-2">
                  <button
                    type="button"
                    disabled={deleting}
                    className="rounded-xl border border-white/20 bg-white/5 px-4 py-2 text-xs font-extrabold text-white/85 hover:bg-white/10 disabled:opacity-40"
                    onClick={() => {
                      setDeleteTarget(null);
                      setDeleteError(null);
                    }}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={deleting}
                    className="rounded-xl border border-red-400/50 bg-red-500/30 px-4 py-2 text-xs font-extrabold text-red-50 hover:bg-red-500/40 disabled:opacity-40"
                    onClick={() => void confirmDelete()}
                  >
                    {deleting ? "正在删除…" : "确认删除"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      {toast ? (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-[60] -translate-x-1/2">
          <div className="rounded-2xl border border-white/15 bg-black/60 px-4 py-2 text-xs font-extrabold text-white/90 backdrop-blur">
            {toast}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TimeCardImage({
  asset,
  onResolvedMetadata,
}: {
  asset: AlbumAsset;
  onResolvedMetadata?: (assetId: string, meta: AssetResolvedMetadata) => void;
}) {
  const [retry, setRetry] = useState(0);
  const url = useAssetImageUrl(asset, retry, onResolvedMetadata);
  const objectKey = asset.file?.trim() || asset.cipherFile?.trim() || "";
  // 保持现有视觉：未拿到 url 时显示背景，不额外加新 UI
  return url ? (
    <img
      src={url}
      alt={asset.assetId}
      loading="lazy"
      className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
      onError={() => {
        if (!objectKey) return;
        if (retry >= 1) return;
        invalidateSignedUrlCacheForObjectKey(objectKey);
        setRetry(1);
      }}
    />
  ) : null;
}

function ActiveImage({
  asset,
  onResolvedMetadata,
  onBlobUrlChange,
}: {
  asset: AlbumAsset;
  onResolvedMetadata?: (assetId: string, meta: AssetResolvedMetadata) => void;
  /** 把当前解密后的 Blob URL 交给父组件，供「下载」按钮直接复用 */
  onBlobUrlChange?: (url: string | undefined) => void;
}) {
  const [retry, setRetry] = useState(0);
  const url = useAssetImageUrl(asset, retry, onResolvedMetadata);
  const objectKey = asset.file?.trim() || asset.cipherFile?.trim() || "";

  useEffect(() => {
    onBlobUrlChange?.(url);
  }, [url, onBlobUrlChange]);

  return url ? (
    <img
      src={url}
      alt={asset.assetId}
      className="max-h-[80vh] w-full object-contain"
      onError={() => {
        if (!objectKey) return;
        if (retry >= 1) return;
        invalidateSignedUrlCacheForObjectKey(objectKey);
        setRetry(1);
      }}
    />
  ) : null;
}

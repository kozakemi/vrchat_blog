import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { LanguageSwitch } from "@/components/LanguageSwitch";
// 组件外的那几个辅助函数拿不到 useTranslation 的 t，直接向 i18n 实例取同一份文案。
import i18n from "@/i18n";
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
import { changeAlbumAssetZone } from "@/lib/albumZoneChange";
import { readImageSize, readU32BE } from "@/lib/imageSize";
import { keyFingerprintB64 } from "@/lib/keyFingerprint";
import { rewriteOssUrlForDevFetch } from "@/lib/ossDevProxy";
import { fetchSignedUrlForOssObject, invalidateSignedUrlCacheForObjectKey } from "@/lib/ossSignFetch";
import { loadOssConfigFromSession } from "@/lib/ossUploadConfig";
import { cn } from "@/lib/utils";
import {
  applyZoneVisibility,
  buildZoneFilterOptions,
  clearZoneVisibility,
  loadZoneVisibility,
  saveZoneVisibility,
  zoneVisibilityScope,
  type ZoneVisibility,
} from "@/lib/zoneVisibility";
import { AlertCircle, Download, FolderInput, Trash2 } from "lucide-react";
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

/** 时间戳格式化；时间未知时的文案由调用方传入（这里拿不到 t） */
function formatTs(ts: number, unknownLabel: string) {
  if (!Number.isFinite(ts) || ts <= 0) return unknownLabel;
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
  if (!res.ok) throw new Error(i18n.t("album.errImageRequest", { status: res.status }));
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
  if (!res.ok) throw new Error(i18n.t("album.errCipherRequest", { status: res.status }));

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
        if (!signed) throw new Error(i18n.t("album.errSignUrl"));
        return fetchAsBlobUrl(asset, signed, asset.mime);
      }

      if (!cipherFile) throw new Error(i18n.t("album.errNoObjectKey"));
      if (!access.zoneKeyB64) {
        throw new Error(i18n.t("album.errNoZoneKey", { zone: asset.zoneId ?? "?" }));
      }
      if (!asset.nonceB64?.trim()) throw new Error(i18n.t("album.errNoNonce"));

      const signed = await fetchSignedUrlForOssObject(cipherFile);
      if (!signed) throw new Error(i18n.t("album.errCipherUrl"));

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
  const { t } = useTranslation();
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

  // 管理员修改归属 Zone（仅 isAdmin 可见）：zoneTarget 非空即弹出确认框
  const [zoneTarget, setZoneTarget] = useState<AlbumAsset | null>(null);
  const [zoneTargetId, setZoneTargetId] = useState("");
  const [zoneChanging, setZoneChanging] = useState(false);
  const [zoneError, setZoneError] = useState<string | null>(null);
  /** 非空表示"迁移成功但旧文件没删掉"，确认框改为只展示说明 */
  const [zoneResult, setZoneResult] = useState<string | null>(null);

  /**
   * Zone 显示开关：**纯界面筛选，只影响当前浏览者**。
   * 它不参与权限判定、不改清单、不影响别人（见 lib/zoneVisibility 里的说明）。
   */
  const [zoneVisibility, setZoneVisibility] = useState<ZoneVisibility>({});

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
   * Zone 开关的作用域：用户名 + 该密钥文件里的 Zone 集合。
   * 换用户、或换一份 Zone 集合不同的密钥文件都会得到新作用域，
   * 因此不会把上一个人的隐藏设置带过来（代价是增删 Zone 会回到"全部显示"）。
   */
  const zoneScope = useMemo(
    () => zoneVisibilityScope(keySession?.username, keySession?.zones),
    [keySession?.username, keySession?.zones],
  );

  useEffect(() => {
    setZoneVisibility(loadZoneVisibility(zoneScope, keySession?.zones));
  }, [zoneScope, keySession?.zones]);

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

  /**
   * Zone 开关只做减法：在"有权查看"的集合里再筛掉被关掉的 Zone。
   * **顺序不可颠倒**——先鉴权、后筛选。反过来的话，界面开关就成了权限开关。
   */
  const zoneFilteredAssets = useMemo(
    () => applyZoneVisibility(accessibleAssets, zoneVisibility),
    [accessibleAssets, zoneVisibility],
  );

  const timeSorted = useMemo(() => {
    const assets = zoneFilteredAssets;
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
  }, [zoneFilteredAssets, resolvedMetaById]);

  /**
   * 当前大图被筛掉时收起灯箱。
   * 不加这一步的话，关掉某个 Zone 后 activeIndex 会指向一个已不存在的条目，
   * 灯箱会凭空消失、Escape 之外没有任何办法退出。
   */
  useEffect(() => {
    if (activeIndex === null) return;
    if (timeSorted[activeIndex]) return;
    setActiveIndex(null);
  }, [activeIndex, timeSorted]);

  /**
   * Zone 开关列表。规则见 `buildZoneFilterOptions`：**按会话持有的 Zone 决定**，
   * 不按"有照片的 Zone"决定 —— 后者会让"刚建好私密区、还没放照片"时整排开关
   * 都消失，而那正是想先把开关配好的时刻。
   */
  const zoneFilters = useMemo(
    () => buildZoneFilterOptions(keySession?.zones, accessibleAssets, zoneVisibility),
    [keySession?.zones, accessibleAssets, zoneVisibility],
  );

  /** 被 Zone 开关筛掉的数量（用于提示"有几张没显示"） */
  const hiddenByZoneCount = accessibleAssets.length - zoneFilteredAssets.length;

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
        a.world?.worldName || (worldId === "unknown" ? t("album.worldUnknownPending") : worldId);

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
  }, [timeSorted, t]);

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

  /**
   * 「改 Zone」弹窗所需的派生信息。
   *
   * 目标 Zone 只能从**当前会话自己持有的 Zone** 里挑：迁移要用新 Zone 的密钥重新加密，
   * 手里没有密钥就无从加密。同理，如果连旧 Zone 的密钥都没有（密文解不开），
   * 这个操作根本不可能完成，界面要提前说清楚而不是等点了按钮再报错。
   */
  const zoneDialog = useMemo(() => {
    if (!zoneTarget) return null;
    const zones = keySession?.zones ?? [];
    const from = zoneTarget.zoneId?.trim() || "";
    const isCipher = Boolean(zoneTarget.cipherFile?.trim());
    return {
      from,
      isCipher,
      /** 非密文（明文对象）不需要旧密钥；密文则必须持有旧 Zone 的密钥才解得开 */
      hasSourceKey: !isCipher || zones.some((z) => z.zoneId === from),
      options: zones.filter((z) => z.zoneId !== from),
      fileName: downloadFilename(zoneTarget),
    };
  }, [zoneTarget, keySession?.zones]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 1600);
    return () => window.clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    // 切换图片或关闭 lightbox 时，默认关闭“更多信息”，并清掉上一张的下载地址
    setIsInfoOpen(false);
    setActiveBlobUrl(undefined);
    // 「改 Zone」弹窗绑定的是某一张具体的照片，换图后必须收起，
    // 否则会对着 A 的确认框去改 B。
    setZoneTarget(null);
    setZoneError(null);
    setZoneResult(null);
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
      setDeleteError(t("album.errDeleteNeedsOssConfig"));
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
      setToast(
        report.objectAlreadyGone ? t("album.deletedGone") : t("album.deleted"),
      );
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }

  /**
   * 确认迁移：取回原图 → 用旧 Zone 密钥解密 → 用新 Zone 密钥重新加密
   * → 上传为新对象 → 改写清单 → 删除旧对象。
   *
   * 顺序与"任何一步失败都还能看"的保证都由 changeAlbumAssetZone 负责，
   * 这里只处理界面状态与内存里的明文缓存。
   */
  async function confirmChangeZone() {
    if (!zoneTarget) return;
    const cfg = loadOssConfigFromSession();
    if (!cfg) {
      setZoneError(t("album.errZoneNeedsOssConfig"));
      return;
    }
    const target = zoneTargetId.trim();
    if (!target) {
      setZoneError(t("album.zoneSelectRequired"));
      return;
    }

    setZoneChanging(true);
    setZoneError(null);
    try {
      const report = await changeAlbumAssetZone(cfg, zoneTarget, target, keySession?.zones ?? []);

      // 已解密的明文留在内存里已经没有意义了，全部丢掉：
      // 旧对象键下的缓存不只是浪费内存，它还会让"迁移后仍显示旧内容"这种情况发生。
      for (const key of [report.newObjectKey, ...report.orphanObjectKeys]) {
        removeAlbumBlobUrl(key);
      }
      const oldCipher = zoneTarget.cipherFile?.trim();
      const oldPlain = zoneTarget.file?.trim();
      if (oldCipher) removeAlbumBlobUrl(oldCipher);
      if (oldPlain) removeAlbumBlobUrl(oldPlain);

      await refetchManifest();

      if (report.warning) {
        setZoneResult(report.warning);
        return;
      }
      setZoneTarget(null);
      setToast(
        report.fromPlaintext
          ? t("album.zoneMovedEncrypted", { zone: report.toZoneId })
          : t("album.zoneMoved", { zone: report.toZoneId }),
      );
    } catch (e) {
      setZoneError(e instanceof Error ? e.message : String(e));
    } finally {
      setZoneChanging(false);
    }
  }

  /**
   * 勾选/取消某个 Zone 的显示。
   * 这是**纯界面筛选**：不改权限、不改清单、不影响别人，只决定自己看不看得到。
   */
  function setZoneShown(zoneId: string, shown: boolean) {
    const next: ZoneVisibility = { ...zoneVisibility, [zoneId]: shown };
    setZoneVisibility(next);
    saveZoneVisibility(zoneScope, next);
  }

  function showAllZones() {
    const next: ZoneVisibility = {};
    for (const z of keySession?.zones ?? []) next[z.zoneId] = true;
    setZoneVisibility(next);
    clearZoneVisibility(zoneScope);
  }

  /** 下载当前大图：直接复用已解密并展示中的 Blob URL，不重新下载 */
  function downloadActiveImage() {
    if (!active || !activeBlobUrl || !canDownloadActive) {
      setToast(t("album.imageNotReady"));
      return;
    }
    const a = document.createElement("a");
    a.href = activeBlobUrl;
    a.download = downloadFilename(active);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setToast(t("album.downloadStarted"));
  }

  async function copyText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setToast(t("album.copied", { label }));
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
        setToast(t("album.copied", { label }));
      } catch {
        setToast(t("album.copyFailed"));
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
            {t("album.back")}
          </Link>
          <div className="min-w-0">
            <div className="text-sm font-extrabold tracking-wide text-white/90">
              {t("album.title")}
            </div>
            <div className="truncate text-[11px] font-bold text-white/55">{keySession.username}</div>
          </div>
          {keySession?.isAdmin ? (
            <Link
              to="/album-admin"
              className="ml-1 shrink-0 rounded-xl border border-amber-400/35 bg-amber-500/15 px-3 py-1.5 text-[11px] font-extrabold text-amber-100/95 hover:bg-amber-500/25"
            >
              {t("album.adminLink")}
            </Link>
          ) : null}
          <Link
            to="/about"
            className="shrink-0 rounded-xl border border-white/15 bg-black/15 px-3 py-1.5 text-[11px] font-extrabold text-white/70 backdrop-blur hover:bg-black/30"
          >
            {t("album.aboutLink")}
          </Link>
        </div>

        {/* 右侧一组：视图切换 + 语言切换。外面这层不是多余的——header 是 justify-between，
            把语言切换器直接当第三个子元素会让「按时间 / 按世界」飘到页头正中间。 */}
        <div className="flex shrink-0 items-center gap-2">
          <div className="flex shrink-0 items-center gap-2 rounded-2xl border border-white/15 bg-black/15 p-1 backdrop-blur">
            <button
              type="button"
              onClick={() => setMode("time")}
              className={cn(
                "rounded-2xl px-3 py-2 text-xs font-extrabold tracking-wide text-white/80",
                mode === "time" && "bg-white/15 text-white",
              )}
            >
              {t("album.byTime")}
            </button>
            <button
              type="button"
              onClick={() => setMode("world")}
              className={cn(
                "rounded-2xl px-3 py-2 text-xs font-extrabold tracking-wide text-white/80",
                mode === "world" && "bg-white/15 text-white",
              )}
            >
              {t("album.byWorld")}
            </button>
          </div>

          <LanguageSwitch className="shrink-0 rounded-xl border border-white/20 bg-black/20 px-3 py-2 text-xs font-extrabold text-white/80 backdrop-blur hover:bg-black/30" />
        </div>
      </header>

      {/*
        Zone 显示开关。条件看的是**有照片的 Zone**（见 buildZoneFilterOptions）：
        只有一个 Zone 有照片时没有可切换的对象，一个孤零零的勾选框只是噪声。
        等私密区有了照片，第二个开关会自己出现。
      */}
      {zoneFilters.length > 1 ? (
        <div className="relative z-10 flex flex-wrap items-center gap-2 px-4 pb-2">
          <span className="text-[11px] font-bold tracking-wide text-white/45">
            {t("album.showZone")}
          </span>
          {zoneFilters.map((z) => (
            <label
              key={z.zoneId}
              title={[
                z.comment ? `${z.zoneId} — ${z.comment}` : z.zoneId,
                z.count === 0 ? t("album.zoneEmpty") : t("album.photosCount", { count: z.count }),
              ].join(" · ")}
              className={cn(
                "inline-flex cursor-pointer items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-[11px] font-extrabold backdrop-blur transition-colors",
                z.visible
                  ? "border-white/20 bg-black/25 text-white/85 hover:bg-black/35"
                  : "border-white/10 bg-black/10 text-white/40 hover:bg-black/20",
              )}
            >
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-amber-400"
                checked={z.visible}
                onChange={(e) => setZoneShown(z.zoneId, e.currentTarget.checked)}
              />
              <span className="font-mono">{z.zoneId}</span>
              <span className={z.visible && z.count > 0 ? "text-white/45" : "text-white/25"}>
                {z.count}
              </span>
            </label>
          ))}
          {hiddenByZoneCount > 0 ? (
            <button
              type="button"
              className="rounded-xl border border-amber-400/40 bg-amber-500/15 px-2.5 py-1.5 text-[11px] font-extrabold text-amber-100 hover:bg-amber-500/25"
              onClick={showAllZones}
            >
              {t("album.showAllHidden", { count: hiddenByZoneCount })}
            </button>
          ) : null}
        </div>
      ) : null}

      <main ref={scrollRef} className="relative z-10 flex-1 overflow-auto px-4 pb-6">
        <div className="mx-auto w-full max-w-6xl">
          {error ? (
            <div className="mt-4 rounded-2xl border border-red-400/30 bg-red-950/30 p-4 text-sm text-red-100">
              <div>{t("album.loadFailedTitle")}</div>
              <div className="mt-1 text-xs text-red-200/70">{t("album.loadFailedHint")}</div>
              <details className="mt-2 text-[11px] text-red-200/60">
                <summary className="cursor-pointer">{t("album.technicalDetail")}</summary>
                <pre className="mt-1 whitespace-pre-wrap break-all font-mono">{error}</pre>
              </details>
            </div>
          ) : null}

          {!manifest && !error ? (
            <div className="mt-10 text-center text-sm font-bold text-white/70">
              {t("album.loading")}
            </div>
          ) : null}

          {manifest ? (
            <>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-white/70">
                <div>
                  {/*
                    用 <Trans> 而不是 t()：数字上原有的加粗高亮要保住。
                    带标记的整句没法用 t() 表达（那会变成三个碎片 key，英文语序排不顺）。
                  */}
                  <Trans
                    i18nKey="album.totalCount"
                    count={timeSorted.length}
                    components={{ strong: <span className="font-extrabold text-white/90" /> }}
                  />
                  {hiddenByZoneCount > 0 ? (
                    <span className="ml-2 text-white/45">
                      {t("album.hiddenByZoneNote", { count: hiddenByZoneCount })}
                    </span>
                  ) : null}
                  {hiddenCount > 0 ? (
                    <span className="ml-2 text-white/45">
                      {t("album.hiddenByPermissionNote", { count: hiddenCount })}
                    </span>
                  ) : null}
                </div>
              </div>

              {timeSorted.length === 0 ? (
                <div className="mt-10 text-center text-sm font-bold text-white/70">
                  {hiddenByZoneCount > 0
                    ? t("album.emptyAllHidden")
                    : hiddenCount > 0
                      ? t("album.emptyNoPermission")
                      : t("album.emptyNoPhotos")}
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
                      title={a.world?.worldName ?? a.world?.worldId ?? t("album.worldUnknown")}
                    >
                      <div className="relative aspect-[4/3] w-full bg-black/20">
                        <TimeCardImage asset={a} onResolvedMetadata={handleResolvedMetadata} />
                      </div>
                      <div className="flex flex-col gap-0.5 px-3 py-2 text-left">
                        <div className="truncate text-[11px] font-extrabold text-white/85">
                          {formatTs(a._takenAtTs, t("album.timeUnknown"))}
                        </div>
                        <span
                          role="button"
                          tabIndex={0}
                          className="truncate text-left text-[11px] text-white/60 hover:text-white/85"
                          title={t("album.copyWorldTitle")}
                          onClick={(e) => {
                            // 外层卡片是 button，这里不能再嵌套 button
                            e.preventDefault();
                            e.stopPropagation();
                            const name = a.world?.worldName?.trim();
                            const id = a.world?.worldId?.trim();
                            if (name) {
                              void copyText(name, t("album.worldNameLabel"));
                              return;
                            }
                            if (id) {
                              void copyText(id, "WorldID");
                              return;
                            }
                            setToast(t("album.noWorldInfo"));
                          }}
                          onKeyDown={(e) => {
                            if (e.key !== "Enter" && e.key !== " ") return;
                            e.preventDefault();
                            e.stopPropagation();
                            const name = a.world?.worldName?.trim();
                            const id = a.world?.worldId?.trim();
                            if (name) {
                              void copyText(name, t("album.worldNameLabel"));
                              return;
                            }
                            if (id) {
                              void copyText(id, "WorldID");
                              return;
                            }
                            setToast(t("album.noWorldInfo"));
                          }}
                        >
                          {a.world?.worldName ??
                            (a.world?.worldId ? a.world.worldId : t("album.worldUnknown"))}
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
                              title={t("album.copyWorldNameTitle")}
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                if (g.worldName) void copyText(g.worldName, t("album.worldNameLabel"));
                              }}
                            >
                              {g.worldName}
                            </button>
                            <button
                              type="button"
                              className="block w-full truncate text-left text-[11px] text-white/60 hover:text-white/85"
                              title={t("album.copyWorldIdTitle")}
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                if (g.worldId && g.worldId !== "unknown") {
                                  void copyText(g.worldId, "WorldID");
                                  return;
                                }
                                setToast(t("album.worldIdEmpty"));
                              }}
                            >
                              {g.worldId === "unknown" ? t("album.worldIdEmpty") : g.worldId}
                            </button>
                          </div>
                          <div className="flex items-center gap-3 text-[11px] text-white/70">
                            <div>{t("album.photosCount", { count: g.items.length })}</div>
                            <div className="hidden sm:block">
                              {t("album.latestAt", {
                                time: formatTs(g.latestTs, t("album.timeUnknown")),
                              })}
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
                                {formatTs(a._takenAtTs, t("album.timeUnknown"))}
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
                  {formatTs(active._takenAtTs, t("album.timeUnknown"))}
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <button
                    type="button"
                    className="truncate text-left text-xs text-white/60 hover:text-white/85"
                    title={t("album.copyWorldNameTitle")}
                    onClick={() => {
                      const name = active.world?.worldName?.trim();
                      if (!name) return setToast(t("album.noWorldName"));
                      void copyText(name, t("album.worldNameLabel"));
                    }}
                  >
                    {active.world?.worldName ?? t("album.worldUnknown")}
                  </button>
                  <button
                    type="button"
                    className="truncate text-left text-xs text-white/60 hover:text-white/85"
                    title={t("album.copyWorldIdTitle")}
                    onClick={() => {
                      const id = active.world?.worldId?.trim();
                      if (!id) return setToast(t("album.noWorldId"));
                      void copyText(id, "WorldID");
                    }}
                  >
                    {active.world?.worldId ? `WorldID: ${active.world.worldId}` : "WorldID: -"}
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  className="rounded-xl border border-white/20 bg-white/5 px-3 py-2 text-xs font-extrabold text-white/85 hover:bg-white/10 disabled:opacity-40"
                  title={t("album.saveImageTitle")}
                  aria-label={t("album.downloadImageAria")}
                  disabled={!canDownloadActive}
                  onClick={downloadActiveImage}
                >
                  <span className="inline-flex items-center gap-2">
                    <Download className="h-4 w-4" aria-hidden="true" />
                    {t("album.download")}
                  </span>
                </button>
                <button
                  type="button"
                  className="rounded-xl border border-white/20 bg-white/5 px-3 py-2 text-xs font-extrabold text-white/85 hover:bg-white/10"
                  title={t("album.moreInfo")}
                  aria-label={t("album.moreInfo")}
                  onClick={() => setIsInfoOpen((v) => !v)}
                >
                  <span className="inline-flex items-center gap-2">
                    <AlertCircle className="h-4 w-4" aria-hidden="true" />
                    {t("album.more")}
                  </span>
                </button>
                {keySession?.isAdmin ? (
                  <button
                    type="button"
                    className="rounded-xl border border-sky-400/40 bg-sky-500/15 px-3 py-2 text-xs font-extrabold text-sky-100 hover:bg-sky-500/25"
                    title={t("album.changeZoneTitle")}
                    aria-label={t("album.changeZoneAria")}
                    onClick={() => {
                      setZoneError(null);
                      setZoneResult(null);
                      setZoneTargetId("");
                      setZoneTarget(active);
                    }}
                  >
                    <span className="inline-flex items-center gap-2">
                      <FolderInput className="h-4 w-4" aria-hidden="true" />
                      {t("album.changeZone")}
                    </span>
                  </button>
                ) : null}
                {keySession?.isAdmin ? (
                  <button
                    type="button"
                    className="rounded-xl border border-red-400/40 bg-red-500/15 px-3 py-2 text-xs font-extrabold text-red-100 hover:bg-red-500/25"
                    title={t("album.deleteTitle")}
                    aria-label={t("album.deleteAria")}
                    onClick={() => {
                      setDeleteError(null);
                      setDeleteResult(null);
                      setDeleteTarget(active);
                    }}
                  >
                    <span className="inline-flex items-center gap-2">
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                      {t("album.delete")}
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
                  {t("album.previous")}
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
                  {t("album.next")}
                </button>
                <button
                  type="button"
                  className="rounded-xl border border-white/20 bg-white/5 px-3 py-2 text-xs font-extrabold text-white/85 hover:bg-white/10"
                  onClick={() => setActiveIndex(null)}
                >
                  {t("album.closeEsc")}
                </button>
              </div>
            </div>

            {isInfoOpen ? (
              <div className="mb-3 rounded-2xl border border-white/10 bg-white/5 p-3 text-xs text-white/80">
                <div className="flex flex-wrap gap-x-6 gap-y-2">
                  <div>
                    <span className="text-white/60">{t("album.fileNameLabel")}</span>
                    <span className="font-extrabold break-all">
                      {active.originalName ?? t("album.unknown")}
                    </span>
                  </div>
                  <div>
                    <span className="text-white/60">{t("album.sizeLabel")}</span>
                    <span className="font-extrabold">
                      {active.width && active.height
                        ? `${active.width}×${active.height}`
                        : t("album.unknown")}
                    </span>
                  </div>
                  <div>
                    <span className="text-white/60">{t("album.takenAtLabel")}</span>
                    <span className="font-extrabold">{active.takenAt ?? t("album.unknown")}</span>
                  </div>
                  {/* ---- 以下为排查"是否用错密钥上传"所需的诊断信息 ---- */}
                  <div>
                    <span className="text-white/60">{t("album.zoneLabel")}</span>
                    <span className="font-extrabold">
                      {active.zoneId ?? t("album.zoneNotDeclared")}
                    </span>
                    <span
                      className={activeZoneKeyOk ? "ml-2 text-emerald-200/90" : "ml-2 text-rose-200/90"}
                    >
                      {activeZoneKeyOk ? t("album.zoneKeyHeld") : t("album.zoneKeyMissing")}
                    </span>
                  </div>
                  <div>
                    <span className="text-white/60">{t("album.encryptionLabel")}</span>
                    <span className="font-extrabold">
                      {active.encrypted === undefined
                        ? t("album.encryptionUnknown")
                        : active.encrypted
                          ? t("album.encryptionCipher")
                          : t("album.encryptionPlain")}
                    </span>
                  </div>
                  <div>
                    <span className="text-white/60">{t("album.uploadedKeyFpLabel")}</span>
                    <span className="font-extrabold">
                      {active.keyFp ?? t("album.fpNotRecorded")}
                    </span>
                  </div>
                  <div>
                    <span className="text-white/60">{t("album.decryptKeyFpLabel")}</span>
                    <span className="font-extrabold">
                      {active.decryptKeyFp ?? t("album.fpNotDecrypted")}
                    </span>
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
                        ? t("album.fpMatch")
                        : t("album.fpMismatch")}
                    </div>
                  ) : null}
                  {active.encrypted === false ? (
                    <div className="text-amber-200/90">{t("album.plainWarning")}</div>
                  ) : null}
                  <div>
                    <span className="text-white/60">{t("album.objectKeyLabel")}</span>
                    <span className="font-extrabold break-all">{activeObjectKey || t("album.none")}</span>
                  </div>
                  <div>
                    <span className="text-white/60">{t("album.relPathLabel")}</span>
                    <span className="font-extrabold break-all">
                      {active.relPath ?? t("album.notRecorded")}
                    </span>
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
          aria-label={t("album.deleteAria")}
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
                <div className="text-sm font-extrabold text-amber-200">
                  {t("album.deletePartialTitle")}
                </div>
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
                    {t("album.close")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="text-sm font-extrabold text-red-100">
                  {t("album.deleteConfirmTitle")}
                </div>
                <p className="mt-2 break-all text-xs text-white/70">
                  {downloadFilename(deleteTarget)}
                </p>
                <p className="mt-3 text-xs leading-relaxed text-amber-200/90">
                  <Trans
                    i18nKey="album.deleteWarning"
                    components={{ strong: <strong className="text-amber-100" /> }}
                  />
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
                    {t("album.cancel")}
                  </button>
                  <button
                    type="button"
                    disabled={deleting}
                    className="rounded-xl border border-red-400/50 bg-red-500/30 px-4 py-2 text-xs font-extrabold text-red-50 hover:bg-red-500/40 disabled:opacity-40"
                    onClick={() => void confirmDelete()}
                  >
                    {deleting ? t("album.deleting") : t("album.confirmDelete")}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      {zoneTarget && zoneDialog ? (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={t("album.changeZoneAria")}
          onClick={() => {
            if (zoneChanging) return;
            setZoneTarget(null);
            setZoneResult(null);
            setZoneError(null);
          }}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-sky-400/30 bg-zinc-900/95 p-4 text-sm text-white/90 shadow-[0_18px_60px_rgba(0,0,0,0.5)]"
            onClick={(e) => e.stopPropagation()}
          >
            {zoneResult ? (
              <>
                <div className="text-sm font-extrabold text-amber-200">
                  {t("album.zonePartialTitle")}
                </div>
                <p className="mt-2 text-xs leading-relaxed text-white/75">{zoneResult}</p>
                <div className="mt-4 flex justify-end">
                  <button
                    type="button"
                    className="rounded-xl border border-white/20 bg-white/5 px-4 py-2 text-xs font-extrabold text-white/85 hover:bg-white/10"
                    onClick={() => {
                      setZoneTarget(null);
                      setZoneResult(null);
                    }}
                  >
                    {t("album.close")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="text-sm font-extrabold text-sky-100">
                  {t("album.zoneDialogTitle")}
                </div>
                <p className="mt-2 break-all text-xs text-white/70">{zoneDialog.fileName}</p>

                <div className="mt-3 space-y-1 text-xs text-white/70">
                  <div>
                    {t("album.zoneCurrentLabel")}
                    <span className="font-extrabold text-white/90">
                      {zoneDialog.from || t("album.zoneNotRecorded")}
                    </span>
                  </div>
                  <div>
                    {t("album.zoneStatusLabel")}
                    <span className="font-extrabold text-white/90">
                      {zoneDialog.isCipher
                        ? t("album.zoneStatusEncrypted")
                        : t("album.zoneStatusPlain")}
                    </span>
                  </div>
                </div>

                {!zoneDialog.hasSourceKey ? (
                  <p className="mt-3 rounded-lg border border-rose-400/30 bg-rose-950/40 px-3 py-2 text-xs leading-relaxed text-rose-100">
                    {t("album.zoneNoSourceKey", { zone: zoneDialog.from })}
                  </p>
                ) : zoneDialog.options.length === 0 ? (
                  <p className="mt-3 rounded-lg border border-amber-400/30 bg-amber-950/30 px-3 py-2 text-xs leading-relaxed text-amber-100">
                    {t("album.zoneNoTargetOptions")}
                  </p>
                ) : (
                  <label className="mt-3 block text-[11px] text-white/60">
                    {t("album.zoneSelectLabel")}
                    <select
                      aria-label={t("album.zoneSelectAria")}
                      className="mt-1 w-full rounded-xl border border-white/15 bg-black/40 px-3 py-2 text-xs text-white"
                      value={zoneTargetId}
                      onChange={(e) => setZoneTargetId(e.target.value)}
                    >
                      <option value="">{t("album.zoneSelectPlaceholder")}</option>
                      {zoneDialog.options.map((z) => (
                        <option key={z.zoneId} value={z.zoneId}>
                          {z.zoneId}
                          {z.comment ? ` — ${z.comment}` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                <p className="mt-3 text-[11px] leading-relaxed text-white/55">
                  {t("album.zoneProcessNote")}
                </p>

                {zoneError ? (
                  <p className="mt-3 rounded-lg border border-rose-400/30 bg-rose-950/40 px-3 py-2 text-xs leading-relaxed text-rose-100">
                    {zoneError}
                  </p>
                ) : null}

                <div className="mt-4 flex justify-end gap-2">
                  <button
                    type="button"
                    disabled={zoneChanging}
                    className="rounded-xl border border-white/20 bg-white/5 px-4 py-2 text-xs font-extrabold text-white/85 hover:bg-white/10 disabled:opacity-40"
                    onClick={() => {
                      setZoneTarget(null);
                      setZoneError(null);
                    }}
                  >
                    {t("album.cancel")}
                  </button>
                  <button
                    type="button"
                    disabled={zoneChanging || !zoneTargetId || !zoneDialog.hasSourceKey}
                    className="rounded-xl border border-sky-400/50 bg-sky-500/30 px-4 py-2 text-xs font-extrabold text-sky-50 hover:bg-sky-500/40 disabled:opacity-40"
                    onClick={() => void confirmChangeZone()}
                  >
                    {zoneChanging ? t("album.zoneChanging") : t("album.zoneConfirm")}
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

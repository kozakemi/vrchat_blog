import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { hasAlbumRouteAccess, STORAGE_GUEST_NICKNAME_KEY } from "@/lib/authGate";
import { base64ToBytes, buildAadJson, importAesGcmKey } from "@/lib/albumCrypto";
import { fetchAlbumManifestOrThrow } from "@/lib/albumManifestFetch";
import { rewriteOssUrlForDevFetch } from "@/lib/ossDevProxy";
import { fetchSignedUrlForOssObject, invalidateSignedUrlCacheForObjectKey } from "@/lib/ossSignFetch";
import { cn } from "@/lib/utils";
import { AlertCircle } from "lucide-react";
import { useSessionAuthStore } from "@/store/sessionAuthStore";

type AlbumViewMode = "time" | "world";

type BlobUrlCacheEntry = {
  objectUrl: string;
  createdAt: number;
  lastUsedAt: number;
};

// 控制内存：最多缓存 N 张解码后的 Blob URL（不影响 UI，只影响性能/内存）
const BLOB_URL_CACHE_MAX = 180;
const blobUrlCache = new Map<string, BlobUrlCacheEntry>();

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

type AssetResolvedMetadata = {
  takenAt?: string;
  world?: {
    worldId?: string | null;
    worldName?: string | null;
  };
};

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

function readU32BE(bytes: Uint8Array, offset: number) {
  return (
    (bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]
  ) >>> 0;
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
  const out: AssetResolvedMetadata = { takenAt: inferTakenAt(asset) };
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
    takenAt: takenAt || out.takenAt,
    world: {
      worldId: worldId || null,
      worldName: worldName || null,
    },
  };
}

function evictBlobCacheIfNeeded() {
  if (blobUrlCache.size <= BLOB_URL_CACHE_MAX) return;
  // 按最久未使用淘汰
  const items = [...blobUrlCache.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
  const removeCount = Math.max(1, blobUrlCache.size - BLOB_URL_CACHE_MAX);
  for (let i = 0; i < removeCount; i++) {
    const [key, entry] = items[i];
    URL.revokeObjectURL(entry.objectUrl);
    blobUrlCache.delete(key);
  }
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
  return { objectUrl: URL.createObjectURL(fixedBlob), meta };
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
  return { objectUrl: URL.createObjectURL(blob), meta };
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
    const objectKey = file || cipherFile || "";
    const zoneKeyB64 =
      asset.zoneId && keySession?.zones
        ? keySession.zones.find((z) => z.zoneId === asset.zoneId)?.keyB64
        : undefined;

    if (!file && !cipherFile) {
      setUrl(fallback);
      return;
    }

    // 1) 优先命中 Blob URL 缓存（避免重复下载）
    const blobCached = objectKey ? blobUrlCache.get(objectKey) : undefined;
    if (blobCached) {
      blobCached.lastUsedAt = Date.now();
      setUrl(blobCached.objectUrl);
      return;
    }

    // 2) 先拿签名 URL，再 fetch 成 blob，最后转成 ObjectURL 给 <img>
    setUrl(undefined);
    const run = async () => {
      if (file) {
        const signed = await fetchSignedUrlForOssObject(file);
        if (!signed) throw new Error("获取签名URL失败");
        return fetchAsBlobUrl(asset, signed, asset.mime);
      }

      if (!cipherFile) throw new Error("缺少可读取的对象键");
      if (!asset.zoneId) throw new Error("密文资源缺少 zoneId");
      if (!zoneKeyB64) throw new Error(`缺少 Zone「${asset.zoneId}」的解密密钥`);
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
        zoneKeyB64,
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

        blobUrlCache.set(objectKey, {
          objectUrl,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
        });
        evictBlobCacheIfNeeded();
        setUrl(objectUrl);
        if (meta) onResolvedMetadata?.(asset.assetId, meta);
      })
      .catch((e) => {
        if (cancelled) return;
        // 不打断 UI，保底用 fallback（若存在）
        // eslint-disable-next-line no-console
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
  const navigate = useNavigate();
  const keySession = useSessionAuthStore((s) => s.keySession);
  const [routeReady, setRouteReady] = useState(false);
  const [guestNickname, setGuestNickname] = useState("");
  const [mode, setMode] = useState<AlbumViewMode>("time");
  const [manifest, setManifest] = useState<AlbumManifest | null>(null);
  const [resolvedMetaById, setResolvedMetaById] = useState<Record<string, AssetResolvedMetadata>>({});
  const [error, setError] = useState<string | null>(null);

  const displayName = useMemo(() => {
    if (keySession?.username) return keySession.username;
    const g = guestNickname.trim();
    return g ? `访客 · ${g}` : null;
  }, [keySession?.username, guestNickname]);

  useLayoutEffect(() => {
    if (hasAlbumRouteAccess()) {
      setRouteReady(true);
      return;
    }
    navigate({ pathname: "/", search: "?login=1" }, { replace: true });
  }, [navigate]);

  useEffect(() => {
    setGuestNickname(window.localStorage.getItem(STORAGE_GUEST_NICKNAME_KEY) ?? "");
  }, []);

  // lightbox
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [isInfoOpen, setIsInfoOpen] = useState(false);

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
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [BATCH_SIZE]);

  const timeSorted = useMemo(() => {
    const assets = manifest?.assets ?? [];
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
  }, [manifest, resolvedMetaById]);

  const handleResolvedMetadata = useMemo(
    () => (assetId: string, meta: AssetResolvedMetadata) => {
      setResolvedMetaById((prev) => {
        const cur = prev[assetId];
        const next: AssetResolvedMetadata = {
          takenAt: meta.takenAt || cur?.takenAt,
          world: {
            worldId: meta.world?.worldId ?? cur?.world?.worldId ?? null,
            worldName: meta.world?.worldName ?? cur?.world?.worldName ?? null,
          },
        };
        if (
          cur?.takenAt === next.takenAt &&
          cur?.world?.worldId === next.world?.worldId &&
          cur?.world?.worldName === next.world?.worldName
        ) {
          return prev;
        }
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

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 1600);
    return () => window.clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    // 切换图片或关闭 lightbox 时，默认关闭“更多信息”
    setIsInfoOpen(false);
  }, [activeIndex]);

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

  if (!routeReady) {
    return (
      <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 text-sm text-white/70">
        正在校验访问…
      </div>
    );
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
            {displayName ? (
              <div className="truncate text-[11px] font-bold text-white/55">{displayName}</div>
            ) : null}
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
            <div className="mt-4 rounded-2xl border border-red-400/30 bg-red-950/30 p-4 text-sm text-red-100">
              {error}
              <div className="mt-2 text-xs text-red-200/80">
                清单默认与图片相同经函数计算换取临时 URL（对象键默认{" "}
                <code className="rounded bg-black/30 px-1 py-0.5">albums/manifest.json</code>
                ，可用 <code className="rounded bg-black/30 px-1 py-0.5">VITE_ALBUM_MANIFEST_FILE</code>
                覆盖）。若需改为直链，请设置有效的完整 HTTPS{" "}
                <code className="rounded bg-black/30 px-1 py-0.5">VITE_ALBUM_MANIFEST_URL</code>
                （勿填单独一个 <code className="rounded bg-black/30 px-1 py-0.5">/</code>
                ）；仅在不走签名服务时才使用该变量。
              </div>
            </div>
          ) : null}

          {!manifest && !error ? (
            <div className="mt-10 text-center text-sm font-bold text-white/70">正在加载相册…</div>
          ) : null}

          {manifest ? (
            <>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-white/70">
                <div>
                  共 <span className="font-extrabold text-white/90">{manifest.assets.length}</span> 张
                </div>
              </div>

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
                  <button
                    type="button"
                    className="text-left hover:text-white"
                    title="点击复制"
                    onClick={() => void copyText(active.assetId, "assetId")}
                  >
                    <span className="text-white/60">assetId：</span>
                    <span className="font-extrabold">{active.assetId}</span>
                  </button>
                  {active.file ? (
                    <button
                      type="button"
                      className="text-left hover:text-white"
                      title="点击复制"
                      onClick={() => void copyText(active.file ?? "", "file")}
                    >
                      <span className="text-white/60">file：</span>
                      <span className="font-extrabold">{active.file}</span>
                    </button>
                  ) : null}
                  {active.cipherFile ? (
                    <button
                      type="button"
                      className="text-left hover:text-white"
                      title="点击复制"
                      onClick={() => void copyText(active.cipherFile ?? "", "cipherFile")}
                    >
                      <span className="text-white/60">cipherFile：</span>
                      <span className="font-extrabold">{active.cipherFile}</span>
                    </button>
                  ) : null}
                  {active.zoneId ? (
                    <button
                      type="button"
                      className="text-left hover:text-white"
                      title="点击复制"
                      onClick={() => void copyText(active.zoneId ?? "", "zoneId")}
                    >
                      <span className="text-white/60">zoneId：</span>
                      <span className="font-extrabold">{active.zoneId}</span>
                    </button>
                  ) : null}
                  {active.file ? (
                    <button
                      type="button"
                      className="text-left hover:text-white"
                      title="点击获取并复制（短期有效）"
                      onClick={() => {
                        const file = active.file?.trim();
                        if (!file) return setToast("无 file 可获取链接");
                        void fetchSignedUrlForOssObject(file)
                          .then((url) => {
                            if (!url) return setToast("获取链接失败");
                            return copyText(url, "临时链接");
                          })
                          .catch(() => setToast("获取链接失败"));
                      }}
                    >
                      <span className="text-white/60">临时链接：</span>
                      <span className="font-extrabold">点击复制</span>
                    </button>
                  ) : null}
                  {active.src ? (
                    <button
                      type="button"
                      className="text-left hover:text-white"
                      title="点击复制"
                      onClick={() => void copyText(active.src ?? "", "src")}
                    >
                      <span className="text-white/60">src：</span>
                      <span className="font-extrabold">{active.src}</span>
                    </button>
                  ) : null}
                  <div>
                    <span className="text-white/60">尺寸：</span>
                    <span className="font-extrabold">
                      {active.width && active.height ? `${active.width}×${active.height}` : "未知"}
                    </span>
                  </div>
                  {active.mime ? (
                    <div>
                      <span className="text-white/60">mime：</span>
                      <span className="font-extrabold">{active.mime}</span>
                    </div>
                  ) : null}
                  <button
                    type="button"
                    className="text-left hover:text-white"
                    title="点击复制"
                    onClick={() => void copyText(active.takenAt ?? "", "takenAt")}
                  >
                    <span className="text-white/60">takenAt：</span>
                    <span className="font-extrabold">{active.takenAt ?? "未知"}</span>
                  </button>
                </div>
              </div>
            ) : null}

            <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/30">
              <ActiveImage asset={active} onResolvedMetadata={handleResolvedMetadata} />
            </div>
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
}: {
  asset: AlbumAsset;
  onResolvedMetadata?: (assetId: string, meta: AssetResolvedMetadata) => void;
}) {
  const [retry, setRetry] = useState(0);
  const url = useAssetImageUrl(asset, retry, onResolvedMetadata);
  const objectKey = asset.file?.trim() || asset.cipherFile?.trim() || "";
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

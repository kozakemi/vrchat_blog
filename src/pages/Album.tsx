import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { AlertCircle } from "lucide-react";

type AlbumViewMode = "time" | "world";

type SignedUrlResponse = {
  signedUrl?: string;
  expire_in?: number;
};

type SignedUrlCacheEntry = {
  url: string;
  expiresAt: number;
};

const SIGN_ENDPOINT =
  import.meta.env.VITE_OSS_SIGN_ENDPOINT ??
  "https://vrchat-oss-wdmpygkprb.cn-beijing.fcapp.run";

const signedUrlCache = new Map<string, SignedUrlCacheEntry>();

type AlbumAsset = {
  assetId: string;
  // OSS 对象路径（用于签名换取临时可访问 URL）
  // 例如：VRChat/2026-01/VRChat_....png
  file?: string;
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

function normalizeSignedUrl(value: string) {
  // 兼容后端/调用方把 URL 包在反引号里：`http://...`
  let s = value.trim();
  if (
    (s.startsWith("`") && s.endsWith("`")) ||
    (s.startsWith("\"") && s.endsWith("\"")) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  // 处理仅一侧带反引号的情况
  s = s.replace(/^`/, "").replace(/`$/, "");

  // 尽量统一到 https（GitHub Pages 为 https，http 资源容易被浏览器拦截）
  if (s.startsWith("http://vrchat-png.oss-cn-beijing.aliyuncs.com/")) {
    s = s.replace("http://", "https://");
  }
  return s;
}

async function fetchSignedUrl(file: string) {
  const endpoint = SIGN_ENDPOINT?.trim();
  if (!endpoint) return null;

  const cached = signedUrlCache.get(file);
  if (cached && cached.expiresAt - Date.now() > 30_000) return cached.url;

  const url = `${endpoint.replace(/\/+$/, "")}?file=${encodeURIComponent(file)}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`获取签名 URL 失败：HTTP ${res.status}`);
  const data = (await res.json()) as SignedUrlResponse;
  const signedUrlRaw = data.signedUrl;
  if (!signedUrlRaw) throw new Error("签名接口返回缺少 signedUrl 字段");

  const signedUrl = normalizeSignedUrl(String(signedUrlRaw));
  // 防御：如果签名服务把路径斜杠编码成 %2F 或 %252F，OSS 会按字面量 key 查找导致 404。
  // 这种情况前端无法修复（改路径会导致签名不匹配），需要修复签名服务。
  const pathPart = signedUrl.split("?", 1)[0] ?? signedUrl;
  if (/%252F|%2F/i.test(pathPart)) {
    throw new Error("签名URL路径包含%2F（斜杠被编码），请修复签名服务生成逻辑");
  }
  const expireIn = Number.isFinite(Number(data.expire_in)) ? Number(data.expire_in) : 300;
  const expiresAt = Date.now() + Math.max(1, expireIn) * 1000;

  signedUrlCache.set(file, { url: signedUrl, expiresAt });
  return signedUrl;
}

function useAssetImageUrl(asset: AlbumAsset, refreshToken = 0) {
  const file = asset.file?.trim();
  const fallback = asset.src ?? undefined;
  const [url, setUrl] = useState<string | undefined>(() => fallback);

  useEffect(() => {
    let cancelled = false;
    if (!file) {
      setUrl(fallback);
      return;
    }

    const cached = signedUrlCache.get(file);
    if (cached && cached.expiresAt - Date.now() > 30_000) {
      setUrl(cached.url);
      return;
    }

    setUrl(undefined);
    void fetchSignedUrl(file)
      .then((u) => {
        if (cancelled) return;
        setUrl(u ?? fallback);
      })
      .catch((e) => {
        if (cancelled) return;
        // 不打断 UI，保底用 fallback（若存在）
        // eslint-disable-next-line no-console
        console.warn("[album] fetchSignedUrl failed:", e);
        setUrl(fallback);
      });

    return () => {
      cancelled = true;
    };
  }, [file, fallback, refreshToken]);

  return url;
}

export default function Album() {
  const [mode, setMode] = useState<AlbumViewMode>("time");
  const [manifest, setManifest] = useState<AlbumManifest | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    fetch("./albums/manifest.json")
      .then((r) => {
        if (!r.ok) throw new Error(`加载 manifest 失败：HTTP ${r.status}`);
        return r.json() as Promise<AlbumManifest>;
      })
      .then((data) => {
        if (cancelled) return;
        setManifest(data);
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
      .map((a) => ({ ...a, _takenAtTs: toTs(a.takenAt) }))
      .sort((a, b) => b._takenAtTs - a._takenAtTs);
  }, [manifest]);

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

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-black/20">
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/30 via-black/10 to-black/40" />

      <header className="relative z-10 flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-3">
          <Link
            to="/"
            className="rounded-xl border border-white/20 bg-black/20 px-3 py-2 text-sm font-extrabold text-white/90 backdrop-blur hover:bg-black/30"
          >
            返回
          </Link>
          <div className="text-sm font-extrabold tracking-wide text-white/90">
            相册
          </div>
        </div>

        <div className="flex items-center gap-2 rounded-2xl border border-white/15 bg-black/15 p-1 backdrop-blur">
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
                请确认存在 <code className="rounded bg-black/30 px-1 py-0.5">public/albums/manifest.json</code>
                （开发环境当前通过 <code className="rounded bg-black/30 px-1 py-0.5">/VRChat/...</code> 引用图片）。
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
                        <TimeCardImage asset={a} />
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
                                <TimeCardImage asset={a} />
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
                  {active.file ? (
                    <button
                      type="button"
                      className="text-left hover:text-white"
                      title="点击获取并复制（短期有效）"
                      onClick={() => {
                        const file = active.file?.trim();
                        if (!file) return setToast("无 file 可获取链接");
                        void fetchSignedUrl(file)
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
              <ActiveImage asset={active} />
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

function TimeCardImage({ asset }: { asset: AlbumAsset }) {
  const [retry, setRetry] = useState(0);
  const url = useAssetImageUrl(asset, retry);
  // 保持现有视觉：未拿到 url 时显示背景，不额外加新 UI
  return url ? (
    <img
      src={url}
      alt={asset.assetId}
      loading="lazy"
      className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
      onError={() => {
        const file = asset.file?.trim();
        if (!file) return;
        if (retry >= 1) return;
        signedUrlCache.delete(file);
        setRetry(1);
      }}
    />
  ) : null;
}

function ActiveImage({ asset }: { asset: AlbumAsset }) {
  const [retry, setRetry] = useState(0);
  const url = useAssetImageUrl(asset, retry);
  return url ? (
    <img
      src={url}
      alt={asset.assetId}
      className="max-h-[80vh] w-full object-contain"
      onError={() => {
        const file = asset.file?.trim();
        if (!file) return;
        if (retry >= 1) return;
        signedUrlCache.delete(file);
        setRetry(1);
      }}
    />
  ) : null;
}

import { rewriteOssUrlForDevFetch } from "@/lib/ossDevProxy";
import { fetchSignedUrlForOssObject, getOssSignEndpoint } from "@/lib/ossSignFetch";
import { getAlbumManifestUrl, getOptionalDirectManifestUrl } from "@/lib/manifestUrl";

/** 与 AlbumAdmin 上传清单时使用的默认对象键一致（见 getManifestObjectKey）；可用 VITE_ALBUM_MANIFEST_FILE 覆盖 */
export const DEFAULT_MANIFEST_OBJECT_KEY = "albums/manifest.json";

export function getManifestObjectKey(): string {
  const raw = import.meta.env.VITE_ALBUM_MANIFEST_FILE?.trim();
  return raw || DEFAULT_MANIFEST_OBJECT_KEY;
}

/**
 * 合并上传写入的根结构；兼容部分导出为「纯数组」或嵌套在 data 下的写法。
 */
export type AlbumManifestPayload = {
  schemaVersion: number;
  generatedAt?: string;
  assets: unknown[];
  /**
   * 顶层其它字段的原样保留（`assetsBasePath`，或将来由外部工具写入的任何键）。
   *
   * 为什么必须留着：合并写回是「读整份 → 改 assets → 写回整份」，
   * 若归一化只挑出 schemaVersion/generatedAt/assets，那么每次上传都会
   * 静默削掉其余顶层字段（曾经真实削掉过 `assetsBasePath`）。
   */
  extra: Record<string, unknown>;
};

const KNOWN_TOP_LEVEL_KEYS = new Set(["schemaVersion", "generatedAt", "assets"]);

function collectExtraTopLevel(o: Record<string, unknown>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(k)) extra[k] = v;
  }
  return extra;
}

function toSchemaVersion(sv: unknown): number {
  const n = typeof sv === "number" ? sv : Number(sv);
  return Number.isFinite(n) ? n : 1;
}

export function normalizeAlbumManifestPayload(raw: unknown): AlbumManifestPayload {
  if (raw === null || raw === undefined) {
    throw new Error("清单响应为空");
  }
  if (Array.isArray(raw)) {
    return { schemaVersion: 1, assets: raw, extra: {} };
  }
  if (typeof raw !== "object") {
    throw new Error("清单 JSON 根节点须为对象或数组");
  }
  const o = raw as Record<string, unknown>;
  if (Array.isArray(o.assets)) {
    return {
      schemaVersion: toSchemaVersion(o.schemaVersion),
      generatedAt: typeof o.generatedAt === "string" ? o.generatedAt : undefined,
      assets: o.assets,
      extra: collectExtraTopLevel(o),
    };
  }
  const inner = o.data;
  if (inner && typeof inner === "object") {
    const d = inner as Record<string, unknown>;
    if (Array.isArray(d.assets)) {
      return {
        schemaVersion: toSchemaVersion(d.schemaVersion),
        generatedAt: typeof d.generatedAt === "string" ? d.generatedAt : undefined,
        assets: d.assets,
        // 嵌套在 data 下时，外层的额外字段同样保留（两者合并，内层优先）
        extra: { ...collectExtraTopLevel(o), ...collectExtraTopLevel(d) },
      };
    }
  }
  throw new Error(
    "清单缺少 assets 数组。请确认 OSS 上对象为相册合并后的 JSON（含 assets），对象键与 VITE_ALBUM_MANIFEST_FILE / 上传路径一致。",
  );
}

export type MergedManifestResult = {
  /** 可直接 JSON.stringify 写回 OSS 的完整顶层对象 */
  doc: Record<string, unknown>;
  /** 合并前已有条目数 */
  previousCount: number;
  /** 合并后总条目数 */
  mergedCount: number;
};

/**
 * 把新条目按 assetId 合并进现有清单 —— **纯函数**，因此可以被测试直接调用。
 *
 * 之前这段逻辑内联在 AlbumAdmin 组件里，无法在不渲染 React 的前提下执行，
 * 于是「清单合并」这一最危险的操作长期没有任何自动化覆盖。
 *
 * @param existing 现有清单读取结果；`missing` 表示对象不存在（首次上传），按空清单处理
 * @param newAssets 本次新增条目（调用方须保证其密文已成功写入 OSS）
 * @param generatedAt 写回时间戳（由调用方注入，保证可测）
 */
export function buildMergedManifest(
  existing: ExistingManifestForMerge,
  newAssets: Record<string, unknown>[],
  generatedAt: string,
): MergedManifestResult {
  const payload = existing.status === "ok" ? existing.payload : null;
  const extra = payload ? payload.extra : {};

  const byId = new Map<string, unknown>();
  for (const a of payload?.assets ?? []) {
    const id = (a as { assetId?: unknown } | null)?.assetId;
    if (typeof id === "string") byId.set(id, a);
  }
  const previousCount = byId.size;
  for (const a of newAssets) {
    const id = (a as { assetId?: unknown }).assetId;
    if (typeof id === "string") byId.set(id, a);
  }

  const assetsBasePath =
    typeof extra.assetsBasePath === "string" ? (extra.assetsBasePath as string) : "/albums/";

  const doc: Record<string, unknown> = {
    ...extra,
    schemaVersion: payload?.schemaVersion ?? 1,
    generatedAt,
    assetsBasePath,
    assets: [...byId.values()],
  };

  return { doc, previousCount, mergedCount: byId.size };
}

export type ManifestRemovalResult = {
  /** 可直接 JSON.stringify 写回 OSS 的完整顶层对象 */
  doc: Record<string, unknown>;
  /** 实际移除了多少条（assetId 已不在清单里时为 0） */
  removedCount: number;
  /** 移除后剩余条目数 */
  remainingCount: number;
};

/**
 * 从清单里移除指定 assetId —— 纯函数，与 buildMergedManifest 一样可被测试直接调用。
 *
 * 行为约定：
 * - 顶层额外字段（assetsBasePath 等）原样保留；
 * - **assetId 缺失或非字符串的条目一律保留**——宁可不删，也不要因为字段异常误删数据；
 * - 找不到目标 id 时返回 removedCount = 0，由调用方决定是否继续删对象（"彻底删除"应保持幂等）。
 */
export function buildManifestWithoutAssets(
  existing: ExistingManifestForMerge,
  assetIdsToRemove: Iterable<string>,
  generatedAt: string,
): ManifestRemovalResult {
  const payload = existing.status === "ok" ? existing.payload : null;
  const extra = payload ? payload.extra : {};
  const drop = new Set(assetIdsToRemove);
  const all = payload?.assets ?? [];

  const kept = all.filter((a) => {
    const id = (a as { assetId?: unknown } | null)?.assetId;
    if (typeof id !== "string") return true;
    return !drop.has(id);
  });

  const assetsBasePath =
    typeof extra.assetsBasePath === "string" ? (extra.assetsBasePath as string) : "/albums/";

  const doc: Record<string, unknown> = {
    ...extra,
    schemaVersion: payload?.schemaVersion ?? 1,
    generatedAt,
    assetsBasePath,
    assets: kept,
  };

  return { doc, removedCount: all.length - kept.length, remainingCount: kept.length };
}

function parseManifestJsonText(text: string, requestLabel: string): unknown {
  const lead = text.trimStart().slice(0, 120).toLowerCase();
  if (lead.startsWith("<!doctype") || lead.startsWith("<html") || lead.startsWith("<!")) {
    throw new Error(
      `清单地址返回了网页（HTML）而不是 JSON。请求：${requestLabel}。若已配置签名服务，请确认 OSS 上存在对象键 ${getManifestObjectKey()}，且函数计算已允许为该路径签名。`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`解析 manifest 失败：${msg}。请求：${requestLabel}`);
  }
}

type ManifestFetchOutcome =
  | { status: "ok"; text: string; label: string }
  | { status: "http-error"; httpStatus: number; label: string };

/**
 * 按优先级解析清单地址并取回文本。
 * 只区分「HTTP 成功」与「HTTP 失败」，不抛 HTTP 异常——由调用方决定失败语义。
 */
async function loadManifestText(): Promise<ManifestFetchOutcome> {
  const directFirst = getOptionalDirectManifestUrl();
  if (directFirst) {
    const url = rewriteOssUrlForDevFetch(directFirst);
    const r = await fetch(url, {
      cache: "no-store",
      referrerPolicy: "strict-origin-when-cross-origin",
    });
    if (!r.ok) return { status: "http-error", httpStatus: r.status, label: directFirst };
    return { status: "ok", text: await r.text(), label: directFirst };
  }

  const signEp = getOssSignEndpoint();
  const manifestKey = getManifestObjectKey();

  if (signEp) {
    const signed = await fetchSignedUrlForOssObject(manifestKey);
    if (!signed) {
      throw new Error("无法获取清单临时 URL：签名服务未配置或返回为空");
    }
    const url = rewriteOssUrlForDevFetch(signed);
    const r = await fetch(url, {
      cache: "no-store",
      referrerPolicy: "strict-origin-when-cross-origin",
    });
    if (!r.ok) return { status: "http-error", httpStatus: r.status, label: manifestKey };
    return { status: "ok", text: await r.text(), label: manifestKey };
  }

  const logicalUrl = getAlbumManifestUrl();
  const url = rewriteOssUrlForDevFetch(logicalUrl);
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) return { status: "http-error", httpStatus: r.status, label: logicalUrl };
  return { status: "ok", text: await r.text(), label: logicalUrl };
}

/**
 * 优先与图片相同：经函数计算换取 manifest 临时 URL，再 fetch JSON。
 * 未配置签名服务时回退为直接 URL（本地 public 或 VITE_ALBUM_MANIFEST_URL / 同源路径）。
 */
export async function fetchAlbumManifestOrThrow(): Promise<unknown> {
  const out = await loadManifestText();
  if (out.status === "http-error") {
    // 空桶尚无清单；访客按空相册展示，首次上传会创建真实清单。
    if (out.httpStatus === 404) {
      return normalizeAlbumManifestPayload({ schemaVersion: 1, assets: [] });
    }
    throw new Error(`加载 manifest 失败：HTTP ${out.httpStatus}。请求：${out.label}`);
  }
  return normalizeAlbumManifestPayload(parseManifestJsonText(out.text, out.label));
}

export type ExistingManifestForMerge =
  | { status: "ok"; payload: AlbumManifestPayload }
  | { status: "missing" };

/**
 * 管理端「写清单之前」读取现有清单——语义比 fetchAlbumManifestOrThrow 更严格：
 *
 * - 仅当对象确实不存在（HTTP 404，例如首次上传）才返回 `missing`，此时按空清单合并是正确的；
 * - 其余任何失败（网络、签名、返回 HTML、缺 assets 字段）一律抛出。
 *
 * 绝不退化成 null 让调用方当成空清单：那会用「只含本次新增」的清单覆盖线上已有条目，
 * 造成静默的全量数据丢失。
 */
export async function fetchExistingManifestForMerge(): Promise<ExistingManifestForMerge> {
  const out = await loadManifestText();
  if (out.status === "http-error") {
    if (out.httpStatus === 404) return { status: "missing" };
    throw new Error(
      `读取现有清单失败：HTTP ${out.httpStatus}。请求：${out.label}。已中止写入，以免覆盖线上清单。`,
    );
  }

  try {
    return {
      status: "ok",
      payload: normalizeAlbumManifestPayload(parseManifestJsonText(out.text, out.label)),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`现有清单无法解析，已中止写入以免覆盖：${msg}`);
  }
}

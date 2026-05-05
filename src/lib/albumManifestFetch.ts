import { rewriteOssUrlForDevFetch } from "@/lib/ossDevProxy";
import { fetchSignedUrlForOssObject, getOssSignEndpoint } from "@/lib/ossSignFetch";
import { getAlbumManifestUrl, getOptionalDirectManifestUrl } from "@/lib/manifestUrl";

/** 与 AlbumAdmin 上传的 MANIFEST_KEY 默认一致；可通过 VITE_ALBUM_MANIFEST_FILE 覆盖 */
export const DEFAULT_MANIFEST_OBJECT_KEY = "albums/manifest.json";

export function getManifestObjectKey(): string {
  const raw = import.meta.env.VITE_ALBUM_MANIFEST_FILE?.trim();
  return raw || DEFAULT_MANIFEST_OBJECT_KEY;
}

/** 合并上传写入的根结构；兼容部分导出为「纯数组」或嵌套在 data 下的写法 */
export type AlbumManifestPayload = {
  schemaVersion: number;
  generatedAt?: string;
  assets: unknown[];
};

export function normalizeAlbumManifestPayload(raw: unknown): AlbumManifestPayload {
  if (raw === null || raw === undefined) {
    throw new Error("清单响应为空");
  }
  if (Array.isArray(raw)) {
    return { schemaVersion: 1, assets: raw };
  }
  if (typeof raw !== "object") {
    throw new Error("清单 JSON 根节点须为对象或数组");
  }
  const o = raw as Record<string, unknown>;
  if (Array.isArray(o.assets)) {
    const sv = o.schemaVersion;
    const schemaVersion =
      typeof sv === "number" ? sv : Number.isFinite(Number(sv)) ? Number(sv) : 1;
    return {
      schemaVersion: Number.isFinite(schemaVersion) ? schemaVersion : 1,
      generatedAt: typeof o.generatedAt === "string" ? o.generatedAt : undefined,
      assets: o.assets,
    };
  }
  const inner = o.data;
  if (inner && typeof inner === "object") {
    const d = inner as Record<string, unknown>;
    if (Array.isArray(d.assets)) {
      const sv = d.schemaVersion;
      const schemaVersion =
        typeof sv === "number" ? sv : Number.isFinite(Number(sv)) ? Number(sv) : 1;
      return {
        schemaVersion: Number.isFinite(schemaVersion) ? schemaVersion : 1,
        generatedAt: typeof d.generatedAt === "string" ? d.generatedAt : undefined,
        assets: d.assets,
      };
    }
  }
  throw new Error(
    "清单缺少 assets 数组。请确认 OSS 上对象为相册合并后的 JSON（含 assets），对象键与 VITE_ALBUM_MANIFEST_FILE / 上传路径一致。",
  );
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

/**
 * 优先与图片相同：经函数计算换取 manifest 临时 URL，再 fetch JSON。
 * 未配置签名服务时回退为直接 URL（本地 public 或 VITE_ALBUM_MANIFEST_URL / 同源路径）。
 */
export async function fetchAlbumManifestOrThrow(): Promise<unknown> {
  const directFirst = getOptionalDirectManifestUrl();
  if (directFirst) {
    const url = rewriteOssUrlForDevFetch(directFirst);
    const r = await fetch(url, {
      cache: "no-store",
      referrerPolicy: "strict-origin-when-cross-origin",
    });
    if (!r.ok) throw new Error(`加载 manifest 失败：HTTP ${r.status}。请求：${directFirst}`);
    const text = await r.text();
    return normalizeAlbumManifestPayload(parseManifestJsonText(text, directFirst));
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
    if (!r.ok) {
      throw new Error(`加载 manifest 失败：HTTP ${r.status}（对象键：${manifestKey}）`);
    }
    const text = await r.text();
    return normalizeAlbumManifestPayload(parseManifestJsonText(text, manifestKey));
  }

  const logicalUrl = getAlbumManifestUrl();
  const url = rewriteOssUrlForDevFetch(logicalUrl);
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`加载 manifest 失败：HTTP ${r.status}。请求：${logicalUrl}`);
  const text = await r.text();
  return normalizeAlbumManifestPayload(parseManifestJsonText(text, logicalUrl));
}

/** 管理端合并清单：失败则视为空清单 */
export async function tryFetchAlbumManifest(): Promise<unknown | null> {
  try {
    return await fetchAlbumManifestOrThrow();
  } catch {
    return null;
  }
}

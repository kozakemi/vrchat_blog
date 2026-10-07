import { resolveSignedUrlToAbsolute } from "@/lib/ossSignedUrl";

type SignedUrlResponse = {
  signedUrl?: string;
  expire_in?: number;
};

const DEFAULT_SIGN_ENDPOINT = "https://vrchat-oss-wdmpygkprb.cn-beijing.fcapp.run";

/**
 * 用来**显式关闭**签名服务的取值。
 *
 * 为什么需要它：函数计算签名服务是**可选的部署件**。本地预览、或纯静态托管
 * （只放 dist/、不部署 FC）时，没有它也应该能把页面跑起来。把
 * `VITE_OSS_SIGN_ENDPOINT` 设为 off / none / - / 0 / false 即可关闭，
 * 此时清单改走同源直链（见 manifestUrl.ts 的 getAlbumManifestUrl），
 * 不再有任何跨域请求。
 *
 * 为什么不用空字符串表示关闭：`.env` 里写 `VITE_X=` 与"压根没写"在
 * import.meta.env 里都是空串，而"没写"的语义必须是"用默认的函数计算地址"，
 * 两者得能区分开，所以要一个明确的哨兵值。
 */
const SIGN_ENDPOINT_DISABLED = new Set(["off", "none", "-", "0", "false"]);

/**
 * 解析 `VITE_OSS_SIGN_ENDPOINT` 的取值，返回真正要用的地址。
 *
 * 返回 `""` 表示**明确关闭**；输入为空/未设置时返回默认的函数计算地址。
 * 抽成纯函数是为了能被直接测试——这行 if 判错会把线上的签名服务一起关掉，
 * 或者让本地预览仍然去请求阿里云，两种都很难在界面上看出来。
 */
export function resolveSignEndpointFrom(value: string | undefined): string {
  const raw = value?.trim();
  if (!raw) return DEFAULT_SIGN_ENDPOINT;
  if (SIGN_ENDPOINT_DISABLED.has(raw.toLowerCase())) return "";
  return raw;
}

/** 某个取值是否表示"关闭签名服务"（没写不算关闭，因为"没写"的语义是"用默认地址"） */
export function isSignEndpointDisabled(value: string | undefined): boolean {
  const raw = value?.trim();
  if (!raw) return false;
  return SIGN_ENDPOINT_DISABLED.has(raw.toLowerCase());
}

const SIGN_ENDPOINT = resolveSignEndpointFrom(import.meta.env.VITE_OSS_SIGN_ENDPOINT);

const signedUrlCache = new Map<string, { url: string; expiresAt: number }>();

/** 与相册页、清单共用：阿里云函数计算签名服务根 URL */
export function getOssSignEndpoint(): string | null {
  const s = SIGN_ENDPOINT?.trim();
  return s || null;
}

/**
 * 通过签名服务换取 OSS 对象临时 GET URL（与相册图片一致：`?file=<对象键>`）。
 */
export async function fetchSignedUrlForOssObject(objectKey: string): Promise<string | null> {
  const endpoint = SIGN_ENDPOINT?.trim();
  if (!endpoint) return null;

  const file = objectKey.trim();
  if (!file) return null;

  const cached = signedUrlCache.get(file);
  if (cached && cached.expiresAt - Date.now() > 30_000) return cached.url;

  const url = `${endpoint.replace(/\/+$/, "")}?file=${encodeURIComponent(file)}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`获取签名 URL 失败：HTTP ${res.status}`);
  const data = (await res.json()) as SignedUrlResponse;
  const signedUrlRaw = data.signedUrl;
  if (!signedUrlRaw) throw new Error("签名接口返回缺少 signedUrl 字段");

  const signedUrl = resolveSignedUrlToAbsolute(String(signedUrlRaw));
  const pathPart = signedUrl.split("?", 1)[0] ?? signedUrl;
  if (/%252F|%2F/i.test(pathPart)) {
    throw new Error("签名URL路径包含%2F（斜杠被编码），请修复签名服务生成逻辑");
  }
  const expireIn = Number.isFinite(Number(data.expire_in)) ? Number(data.expire_in) : 300;
  const expiresAt = Date.now() + Math.max(1, expireIn) * 1000;

  signedUrlCache.set(file, { url: signedUrl, expiresAt });
  return signedUrl;
}

/** 图片 onError 重试时清除该对象的签名缓存，强制重新向 FC 要 URL */
export function invalidateSignedUrlCacheForObjectKey(objectKey: string): void {
  signedUrlCache.delete(objectKey.trim());
}

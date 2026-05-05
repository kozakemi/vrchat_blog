import { resolveSignedUrlToAbsolute } from "@/lib/ossSignedUrl";

type SignedUrlResponse = {
  signedUrl?: string;
  expire_in?: number;
};

const DEFAULT_SIGN_ENDPOINT = "https://vrchat-oss-wdmpygkprb.cn-beijing.fcapp.run";

const SIGN_ENDPOINT =
  import.meta.env.VITE_OSS_SIGN_ENDPOINT?.trim() || DEFAULT_SIGN_ENDPOINT;

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

import { rewriteOssUrlForDevFetch } from "@/lib/ossDevProxy";
import { getPutPresignedUrlWithConfig } from "@/lib/ossClientPresign";
import type { OssUploadConfig } from "@/lib/ossTypes";
import { normalizeSignedUrl } from "@/lib/ossSignedUrl";

type PutSignResponse = {
  signedUrl?: string;
};

const SIGN_ENDPOINT =
  import.meta.env.VITE_OSS_SIGN_ENDPOINT ?? "https://vrchat-oss-wdmpygkprb.cn-beijing.fcapp.run";

/**
 * 向签名服务申请 PUT 预签名 URL（需在 FC 等后端实现 `?put=1&key=<对象键>`）。
 * key 为 OSS 对象键，例如 `manifest.json` 或 `albums/assets/a_xxx.bin`
 */
export async function fetchPutSignedUrl(objectKey: string): Promise<string | null> {
  const endpoint = SIGN_ENDPOINT?.trim();
  if (!endpoint) return null;
  const url = `${endpoint.replace(/\/+$/, "")}?put=1&key=${encodeURIComponent(objectKey)}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
  const data = (await res.json()) as PutSignResponse;
  const raw = data.signedUrl?.trim();
  if (!raw) return null;
  return normalizeSignedUrl(String(raw));
}

/**
 * 生成 PUT 预签名 URL。
 * - 已填写网页 OSS JSON 时：仅用浏览器内签名（便于排查错误，不再静默退回 FC）。
 * - 未填写 JSON 时：退回签名服务 `?put=1&key=`。
 *
 * @param contentType 必须与随后 PUT 请求的 Content-Type 完全一致（含 application/json）
 */
export async function resolvePutSignedUrl(
  objectKey: string,
  clientConfig: OssUploadConfig | null,
  contentType = "application/octet-stream",
): Promise<string> {
  if (clientConfig) {
    return await getPutPresignedUrlWithConfig(objectKey, clientConfig, contentType);
  }
  const u = await fetchPutSignedUrl(objectKey);
  if (!u) {
    throw new Error(
      "未配置 OSS 网页 JSON，且签名服务未返回 PUT 地址（请部署 VITE_OSS_SIGN_ENDPOINT 的 put=1 接口）",
    );
  }
  return u;
}

export async function putObjectWithSignedUrl(
  putUrl: string,
  body: Blob | ArrayBuffer | Uint8Array,
  contentType: string,
): Promise<void> {
  const fetchUrl = rewriteOssUrlForDevFetch(putUrl);
  const res = await fetch(fetchUrl, {
    method: "PUT",
    body,
    headers: { "Content-Type": contentType },
    mode: "cors",
    referrerPolicy: "strict-origin-when-cross-origin",
  });
  if (!res.ok) {
    const hint =
      res.status === 403
        ? "（403：多为签名与 Content-Type 不一致，或桶策略/CORS；控制台核对跨域 PUT）"
        : "";
    throw new Error(`上传失败：HTTP ${res.status} ${res.statusText}${hint}`);
  }
}

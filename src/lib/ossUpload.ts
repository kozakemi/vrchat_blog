import { rewriteOssUrlForDevFetch } from "@/lib/ossDevProxy";
import { getPutPresignedUrlWithConfig } from "@/lib/ossClientPresign";
import type { OssUploadConfig } from "@/lib/ossTypes";
import { ossBucketPublicOrigin, resolveSignedUrlToAbsolute } from "@/lib/ossSignedUrl";

/**
 * 生成 PUT 预签名 URL。
 *
 * 目前**只支持**浏览器内用 OSS 配置（上方 JSON）签名。
 * 曾经存在的「退回签名服务 `?put=1&key=`」路径已移除，原因（2026-10 实测线上 FC）：
 *   - `?put=1&key=<k>` 返回 `400 {"error":"缺少 file 参数"}`；
 *   - `?put=1&file=<k>` / `?file=<k>&method=PUT` 返回的签名与纯 GET 签名逐字节相同。
 * OSS 签名包含 HTTP 方法，GET 签名无法授权 PUT，继续退回只会得到难以定位的 403。
 * 因此未配置 OSS JSON 时直接给出可操作的报错，而不是静默走一条死路。
 *
 * @param contentType 必须与随后 PUT 请求的 Content-Type 完全一致（含 application/json）
 */
export async function resolvePutSignedUrl(
  objectKey: string,
  clientConfig: OssUploadConfig | null,
  contentType = "application/octet-stream",
): Promise<string> {
  if (!clientConfig) {
    throw new Error(
      `未配置 OSS 上传凭据，无法为「${objectKey}」生成 PUT 预签名：` +
        "请在管理页「OSS 上传配置」中填写 AccessKey JSON 并保存（签名服务只提供 GET 签名，不能替代）",
    );
  }
  const origin = ossBucketPublicOrigin(clientConfig.oss_bucket_name, clientConfig.oss_endpoint);
  const url = await getPutPresignedUrlWithConfig(objectKey, clientConfig, contentType);
  return resolveSignedUrlToAbsolute(url, origin);
}

export async function putObjectWithSignedUrl(
  putUrl: string,
  body: Blob | ArrayBuffer | Uint8Array,
  contentType: string,
): Promise<void> {
  const fetchUrl = rewriteOssUrlForDevFetch(resolveSignedUrlToAbsolute(putUrl));
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

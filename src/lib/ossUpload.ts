import { rewriteOssUrlForDevFetch } from "@/lib/ossDevProxy";
import { getDeletePresignedUrlWithConfig, getPutPresignedUrlWithConfig } from "@/lib/ossClientPresign";
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
  let res: Response;
  try {
    res = await fetch(fetchUrl, {
      method: "PUT",
      body,
      headers: { "Content-Type": contentType },
      mode: "cors",
      referrerPolicy: "strict-origin-when-cross-origin",
    });
  } catch {
    // 跨域预检被拒时浏览器只抛网络错误，无法读取 OSS 的 XML 错误正文。
    throw new Error(
      "上传请求未收到可读响应：请检查网络，以及 OSS 桶的 CORS 是否允许当前站点的 PUT 方法和 Content-Type 请求头。" +
        "仅允许 GET 会导致相册能读取但无法上传。",
    );
  }
  if (!res.ok) {
    const hint =
      res.status === 403
        ? "（403：多为签名与 Content-Type 不一致，或桶策略/CORS；控制台核对跨域 PUT）"
        : "";
    throw new Error(`上传失败：HTTP ${res.status} ${res.statusText}${hint}`);
  }
}

/**
 * 生成 DELETE 预签名 URL（与 PUT 同理：只能靠浏览器内的 OSS 配置签名）。
 *
 * OSS 的签名串包含 HTTP 方法，因此删除必须有独立的 DELETE 签名，
 * 拿 PUT/GET 的签名去删只会得到 403。
 */
export async function resolveDeleteSignedUrl(
  objectKey: string,
  clientConfig: OssUploadConfig | null,
  expiresSec = 900,
): Promise<string> {
  if (!clientConfig) {
    throw new Error(
      `未配置 OSS 凭据，无法为「${objectKey}」生成删除签名：` +
        "请在管理页「OSS 上传配置」中填写 AccessKey JSON 并保存（签名服务只提供 GET 签名，不能替代）",
    );
  }
  const origin = ossBucketPublicOrigin(clientConfig.oss_bucket_name, clientConfig.oss_endpoint);
  const url = await getDeletePresignedUrlWithConfig(objectKey, clientConfig, expiresSec);
  return resolveSignedUrlToAbsolute(url, origin);
}

/**
 * 用 DELETE 预签名删除 OSS 对象。
 *
 * - 404 视为成功（对象本就不在，"彻底删除"应当幂等）；
 * - 预检被拒时浏览器只抛网络错误，读不到 OSS 的 XML 正文，因此这里给出明确的 CORS 指引。
 */
export async function deleteObjectWithSignedUrl(
  deleteUrl: string,
): Promise<{ alreadyGone: boolean }> {
  const fetchUrl = rewriteOssUrlForDevFetch(resolveSignedUrlToAbsolute(deleteUrl));
  let res: Response;
  try {
    res = await fetch(fetchUrl, {
      method: "DELETE",
      mode: "cors",
      referrerPolicy: "strict-origin-when-cross-origin",
    });
  } catch {
    throw new Error(
      "删除请求未收到可读响应：请检查网络，以及 OSS 桶的 CORS 是否允许当前站点的 DELETE 方法。" +
        "只放行 GET/PUT 时会出现「能上传、能浏览，但删不掉」。可用 node tools/oss-upload-cors.mjs --apply 补齐。",
    );
  }
  if (res.status === 404) return { alreadyGone: true };
  if (!res.ok) {
    const hint =
      res.status === 403
        ? "（403：多为桶 CORS 未放行 DELETE，或签名方法与请求方法不一致）"
        : "";
    throw new Error(`删除失败：HTTP ${res.status} ${res.statusText}${hint}`);
  }
  return { alreadyGone: false };
}

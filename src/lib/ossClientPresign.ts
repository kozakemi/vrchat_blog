import type { OssUploadConfig } from "./ossTypes";

function endpointToRegion(endpoint: string): string {
  const host = endpoint.replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
  const regional = host.match(/^(oss-[a-z0-9-]+)\.aliyuncs\.com$/);
  if (regional) return regional[1];
  const vhost = host.match(/^[a-z0-9-]+\.(oss-[a-z0-9-]+)\.aliyuncs\.com$/);
  if (vhost) return vhost[1];
  if (host.startsWith("oss-")) return host.split(".")[0] ?? "oss-cn-beijing";
  return "oss-cn-beijing";
}

/** ali-oss 的实例类型较绕，这里只声明我们实际用到的能力 */
type PresignClient = {
  signatureUrl(
    objectKey: string,
    options: Record<string, unknown>,
  ): string | { toString(): string };
};

/**
 * 客户端按凭据缓存。
 *
 * 批量上传时每个文件都要签一次名，若每次都新建客户端（动态 import + 解析
 * endpoint + 构造实例），上千张图会把这些工作白白重复上千遍。
 * 缓存键包含密钥本身，避免换凭据后误用旧客户端。
 */
const clientCache = new Map<string, PresignClient>();

async function getOssClient(config: OssUploadConfig): Promise<PresignClient> {
  const cacheKey = [
    config.oss_endpoint,
    config.oss_bucket_name,
    config.oss_access_key_id,
    config.oss_access_key_secret,
  ].join("|");
  const cached = clientCache.get(cacheKey);
  if (cached) return cached;

  let mod: typeof import("ali-oss");
  try {
    mod = await import("ali-oss");
  } catch (e) {
    throw new Error(
      `加载 ali-oss SDK 失败：${e instanceof Error ? e.message : String(e)}。请检查网络及构建分包是否正常加载。`,
    );
  }

  let client: PresignClient;
  try {
    const OSS = mod.default;
    client = new OSS({
      region: endpointToRegion(config.oss_endpoint),
      accessKeyId: config.oss_access_key_id,
      accessKeySecret: config.oss_access_key_secret,
      bucket: config.oss_bucket_name,
      secure: true,
    }) as unknown as PresignClient;
  } catch (e) {
    throw new Error(`初始化 OSS 客户端失败：${e instanceof Error ? e.message : String(e)}`);
  }

  clientCache.set(cacheKey, client);
  return client;
}

function toStringUrl(url: string | { toString(): string }): string {
  return typeof url === "string" ? url : String(url);
}

/**
 * 在浏览器内用 AccessKey 生成 PUT 预签名 URL。
 *
 * 注意：实际上传 PUT 时的 `Content-Type` 必须与签名时完全一致，否则 OSS 返回 403（浏览器常显示为 Load failed）。
 */
export async function getPutPresignedUrlWithConfig(
  objectKey: string,
  config: OssUploadConfig,
  contentType: string,
  expiresSec = 900,
): Promise<string> {
  const client = await getOssClient(config);
  return toStringUrl(
    client.signatureUrl(objectKey, {
      method: "PUT",
      expires: expiresSec,
      /** 必须与 putObjectWithSignedUrl 里传入的 Content-Type 一致 */
      "Content-Type": contentType,
    }),
  );
}

/**
 * 生成 DELETE 预签名 URL。
 *
 * OSS 签名串包含 HTTP 方法，所以删除必须单独签名——不能用 PUT/GET 的签名去发 DELETE。
 * 注意：浏览器发出 DELETE 前会走 CORS 预检，桶的跨域规则必须显式放行 DELETE
 * （可用 `node tools/oss-upload-cors.mjs --apply` 补齐）。
 */
export async function getDeletePresignedUrlWithConfig(
  objectKey: string,
  config: OssUploadConfig,
  expiresSec = 900,
): Promise<string> {
  const client = await getOssClient(config);
  return toStringUrl(client.signatureUrl(objectKey, { method: "DELETE", expires: expiresSec }));
}

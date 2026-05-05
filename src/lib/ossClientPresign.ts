import type { OssUploadConfig } from "./ossTypes";

function endpointToRegion(endpoint: string): string {
  const host = endpoint.replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
  const m = host.match(/^(oss-[a-z0-9-]+)\.aliyuncs\.com$/);
  if (m) return m[1];
  if (host.startsWith("oss-")) return host.split(".")[0] ?? "oss-cn-beijing";
  return "oss-cn-beijing";
}

/**
 * 在浏览器内用 AccessKey 生成 PUT 预签名 URL（AccessKey 会进内存；生产环境更推荐 RAM + STS/服务端签名）
 *
 * 注意：实际上传 PUT 时的 `Content-Type` 必须与签名时完全一致，否则 OSS 返回 403（浏览器常显示为 Load failed）。
 */
export async function getPutPresignedUrlWithConfig(
  objectKey: string,
  config: OssUploadConfig,
  contentType: string,
  expiresSec = 900,
): Promise<string> {
  let mod: typeof import("ali-oss");
  try {
    mod = await import("ali-oss");
  } catch (e) {
    throw new Error(
      `加载 ali-oss SDK 失败：${e instanceof Error ? e.message : String(e)}。请检查网络及构建分包是否正常加载。`,
    );
  }
  const OSS = mod.default;
  let client: InstanceType<typeof OSS>;
  try {
    client = new OSS({
      region: endpointToRegion(config.oss_endpoint),
      accessKeyId: config.oss_access_key_id,
      accessKeySecret: config.oss_access_key_secret,
      bucket: config.oss_bucket_name,
      secure: true,
    });
  } catch (e) {
    throw new Error(`初始化 OSS 客户端失败：${e instanceof Error ? e.message : String(e)}`);
  }

  const url = client.signatureUrl(objectKey, {
    method: "PUT",
    expires: expiresSec,
    /** 必须与 putObjectWithSignedUrl 里传入的 Content-Type 一致 */
    "Content-Type": contentType,
  });
  return typeof url === "string" ? url : String(url);
}

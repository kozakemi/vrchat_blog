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
    // 跨域预检被拒时浏览器只抛网络错误（Firefox 报 "NetworkError when attempting
    // to fetch resource."），读不到 OSS 的 XML 错误正文，所以这里把几种常见原因都列出来。
    throw new Error(
      "上传请求未收到可读响应（浏览器只报网络错误）。常见原因：" +
        "① 桶的 CORS 未允许当前站点的 PUT 与 Content-Type；" +
        "② 桶或账号的数据访问被停用（如欠费），此时连 CORS 预检都会返回 403，" +
        "可运行 node tools/oss-upload-cors.mjs 看预检状态；" +
        "③ 本地网络或代理拦截了 oss.aliyuncs.com。",
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
 * - OSS 的 DeleteObject 是幂等的：**删除不存在的对象同样返回 204**（实测确认），
 *   所以一般情况下无法区分"删掉了"和"本来就没有"。`alreadyGone` 只在服务端
 *   确实回了 404 时才为 true（例如经过了某些代理/网关），调用方不应依赖它做判断。
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

/** 上传前探测使用的固定对象键：0 字节，用完立即删除 */
const PREFLIGHT_OBJECT_KEY = "albums/assets/__preflight__.bin";

export type UploadProbeResult = {
  ok: boolean;
  /** 探测消息（失败时给出可操作的原因） */
  message: string;
  /** 探针对象是否已清理干净 */
  cleanedUp: boolean;
};

/**
 * 上传前探测：用**真实的 0 字节 PUT** 走一遍完整链路（预检 → 写入 → 删除）。
 *
 * 为什么需要它：浏览器在 CORS 预检被拒时只会抛一个"网络错误"，既读不到 OSS 的
 * 错误码（例如账号欠费导致数据访问停用时的 `UserDisable` 403），也无法区分
 * "CORS 没配好"、"账号被停用"、"网络不可达"。先单独探一次，就能在开始批量上传前
 * 给出明确结论——否则选了 500 张图，只会得到 500 条一模一样的报错。
 *
 * 探测会真的写入一个 0 字节对象，随后立刻删除；不会碰清单，也不影响相册。
 */
export async function probeUploadAccess(
  clientConfig: OssUploadConfig | null,
): Promise<UploadProbeResult> {
  if (!clientConfig) {
    return { ok: false, message: "尚未配置 OSS 上传凭据", cleanedUp: true };
  }

  try {
    const putUrl = await resolvePutSignedUrl(
      PREFLIGHT_OBJECT_KEY,
      clientConfig,
      "application/octet-stream",
    );
    await putObjectWithSignedUrl(putUrl, new Uint8Array(0), "application/octet-stream");
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      cleanedUp: true,
      message:
        `上传通道不可用：${raw} ` +
        "如果是网络层错误（Firefox 常显示 NetworkError），请先运行 " +
        "node tools/oss-upload-cors.mjs 查看预检状态——预检返回 403 时也常见于" +
        "桶/账号的数据访问被停用（例如欠费），需到阿里云控制台确认费用与账号状态。",
    };
  }

  // 能写进去就说明通道可用；顺手清掉探针，删不掉也不算致命。
  let cleanedUp = false;
  try {
    const deleteUrl = await resolveDeleteSignedUrl(PREFLIGHT_OBJECT_KEY, clientConfig);
    await deleteObjectWithSignedUrl(deleteUrl);
    cleanedUp = true;
  } catch {
    cleanedUp = false;
  }

  return {
    ok: true,
    cleanedUp,
    message: cleanedUp
      ? "上传通道正常"
      : `上传通道可用，但探针对象 ${PREFLIGHT_OBJECT_KEY} 删除失败（可稍后手动清理，不影响使用）`,
  };
}

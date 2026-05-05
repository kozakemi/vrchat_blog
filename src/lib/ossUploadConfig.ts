import type { OssUploadConfig } from "./ossTypes";

export type { OssUploadConfig } from "./ossTypes";

/** 本次浏览器会话中保存的 OSS 上传配置（JSON 原文） */
export const SESSION_OSS_UPLOAD_JSON_KEY = "td_oss_upload_json_v1";

const DEFAULT_TEMPLATE = `{
  "OSS_ACCESS_KEY_ID": "",
  "OSS_ACCESS_KEY_SECRET": "",
  "OSS_ENDPOINT": "oss-cn-beijing.aliyuncs.com",
  "OSS_BUCKET_NAME": "vrchat-png"
}`;

export function getDefaultOssJsonTemplate(): string {
  return DEFAULT_TEMPLATE;
}

function str(o: Record<string, unknown>, ...candidates: string[]): string | undefined {
  for (const k of candidates) {
    const v = o[k] ?? o[k.toLowerCase()] ?? o[k.toUpperCase()];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function fromObject(raw: Record<string, unknown>): { ok: true; config: OssUploadConfig } | { ok: false; error: string } {
  const oss_access_key_id = str(raw, "OSS_ACCESS_KEY_ID", "oss_access_key_id", "accessKeyId", "AccessKeyId");
  const oss_access_key_secret = str(
    raw,
    "OSS_ACCESS_KEY_SECRET",
    "oss_access_key_secret",
    "accessKeySecret",
    "AccessKeySecret",
  );
  const oss_endpoint = str(
    raw,
    "OSS_ENDPOINT",
    "oss_endpoint",
    "endpoint",
    "region",
  );
  const oss_bucket_name = str(raw, "OSS_BUCKET_NAME", "oss_bucket_name", "bucket", "Bucket", "bucketName");
  if (!oss_access_key_id) return { ok: false, error: "缺少 AccessKeyId（OSS_ACCESS_KEY_ID）" };
  if (!oss_access_key_secret) return { ok: false, error: "缺少 AccessKeySecret（OSS_ACCESS_KEY_SECRET）" };
  if (!oss_endpoint) return { ok: false, error: "缺少 Endpoint（OSS_ENDPOINT）" };
  if (!oss_bucket_name) return { ok: false, error: "缺少 Bucket 名（OSS_BUCKET_NAME）" };
  return {
    ok: true,
    config: {
      oss_access_key_id,
      oss_access_key_secret,
      oss_endpoint: oss_endpoint.replace(/^https?:\/\//i, ""),
      oss_bucket_name,
    },
  };
}

/** 支持 `KEY = 'value'` 或 `KEY = "value"` 的简写（整段粘贴） */
function parseLooseKeyValueBlock(text: string): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  const re = /(OSS_ACCESS_KEY_ID|OSS_ACCESS_KEY_SECRET|OSS_ENDPOINT|OSS_BUCKET_NAME)\s*=\s*['"]([^'"]*)['"]/gi;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text)) !== null) {
    out[m[1]] = m[2];
    n++;
  }
  return n > 0 ? out : null;
}

/**
 * 解析用户粘贴的 JSON 或类 Python 配置块
 */
export function parseOssUploadJson(
  text: string,
): { ok: true; config: OssUploadConfig } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "内容为空" };
  try {
    const raw = JSON.parse(trimmed) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return fromObject(raw as Record<string, unknown>);
    }
  } catch {
    const loose = parseLooseKeyValueBlock(trimmed);
    if (loose) return fromObject(loose);
    return { ok: false, error: "不是合法 JSON，请检查引号/逗号" };
  }
  return { ok: false, error: "根节点须为 JSON 对象" };
}

export function loadOssConfigFromSession(): OssUploadConfig | null {
  try {
    const t = sessionStorage.getItem(SESSION_OSS_UPLOAD_JSON_KEY);
    if (!t) return null;
    const p = parseOssUploadJson(t);
    return p.ok ? p.config : null;
  } catch {
    return null;
  }
}

export function saveOssConfigToSession(jsonText: string): { ok: true; config: OssUploadConfig } | { ok: false; error: string } {
  const p = parseOssUploadJson(jsonText);
  if (!p.ok) return p;
  sessionStorage.setItem(SESSION_OSS_UPLOAD_JSON_KEY, jsonText.trim());
  return p;
}

export function clearOssConfigSession(): void {
  sessionStorage.removeItem(SESSION_OSS_UPLOAD_JSON_KEY);
}

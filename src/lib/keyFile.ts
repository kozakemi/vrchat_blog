export type KeyFileZoneV1 = {
  zoneId: string;
  keyB64: string;
  comment?: string;
};

export type KeyFileV1 = {
  schemaVersion: number;
  username: string;
  zones: KeyFileZoneV1[];
  createdAt?: string;
  roles?: string[];
};

const ZONE_ID_RE = /^[a-zA-Z0-9._-]{1,64}$/;

export function isAdminKeyFile(data: KeyFileV1): boolean {
  return Array.isArray(data.roles) && data.roles.includes("admin");
}

export function validateKeyFile(data: KeyFileV1): string | null {
  if (data.schemaVersion !== 1) return "仅支持 schemaVersion: 1";
  if (typeof data.username !== "string" || !data.username.trim()) return "缺少 username";
  if (!Array.isArray(data.zones)) return "zones 须为数组";
  const seen = new Set<string>();
  for (const z of data.zones) {
    if (typeof z.zoneId !== "string" || !ZONE_ID_RE.test(z.zoneId)) {
      return `无效的 zoneId：${String(z.zoneId)}`;
    }
    if (seen.has(z.zoneId)) return `重复的 zoneId：${z.zoneId}`;
    seen.add(z.zoneId);
    if (typeof z.keyB64 !== "string" || !z.keyB64.trim()) return `Zone「${z.zoneId}」缺少 keyB64`;
    const raw = base64ToBytes(z.keyB64);
    if (raw.length !== 32) return `Zone「${z.zoneId}」的 keyB64 解码后须为 32 字节`;
  }
  if (data.roles !== undefined && !Array.isArray(data.roles)) return "roles 须为字符串数组";
  return null;
}

export function parseKeyFileJson(text: string): KeyFileV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("密钥文件不是合法 JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("密钥文件格式无效");
  const o = parsed as Record<string, unknown>;
  if (o.schemaVersion !== 1) throw new Error("仅支持 schemaVersion: 1");
  return parsed as KeyFileV1;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function keyFileToDownloadJson(data: KeyFileV1): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

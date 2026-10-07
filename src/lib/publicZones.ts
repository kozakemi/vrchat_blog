import rawConfig from "@/config/public-zones.json";
import type { KeyFileZoneV1 } from "@/lib/keyFile";

/**
 * 「公开区」配置：注册时自动发放给访客的 Zone。
 *
 * ⚠️ 安全前提：本配置会**打包进前端产物**，所以这里的 keyB64 对任何人都是公开的
 * （无需注册，直接读 JS 就能拿走）。因此它只能承载“本来就要公开”的内容。
 * 私密照片请放进不在此列表里的 Zone，用管理员密钥文件分发。
 */

const ZONE_ID_RE = /^[a-zA-Z0-9._-]{1,64}$/;

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function parsePublicZones(): KeyFileZoneV1[] {
  const raw = rawConfig as { zones?: unknown };
  if (!Array.isArray(raw.zones)) {
    throw new Error("public-zones.json 缺少 zones 数组");
  }
  const seen = new Set<string>();
  return raw.zones.map((entry, index) => {
    const z = entry as Partial<KeyFileZoneV1>;
    const where = `public-zones.json zones[${index}]`;
    if (typeof z.zoneId !== "string" || !ZONE_ID_RE.test(z.zoneId)) {
      throw new Error(`${where} 的 zoneId 无效（仅允许字母数字与 . _ -，长度 1-64）`);
    }
    if (seen.has(z.zoneId)) throw new Error(`${where} 的 zoneId 重复：${z.zoneId}`);
    seen.add(z.zoneId);
    if (typeof z.keyB64 !== "string" || !z.keyB64.trim()) {
      throw new Error(`${where}（${z.zoneId}）缺少 keyB64`);
    }
    if (base64ToBytes(z.keyB64).length !== 32) {
      throw new Error(`${where}（${z.zoneId}）的 keyB64 解码后须为 32 字节`);
    }
    return {
      zoneId: z.zoneId,
      keyB64: z.keyB64,
      ...(typeof z.comment === "string" && z.comment.trim() ? { comment: z.comment.trim() } : {}),
    };
  });
}

/** 已校验的公开 Zone 列表；配置写错时会在应用启动阶段直接抛错，而不是静默发放坏密钥 */
export const PUBLIC_ZONES: KeyFileZoneV1[] = parsePublicZones();

/** 注册时是否真的能发放出可用的密钥（配置为空则不能） */
export function canSelfRegister(): boolean {
  return PUBLIC_ZONES.length > 0;
}

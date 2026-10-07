import type { KeyFileZoneV1 } from "@/lib/keyFile";

export type AccessCheckAsset = {
  assetId: string;
  zoneId?: string | null;
  cipherFile?: string | null;
};

/**
 * 判定结果。
 * 刻意用扁平结构而不是可辨识联合：`strict` 关闭时对 `!decision.allowed` 的收窄
 * 在调用处并不可靠，扁平字段读起来也更直接。
 */
export type AccessDecision = {
  allowed: boolean;
  /** allowed 为 true 时可用；无 Zone 的明文资源为 null */
  zoneKeyB64: string | null;
  /** allowed 为 false 时的原因（用于控制台排查；界面不展示） */
  reason: string;
};

/**
 * 单个资源能否被当前会话查看 —— **唯一权威判定**。
 *
 * 规则（刻意从严，宁可少显示也不要漏权）：
 * 1. 密文资源必须声明 zoneId，否则无从判断归属，直接拒绝；
 * 2. **只要资源声明了 zoneId，就必须持有对应 Zone 的密钥**——
 *    这一条同样约束明文资源。否则「把私密照片放进 Zone」形同虚设：
 *    明文对象只要知道对象键，任何人都能通过签名服务取到。
 * 3. 未声明 zoneId 的明文资源（早期清单格式）放行。
 */
export function checkAssetAccess(
  asset: AccessCheckAsset,
  zones: KeyFileZoneV1[] | undefined,
): AccessDecision {
  const zoneId = asset.zoneId?.trim() ?? "";
  const cipherFile = asset.cipherFile?.trim() ?? "";

  if (!zoneId) {
    if (cipherFile) return { allowed: false, zoneKeyB64: null, reason: "密文资源缺少 zoneId" };
    return { allowed: true, zoneKeyB64: null, reason: "" };
  }

  const key = zones?.find((z) => z.zoneId === zoneId)?.keyB64;
  if (!key) {
    return { allowed: false, zoneKeyB64: null, reason: `当前身份没有 Zone「${zoneId}」的密钥` };
  }
  return { allowed: true, zoneKeyB64: key, reason: "" };
}

/**
 * 过滤出当前会话真正有权查看的资源。
 *
 * 相册列表必须用它，而不是直接把清单里的 assets 全渲染出来：
 * 否则无权资源的**文件名、拍摄时间、世界名**照样会出现在页面上
 * （图片解不开，但元数据已经泄露了）。
 */
export function filterAccessibleAssets<T extends AccessCheckAsset>(
  assets: T[],
  zones: KeyFileZoneV1[] | undefined,
): T[] {
  return assets.filter((a) => checkAssetAccess(a, zones).allowed);
}

import {
  ALBUM_ASSETS_PREFIX,
  base64ToBytes,
  buildAadJson,
  encryptPlaintextToParts,
  importAesGcmKey,
} from "@/lib/albumCrypto";
import type { KeyFileZoneV1 } from "@/lib/keyFile";
import { keyFingerprintB64 } from "@/lib/keyFingerprint";
import {
  buildManifestWithReplacedAsset,
  fetchExistingManifestForMerge,
  getManifestObjectKey,
} from "@/lib/albumManifestFetch";
import { rewriteOssUrlForDevFetch } from "@/lib/ossDevProxy";
import { fetchSignedUrlForOssObject } from "@/lib/ossSignFetch";
import type { OssUploadConfig } from "@/lib/ossTypes";
import {
  deleteObjectWithSignedUrl,
  putObjectWithSignedUrl,
  resolveDeleteSignedUrl,
  resolvePutSignedUrl,
} from "@/lib/ossUpload";

/**
 * 改变一张照片的归属 Zone。
 *
 * ============================================================================
 * 为什么这不是"改个字段"那么简单
 * ============================================================================
 * 密文是用**旧 Zone 的密钥**做的 AES-256-GCM，而 AAD 里又绑死了 `zoneId`
 * （见 albumCrypto.buildAadJson）。这两个约束决定了：
 *
 *   - 只把清单里的 zoneId 改掉 → 新 Zone 的密钥解不开（GCM 认证必然失败）；
 *   - 只把密文重新加密、不动 AAD → 同样解不开。
 *
 * 所以"改 Zone"在密码学上等价于**换一把钥匙重新锁一遍**，必须走完整流程：
 *   下载密文 → 用旧密钥解密 → 用新密钥重新加密（AAD 换成新 zoneId）
 *   → 上传为新对象 → 改写清单指向它 → 删除旧密文。
 *
 * ============================================================================
 * 顺序与安全（每一步都为了"最坏情况可以恢复"）
 * ============================================================================
 * 1. **新密文写到新的对象键**，绝不就地覆盖。就地覆盖时若随后的清单写入失败，
 *    旧密钥的密文已被销毁、清单却仍指向旧 Zone —— 这张照片就**永久不可读**了。
 * 2. **先传新对象，再改清单**，最后才删旧对象。任何一步失败，清单都还指向一个
 *    真实存在、且能解开的对象；最坏的结果只是留下一个不可见的孤儿对象。
 * 3. 清单写入后**回读校验**：zoneId / cipherFile 都必须真的变了，且不能残留 `file` 直链
 *    （读取路径里 `file` 优先级高于 `cipherFile`，残留会导致页面继续去读旧明文对象）。
 * 4. 旧对象删除失败**不抛错**，而是返回 warning —— 但这条 warning 是安全告警而不是
 *    卫生问题：旧密文仍然可以用旧 Zone 的密钥解开。把照片从"人多"的 Zone 收窄到
 *    "人少"的 Zone 时，不删掉旧对象等于白收窄。
 */

export type ZoneChangeAsset = {
  assetId: string;
  zoneId?: string | null;
  mime?: string | null;
  cipherFile?: string | null;
  file?: string | null;
  nonceB64?: string | null;
  aad?: { v?: number; zoneId?: string; assetId?: string; mime?: string } | null;
  originalName?: string | null;
  relPath?: string | null;
};

export type ZoneChangeReport = {
  assetId: string;
  /** 迁移前的归属 Zone；null 表示原先未声明 */
  fromZoneId: string | null;
  toZoneId: string;
  /** 原先是不是**未加密的明文对象**（这次迁移顺便把它加密了） */
  fromPlaintext: boolean;
  newObjectKey: string;
  newSize: number;
  /** 写进清单的新密钥指纹 */
  keyFp: string;
  /** 已清理掉的旧对象键 */
  removedObjectKeys: string[];
  /** ⚠️ 仍留在桶里的旧对象键（删除失败）：它们仍能用旧 Zone 的密钥解开 */
  orphanObjectKeys: string[];
  /** 迁移后清单总条目数 */
  totalCount: number;
  warning?: string;
};

function requireZone(zones: KeyFileZoneV1[], zoneId: string, purpose: string): KeyFileZoneV1 {
  const zone = zones.find((z) => z.zoneId === zoneId);
  if (!zone) {
    throw new Error(
      `当前密钥文件里没有 Zone「${zoneId}」的密钥，无法${purpose}。请换用包含该 Zone 的密钥文件后再试。`,
    );
  }
  return zone;
}

/**
 * 取回原图（明文对象直接就是原图；密文对象需要先解密）。
 * 解密失败会给出"多半是用错密钥/文件损坏"这种能直接行动的说明，而不是抛 WebCrypto 的原文。
 */
async function readPlainBytes(
  asset: ZoneChangeAsset,
  sourceObjectKey: string,
  isCipher: boolean,
  currentZoneId: string | null,
  mime: string,
  decryptKeyB64: string | null,
): Promise<Uint8Array> {
  const signed = await fetchSignedUrlForOssObject(sourceObjectKey);
  if (!signed) throw new Error("取不到对象临时链接（签名服务未配置或返回为空）");

  const res = await fetch(rewriteOssUrlForDevFetch(signed), {
    cache: "no-store",
    referrerPolicy: "strict-origin-when-cross-origin",
  });
  if (!res.ok) throw new Error(`读取原对象失败：HTTP ${res.status}`);
  const rawBytes = new Uint8Array(await res.arrayBuffer());

  if (!isCipher) return rawBytes;

  const nonce = asset.nonceB64?.trim();
  if (!nonce) throw new Error("这条密文缺少 nonceB64，无法解密，因此不能迁移");
  if (!decryptKeyB64) throw new Error("内部错误：密文迁移缺少解密密钥");

  // AAD 以清单里记录的 aad 对象为准（它就是加密时的原样），缺失时按字段重建。
  const aadJson =
    asset.aad && typeof asset.aad === "object"
      ? JSON.stringify(asset.aad)
      : buildAadJson(currentZoneId ?? "", asset.assetId, mime);

  try {
    const key = await importAesGcmKey(decryptKeyB64, ["decrypt"]);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(nonce), additionalData: new TextEncoder().encode(aadJson) },
      key,
      rawBytes,
    );
    return new Uint8Array(plain);
  } catch {
    throw new Error(
      `解密失败（AES-GCM 认证不通过）。这通常意味着清单里记录的 Zone「${currentZoneId ?? "?"}」` +
        `与实际加密时用的密钥不是同一把，或者文件已损坏。请先在「更多」里核对两条密钥指纹，再决定是否迁移。`,
    );
  }
}

/**
 * 把 `asset` 迁移到 `targetZoneId`。
 *
 * @param zones 当前会话持有的 Zone（既要能解旧的，也要有新的）
 */
export async function changeAlbumAssetZone(
  config: OssUploadConfig,
  asset: ZoneChangeAsset,
  targetZoneId: string,
  zones: KeyFileZoneV1[],
): Promise<ZoneChangeReport> {
  const assetId = asset.assetId?.trim() ?? "";
  if (!assetId) throw new Error("这条照片缺少 assetId，无法迁移");

  const target = targetZoneId.trim();
  if (!target) throw new Error("请选择要迁移到的 Zone");

  const currentZoneId = asset.zoneId?.trim() || null;
  if (currentZoneId === target) {
    throw new Error(`这张照片已经属于 Zone「${target}」了，无需迁移`);
  }

  const targetZone = requireZone(zones, target, "用它重新加密");

  // `cipherFile` 优先：只有它是密文，才谈得上"用旧密钥解密"。
  const cipherKey = asset.cipherFile?.trim() ?? "";
  const plainKey = asset.file?.trim() ?? "";
  const isCipher = Boolean(cipherKey);
  const sourceObjectKey = cipherKey || plainKey;

  if (!sourceObjectKey) {
    throw new Error("这条既没有密文对象键、也没有 OSS 对象键（可能只存了本地路径），无法迁移");
  }

  let decryptKeyB64: string | null = null;
  if (isCipher) {
    if (!currentZoneId) {
      throw new Error("这条是密文但没有记录归属 Zone，无法确定用哪把密钥解密，不能迁移");
    }
    decryptKeyB64 = requireZone(zones, currentZoneId, `解密这张照片（它属于「${currentZoneId}」）`).keyB64;
  }

  const mime =
    (asset.mime || asset.aad?.mime || "application/octet-stream").trim() ||
    "application/octet-stream";

  // ---- 第一步：确认它在清单里。此时还没有产生任何副作用。----
  const before = await fetchExistingManifestForMerge();
  if (before.status !== "ok") {
    throw new Error("读取现有相册失败，已中止（不看清楚现状就不动手）");
  }
  const originalRow = before.payload.assets.find(
    (a) => (a as { assetId?: unknown } | null)?.assetId === assetId,
  ) as Record<string, unknown> | undefined;
  if (!originalRow) {
    throw new Error(`相册目录里找不到这条照片（${assetId}），已中止：不改清单、也不新建对象`);
  }

  // ---- 第二步：取回原图 ----
  const plainBytes = await readPlainBytes(
    asset,
    sourceObjectKey,
    isCipher,
    currentZoneId,
    mime,
    decryptKeyB64,
  );

  // ---- 第三步：用目标 Zone 的密钥重新加密 ----
  // 复制出独立的 ArrayBuffer：Uint8Array 可能是大 buffer 的视图，直接传 .buffer 会带上无关字节。
  const plainBuf = plainBytes.slice().buffer as ArrayBuffer;
  const { nonceB64, cipherBytes, aadJson } = await encryptPlaintextToParts(
    plainBuf,
    target,
    assetId,
    mime,
    targetZone.keyB64,
  );
  const keyFp = await keyFingerprintB64(targetZone.keyB64);

  // 新对象键带上目标密钥指纹，天然与旧键不同；万一撞上（例如两个 Zone 其实共用同一把密钥，
  // 指纹相同），再补一个随机后缀 —— 无论如何都**不能就地覆盖**。
  let newObjectKey = `${ALBUM_ASSETS_PREFIX}${assetId}.${keyFp}.bin`;
  if (newObjectKey === cipherKey || newObjectKey === plainKey) {
    newObjectKey = `${ALBUM_ASSETS_PREFIX}${assetId}.${keyFp}.${crypto.randomUUID().slice(0, 8)}.bin`;
  }

  const putUrl = await resolvePutSignedUrl(newObjectKey, config, "application/octet-stream");
  await putObjectWithSignedUrl(putUrl, cipherBytes, "application/octet-stream");

  // ---- 第四步：改写清单，原地替换这一条 ----
  const row: Record<string, unknown> = {
    // 展开原条目：takenAt / world / width / height 等字段与加密无关，必须原样留着。
    // （曾经因为"重建对象而不是合并字段"，把宽高和加密信息一起丢过。）
    ...originalRow,
    assetId,
    zoneId: target,
    mime,
    size: cipherBytes.byteLength,
    nonceB64,
    cipherFile: newObjectKey,
    aad: JSON.parse(aadJson) as Record<string, unknown>,
    keyFp,
  };
  // 读取路径里 `file` 的优先级高于 `cipherFile`（见 Album.useAssetImageUrl），
  // 残留会让页面继续去取那个即将被删掉的明文对象 —— 必须显式清掉。
  delete row.file;

  const fresh = await fetchExistingManifestForMerge();
  if (fresh.status !== "ok") {
    throw new Error(
      `新密文已上传（${newObjectKey}），但随后读不到相册目录，因此没有改写清单。` +
        "照片仍按旧密文正常显示，新对象暂时是多余的，可以稍后重试。",
    );
  }

  const { doc, replacedCount, totalCount } = buildManifestWithReplacedAsset(
    fresh,
    assetId,
    row,
    new Date().toISOString(),
  );
  if (replacedCount === 0) {
    throw new Error(
      `新密文已上传（${newObjectKey}），但相册目录里已经找不到这条照片了（可能被另一个标签页改动），` +
        "因此没有改写清单。请刷新相册确认现状。",
    );
  }

  const manifestKey = getManifestObjectKey();
  const manifestPutUrl = await resolvePutSignedUrl(manifestKey, config, "application/json");
  await putObjectWithSignedUrl(
    manifestPutUrl,
    new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }),
    "application/json",
  );

  // ---- 第五步：回读校验（写进去 ≠ 写对了）----
  const after = await fetchExistingManifestForMerge();
  if (after.status !== "ok") {
    throw new Error("相册目录保存后读不回来，请到 OSS 控制台确认后再操作");
  }
  const afterRow = after.payload.assets.find(
    (a) => (a as { assetId?: unknown } | null)?.assetId === assetId,
  ) as Record<string, unknown> | undefined;
  if (!afterRow) throw new Error("相册目录保存后这条照片不见了，迁移未生效");
  if (String(afterRow.zoneId ?? "") !== target) {
    throw new Error(
      `相册目录保存后归属 Zone 还是「${String(afterRow.zoneId ?? "未声明")}」，迁移未生效`,
    );
  }
  if (String(afterRow.cipherFile ?? "") !== newObjectKey) {
    throw new Error(`相册目录保存后密文指向的不是新对象（${newObjectKey}），迁移未生效`);
  }
  if (afterRow.file) {
    throw new Error("相册目录保存后仍残留 file 直链字段，会导致页面继续读取旧对象，迁移未生效");
  }

  // ---- 第六步：清理被替换掉的旧对象（尽力而为）----
  const staleKeys = [...new Set([cipherKey, plainKey].filter((k) => k && k !== newObjectKey))];

  const removedObjectKeys: string[] = [];
  const orphanObjectKeys: string[] = [];
  for (const key of staleKeys) {
    try {
      const deleteUrl = await resolveDeleteSignedUrl(key, config);
      const { alreadyGone } = await deleteObjectWithSignedUrl(deleteUrl);
      if (!alreadyGone) removedObjectKeys.push(key);
    } catch {
      orphanObjectKeys.push(key);
    }
  }

  const warning = orphanObjectKeys.length
    ? `照片已成功迁移到 Zone「${target}」，但旧文件没能删掉：${orphanObjectKeys.join("、")}。` +
      `⚠️ 旧文件仍然可以用「${currentZoneId ?? "原来的"}」的密钥解开——` +
      "如果这次是从较公开的 Zone 挪到较私密的 Zone，请务必到 OSS 控制台手动删除它，" +
      "否则持有旧密钥的人还能取到这张原图。"
    : undefined;

  return {
    assetId,
    fromZoneId: currentZoneId,
    toZoneId: target,
    fromPlaintext: !isCipher,
    newObjectKey,
    newSize: cipherBytes.byteLength,
    keyFp,
    removedObjectKeys,
    orphanObjectKeys,
    totalCount,
    ...(warning ? { warning } : {}),
  };
}

import {
  buildManifestWithoutAssets,
  fetchExistingManifestForMerge,
  getManifestObjectKey,
} from "@/lib/albumManifestFetch";
import type { OssUploadConfig } from "@/lib/ossTypes";
import {
  deleteObjectWithSignedUrl,
  putObjectWithSignedUrl,
  resolveDeleteSignedUrl,
  resolvePutSignedUrl,
} from "@/lib/ossUpload";

export type DeletableAlbumAsset = {
  assetId: string;
  zoneId?: string | null;
  file?: string | null;
  cipherFile?: string | null;
  originalName?: string | null;
};

export type DeleteAlbumAssetReport = {
  assetId: string;
  /** 清单是否真的被改写（目标本来就不在清单里时为 false） */
  manifestWritten: boolean;
  /** 删除后清单剩余条目数 */
  remainingCount: number;
  /** 被删除的 OSS 对象键；null 表示该条目没有 OSS 对象（只有本地 src） */
  objectKey: string | null;
  objectDeleted: boolean;
  objectAlreadyGone: boolean;
  /** 部分成功时的说明（例如清单已移除但密文没删掉） */
  warning?: string;
};

/**
 * 彻底删除一张照片：先从清单移除，再删 OSS 密文。
 *
 * **顺序不可颠倒**，这是本功能的安全核心：
 * - 先改清单成功、再删对象失败 → 最多留下一个**不可见的孤儿对象**（不占相册显示，只占存储）；
 * - 若反过来先删对象、而清单写入失败 → 清单里就会出现**指向不存在对象的悬空引用**，
 *   相册上表现为一张永远加载不出来的裂图，且无法自愈。
 *
 * 每一步都做回读校验；清单读取失败时**直接中止**，绝不在读不到现状的情况下改写它。
 */
export async function deleteAlbumAsset(
  config: OssUploadConfig,
  asset: DeletableAlbumAsset,
): Promise<DeleteAlbumAssetReport> {
  const objectKey = asset.cipherFile?.trim() || asset.file?.trim() || null;

  // ---- 第一步：改清单 ----
  const existing = await fetchExistingManifestForMerge();
  if (existing.status !== "ok") {
    throw new Error("读取现有相册失败，已中止删除（避免误改清单或误删对象）");
  }

  const { doc, removedCount, remainingCount } = buildManifestWithoutAssets(
    existing,
    [asset.assetId],
    new Date().toISOString(),
  );

  let manifestWritten = false;
  if (removedCount > 0) {
    const putUrl = await resolvePutSignedUrl(getManifestObjectKey(), config, "application/json");
    await putObjectWithSignedUrl(
      putUrl,
      new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }),
      "application/json",
    );
    manifestWritten = true;

    const after = await fetchExistingManifestForMerge();
    if (after.status !== "ok") {
      throw new Error("相册目录保存后读不回来，请到 OSS 控制台确认后再操作");
    }
    const ids = new Set(
      after.payload.assets
        .map((a) => (a as { assetId?: unknown }).assetId)
        .filter((v): v is string => typeof v === "string"),
    );
    if (ids.has(asset.assetId)) {
      throw new Error("相册目录保存后这张照片仍在列表中，删除未生效");
    }
    if (ids.size !== remainingCount) {
      throw new Error(`相册目录保存后条目数异常（期望 ${remainingCount}，实际 ${ids.size}）`);
    }
  }

  // ---- 第二步：删密文 ----
  if (!objectKey) {
    return {
      assetId: asset.assetId,
      manifestWritten,
      remainingCount,
      objectKey: null,
      objectDeleted: false,
      objectAlreadyGone: false,
      warning: "该条目只有本地 src 路径，没有可删除的 OSS 对象",
    };
  }

  try {
    const deleteUrl = await resolveDeleteSignedUrl(objectKey, config);
    const { alreadyGone } = await deleteObjectWithSignedUrl(deleteUrl);
    return {
      assetId: asset.assetId,
      manifestWritten,
      remainingCount,
      objectKey,
      objectDeleted: !alreadyGone,
      objectAlreadyGone: alreadyGone,
    };
  } catch (e) {
    // 清单已经改好，相册里不会出现裂图；只是留下一个不可见的孤儿对象。
    return {
      assetId: asset.assetId,
      manifestWritten,
      remainingCount,
      objectKey,
      objectDeleted: false,
      objectAlreadyGone: false,
      warning:
        `照片已从相册移除，但密文删除失败：${e instanceof Error ? e.message : String(e)}。` +
        "该文件已成为不可见的孤儿对象（不影响相册显示，但会继续占用存储）。",
    };
  }
}

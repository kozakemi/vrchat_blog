import { buildMergedManifest, fetchExistingManifestForMerge, getManifestObjectKey } from "./albumManifestFetch";
import { putObjectWithSignedUrl, resolvePutSignedUrl } from "./ossUpload";
import type { OssUploadConfig } from "./ossTypes";

/** 首次上传前初始化清单。只有明确的 404 才创建，读取失败时绝不覆盖。 */
export async function ensureAlbumStorageInitialized(config: OssUploadConfig): Promise<void> {
  const current = await fetchExistingManifestForMerge();
  if (current.status === "ok") return;

  const { doc } = buildMergedManifest(current, [], new Date().toISOString());
  const putUrl = await resolvePutSignedUrl(getManifestObjectKey(), config, "application/json");
  await putObjectWithSignedUrl(
    putUrl,
    new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }),
    "application/json",
  );
  const after = await fetchExistingManifestForMerge();
  if (after.status !== "ok") {
    throw new Error("相册清单初始化后仍不可读取，请检查 OSS 权限与清单路径");
  }
  // OSS 的文件夹是对象键前缀：写入 albums/manifest.json、albums/assets/<id>.bin
  // 即会自动形成所需目录，无需创建空目录标记或预先上传占位图片。
}

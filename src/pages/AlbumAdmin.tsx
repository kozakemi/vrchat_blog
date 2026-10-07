import { useEffect, useMemo, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import JSZip from "jszip";
import { encryptPlaintextToParts, generateZoneKeyB64, newAssetId } from "@/lib/albumCrypto";
import { keyFingerprintB64 } from "@/lib/keyFingerprint";
import { keyFileToDownloadJson, type KeyFileV1, type KeyFileZoneV1 } from "@/lib/keyFile";
import {
  buildMergedManifest,
  fetchExistingManifestForMerge,
  getManifestObjectKey,
} from "@/lib/albumManifestFetch";
import {
  clearOssConfigSession,
  getDefaultOssJsonTemplate,
  parseOssUploadJson,
  saveOssConfigToSession,
  SESSION_OSS_UPLOAD_JSON_KEY,
} from "@/lib/ossUploadConfig";
import { putObjectWithSignedUrl, resolvePutSignedUrl } from "@/lib/ossUpload";
import type { OssUploadConfig } from "@/lib/ossTypes";
import { ensureAlbumStorageInitialized } from "@/lib/albumStorage";
import { useSessionAuthStore } from "@/store/sessionAuthStore";

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

const FILE_FILTER = /\.(jpe?g|png|webp|gif|mp4|webm)$/i;
/** 密文对象前缀（清单对象键见 getManifestObjectKey()，可用 VITE_ALBUM_MANIFEST_FILE 覆盖） */
const ASSETS_PREFIX = "albums/assets/";

/** 单机 ZIP 分卷上限，避免 JSZip.generateAsync 一次性分配过大 ArrayBuffer */
const ZIP_BATCH_MAX_FILES = 18;
const ZIP_BATCH_MAX_BYTES = 380 * 1024 * 1024;

type AdminTab = "encrypt" | "zones";

type QueueItem = {
  key: string;
  file: File;
  relPath: string;
  zoneId: string;
};

function guessMime(file: File): string {
  if (file.type && file.type !== "application/octet-stream") return file.type;
  const lower = file.name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot >= 0) {
    const ext = lower.slice(dot);
    if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  }
  return "application/octet-stream";
}

function collectMediaFiles(fileList: FileList | null): File[] {
  if (!fileList?.length) return [];
  const out: File[] = [];
  for (let i = 0; i < fileList.length; i++) {
    const f = fileList[i];
    if (FILE_FILTER.test(f.name)) out.push(f);
  }
  return out;
}

function downloadBlob(filename: string, blob: Blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function chunkQueueForZip(items: QueueItem[], maxFiles: number, maxBytes: number): QueueItem[][] {
  if (!items.length) return [];
  const chunks: QueueItem[][] = [];
  let cur: QueueItem[] = [];
  let curBytes = 0;
  for (const it of items) {
    const sz = it.file.size || 0;
    const overFiles = cur.length >= maxFiles;
    const overBytes = cur.length > 0 && curBytes + sz > maxBytes;
    if (overFiles || overBytes) {
      chunks.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(it);
    curBytes += sz;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

async function encryptQueueItem(item: QueueItem, zone: KeyFileZoneV1) {
  const buf = await item.file.arrayBuffer();
  const mime = guessMime(item.file);
  const assetId = newAssetId();
  const { nonceB64, cipherBytes, aadJson } = await encryptPlaintextToParts(
    buf,
    item.zoneId,
    assetId,
    mime,
    zone.keyB64,
  );
  const cipherName = `${assetId}.bin`;
  const ossKey = `${ASSETS_PREFIX}${cipherName}`;
  const aadObj = JSON.parse(aadJson) as { v: number; zoneId: string; assetId: string; mime: string };
  const row = {
    assetId,
    zoneId: item.zoneId,
    originalName: item.file.name,
    relPath: item.relPath,
    mime,
    size: cipherBytes.byteLength,
    nonceB64,
    cipherFile: ossKey,
    aad: aadObj,
    /**
     * 加密时所用密钥的指纹。写进清单是为了事后能一眼比对
     * "上传时用的密钥" 与 "现在解密用的密钥" 是否同一把
     * （排查"是不是用错密钥上传了"这类问题）。
     */
    keyFp: await keyFingerprintB64(zone.keyB64),
  };
  return { row, cipherBytes, cipherName, ossKey };
}

export default function AlbumAdmin() {
  const keySession = useSessionAuthStore((s) => s.keySession);
  const setKeySession = useSessionAuthStore((s) => s.setKeySession);

  const [tab, setTab] = useState<AdminTab>("encrypt");

  const [newZoneId, setNewZoneId] = useState("");
  const [newZoneComment, setNewZoneComment] = useState("");

  const [defaultZoneId, setDefaultZoneId] = useState("");
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [lastMsg, setLastMsg] = useState<string | null>(null);

  const [ossJsonDraft, setOssJsonDraft] = useState(() => {
    try {
      return sessionStorage.getItem(SESSION_OSS_UPLOAD_JSON_KEY) ?? getDefaultOssJsonTemplate();
    } catch {
      return getDefaultOssJsonTemplate();
    }
  });
  const [ossUploadConfig, setOssUploadConfig] = useState<OssUploadConfig | null>(() => {
    try {
      const raw = sessionStorage.getItem(SESSION_OSS_UPLOAD_JSON_KEY);
      if (!raw) return null;
      const p = parseOssUploadJson(raw);
      return p.ok ? p.config : null;
    } catch {
      return null;
    }
  });

  const zoneOptions = useMemo(() => keySession?.zones ?? [], [keySession?.zones]);

  useEffect(() => {
    if (!defaultZoneId && zoneOptions.length) setDefaultZoneId(zoneOptions[0].zoneId);
  }, [defaultZoneId, zoneOptions]);

  // 与相册页同一套准入规则：没有密钥会话就回登录页，非管理员回相册页
  if (!keySession) {
    return <Navigate to="/" replace state={{ needKey: true }} />;
  }
  if (!keySession.isAdmin) {
    return <Navigate to="/album" replace />;
  }

  function appendQueue(files: File[]) {
    if (!files.length) return;
    const dz = defaultZoneId || zoneOptions[0]?.zoneId || "";
    if (!dz) {
      setLastMsg("请先在本页「Zone」标签创建至少一个 Zone，或选择默认 Zone");
      setTab("zones");
      return;
    }
    setQueue((prev) => {
      const next = [
        ...prev,
        ...files.map((file) => ({
          key: crypto.randomUUID(),
          file,
          relPath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
          zoneId: dz,
        })),
      ];
      setLastMsg(`已加入 ${files.length} 个文件（当前共 ${next.length} 项）`);
      return next;
    });
  }

  function handleCreateZone() {
    const zoneId = newZoneId.trim();
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(zoneId)) {
      setLastMsg("Zone ID 仅允许字母数字与 ._-，长度 1–64");
      return;
    }
    if (zoneOptions.some((z) => z.zoneId === zoneId)) {
      setLastMsg("该 Zone ID 已存在");
      return;
    }
    const keyB64 = generateZoneKeyB64();
    const zone: KeyFileZoneV1 = {
      zoneId,
      keyB64,
      ...(newZoneComment.trim() ? { comment: newZoneComment.trim() } : {}),
    };
    const nextZones = [...keySession.zones, zone];
    const next: KeyFileV1 = {
      schemaVersion: 1,
      username: keySession.username,
      roles: [...keySession.roles],
      zones: nextZones,
      createdAt: new Date().toISOString(),
    };
    setKeySession({ ...keySession, zones: nextZones });
    setLastMsg(`已创建 Zone「${zoneId}」，并已下载更新后的密钥文件`);
    downloadBlob(
      `key-${keySession.username}-updated.json`,
      new Blob([keyFileToDownloadJson(next)], { type: "application/json" }),
    );
    setNewZoneId("");
    setNewZoneComment("");
    setDefaultZoneId(zoneId);
  }

  function handleSaveOssJson() {
    const r = saveOssConfigToSession(ossJsonDraft);
    if (r.ok === false) {
      setLastMsg(r.error);
      return;
    }
    setOssUploadConfig(r.config);
    setLastMsg("OSS 上传配置已校验并保存（仅保存在当前浏览器标签页的会话中）");
  }

  function handleClearOssJson() {
    clearOssConfigSession();
    setOssJsonDraft(getDefaultOssJsonTemplate());
    setOssUploadConfig(null);
    setLastMsg("已清除 OSS 上传配置");
  }

  /**
   * 合并并上传清单。三道防线，保证「清单永不出现悬空引用、永不丢已有条目」：
   * 1. 写前严格读取现有清单：读取/解析失败一律中止，只有 404 才按空清单处理；
   * 2. 写入后立即回读校验：新增条目与原有条目必须全部在场；
   * 3. 校验不通过时抛错，由调用方下载 manifest-backup 兜底，绝不静默成功。
   *
   * 已知局限：OSS 单对象 PUT 没有 CAS/乐观锁，两个标签页同时合并仍可能互相覆盖，
   * 回读校验只能发现、无法阻止。要彻底解决需把合并逻辑放到服务端串行化。
   */
  async function mergeAndUploadManifest(
    newAssets: Record<string, unknown>[],
    ossCfg: OssUploadConfig,
  ): Promise<{ previousCount: number; mergedCount: number }> {
    const current = await fetchExistingManifestForMerge();
    // 合并本身是纯函数（src/lib/albumManifestFetch.ts），可被测试直接覆盖；
    // 它会原样保留清单里除 assets 之外的顶层字段，不再硬编码重建整个根对象。
    const { doc, previousCount } = buildMergedManifest(
      current,
      newAssets,
      new Date().toISOString(),
    );

    const body = JSON.stringify(doc, null, 2);
    const objectKey = getManifestObjectKey();
    const putUrl = await resolvePutSignedUrl(objectKey, ossCfg, "application/json");
    await putObjectWithSignedUrl(putUrl, new Blob([body], { type: "application/json" }), "application/json");

    const after = await fetchExistingManifestForMerge();
    if (after.status !== "ok") {
      throw new Error(`相册目录保存后读不回来（${objectKey}），无法确认是否成功，请到 OSS 控制台确认`);
    }
    const afterIds = new Set(
      after.payload.assets
        .map((a) => (a as { assetId?: string }).assetId)
        .filter((v): v is string => typeof v === "string"),
    );
    const expectedIds = (doc.assets as { assetId?: unknown }[])
      .map((a) => a.assetId)
      .filter((v): v is string => typeof v === "string");
    const lost = expectedIds.filter((id) => !afterIds.has(id));
    if (lost.length) {
      throw new Error(
        `保存后核对不通过：有 ${lost.length} 条没有出现在结果里（如 ${lost.slice(0, 3).join(", ")}），可能被另一次上传覆盖`,
      );
    }
    // 顶层字段也必须能回读出来（防止归一化把 assetsBasePath 之类的字段吃掉）
    const knownTopLevel = new Set(["assets", "schemaVersion", "generatedAt"]);
    const afterExtra = after.payload.extra ?? {};
    const lostTopLevel = Object.keys(doc).filter(
      (k) => !knownTopLevel.has(k) && !(k in afterExtra),
    );
    if (lostTopLevel.length) {
      throw new Error(
        `保存后核对不通过：字段 ${lostTopLevel.join(", ")} 没有出现在结果里`,
      );
    }
    return { previousCount, mergedCount: afterIds.size };
  }

  async function runEncrypt(uploadToOss: boolean) {
    if (!queue.length) {
      setLastMsg("请先添加文件（支持文件夹递归筛选图片/视频后缀）");
      return;
    }
    const missingZone = queue.some((q) => !zoneOptions.some((z) => z.zoneId === q.zoneId));
    if (missingZone) {
      setLastMsg("存在无效的 Zone，请逐行检查");
      return;
    }
    if (uploadToOss && !ossUploadConfig) {
      setLastMsg("请先填写并保存「OSS 上传配置」JSON（加密并上传到 OSS 必填）");
      return;
    }

    setBusy(true);
    setLastMsg(null);

    try {
      if (uploadToOss) {
        const ossCfg = ossUploadConfig!;
        setLastMsg("检查并初始化相册存储…");
        await ensureAlbumStorageInitialized(ossCfg);
        const newManifestAssets: Record<string, unknown>[] = [];
        const failedItems: QueueItem[] = [];
        const failures: string[] = [];

        for (let i = 0; i < queue.length; i++) {
          const item = queue[i];
          setLastMsg(`加密并上传 ${i + 1}/${queue.length}…`);
          try {
            const zone = zoneOptions.find((z) => z.zoneId === item.zoneId);
            if (!zone) throw new Error(`Zone「${item.zoneId}」不存在`);
            const { row, cipherBytes, ossKey } = await encryptQueueItem(item, zone);
            const putUrl = await resolvePutSignedUrl(ossKey, ossCfg, "application/octet-stream");
            await putObjectWithSignedUrl(putUrl, cipherBytes, "application/octet-stream");
            // 只有密文确认写入成功才进清单，避免清单出现指向不存在对象的悬空引用
            newManifestAssets.push(row);
          } catch (e) {
            failedItems.push(item);
            failures.push(`${item.relPath}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        if (!newManifestAssets.length) {
          setQueue(failedItems);
          setLastMsg(
            `${failures.length} 项都没能上传，相册没有任何改动。第一个失败原因：${failures[0]}`,
          );
          return;
        }

        try {
          const result = await mergeAndUploadManifest(newManifestAssets, ossCfg);
          const warn = failures.length
            ? `；另有 ${failures.length} 项失败，已保留在列表中可重试（首个：${failures[0]}）`
            : "";
          setLastMsg(
            `已保存：原有 ${result.previousCount} 张 + 本次 ${newManifestAssets.length} 张 = 共 ${result.mergedCount} 张。${warn}`,
          );
          setQueue(failedItems);
        } catch (e) {
          downloadBlob(
            `manifest-backup-${Date.now()}.json`,
            new Blob(
              [JSON.stringify({ schemaVersion: 1, assets: newManifestAssets }, null, 2)],
              { type: "application/json" },
            ),
          );
          setQueue(failedItems);
          setLastMsg(
            `${newManifestAssets.length} 张照片已上传，但相册目录保存失败：${e instanceof Error ? e.message : String(e)}。` +
              `已下载 manifest-backup-*.json 作为备份；请先确认相册状态再重试，不要反复上传。`,
          );
        }
        return;
      }

      const batches = chunkQueueForZip(queue, ZIP_BATCH_MAX_FILES, ZIP_BATCH_MAX_BYTES);
      const ts = Date.now();

      for (let b = 0; b < batches.length; b++) {
        const batch = batches[b];
        setLastMsg(`打包 ZIP 分卷 ${b + 1}/${batches.length}（本卷 ${batch.length} 个文件）…`);

        const zip = new JSZip();
        const assetsFolder = zip.folder("assets");
        const batchAssets: Record<string, unknown>[] = [];

        for (const item of batch) {
          const zone = zoneOptions.find((z) => z.zoneId === item.zoneId)!;
          const { row, cipherBytes, cipherName } = await encryptQueueItem(item, zone);
          batchAssets.push(row);
          assetsFolder?.file(cipherName, cipherBytes);
        }

        zip.file(
          "manifest-fragment.json",
          JSON.stringify(
            {
              schemaVersion: 1,
              generatedAt: new Date().toISOString(),
              assetsBasePath: "/albums/",
              assets: batchAssets,
            },
            null,
            2,
          ),
        );

        const zipBlob = await zip.generateAsync({
          type: "blob",
          compression: "STORE",
        });

        const partLabel =
          batches.length > 1
            ? `-part${String(b + 1).padStart(2, "0")}-of-${String(batches.length).padStart(2, "0")}`
            : "";
        downloadBlob(`album-encrypt${partLabel}-${ts}.zip`, zipBlob);
        await new Promise((r) => setTimeout(r, 120));
      }

      setLastMsg(
        batches.length > 1
          ? `已生成 ${batches.length} 个 ZIP 分卷（每卷至多约 ${ZIP_BATCH_MAX_FILES} 个文件或 ${Math.round(ZIP_BATCH_MAX_BYTES / (1024 * 1024))}MB 原图体积），避免一次性分配过大内存。`
          : `已生成 ZIP（${queue.length} 个文件）。`,
      );
      setQueue([]);
    } catch (e) {
      setLastMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-gradient-to-b from-zinc-950 via-black to-zinc-950 text-white">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-3">
          <Link
            to="/album"
            className="rounded-xl border border-white/20 bg-white/5 px-3 py-2 text-xs font-extrabold text-white/90 hover:bg-white/10"
          >
            返回相册
          </Link>
          <div>
            <div className="text-sm font-extrabold tracking-wide">相册管理</div>
            <div className="text-[11px] text-amber-200/90">{keySession.username}</div>
          </div>
        </div>
        <Link
          to="/"
          className="rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-xs font-bold text-white/70 hover:text-white"
        >
          首页
        </Link>
      </header>

      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 overflow-auto px-4 py-4">
        <div className="flex gap-2 rounded-2xl border border-white/10 bg-white/5 p-1">
          <button
            type="button"
            className={`flex-1 rounded-xl px-4 py-2 text-xs font-extrabold ${
              tab === "encrypt" ? "bg-amber-500/25 text-amber-100" : "text-white/65 hover:bg-white/10"
            }`}
            onClick={() => setTab("encrypt")}
          >
            加密照片到 Zone
          </button>
          <button
            type="button"
            className={`flex-1 rounded-xl px-4 py-2 text-xs font-extrabold ${
              tab === "zones" ? "bg-amber-500/25 text-amber-100" : "text-white/65 hover:bg-white/10"
            }`}
            onClick={() => setTab("zones")}
          >
            创建与管理 Zone
          </button>
        </div>

        {tab === "encrypt" ? (
          <section className="space-y-4 rounded-2xl border border-amber-400/30 bg-amber-950/20 p-4">
            <div className="rounded-xl border border-cyan-400/35 bg-black/35 p-3">
              <div className="mb-2 text-[11px] font-extrabold text-cyan-100/95">
                OSS 上传配置（点「加密并上传到 OSS」前<strong className="text-cyan-50">必填</strong>）
              </div>
              <textarea
                aria-label="OSS 上传配置 JSON"
                className="h-40 w-full resize-y rounded-lg border border-white/15 bg-black/50 p-2 font-mono text-[11px] leading-relaxed text-white/90 outline-none focus:border-cyan-400/50"
                spellCheck={false}
                autoComplete="off"
                value={ossJsonDraft}
                onChange={(e) => setOssJsonDraft(e.target.value)}
              />
              <div className="mt-2 flex flex-wrap gap-2">
                <label className="cursor-pointer rounded-lg border border-cyan-400/40 px-3 py-1.5 text-[11px] text-cyan-50">
                  导入 OSS JSON
                  <input
                    type="file"
                    accept=".json,application/json"
                    aria-label="导入 OSS JSON"
                    className="sr-only"
                    disabled={busy}
                    onChange={async (e) => {
                      const file = e.currentTarget.files?.[0];
                      e.currentTarget.value = "";
                      if (!file) return;
                      try {
                        const text = await file.text();
                        const result = saveOssConfigToSession(text);
                        if (result.ok === false) {
                          setLastMsg(`OSS 配置导入失败：${result.error}`);
                          return;
                        }
                        setOssJsonDraft(text);
                        setOssUploadConfig(result.config);
                        setLastMsg("OSS 上传配置已导入并保存（仅当前标签页会话）");
                      } catch {
                        setLastMsg("OSS 配置文件读取或保存失败，请重试");
                      }
                    }}
                  />
                </label>
                <button
                  type="button"
                  className="rounded-lg border border-cyan-400/40 bg-cyan-500/20 px-3 py-1.5 text-[11px] font-extrabold text-cyan-50 hover:bg-cyan-500/30"
                  onClick={handleSaveOssJson}
                >
                  保存配置
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/75 hover:bg-white/10"
                  onClick={handleClearOssJson}
                >
                  清除配置
                </button>
              </div>
              <p className="mt-2 text-[10px] leading-relaxed text-rose-200/85">
                这段密钥只保存在当前标签页，关掉浏览器就清空。请务必：不要在公共电脑上使用、不要提交到 Git、不要发到聊天里；一旦泄露，请到阿里云控制台更换。
              </p>
              {ossUploadConfig ? (
                <p className="mt-1 text-[10px] text-emerald-200/90">
                  已就绪：Bucket「{ossUploadConfig.oss_bucket_name}」· {ossUploadConfig.oss_endpoint}
                </p>
              ) : (
                <p className="mt-1 text-[10px] text-amber-200/85">尚未保存有效配置</p>
              )}
            </div>

            <p className="text-[11px] leading-relaxed text-white/55">
              只挑图片和视频（jpg / png / webp / gif / mp4 / webm）。选文件夹时会连着子文件夹一起找。每个文件都能单独选放进哪个
              Zone。<span className="text-amber-200/90">照片多的时候请用「加密并上传到 OSS」</span>
              （直接传，不占内存）；「仅打包下载」会按约 {ZIP_BATCH_MAX_FILES} 张 或{" "}
              {Math.round(ZIP_BATCH_MAX_BYTES / (1024 * 1024))}MB 分成几个 ZIP 下载。上传前需要先在上面填好 OSS 配置。
            </p>

            <div className="flex flex-wrap gap-3">
              <label className="text-[11px] text-white/60">
                默认 Zone（新加入文件）
                <select
                  className="mt-1 block rounded-xl border border-white/15 bg-black/40 px-3 py-2 text-xs text-white"
                  value={defaultZoneId}
                  onChange={(e) => setDefaultZoneId(e.target.value)}
                >
                  {zoneOptions.length === 0 ? (
                    <option value="">请先创建 Zone</option>
                  ) : (
                    zoneOptions.map((z) => (
                      <option key={z.zoneId} value={z.zoneId}>
                        {z.zoneId}
                        {z.comment ? ` — ${z.comment}` : ""}
                      </option>
                    ))
                  )}
                </select>
              </label>
            </div>

            <div className="flex flex-wrap gap-3">
              <label className="cursor-pointer rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-xs font-extrabold hover:bg-white/15">
                选择文件
                <input
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    appendQueue(collectMediaFiles(e.currentTarget.files));
                    e.currentTarget.value = "";
                  }}
                />
              </label>
              <label className="cursor-pointer rounded-xl border border-amber-400/40 bg-amber-500/15 px-4 py-2 text-xs font-extrabold text-amber-100 hover:bg-amber-500/25">
                选择文件夹（递归）
                <input
                  type="file"
                  multiple
                  className="hidden"
                  {...{ webkitdirectory: "" }}
                  onChange={(e) => {
                    appendQueue(collectMediaFiles(e.currentTarget.files));
                    e.currentTarget.value = "";
                  }}
                />
              </label>
              <button
                type="button"
                className="rounded-xl border border-white/15 px-4 py-2 text-xs text-white/70 hover:bg-white/10"
                onClick={() => {
                  setQueue([]);
                  setLastMsg("已清空列表");
                }}
              >
                清空列表
              </button>
            </div>

            {queue.length > 0 ? (
              <div className="max-h-[45vh] overflow-auto rounded-xl border border-white/10">
                <table className="w-full text-left text-[11px]">
                  <thead className="sticky top-0 bg-zinc-900/95 text-white/55">
                    <tr>
                      <th className="px-2 py-2">路径</th>
                      <th className="w-40 px-2 py-2">目标 Zone</th>
                      <th className="w-16 px-2 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {queue.map((item) => (
                      <tr key={item.key} className="border-t border-white/5">
                        <td className="max-w-md truncate px-2 py-1.5 font-mono text-white/85" title={item.relPath}>
                          {item.relPath}
                        </td>
                        <td className="px-2 py-1">
                          <select
                            className="w-full rounded-lg border border-white/15 bg-black/50 px-2 py-1 text-[11px]"
                            value={item.zoneId}
                            onChange={(e) =>
                              setQueue((prev) =>
                                prev.map((q) =>
                                  q.key === item.key ? { ...q, zoneId: e.target.value } : q,
                                ),
                              )
                            }
                          >
                            {zoneOptions.map((z) => (
                              <option key={z.zoneId} value={z.zoneId}>
                                {z.zoneId}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-2 py-1">
                          <button
                            type="button"
                            className="text-rose-300/90 hover:text-rose-200"
                            onClick={() => setQueue((prev) => prev.filter((q) => q.key !== item.key))}
                          >
                            移除
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                disabled={busy || !zoneOptions.length}
                className="rounded-xl border border-amber-400/50 bg-amber-500/25 px-5 py-2.5 text-xs font-extrabold text-amber-50 hover:bg-amber-500/35 disabled:opacity-40"
                onClick={() => void runEncrypt(true)}
              >
                {busy ? "处理中…" : "加密并上传到 OSS"}
              </button>
              <button
                type="button"
                disabled={busy || !zoneOptions.length}
                className="rounded-xl border border-white/20 bg-white/10 px-5 py-2.5 text-xs font-extrabold text-white/90 hover:bg-white/15 disabled:opacity-40"
                onClick={() => void runEncrypt(false)}
              >
                仅打包下载 ZIP（离线）
              </button>
            </div>
          </section>
        ) : (
          <section className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4">
            <div className="text-[11px] font-bold text-white/70">新建 Zone</div>
            <label className="block text-[11px] text-white/55">
              Zone ID
              <input
                className="mt-1 w-full max-w-md rounded-xl border border-white/15 bg-black/40 px-3 py-2 text-xs text-white"
                value={newZoneId}
                onChange={(e) => setNewZoneId(e.target.value)}
                placeholder="例：friends-2026"
              />
            </label>
            <label className="block text-[11px] text-white/55">
              备注（可选）
              <input
                className="mt-1 w-full max-w-md rounded-xl border border-white/15 bg-black/40 px-3 py-2 text-xs text-white"
                value={newZoneComment}
                onChange={(e) => setNewZoneComment(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="rounded-xl border border-amber-400/40 bg-amber-500/20 px-4 py-2 text-xs font-extrabold text-amber-100 hover:bg-amber-500/30"
              onClick={handleCreateZone}
            >
              生成密钥并下载更新后的密钥文件
            </button>

            <div className="mt-4 text-[11px] font-bold text-white/70">已有 Zone</div>
            <ul className="list-inside list-disc text-[11px] text-white/60">
              {zoneOptions.map((z) => (
                <li key={z.zoneId}>
                  <span className="font-mono text-white/85">{z.zoneId}</span>
                  {z.comment ? ` — ${z.comment}` : ""}
                </li>
              ))}
            </ul>
          </section>
        )}

        {lastMsg ? (
          <div className="rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-[11px] text-amber-100/95">{lastMsg}</div>
        ) : null}

        <p className="text-[10px] text-white/40">保存前会先读取现有相册并核对，确保不会覆盖已有照片。</p>
      </div>
    </div>
  );
}

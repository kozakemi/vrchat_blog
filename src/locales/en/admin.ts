/** 相册管理页（src/pages/AlbumAdmin.tsx）的英文文案。key 必须与 zh/admin.ts、ja/admin.ts 完全一致。 */
const admin = {
  // ---- 页头 / 标签页 ----
  backToAlbum: "Back to album",
  adminTitle: "Album admin",
  home: "Home",
  tabEncrypt: "Encrypt photos into a Zone",
  tabZones: "Create and manage Zones",

  // ---- OSS 上传配置 ----
  ossConfigTitle: "OSS upload config (<strong>required</strong> before “Encrypt and upload to OSS”)",
  ossConfigJsonAria: "OSS upload config JSON",
  importOssJson: "Import OSS JSON",
  saveConfig: "Save config",
  clearConfig: "Clear config",
  ossImportFailed: "Could not import the OSS config: {{detail}}",
  ossImported: "OSS upload config imported and saved (this tab's session only)",
  ossImportReadFailed: "Could not read or save the OSS config file. Please try again",
  ossSecretWarning:
    "This key is kept only in the current tab and is cleared when you close the browser. Please never use it on a shared computer, commit it to Git, or paste it into a chat. If it ever leaks, replace it in the Alibaba Cloud console.",
  ossReady: "Ready: Bucket “{{bucket}}” · {{endpoint}}",
  ossNotConfigured: "No valid config saved yet",

  // ---- 加密并上传 ----
  encryptHint:
    "Only images and videos are picked up (jpg / png / webp / gif / mp4 / webm). Choosing a folder also looks inside its subfolders. Each file can be sent to its own Zone. <span>With a lot of photos, use “Encrypt and upload to OSS”</span> (sent directly, so it does not eat memory); “Download as ZIP only” splits the files into several ZIPs of about {{maxFiles}} photos or {{maxMb}}MB each. Fill in the OSS config above before uploading.",
  defaultZoneLabel: "Default Zone (for newly added files)",
  createZoneFirst: "Create a Zone first",
  selectFiles: "Choose files",
  selectFolderRecursive: "Choose a folder (includes subfolders)",
  clearQueue: "Clear list",
  queueCleared: "List cleared",
  colPath: "Path",
  colTargetZone: "Target Zone",
  remove: "Remove",
  processing: "Working…",
  encryptAndUpload: "Encrypt and upload to OSS",
  zipOnlyOffline: "Download as ZIP only (offline)",
  mergeSafetyNote: "Before saving, the current album is read and checked so that existing photos are not overwritten.",

  // ---- Zone 管理 ----
  newZoneTitle: "New Zone",
  zoneIdPlaceholder: "e.g. friends-2026",
  zoneCommentLabel: "Note (optional)",
  generateKeyAndDownload: "Create a key and download the updated key file",
  existingZones: "Existing Zones",

  // ---- 挑文件 / 建 Zone 的提示 ----
  noZoneYet: "Create at least one Zone on this page's “Zone” tab first, or choose a default Zone",
  addedFiles: "Files added: {{count}} ({{total}} in the list now)",
  zoneIdRule: "Zone ID may only use letters, numbers and ._-, 1–64 characters",
  zoneIdExists: "That Zone ID already exists",
  zoneCreated: "Zone “{{zoneId}}” created — the updated key file has been downloaded",
  ossSaved: "OSS upload config checked and saved (kept only in this browser tab's session)",
  ossCleared: "OSS upload config cleared",

  // ---- 相册目录（manifest）的读写与核对 ----
  manifestReadBackFailed:
    "The album index could not be read back after saving ({{objectKey}}), so success cannot be confirmed — please check the OSS console",
  manifestVerifyLost:
    "Check after saving failed: missing from the result: {{count}} (e.g. {{sample}}) — another upload may have overwritten them",
  manifestVerifyLostFields: "Check after saving failed: missing from the result: {{fields}}",
  needFiles: "Add files first (choosing a folder picks up image and video extensions recursively)",
  invalidZoneInQueue: "Some rows use a Zone that no longer exists — please check each row",
  needOssConfig: "Fill in and save the “OSS upload config” JSON first (needed to upload to OSS)",
  checkingUploadPath: "Checking the upload path…",
  uploadPathUnavailable: "The pre-upload check did not pass. {{detail}}",
  checkingAlbumStorage: "Checking the album storage…",
  encryptingProgress: "Encrypting and uploading {{current}}/{{total}}…",
  zoneMissing: "Zone “{{zoneId}}” does not exist",
  abortedConsecutive:
    "Failed in a row: {{count}} — so this upload was stopped ({{remaining}} left in the list). First failure: {{reason}}. This is usually not a single file problem but the whole upload path being unavailable — run node tools/oss-upload-cors.mjs to see the preflight status, and check that your Alibaba Cloud account or bucket has not had data access disabled (for example, unpaid fees).",
  allUploadsFailed: "Nothing was uploaded: {{count}} — the album was not changed at all. First failure: {{reason}}",
  someFailedSuffix: " Also failed: {{count}} — kept in the list so you can retry (first: {{reason}})",
  savedSummary: "Saved: {{previous}} existing + {{added}} new = {{total}} total.{{detail}}",
  uploadedButManifestFailed:
    "Photos uploaded: {{count}} — but saving the album index failed: {{detail}}. A manifest-backup-*.json was downloaded as a backup; check the album state before retrying, and do not upload repeatedly.",
  zipProgress: "Building ZIP part {{current}}/{{total}} (files in this part: {{files}})…",
  zipSplitDone:
    "Created {{parts}} ZIP parts (each up to about {{maxFiles}} files or {{maxMb}}MB of original photos) so that too much memory is not allocated at once.",
  zipSingleDone: "ZIP created ({{count}} in total).",
  couldNotFinish: "Could not finish: {{detail}}",
};

export default admin;

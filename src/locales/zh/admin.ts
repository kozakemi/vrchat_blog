/**
 * 相册管理页（src/pages/AlbumAdmin.tsx）的中文文案。
 *
 * 这个对象就是 i18next 的 `admin` 命名空间：页面上用 t("admin.xxx") 取。
 * ⚠️ zh / ja / en 三份的 key 集合必须完全一致，由 `npm run test:i18n` 强制。
 *
 * 约定：
 * - 「Zone」「OSS 上传配置」「Bucket」「AccessKey」这类专有名词三语都保持原样；
 * - 外层说明（用户看得懂的那句）在这里翻译，内层技术细节由页面通过 {{detail}}
 *   等变量拼进来——src/lib/ 抛出的中文诊断消息刻意不翻译，方便站长排查。
 */
const admin = {
  // ---- 页头 / 标签页 ----
  backToAlbum: "返回相册",
  adminTitle: "相册管理",
  home: "首页",
  tabEncrypt: "加密照片到 Zone",
  tabZones: "创建与管理 Zone",

  // ---- OSS 上传配置 ----
  ossConfigTitle: "OSS 上传配置（点「加密并上传到 OSS」前<strong>必填</strong>）",
  ossConfigJsonAria: "OSS 上传配置 JSON",
  importOssJson: "导入 OSS JSON",
  saveConfig: "保存配置",
  clearConfig: "清除配置",
  ossImportFailed: "OSS 配置导入失败：{{detail}}",
  ossImported: "OSS 上传配置已导入并保存（仅当前标签页会话）",
  ossImportReadFailed: "OSS 配置文件读取或保存失败，请重试",
  ossSecretWarning:
    "这段密钥只保存在当前标签页，关掉浏览器就清空。请务必：不要在公共电脑上使用、不要提交到 Git、不要发到聊天里；一旦泄露，请到阿里云控制台更换。",
  ossReady: "已就绪：Bucket「{{bucket}}」· {{endpoint}}",
  ossNotConfigured: "尚未保存有效配置",

  // ---- 加密并上传 ----
  encryptHint:
    "只挑图片和视频（jpg / png / webp / gif / mp4 / webm）。选文件夹时会连着子文件夹一起找。每个文件都能单独选放进哪个 Zone。<span>照片多的时候请用「加密并上传到 OSS」</span>（直接传，不占内存）；「仅打包下载」会按约 {{maxFiles}} 张 或 {{maxMb}}MB 分成几个 ZIP 下载。上传前需要先在上面填好 OSS 配置。",
  defaultZoneLabel: "默认 Zone（新加入文件）",
  createZoneFirst: "请先创建 Zone",
  selectFiles: "选择文件",
  selectFolderRecursive: "选择文件夹（递归）",
  clearQueue: "清空列表",
  queueCleared: "已清空列表",
  colPath: "路径",
  colTargetZone: "目标 Zone",
  remove: "移除",
  processing: "处理中…",
  encryptAndUpload: "加密并上传到 OSS",
  zipOnlyOffline: "仅打包下载 ZIP（离线）",
  mergeSafetyNote: "保存前会先读取现有相册并核对，确保不会覆盖已有照片。",

  // ---- Zone 管理 ----
  newZoneTitle: "新建 Zone",
  zoneIdPlaceholder: "例：friends-2026",
  zoneCommentLabel: "备注（可选）",
  generateKeyAndDownload: "生成密钥并下载更新后的密钥文件",
  existingZones: "已有 Zone",

  // ---- 挑文件 / 建 Zone 的提示 ----
  noZoneYet: "请先在本页「Zone」标签创建至少一个 Zone，或选择默认 Zone",
  addedFiles: "已加入 {{count}} 个文件（当前共 {{total}} 项）",
  zoneIdRule: "Zone ID 仅允许字母数字与 ._-，长度 1–64",
  zoneIdExists: "该 Zone ID 已存在",
  zoneCreated: "已创建 Zone「{{zoneId}}」，并已下载更新后的密钥文件",
  ossSaved: "OSS 上传配置已校验并保存（仅保存在当前浏览器标签页的会话中）",
  ossCleared: "已清除 OSS 上传配置",

  // ---- 相册目录（manifest）的读写与核对 ----
  manifestReadBackFailed: "相册目录保存后读不回来（{{objectKey}}），无法确认是否成功，请到 OSS 控制台确认",
  manifestVerifyLost: "保存后核对不通过：有 {{count}} 条没有出现在结果里（如 {{sample}}），可能被另一次上传覆盖",
  manifestVerifyLostFields: "保存后核对不通过：字段 {{fields}} 没有出现在结果里",
  needFiles: "请先添加文件（支持文件夹递归筛选图片/视频后缀）",
  invalidZoneInQueue: "存在无效的 Zone，请逐行检查",
  needOssConfig: "请先填写并保存「OSS 上传配置」JSON（加密并上传到 OSS 必填）",
  checkingUploadPath: "检查上传通道…",
  uploadPathUnavailable: "上传前检查未通过。{{detail}}",
  checkingAlbumStorage: "检查并初始化相册存储…",
  encryptingProgress: "加密并上传 {{current}}/{{total}}…",
  zoneMissing: "Zone「{{zoneId}}」不存在",
  abortedConsecutive:
    "连续 {{count}} 项失败，已停止本次上传（剩余 {{remaining}} 项保留在列表中）。首个失败原因：{{reason}}。这通常不是单个文件的问题，而是上传通道整体不可用——请运行 node tools/oss-upload-cors.mjs 查看预检状态，并确认阿里云账号/桶未因欠费等原因停用数据访问。",
  allUploadsFailed: "{{count}} 项都没能上传，相册没有任何改动。第一个失败原因：{{reason}}",
  someFailedSuffix: "；另有 {{count}} 项失败，已保留在列表中可重试（首个：{{reason}}）",
  savedSummary: "已保存：原有 {{previous}} 张 + 本次 {{added}} 张 = 共 {{total}} 张。{{detail}}",
  uploadedButManifestFailed:
    "{{count}} 张照片已上传，但相册目录保存失败：{{detail}}。已下载 manifest-backup-*.json 作为备份；请先确认相册状态再重试，不要反复上传。",
  zipProgress: "打包 ZIP 分卷 {{current}}/{{total}}（本卷 {{files}} 个文件）…",
  zipSplitDone:
    "已生成 {{parts}} 个 ZIP 分卷（每卷至多约 {{maxFiles}} 个文件或 {{maxMb}}MB 原图体积），避免一次性分配过大内存。",
  zipSingleDone: "已生成 ZIP（{{count}} 个文件）。",
  couldNotFinish: "没能完成：{{detail}}",
};

export default admin;

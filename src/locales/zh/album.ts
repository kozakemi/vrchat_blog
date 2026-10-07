/**
 * 相册页（src/pages/Album.tsx）的中文文案。
 *
 * 这个对象就是 i18next 的 `album` 命名空间：页面上用 t("album.xxx") 取。
 * ⚠️ zh / ja / en 三份的 key 集合必须完全一致，由 `npm run test:i18n` 强制。
 */
const album = {
  // ---- 顶部导航与视图切换 ----
  back: "返回",
  title: "相册",
  adminLink: "管理",
  aboutLink: "关于",
  byTime: "按时间",
  byWorld: "按世界",

  // ---- Zone 显示开关（纯界面筛选）----
  showZone: "显示 Zone",
  zoneEmpty: "这个 Zone 还没有照片",
  photosCount: "共 {{count}} 张",
  showAllHidden: "已隐藏 {{count}} 张 · 全部显示",

  // ---- 加载与打不开 ----
  loading: "正在加载相册…",
  loadFailedTitle: "相册暂时打不开，请稍后再试。",
  loadFailedHint: "如果一直这样，请联系站长。",
  technicalDetail: "技术细节",

  // ---- 数量与空状态 ----
  totalCount: "共 <strong>{{count}}</strong> 张",
  hiddenByZoneNote: "（另有 {{count}} 张被上方的 Zone 开关隐藏）",
  hiddenByPermissionNote: "（另有 {{count}} 张不在当前身份的权限内）",
  emptyAllHidden: "这些照片都被上方的 Zone 开关隐藏了，点「全部显示」就能看到。",
  emptyNoPermission: "这里的照片不在当前身份的权限内。",
  emptyNoPhotos: "相册暂无照片，管理员上传后会自动显示。",

  // ---- 世界（VRChat world）----
  worldUnknown: "世界未知",
  worldUnknownPending: "未知世界 / 待填写",
  worldIdEmpty: "WorldID 为空（待填写）",
  latestAt: "最新：{{time}}",

  // ---- 复制与提示 ----
  copyWorldTitle: "点击复制世界名称/ID",
  copyWorldNameTitle: "点击复制世界名称",
  copyWorldIdTitle: "点击复制 WorldID",
  worldNameLabel: "世界名称",
  noWorldInfo: "无世界信息可复制",
  noWorldName: "无世界名称可复制",
  noWorldId: "无 WorldID 可复制",
  copied: "{{label}}已复制",
  copyFailed: "复制失败",
  timeUnknown: "时间未知",

  // ---- 大图操作 ----
  download: "下载",
  downloadImageAria: "下载图片",
  saveImageTitle: "保存这张图片到本地",
  more: "更多",
  moreInfo: "查看更多图片信息",
  previous: "上一张 ←",
  next: "下一张 →",
  closeEsc: "关闭 Esc",
  close: "关闭",
  imageNotReady: "图片还没准备好，请稍后再试",
  downloadStarted: "已开始下载",

  // ---- 「更多」面板 ----
  fileNameLabel: "文件名：",
  sizeLabel: "尺寸：",
  takenAtLabel: "拍摄时间：",
  unknown: "未知",
  zoneLabel: "归属 Zone：",
  zoneNotDeclared: "（未声明）",
  zoneKeyHeld: "当前会话持有该区密钥",
  zoneKeyMissing: "当前会话没有该区密钥",
  encryptionLabel: "加密方式：",
  encryptionUnknown: "尚未解密，未知",
  encryptionCipher: "AES-256-GCM 密文",
  encryptionPlain: "明文对象（未加密）",
  uploadedKeyFpLabel: "上传时密钥指纹：",
  decryptKeyFpLabel: "本次解密密钥指纹：",
  fpNotRecorded: "（清单未记录）",
  fpNotDecrypted: "（未解密）",
  fpMatch: "✓ 加密与解密用的是同一把密钥",
  fpMismatch: "⚠️ 加密与解密用的不是同一把密钥（清单记录与实际不符）",
  plainWarning: "⚠️ 这条是明文对象：没有加密，任何知道该对象键的人都能取到原图",
  objectKeyLabel: "OSS 对象键：",
  relPathLabel: "相对路径：",
  none: "（无）",
  notRecorded: "（未记录）",

  // ---- 删除照片（管理员）----
  deleteAria: "删除照片",
  deleteTitle: "删除这张照片（不可恢复）",
  delete: "删除",
  deletePartialTitle: "删除未完全完成",
  deleteConfirmTitle: "确认删除这张照片？",
  deleteWarning:
    "会同时删除 OSS 上的密文文件，<strong>删除后无法恢复</strong>（存储桶未开启版本控制）。请确认没有其他地方还需要它。",
  deleting: "正在删除…",
  confirmDelete: "确认删除",
  cancel: "取消",
  deletedGone: "这张照片已删除（密文此前已不存在）",
  deleted: "已删除这张照片",
  errDeleteNeedsOssConfig: "需要先在「相册管理」页保存 OSS 上传配置，删除请求才能签名。",

  // ---- 改归属 Zone（管理员）----
  changeZone: "改 Zone",
  changeZoneTitle: "把这张照片改成归属另一个 Zone",
  changeZoneAria: "修改归属 Zone",
  zoneDialogTitle: "把这张照片换个 Zone",
  zonePartialTitle: "已换好，但旧文件没删掉",
  zoneCurrentLabel: "现在的 Zone：",
  zoneNotRecorded: "（没记录）",
  zoneStatusLabel: "当前状态：",
  zoneStatusEncrypted: "已加密",
  zoneStatusPlain: "未加密（这次会顺便加密）",
  zoneNoSourceKey:
    "你的密钥文件里没有「{{zone}}」的密钥，打不开这张照片，所以换不了。请改用包含这个 Zone 的密钥文件。",
  zoneNoTargetOptions:
    "你的密钥文件里没有别的 Zone 可以换。请先到「相册管理 → 创建与管理 Zone」新建一个。",
  zoneSelectLabel: "换成哪个 Zone",
  zoneSelectAria: "目标 Zone",
  zoneSelectPlaceholder: "请选择",
  zoneSelectRequired: "请选择要换成哪个 Zone",
  zoneProcessNote:
    "照片内容不会被改动。过程是：取回这张照片 → 用现在的密钥解开 → 用新 Zone 的密钥重新加密 → 传成新文件 → 让相册指向它 → 删掉旧文件。会按原始大小下载并上传一次，所以大图需要等一会儿。",
  zoneChanging: "正在迁移…",
  zoneConfirm: "确认换区",
  errZoneNeedsOssConfig: "需要先在「相册管理」页保存 OSS 上传配置，迁移请求才能签名。",
  zoneMovedEncrypted: "已加密并归入 Zone「{{zone}}」",
  zoneMoved: "已改成 Zone「{{zone}}」",

  // ---- 取图失败（只进控制台，界面上不展示）----
  errSignUrl: "获取签名URL失败",
  errNoObjectKey: "缺少可读取的对象键",
  errNoZoneKey: "缺少 Zone「{{zone}}」的解密密钥",
  errNoNonce: "密文资源缺少 nonceB64",
  errCipherUrl: "获取密文临时URL失败",
  errImageRequest: "图片请求失败：HTTP {{status}}",
  errCipherRequest: "密文请求失败：HTTP {{status}}",
};

export default album;

/** 相册管理页（src/pages/AlbumAdmin.tsx）的日文文案。key 必须与 zh/admin.ts、en/admin.ts 完全一致。 */
const admin = {
  // ---- 页头 / 标签页 ----
  backToAlbum: "アルバムへ戻る",
  adminTitle: "アルバム管理",
  home: "ホーム",
  tabEncrypt: "写真を Zone に暗号化",
  tabZones: "Zone の作成と管理",

  // ---- OSS 上传配置 ----
  ossConfigTitle: "OSS アップロード設定（「暗号化して OSS へアップロード」の前に<strong>必須</strong>）",
  ossConfigJsonAria: "OSS アップロード設定 JSON",
  importOssJson: "OSS JSON を読み込む",
  saveConfig: "設定を保存",
  clearConfig: "設定を消去",
  ossImportFailed: "OSS 設定を読み込めませんでした：{{detail}}",
  ossImported: "OSS アップロード設定を読み込んで保存しました（このタブのセッション内のみ）",
  ossImportReadFailed: "OSS 設定ファイルの読み込みまたは保存に失敗しました。もう一度お試しください",
  ossSecretWarning:
    "この鍵は今のタブにだけ保存され、ブラウザを閉じると消えます。次のことを必ず守ってください：共用のパソコンでは使わない、Git に上げない、チャットに送らない。もし漏れてしまったら、Alibaba Cloud のコンソールで作り直してください。",
  ossReady: "準備完了：Bucket「{{bucket}}」· {{endpoint}}",
  ossNotConfigured: "有効な設定がまだ保存されていません",

  // ---- 加密并上传 ----
  encryptHint:
    "選べるのは画像と動画だけです（jpg / png / webp / gif / mp4 / webm）。フォルダを選ぶと、中のサブフォルダもまとめて探します。ファイルごとに、入れる Zone を個別に選べます。<span>写真が多いときは「暗号化して OSS へアップロード」</span>（そのまま送るのでメモリを使いません）。「ZIP のダウンロードのみ」は約 {{maxFiles}} 枚、または {{maxMb}}MB ごとにいくつかの ZIP に分けて保存します。アップロードする前に、上の OSS 設定を入力しておいてください。",
  defaultZoneLabel: "既定の Zone（あとから追加したファイル）",
  createZoneFirst: "先に Zone を作成してください",
  selectFiles: "ファイルを選ぶ",
  selectFolderRecursive: "フォルダを選ぶ（サブフォルダも含む）",
  clearQueue: "リストを空にする",
  queueCleared: "リストを空にしました",
  colPath: "パス",
  colTargetZone: "保存先 Zone",
  remove: "外す",
  processing: "処理中…",
  encryptAndUpload: "暗号化して OSS へアップロード",
  zipOnlyOffline: "ZIP のダウンロードのみ（オフライン）",
  mergeSafetyNote: "保存する前に既存のアルバムを読み込んで照合し、すでにある写真を上書きしないようにします。",

  // ---- Zone 管理 ----
  newZoneTitle: "Zone を新規作成",
  zoneIdPlaceholder: "例：friends-2026",
  zoneCommentLabel: "メモ（任意）",
  generateKeyAndDownload: "キーを作り、更新後のキーファイルを保存",
  existingZones: "既存の Zone",

  // ---- 挑文件 / 建 Zone 的提示 ----
  noZoneYet: "先にこのページの「Zone」タブで Zone を1つ以上作るか、既定の Zone を選んでください",
  addedFiles: "{{count}} 個のファイルを追加しました（現在は合計 {{total}} 件）",
  zoneIdRule: "Zone ID に使えるのは英数字と ._- だけ、長さは 1〜64",
  zoneIdExists: "この Zone ID はすでにあります",
  zoneCreated: "Zone「{{zoneId}}」を作成し、更新後のキーファイルを保存しました",
  ossSaved: "OSS アップロード設定を確認して保存しました（今のブラウザタブのセッション内だけに保存されます）",
  ossCleared: "OSS アップロード設定を消去しました",

  // ---- 相册目录（manifest）的读写与核对 ----
  manifestReadBackFailed:
    "アルバム目録を保存したあとに読み戻せませんでした（{{objectKey}}）。成功したか分からないので、OSS コンソールで確認してください",
  manifestVerifyLost:
    "保存後の照合に通りませんでした：{{count}} 件が結果に出てきません（例：{{sample}}）。別のアップロードに上書きされた可能性があります",
  manifestVerifyLostFields: "保存後の照合に通りませんでした：項目 {{fields}} が結果に出てきません",
  needFiles: "先にファイルを追加してください（フォルダを選ぶと画像・動画の拡張子をまとめて拾います）",
  invalidZoneInQueue: "無効な Zone があります。1 行ずつ確認してください",
  needOssConfig: "先に「OSS アップロード設定」の JSON を入力して保存してください（暗号化して OSS へアップロードするときに必要です）",
  checkingUploadPath: "アップロード経路を確認しています…",
  uploadPathUnavailable: "アップロード前の確認に通りませんでした。{{detail}}",
  checkingAlbumStorage: "アルバムの保存先を確認しています…",
  encryptingProgress: "暗号化してアップロード中 {{current}}/{{total}}…",
  zoneMissing: "Zone「{{zoneId}}」がありません",
  abortedConsecutive:
    "{{count}} 件続けて失敗したため、今回のアップロードを中止しました（残り {{remaining}} 件はリストに残しています）。最初の失敗理由：{{reason}}。これは 1 つのファイルの問題ではなく、アップロード経路そのものが使えないことが多いです。node tools/oss-upload-cors.mjs を実行して事前チェックの状態を見て、Alibaba Cloud のアカウントやバケットが未払いなどでデータアクセスを止められていないか確認してください。",
  allUploadsFailed: "{{count}} 件ともアップロードできず、アルバムは何も変わっていません。最初の失敗理由：{{reason}}",
  someFailedSuffix: "ほかにも {{count}} 件失敗しました。リストに残しているので再試行できます（最初：{{reason}}）",
  savedSummary: "保存しました：既存 {{previous}} 枚 ＋ 今回 {{added}} 枚 ＝ 合計 {{total}} 枚。{{detail}}",
  uploadedButManifestFailed:
    "{{count}} 枚の写真はアップロードしましたが、アルバム目録を保存できませんでした：{{detail}}。バックアップとして manifest-backup-*.json を保存しました。アルバムの状態を確認してから再試行し、何度もアップロードしないでください。",
  zipProgress: "ZIP をまとめています {{current}}/{{total}}（この分は {{files}} ファイル）…",
  zipSplitDone:
    "ZIP を {{parts}} 個に分けて作成しました（1 つあたり最大で約 {{maxFiles}} ファイル、または元画像で {{maxMb}}MB）。一度に大きなメモリを確保しないためです。",
  zipSingleDone: "ZIP を作成しました（{{count}} ファイル）。",
  couldNotFinish: "完了できませんでした：{{detail}}",
};

export default admin;

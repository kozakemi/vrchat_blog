/** 相册页（src/pages/Album.tsx）的日文文案。key 必须与 zh/album.ts、en/album.ts 完全一致。 */
const album = {
  // ---- 上部ナビゲーションと表示切替 ----
  back: "戻る",
  title: "アルバム",
  adminLink: "管理",
  aboutLink: "このサイトについて",
  byTime: "時系列",
  byWorld: "ワールド別",

  // ---- Zone 表示スイッチ（画面内の絞り込みのみ）----
  showZone: "Zone を表示",
  zoneEmpty: "この Zone にはまだ写真がありません",
  photosCount: "全 {{count}} 枚",
  showAllHidden: "{{count}} 枚を非表示 · すべて表示",

  // ---- 読み込みと開けないとき ----
  loading: "アルバムを読み込んでいます…",
  loadFailedTitle: "アルバムを開けません。しばらくしてからお試しください。",
  loadFailedHint: "ずっとこのままの場合は、管理人までご連絡ください。",
  technicalDetail: "技術的な詳細",

  // ---- 枚数と空の状態 ----
  totalCount: "全 <strong>{{count}}</strong> 枚",
  hiddenByZoneNote: "（ほか {{count}} 枚は上の Zone スイッチで非表示）",
  hiddenByPermissionNote: "（ほか {{count}} 枚は現在の権限では見られません）",
  emptyAllHidden: "これらの写真は上の Zone スイッチで非表示になっています。「すべて表示」を押すと見られます。",
  emptyNoPermission: "ここの写真は現在の権限では見られません。",
  emptyNoPhotos: "アルバムにまだ写真がありません。管理者がアップロードすると自動で表示されます。",

  // ---- ワールド（VRChat world）----
  worldUnknown: "ワールド不明",
  worldUnknownPending: "不明なワールド / 未入力",
  worldIdEmpty: "WorldID が空です（未入力）",
  latestAt: "最新：{{time}}",

  // ---- コピーとお知らせ ----
  copyWorldTitle: "クリックでワールド名/ID をコピー",
  copyWorldNameTitle: "クリックでワールド名をコピー",
  copyWorldIdTitle: "クリックで WorldID をコピー",
  worldNameLabel: "ワールド名",
  noWorldInfo: "コピーできるワールド情報がありません",
  noWorldName: "コピーできるワールド名がありません",
  noWorldId: "コピーできる WorldID がありません",
  copied: "{{label}}をコピーしました",
  copyFailed: "コピーできませんでした",
  timeUnknown: "日時不明",

  // ---- 拡大表示の操作 ----
  download: "ダウンロード",
  downloadImageAria: "画像をダウンロード",
  saveImageTitle: "この画像を端末に保存",
  more: "詳細",
  moreInfo: "画像の詳しい情報を見る",
  previous: "前へ ←",
  next: "次へ →",
  closeEsc: "閉じる Esc",
  close: "閉じる",
  imageNotReady: "画像の準備ができていません。しばらくしてからお試しください",
  downloadStarted: "ダウンロードを開始しました",

  // ---- 「詳細」パネル ----
  fileNameLabel: "ファイル名：",
  sizeLabel: "サイズ：",
  takenAtLabel: "撮影日時：",
  unknown: "不明",
  zoneLabel: "所属 Zone：",
  zoneNotDeclared: "（未設定）",
  zoneKeyHeld: "現在のセッションはこの Zone のキーを持っています",
  zoneKeyMissing: "現在のセッションはこの Zone のキーを持っていません",
  encryptionLabel: "暗号化方式：",
  encryptionUnknown: "未復号のため不明",
  encryptionCipher: "AES-256-GCM 暗号文",
  encryptionPlain: "平文オブジェクト（未暗号化）",
  uploadedKeyFpLabel: "アップロード時のキー指紋：",
  decryptKeyFpLabel: "今回の復号キー指紋：",
  fpNotRecorded: "（一覧に記録なし）",
  fpNotDecrypted: "（未復号）",
  fpMatch: "✓ 暗号化と復号は同じキーです",
  fpMismatch: "⚠️ 暗号化と復号で別のキーが使われています（一覧の記録と実際が一致しません）",
  plainWarning:
    "⚠️ これは平文オブジェクトです。暗号化されておらず、オブジェクトキーを知っている人は誰でも元の画像を取得できます",
  objectKeyLabel: "OSS オブジェクトキー：",
  relPathLabel: "相対パス：",
  none: "（なし）",
  notRecorded: "（未記録）",

  // ---- 写真の削除（管理者）----
  deleteAria: "写真を削除",
  deleteTitle: "この写真を削除（元に戻せません）",
  delete: "削除",
  deletePartialTitle: "削除が完了しませんでした",
  deleteConfirmTitle: "この写真を削除しますか？",
  deleteWarning:
    "OSS 上の暗号文ファイルも同時に削除されます。<strong>削除すると元に戻せません</strong>（バケットでバージョニングを有効にしていません）。ほかに必要としている場所がないか確認してください。",
  deleting: "削除中…",
  confirmDelete: "削除する",
  cancel: "キャンセル",
  deletedGone: "この写真は削除しました（暗号文はすでに存在していませんでした）",
  deleted: "この写真を削除しました",
  errDeleteNeedsOssConfig:
    "削除リクエストに署名するには、先に「アルバム管理」ページで OSS アップロード設定を保存してください。",

  // ---- 所属 Zone の変更（管理者）----
  changeZone: "Zone を変更",
  changeZoneTitle: "この写真の所属 Zone を変更",
  changeZoneAria: "所属 Zone を変更",
  zoneDialogTitle: "この写真を別の Zone に移動",
  zonePartialTitle: "移動は完了しましたが、古いファイルが残っています",
  zoneCurrentLabel: "現在の Zone：",
  zoneNotRecorded: "（記録なし）",
  zoneStatusLabel: "現在の状態：",
  zoneStatusEncrypted: "暗号化済み",
  zoneStatusPlain: "未暗号化（今回まとめて暗号化します）",
  zoneNoSourceKey:
    "キーファイルに「{{zone}}」のキーがないため、この写真を開けず、移動できません。この Zone を含むキーファイルを使ってください。",
  zoneNoTargetOptions:
    "キーファイルに移動先となる別の Zone がありません。先に「アルバム管理 → Zone の作成と管理」で新しく作成してください。",
  zoneSelectLabel: "移動先の Zone",
  zoneSelectAria: "移動先 Zone",
  zoneSelectPlaceholder: "選択してください",
  zoneSelectRequired: "移動先の Zone を選んでください",
  zoneProcessNote:
    "写真の中身は変わりません。手順は、この写真を取得 → 現在のキーで復号 → 新しい Zone のキーで再暗号化 → 新しいファイルとしてアップロード → アルバムの参照先を切り替え → 古いファイルを削除、という流れです。元のサイズのまま一度ダウンロードとアップロードを行うため、大きな画像は少し時間がかかります。",
  zoneChanging: "移動中…",
  zoneConfirm: "移動する",
  errZoneNeedsOssConfig:
    "移動リクエストに署名するには、先に「アルバム管理」ページで OSS アップロード設定を保存してください。",
  zoneMovedEncrypted: "暗号化して Zone「{{zone}}」に移動しました",
  zoneMoved: "Zone「{{zone}}」に変更しました",

  // ---- 画像の取得失敗（コンソールのみ、画面には出ません）----
  errSignUrl: "署名付き URL を取得できませんでした",
  errNoObjectKey: "読み取れるオブジェクトキーがありません",
  errNoZoneKey: "Zone「{{zone}}」の復号キーがありません",
  errNoNonce: "暗号文リソースに nonceB64 がありません",
  errCipherUrl: "暗号文の一時 URL を取得できませんでした",
  errImageRequest: "画像の取得に失敗しました：HTTP {{status}}",
  errCipherRequest: "暗号文の取得に失敗しました：HTTP {{status}}",
};

export default album;

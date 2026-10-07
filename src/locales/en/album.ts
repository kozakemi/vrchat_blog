/** 相册页（src/pages/Album.tsx）的英文文案。key 必须与 zh/album.ts、ja/album.ts 完全一致。 */
const album = {
  // ---- Top navigation and view switch ----
  back: "Back",
  title: "Album",
  adminLink: "Admin",
  aboutLink: "About",
  byTime: "By time",
  byWorld: "By world",

  // ---- Zone display switches (on-screen filtering only) ----
  showZone: "Show Zone",
  zoneEmpty: "No photos in this Zone yet",
  photosCount: "Photos: {{count}}",
  showAllHidden: "Hidden: {{count}} · Show all",

  // ---- Loading and failure to open ----
  loading: "Loading the album…",
  loadFailedTitle: "The album cannot be opened right now. Please try again later.",
  loadFailedHint: "If this keeps happening, please contact the site owner.",
  technicalDetail: "Technical details",

  // ---- Counts and empty states ----
  totalCount: "Photos: <strong>{{count}}</strong>",
  hiddenByZoneNote: "({{count}} more hidden by the Zone switches above)",
  hiddenByPermissionNote: "({{count}} more outside this account's permissions)",
  emptyAllHidden:
    "These photos are hidden by the Zone switches above. Press “Show all” to see them.",
  emptyNoPermission: "These photos are outside this account's permissions.",
  emptyNoPhotos:
    "No photos in the album yet. They will appear automatically once an admin uploads them.",

  // ---- World (VRChat world) ----
  worldUnknown: "Unknown world",
  worldUnknownPending: "Unknown world / not set",
  worldIdEmpty: "WorldID is empty (not set)",
  latestAt: "Latest: {{time}}",

  // ---- Copy and toasts ----
  copyWorldTitle: "Click to copy the world name/ID",
  copyWorldNameTitle: "Click to copy the world name",
  copyWorldIdTitle: "Click to copy the WorldID",
  worldNameLabel: "World name",
  noWorldInfo: "No world info to copy",
  noWorldName: "No world name to copy",
  noWorldId: "No WorldID to copy",
  copied: "Copied: {{label}}",
  copyFailed: "Copy failed",
  timeUnknown: "Time unknown",

  // ---- Large view controls ----
  download: "Download",
  downloadImageAria: "Download image",
  saveImageTitle: "Save this image to your device",
  more: "More",
  moreInfo: "Show more image info",
  previous: "← Prev",
  next: "Next →",
  closeEsc: "Close Esc",
  close: "Close",
  imageNotReady: "The image is not ready yet. Please try again later",
  downloadStarted: "Download started",

  // ---- “More” panel ----
  fileNameLabel: "File name:",
  sizeLabel: "Size:",
  takenAtLabel: "Taken at:",
  unknown: "Unknown",
  zoneLabel: "Zone:",
  zoneNotDeclared: "(not set)",
  zoneKeyHeld: "This session holds the key for this Zone",
  zoneKeyMissing: "This session does not hold the key for this Zone",
  encryptionLabel: "Encryption:",
  encryptionUnknown: "Not decrypted yet — unknown",
  encryptionCipher: "AES-256-GCM ciphertext",
  encryptionPlain: "Plain object (not encrypted)",
  uploadedKeyFpLabel: "Key fingerprint at upload:",
  decryptKeyFpLabel: "Key fingerprint used to decrypt:",
  fpNotRecorded: "(not recorded in the manifest)",
  fpNotDecrypted: "(not decrypted)",
  fpMatch: "✓ The same key was used to encrypt and decrypt",
  fpMismatch:
    "⚠️ Encrypt and decrypt used different keys (the manifest does not match reality)",
  plainWarning:
    "⚠️ This is a plain object: it is not encrypted, so anyone who knows the object key can fetch the original image",
  objectKeyLabel: "OSS object key:",
  relPathLabel: "Relative path:",
  none: "(none)",
  notRecorded: "(not recorded)",

  // ---- Delete photo (admin) ----
  deleteAria: "Delete photo",
  deleteTitle: "Delete this photo (cannot be undone)",
  delete: "Delete",
  deletePartialTitle: "Delete did not fully complete",
  deleteConfirmTitle: "Delete this photo?",
  deleteWarning:
    "The ciphertext file on OSS is deleted as well. <strong>This cannot be undone</strong> (versioning is not enabled on the bucket). Please make sure nothing else needs it.",
  deleting: "Deleting…",
  confirmDelete: "Delete",
  cancel: "Cancel",
  deletedGone: "Photo deleted (the ciphertext file was already gone)",
  deleted: "Photo deleted",
  errDeleteNeedsOssConfig:
    "Save the OSS upload settings on the “Album admin” page first, so the delete request can be signed.",

  // ---- Change the owning Zone (admin) ----
  changeZone: "Change Zone",
  changeZoneTitle: "Move this photo to another Zone",
  changeZoneAria: "Change the owning Zone",
  zoneDialogTitle: "Move this photo to another Zone",
  zonePartialTitle: "Moved, but the old file was not deleted",
  zoneCurrentLabel: "Current Zone:",
  zoneNotRecorded: "(not recorded)",
  zoneStatusLabel: "Current state:",
  zoneStatusEncrypted: "Encrypted",
  zoneStatusPlain: "Not encrypted (it will be encrypted during this move)",
  zoneNoSourceKey:
    "Your key file has no key for “{{zone}}”, so this photo cannot be opened and cannot be moved. Please use a key file that includes this Zone.",
  zoneNoTargetOptions:
    "Your key file has no other Zone to move to. Create one first under “Album admin → Create and manage Zones”.",
  zoneSelectLabel: "Move to which Zone",
  zoneSelectAria: "Target Zone",
  zoneSelectPlaceholder: "Please choose",
  zoneSelectRequired: "Please choose which Zone to move to",
  zoneProcessNote:
    "The photo itself is not changed. The steps are: fetch this photo → decrypt with the current key → re-encrypt with the new Zone key → upload as a new file → point the album at it → delete the old file. It is downloaded and uploaded once at full size, so large images take a while.",
  zoneChanging: "Moving…",
  zoneConfirm: "Move",
  errZoneNeedsOssConfig:
    "Save the OSS upload settings on the “Album admin” page first, so the move request can be signed.",
  zoneMovedEncrypted: "Encrypted and moved into Zone “{{zone}}”",
  zoneMoved: "Changed to Zone “{{zone}}”",

  // ---- Image fetch failures (console only, never shown in the UI) ----
  errSignUrl: "Could not get a signed URL",
  errNoObjectKey: "No readable object key",
  errNoZoneKey: "No decryption key for Zone “{{zone}}”",
  errNoNonce: "The ciphertext object has no nonceB64",
  errCipherUrl: "Could not get a temporary URL for the ciphertext",
  errImageRequest: "Image request failed: HTTP {{status}}",
  errCipherRequest: "Ciphertext request failed: HTTP {{status}}",
};

export default album;

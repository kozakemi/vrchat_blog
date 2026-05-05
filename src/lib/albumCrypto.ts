/** 与《相册加密方案-实现文档》一致的 AAD 字段顺序 */

export function buildAadJson(zoneId: string, assetId: string, mime: string): string {
  return JSON.stringify({ v: 1, zoneId, assetId, mime });
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function generateZoneKeyB64(): string {
  const k = new Uint8Array(32);
  crypto.getRandomValues(k);
  return bytesToBase64(k);
}

export async function importAesGcmKey(keyB64: string, usages: KeyUsage[]): Promise<CryptoKey> {
  const raw = base64ToBytes(keyB64);
  if (raw.byteLength !== 32) throw new Error("AES-256 密钥须为 32 字节");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, usages);
}

export type EncryptManifestParts = {
  nonceB64: string;
  cipherBytes: Uint8Array;
  aadJson: string;
};

export async function encryptPlaintextToParts(
  plaintext: ArrayBuffer,
  zoneId: string,
  assetId: string,
  mime: string,
  keyB64: string,
): Promise<EncryptManifestParts> {
  const key = await importAesGcmKey(keyB64, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aadJson = buildAadJson(zoneId, assetId, mime);
  const aadBuf = new TextEncoder().encode(aadJson);
  const cipherBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aadBuf },
    key,
    plaintext,
  );
  return {
    nonceB64: bytesToBase64(iv),
    cipherBytes: new Uint8Array(cipherBuf),
    aadJson,
  };
}

export function newAssetId(): string {
  return `a_${crypto.randomUUID().replace(/-/g, "")}`;
}

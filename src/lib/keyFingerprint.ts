/**
 * 密钥指纹：取密钥原始字节 SHA-256 的前 4 字节（8 个十六进制字符）。
 *
 * 用途只有一个 —— 让人一眼看出"这次解密用的密钥"和"上传时用的密钥"
 * 是不是同一把。AES-GCM 是带认证的加密，能解出来就等价于数学上证明
 * 加密用的就是这把密钥，所以这个指纹只是把这件事**显示出来**，便于排查。
 *
 * 泄露面：它是 256 位密钥的 32 位截断摘要，无法反推密钥；即使拿到指纹，
 * 攻击者仍需穷举 2^256 的密钥空间。可以安全地写进清单。
 */
export async function keyFingerprintB64(keyB64: string): Promise<string> {
  const bin = atob(keyB64.trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest).slice(0, 4)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

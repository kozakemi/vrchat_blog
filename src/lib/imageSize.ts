/**
 * 从图片文件头读取像素尺寸。
 *
 * 为什么需要它：管理页上传时并不把 width/height 写进清单，所以加密照片的尺寸
 * 在列表里一直显示"未知"。相册本来就会把整张图下载并解密到内存，因此读文件头
 * 几乎没有额外成本，而且能顺带修好已有数据（不必重新上传）。
 *
 * 只读文件头，不解码整张图；不认识的格式返回 null，由调用方显示"未知"。
 */

export function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

export function readImageSize(bytes: Uint8Array): { width: number; height: number } | null {
  // PNG：IHDR 紧随 8 字节签名
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  ) {
    return { width: readU32BE(bytes, 16), height: readU32BE(bytes, 20) };
  }

  // GIF：逻辑屏幕描述符，小端
  if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) };
  }

  // JPEG：逐段找 SOFn（SOF0-SOF15，排除 DHT/JPG/DAC）
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let o = 2;
    while (o + 9 < bytes.length) {
      if (bytes[o] !== 0xff) {
        o++;
        continue;
      }
      const marker = bytes[o + 1];
      // 填充字节与无长度字段的标记
      if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        o += 2;
        continue;
      }
      const segLen = (bytes[o + 2] << 8) | bytes[o + 3];
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        return {
          width: (bytes[o + 7] << 8) | bytes[o + 8],
          height: (bytes[o + 5] << 8) | bytes[o + 6],
        };
      }
      o += 2 + segLen;
    }
    return null;
  }

  // WebP：RIFF 容器，按 VP8X / VP8 / VP8L 三种子格式分别解析
  if (
    bytes.length >= 30 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    const fourcc = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (fourcc === "VP8X") {
      return {
        width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
        height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
      };
    }
    if (fourcc === "VP8 ") {
      return {
        width: (bytes[26] | (bytes[27] << 8)) & 0x3fff,
        height: (bytes[28] | (bytes[29] << 8)) & 0x3fff,
      };
    }
    if (fourcc === "VP8L") {
      const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }

  return null;
}

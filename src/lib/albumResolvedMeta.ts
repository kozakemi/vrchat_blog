/**
 * 解密/下载后从明文字节解析出的元数据，以及它与已有记录的合并规则。
 *
 * 为什么单独抽成模块：合并逻辑此前内联在 React 组件里，用
 * `{ takenAt, world }` **重建**对象，把 width/height/encrypted/decryptKeyFp
 * 全部丢掉，于是"尺寸"和"本次解密密钥指纹"在界面上永远显示未知——
 * 功能其实跑通了，只是结果被扔了。这个坑已经踩过两次，所以把合并抽成
 * 纯函数并加上测试，避免再犯第三次。
 */

export type AssetResolvedMetadata = {
  takenAt?: string;
  /** 从明文字节里读出的真实像素尺寸：清单里没有时靠它补上 */
  width?: number;
  height?: number;
  /** 这条资源是否为密文（false = 明文对象，没有加密） */
  encrypted?: boolean;
  /** 实际成功解密所用的密钥指纹，用于与清单记录的上传时指纹比对 */
  decryptKeyFp?: string;
  world?: {
    worldId?: string | null;
    worldName?: string | null;
  };
};

/**
 * 把一次新的解析结果合并到已有记录上：**逐字段**合并，新值优先，缺省沿用旧值。
 * 注意 `takenAt` 用 `||`（空串视为无值），其余用 `??`（只跳过 null/undefined）。
 */
export function mergeResolvedMetadata(
  cur: AssetResolvedMetadata | undefined,
  meta: AssetResolvedMetadata,
): AssetResolvedMetadata {
  return {
    takenAt: meta.takenAt || cur?.takenAt,
    width: meta.width ?? cur?.width,
    height: meta.height ?? cur?.height,
    encrypted: meta.encrypted ?? cur?.encrypted,
    decryptKeyFp: meta.decryptKeyFp ?? cur?.decryptKeyFp,
    world: {
      worldId: meta.world?.worldId ?? cur?.world?.worldId ?? null,
      worldName: meta.world?.worldName ?? cur?.world?.worldName ?? null,
    },
  };
}

/** 两个解析结果是否等价：用于避免无意义的 state 更新与重渲染 */
export function resolvedMetadataEquals(
  a: AssetResolvedMetadata | undefined,
  b: AssetResolvedMetadata,
): boolean {
  return (
    a?.takenAt === b.takenAt &&
    a?.width === b.width &&
    a?.height === b.height &&
    a?.encrypted === b.encrypted &&
    a?.decryptKeyFp === b.decryptKeyFp &&
    a?.world?.worldId === b.world?.worldId &&
    a?.world?.worldName === b.world?.worldName
  );
}

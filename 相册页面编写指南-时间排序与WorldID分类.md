# 相册页面编写指南：按时间排序 & 按 WorldID 分类

本文档指导你在本项目（React + Vite + TS）中实现相册页面的结构与逻辑。相册提供两种展示/排序方式：

1. **按照片时间（takenAt）排序**：时间线/瀑布流/网格
2. **按拍照世界（WorldID）分类**：先分组（worldId），组内再按时间排序

> 假设：相册数据来自 `manifest.json`（由创建工具生成，字段可参考《相册图片可解析数据与解析方式》）。  
> 约定：当图片缺失 XMP 时：  
> - `takenAt` 使用文件时间兜底  
> - `worldId` 为空（归入“未知世界/待填写”组）

---

## 1. 相册数据模型建议（Manifest）

### 1.1 关键字段（最小可用）
```ts
export type AlbumAsset = {
  assetId: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;

  takenAt: string; // ISO8601

  world?: {
    worldId?: string | null;
    worldName?: string | null;
  };

  author?: string | null;

  // 若启用加密（AES-256-GCM），这里还会有 zoneId/nonce/cipherFile/aad 等字段
  zoneId?: string;
  nonceB64?: string;
  cipherFile?: string;
  aad?: unknown;
};
```

### 1.2 Manifest 顶层建议
```ts
export type AlbumManifest = {
  schemaVersion: number;
  generatedAt: string;
  assetsBasePath: string; // 例如 "/albums/assets/"
  assets: AlbumAsset[];
};
```

---

## 2. 页面信息架构（IA）与交互建议

### 2.1 路由建议
- `/album`：相册主页面（包含模式切换）
- 可选：
  - `/album/photo/:assetId`：单张详情页（支持上一张/下一张）
  - `/album/world/:worldId`：世界分组详情页（与分类模式联动）

### 2.2 相册主页面组件拆分
建议组件结构：
```
pages/
  Album.tsx
components/album/
  AlbumToolbar.tsx        # 模式切换、搜索、过滤、排序控制
  AlbumGrid.tsx           # 时间模式：网格/瀑布流
  AlbumWorldGroups.tsx    # 世界模式：分组列表
  AlbumCard.tsx           # 单张卡片（缩略图+信息）
  AlbumLightbox.tsx       # 详情弹窗/查看器（可选）
```

### 2.3 两种模式切换（Toolbar）
工具栏提供：
- 展示模式：`时间` / `世界`
- 可选：搜索（按世界名/作者/备注）、过滤（zone、世界、日期范围）

建议用 Zustand 保存 UI 状态：
- `viewMode: "time" | "world"`
- `selectedWorldId?: string`
- `query?: string`

---

## 3. 模式 A：按时间排序（takenAt）

### 3.1 排序规则（推荐）
1. `takenAt` 解析成时间戳（`Date.parse`）
2. 时间无效时（极端情况）放到最后
3. 默认：新到旧（descending），也可提供旧到新

伪代码：
```ts
function toTs(iso: string) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : -Infinity;
}

const sorted = [...assets].sort((a, b) => toTs(b.takenAt) - toTs(a.takenAt));
```

### 3.2 展示建议
- 网格（推荐 MVP）：每行 2~6 张自适应
- 瀑布流（进阶）：图片比例不一时更美观
- 可选：按日期分段（2026-03、2026-02…）

### 3.3 性能建议（重要）
相册可能有大量图片，建议：
- 缩略图策略：优先生成 thumbnails（后续可加）
- 懒加载：`loading="lazy"` + `IntersectionObserver`
- 虚拟列表（大量时）：`react-virtual` 或同类库

---

## 4. 模式 B：按 WorldID 分类（分组显示）

### 4.1 分组规则
分组 key：`worldId`
- `worldId` 有值 → `worldId` 组
- `worldId` 为空 → 归入 `unknown` 组（显示名“未知世界 / 待填写”）

建议保留世界显示名：
- `worldName`（如存在）用于 UI 标题
- 若 `worldName` 缺失但 `worldId` 存在：标题显示 `worldId`

### 4.2 组内排序规则
同时间模式一致（按 `takenAt` 排序）。

### 4.3 分组排序规则（推荐）
两种常用方式，建议默认 A：
- A. **按该世界“最新一张照片时间”降序**（更符合浏览习惯）
- B. 按世界名/世界 ID 字典序

伪代码（按世界最新时间）：
```ts
type Group = {
  worldId: string; // "unknown" or wrld_xxx
  worldName?: string;
  latestTs: number;
  items: AlbumAsset[];
};

function groupByWorld(assets: AlbumAsset[]): Group[] {
  const map = new Map<string, Group>();
  for (const a of assets) {
    const id = a.world?.worldId || "unknown";
    const name = a.world?.worldName || (id === "unknown" ? "未知世界 / 待填写" : id);
    const ts = Date.parse(a.takenAt);

    const g = map.get(id) ?? { worldId: id, worldName: name, latestTs: -Infinity, items: [] };
    g.items.push(a);
    if (Number.isFinite(ts)) g.latestTs = Math.max(g.latestTs, ts);
    map.set(id, g);
  }
  for (const g of map.values()) {
    g.items.sort((a, b) => Date.parse(b.takenAt) - Date.parse(a.takenAt));
  }
  return [...map.values()].sort((a, b) => b.latestTs - a.latestTs);
}
```

### 4.4 展示建议
世界模式的 UI 建议是“分组折叠列表”：
- 组头：世界名 + 照片数量 + 最新时间
- 组内容：网格缩略图（可折叠/展开）

可选增强：
- 点击组头进入 `/album/world/:worldId` 详情页

---

## 5. 与加密相册（Zone）方案的衔接

若你启用了《相册加密方案（AES-256-GCM + Zone）》：

### 5.1 过滤可见资源
在加载 manifest 后，先根据 key file 中的 zone keys 做过滤：
- 资源 `zoneId` 不在用户 key file 中 → 不显示（或显示锁定占位）

### 5.2 解密缩略图/原图
渲染阶段：
1. fetch 密文（`cipherFile`）
2. 用 `zoneId` 对应的 key + `nonceB64` + `aad` 解密
3. `Blob` → `ObjectURL` → `<img src=...>`

建议缓存：
- `Map<assetId, objectUrl>`，避免滚动时重复解密
- 页面卸载时 `URL.revokeObjectURL`

---

## 6. 错误处理与“缺字段”策略（务必做）

### 6.1 时间缺失/无效
兜底顺序建议：
1. `takenAt`（manifest 写入时已兜底）
2. 若仍无效：放到列表末尾，并显示“时间未知”

### 6.2 世界信息缺失
`worldId` 为空：
- 世界模式：统一进入 `unknown` 组
- 时间模式：卡片副标题显示“世界未知”

### 6.3 解密失败
可能原因：
- key file 不包含对应 zone
- nonce/aad 不匹配
- 密文损坏

UI 行为建议：
- 在卡片上显示“无法解密/无权限”
- 点击时弹出错误详情（可复制错误码）

---

## 7. MVP 实现步骤（推荐顺序）

1. 新增路由与页面：`/album`
2. 加载 `manifest.json` 并渲染时间模式（不加密也可先跑通）
3. 增加模式切换：时间 / 世界
4. 实现世界分组逻辑与 UI
5. 接入加密：导入 key file → 过滤 zone → 解密显示
6. 做性能优化：懒加载、缓存 objectUrl、必要时上虚拟列表

---

## 8. 验收清单（对照完成度）
- [ ] 时间模式：按 `takenAt` 正确排序，UI 能正常浏览
- [ ] 世界模式：按 `worldId` 分组，`unknown` 组正常工作
- [ ] 组内仍按时间排序
- [ ] 模式切换不会丢失滚动/状态（可选）
- [ ] 缺 XMP 的图：时间有兜底，世界为空不报错
- [ ]（如启用加密）无权限/解密失败有清晰提示

import type { KeyFileZoneV1 } from "@/lib/keyFile";
import {
  readJsonFromLocalStorage,
  writeJsonToLocalStorage,
} from "@/lib/localStore";

/**
 * 「某个 Zone 的图片要不要显示」——**纯界面开关，不是权限**。
 *
 * ============================================================================
 * 它永远不能让看不到的东西变得可见
 * ============================================================================
 * 判定链是固定的两层，顺序不可颠倒：
 *
 *   1. `filterAccessibleAssets`（albumAccess）——当前会话是否**持有该 Zone 的密钥**，唯一的权限判定；
 *   2. `applyZoneVisibility`（本模块）——在有权的集合里再按勾选**筛掉**一部分。
 *
 * 第二层只能是"筛掉"，因为它默认全部可见（`!== false`）。任何把这两层合并、
 * 或让勾选状态参与"能不能解密"的想法，都会把界面开关变成权限开关，那是错的。
 *
 * ============================================================================
 * 存哪里、按什么隔离
 * ============================================================================
 * 存在 localStorage（用户选了"记住"），按 **作用域** 分开：用户名 + 该密钥文件里的
 * Zone 集合。这样换用户、或换一份 Zone 集合不同的密钥文件都会得到新作用域，
 * 不会把上一个人的隐藏设置带过去。
 *
 * 代价是：密钥文件里增删 Zone 会让该作用域的勾选回到"全部显示"。这是刻意的——
 * 回到安全的默认值，比让一个来路不明的 false 静默生效要好。
 *
 * 作用域字符串里**不含任何密钥字节**：它只是为了区分不同的密钥文件，没必要把
 * keyB64 再往 localStorage 里抄一份。
 */

export type ZoneVisibility = Record<string, boolean>;

export const ZONE_VISIBILITY_STORAGE_KEY = "td_zone_visibility_v1";

/** 最多保留多少个作用域：单机浏览器不会有太多密钥文件，超出就丢最旧的 */
const MAX_SCOPES = 8;

type StoredShape = Record<string, ZoneVisibility>;

/** 存储作用域：用户名 + 排序后的 Zone id，不含密钥 */
export function zoneVisibilityScope(
  username: string | undefined,
  zones: KeyFileZoneV1[] | undefined,
): string {
  const ids = (zones ?? []).map((z) => z.zoneId).sort();
  return `${username ?? ""}|${ids.join(",")}`;
}

function readStore(): StoredShape {
  const parsed = readJsonFromLocalStorage<unknown>(ZONE_VISIBILITY_STORAGE_KEY);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: StoredShape = {};
  for (const [scope, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const vis: ZoneVisibility = {};
    for (const [zoneId, flag] of Object.entries(value as Record<string, unknown>)) {
      if (typeof flag === "boolean") vis[zoneId] = flag;
    }
    out[scope] = vis;
  }
  return out;
}

function writeStore(store: StoredShape): void {
  const keys = Object.keys(store);
  const trimmed: StoredShape =
    keys.length > MAX_SCOPES
      ? Object.fromEntries(keys.slice(keys.length - MAX_SCOPES).map((k) => [k, store[k]]))
      : store;
  writeJsonToLocalStorage(ZONE_VISIBILITY_STORAGE_KEY, trimmed);
}

/**
 * 读取某作用域下的可见性。
 * 只保留**当前确实持有**的 Zone，因此存储里残留的陌生 zoneId 不会影响任何东西。
 */
export function loadZoneVisibility(
  scope: string,
  zones: KeyFileZoneV1[] | undefined,
): ZoneVisibility {
  const stored = readStore()[scope];
  const out: ZoneVisibility = {};
  for (const z of zones ?? []) {
    out[z.zoneId] = stored?.[z.zoneId] !== false;
  }
  return out;
}

export function saveZoneVisibility(scope: string, visibility: ZoneVisibility): void {
  const store = readStore();
  store[scope] = visibility;
  writeStore(store);
}

/** 忘掉该作用域的勾选（"全部显示"用它，比写一堆 true 干净） */
export function clearZoneVisibility(scope: string): void {
  const store = readStore();
  if (!(scope in store)) return;
  delete store[scope];
  writeStore(store);
}

/**
 * 单条资源是否应当显示。
 *
 * - 没有声明 `zoneId` 的老条目：不属于任何 Zone，**不受开关控制**，始终显示；
 * - 其余：默认可见，**只有被显式关掉（false）才隐藏**。
 */
export function isZoneVisible(
  visibility: ZoneVisibility,
  zoneId: string | null | undefined,
): boolean {
  const id = zoneId?.trim() ?? "";
  if (!id) return true;
  return visibility[id] !== false;
}

/**
 * 在"有权查看"之后按 Zone 开关再筛一层。
 *
 * ⚠️ 调用方必须先过 `filterAccessibleAssets`。本函数只做减法：
 * 它不知道也不关心权限，默认全通过，因此不可能把无权资源放出来。
 */
export function applyZoneVisibility<T extends { zoneId?: string | null }>(
  assets: T[],
  visibility: ZoneVisibility,
): T[] {
  return assets.filter((a) => isZoneVisible(visibility, a.zoneId));
}

/** 统计每个 Zone 有多少条资源（界面据此决定显示哪些开关、以及各显示多少张） */
export function countAssetsByZone<T extends { zoneId?: string | null }>(
  assets: T[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const a of assets) {
    const id = a.zoneId?.trim() ?? "";
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

export type ZoneFilterOption = {
  zoneId: string;
  comment?: string;
  /** 该 Zone 下当前会话有权查看的资源数（按**鉴权后**的集合统计，与开关无关） */
  count: number;
  /** 当前是否勾选显示 */
  visible: boolean;
};

/**
 * 界面要显示哪些 Zone 开关，以及各自的计数与勾选状态。
 *
 * **只列"确实有照片"的 Zone**：一个 0 张的 Zone，勾不勾都没有任何区别，
 * 列出来只会让人点了没反应、以为坏了。所以"密钥里有私密区、但还没往里放照片"时
 * 整排开关不显示——这是**刻意**的，等那个 Zone 有了照片，开关会自己出现。
 *
 * ⚠️ **计数必须取自"鉴权后"的集合，而且与勾选状态无关。**
 * 这是本函数唯一必须守住的不变量：若改用"勾选后"的集合统计，那么关掉一个 Zone
 * 之后它立刻变成 0 条 → 被下面的 count > 0 过滤掉 → 用户再也无法把它打开。
 *
 * （历史：曾为了"可发现性"改成按密钥文件持有的 Zone 全列出、含 0 张。
 * 实测下来"点了没反应的勾选框"比"暂时不出现"更让人困惑，已改回按照片数过滤。）
 */
export function buildZoneFilterOptions(
  zones: KeyFileZoneV1[] | undefined,
  accessibleAssets: { zoneId?: string | null }[],
  visibility: ZoneVisibility,
): ZoneFilterOption[] {
  const counts = countAssetsByZone(accessibleAssets);
  return (zones ?? [])
    .map((z) => ({
      zoneId: z.zoneId,
      ...(z.comment ? { comment: z.comment } : {}),
      count: counts.get(z.zoneId) ?? 0,
      visible: visibility[z.zoneId] !== false,
    }))
    .filter((z) => z.count > 0);
}

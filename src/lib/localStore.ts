/**
 * localStorage 的可用性探测与安全读写。
 *
 * Safari 隐私模式、浏览器「阻止所有 Cookie」、企业策略等情况下，`localStorage`
 * 对象**存在**但 `setItem` 会抛错；直接使用会静默失败（表现为「每次刷新都要重新登录」
 * 或「设置记不住」），而且没有任何提示。所以统一在这里探测一次，再把结果暴露给界面。
 *
 * 这里刻意用**裸 `localStorage`** 而不是 `window.localStorage`：在 SSR / Node 测试里
 * `typeof localStorage === "undefined"` 可以安全地判定"没有"，而读 `window.localStorage`
 * 会直接抛 ReferenceError。
 */

export function detectLocalStorage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const probe = "__td_ls_probe__";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

export function isLocalStorageAvailable(): boolean {
  return detectLocalStorage() !== null;
}

/**
 * 读取并 JSON.parse。
 * 不可用、键不存在、内容损坏、类型不符 —— 一律返回 null，由调用方给默认值，
 * 绝不让一份写坏的历史数据把页面打崩。
 */
export function readJsonFromLocalStorage<T>(key: string): T | null {
  const ls = detectLocalStorage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** 写入 JSON；不可用或写失败时静默放弃并返回 false（记不住不影响功能本身） */
export function writeJsonToLocalStorage(key: string, value: unknown): boolean {
  const ls = detectLocalStorage();
  if (!ls) return false;
  try {
    ls.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

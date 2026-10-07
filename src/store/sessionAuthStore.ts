import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { KeyFileZoneV1 } from "@/lib/keyFile";

export type KeySessionState = {
  username: string;
  zones: KeyFileZoneV1[];
  roles: string[];
  isAdmin: boolean;
};

type SessionAuthStore = {
  keySession: KeySessionState | null;
  setKeySession: (session: KeySessionState | null) => void;
};

/** 登录态在 localStorage 中的键名：刷新页面、重开浏览器都不应掉登录 */
export const SESSION_STORAGE_KEY = "td_key_session_v1";

/**
 * 探测 localStorage 是否**真的可写**。
 *
 * Safari 隐私模式、浏览器"阻止所有 Cookie"、企业策略等情况下，
 * `localStorage` 存在但 `setItem` 会抛错；此时若直接交给 persist，
 * 它会静默失败 —— 表现为"每次刷新都要重新登录"，而且没有任何提示。
 * 所以这里先探测，再把结果暴露给界面，让使用者知道原因。
 */
function detectLocalStorage(): Storage | null {
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

/** localStorage 不可用时使用的空实现：让会话退回"仅内存"，并且不抛错 */
const noopStorage: StateStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

/** 当前环境能否持久化登录态；界面据此提示使用者 */
export function isSessionPersistenceAvailable(): boolean {
  return detectLocalStorage() !== null;
}

function isValidZone(z: unknown): z is KeyFileZoneV1 {
  if (!z || typeof z !== "object") return false;
  const o = z as Record<string, unknown>;
  return typeof o.zoneId === "string" && typeof o.keyB64 === "string" && o.keyB64.length > 0;
}

/**
 * 校验从 localStorage 读回的登录态。
 * 数据结构变更、手动改坏、或用旧版本写入的数据都不应让页面崩在 `keySession.zones` 上——
 * 校验不过就当未登录处理，用户重新导入密钥即可。
 */
function sanitizeKeySession(value: unknown): KeySessionState | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (typeof o.username !== "string" || !o.username.trim()) return null;
  if (!Array.isArray(o.zones) || !o.zones.every(isValidZone)) return null;
  return {
    username: o.username,
    zones: o.zones as KeyFileZoneV1[],
    roles: Array.isArray(o.roles) ? o.roles.filter((r): r is string => typeof r === "string") : [],
    isAdmin: o.isAdmin === true,
  };
}

export const useSessionAuthStore = create<SessionAuthStore>()(
  persist(
    (set) => ({
      keySession: null,
      setKeySession: (session) => set({ keySession: session }),
    }),
    {
      name: SESSION_STORAGE_KEY,
      storage: createJSONStorage(() => detectLocalStorage() ?? noopStorage),
      partialize: (state) => ({ keySession: state.keySession }),
      merge: (persisted, current) => ({
        ...current,
        keySession: sanitizeKeySession(
          (persisted as { keySession?: unknown } | undefined)?.keySession,
        ),
      }),
    },
  ),
);

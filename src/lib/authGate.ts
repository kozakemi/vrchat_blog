export const STORAGE_AUTH_MODE_KEY = "td_auth_mode";
export const STORAGE_GUEST_NICKNAME_KEY = "td_guest_nickname";

/** 完成首页登录转场进入相册前写入；登出时清除 */
export const SESSION_ALBUM_GRANTED_KEY = "td_album_granted";

export function hasAlbumRouteAccess(): boolean {
  if (typeof window === "undefined") return false;
  return window.sessionStorage.getItem(SESSION_ALBUM_GRANTED_KEY) === "1";
}

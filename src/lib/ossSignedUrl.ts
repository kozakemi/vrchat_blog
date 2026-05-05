/** 与相册页签名 URL 规则一致，供 GET/PUT 共用 */
export function normalizeSignedUrl(value: string): string {
  let s = value.trim();
  if (
    (s.startsWith("`") && s.endsWith("`")) ||
    (s.startsWith("\"") && s.endsWith("\"")) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/^`/, "").replace(/`$/, "");
  if (s.startsWith("http://vrchat-png.oss-cn-beijing.aliyuncs.com/")) {
    s = s.replace("http://", "https://");
  }
  return s;
}

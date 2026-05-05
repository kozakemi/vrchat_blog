/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ALBUM_MANIFEST_URL?: string;
  /** OSS 上清单对象键，与 FC ?file= 一致；默认 albums/manifest.json */
  readonly VITE_ALBUM_MANIFEST_FILE?: string;
  /** 签名链为相对路径时拼到此前缀（默认 vrchat-png 外网域名）；图在其它 Bucket 且 FC 仍返回相对路径时需改 */
  readonly VITE_OSS_SIGNED_URL_ORIGIN?: string;
  readonly VITE_OSS_SIGN_ENDPOINT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

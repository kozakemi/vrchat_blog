/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ALBUM_MANIFEST_URL?: string;
  readonly VITE_OSS_SIGN_ENDPOINT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

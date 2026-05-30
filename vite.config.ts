import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from "vite-tsconfig-paths";
import { traeBadgePlugin } from 'vite-plugin-trae-solo-badge';

// https://vite.dev/config/
export default defineConfig({
  base: './',
  build: {
    sourcemap: 'hidden',
  },
  /** 开发时 OSS PUT/GET 经同源代理，路径 /dev-oss-proxy/<bucket-host>/... */
  server: {
    proxy: {
      "/dev-oss-proxy": {
        target: "https://vrchat-png.oss-cn-beijing.aliyuncs.com",
        changeOrigin: true,
        secure: true,
        router(req) {
          const path = req.url ?? "";
          const m = path.match(/^\/dev-oss-proxy\/([^/]+)/);
          if (m?.[1]) return `https://${m[1]}`;
          return "https://vrchat-png.oss-cn-beijing.aliyuncs.com";
        },
        rewrite: (path) => path.replace(/^\/dev-oss-proxy\/[^/]+/, "") || "/",
      },
    },
  },
  plugins: [
    react({
      babel: {
        plugins: [
          'react-dev-locator',
        ],
      },
    }),
    traeBadgePlugin({
      variant: 'dark',
      position: 'bottom-right',
      prodOnly: true,
      clickable: true,
      clickUrl: 'https://www.trae.ai/solo?showJoin=1',
      autoTheme: true,
      autoThemeTarget: '#root'
    }), 
    tsconfigPaths()
  ],
})

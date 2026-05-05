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
  /** 开发时 OSS 未配置 localhost CORS 会导致 PUT/OPTIONS 失败；经代理变为同源请求 */
  server: {
    proxy: {
      "/dev-oss-proxy/vrchat-png": {
        target: "https://vrchat-png.oss-cn-beijing.aliyuncs.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/dev-oss-proxy\/vrchat-png/, ""),
      },
      "/dev-oss-proxy/vrchat-img": {
        target: "https://vrchat-img.oss-cn-beijing.aliyuncs.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/dev-oss-proxy\/vrchat-img/, ""),
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

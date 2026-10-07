import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin, type UserConfig } from "vite";
import baseConfig from "./vite.config";

/**
 * 「本地预览」专用配置 —— 配合 `npm run local` 使用，用来看页面效果。
 *
 * 与正式配置的差别只有两点：
 *   1. 把 demo/ 挂到开发服务器上（见下面的插件），让相册有内容可看；
 *   2. 端口写死，方便把地址稳定地打印出来。
 *
 * OSS 代理等其余配置直接从 vite.config.ts 继承，避免两份配置各写一套逐渐走样。
 * 关掉函数计算签名服务是在 .env.demo 里做的（`vite --mode demo`）。
 */

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEMO_DIR = path.join(ROOT, "demo");

/** 固定端口：写死是为了让打印出来的地址稳定、可直接复制 */
export const DEMO_PORT = 5199;

/**
 * 把 demo/ **叠加**在正常的 public/ 之上：
 *
 *   /albums/manifest.json  → demo/manifest.json
 *   /demo/key.json         → demo/key.json
 *   /demo/<name>.png       → demo/images/<name>.png
 *
 * 刻意不把这些文件放进 public/：演示数据（尤其是那份演示密钥文件）不该被
 * 构建进线上产物——线上的清单在 OSS 上，跟这里毫无关系。
 */
function demoAssetsPlugin(): Plugin {
  return {
    name: "those-days:demo-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const urlPath = (req.url ?? "").split("?")[0];
        let file: string | null = null;
        let type = "application/octet-stream";

        if (urlPath === "/albums/manifest.json") {
          file = path.join(DEMO_DIR, "manifest.json");
          type = "application/json; charset=utf-8";
        } else if (urlPath === "/demo/key.json") {
          file = path.join(DEMO_DIR, "key.json");
          type = "application/json; charset=utf-8";
        } else if (urlPath.startsWith("/demo/") && urlPath.endsWith(".png")) {
          // path.basename 兜掉 ../ 之类的穿越尝试
          file = path.join(DEMO_DIR, "images", path.basename(urlPath));
          type = "image/png";
        }

        if (!file || !fs.existsSync(file)) return next();
        res.setHeader("Content-Type", type);
        res.setHeader("Cache-Control", "no-store");
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

const base = baseConfig as UserConfig;

export default defineConfig({
  ...base,
  plugins: [...(base.plugins ?? []), demoAssetsPlugin()],
  server: {
    ...base.server,
    port: DEMO_PORT,
    strictPort: false,
  },
});

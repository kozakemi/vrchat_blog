#!/usr/bin/env node
/**
 * 本地预览 —— 一条命令把站点跑起来，**用来看页面效果**。
 *
 *   npm run local
 *
 * 它做的事：
 *   1. 演示图片缺失就先生成（tools/make-demo-images.mjs，确定性的，所以不进 git）；
 *   2. 用 vite.config.demo.ts + `--mode demo` 起开发服务器；
 *   3. 把各个页面的地址和"怎么看到相册内容"打印出来。
 *
 * 为什么需要它，而不是直接 `npm run dev`：
 *   - 相册的清单和图片都在 OSS 上，且要经函数计算签名。本地不连阿里云时，
 *     相册页只会报错、什么都没有，根本看不出页面效果；
 *   - 所以 demo 模式关掉了签名服务（.env.demo 里 VITE_OSS_SIGN_ENDPOINT=off），
 *     清单改走同源直链，由 vite.config.demo.ts 挂到 demo/ 上；
 *   - 演示数据全是**明文占位图**（只用 `src` 字段，不走加密），因此不需要任何密钥、
 *     任何网络请求就能把网格、灯箱、「更多」面板填满。
 *
 * 演示模式**不能**上传 / 删除 / 改归属 Zone —— 那三件事都要真实 OSS 签名。
 * 按钮会照常显示（演示密钥文件带了 admin 角色），点了会给出明确报错。
 *
 * 参数：
 *   --no-images   不自动生成演示图片（用于你自己替换了几张的真图来看效果）
 */

import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_FILE = path.join(ROOT, "vite.config.demo.ts");

function line(char = "─") {
  return char.repeat(66);
}

function main() {
  if (!process.argv.includes("--no-images")) {
    const gen = spawnSync(process.execPath, [path.join(ROOT, "tools/make-demo-images.mjs")], {
      stdio: "inherit",
      cwd: ROOT,
    });
    if (gen.status !== 0) {
      console.warn("⚠️  演示图片生成失败，相册会是空的（不影响其他页面）。");
    }
  }

  return createServer({
    root: ROOT,
    configFile: CONFIG_FILE,
    // mode=demo → 加载 .env.demo（关掉函数计算签名服务）
    mode: "demo",
  });
}

const server = await main();
await server.listen();

const origin = (server.resolvedUrls?.local?.[0] ?? "http://localhost:5199/").replace(/\/+$/, "");
const keyFile = path.join(ROOT, "demo", "key.json");

console.log(`
${line("=")}
  本地预览已启动（演示数据，不连阿里云、不需要真密钥）
${line("=")}

  页面（可直接点开）：
    登录页    ${origin}/#/
    关于页    ${origin}/#/about
    相册页    ${origin}/#/album
    管理页    ${origin}/#/album-admin

  想看到相册里的照片，先去登录页登录——两种方式：
    ① 想要完整的 Zone 开关效果：选「密钥登录」，导入
         ${keyFile}
       （这个演示密钥带 admin 角色、含 public-v1 与 demo-vault-v1 两个区；
        也可以直接打开 ${origin}/demo/key.json 下载它）
    ② 只想随便进看看：选「注册」，填个昵称即可
       （但那样只有公开区，看不到 Zone 开关那排复选框）

  进相册后可以观察：
    · 顶部的「显示 Zone」复选框：勾掉 demo-vault-v1，三个世界分组会各少一张
    · 「按时间 / 按世界」两种视图
    · 点开大图 → 下载 / 改 Zone / 删除 / 更多（尺寸、Zone、密钥指纹）
    · 「更多」里的诊断信息与浏览器控制台的 [album] 图片诊断

  演示模式做不到的：
    上传 / 删除 / 改归属 Zone 需要真实的 OSS 签名，离线下一律报错（按钮仍可见）。
    要连线上测试，用 npm run dev + 管理页里的 OSS 配置。

  Ctrl+C 退出。
${line("=")}
`);

async function shutdown() {
  await server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

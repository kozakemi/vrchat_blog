#!/usr/bin/env node
/**
 * 将仓库根目录的 VRChat/ 复制到 dist/VRChat/
 *
 * 目的：GitHub Pages 部署只上传 dist/，而 VRChat/ 不在 public/ 下不会被 Vite 自动拷贝，
 * 导致相册图片在 Pages 上 404。该脚本作为 postbuild 执行，确保产物包含图片。
 */

import fs from "node:fs/promises";
import path from "node:path";

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const cwd = process.cwd();
  const src = path.resolve(cwd, "VRChat");
  const dist = path.resolve(cwd, "dist");
  const dst = path.resolve(dist, "VRChat");

  if (!(await exists(dist))) {
    console.error("未找到 dist/，请先运行构建。");
    process.exit(1);
  }

  if (!(await exists(src))) {
    console.warn("未找到 VRChat/，跳过复制。");
    return;
  }

  await fs.mkdir(dst, { recursive: true });

  // Node 20 支持 fs.cp
  await fs.cp(src, dst, { recursive: true });

  console.log(`已复制 VRChat/ -> ${path.relative(cwd, dst)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


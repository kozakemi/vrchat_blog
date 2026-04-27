#!/usr/bin/env node
/**
 * 生成相册 manifest.json（MVP）
 * - 扫描 VRChat/ 目录下图片（递归）
 * - 从 PNG XMP（iTXt/tEXt）提取：CreateDate / Author / WorldID / WorldDisplayName
 * - 当无 XMP 时：takenAt 使用文件时间兜底；world 留空
 *
 * 用法：
 *   node tools/album-manifest/generate-manifest.js \
 *     --in VRChat \
 *     --out public/albums/manifest.json \
 *     --src-prefix ./VRChat
 */

import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function parseArgs(argv) {
  const args = {
    inDir: "VRChat",
    outFile: "public/albums/manifest.json",
    srcPrefix: "./VRChat",
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--in") args.inDir = argv[++i];
    else if (a === "--out") args.outFile = argv[++i];
    else if (a === "--src-prefix") args.srcPrefix = argv[++i];
    else if (a === "-h" || a === "--help") args.help = true;
  }
  return args;
}

function usage() {
  return [
    "用法：",
    "  node tools/album-manifest/generate-manifest.js --in VRChat --out public/albums/manifest.json --src-prefix ./VRChat",
    "",
    "参数：",
    "  --in         输入目录（默认 VRChat）",
    "  --out        输出 manifest 路径（默认 public/albums/manifest.json）",
    "  --src-prefix 写入到 manifest.assets[].src 的前缀（默认 ./VRChat）",
  ].join("\n");
}

function isImageFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp";
}

async function walk(dirAbs) {
  const out = [];
  const entries = await fs.readdir(dirAbs, { withFileTypes: true });
  for (const ent of entries) {
    const abs = path.join(dirAbs, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await walk(abs)));
    } else if (ent.isFile() && isImageFile(abs)) {
      out.push(abs);
    }
  }
  return out;
}

function readU32BE(buf, offset) {
  return buf.readUInt32BE(offset);
}

function safeTextDecoder(bytes) {
  // VRChat XMP 看起来是 UTF-8；若遇到异常，replace
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function parsePngIhdr(buf) {
  if (buf.length < 8 + 8 + 13) return null;
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;

  // IHDR 作为第一个 chunk（通常是）
  const len = readU32BE(buf, 8);
  const type = buf.subarray(12, 16).toString("ascii");
  if (type !== "IHDR" || len < 8) return null;
  const width = readU32BE(buf, 16);
  const height = readU32BE(buf, 20);
  return { width, height };
}

function extractXmpFromPng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;

  let offset = 8;
  while (offset + 12 <= buf.length) {
    const length = readU32BE(buf, offset);
    const type = buf.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) break;

    if (type === "iTXt") {
      const data = buf.subarray(dataStart, dataEnd);
      const keywordEnd = data.indexOf(0);
      if (keywordEnd > 0) {
        const keyword = safeTextDecoder(data.subarray(0, keywordEnd));
        if (keyword === "XML:com.adobe.xmp" || keyword === "xmp") {
          // iTXt: keyword\0 compressionFlag compressionMethod languageTag\0 translatedKeyword\0 text
          let p = keywordEnd + 1;
          const compressionFlag = data[p];
          p += 1;
          // compressionMethod
          p += 1;
          // languageTag (null-terminated)
          const langEnd = data.indexOf(0, p);
          if (langEnd < 0) return null;
          p = langEnd + 1;
          // translatedKeyword (null-terminated)
          const transEnd = data.indexOf(0, p);
          if (transEnd < 0) return null;
          p = transEnd + 1;

          const textBytes = data.subarray(p);
          const xmlBytes =
            compressionFlag === 1 ? zlib.inflateSync(textBytes) : textBytes;
          return safeTextDecoder(xmlBytes);
        }
      }
    } else if (type === "tEXt") {
      const data = buf.subarray(dataStart, dataEnd);
      const keywordEnd = data.indexOf(0);
      if (keywordEnd > 0) {
        const keyword = safeTextDecoder(data.subarray(0, keywordEnd));
        if (keyword === "XML:com.adobe.xmp" || keyword === "xmp") {
          const textBytes = data.subarray(keywordEnd + 1);
          return safeTextDecoder(textBytes);
        }
      }
    }

    // length + type + data + crc
    offset = dataEnd + 4;
  }
  return null;
}

function pickXmpField(xml, tagName) {
  // 支持 <WorldID> / <xmp:CreateDate> / <xmp:Author> 等
  // 注意：这是“足够好”的解析，不做完整 XML 解析（后续可替换为 fast-xml-parser）
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<[^>]*${escaped}[^>]*>([^<]+)</[^>]*${escaped}>`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

function parseTakenAtFromFilename(fileName) {
  // VRChat_2026-03-01_22-12-35.355_2048x1440.png
  const m = fileName.match(
    /^VRChat_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.(\d{3})_/,
  );
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, ms] = m;
  return `${y}-${mo}-${d}T${hh}:${mm}:${ss}.${ms}`;
}

function normalizeRel(relPath) {
  return relPath.split(path.sep).join("/");
}

function toAssetId(relPath) {
  // 例如 2026-02/VRChat_...png -> 2026-02__VRChat_...
  const noExt = relPath.replace(/\.[^.]+$/, "");
  return normalizeRel(noExt).replaceAll("/", "__");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  const cwd = process.cwd();
  const inAbs = path.resolve(cwd, args.inDir);
  const outAbs = path.resolve(cwd, args.outFile);

  const files = await walk(inAbs);
  if (files.length === 0) {
    console.error(`未找到图片：${args.inDir}`);
    process.exit(1);
  }

  const assets = [];
  for (const abs of files) {
    const rel = path.relative(inAbs, abs);
    const relNorm = normalizeRel(rel);
    const src = `${args.srcPrefix.replace(/\/$/, "")}/${relNorm}`;
    const stat = await fs.stat(abs);

    const buf = await fs.readFile(abs);
    const ihdr = path.extname(abs).toLowerCase() === ".png" ? parsePngIhdr(buf) : null;

    let takenAt = null;
    let author = null;
    let worldId = null;
    let worldName = null;

    const xmpXml = path.extname(abs).toLowerCase() === ".png" ? extractXmpFromPng(buf) : null;
    if (xmpXml) {
      takenAt =
        pickXmpField(xmpXml, "CreateDate") ||
        pickXmpField(xmpXml, "xmp:CreateDate") ||
        pickXmpField(xmpXml, "DateTime") ||
        pickXmpField(xmpXml, "tiff:DateTime");
      author = pickXmpField(xmpXml, "Author") || pickXmpField(xmpXml, "xmp:Author");
      worldId = pickXmpField(xmpXml, "WorldID");
      worldName = pickXmpField(xmpXml, "WorldDisplayName");
    }

    if (!takenAt) {
      takenAt = parseTakenAtFromFilename(path.basename(abs));
    }
    if (!takenAt) {
      // 兜底：用文件修改时间（跨平台相对稳定）
      takenAt = new Date(stat.mtimeMs).toISOString();
    }

    assets.push({
      assetId: toAssetId(relNorm),
      src,
      mime: path.extname(abs).toLowerCase() === ".png" ? "image/png" : undefined,
      bytes: stat.size,
      width: ihdr?.width,
      height: ihdr?.height,
      takenAt,
      author: author ?? null,
      world: {
        worldId: worldId ?? null,
        worldName: worldName ?? null,
      },
      source: {
        xmp: Boolean(xmpXml),
        fileName: path.basename(abs),
        relPath: relNorm,
      },
    });
  }

  // 输出时按时间倒序（方便肉眼检查；UI 也会再排序）
  assets.sort((a, b) => Date.parse(b.takenAt) - Date.parse(a.takenAt));

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    assets,
  };

  await fs.mkdir(path.dirname(outAbs), { recursive: true });
  await fs.writeFile(outAbs, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

  const nonEmptyWorld = assets.filter((a) => a.world?.worldId).length;
  console.log(
    `已生成 manifest：${path.relative(cwd, outAbs)}（assets=${assets.length}, worldId=${nonEmptyWorld}）`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


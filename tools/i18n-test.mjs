#!/usr/bin/env node
/**
 * 多语言（i18n）的回归测试。
 *
 * 这个站宣称支持 zh / ja / en，但曾经只有登录页与关于页是真的三语，
 * 相册页与管理页整页硬编码中文——日文用户看完日文登录页，进去全是中文。
 * 而这种退化**不会报任何错**，只会静默地少一种语言，所以必须用测试钉住。
 *
 * 查五件事：
 *   1. 三语的 key 集合**完全一致**（缺一个 key，界面上就会直接显示成 key 名）；
 *   2. 三语都没有空文案；
 *   3. 代码里 `t("...")` 引用的每个 key 在三种语言里都取得到（不是回退成 key 本身）；
 *   4. 页面组件里**没有硬编码中文**（注释与 console.* 诊断输出除外）——
 *      这一条是防退化的关键：新加的按钮文案忘了走 t()，这里就会红；
 *   5. 切换语言时 `<html lang>` 会同步（否则切到日文后文档语言仍是 zh，
 *      朗读器按中文读日文、浏览器按中文规则挑 CJK 字体）。
 *
 * 用法：node tools/i18n-test.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LANGS = ["zh", "ja", "en"];
const CJK = /[\u4e00-\u9fa5\u3040-\u30ff]/;
/** 扫描硬编码中文的范围：只有页面与组件。lib/ 里的技术诊断消息刻意保持中文 */
const UI_GLOB_DIRS = ["src/pages", "src/components"];

// ---- 浏览器环境桩：i18n.ts 在模块加载时就会读 localStorage / 写 document.lang ----
class MemoryStorage {
  #map = new Map();
  getItem(k) {
    return this.#map.has(k) ? this.#map.get(k) : null;
  }
  setItem(k, v) {
    this.#map.set(String(k), String(v));
  }
  removeItem(k) {
    this.#map.delete(k);
  }
  clear() {
    this.#map.clear();
  }
}

globalThis.window = {
  localStorage: new MemoryStorage(),
  navigator: { language: "zh-CN", languages: ["zh-CN"] },
};
globalThis.document = { documentElement: { lang: "" } };

const server = await createServer({
  configFile: false,
  resolve: { alias: { "@": new URL("../src", import.meta.url).pathname } },
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: "custom",
  logLevel: "error",
  optimizeDeps: { noDiscovery: true, include: [] },
});

const i18n = (await server.ssrLoadModule("/src/i18n.ts")).default;

let pass = 0;
let fail = 0;
const test = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`);
  }
};

/** 把一个语言的资源树摊平成 key → 值（叶子可以是字符串） */
function flatten(obj, prefix = "") {
  const out = new Map();
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [kk, vv] of flatten(v, key)) out.set(kk, vv);
    } else {
      out.set(key, v);
    }
  }
  return out;
}

const resources = i18n.options.resources;
const flat = Object.fromEntries(LANGS.map((l) => [l, flatten(resources[l].translation)]));

// ---------------------------------------------------------------------------

console.log("【1】三语 key 集合必须完全一致");
await test("每种语言都有非空文案（不是只有空壳命名空间）", () => {
  for (const l of LANGS) {
    assert.ok(flat[l].size > 30, `${l} 只有 ${flat[l].size} 个 key，疑似文案没填`);
  }
  // 相册页与管理页必须真的搬进来了，而不是空对象
  for (const l of LANGS) {
    const albumKeys = [...flat[l].keys()].filter((k) => k.startsWith("album."));
    const adminKeys = [...flat[l].keys()].filter((k) => k.startsWith("admin."));
    assert.ok(albumKeys.length > 20, `${l} 的 album.* 只有 ${albumKeys.length} 个 key`);
    assert.ok(adminKeys.length > 15, `${l} 的 admin.* 只有 ${adminKeys.length} 个 key`);
  }
});
await test("zh / ja / en 的 key 集合逐个对齐", () => {
  const base = new Set(flat.zh.keys());
  for (const l of ["ja", "en"]) {
    const cur = new Set(flat[l].keys());
    const missing = [...base].filter((k) => !cur.has(k));
    const extra = [...cur].filter((k) => !base.has(k));
    assert.deepEqual(missing, [], `${l} 缺少这些 key（界面会直接显示 key 名）：${missing.join(", ")}`);
    assert.deepEqual(extra, [], `${l} 有 zh 里不存在的 key：${extra.join(", ")}`);
  }
});
await test("没有空文案（空字符串会显示成一片空白）", () => {
  for (const l of LANGS) {
    const empties = [...flat[l].entries()]
      .filter(([, v]) => typeof v !== "string" || !v.trim())
      .map(([k]) => k);
    assert.deepEqual(empties, [], `${l} 有空文案：${empties.join(", ")}`);
  }
});
await test("插值占位符在三种语言里一致（{{count}} 不能漏掉或拼错）", () => {
  for (const [key, zhVal] of flat.zh) {
    if (typeof zhVal !== "string") continue;
    const vars = (s) => [...s.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]).sort();
    const want = vars(zhVal);
    for (const l of ["ja", "en"]) {
      const got = vars(flat[l].get(key) ?? "");
      assert.deepEqual(got, want, `${l} 的「${key}」占位符不一致：期望 ${want}，实际 ${got}`);
    }
  }
});

console.log("\n【2】代码里引用的 key 必须都取得到");
const walk = (dir) => {
  const out = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(rel));
    else if (/\.tsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
};
const uiFiles = UI_GLOB_DIRS.flatMap(walk);

await test("每个 t(\"...\") 在三种语言里都有值、且不会回退成 key 名", () => {
  const used = new Map(); // key -> 出现在哪个文件
  for (const f of [...uiFiles, "src/i18n.ts"]) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    for (const m of src.matchAll(/\bt\(\s*"([^"]+)"/g)) {
      if (!used.has(m[1])) used.set(m[1], f);
    }
  }
  assert.ok(used.size > 30, `只找到 ${used.size} 个 t() 调用，扫描逻辑可能失效了`);

  const problems = [];
  for (const [key, file] of used) {
    for (const l of LANGS) {
      const val = flat[l].get(key);
      if (typeof val !== "string" || !val.trim()) {
        problems.push(`${key}（${file}）在 ${l} 里取不到`);
      }
    }
  }
  assert.deepEqual(problems, [], `以下 key 有问题：\n      ${problems.join("\n      ")}`);
});

console.log("\n【3】页面组件里不得残留硬编码中文");
/** 判断节点是否在 console.* 调用内部（那类输出是给开发者排查用的，允许中文） */
function isInsideConsole(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const e = n.expression;
      if (ts.isIdentifier(e.expression) && e.expression.text === "console") return true;
    }
  }
  return false;
}

function findHardcodedCjk(file) {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
  const hits = [];
  const visit = (node) => {
    if (isInsideConsole(node)) return; // 诊断输出：允许中文
    const record = (what, value) => {
      if (typeof value === "string" && CJK.test(value.trim())) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        hits.push(`${file}:${line + 1} [${what}] ${value.trim().slice(0, 48)}`);
      }
    };
    // JSX 文本节点（注释天然不在 AST 里）
    if (ts.isJsxText(node)) record("jsx", node.text);
    // JSX 属性里的字符串（title= / aria-label= / placeholder= 等）
    if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      record(`attr ${node.name.getText(sf)}`, node.initializer.text);
    }
    // 表达式里的普通字符串字面量
    if (ts.isStringLiteral(node) && !ts.isJsxAttribute(node.parent)) record("string", node.text);
    if (ts.isNoSubstitutionTemplateLiteral(node)) record("template", node.text);
    if (ts.isTemplateExpression(node)) {
      const full = node.getText(sf);
      if (CJK.test(full)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        hits.push(`${file}:${line + 1} [template] ${full.replace(/\s+/g, " ").slice(0, 48)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

await test("所有页面/组件里都没有硬编码中文（注释与 console.* 除外）", () => {
  const hits = uiFiles.flatMap(findHardcodedCjk);
  assert.deepEqual(
    hits,
    [],
    `新加的文案必须走 t()，不能直接写中文：\n      ${hits.join("\n      ")}`,
  );
});

console.log("\n【4】切换语言时 <html lang> 必须同步");
await test("初始语言写进 <html lang>", () => {
  assert.equal(globalThis.document.documentElement.lang, "zh", "初识语言是 zh-CN，应写成 zh");
});
await test("切到日文/英文后 lang 跟着变（否则朗读器与字体选择都还是按中文走）", async () => {
  await i18n.changeLanguage("ja");
  assert.equal(globalThis.document.documentElement.lang, "ja");
  await i18n.changeLanguage("en");
  assert.equal(globalThis.document.documentElement.lang, "en");
});
await test("带地区的语言标签归一化到受支持的语言", async () => {
  await i18n.changeLanguage("zh-CN");
  assert.equal(globalThis.document.documentElement.lang, "zh");
  await i18n.changeLanguage("ja-JP");
  assert.equal(globalThis.document.documentElement.lang, "ja");
  await i18n.changeLanguage("zh");
});

console.log("\n【5】抽样验证真的切换了文案");
await test("三语不是「只翻了个别词」：绝大多数 key 的 ja / en 都与 zh 不同", () => {
  const zhKeys = [...flat.zh.keys()].filter((k) => CJK.test(flat.zh.get(k) ?? ""));
  assert.ok(zhKeys.length > 40, `中文 key 只有 ${zhKeys.length} 个，文案疑似没搬进来`);

  const sameJa = zhKeys.filter((k) => flat.ja.get(k) === flat.zh.get(k));
  const sameEn = zhKeys.filter((k) => flat.en.get(k) === flat.zh.get(k));
  const ratioJa = 1 - sameJa.length / zhKeys.length;
  const ratioEn = 1 - sameEn.length / zhKeys.length;

  // 阈值不用 100%：Zone / OSS / Bucket / AccessKey / AAD 这类专有名词三语本来就一样，
  // 是有意保留的。但只要出现成片没翻的，比例会立刻掉下来。
  assert.ok(
    ratioJa > 0.9,
    `只有 ${(ratioJa * 100).toFixed(0)}% 的 key 日文与中文不同，疑似漏翻：${sameJa.slice(0, 12).join(", ")}`,
  );
  assert.ok(
    ratioEn > 0.9,
    `只有 ${(ratioEn * 100).toFixed(0)}% 的 key 英文与中文不同，疑似漏翻：${sameEn.slice(0, 12).join(", ")}`,
  );
});
await test("用 getFixedT 逐个语言取文案，取到的是该语言的原文而不是 key 名", () => {
  const keys = [...flat.zh.keys()];
  for (const key of keys) {
    for (const l of LANGS) {
      const got = i18n.getFixedT(l)(key);
      assert.notEqual(got, key, `${l} 下「${key}」回退成了 key 名`);
      assert.equal(got, flat[l].get(key), `${l} 下「${key}」取到的不是该语言的文案`);
    }
  }
});

console.log("\n【6】语言选择必须跨刷新保留");
await test("切换语言后写入 localStorage", async () => {
  const { persistLanguage } = await server.ssrLoadModule("/src/i18n.ts");
  persistLanguage("ja");
  assert.equal(globalThis.window.localStorage.getItem("td_lang"), "ja");
});
await test("换一份全新的模块图（=刷新页面）后仍是上次选的语言", async () => {
  globalThis.window.navigator = { language: "zh-CN", languages: ["zh-CN"] };
  const server2 = await createServer({
    configFile: false,
    resolve: { alias: { "@": new URL("../src", import.meta.url).pathname } },
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    logLevel: "error",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const i18n2 = (await server2.ssrLoadModule("/src/i18n.ts")).default;
  await server2.close();
  assert.equal(i18n2.language, "ja", "刷新后应当沿用上次选择的语言，而不是回到浏览器偏好");
  assert.equal(globalThis.document.documentElement.lang, "ja", "刷新后 <html lang> 也要跟着");
});

console.log("\n【7】含内联标签的整句（<Trans>）必须真的解析出标签，而不是打印字面量");
await test("<Trans> 三语都能渲染出元素、无 {{ }} 残留、无转义的裸标签", async () => {
  // 这几处是「一句话中间夹着 <strong>/<span>」的文案。拆成碎片 key 会让英文语序排不顺，
  // 所以用了 <Trans>。它出错时不会抛异常，只会把 <strong> 当文本打出来、或者留下 {{count}}，
  // 界面上很显眼、代码里却看不出来——所以这里用 react-dom/server 真渲染一遍。
  const usedTrans = new Map();
  for (const f of uiFiles) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    for (const m of src.matchAll(/i18nKey="([^"]+)"/g)) usedTrans.set(m[1], f);
  }
  assert.ok(usedTrans.size > 0, "没有找到任何 <Trans i18nKey> 用法，扫描逻辑可能失效了");

  const { default: React } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { Trans, I18nextProvider } = await import("react-i18next");

  const placeholderNames = (s) =>
    [...s.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]);

  for (const [key, file] of usedTrans) {
    const zhText = flat.zh.get(key);
    assert.ok(typeof zhText === "string", `「${key}」（${file}）在 zh 里取不到文案`);

    // 从中文原文里推出这句话用到了哪些标签，给每个标签挂一个可断言的标记属性
    const tags = [...new Set([...zhText.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)[\s>]/g)].map((m) => m[1]))];
    const components = Object.fromEntries(
      tags.map((t) => [t, React.createElement("i", { "data-i18n-tag": t })]),
    );
    const values = Object.fromEntries(placeholderNames(zhText).map((p) => [p, 7]));

    for (const l of LANGS) {
      await i18n.changeLanguage(l);
      const html = renderToStaticMarkup(
        React.createElement(
          I18nextProvider,
          { i18n },
          React.createElement(Trans, { i18nKey: key, values, components }),
        ),
      );

      assert.ok(
        !html.includes("{{"),
        `${l} 的「${key}」渲染后残留了未替换的 {{ }}：${html}`,
      );
      assert.ok(
        !html.includes("&lt;"),
        `${l} 的「${key}」渲染后出现了被转义的标签（说明标签没被解析）：${html}`,
      );
      for (const t of tags) {
        assert.ok(
          html.includes(`data-i18n-tag="${t}"`),
          `${l} 的「${key}」渲染后缺少 <${t}> 元素：${html}`,
        );
      }
    }
  }
  await i18n.changeLanguage("zh");
});

delete globalThis.window;
delete globalThis.document;
await server.close();
console.log(`\n======= 通过 ${pass} / 失败 ${fail} =======`);
process.exit(fail ? 1 : 0);

// 文字ツールでアラビア語とタイ語を入力すると、書けるフォントに自動で切り替わり、整形して保存される。
// 保存した PDF から pdf.js で文字が取り出せることを確認する。通信ゼロも検証する。
//   node test/e2e/shape-flow.mjs
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = process.cwd();
const html = process.env.WASHI_HTML ? join(root, process.env.WASHI_HTML) : join(root, "dist", "washi-pdf.html");
const outDir = join(root, "dist", ".e2e");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "ja-JP" });
const page = await context.newPage();
// 試験は「ページ全体を表示」で行う（ページ上の位置を、ページ全体が見えている前提で指す）
await page.addInitScript(() => {
  try {
    localStorage.setItem("washi-pdf.fit", "page");
  } catch {}
});
const network = [];
page.on("request", (r) => {
  const u = r.url();
  if (!u.startsWith("file://") && !u.startsWith("blob:") && !u.startsWith("data:")) network.push(u);
});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

await page.goto("file://" + html);
await page.waitForSelector(".dropzone", { timeout: 30000 });
await page.setInputFiles('input[type="file"][accept*="pdf"]', join(root, "test", "fixtures", "en-standard14.pdf"));
await page.waitForSelector(".card", { timeout: 30000 });
await page.click('button[role="tab"]:has-text("編集")');
await page.waitForSelector(".page-canvas");
await page.waitForFunction(() => !document.querySelector(".page-loading"));
const box = await (await page.$(".page")).boundingBox();
const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];

const typeText = async (fy, text) => {
  await page.click(".stage");
  await page.keyboard.press("t");
  await page.mouse.click(...at(0.15, fy));
  await page.waitForSelector("[contenteditable]");
  await page.keyboard.insertText(text);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
};
await typeText(0.55, "مرحبا بكم 123");
await typeText(0.65, "สวัสดี ที่นี่");
await typeText(0.75, "नमस्ते क्षत्रिय");

// 自動で切り替わったフォント名（プロパティ欄のフォント選択）
const fonts = await page.$$eval(".obj-text", (els) => els.map((e) => getComputedStyle(e).fontFamily));
console.log("fonts:", fonts.join(" | "));
if (!fonts.some((f) => /arabic/i.test(f)) || !fonts.some((f) => /thai/i.test(f)) || !fonts.some((f) => /devanagari/i.test(f))) fail("書けるフォントに切り替わっていません");
await page.screenshot({ path: join(outDir, "shape-ui.png") });

const [download] = await Promise.all([page.waitForEvent("download"), page.click('button.btn.primary:has-text("保存")')]);
const saved = join(outDir, "shaped.pdf");
await download.saveAs(saved);
await browser.close();

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const pdfjsDir = join(require.resolve("pdfjs-dist/package.json"), "..");
const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(saved)), isEvalSupported: false, standardFontDataUrl: `${join(pdfjsDir, "standard_fonts")}/`, cMapUrl: `${join(pdfjsDir, "cmaps")}/` }).promise;
const tc = await (await pdf.getPage(1)).getTextContent();
const str = tc.items.map((it) => it.str ?? "").join("").replace(/​/g, "");
console.log("text:", JSON.stringify(str.slice(-80)));
const rev = (s) => [...s].reverse().join("");
for (const s of ["123", "สวัสดี", "ที่นี่", "नमस्ते", "क्ष"]) if (!str.includes(s)) fail(`${s} が抽出できません`);
for (const s of ["مرحبا", "بكم"]) if (!str.includes(s) && !str.includes(rev(s))) fail(`${s} が抽出できません`);
if (network.length) fail(`外部への通信が発生しました: ${network}`);
if (errors.length) fail(`ブラウザのエラー: ${errors}`);
console.log("OK: 整形フォントで入力・保存、通信ゼロ、エラーなし");

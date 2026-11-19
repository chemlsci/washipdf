// 縦書きの列を「既存文字」で書き換えて保存し、pdf.js で新しい文字が取り出せ、元の文字が消えていることを確認する。
//   node test/e2e/vertical-flow.mjs
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
await page.setInputFiles('input[type="file"][accept*="pdf"]', join(root, "test", "fixtures", "ja-special-cases.pdf"));
await page.waitForSelector(".card", { timeout: 30000 });
await page.click('button[role="tab"]:has-text("編集")');
await page.waitForSelector(".page-canvas");
await page.waitForFunction(() => !document.querySelector(".page-loading"));
await page.click('button.tool:has-text("既存文字")');
const col = page.locator('.run-box[title*="縦書きの文字列"]');
await col.waitFor({ timeout: 30000 });
const box = await col.boundingBox();
console.log("column box:", Math.round(box.width), "x", Math.round(box.height));
if (box.height < box.width * 3) fail("縦書きの列の枠が縦長になっていません");
await col.click();
await page.waitForSelector("[contenteditable]");
const wm = await page.$eval("[contenteditable]", (el) => getComputedStyle(el).writingMode);
console.log("writing-mode:", wm);
if (wm !== "vertical-rl") fail("編集欄が縦書きになっていません");
await page.keyboard.press("Control+A");
await page.keyboard.insertText("改訂版の列");
await page.keyboard.press("Escape");
await page.waitForSelector(".obj-textedit.vertical");
await page.screenshot({ path: join(outDir, "vertical-ui.png") });

const [download] = await Promise.all([page.waitForEvent("download"), page.click('button.btn.primary:has-text("保存")')]);
const saved = join(outDir, "vertical.pdf");
await download.saveAs(saved);
await browser.close();

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const pdfjsDir = join(require.resolve("pdfjs-dist/package.json"), "..");
const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(saved)), isEvalSupported: false, standardFontDataUrl: `${join(pdfjsDir, "standard_fonts")}/`, cMapUrl: `${join(pdfjsDir, "cmaps")}/` }).promise;
const tc = await (await pdf.getPage(1)).getTextContent();
const str = tc.items.map((it) => it.str ?? "").join("").replace(/\s/g, "");
console.log("text:", JSON.stringify(str));
if (str.includes("縦書きの文字列")) fail("元の縦書きが残っています");
for (const ch of "改訂版の列") if (!str.includes(ch)) fail(`${ch} が抽出できません`);
if (network.length) fail(`外部への通信が発生しました: ${network}`);
if (errors.length) fail(`ブラウザのエラー: ${errors}`);
console.log("OK: 縦書きの列を書き換えて保存、通信ゼロ、エラーなし");

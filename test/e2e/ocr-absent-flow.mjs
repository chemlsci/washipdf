// 配布用の単一ファイルには、文字認識（OCR）を入れない：ツールの一覧に出ないこと、同じ配信元のプログラムを読み込む許可
// （script-src 'self'）が無いことを確かめる。（文字認識そのものの動作は、Web 版を組み立てるサイト側のテストで確かめる）
//   node test/e2e/ocr-absent-flow.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = process.cwd();
const html = process.env.WASHI_HTML ? join(root, process.env.WASHI_HTML) : join(root, "dist", "washi-pdf.html");
const fail = (msg) => {
  console.error("FAIL:", msg);
  process.exit(1);
};
const text = readFileSync(html, "utf8");
const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(text)?.[1] ?? "";
if (!/connect-src 'none'/.test(csp)) fail("connect-src 'none' が無い");
if (/script-src[^;]*'self'/.test(csp)) fail("script-src に 'self' が入っている");
// ページに直接書いたプログラムは、ハッシュで名指ししたものだけ（'unsafe-inline' は使わない）
if (/script-src[^;]*'unsafe-inline'/.test(csp)) fail("script-src に 'unsafe-inline' が入っている");
if (!/script-src[^;]*'sha256-[A-Za-z0-9+/=]+'/.test(csp)) fail("script-src にハッシュが無い");
if (text.includes('id="ocr-config"')) fail("文字認識の設定が入っている");

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "ja-JP" })).newPage();
// 試験は「ページ全体を表示」で行う（ページ上の位置を、ページ全体が見えている前提で指す）
await page.addInitScript(() => {
  try {
    localStorage.setItem("washi-pdf.fit", "page");
  } catch {}
});
await page.goto("file://" + html);
await page.waitForSelector(".dropzone", { timeout: 30000 });
await page.setInputFiles('input[type="file"][accept*="pdf"]', join(root, "test", "fixtures", "scan.pdf"));
await page.waitForSelector(".card", { timeout: 30000 });
await page.click('button[role="tab"]:has-text("ツール")');
await page.waitForSelector(".tool-card");
const cards = await page.locator(".tool-card").count();
const ocr = await page.locator('.tool-card[data-tool="ocr"]').count();
await browser.close();
if (ocr) fail("配布用のファイルに、文字認識のツールが出ている");
console.log(`ok  配布用のファイル：ツール ${cards} 個、文字認識は無し。CSP は connect-src 'none'、script-src に 'self' 無し`);
console.log("ocr-absent-flow: OK");

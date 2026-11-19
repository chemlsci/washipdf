// 和暦変換：ツール → 西暦→和暦で一覧を出し、適用 → 保存。保存後のテキストに和暦が入ることを確認する。通信ゼロも検証。
//   node test/e2e/wareki-flow.mjs
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
const fail = (m) => {
  console.error(m);
  process.exit(1);
};

await page.goto("file://" + html);
await page.waitForSelector(".dropzone", { timeout: 30000 });
if (await page.$('button:has-text("破棄する")')) await page.click('button:has-text("破棄する")');
await page.setInputFiles('input[type="file"][accept*="pdf"]', join(root, "test", "fixtures", "ja-subset-identity.pdf"));
await page.waitForSelector(".card", { timeout: 30000 });

// ツール → 和暦 ⇄ 西暦
await page.click('button[role="tab"]:has-text("ツール")');
await page.waitForSelector(".tool-cards");
await page.click('.tool-card[data-tool="wareki"]');
await page.waitForSelector(".modal", { timeout: 30000 });
// 西暦→和暦に切り替えて再スキャン
await page.click('.modal .seg button:has-text("西暦 → 和暦")');
await page.waitForFunction(() => document.querySelectorAll(".wareki-list li").length > 0, null, { timeout: 30000 });
const rows = await page.$$eval(".wareki-list li", (els) => els.map((e) => e.querySelector(".wareki-to")?.textContent ?? ""));
console.log("detected:", rows.join(" | "));
if (!rows.some((r) => /令和\d+年/.test(r))) fail("西暦→和暦の候補に令和が無い");
await page.screenshot({ path: join(outDir, "wareki-list.png") });
await page.click('.modal .btn.primary:has-text("件を変換")');
await page.waitForSelector(".obj-textedit", { timeout: 10000 }).catch(() => {});

const [download] = await Promise.all([page.waitForEvent("download"), page.click('button.btn.primary:has-text("保存")')]);
const saved = join(outDir, "wareki.pdf");
await download.saveAs(saved);
await browser.close();

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const dir = join(require.resolve("pdfjs-dist/package.json"), "..");
const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(saved)), isEvalSupported: false, standardFontDataUrl: `${join(dir, "standard_fonts")}/`, cMapUrl: `${join(dir, "cmaps")}/` }).promise;
const tc = await (await pdf.getPage(1)).getTextContent();
const str = tc.items.map((it) => it.str ?? "").join("").replace(/\s/g, "");
console.log("text has 令和:", /令和\d+年/.test(str));
if (!/令和\d+年/.test(str)) fail("保存後のテキストに和暦が入っていない");
if (network.length) fail(`外部への通信が発生しました: ${network}`);
if (errors.length) fail(`ブラウザのエラー: ${errors}`);
console.log("OK: 和暦変換（西暦→和暦）を一覧から適用して保存、通信ゼロ、エラーなし");

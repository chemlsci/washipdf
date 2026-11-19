// しおり・添付ファイル・面付け・文書比較をブラウザで通して確認する。通信ゼロも検証する。
//   node test/e2e/m13-flow.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = process.cwd();
const html = join(root, "dist", "washi-pdf.html");
const outDir = join(root, "dist", ".e2e");
mkdirSync(outDir, { recursive: true });
const memo = join(outDir, "memo.txt");
writeFileSync(memo, "添付のテスト");

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
await page.setInputFiles('input[type="file"][accept*="pdf"]', [join(root, "test", "fixtures", "ja-subset-identity.pdf"), join(root, "test", "fixtures", "en-standard14.pdf")]);
await page.waitForFunction(() => document.querySelectorAll(".card").length === 2, null, { timeout: 30000 });
await page.click('button[role="tab"]:has-text("ツール")');

// しおり
await page.click('.tool-card[data-tool="outline"]');
const ol = page.locator('.modal[aria-label="しおり（目次）"]');
await ol.waitFor();
await ol.locator('button:has-text("項目を追加")').click();
await ol.locator(".outline-row").nth(0).locator(".outline-title").fill("表紙");
await ol.locator('button:has-text("項目を追加")').click();
await ol.locator(".outline-row").nth(1).locator(".outline-title").fill("本文");
await ol.locator(".outline-row").nth(1).locator('input[type="number"]').fill("2");
await ol.locator(".outline-row").nth(1).locator('button[title="階層を下げる"]').click();
await page.screenshot({ path: join(outDir, "m13-outline.png") });
await ol.locator('button.btn.primary:has-text("適用")').click();
await page.waitForSelector('.tool-card.active:has-text("しおり")');

// 添付
await page.click('.tool-card[data-tool="attachments"]');
const at = page.locator('.modal[aria-label="添付ファイル"]');
await at.waitFor();
await at.locator('input[type="file"]').setInputFiles(memo);
await at.locator(".attach-row").waitFor();
await at.locator(".attach-row input").fill("メモです");
await at.locator('button.btn.primary:has-text("適用")').click();
await page.waitForSelector('.tool-card.active:has-text("添付ファイル")');

// 保存して検証
const [dl] = await Promise.all([page.waitForEvent("download"), page.click('button.btn.primary:has-text("保存")')]);
const saved = join(outDir, "m13.pdf");
await dl.saveAs(saved);
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const pdfjsDir = join(require.resolve("pdfjs-dist/package.json"), "..");
const opts = { isEvalSupported: false, standardFontDataUrl: `${join(pdfjsDir, "standard_fonts")}/`, cMapUrl: `${join(pdfjsDir, "cmaps")}/` };
const pdf = await pdfjs.getDocument({ ...opts, data: new Uint8Array(readFileSync(saved)) }).promise;
const outline = await pdf.getOutline();
console.log("outline:", JSON.stringify(outline?.map((o) => [o.title, o.items.map((i) => i.title)])));
if (!outline || outline.length !== 1 || outline[0].title !== "表紙" || outline[0].items[0]?.title !== "本文") fail("しおりが保存されていません");
const idx = await pdf.getPageIndex(outline[0].items[0].dest[0]);
if (idx !== 1) fail(`本文のページが 2 ページ目でない: ${idx}`);
const atts = await pdf.getAttachments();
// pdf.js の版によって、Map か普通のオブジェクトで返る
const attList = atts instanceof Map ? [...atts.values()] : Object.values(atts ?? {});
console.log("attachments:", attList.map((a) => a.filename));
if (!attList.some((a) => a.filename === "memo.txt")) fail("添付が保存されていません");

// 面付け（小冊子）
await page.click('.tool-card[data-tool="nup"]');
const nup = page.locator('.modal[aria-label="割り付け・小冊子（N-up）"]');
await nup.waitFor();
await nup.locator('label:has-text("小冊子") input').check();
const [dl2] = await Promise.all([page.waitForEvent("download"), nup.locator('button.btn.primary:has-text("作成してダウンロード")').click()]);
const booklet = join(outDir, "m13-booklet.pdf");
await dl2.saveAs(booklet);
const lib = await PDFDocument.load(readFileSync(booklet));
const p0 = lib.getPage(0);
console.log("booklet pages:", lib.getPageCount(), "size:", p0.getWidth(), p0.getHeight());
if (lib.getPageCount() !== 2 || p0.getWidth() <= p0.getHeight()) fail("小冊子が 2 枚の横向きになっていません");

// 文書比較：1 ページ目は同じ、2 ページ目は相手に無い
await page.click('.tool-card[data-tool="compare"]');
const cmp = page.locator('.modal[aria-label="文書の比較"]');
await cmp.waitFor();
await cmp.locator('input[type="file"]').setInputFiles(join(root, "test", "fixtures", "ja-subset-identity.pdf"));
await cmp.locator(".compare-head").waitFor({ timeout: 60000 });
// 図や画像の違いを調べている途中は「確認済み」の途中経過が出る。最後の結果になるまで待つ
await page.waitForFunction(() => /\d+ \/ \d+$/.test(document.querySelector(".compare-head b")?.textContent?.trim() ?? ""), null, { timeout: 60000 });
const summary = await cmp.locator(".compare-head b").innerText();
console.log("compare:", summary);
await page.screenshot({ path: join(outDir, "m13-compare.png") });
if (!/1 \/ 2/.test(summary)) fail("比較の結果が想定と違います");
await browser.close();

if (network.length) fail(`外部への通信が発生しました: ${network}`);
if (errors.length) fail(`ブラウザのエラー: ${errors}`);
console.log("OK: しおり・添付・面付け・比較、通信ゼロ、エラーなし");

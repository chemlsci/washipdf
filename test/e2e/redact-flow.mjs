// 「既存画像」で元の画像を削除し、「墨消し」で文字の一部を取り除いて保存する。
// 保存した PDF から該当の文字が消え、画像の描画命令が 1 つ減っていることを確認する。通信ゼロも検証する。
//   node test/e2e/redact-flow.mjs
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { decodePDFRawStream, PDFArray, PDFDocument, PDFRawStream } from "pdf-lib";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = process.cwd();
const html = join(root, "dist", "washi-pdf.html");
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

await page.goto("file://" + html);
await page.waitForSelector(".dropzone", { timeout: 30000 });
await page.setInputFiles('input[type="file"][accept*="pdf"]', join(root, "test", "fixtures", "images.pdf"));
await page.waitForSelector(".card", { timeout: 30000 });
await page.click('button[role="tab"]:has-text("編集")');
await page.waitForSelector(".page-canvas");
await page.waitForFunction(() => !document.querySelector(".page-loading"));

// 既存画像：枠が 2 つ出て、クリックすると削除オブジェクトになる
await page.click('button.tool:has-text("既存画像")');
await page.waitForSelector(".img-box", { timeout: 30000 });
const boxes = await page.$$(".img-box");
console.log("image boxes:", boxes.length);
if (boxes.length !== 2) {
  console.error("画像の枠が 2 つではありません");
  process.exit(1);
}
await boxes[0].click();
await page.waitForSelector(".obj-imageedit");
console.log("boxes after delete:", await page.$$eval(".img-box", (els) => els.length));

// 墨消し：ページ座標で文字 "Hello Images"（x 50.., 下から 40pt）の左側をドラッグ
const pageBox = await (await page.$(".page")).boundingBox();
const zoom = pageBox.width / 400; // ページ幅 400pt
const at = (x, yFromTop) => [pageBox.x + x * zoom, pageBox.y + yFromTop * zoom];
await page.click('button.tool:has-text("墨消し")');
await page.mouse.move(...at(45, 240));
await page.mouse.down();
await page.mouse.move(...at(95, 265), { steps: 5 });
await page.mouse.up();
await page.waitForSelector(".obj-redact");
await page.screenshot({ path: join(outDir, "redact-ui.png") });

const [download] = await Promise.all([page.waitForEvent("download"), page.click('button.btn.primary:has-text("保存")')]);
const saved = join(outDir, "redacted.pdf");
await download.saveAs(saved);
await browser.close();

// 検証：Do 命令の数は pdf-lib で、文字は pdf.js で
const bytes = new Uint8Array(readFileSync(saved));
const lib = await PDFDocument.load(bytes);
const contents = lib.getPage(0).node.Contents();
const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
let content = "";
for (const r of refs) {
  const s = lib.context.lookup(r);
  if (s instanceof PDFRawStream) content += `${Buffer.from(decodePDFRawStream(s).decode()).toString("latin1")}\n`;
}
const doCount = (content.match(/\bDo\b/g) ?? []).length;
console.log("Do count:", doCount);
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const pdfjsDir = join(require.resolve("pdfjs-dist/package.json"), "..");
const pdf = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, standardFontDataUrl: `${join(pdfjsDir, "standard_fonts")}/` }).promise;
const tc = await (await pdf.getPage(1)).getTextContent();
const str = tc.items.map((it) => it.str ?? "").join("");
console.log("text:", JSON.stringify(str));
if (doCount !== 1 || /Hello/.test(str) || !/Images/.test(str)) {
  console.error("画像の削除か墨消しが反映されていません");
  process.exit(1);
}
if (network.length) {
  console.error("外部への通信が発生しました:", network);
  process.exit(1);
}
if (errors.length) {
  console.error("ブラウザのエラー:", errors);
  process.exit(1);
}
console.log("OK: 既存画像の削除と墨消しを保存、通信ゼロ、エラーなし");

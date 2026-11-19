// 注釈ツール（ハイライト・下線・付箋・ペン・スタンプ）をブラウザで実際に付けて保存し、
// 保存した PDF に注釈が入っていることを確認する。通信ゼロも検証する。
//   node test/e2e/annots-flow.mjs
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { PDFArray, PDFDict, PDFDocument, PDFName } from "pdf-lib";

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
await page.setInputFiles('input[type="file"][accept*="pdf"]', join(root, "test", "fixtures", "ja-subset-identity.pdf"));
await page.waitForSelector(".card", { timeout: 30000 });
await page.click('button[role="tab"]:has-text("編集")');
await page.waitForSelector(".page-canvas");
await page.waitForFunction(() => !document.querySelector(".page-loading"));

// ページ上の相対位置（0〜1）で座標を決める。ズーム倍率に依存しない
const box = await (await page.$(".page")).boundingBox();
const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
const drag = async (from, to) => {
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(...to, { steps: 6 });
  await page.mouse.up();
};
const objs = async () => page.$$eval(".obj", (els) => els.map((e) => e.className.split(" ")[1]));

await page.click('button.tool:has-text("ハイライト")');
await drag(at(0.12, 0.1), at(0.5, 0.13));
await page.click('button.tool:has-text("下線")');
await drag(at(0.12, 0.16), at(0.4, 0.18));
await page.click('button.tool:has-text("付箋")');
await page.mouse.click(...at(0.8, 0.08));
await page.fill(".props textarea", "ここを確認");
await page.click('button.tool:has-text("ペン")');
await drag(at(0.2, 0.5), at(0.4, 0.55));
await page.click('button.tool:has-text("スタンプ")');
await page.mouse.click(...at(0.7, 0.5));
const created = await objs();
console.log("objects:", created.join(","));
await page.screenshot({ path: join(outDir, "annots-ui.png") });
const want = ["obj-markup", "obj-markup", "obj-note", "obj-ink", "obj-stamp"];
if (want.some((w, i) => created[i] !== w)) {
  console.error("作成されたオブジェクトが想定と違います", created);
  process.exit(1);
}

const [download] = await Promise.all([page.waitForEvent("download"), page.click('button.btn.primary:has-text("保存")')]);
const saved = join(outDir, "annots.pdf");
await download.saveAs(saved);
await browser.close();

const lib = await PDFDocument.load(readFileSync(saved));
const annots = lib.getPage(0).node.Annots();
const subtypes = annots instanceof PDFArray ? annots.asArray().map((r) => lib.context.lookup(r)).filter((d) => d instanceof PDFDict).map((d) => d.get(PDFName.of("Subtype")).decodeText()).sort() : [];
console.log("annots:", subtypes.join(","));
const expect = ["Highlight", "Ink", "Popup", "Text", "Underline"];
if (JSON.stringify(subtypes) !== JSON.stringify(expect)) {
  console.error("注釈が想定どおり保存されていません", subtypes);
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
console.log("OK: 注釈 5 種を保存、通信ゼロ、エラーなし");

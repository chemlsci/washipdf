// 大きな画像を含む PDF をその場で作り、「圧縮」を有効にして保存すると小さくなることを確認する。通信ゼロも検証する。
//   node test/e2e/compress-flow.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { PDFDocument, PDFName, PDFNumber } from "pdf-lib";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { createCanvas } = require("@napi-rs/canvas");

const root = process.cwd();
const html = join(root, "dist", "washi-pdf.html");
const outDir = join(root, "dist", ".e2e");
mkdirSync(outDir, { recursive: true });

// 1600×1200 のノイズ入りグラデーション JPEG を 200pt 幅で貼った PDF
const big = createCanvas(1600, 1200);
const g = big.getContext("2d");
const grad = g.createLinearGradient(0, 0, 1600, 1200);
grad.addColorStop(0, "#ff8800");
grad.addColorStop(1, "#0066ff");
g.fillStyle = grad;
g.fillRect(0, 0, 1600, 1200);
for (let i = 0; i < 20000; i++) {
  g.fillStyle = `rgba(0,0,0,${Math.random() * 0.5})`;
  g.fillRect(Math.random() * 1600, Math.random() * 1200, 3, 3);
}
const src = await PDFDocument.create();
const page = src.addPage([400, 400]);
page.drawImage(await src.embedJpg(await big.encode("jpeg", 95)), { x: 50, y: 200, width: 200, height: 150 });
const srcFile = join(outDir, "compress-src.pdf");
writeFileSync(srcFile, await src.save({ useObjectStreams: false }));
const srcSize = readFileSync(srcFile).length;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "ja-JP" });
const pg = await context.newPage();
// 試験は「ページ全体を表示」で行う（ページ上の位置を、ページ全体が見えている前提で指す）
await pg.addInitScript(() => {
  try {
    localStorage.setItem("washi-pdf.fit", "page");
  } catch {}
});
const network = [];
pg.on("request", (r) => {
  const u = r.url();
  if (!u.startsWith("file://") && !u.startsWith("blob:") && !u.startsWith("data:")) network.push(u);
});
const errors = [];
pg.on("pageerror", (e) => errors.push(String(e)));
pg.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await pg.goto("file://" + html);
await pg.waitForSelector(".dropzone", { timeout: 30000 });
await pg.setInputFiles('input[type="file"][accept*="pdf"]', srcFile);
await pg.waitForSelector(".card", { timeout: 30000 });
await pg.click('button[role="tab"]:has-text("ツール")');
await pg.click('.tool-card[data-tool="compress"]');
const dlg = pg.locator('.modal[aria-label="圧縮"]');
await dlg.waitFor();
await dlg.locator('label:has-text("保存時に圧縮する") input').check();
await dlg.locator("select").selectOption("96");
await pg.screenshot({ path: join(outDir, "compress-dialog.png") });
await dlg.locator('button.btn.primary:has-text("適用")').click();
await pg.waitForSelector('.tool-card.active:has-text("圧縮")');

const [download] = await Promise.all([pg.waitForEvent("download"), pg.click('button.btn.primary:has-text("保存")')]);
const saved = join(outDir, "compressed.pdf");
await download.saveAs(saved);
const toast = await pg.locator(".toast").first().innerText().catch(() => "");
console.log("toast:", toast);

// 白黒 2 値化：選ぶとプレビューが出て、拡大して確かめられる。保存すると画像が 1 ビットになる
await pg.click('.tool-card[data-tool="compress"]');
await dlg.waitFor();
await dlg.locator('label:has-text("白黒 2 値") input').check();
await pg.waitForFunction(() => (document.querySelector(".modal .preview-canvas:not(.busy) canvas")?.width ?? 0) > 100, null, { timeout: 60000 });
await dlg.locator(".preview-zoom").click();
await pg.waitForFunction(() => !!document.querySelector(".modal .preview-canvas.zoomed:not(.busy) canvas"), null, { timeout: 60000 });
await pg.screenshot({ path: join(outDir, "compress-bilevel.png") });
await dlg.locator('button.btn.primary:has-text("適用")').click();
const [download2] = await Promise.all([pg.waitForEvent("download"), pg.click('button.btn.primary:has-text("保存")')]);
const saved2 = join(outDir, "compressed-bw.pdf");
await download2.saveAs(saved2);
await browser.close();
{
  const lib2 = await PDFDocument.load(readFileSync(saved2));
  const x2 = lib2.getPage(0).node.Resources().lookup(PDFName.of("XObject"));
  const bits = x2.entries().map(([, v]) => lib2.context.lookup(v).dict.lookup(PDFName.of("BitsPerComponent"))).map((w) => (w instanceof PDFNumber ? w.asNumber() : -1));
  console.log("bilevel bits:", bits, "size:", readFileSync(saved2).length);
  if (!bits.length || !bits.every((b) => b === 1)) {
    console.error("白黒 2 値になっていません");
    process.exit(1);
  }
}

const outSize = readFileSync(saved).length;
console.log("size:", srcSize, "→", outSize);
const lib = await PDFDocument.load(readFileSync(saved));
const xobj = lib.getPage(0).node.Resources().lookup(PDFName.of("XObject"));
const widths = xobj.entries().map(([, v]) => lib.context.lookup(v).dict.lookup(PDFName.of("Width"))).map((w) => (w instanceof PDFNumber ? w.asNumber() : -1));
console.log("image widths:", widths);
if (outSize >= srcSize * 0.5 || !widths.every((w) => w <= 270) || !/再圧縮/.test(toast)) {
  console.error("圧縮が効いていません");
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
console.log("OK: 圧縮して保存、通信ゼロ、エラーなし");

// スマホで起きた 2 つの不具合の再発防止。
//  1. 「名前を付けて保存」で選んだ場所に書けず、空（0 B）のファイルになる端末がある
//     → 書いた後に大きさを確かめ、合わなければダウンロードに切り替えて、そう知らせる
//  2. そのまま印刷できない端末で「PDF を開く」しか出ず、開いても印刷の操作が無い
//     → 共有できる端末では、共有（一覧から印刷を選ぶ）を案内する
//   node test/e2e/save-fallback-flow.mjs
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = process.cwd();
const html = process.env.WASHI_HTML ? join(root, process.env.WASHI_HTML) : join(root, "dist", "washi-pdf.html");
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "ja-JP", acceptDownloads: true });
const page = await context.newPage();
// 試験は「ページ全体を表示」で行う（ページ上の位置を、ページ全体が見えている前提で指す）
await page.addInitScript(() => {
  try {
    localStorage.setItem("washi-pdf.fit", "page");
  } catch {}
});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const fail = async (m) => {
  console.error("FAIL:", m);
  await browser.close();
  process.exit(1);
};

// 保存先の選択は成功するが、書き込みが黙って捨てられる（大きさ 0 のまま）端末をまねる。共有はできる・印刷はできない端末をまねる
await page.addInitScript(() => {
  window.__removed = 0;
  window.__shared = 0;
  window.showSaveFilePicker = async (o) => ({
    kind: "file",
    name: o?.suggestedName ?? "out.pdf",
    queryPermission: async () => "granted",
    requestPermission: async () => "granted",
    createWritable: async () => ({ write: async () => undefined, close: async () => undefined }),
    getFile: async () => new File([], "out.pdf"),
    remove: async () => void window.__removed++,
  });
  navigator.canShare = () => true;
  navigator.share = async () => void window.__shared++;
  window.print = undefined;
  Object.defineProperty(navigator, "pdfViewerEnabled", { get: () => false });
});

await page.goto("file://" + html);
await page.waitForSelector(".dropzone", { timeout: 30000 });
await page.setInputFiles('input[type="file"][accept*="pdf"]', join(root, "test", "fixtures", "ja-subset-identity.pdf"));
await page.waitForSelector(".card", { timeout: 30000 });

// 1. 名前を付けて保存 → 書けない → ダウンロードに切り替わる
await page.click(".split-btn .menu-caret");
const [download] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), page.click('.menu-pop button:has-text("名前を付けて保存")')]);
const size = (await (await download.createReadStream()).toArray()).reduce((n, c) => n + c.length, 0);
if (size < 1000) await fail(`ダウンロードされたファイルが小さすぎる（${size} B）`);
await page.waitForSelector(".toast", { timeout: 10000 });
const toast = (await page.locator(".toast").innerText()).replace(/\s+/g, " ");
if (!toast.includes("ダウンロードとして保存")) await fail(`切り替えたことを知らせていない: ${toast}`);
if ((await page.evaluate(() => window.__removed)) < 1) await fail("空のファイルを消そうとしていない");
console.log(`ok  書けない保存先 → ダウンロードに切り替え（${size} B）、知らせ: ${toast.slice(0, 40)}`);

// 2. 印刷 → 共有を案内する
await page.click(".split-btn .menu-caret");
await page.click('.menu-pop button:has-text("印刷")');
await page.waitForSelector(".ready-actions", { timeout: 30000 });
const msg = await page.locator(".modal p").first().innerText();
if (!msg.includes("共有")) await fail(`共有の案内になっていない: ${msg}`);
await page.click('.ready-actions .btn.primary');
await page.waitForFunction(() => window.__shared > 0, null, { timeout: 10000 }).catch(() => fail("共有が呼ばれなかった"));
console.log("ok  印刷できない端末 → 共有を案内して呼び出す");
if (errors.length) await fail("ページのエラー: " + errors[0]);
await browser.close();
console.log("save-fallback-flow: OK");

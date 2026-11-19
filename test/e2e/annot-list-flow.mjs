// 注釈の一覧：ハイライトと付箋を付けて保存し、開き直すと、元の PDF の注釈として一覧に出る（付箋は内容も）。
// 一覧の項目を押すと、編集画面のそのページへ移り、その場所を示す枠が出る。このアプリで付けた注釈は、押すとその部品が選ばれる。
//   node test/e2e/annot-list-flow.mjs
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = process.cwd();
const html = process.env.WASHI_HTML ? join(root, process.env.WASHI_HTML) : join(root, "dist", "washi-pdf.html");
const outDir = join(root, "dist", ".e2e");
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: "ja-JP", acceptDownloads: true })).newPage();
await page.addInitScript(() => {
  try {
    localStorage.setItem("washi-pdf.fit", "page");
  } catch {}
});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const fail = async (msg) => {
  console.error("FAIL:", msg);
  await page.screenshot({ path: join(outDir, "annot-list-fail.png") });
  await browser.close();
  process.exit(1);
};
const open = async (file) => {
  await page.goto("file://" + html);
  await page.waitForSelector(".dropzone");
  if (await page.$('button:has-text("破棄する")')) await page.click('button:has-text("破棄する")');
  await page.setInputFiles('input[type="file"][accept*="pdf"]', file);
  await page.waitForSelector(".card");
};
const openList = async () => {
  await page.click('button[role="tab"]:has-text("ツール")');
  await page.fill(".tool-search input", "注釈の一覧");
  await page.click('.tool-card[data-tool="annotList"]');
  await page.waitForSelector(".annot-list li, .modal .note", { timeout: 15000 });
  await page.waitForTimeout(300);
  return page.locator(".annot-list li").allInnerTexts();
};

await open(join(root, "test", "fixtures", "ja-libreoffice-writer.pdf"));
await page.click('button[role="tab"]:has-text("編集")');
await page.waitForSelector(".page-canvas");
const bb = await page.locator(".page-slot.current .page").boundingBox();
const at = (fx, fy) => [bb.x + bb.width * fx, bb.y + bb.height * fy];
await page.click('button.tool:has-text("ハイライト")');
await page.mouse.move(...at(0.1, 0.2));
await page.mouse.down();
await page.mouse.move(...at(0.5, 0.22), { steps: 5 });
await page.mouse.up();
await page.click('button.tool:has-text("付箋")');
await page.mouse.click(...at(0.8, 0.6));
await page.fill(".props textarea", "ここを確認");
// このアプリで付けた注釈：一覧に出て、押すとその部品が選ばれる
const own = await openList();
if (own.length !== 2 || !own.some((s) => s.includes("付箋") && s.includes("ここを確認"))) await fail(`付けた注釈が一覧に出ない: ${JSON.stringify(own)}`);
await page.locator(".annot-list li button", { hasText: "付箋" }).click();
await page.waitForSelector(".obj-note.selected", { timeout: 5000 }).catch(() => fail("一覧から移っても付箋が選ばれていない"));
console.log("ok  付けた注釈が一覧に出て、押すとその部品が選ばれる：", own.map((s) => s.replace(/\s+/g, " ")).join(" / "));

const [download] = await Promise.all([page.waitForEvent("download"), page.click('button.btn.primary:has-text("保存")')]);
const saved = join(outDir, "annot-list.pdf");
await download.saveAs(saved);
// 開き直すと、元の PDF の注釈として一覧に出る。押すと場所を示す枠が出る
await open(saved);
const src = await openList();
if (src.length !== 2 || !src.some((s) => s.includes("ハイライト")) || !src.some((s) => s.includes("ここを確認"))) await fail(`元の PDF の注釈が一覧に出ない: ${JSON.stringify(src)}`);
await page.locator(".annot-list li button", { hasText: "ハイライト" }).click();
await page.waitForSelector(".annot-flash", { timeout: 5000 }).catch(() => fail("一覧から移っても場所を示す枠が出ない"));
console.log("ok  開き直すと元の PDF の注釈として一覧に出て、押すと場所を示す：", src.map((s) => s.replace(/\s+/g, " ")).join(" / "));
if (errors.length) await fail("ページのエラー: " + errors[0]);
await browser.close();
console.log("annot-list-flow: OK");

// リンク：リンクの道具でドラッグして範囲を作り、URL とページを行き先にして保存すると、PDF のリンク注釈になる。
// 保存した PDF を開き直してリンクの道具を選ぶと、元のリンクが編集できる部品として読み込まれ、削除・変更が保存に反映される。
//   node test/e2e/link-flow.mjs
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { PDFDocument, PDFName, PDFArray, PDFDict, PDFRef } = require("pdf-lib");

const root = process.cwd();
const html = process.env.WASHI_HTML ? join(root, process.env.WASHI_HTML) : join(root, "dist", "washi-pdf.html");
const outDir = join(root, "dist", ".e2e");
mkdirSync(outDir, { recursive: true });
const browser = await browser0();
async function browser0() {
  return chromium.launch();
}
const page = await (await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: "ja-JP", acceptDownloads: true })).newPage();
// 試験は「ページ全体を表示」で行う（ページ上の位置を、ページ全体が見えている前提で指す）
await page.addInitScript(() => {
  try {
    localStorage.setItem("washi-pdf.fit", "page");
  } catch {}
});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const network = [];
page.on("request", (r) => {
  const u = r.url();
  if (!u.startsWith("file://") && !u.startsWith("blob:") && !u.startsWith("data:")) network.push(u);
});
const fail = async (msg) => {
  console.error("FAIL:", msg);
  await page.screenshot({ path: join(outDir, "link-fail.png") });
  await browser.close();
  process.exit(1);
};
const linksOf = async (file) => {
  const doc = await PDFDocument.load(readFileSync(file));
  const pages = doc.getPages();
  return pages.map((p) => {
    const annots = p.node.lookup(PDFName.of("Annots"));
    if (!(annots instanceof PDFArray)) return [];
    return annots
      .asArray()
      .map((a) => (a instanceof PDFRef ? doc.context.lookup(a) : a))
      .filter((d) => d instanceof PDFDict && d.get(PDFName.of("Subtype")) === PDFName.of("Link"))
      .map((d) => {
        const act = d.lookup(PDFName.of("A"));
        if (act instanceof PDFDict) return `url:${act.lookup(PDFName.of("URI")).decodeText()}`;
        const dest = d.lookup(PDFName.of("Dest"));
        return `page:${pages.findIndex((x) => x.ref === dest.get(0)) + 1}`;
      });
  });
};
const save = async (name) => {
  const [download] = await Promise.all([page.waitForEvent("download"), page.click('button.btn.primary:has-text("保存")')]);
  const file = join(outDir, name);
  await download.saveAs(file);
  return file;
};
const draw = async (x, y) => {
  const bb = await page.locator(".page-slot.current .page").boundingBox();
  await page.mouse.move(bb.x + x, bb.y + y);
  await page.mouse.down();
  await page.mouse.move(bb.x + x + 140, bb.y + y + 30, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(200);
};

await page.goto("file://" + html);
await page.waitForSelector(".dropzone");
await page.setInputFiles('input[type="file"][accept*="pdf"]', ["ja-libreoffice-writer.pdf", "en-standard14.pdf"].map((f) => join(root, "test", "fixtures", f)));
await page.waitForFunction(() => document.querySelectorAll(".card").length === 2);
await page.click('button[role="tab"]:has-text("編集")');
await page.waitForSelector(".page-canvas");
// 1 つ目：URL
await page.click('button.tool:has-text("リンク")');
await draw(60, 80);
await page.fill('.props input[type="url"]', "https://example.com/a");
// 2 つ目：2 ページ目へ
await page.click('button.tool:has-text("リンク")');
await draw(60, 160);
await page.click('.props .seg button:has-text("ページ")');
await page.selectOption(".props select", { label: "2 ページ" });
if ((await page.locator(".page-slot.current .obj-link").count()) !== 2) await fail("リンクの枠が 2 つ出ていない");
const first = await linksOf(await save("links.pdf"));
if (JSON.stringify(first) !== JSON.stringify([["url:https://example.com/a", "page:2"], []])) await fail(`保存したリンクが違う: ${JSON.stringify(first)}`);
console.log("ok  URL とページへのリンクを作って保存：", JSON.stringify(first));

// 開き直して、元のリンクを編集・削除する
await page.goto("file://" + html);
await page.waitForSelector(".dropzone");
if (await page.$('button:has-text("破棄する")')) await page.click('button:has-text("破棄する")');
await page.setInputFiles('input[type="file"][accept*="pdf"]', join(outDir, "links.pdf"));
await page.waitForFunction(() => document.querySelectorAll(".card").length === 2);
await page.click('button[role="tab"]:has-text("編集")');
await page.waitForSelector(".page-canvas");
await page.click('button.tool:has-text("リンク")');
await page.waitForFunction(() => document.querySelectorAll(".page-slot.current .obj-link").length === 2, null, { timeout: 10000 }).catch(() => fail("元のリンクが部品として読み込まれない"));
// ページへのリンクを選んで削除、URL のリンクは行き先を変える
await page.click('button.tool:has-text("選択")');
const boxes = page.locator(".page-slot.current .obj-link");
const labels = await boxes.allInnerTexts();
const pageIdx = labels.findIndex((s) => s.includes("ページ"));
await boxes.nth(pageIdx).click();
await page.keyboard.press("Delete");
await page.locator(".page-slot.current .obj-link").first().click();
await page.fill('.props input[type="url"]', "https://example.com/b");
const second = await linksOf(await save("links-edited.pdf"));
if (JSON.stringify(second) !== JSON.stringify([["url:https://example.com/b"], []])) await fail(`編集したリンクが反映されていない: ${JSON.stringify(second)}`);
console.log("ok  開き直して元のリンクを編集・削除：", JSON.stringify(second));

if (network.length) await fail("通信が発生: " + network[0]);
if (errors.length) await fail("ページのエラー: " + errors[0]);
await browser.close();
console.log("link-flow: OK");

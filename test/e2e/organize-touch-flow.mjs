// スマホのページ整理：長押しドラッグで並べ替え（移動先のバーが出る）、浮きボタンは最後にタップしたカードだけ、削除は確認。
//   node test/e2e/organize-touch-flow.mjs
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
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "ja-JP" });
const page = await context.newPage();
// 試験は「ページ全体を表示」で行う（ページ上の位置を、ページ全体が見えている前提で指す）
await page.addInitScript(() => {
  try {
    localStorage.setItem("washi-pdf.fit", "page");
  } catch {}
});
const cdp = await context.newCDPSession(page);
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
const touch = async (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }] });

await page.goto("file://" + html);
await page.waitForSelector(".dropzone", { timeout: 30000 });
if (await page.$('button:has-text("破棄する")')) await page.click('button:has-text("破棄する")');
await page.setInputFiles('input[type="file"][accept*="pdf"]', [join(root, "test", "fixtures", "ja-vertical.pdf"), join(root, "test", "fixtures", "vector.pdf"), join(root, "test", "fixtures", "forms.pdf"), join(root, "test", "fixtures", "images.pdf")]);
await page.waitForSelector(".card", { timeout: 30000 });
await page.waitForFunction(() => document.querySelectorAll(".card img").length >= 4, null, { timeout: 30000 });
const labels = async () => page.$$eval(".card .src", (els) => els.map((e) => e.textContent.replace(/ p\.\d+$/, "")));
const before = await labels();
console.log("before:", before.join(", "));

// 1 枚目を長押しして 4 枚目の右側まで動かす
const cards = await page.$$(".card");
const b1 = await cards[0].boundingBox();
const b4 = await cards[3].boundingBox();
await touch("touchStart", b1.x + b1.width / 2, b1.y + b1.height / 2);
await page.waitForTimeout(600);
const dragging = await page.$(".card.dragging");
if (!dragging) fail("長押しでドラッグが始まりません");
for (let i = 1; i <= 8; i++) {
  const t = i / 8;
  await touch("touchMove", b1.x + b1.width / 2 + (b4.x + b4.width * 0.8 - b1.x - b1.width / 2) * t, b1.y + b1.height / 2 + (b4.y + b4.height / 2 - b1.y - b1.height / 2) * t);
  await page.waitForTimeout(30);
}
const indicator = await page.$(".card.drop-after, .card.drop-before");
if (!indicator) fail("移動先のバーが出ません");
await page.screenshot({ path: join(outDir, "organize-touch-drag.png") });
await touch("touchEnd", 0, 0);
await page.waitForTimeout(300);
const after = await labels();
console.log("after:", after.join(", "));
if (after[after.length - 1] !== before[0] || after[0] === before[0]) fail("並べ替えが反映されていません");
if (await page.$(".card.dragging")) fail("ドラッグ状態が残っています");

// 浮きボタン：タップしたカードにだけ出る。削除は confirm
await page.locator(".card").nth(1).tap();
await page.waitForTimeout(200);
const visibleBars = await page.$$eval(".card-actions", (els) => els.filter((e) => getComputedStyle(e).opacity === "1").length);
if (visibleBars !== 1) fail(`浮きボタンが ${visibleBars} 枚に出ています`);
const rotateButtons = await page.$$eval(".card.last .card-actions button", (els) => els.filter((e) => getComputedStyle(e).display !== "none").map((e) => e.getAttribute("title")));
console.log("float buttons:", rotateButtons.join(", "));
if (rotateButtons.includes("左回転")) fail("浮きボタンに左回転が残っています");
await page.locator(".card.last .card-actions button[title='削除']").tap();
// 削除の前に、アプリの確認が出る。キャンセルする
const asked = await page.locator(".confirm-dialog").waitFor({ timeout: 3000 }).then(() => true, () => false);
if (!asked) fail("削除の確認が出ません");
await page.locator(".confirm-dialog .btn:not(.primary)").last().tap();
await page.waitForTimeout(300);
if ((await page.$$(".card")).length !== 4) fail("キャンセルしたのにページが減っています");

await browser.close();
if (errors.length) fail(`ブラウザのエラー: ${errors}`);
console.log("OK: 長押しドラッグで並べ替え、浮きボタン 1 枚、削除は確認、エラーなし");

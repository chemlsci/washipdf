// 「名前を付けて保存」で保存先を選ぶ画面を出せない環境でも、何も起きないまま終わらないこと。
//  1. 画面が出る間もなく「取り消し」が返る（自動操作のブラウザ、アプリ内ブラウザなど）→ 名前を入力して保存する画面に切り替える
//  2. 権限などのエラーになる → 同じく切り替える
//  3. 利用者が自分で取り消した（時間をおいて取り消しが返る）→ 何も出さない
//   node test/e2e/saveas-picker-flow.mjs
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = process.cwd();
const html = process.env.WASHI_HTML ? join(root, process.env.WASHI_HTML) : join(root, "dist", "washi-pdf.html");
const browser = await chromium.launch();
const fail = async (m) => {
  console.error("FAIL:", m);
  await browser.close();
  process.exit(1);
};

for (const [label, mock, expectDialog] of [
  ["すぐに取り消しが返る", `window.showSaveFilePicker = async () => { throw new DOMException("The user aborted a request.", "AbortError"); };`, true],
  ["権限のエラーになる", `window.showSaveFilePicker = async () => { throw new DOMException("Not allowed", "SecurityError"); };`, true],
  ["利用者が取り消した", `window.showSaveFilePicker = () => new Promise((_, reject) => setTimeout(() => reject(new DOMException("The user aborted a request.", "AbortError")), 900));`, false],
]) {
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
  await page.addInitScript(mock);
  await page.goto("file://" + html);
  await page.waitForSelector(".dropzone", { timeout: 30000 });
  await page.setInputFiles('input[type="file"][accept*="pdf"]', join(root, "test", "fixtures", "ja-subset-identity.pdf"));
  await page.waitForSelector(".card", { timeout: 30000 });
  await page.click(".split-btn .menu-caret");
  await page.click('.menu-pop button:has-text("名前を付けて保存")');
  if (expectDialog) {
    await page.waitForSelector(".modal .field input", { timeout: 5000 }).catch(() => fail(`${label}: 名前を入力する画面に切り替わらない`));
    // そのまま保存すると、ダウンロードとして保存される
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), page.click(".modal .btn.primary")]);
    const size = (await (await download.createReadStream()).toArray()).reduce((n, c) => n + c.length, 0);
    if (size < 1000) await fail(`${label}: 保存されたファイルが小さすぎる（${size} B）`);
    console.log(`ok  ${label} → 名前を入力して保存（${size} B）`);
  } else {
    await page.waitForTimeout(1600);
    if (await page.locator(".modal").count()) await fail(`${label}: 取り消したのに画面が出た`);
    if (await page.locator(".toast.error, .error-banner").count()) await fail(`${label}: 取り消しをエラーとして出した`);
    console.log(`ok  ${label} → 何も出さない`);
  }
  if (errors.length) await fail(`${label}: ページのエラー: ${errors[0]}`);
  await context.close();
}
await browser.close();
console.log("saveas-picker-flow: OK");

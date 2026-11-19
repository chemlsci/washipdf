// 自動保存と復元：PDF を読み込んで文字を追加 → ページを開き直す → 「前回の作業を復元」で編集が戻ることを確認する。
// ついでにロゴ（ヘッダー・起動画面）と署名付き PDF の警告も確認する。
//   node test/e2e/draft-flow.mjs
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
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "ja-JP" });
const page = await context.newPage();
// 試験は「ページ全体を表示」で行う（ページ上の位置を、ページ全体が見えている前提で指す）
await page.addInitScript(() => {
  try {
    localStorage.setItem("washi-pdf.fit", "page");
      // この試験は自動保存を前提にする（ファイルで開いた版の既定は「切」）。試験の中で切り替えたあとは、その設定を残す
      if (localStorage.getItem("washi-pdf.autosave") == null) localStorage.setItem("washi-pdf.autosave", "on");
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
// 前回の下書きが残っていれば破棄して始める
if (await page.$('button:has-text("破棄する")')) await page.click('button:has-text("破棄する")');
if (!(await page.$(".hero svg")) || !(await page.$(".brand svg"))) fail("ロゴが表示されていません");

// 署名付き PDF：警告トースト
await page.setInputFiles('input[type="file"][accept*="pdf"]', join(root, "test", "fixtures", "signed.pdf"));
await page.waitForSelector(".card", { timeout: 30000 });
await page.waitForSelector(".toast", { timeout: 10000 });
const toast = await page.$eval(".toast", (el) => el.textContent);
console.log("toast:", toast);
if (!/電子署名/.test(toast)) fail("署名の警告が出ていません");

// 文字を追加して、自動保存を待つ
await page.click('button[role="tab"]:has-text("編集")');
await page.waitForSelector(".page-canvas");
await page.waitForFunction(() => !document.querySelector(".page-loading"));
await page.keyboard.press("t");
const pageBox = await (await page.$(".page")).boundingBox();
await page.mouse.click(pageBox.x + pageBox.width * 0.3, pageBox.y + pageBox.height * 0.5);
await page.waitForSelector("[contenteditable]");
await page.keyboard.insertText("復元テスト");
await page.keyboard.press("Escape");
await page.waitForSelector(".obj-text");
await page.waitForTimeout(2500);

// 開き直す → 復元を尋ねられる
await page.goto("file://" + html);
await page.waitForSelector('button:has-text("復元する")', { timeout: 15000 });
await page.screenshot({ path: join(outDir, "draft-prompt.png") });
await page.click('button:has-text("復元する")');
await page.waitForSelector(".card", { timeout: 30000 });
await page.click('button[role="tab"]:has-text("編集")');
await page.waitForSelector(".page-canvas");
await page.waitForSelector(".obj-text", { timeout: 15000 });
const text = await page.$eval(".obj-text", (el) => el.textContent);
console.log("restored text:", JSON.stringify(text));
if (!text.includes("復元テスト")) fail("編集が復元されていません");
await page.screenshot({ path: join(outDir, "draft-restored.png") });

// 保存までできる
const [download] = await Promise.all([page.waitForEvent("download"), page.click('button.btn.primary:has-text("保存")')]);
console.log("saved:", download.suggestedFilename());

// 破棄：次回は尋ねられない（下書きを消してから開き直す）
await page.evaluate(() => new Promise((res) => {
  const req = indexedDB.deleteDatabase("washi-pdf");
  req.onsuccess = req.onerror = req.onblocked = () => res();
}));
await browser.close();
if (network.length) fail(`外部への通信が発生しました: ${network}`);
if (errors.length) fail(`ブラウザのエラー: ${errors}`);
console.log("OK: 署名の警告、自動保存と復元、ロゴ、通信ゼロ、エラーなし");

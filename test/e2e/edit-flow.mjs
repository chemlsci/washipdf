// 実際の dist/washi-pdf.html を file:// で開き、既存文字の書き換え → 保存 までを通しで確認する。
// 同時に、ネットワーク要求が一切発生しないこと（通信ゼロ）を検証する。
//   node test/e2e/edit-flow.mjs [--headed]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

// playwright はプロジェクトの devDependency か、グローバルにあるものを使う
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = process.cwd();
// WASHI_HTML=dist/washi-pdf-zh-CN.html のように、別のビルドを対象にできる
const html = process.env.WASHI_HTML ? join(root, process.env.WASHI_HTML) : join(root, "dist", "washi-pdf.html");
const outDir = join(root, "dist", ".e2e");
mkdirSync(outDir, { recursive: true });
const mobile = process.argv.includes("--mobile");

const browser = await chromium.launch();
const context = await browser.newContext(
  mobile
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "ja-JP" }
    : { viewport: { width: 1400, height: 900 }, locale: "ja-JP" },
);
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

// PDF を読み込む
await page.setInputFiles('input[type="file"][accept*="pdf"]', join(root, "test", "fixtures", "ja-subset-identity.pdf"));
await page.waitForSelector(".card", { timeout: 30000 });
await page.screenshot({ path: join(outDir, "01-organize.png") });

// 編集画面へ
await page.click('button[role="tab"]:has-text("編集")');
await page.waitForSelector(".page-canvas");
await page.waitForFunction(() => !document.querySelector(".page-loading"));

// 既存文字ツール
await page.click('button.tool:has-text("既存文字")');
await page.waitForSelector(".run-box", { timeout: 30000 });
const boxes = await page.$$eval(".run-box", (els) => els.map((e) => ({ title: e.getAttribute("title"), noedit: e.classList.contains("noedit") })));
console.log("run boxes:", boxes.length, "non-editable:", boxes.filter((b) => b.noedit).length);
await page.screenshot({ path: join(outDir, "02-runs.png") });

// 1行目をクリックして書き換える（スマホでは画面下の入力欄で編集する）
const typeInto = async (text) => {
  if (mobile) {
    const ta = page.locator(".props textarea").first();
    await ta.waitFor();
    await ta.fill(text);
    await page.keyboard.press("Tab");
  } else {
    await page.waitForSelector("[contenteditable]");
    await page.keyboard.press("Control+A");
    await page.keyboard.type(text);
    await page.keyboard.press("Escape");
  }
};
const first = page.locator('.run-box[title*="株式会社サンプル商事"]');
await first.click({ timeout: 10000 }).catch(async (e) => {
  await page.screenshot({ path: join(outDir, "err-click.png") });
  throw e;
});
await typeInto("有限会社テスト工業 御中");
await page.waitForSelector(".obj-textedit");
await page.screenshot({ path: join(outDir, "03-edited.png") });

// プロパティで状態を確認
const note = await page.locator(".props .note").first().innerText();
console.log("props note:", note);

// 段落モードで 3 行ブロックを書き換え
await page.click('.seg.small button:has-text("段落")');
await page.locator('.run-box[title*="本書は自動テスト用"]').click();
await typeInto("差し替えた段落です。この文章は元の三行分の箱の中で、日本語の禁則処理を守りながら折り返されます。");
await page.waitForTimeout(300);
await page.screenshot({ path: join(outDir, "04-block.png") });

// 保存（ダウンロード）
const [download] = await Promise.all([page.waitForEvent("download"), page.click('button.btn.primary:has-text("保存")')]);
const saved = join(outDir, "edited.pdf");
await download.saveAs(saved);
console.log("saved:", saved, readFileSync(saved).length, "bytes");
await page.waitForTimeout(500);
await page.screenshot({ path: join(outDir, "05-saved.png") });

await browser.close();
writeFileSync(join(outDir, "network.json"), JSON.stringify(network, null, 2));
if (network.length) {
  console.error("外部への通信が発生しました:", network);
  process.exit(1);
}
if (errors.length) {
  console.error("ブラウザのエラー:", errors);
  process.exit(1);
}
console.log("OK: 通信ゼロ、エラーなし");

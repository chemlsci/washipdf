// パスワード付き PDF を開く（入力ダイアログ → 誤入力 → 正しい入力）→ 「パスワード保護」で AES-256 を設定 → 保存。
// 保存した PDF が暗号化されていることを pdf-lib で確認する。通信ゼロも検証する。
//   node test/e2e/security-flow.mjs
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { PDFDocument, PDFName, PDFNumber } from "pdf-lib";

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
await page.setInputFiles('input[type="file"][accept*="pdf"]', join(root, "test", "fixtures", "enc-aes-256.pdf"));

// パスワード入力ダイアログ：まず間違える
const dlg = page.locator('.modal[aria-label="パスワードが必要です"]');
await dlg.waitFor({ timeout: 30000 });
await dlg.locator('input[type="password"]').fill("wrong");
await dlg.locator('button:has-text("開く")').click();
await dlg.locator(".note.error").waitFor({ timeout: 10000 });
await page.screenshot({ path: join(outDir, "security-01-retry.png") });
await dlg.locator('input[type="password"]').fill("user");
await dlg.locator('input[type="password"]').press("Enter");
await page.waitForSelector(".card", { timeout: 30000 });
const toast = await page.locator(".toast").first().innerText().catch(() => "");
console.log("toast:", toast.replace(/\n/g, " "));

// ツール → パスワード保護
await page.click('button[role="tab"]:has-text("ツール")');
await page.click('.tool-card[data-tool="protect"]');
const prot = page.locator('.modal[aria-label="パスワード保護"]');
await prot.waitFor();
const info = await prot.locator(".note").first().innerText();
console.log("source info:", info);
if (!/AES-256/.test(info)) {
  console.error("元ファイルの保護方式が表示されていません:", info);
  process.exit(1);
}
await prot.locator('label:has-text("保存時にパスワードで保護する") input').check();
const pwInputs = prot.locator('input[type="password"]');
await pwInputs.nth(0).fill("e2e-open");
await pwInputs.nth(1).fill("e2e-owner");
await prot.locator('label:has-text("印刷") input').uncheck();
await page.screenshot({ path: join(outDir, "security-02-protect.png") });
await prot.locator('button.btn.primary:has-text("適用")').click();
await page.waitForSelector(".tool-card.active:has-text(\"パスワード保護\")");

// 保存
const [download] = await Promise.all([page.waitForEvent("download"), page.click('button.btn.primary:has-text("保存")')]);
const saved = join(outDir, "protected.pdf");
await download.saveAs(saved);
await browser.close();

const bytes = readFileSync(saved);
let rejected = false;
try {
  await PDFDocument.load(bytes);
} catch (e) {
  rejected = /encrypted/i.test(String(e));
}
if (!rejected) {
  console.error("保存した PDF が暗号化されていません");
  process.exit(1);
}
const lib = await PDFDocument.load(bytes, { ignoreEncryption: true });
const enc = lib.context.lookup(lib.context.trailerInfo.Encrypt);
const v = enc.get(PDFName.of("V"));
const p = enc.get(PDFName.of("P"));
console.log("Encrypt:", "V", v instanceof PDFNumber ? v.asNumber() : v, "P", p instanceof PDFNumber ? p.asNumber() : p);
if (!(v instanceof PDFNumber) || v.asNumber() !== 5 || !(p instanceof PDFNumber) || p.asNumber() & 4) {
  console.error("AES-256（V 5）で印刷不可になっていません");
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
console.log("OK: 解錠 → 保護して保存、通信ゼロ、エラーなし");

// 「パスワード保護」を設定した文書でも、いったん PDF を組み立ててから読み直す道具が動くこと。
//  1. 割り付け（N-up）：できあがった PDF は開けて、パスワード保護も掛かっている
//  2. 画像として保存：画像が書き出される
//  3. 文書の比較：比べられる
//  4. 名前に括弧のある添付ファイルを付けて保存しても、保存した PDF を開き直せる
//   node test/e2e/tools-protected-flow.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { PDFDocument } = require("pdf-lib");

const root = process.cwd();
const html = "file://" + (process.env.WASHI_HTML ? join(root, process.env.WASHI_HTML) : join(root, "dist", "washi-pdf.html"));
const outDir = join(root, "dist", ".e2e");
mkdirSync(outDir, { recursive: true });
const fx = (n) => join(root, "test", "fixtures", n);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "ja-JP", acceptDownloads: true });
const page = await context.newPage();
page.setDefaultTimeout(60000);
// 試験は「ページ全体を表示」で行う（ページ上の位置を、ページ全体が見えている前提で指す）
await page.addInitScript(() => {
  try {
    localStorage.setItem("washi-pdf.fit", "page");
  } catch {}
});
const errors = [];
const network = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("request", (r) => {
  const u = r.url();
  if (!u.startsWith("file://") && !u.startsWith("blob:") && !u.startsWith("data:")) network.push(u);
});
const fail = async (m) => {
  console.error("FAIL:", m);
  await browser.close();
  process.exit(1);
};
const idle = async () => {
  await page.waitForFunction(() => !document.querySelector(".busy"), null, { timeout: 180000 });
  await page.waitForTimeout(250);
};
const errorToast = () => page.locator(".toast.error").allInnerTexts();

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const pdfjsDir = join(require.resolve("pdfjs-dist/package.json"), "..");
const open = (file, password) => pdfjs.getDocument({ isEvalSupported: false, standardFontDataUrl: `${join(pdfjsDir, "standard_fonts")}/`, cMapUrl: `${join(pdfjsDir, "cmaps")}/`, cMapPacked: true, data: new Uint8Array(readFileSync(file)), password, verbosity: 0 }).promise;
const isEncrypted = async (file) => {
  try {
    await PDFDocument.load(readFileSync(file));
    return false;
  } catch (e) {
    return /encrypted/i.test(String(e));
  }
};

await page.goto(html);
await page.waitForSelector(".dropzone");
await page.setInputFiles('input[type="file"][accept*="pdf"]', [fx("ja-subset-identity.pdf"), fx("en-standard14.pdf")]);
await page.waitForFunction(() => document.querySelectorAll(".card").length === 2);
await idle();
await page.click('button[role="tab"]:has-text("ツール")');

// 添付ファイル：名前に、閉じない括弧と末尾の \ がある
const odd = join(outDir, "memo (1.txt");
writeFileSync(odd, "attachment body");
await page.click('.tool-card[data-tool="attachments"]');
await page.setInputFiles('.modal input[type="file"]', odd);
await page.waitForSelector(".attach-row");
await page.click(".modal .modal-foot button.primary");

// パスワード保護（全角のパスワード：注意を出すが、設定はできる）
await page.click('.tool-card[data-tool="protect"]');
const prot = page.locator('.modal[aria-label="パスワード保護"]');
await prot.locator('input[type="checkbox"]').first().check();
await prot.locator('input[type="password"]').first().fill("ｐｗ９ａ");
const warn = await prot.locator(".note.warn").innerText().catch(() => "");
if (!warn.includes("ほかのソフト")) await fail(`全角のパスワードへの注意が出ていない: ${warn}`);
const rc4 = await prot.locator('select option[value="rc4"]').innerText();
if (!rc4.includes("弱い")) await fail(`RC4 が弱い方式だと書かれていない: ${rc4}`);
await page.screenshot({ path: join(outDir, "tools-protected-dialog.png") });
await prot.locator('input[type="password"]').first().fill("pw-9a");
if (await prot.locator(".note.warn").count()) await fail("半角の英数字のパスワードに注意が出ている");
await prot.locator(".modal-foot button.primary").click();
await page.waitForSelector('.tool-card.active[data-tool="protect"]');

// 1. 割り付け
await page.click('.tool-card[data-tool="nup"]');
const nup = page.locator('.modal[aria-label="割り付け・小冊子（N-up）"]');
await nup.waitFor();
if (!(await nup.locator(".note").allInnerTexts()).join(" ").includes("注釈と入力欄")) await fail("割り付け：注釈と入力欄の扱いが書かれていない");
const [dl1] = await Promise.all([page.waitForEvent("download"), nup.locator(".modal-foot button.primary").click()]);
await idle();
const nupFile = join(outDir, "tools-protected-nup.pdf");
await dl1.saveAs(nupFile);
if ((await errorToast()).length) await fail(`割り付け：エラーが出た: ${await errorToast()}`);
if (!(await isEncrypted(nupFile))) await fail("割り付け：できあがった PDF にパスワード保護が掛かっていない");
if ((await open(nupFile, "pw-9a")).numPages !== 1) await fail("割り付け：ページ数が違う");
console.log("ok  1. 割り付け：保護を設定した文書でも作れ、できあがった PDF にも保護が掛かる");

// 2. 画像として保存
await page.click('.tool-card[data-tool="toImages"]');
await page.waitForSelector(".modal");
const [dl2] = await Promise.all([page.waitForEvent("download"), page.click(".modal .modal-foot button.primary")]);
await idle();
if ((await errorToast()).length) await fail(`画像として保存：エラーが出た: ${await errorToast()}`);
const zip = join(outDir, "tools-protected-images.zip");
await dl2.saveAs(zip);
if (readFileSync(zip).length < 5000) await fail("画像として保存：書き出されたファイルが小さすぎる");
console.log(`ok  2. 画像として保存：${dl2.suggestedFilename()}（${readFileSync(zip).length} B）`);

// 3. 文書の比較
await page.click('.tool-card[data-tool="compare"]');
const cmp = page.locator('.modal[aria-label="文書の比較"]');
await cmp.waitFor();
await cmp.locator('input[type="file"]').setInputFiles(fx("ja-subset-identity.pdf"));
await cmp.locator(".compare-head").waitFor({ timeout: 120000 }).catch(async () => fail(`文書の比較：結果が出ない: ${await errorToast()}`));
await page.waitForFunction(() => /\d+ \/ \d+$/.test(document.querySelector(".compare-head b")?.textContent?.trim() ?? ""), null, { timeout: 120000 });
if ((await errorToast()).length) await fail(`文書の比較：エラーが出た: ${await errorToast()}`);
console.log("ok  3. 文書の比較：", await cmp.locator(".compare-head b").innerText());
await page.keyboard.press("Escape");

// 4. 保存：開き直せて、保護が掛かり、添付の名前がそのまま残る
const [dl4] = await Promise.all([page.waitForEvent("download"), page.click('button.btn.primary:has-text("保存")')]);
await idle();
const saved = join(outDir, "tools-protected-saved.pdf");
await dl4.saveAs(saved);
if ((await errorToast()).length) await fail(`保存：エラーが出た: ${await errorToast()}`);
if (!(await isEncrypted(saved))) await fail("保存：パスワード保護が掛かっていない");
const doc = await open(saved, "pw-9a");
const atts = await doc.getAttachments();
const names = (atts instanceof Map ? [...atts.values()] : Object.values(atts ?? {})).map((a) => a.rawFilename ?? a.filename);
if (doc.numPages !== 2 || names.length !== 1 || names[0] !== "memo (1.txt") await fail(`保存：ページ数か添付の名前が違う: ${doc.numPages} ページ、${JSON.stringify(names)}`);
// アプリでも開き直せて、添付の名前が同じ
await page.click('header [data-action="close"]');
await page.click(".confirm-dialog button.primary");
await page.waitForSelector(".dropzone");
await page.setInputFiles('input[type="file"][accept*="pdf"]', saved);
const pw = page.locator('.modal[aria-label="パスワードが必要です"]');
await pw.waitFor();
await pw.locator('input[type="password"]').fill("pw-9a");
await pw.locator('input[type="password"]').press("Enter");
await page.waitForFunction(() => document.querySelectorAll(".card").length === 2);
await idle();
await page.waitForTimeout(1500);
await page.click('button[role="tab"]:has-text("ツール")');
await page.click('.tool-card[data-tool="attachments"]');
await page.waitForSelector(".attach-row");
const shown = await page.locator(".attach-row b").allInnerTexts();
if (shown.length !== 1 || shown[0] !== "memo (1.txt") await fail(`開き直した文書の添付の名前が違う: ${JSON.stringify(shown)}`);
// 取り出すときは、種類の分からないファイルとして渡す（ブラウザーに開かせない）
const [dl5] = await Promise.all([page.waitForEvent("download"), page.click(".attach-row .icon-btn >> nth=0")]);
if (!dl5.suggestedFilename().startsWith("memo (1")) await fail(`添付の取り出しの名前が違う: ${dl5.suggestedFilename()}`);
console.log(`ok  4. 括弧のある名前の添付つきで保存：開き直せて、名前がそのまま残る（取り出し: ${dl5.suggestedFilename()}）`);

await browser.close();
if (network.length) await fail(`外部への通信: ${network[0]}`);
if (errors.length) await fail(`ブラウザのエラー: ${errors[0]}`);
console.log("tools-protected-flow: OK");

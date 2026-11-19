// 個人情報のひな形で墨消し：検索と置換・墨消し →「墨消し」→ ひな形（電話番号・メール・郵便番号・マイナンバー）を選ぶと、
// その形の文字列が一覧に出る。日付や長い注文番号は電話番号として出ない。墨消しして保存すると、PDF から取り出せない。
//   node test/e2e/pii-flow.mjs
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const pdfjsDir = join(require.resolve("pdfjs-dist/package.json"), "..");

const root = process.cwd();
const html = process.env.WASHI_HTML ? join(root, process.env.WASHI_HTML) : join(root, "dist", "washi-pdf.html");
const outDir = join(root, "dist", ".e2e");
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "ja-JP", acceptDownloads: true })).newPage();
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
  await page.screenshot({ path: join(outDir, "pii-fail.png") });
  await browser.close();
  process.exit(1);
};

await page.goto("file://" + html);
await page.waitForSelector(".dropzone");
await page.setInputFiles('input[type="file"][accept*="pdf"]', join(root, "test", "fixtures", "ja-pii-libreoffice.pdf"));
await page.waitForSelector(".card");
await page.click('button[role="tab"]:has-text("ツール")');
await page.fill(".tool-search input", "検索と置換");
await page.click('.tool-card[data-tool="find"]');
await page.waitForSelector(".modal");
await page.click('.modal .seg button:has-text("墨消し")');
const listed = async (chip) => {
  await page.click(`.modal .chip:has-text("${chip}")`);
  await page.waitForFunction(() => document.querySelector(".find-list li") || /見つかりません/.test(document.querySelector(".modal")?.textContent ?? ""), null, { timeout: 30000 });
  await page.waitForTimeout(300);
  return page.locator(".find-list li mark").allInnerTexts();
};
const phones = await listed("電話番号");
if (phones.join("|") !== "03-1234-5678|090-1111-2222") await fail(`電話番号の一致が違う: ${phones.join("|")}`);
const mails = await listed("メールアドレス");
if (mails.join("|") !== "taro.test@example.com") await fail(`メールの一致が違う: ${mails.join("|")}`);
const postal = await listed("郵便番号");
if (postal.join("|") !== "〒100-0001") await fail(`郵便番号の一致が違う: ${postal.join("|")}`);
const myno = await listed("マイナンバー");
if (myno.join("|") !== "1234 5678 9012") await fail(`マイナンバーの一致が違う: ${myno.join("|")}`);
console.log(`ok  ひな形で見つけた：電話 ${phones.length}・メール ${mails.length}・郵便番号 ${postal.length}・マイナンバー ${myno.length}（日付と注文番号は出ない）`);

// 電話番号を墨消しして保存
await listed("電話番号");
await page.click(".modal-foot .btn.primary");
await page.waitForSelector(".modal", { state: "detached" });
const [download] = await Promise.all([page.waitForEvent("download"), page.click('button.btn.primary:has-text("保存")')]);
const saved = join(outDir, "pii-redacted.pdf");
await download.saveAs(saved);
const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(saved)), isEvalSupported: false, standardFontDataUrl: `${join(pdfjsDir, "standard_fonts")}/`, cMapUrl: `${join(pdfjsDir, "cmaps")}/` }).promise;
const text = (await (await pdf.getPage(1)).getTextContent()).items.map((it) => it.str ?? "").join("");
for (const w of ["03-1234-5678", "1234-5678", "090-1111-2222"]) if (text.includes(w)) await fail(`保存した PDF に「${w}」が残っている`);
for (const w of ["taro.test@example.com", "2026-01-15"]) if (!text.includes(w)) await fail(`消していない「${w}」が無くなった`);
console.log("ok  電話番号を墨消しして保存：取り出せない。ほかの文字は残る");

if (network.length) await fail("通信が発生: " + network[0]);
if (errors.length) await fail("ページのエラー: " + errors[0]);
await browser.close();
console.log("pii-flow: OK");

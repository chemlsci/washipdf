// まとめて処理：3 つの PDF（個人情報入り・ふつうの文書・開くのにパスワードが要るもの）を選び、電話番号の墨消し・透かし・ページ番号を
// まとめてかける。処理できた 2 つが ZIP で保存され、電話番号は取り出せず、透かしとページ番号が入る。パスワードの要るものは失敗として出る。
//   node test/e2e/batch-flow.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
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
const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: "ja-JP", acceptDownloads: true })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const network = [];
page.on("request", (r) => {
  const u = r.url();
  if (!u.startsWith("file://") && !u.startsWith("blob:") && !u.startsWith("data:")) network.push(u);
});
const fail = async (msg) => {
  console.error("FAIL:", msg);
  await page.screenshot({ path: join(outDir, "batch-fail.png") });
  await browser.close();
  process.exit(1);
};
const fx = (f) => join(root, "test", "fixtures", f);

await page.goto("file://" + html);
await page.waitForSelector(".dropzone");
await page.setInputFiles('input[type="file"][accept*="pdf"]', fx("en-standard14.pdf"));
await page.waitForSelector(".card");
await page.click('button[role="tab"]:has-text("ツール")');
await page.fill(".tool-search input", "まとめて処理");
await page.click('.tool-card[data-tool="batch"]');
await page.waitForSelector(".modal");
await page.setInputFiles('.modal input[type="file"]', [fx("ja-pii-libreoffice.pdf"), fx("ja-libreoffice-writer.pdf"), fx("enc-aes-256.pdf")]);
await page.click('.modal .chip:has-text("電話番号")');
await page.check('.modal label:has-text("透かしを入れる") input');
await page.fill('.modal input[placeholder^="透かし"]', "社外秘");
await page.check('.modal label:has-text("ページ番号を入れる") input');
const [download] = await Promise.all([page.waitForEvent("download", { timeout: 120000 }), page.click('.modal-foot .btn.primary')]);
const zip = join(outDir, "batch.zip");
await download.saveAs(zip);
await page.waitForSelector(".batch-results li");
const rows = await page.locator(".batch-results li").allInnerTexts();
console.log("結果：", rows.map((s) => s.replace(/\s+/g, " ")).join(" / "));
if (rows.length !== 3 || !rows[0].includes("墨消し 2") || !rows[2].includes("パスワード")) await fail(`ファイルごとの結果が違う: ${JSON.stringify(rows)}`);
const dir = join(outDir, "batch");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir);
execFileSync("unzip", ["-q", zip, "-d", dir]);
const textOf = async (file) => {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(join(dir, file))), isEvalSupported: false, standardFontDataUrl: `${join(pdfjsDir, "standard_fonts")}/`, cMapUrl: `${join(pdfjsDir, "cmaps")}/` }).promise;
  return (await (await pdf.getPage(1)).getTextContent()).items.map((it) => it.str ?? "").join("");
};
const pii = await textOf("ja-pii-libreoffice.pdf");
if (pii.includes("03-1234-5678") || pii.includes("090-1111-2222")) await fail("電話番号が残っている");
if (!pii.includes("taro.test@example.com")) await fail("消していないメールが無くなった");
if (!pii.includes("社外秘") || !/1\s*\/\s*1/.test(pii)) await fail(`透かしかページ番号が入っていない: ${pii.slice(-80)}`);
const other = await textOf("ja-libreoffice-writer.pdf");
if (!other.includes("社外秘")) await fail("2 つ目に透かしが入っていない");
console.log("ok  ZIP の中：電話番号は消え、透かし・ページ番号が入る。パスワードの要る PDF は失敗として出る");
if (network.length) await fail("通信が発生: " + network[0]);
if (errors.length) await fail("ページのエラー: " + errors[0]);
await browser.close();
console.log("batch-flow: OK");

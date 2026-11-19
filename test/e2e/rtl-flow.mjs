// 右から左へ書く文字（アラビア語・ヘブライ語）：既存の行を選んで語を書き換え、編集中のページに保存結果が表示されること、
// 保存した PDF に新しい語が入り、元の語が残っていないことを確かめる。通信ゼロも検証する。
//   node test/e2e/rtl-flow.mjs
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
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "ja-JP", acceptDownloads: true });
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
const fail = async (msg) => {
  console.error("FAIL:", msg);
  await browser.close();
  process.exit(1);
};

await page.goto("file://" + html);
await page.waitForSelector(".dropzone", { timeout: 30000 });
await page.setInputFiles('input[type="file"][accept*="pdf"]', join(root, "test", "fixtures", "rtl-chromium.pdf"));
await page.waitForSelector(".card", { timeout: 30000 });
await page.click('button[role="tab"]:has-text("編集")');
await page.waitForSelector(".page-canvas");
await page.waitForFunction(() => !document.querySelector(".page-loading"));
await page.click('button.tool:has-text("既存文字")').catch(async () => {
  await page.click('button.tool[title*="既存"]');
});
await page.waitForSelector(".run-box", { timeout: 30000 });

// 行はどれも書き換えの対象（上書きのみの行が無い）で、行の文字列は読む順になっている
const titles = await page.locator(".run-box").evaluateAll((els) => els.map((e) => e.getAttribute("title") ?? ""));
const noedit = await page.locator(".run-box.noedit").count();
if (titles.length < 7) await fail(`行の数が足りない: ${titles.length}`);
if (noedit) await fail(`上書きのみの行がある: ${noedit}`);
for (const want of ["مرحبا بالعالم، هذه وثيقة اختبار رقم 2026.", "שלום עולם, זהו מסמך בדיקה מספר 2026."]) if (!titles.some((t) => t.includes(want))) await fail(`行の文字列が読む順になっていない: ${want}`);
console.log(`ok  行 ${titles.length}（上書きのみ 0）。アラビア語・ヘブライ語の行が読む順の文字列になっている`);

// 語を書き換える：アラビア語（語の置き換え）、ヘブライ語（語を足す）
const edits = [
  ["مرحبا بالعالم", "اختبار", "جديدة"],
  ["שלום עולם", "עולם,", "עולם חדש,"],
];
for (const [find, from, to] of edits) {
  const now = await page.locator(".run-box").evaluateAll((els) => els.map((e) => e.getAttribute("title") ?? ""));
  const i = now.findIndex((t) => t.includes(find));
  if (i < 0) await fail(`行が見つからない: ${find}`);
  const box = page.locator(".run-box").nth(i);
  await box.scrollIntoViewIfNeeded();
  await box.click();
  await page.waitForTimeout(300);
  const ta = page.locator(".props textarea").first();
  const before = await ta.inputValue();
  if (!before.includes(from)) await fail(`入力欄の文字列に「${from}」が無い: ${before}`);
  await ta.fill(before.replace(from, to));
  await page.waitForTimeout(300);
}
// 編集中のページに、保存結果そのもの（帯）が表示される
await page.waitForSelector(".obj-exact", { timeout: 20000 });
await page.waitForTimeout(800);
const bands = await page.locator(".obj-exact").count();
if (bands < 1) await fail("保存結果の表示（帯）が出ていない");
await page.screenshot({ path: join(outDir, "rtl-edit.png") });
console.log(`ok  語を書き換え、編集中のページに保存結果を表示（帯 ${bands}）`);

// 保存して中身を確かめる
const [download] = await Promise.all([page.waitForEvent("download"), page.click('button.btn.primary:has-text("保存")')]);
const saved = join(outDir, "rtl-edited.pdf");
await download.saveAs(saved);
const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(saved)), isEvalSupported: false, standardFontDataUrl: `${join(pdfjsDir, "standard_fonts")}/`, cMapUrl: `${join(pdfjsDir, "cmaps")}/` }).promise;
// 元の文書の字は、語頭・語中・語尾の形のまま（表示順で）取り出されることがある。もとの字にそろえてから比べる
const text = (await (await pdf.getPage(1)).getTextContent()).items.map((it) => it.str ?? "").join(" ").normalize("NFKC");
const rev = (s) => [...s].reverse().join("");
// 元の文書で 1 字ごとに「代わりの文字」の囲みが付いている語（Chromium・LibreOffice の出力）は、残した字にも同じ囲みを付け直すので、
// 取り出すと元の文書と同じく字ごとに区切られる（語の先頭の字は、隣の空白と一緒に取り出されることがある）。空白を除いた形でも比べる
const compact = text.replace(/\s+/g, "");
const has = (w) => text.includes(w) || text.includes(rev(w)) || compact.includes(w) || compact.includes(rev(w));
for (const w of ["جديدة", "חדש"]) if (!has(w)) await fail(`保存した PDF に「${w}」が無い`);
if (has("اختبار")) await fail("置き換えた元の語が残っている");
for (const w of ["2026", "מסמך", "ثيقة"]) if (!has(w)) await fail(`変えていない語「${w}」が無くなった`);
const toast = (await page.locator(".toast").textContent().catch(() => "")) ?? "";
if (/書き換えられませんでした/.test(toast)) await fail(`書き換えられなかった行がある: ${toast}`);
console.log("ok  保存した PDF：新しい語が入り、置き換えた語は残っていない");

if (network.length) await fail("通信が発生: " + network[0]);
if (errors.length) await fail("ページのエラー: " + errors[0]);
await browser.close();
console.log("rtl-flow: OK");

// 文書の比較をブラウザで通して確認する：ページの追加を対応づけ、変わった語だけに色を付ける。通信ゼロも検証する。
//   node test/e2e/compare-flow.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = process.cwd();
const html = join(root, "dist", "washi-pdf.html");
const outDir = join(root, "dist", ".e2e");
mkdirSync(outDir, { recursive: true });

const SENT = ["Check the valve pressure before starting the pump.", "Report any abnormal reading to the supervisor.", "Record the result in the daily log.", "Wear protective gloves at all times."];
/** n ページの手順書。edit(ページ番号, 行) で行を書き換え、insertAt の前に 1 ページ足す */
async function makePdf(n, { insertAt = -1, edit = (_p, l) => l } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = (lines) => {
    const p = doc.addPage([595, 842]);
    lines.forEach((l, i) => p.drawText(l, { x: 50, y: 780 - i * 22, size: 11, font }));
  };
  for (let p = 1; p <= n; p++) {
    if (p === insertAt) page(["Appendix", "This page was inserted."]);
    const lines = [`Chapter ${p}`];
    for (let k = 1; k <= 20; k++) lines.push(edit(p, `${p}-${k} ${SENT[(p + k) % SENT.length]}`));
    page(lines);
  }
  return doc.save();
}
const a = join(outDir, "compare-a.pdf");
const b = join(outDir, "compare-b.pdf");
writeFileSync(a, await makePdf(5));
writeFileSync(b, await makePdf(5, { insertAt: 3, edit: (p, l) => (p === 5 && l.startsWith("5-4 ") ? l.replace("supervisor", "manager") : l) }));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "ja-JP" });
const page = await context.newPage();
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
const fail = async (msg) => {
  console.error(msg);
  await page.screenshot({ path: join(outDir, "compare-fail.png") }).catch(() => {});
  process.exit(1);
};

await page.goto("file://" + html);
await page.waitForSelector(".dropzone", { timeout: 30000 });
await page.setInputFiles('input[type="file"][accept*="pdf"]', [a]);
await page.waitForFunction(() => document.querySelectorAll(".card").length === 5, null, { timeout: 30000 });
await page.click('button[role="tab"]:has-text("ツール")');
await page.click('.tool-card[data-tool="compare"]');
const cmp = page.locator('.modal[aria-label="文書の比較"]');
await cmp.waitFor();
await cmp.locator('input[type="file"]').setInputFiles(b);
await cmp.locator(".compare-head").waitFor({ timeout: 60000 });
await page.waitForFunction(() => /\d+ \/ \d+$/.test(document.querySelector(".compare-head b")?.textContent?.trim() ?? ""), null, { timeout: 60000 });
const summary = (await cmp.locator(".compare-head b").innerText()).trim();
console.log("compare:", summary);
if (!/2 \/ 6$/.test(summary)) await fail(`比較の結果が想定と違います: ${summary}`);
// ページごとの結果の地図：6 件のうち、追加 1・変更 1
const cells = await cmp.locator(".cmp-cell").evaluateAll((els) => els.map((e) => e.className));
console.log("map:", cells.join(" | "));
if (cells.length !== 6 || cells.filter((c) => c.includes("add")).length !== 1 || cells.filter((c) => c.includes("changed")).length !== 1) await fail("地図が想定と違います");
// 最初の違い（足したページ）が表示されている
const pair = await cmp.locator(".compare-pair").innerText();
if (!/— .*3/.test(pair)) await fail(`最初の違いに移っていません: ${pair}`);
// 次の違い：変わった語だけに色が付く
await cmp.locator('button:has-text("次の違い")').click();
await page.waitForFunction(() => document.querySelectorAll(".cmp-mark").length >= 2, null, { timeout: 30000 });
const marks = await cmp.locator(".cmp-mark").allInnerTexts();
console.log("marks:", marks);
if (marks.map((m) => m.trim()).sort().join(",") !== "manager,supervisor") await fail(`色付けが想定と違います: ${marks}`);
await page.screenshot({ path: join(outDir, "compare-word.png") });
// 拡大・縮小
await cmp.locator('button[aria-label="拡大"]').click();
if ((await cmp.locator(".compare-zoom").innerText()).trim() !== "150%") await fail("拡大できません");
// 一覧の違いを押すと、その違いが選ばれ、拡大してその場所へ移る
await cmp.locator(".compare-text li.add").first().click();
await page.waitForFunction(() => document.querySelector(".compare-text li.on") && document.querySelector(".compare-zoom")?.textContent?.trim() === "200%", null, { timeout: 10000 });
await page.waitForTimeout(500);
// 変えた語はページの上の方・右寄りにあるので、横に動いているはず
const scrolled = await cmp.locator(".cmp-scroll").evaluateAll((els) => els.map((e) => [e.scrollLeft, e.scrollTop]));
console.log("scroll:", JSON.stringify(scrolled));
if (!scrolled.every(([x]) => x > 0)) await fail("選んだ違いの場所へ移っていません");
await page.screenshot({ path: join(outDir, "compare-zoom.png") });
// 書き出し：Markdown
const [mdDl] = await Promise.all([page.waitForEvent("download"), cmp.locator('button:has-text("Markdown")').click()]);
const md = readFileSync(await mdDl.path(), "utf8");
if (!md.includes("~~supervisor~~") || !md.includes("**manager**")) await fail(`Markdown の中身が想定と違います:\n${md}`);
// 書き出し：注釈付き PDF（比べた PDF の、変わった語にハイライト）
const [pdfDl] = await Promise.all([page.waitForEvent("download"), cmp.locator('button:has-text("注釈付き PDF")').click()]);
const annotated = await PDFDocument.load(readFileSync(await pdfDl.path()));
const subtypes = annotated.getPages().flatMap((pg) => {
  const annots = pg.node.Annots();
  return annots ? annots.asArray().map((r) => String(annotated.context.lookup(r).get(PDFName.of("Subtype")))) : [];
});
console.log("annots:", subtypes.join(" "));
if (annotated.getPageCount() !== 6 || !subtypes.includes("/Highlight") || !subtypes.includes("/Text")) await fail("注釈付き PDF が想定と違います");
// 書き出し：いまの文書に報告を挿入（末尾にページが増える）
await cmp.locator('button:has-text("報告をいまの文書に挿入")').click();
// 見出しのページ数が増える（ツールの画面なので、ページの一覧は出ていない）
await page
  .waitForFunction(() => Number(/(\d+) ページ/.exec(document.querySelector("header")?.textContent ?? "")?.[1] ?? 0) > 5, null, { timeout: 60000 })
  .catch(async () => fail(`報告が挿入されません: ${await page.locator("header").innerText()} / ${errors}`));
console.log("header after insert:", (await page.locator("header").innerText()).replace(/\s+/g, " ").slice(0, 80));
// 空白の扱いの切り替え（文字の比較だけをやり直す。結果は変わらない）
await cmp.locator('.compare-sub input[type="checkbox"]').uncheck();
if (!/2 \/ 6$/.test((await cmp.locator(".compare-head b").innerText()).trim())) await fail("切り替えで結果が変わりました");
// 挿入した報告のページを見る（ページ整理の画面）
await page.keyboard.press("Escape");
await page.click('button[role="tab"]:has-text("ページ整理")');
await page.waitForFunction(() => document.querySelectorAll(".card").length === 8, null, { timeout: 30000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: join(outDir, "compare-report.png") });
await browser.close();

if (network.length) await fail(`外部への通信が発生しました: ${network}`);
if (errors.length) await fail(`ブラウザのエラー: ${errors}`);
console.log("OK: 文書の比較（ページの対応づけ・語の色付け）、通信ゼロ、エラーなし");

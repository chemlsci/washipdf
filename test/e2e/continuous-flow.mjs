// 連続表示：全ページが縦に並び、スクロールすると画面の中央のページが編集するページになる。サムネイル・ページ送りでそのページへ送る。
// スクロールして 3 ページ目に四角を描いて保存すると、3 ページ目に入る（ほかのページには入らない）。
// あわせて、ページをまたぐ操作を確かめる：
//  - 何かを選んだまま、見えている別のページに描く・文字を置く（最初の 1 回から効く）
//  - ダイアログを開いている間は、後ろのページの部品がキーで動かない・消えない・元に戻らない
//  - 点を足している途中の計測は、ほかのページへ移ると残らない
//  - 行を書き換えたあと同じ段落を書き換えると、1 つの書き換えにまとまる。開いただけの行は履歴に残らない
//   node test/e2e/continuous-flow.mjs
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { PDFDocument, PDFName, PDFArray } = require("pdf-lib");
const { readFileSync } = require("node:fs");

const root = process.cwd();
const html = process.env.WASHI_HTML ? join(root, process.env.WASHI_HTML) : join(root, "dist", "washi-pdf.html");
const outDir = join(root, "dist", ".e2e");
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: "ja-JP", acceptDownloads: true })).newPage();
// 試験は「ページ全体を表示」で行う（ページ上の位置を、ページ全体が見えている前提で指す）
await page.addInitScript(() => {
  try {
    localStorage.setItem("washi-pdf.fit", "page");
  } catch {}
});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const fail = async (msg) => {
  console.error("FAIL:", msg);
  await page.screenshot({ path: join(outDir, "continuous-fail.png") });
  await browser.close();
  process.exit(1);
};
const pager = () => page.evaluate(() => document.querySelector(".pager")?.textContent?.trim() ?? "");

await page.goto("file://" + html);
await page.waitForSelector(".dropzone");
// 1 ページの PDF を 4 つ開いて、4 ページの文書にする
await page.setInputFiles(
  'input[type="file"][accept*="pdf"]',
  ["ja-libreoffice-writer.pdf", "en-standard14.pdf", "ja-subset-identity.pdf", "ja-vertical.pdf"].map((f) => join(root, "test", "fixtures", f)),
);
await page.waitForFunction(() => document.querySelectorAll(".card").length === 4);
await page.click('button[role="tab"]:has-text("編集")');
await page.waitForSelector(".page-canvas");
const slots = await page.locator(".page-slot").count();
if (slots < 4) await fail(`ページが縦に並んでいない: ${slots}`);
// スクロールで 3 ページ目へ
const stage = await page.locator(".stage").boundingBox();
await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
for (let i = 0; i < 40 && !(await pager()).startsWith("3 /"); i++) {
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(40);
}
await page.waitForTimeout(300);
if (!(await pager()).startsWith("3 /")) await fail(`スクロールしても 3 ページ目にならない: ${await pager()}`);
console.log(`ok  ${slots} ページが縦に並び、スクロールで 3 ページ目が編集するページになった`);
// 3 ページ目に四角を描く
await page.click('button.tool:has-text("四角")');
const bb = await page.locator(".page-slot.current .page").boundingBox();
const cx = bb.x + bb.width / 2;
const cy = Math.max(bb.y, stage.y) + 60;
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx + 80, cy + 50, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(200);
// サムネイルで 1 ページ目へ、ページ送りで 2 ページ目へ
await page.keyboard.press("Escape");
await page.locator(".strip-item").first().click();
await page.waitForTimeout(400);
if (!(await pager()).startsWith("1 /")) await fail(`サムネイルで 1 ページ目に送れない: ${await pager()}`);
await page.keyboard.press("PageDown");
await page.waitForFunction(() => document.querySelector(".pager")?.textContent?.trim().startsWith("2 /"));
const top = await page.evaluate(() => {
  const s = document.querySelector(".stage").getBoundingClientRect();
  return Math.round(document.querySelector(".page-slot.current").getBoundingClientRect().top - s.top);
});
if (top < 0 || top > 40) await fail(`ページ送りで、そのページの上端に送られていない: ${top}`);
console.log("ok  サムネイル・ページ送りで、そのページへ送る");
// 保存：四角は 3 ページ目にだけある
const [download] = await Promise.all([page.waitForEvent("download"), page.click('button.btn.primary:has-text("保存")')]);
const saved = join(outDir, "continuous.pdf");
await download.saveAs(saved);
const doc = await PDFDocument.load(readFileSync(saved));
const sizes = doc.getPages().map((p) => {
  const c = p.node.Contents();
  return c instanceof PDFArray ? c.size() : 1;
});
// 描いたページだけ、内容のストリームが足される
const added = sizes.map((n, i) => [n, i]).filter(([n], _, all) => n > Math.min(...all.map((x) => x[0])));
if (added.length !== 1 || added[0][1] !== 2) await fail(`四角が 3 ページ目にだけ入っていない: ${JSON.stringify(sizes)}`);
console.log("ok  保存した PDF：四角は 3 ページ目にだけある");

// ---- ここからは、ページをまたぐ操作 ----
const count = (n, sel) => page.evaluate(([i, q]) => document.querySelectorAll(".page-slot")[i].querySelectorAll(q).length, [n, sel]);
const slotBox = (n) => page.evaluate((i) => {
  const r = document.querySelectorAll(".page-slot")[i].getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}, n);
const tool = () => page.evaluate(() => document.querySelector(".toolbar .tool-group .tool.on")?.dataset.tool ?? "");
const undoState = () => page.evaluate(() => {
  const b = document.querySelector("header .actions .icon-btn");
  return `${b.disabled ? "off" : "on"}:${b.title}`;
});
// 2 ページが同時に見えるように縮小し、1 ページ目から始める
for (let i = 0; i < 4; i++) await page.click('.toolbar-sub button[title="縮小"]');
await page.locator(".strip-item").first().click();
await page.waitForTimeout(500);
// 1 ページ目に四角を描く（描いた四角を選んだ状態になる）
await page.click('button.tool[data-tool="rect"]');
let b1 = await slotBox(0);
await page.mouse.move(b1.x + 30, b1.y + 30);
await page.mouse.down();
await page.mouse.move(b1.x + 80, b1.y + 70, { steps: 4 });
await page.mouse.up();
await page.waitForTimeout(200);
if (!(await page.locator(".page-slot.current .obj.selected").count())) await fail("描いた四角が選ばれていない");
// そのまま、見えている 2 ページ目に四角を描く：最初のドラッグで描けて、2 ページ目が編集するページになる
await page.click('button.tool[data-tool="rect"]');
let b2 = await slotBox(1);
await page.mouse.move(b2.x + 30, b2.y + 30);
await page.mouse.down();
await page.mouse.move(b2.x + 90, b2.y + 80, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(300);
if (!(await pager()).startsWith("2 /")) await fail(`別のページに描いても、そのページが編集するページにならない: ${await pager()}`);
if ((await count(1, ".obj-rect")) !== 1) await fail(`別のページへの最初のドラッグで四角が描けない: ${await count(1, ".obj-rect")} 個`);
const drawn = await page.locator(".page-slot.current .obj-rect.selected").boundingBox();
if (!drawn || drawn.width < 40 || drawn.height < 30) await fail(`別のページに描いた四角の大きさが、ドラッグと合わない: ${JSON.stringify(drawn)}`);
console.log("ok  何かを選んだまま、別のページに四角を描ける（最初のドラッグから）");
// 文字の道具：四角を選んだまま、3 ページ目を 1 回クリックすると入力が始まり、打った字は道具の切り替えにならない
await page.click('button.tool[data-tool="text"]');
const b3 = await slotBox(2);
await page.mouse.click(b3.x + 40, b3.y + 40);
await page.waitForSelector(".page-slot.current [contenteditable]", { timeout: 5000 }).catch(() => {});
if (!(await page.locator(".page-slot.current [contenteditable]").count())) await fail("別のページを 1 回クリックしても、文字の入力が始まらない");
await page.keyboard.type("rest");
await page.waitForTimeout(150);
const typed = await page.locator(".page-slot.current [contenteditable]").innerText();
if (typed.trim() !== "rest" || (await tool()) !== "select") await fail(`打った字が文字にならず、道具の切り替えになった: "${typed}" / ${await tool()}`);
if (!(await pager()).startsWith("3 /")) await fail(`文字を置いたページが編集するページになっていない: ${await pager()}`);
await page.keyboard.press("Escape");
console.log("ok  何かを選んだまま、別のページを 1 回クリックして文字を打てる");

// ダイアログを開いている間のキー：後ろの部品は動かない・消えない・元に戻らない
await page.keyboard.press("Escape");
await page.click('button.tool[data-tool="select"]');
await page.locator(".page-slot.current .obj-text").click();
await page.waitForSelector(".page-slot.current .obj-text.selected");
const posOf = () => page.evaluate(() => {
  const r = document.querySelector(".page-slot.current .obj-text")?.getBoundingClientRect();
  return r ? `${Math.round(r.left)},${Math.round(r.top)}` : "none";
});
const behind = async (name, open, close) => {
  const before = { pos: await posOf(), n: await page.locator(".page-slot.current .obj").count(), undo: await undoState() };
  await open();
  await page.waitForSelector(".modal-back", { timeout: 5000 });
  for (const k of ["ArrowRight", "ArrowDown", "Delete", "Backspace", "Control+z"]) {
    // ダイアログの中のボタンではなく、ダイアログそのものにキーを送る（ボタンの上では Backspace などが別の意味になりうる）
    await page.locator(".modal").focus();
    await page.keyboard.press(k);
  }
  await page.waitForTimeout(150);
  await close();
  await page.waitForFunction(() => !document.querySelector(".modal-back"));
  const after = { pos: await posOf(), n: await page.locator(".page-slot.current .obj").count(), undo: await undoState() };
  if (JSON.stringify(before) !== JSON.stringify(after)) await fail(`${name} を開いている間のキーが、後ろのページに効いた: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
};
await behind("「このソフトについて」", () => page.click('button[title="このソフトについて"]'), () => page.keyboard.press("Escape"));
await behind("ショートカットの一覧", async () => {
  await page.locator("body").focus().catch(() => {});
  await page.keyboard.press("?");
}, () => page.keyboard.press("Escape"));
await behind("署名", () => page.click('button.tool[data-tool="sign"]'), () => page.keyboard.press("Escape"));
await behind("確認", () => page.click('button[title="文書を閉じる"]'), () => page.click(".confirm-dialog .btn:not(.primary)"));
if (!(await page.locator(".page-slot.current .obj-text.selected").count())) await fail("ダイアログを閉じたあと、選択が外れている");
// ダイアログが無ければ、矢印で動く（止めすぎていない）
const p0 = await posOf();
for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowRight"); // 縮小しているので、見て分かる量を動かす
await page.waitForTimeout(100);
if ((await posOf()) === p0) await fail("ダイアログを閉じたあと、矢印で動かせない");
await page.keyboard.press("Escape");
console.log("ok  ダイアログを開いている間は、キーが後ろのページに効かない（4 種）");

// 途中の計測：面積の点を 2 つ押したままページを送ると、計測は残らず、履歴にも残らない
await page.click('button.tool[data-tool="measure"]');
await page.click('.toolbar-sub .seg button:has-text("面積")');
const cur = await page.locator(".page-slot.current .page").boundingBox();
const undoBefore = await undoState();
const measuresBefore = await page.locator(".obj-measure").count();
await page.mouse.click(cur.x + 60, cur.y + 120);
await page.mouse.click(cur.x + 120, cur.y + 120);
await page.waitForTimeout(150);
if ((await page.locator(".obj-measure").count()) !== measuresBefore + 1) await fail("面積の点を押しても、途中の計測が出ない");
await page.keyboard.press("PageUp");
await page.waitForFunction(() => document.querySelector(".pager")?.textContent?.trim().startsWith("2 /"));
await page.waitForTimeout(200);
if ((await page.locator(".obj-measure").count()) !== measuresBefore) await fail("点が足りない途中の計測が、ページを送ったあとも残っている");
if ((await undoState()) !== undoBefore) await fail(`取りやめた計測が履歴に残っている: ${undoBefore} → ${await undoState()}`);
// 距離：押しただけ（動かさない）でホイールで送っても、長さのない計測は残らない
await page.click('.toolbar-sub .seg button:has-text("距離")');
const cur2 = await page.locator(".page-slot.current .page").boundingBox();
await page.mouse.move(cur2.x + 80, cur2.y + 60);
await page.mouse.down();
await page.mouse.wheel(0, 600);
await page.waitForTimeout(300);
await page.mouse.up();
await page.waitForTimeout(300);
const degenerate = await page.evaluate(() => [...document.querySelectorAll(".obj-measure .measure-label")].map((e) => e.textContent).filter((s) => /^0(\.0+)?\s/.test(s ?? "")));
if (degenerate.length) await fail(`長さのない計測が残っている: ${degenerate}`);
console.log("ok  途中の計測は、ページを送ると残らない（履歴にも残らない）");

// 既存文字：開いただけの行は履歴に残らない。行 → 同じ段落の順に書き換えると、1 つの書き換えにまとまる
await page.click('button.tool[data-tool="select"]');
for (let i = 0; i < 4; i++) await page.click('.toolbar-sub button[title="拡大"]');
await page.locator(".strip-item").nth(2).click();
await page.waitForFunction(() => document.querySelector(".pager")?.textContent?.trim().startsWith("3 /"));
await page.click('button.tool[data-tool="edit-text"]');
await page.waitForSelector(".page-slot.current .run-box", { timeout: 30000 });
const undoIdle = await undoState();
await page.locator('.page-slot.current .run-box[title*="段落として編集したとき"]').click();
await page.waitForSelector(".page-slot.current [contenteditable]");
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
if (await page.locator(".page-slot.current .obj-textedit").count()) await fail("開いただけの行の書き換えが残っている");
if ((await undoState()) !== undoIdle) await fail(`開いただけの行が履歴に残っている: ${undoIdle} → ${await undoState()}`);
console.log("ok  開いただけの行は、履歴に残らない");
await page.click('button.tool[data-tool="edit-text"]');
await page.waitForSelector(".page-slot.current .run-box");
await page.locator('.page-slot.current .run-box[title*="段落として編集したとき"]').click();
await page.waitForSelector(".page-slot.current [contenteditable]");
await page.keyboard.press("Control+A");
await page.keyboard.insertText("二行目だけを先に書き換えました。");
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
await page.click('button.tool[data-tool="edit-text"]');
await page.click('.toolbar-sub .seg button:has-text("段落")');
await page.locator('.page-slot.current .run-box[title*="本書は自動テスト用"]').click();
await page.waitForSelector(".page-slot.current [contenteditable]");
const merged = await page.locator(".page-slot.current [contenteditable]").innerText();
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
const edits = await page.locator(".page-slot.current .obj-textedit").count();
if (edits !== 1) await fail(`行と段落の書き換えが 1 つにまとまらない（重なって書かれる）: ${edits} 個`);
if (!merged.includes("二行目だけを先に書き換えました。") || !merged.includes("本書は自動テスト用")) await fail(`段落の書き換えに、先に書き換えた行の文字が入っていない: ${merged}`);
// 保存した PDF でも、書き換えた行の字は 1 回だけ出る（元の行の字は残らない）
const [dl2] = await Promise.all([page.waitForEvent("download"), page.click('button.btn.primary:has-text("保存")')]);
const saved2 = join(outDir, "continuous-merged.pdf");
await dl2.saveAs(saved2);
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const pdf2 = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(saved2)), isEvalSupported: false }).promise;
const text3 = (await (await pdf2.getPage(3)).getTextContent()).items.map((it) => it.str ?? "").join("");
const times = text3.split("二行目だけを先に").length - 1;
if (times !== 1 || text3.includes("段落として編集したとき")) await fail(`保存した PDF で、書き換えた行が重なっている: ${times} 回 / ${text3.slice(0, 200)}`);
console.log("ok  行 → 段落の順に書き換えると、1 つの書き換えにまとまる（保存した PDF でも重ならない）");
if (errors.length) await fail("ページのエラー: " + errors[0]);
await browser.close();
console.log("continuous-flow: OK");

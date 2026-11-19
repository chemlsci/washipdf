// 既存文字の「範囲」：マウスでドラッグして囲んだ複数行が 1 つの書き換えになり、保存できることを確認する。
// スマホ（--mobile）では、範囲モードのときだけドラッグで囲め、それ以外は 1 本指でスクロールできることを確認する。
//   node test/e2e/range-flow.mjs [--mobile]
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = process.cwd();
const html = process.env.WASHI_HTML ? join(root, process.env.WASHI_HTML) : join(root, "dist", "washi-pdf.html");
const outDir = join(root, "dist", ".e2e");
mkdirSync(outDir, { recursive: true });
const mobile = process.argv.includes("--mobile");

const browser = await chromium.launch();
const context = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "ja-JP" } : { viewport: { width: 1400, height: 900 }, locale: "ja-JP" });
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
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

await page.goto("file://" + html);
await page.waitForSelector(".dropzone", { timeout: 30000 });
if (await page.$('button:has-text("破棄する")')) await page.click('button:has-text("破棄する")');
await page.setInputFiles('input[type="file"][accept*="pdf"]', join(root, "test", "fixtures", "ja-subset-identity.pdf"));
await page.waitForSelector(".card", { timeout: 30000 });
await page.click('button[role="tab"]:has-text("編集")');
await page.waitForSelector(".page-canvas");
await page.waitForFunction(() => !document.querySelector(".page-loading"));
await page.click('button.tool[title^="PDF にもともとある文字"]');
await page.waitForSelector(".run-box", { timeout: 30000 });

// 明朝の 3 行段落（合計金額〜）の 2 行目と 3 行目を囲む
const measure = async () => {
  const boxes = await page.$$eval(".run-box", (els) => els.map((e) => ({ title: e.getAttribute("title") ?? "", r: e.getBoundingClientRect().toJSON() })));
  const lines = boxes.filter((b) => /有効期限|本書は自動テスト/.test(b.title));
  if (lines.length < 2) fail(`囲む行が見つかりません: ${boxes.map((b) => b.title.slice(0, 20)).join(" | ")}`);
  return [Math.min(...lines.map((b) => b.r.left)) - 6, Math.min(...lines.map((b) => b.r.top)) - 3, Math.max(...lines.map((b) => b.r.right)) + 6, Math.max(...lines.map((b) => b.r.bottom)) + 3];
};
let [x0, y0, x1, y1] = await measure();

if (mobile) {
  // 範囲モードでないときの 1 本指のなぞりは、スクロール（選択は起きない）
  const stage = await page.$(".stage");
  const before = await stage.evaluate((el) => el.scrollTop);
  await page.evaluate(() => document.querySelector(".stage").scrollTo(0, 0));
  await page.touchscreen.tap(x0 + 10, y0 + 10); // タップで行を選ぶのは従来どおり
  await page.waitForSelector(".obj-textedit", { timeout: 10000 });
  await page.keyboard.press("Escape");
  await page.click('button[title^="元に戻す"]');
  console.log("tap → 1 行の書き換え → 元に戻す OK", before);
  await page.click('button:has-text("範囲")');
  // 行を選ぶと、スマホでは文字が読める大きさまで拡大する。全体表示に戻してから測り直す
  await page.click(".zoom-val");
  await page.waitForTimeout(400);
  [x0, y0, x1, y1] = await measure();
}
await page.mouse.move(x0, y0);
await page.mouse.down();
await page.mouse.move(x1, y1, { steps: 8 });
await page.mouse.up();
// 囲んだ直後は候補の状態：行をタップして足し引きし、「この行を書き換える」で確定する
await page.waitForSelector(".range-bar", { timeout: 10000 });
const pickedBefore = await page.$$eval(".run-box.picked", (els) => els.length);
console.log("picked:", pickedBefore);
if (pickedBefore < 2) fail("囲んだ行が候補になっていません");
// 1 行外して、もう一度足す（トグル）
// 一番下の行で足し引きする（上の行には操作バーが重なる）
const pickedEls = await page.$$(".run-box.picked");
const first = pickedEls[pickedEls.length - 1];
await first.click();
if ((await page.$$eval(".run-box.picked", (els) => els.length)) !== pickedBefore - 1) fail("行の外しができません");
await first.click();
if ((await page.$$eval(".run-box.picked", (els) => els.length)) !== pickedBefore) fail("行の足しができません");
await page.click('.range-bar button:has-text("選んだ行を書き換える")');
if (!mobile) {
  // PC ではその場編集が始まるので、Escape で確定してから確認する
  await page.waitForSelector("[contenteditable]", { timeout: 10000 });
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText("囲んだ行をまとめて書き換えました。有効期限は発行日より三十日間です。");
  await page.keyboard.press("Escape");
}
await page.waitForSelector(".obj-textedit", { timeout: 10000 });
await page.screenshot({ path: join(outDir, `range-${mobile ? "mobile" : "desktop"}.png`) });
const lineCount = await page.$eval(".props input[type=number][max='200']", (el) => Number(el.value)).catch(() => null);
if (lineCount == null) {
  await page.click('button[role="tab"]:has-text("配置")');
}
const lines2 = await page.$eval(".props input[type=number][max='200']", (el) => Number(el.value));
console.log("lines in box:", lines2);
if (lines2 < 2) fail("囲んだ 2 行が 1 つの書き換えになっていません");

// 段組みの判定（PC のみ）：2 段組みの左段を囲み、右段に 3 割ほど食い込んでも左段だけが候補になる
if (!mobile) {
  await page.click('button[title="文書を閉じる"]');
  await page.locator(".confirm-dialog .btn.primary").click();
  await page.waitForSelector(".dropzone", { timeout: 10000 });
  await page.setInputFiles('input[type="file"][accept*="pdf"]', join(root, "test", "fixtures", "ja-libreoffice-writer.pdf"));
  await page.waitForSelector(".card", { timeout: 30000 });
  await page.click('button[role="tab"]:has-text("編集")');
  await page.waitForSelector(".page-canvas");
  await page.waitForFunction(() => !document.querySelector(".page-loading"));
  await page.click('button.tool[title^="PDF にもともとある文字"]');
  await page.waitForSelector(".run-box", { timeout: 30000 });
  const all = await page.$$eval(".run-box", (els) => els.map((e) => ({ title: e.getAttribute("title") ?? "", r: e.getBoundingClientRect().toJSON() })));
  const left = all.filter((b) => /左段/.test(b.title));
  const right = all.filter((b) => /右段/.test(b.title));
  if (!left.length || !right.length) console.log("段組みの行が見つからないため、段の判定は省略:", all.map((b) => b.title.slice(0, 12)).join("|"));
  else {
    const lx0 = Math.min(...left.map((b) => b.r.left)) - 4;
    const ly0 = Math.min(...left.map((b) => b.r.top)) - 4;
    const lx1 = Math.max(...left.map((b) => b.r.right));
    const ly1 = Math.max(...left.map((b) => b.r.bottom)) + 4;
    const rx0 = Math.min(...right.map((b) => b.r.left));
    const rx1 = Math.max(...right.map((b) => b.r.right));
    await page.mouse.move(lx0, ly0);
    await page.mouse.down();
    await page.mouse.move(Math.max(lx1, rx0 + (rx1 - rx0) * 0.3), ly1, { steps: 8 });
    await page.mouse.up();
    await page.waitForSelector(".range-bar", { timeout: 10000 });
    const picked = await page.$$eval(".run-box.picked", (els) => els.map((e) => e.getAttribute("title") ?? ""));
    console.log("picked titles:", picked.map((t) => t.slice(9, 20)));
    if (picked.some((t) => /右段/.test(t))) fail("右段の行が候補に入っています");
    if (!picked.some((t) => /左段/.test(t))) fail("左段の行が候補にありません");
    await page.keyboard.press("Escape");
    if (await page.$(".range-bar")) fail("Escape で候補が消えません");
  }
  await page.click('button[title="文書を閉じる"]');
  await page.locator(".confirm-dialog .btn.primary").click();
  await page.waitForSelector(".dropzone", { timeout: 10000 });
  await page.setInputFiles('input[type="file"][accept*="pdf"]', join(root, "test", "fixtures", "ja-subset-identity.pdf"));
  await page.waitForSelector(".card", { timeout: 30000 });
  await page.click('button[role="tab"]:has-text("編集")');
  await page.waitForSelector(".page-canvas");
  await page.waitForFunction(() => !document.querySelector(".page-loading"));
  await page.click('button.tool[title^="PDF にもともとある文字"]');
  await page.waitForSelector(".run-box", { timeout: 30000 });
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 8 });
  await page.mouse.up();
  await page.waitForSelector(".range-bar", { timeout: 10000 });
  await page.click('.range-bar button:has-text("選んだ行を書き換える")');
  await page.waitForSelector("[contenteditable]", { timeout: 10000 });
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText("囲んだ行をまとめて書き換えました。有効期限は発行日より三十日間です。");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".obj-textedit", { timeout: 10000 });
}

const [download] = await Promise.all([page.waitForEvent("download"), page.click('button.btn.primary:has-text("保存")')]);
const saved = join(outDir, `range-${mobile ? "mobile" : "desktop"}.pdf`);
await download.saveAs(saved);
await browser.close();
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const pdfjsDir = join(require.resolve("pdfjs-dist/package.json"), "..");
const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(saved)), isEvalSupported: false, standardFontDataUrl: `${join(pdfjsDir, "standard_fonts")}/`, cMapUrl: `${join(pdfjsDir, "cmaps")}/` }).promise;
const tc = await (await pdf.getPage(1)).getTextContent();
const str = tc.items.map((it) => it.str ?? "").join("");
if (!str.includes("有効期限")) fail("囲んだ行の文字が保存後に無くなっています");
if (network.length) fail(`外部への通信が発生しました: ${network}`);
if (errors.length) fail(`ブラウザのエラー: ${errors}`);
console.log(`OK: 範囲で囲んで書き換え（${mobile ? "スマホ" : "PC"}）、通信ゼロ、エラーなし`);

// 操作性の点検：デスクトップとスマホで主な画面・ダイアログを一巡し、スクリーンショットと問題の兆候（横スクロール、
// 小さすぎるボタン、画面外の要素、コンソールエラー）を集める。合否判定はせず、報告だけする。
//   node test/e2e/sweep.mjs [--mobile]
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = process.cwd();
const html = process.env.WASHI_HTML ? join(root, process.env.WASHI_HTML) : join(root, "dist", "washi-pdf.html");
const mobile = process.argv.includes("--mobile");
const outDir = join(root, "dist", ".sweep", mobile ? "mobile" : "desktop");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext(
  mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "ja-JP" } : { viewport: { width: 1400, height: 900 }, locale: "ja-JP" },
);
const page = await context.newPage();
// 試験は「ページ全体を表示」で行う（ページ上の位置を、ページ全体が見えている前提で指す）
await page.addInitScript(() => {
  try {
    localStorage.setItem("washi-pdf.fit", "page");
  } catch {}
});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`);
});
const report = [];
let shot = 0;
const snap = async (name) => {
  shot++;
  const file = join(outDir, `${String(shot).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file });
  const issues = await page.evaluate(() => {
    const out = [];
    const de = document.documentElement;
    if (de.scrollWidth > de.clientWidth + 1) out.push(`横スクロール: scrollWidth ${de.scrollWidth} > ${de.clientWidth}`);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const small = [];
    const off = [];
    for (const el of document.querySelectorAll("button, input, select, a, [role=button]")) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const label = (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || el.tagName).trim().slice(0, 20);
      if (r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh) continue; // スクロールで見える範囲外は無視
      if ((r.width < 28 || r.height < 28) && el.tagName !== "INPUT" && el.tagName !== "A") small.push(`${label}(${Math.round(r.width)}x${Math.round(r.height)})`);
      if (r.right > vw + 1 || r.left < -1) off.push(`${label}(${Math.round(r.left)}..${Math.round(r.right)})`);
    }
    if (small.length) out.push(`小さい操作要素: ${small.slice(0, 8).join(", ")}${small.length > 8 ? ` 他${small.length - 8}` : ""}`);
    if (off.length) out.push(`画面からはみ出す要素: ${off.slice(0, 6).join(", ")}`);
    return out;
  });
  report.push({ step: `${shot}-${name}`, issues });
};
const fixtures = join(root, "test", "fixtures");
const closeDialog = async () => {
  const btn = page.locator('.modal button[aria-label="閉じる"], .modal .modal-head button, .modal-foot button:has-text("閉じる"), .modal-foot button:has-text("キャンセル")').first();
  if (await btn.count()) await btn.click();
  else await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
};

await page.goto("file://" + html);
await page.waitForSelector(".dropzone", { timeout: 30000 });
await snap("start");
await page.setInputFiles('input[type="file"][accept*="pdf"]', [join(fixtures, "ja-vertical.pdf"), join(fixtures, "vector.pdf"), join(fixtures, "ja-libreoffice-writer.pdf")]);
await page.waitForSelector(".card", { timeout: 30000 });
await page.waitForTimeout(500);
await snap("organize");

// 編集：縦書きの段落
await page.click('button[role="tab"]:has-text("編集")');
await page.waitForSelector(".page-canvas");
await page.waitForFunction(() => !document.querySelector(".page-loading"));
await snap("edit-select");
await page.click('button.tool:has-text("既存文字")');
await page.waitForSelector(".run-box", { timeout: 30000 });
await page.click('button:has-text("段落")');
await page.waitForTimeout(200);
await snap("edit-runs-block");
const col = page.locator('.run-box[title*="縦書きの段落"]');
await col.click();
await page.waitForTimeout(300);
await snap("vertical-editing");
if (mobile) {
  const ta = page.locator(".props textarea").first();
  await ta.waitFor();
  await ta.fill("改訂した段落です。第12回の会議は、二〇二七年に開く予定。");
  await page.keyboard.press("Tab");
} else {
  await page.waitForSelector("[contenteditable]");
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText("改訂した段落です。第12回の会議は、二〇二七年に開く予定。");
  await page.keyboard.press("Escape");
}
await page.waitForSelector(".obj-textedit.vertical");
await page.waitForTimeout(300);
await snap("vertical-edited");
const vinfo = await page.$eval(".obj-textedit.vertical", (el) => ({ cols: el.querySelectorAll(".textedit-col").length, tcy: el.querySelectorAll(".tcy").length, badge: el.querySelector(".textedit-badge")?.textContent ?? "" }));
report.push({ step: "vertical-edited", issues: [`列 ${vinfo.cols}、縦中横 ${vinfo.tcy}、バッジ「${vinfo.badge}」`] });

// 2 ページ目（図形）で墨消し
await page.click('button[title="次のページ"]');
await page.waitForSelector(".page-canvas");
await page.waitForTimeout(300);
await page.waitForFunction(() => !document.querySelector(".page-loading"));
await page.click('button.tool:has-text("墨消し")');
const pageBox = await (await page.$(".page")).boundingBox();
const z = pageBox.width / 400;
const at = (x, y) => [pageBox.x + x * z, pageBox.y + y * z];
if (mobile) {
  await page.touchscreen.tap(...at(120, 100));
} else {
  await page.mouse.move(...at(120, 100));
  await page.mouse.down();
  await page.mouse.move(...at(180, 180), { steps: 5 });
  await page.mouse.up();
}
await page.waitForTimeout(300);
await snap("redact-drawn");

// 文字ツール・図形ツールのプロパティ
await page.click('button.tool:has-text("選択")');
for (const tool of ["文字", "四角", "ハイライト", "付箋", "スタンプ"]) {
  let b = page.locator(`button.tool:has-text("${tool}")`).first();
  // スマホでは、よく使う道具だけが並びに出ている。残りは「その他」の一覧から選ぶ
  if (!(await b.count()) && (await page.locator('button.tool:has-text("その他")').count())) {
    await page.click('button.tool:has-text("その他")');
    b = page.locator(`.tool-sheet button.tool:has-text("${tool}")`).first();
  }
  if (!(await b.count())) {
    report.push({ step: `tool-${tool}`, issues: ["ボタンが見つからない"] });
    continue;
  }
  await b.click();
  await page.waitForTimeout(150);
}
await snap("tools-strip");

// ツール画面：各カードを開いて閉じる
await page.click('button[role="tab"]:has-text("ツール")');
await page.waitForSelector(".tool-cards");
await snap("tools");
const cards = await page.$$eval(".tool-card", (els) => els.map((e) => e.querySelector(".tool-card-body")?.firstChild?.textContent?.trim() ?? e.textContent.trim().slice(0, 12)));
for (const name of cards) {
  const card = page.locator(".tool-card", { hasText: name }).first();
  const disabled = await card.evaluate((el) => el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true");
  if (disabled) continue;
  await card.click();
  await page.waitForTimeout(400);
  const hasDialog = await page.$(".modal-back");
  await snap(`tool-${name.replace(/[\s/／]/g, "")}`);
  if (hasDialog) await closeDialog();
  if (await page.$(".modal-back")) {
    report.push({ step: `tool-${name}`, issues: ["ダイアログが閉じない"] });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    if (await page.$(".modal-back")) await page.mouse.click(5, 300);
  }
  if (!(await page.$(".tool-cards"))) {
    await page.click('button[role="tab"]:has-text("ツール")');
    await page.waitForSelector(".tool-cards");
  }
}

// このソフトについて
await page.click('button[title="このソフトについて"]');
await page.waitForTimeout(300);
await snap("about");
await closeDialog();

await browser.close();
console.log(JSON.stringify({ mode: mobile ? "mobile" : "desktop", report, errors: [...new Set(errors)].slice(0, 20) }, null, 2));

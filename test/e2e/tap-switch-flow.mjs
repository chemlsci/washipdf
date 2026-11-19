// スマホ（タッチ）で、既存文字の行を続けてタップしたときに、下の入力欄がタップした行に切り替わることを確かめる。
// 以前は、最初のタップの記録が残って 2 回目のタップが「2 本目の指」と見なされ、何も起きなかった。
// あわせて、下のパネルをつまみでたためることも確かめる。
// 指の操作のうち、取り違えやすいものも確かめる：
//  - ページをタップして開いたパネルに、同じタップのクリックが届かない（押していない部品が動かない）
//  - 2 本指で動かす・拡大するとき、1 本目の指で付箋などが置かれない（履歴にも残らない）。描く道具でも 2 本指でページを動かせる
//  - ペンで描いている間はパネルが開かない。つまみは、なぞっても開閉できる
//   node test/e2e/tap-switch-flow.mjs
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = process.cwd();
const html = process.env.WASHI_HTML ? join(root, process.env.WASHI_HTML) : join(root, "dist", "washi-pdf.html");
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "ja-JP" });
const page = await context.newPage();
// 試験は「ページ全体を表示」で行う（ページ上の位置を、ページ全体が見えている前提で指す）
await page.addInitScript(() => {
  try {
    localStorage.setItem("washi-pdf.fit", "page");
  } catch {}
});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const fail = async (m) => {
  console.error("FAIL:", m);
  await browser.close();
  process.exit(1);
};

await page.goto("file://" + html);
await page.waitForSelector(".dropzone", { timeout: 30000 });
await page.setInputFiles('input[type="file"][accept*="pdf"]', join(root, "test", "fixtures", "ja-subset-identity.pdf"));
await page.waitForSelector(".card", { timeout: 30000 });
await page.click('button[role="tab"]:has-text("編集")');
await page.waitForSelector(".page-canvas");
await page.waitForFunction(() => !document.querySelector(".page-loading"));
await page.click('button.tool:has-text("既存文字")');
await page.waitForSelector(".run-box", { timeout: 30000 });

const ta = page.locator(".props textarea").first();
// 画面に見えている、編集できる行を上から順にタップする
const tapVisibleRun = async (skip) => {
  const target = await page.evaluate((skipTexts) => {
    const stage = document.querySelector(".stage").getBoundingClientRect();
    for (const el of document.querySelectorAll(".run-box:not(.noedit)")) {
      const r = el.getBoundingClientRect();
      const title = el.getAttribute("title") ?? "";
      if (r.top < stage.top + 4 || r.bottom > stage.bottom - 4 || r.left < 0 || r.left > stage.right - 30) continue;
      if (skipTexts.some((s) => title.includes(s))) continue;
      return { x: r.left + Math.min(r.width / 2, 40), y: r.top + r.height / 2, title };
    }
    return null;
  }, skip);
  if (!target) return null;
  await page.touchscreen.tap(target.x, target.y);
  await ta.waitFor({ timeout: 5000 });
  await page.waitForTimeout(900);
  return target.title;
};

const seen = [];
for (let i = 0; i < 3; i++) {
  const title = await tapVisibleRun(seen);
  if (!title) break;
  const value = await ta.inputValue();
  const first = value.split("\n")[0].trim();
  if (!first || !title.includes(first.slice(0, 6))) await fail(`${i + 1} 回目のタップ：入力欄がタップした行になっていない（行: ${title.slice(0, 40)} ／ 入力欄: ${value.slice(0, 40)}）`);
  if (seen.some((s) => s === first.slice(0, 8))) await fail(`${i + 1} 回目のタップ：入力欄が前の行のまま（${first.slice(0, 20)}）`);
  seen.push(first.slice(0, 8));
  console.log(`ok  ${i + 1} 回目のタップ → ${first.slice(0, 20)}`);
}
if (seen.length < 2) await fail("タップできる行が 2 つ見つからなかった");

// パネルをたたむ／開く
const h0 = await page.evaluate(() => document.querySelector(".props").getBoundingClientRect().height);
await page.tap(".props-grip");
await page.waitForTimeout(300);
const h1 = await page.evaluate(() => document.querySelector(".props").getBoundingClientRect().height);
if (!(h1 < 40 && h0 > 100)) await fail(`パネルをたためない（${h0} → ${h1}）`);
await page.tap(".props-grip");
await page.waitForTimeout(300);
const h2 = await page.evaluate(() => document.querySelector(".props").getBoundingClientRect().height);
if (!(h2 > 100)) await fail(`パネルを開き直せない（${h2}）`);
console.log(`ok  パネルの開閉（${Math.round(h0)} → ${Math.round(h1)} → ${Math.round(h2)}）`);

// ---- 指の操作 ----
const cdp = await context.newCDPSession(page);
const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map((p, i) => ({ x: p[0], y: p[1], id: p[2] ?? i + 1 })) });
const tapAt = async (x, y) => {
  await touch("touchStart", [[x, y]]);
  await page.waitForTimeout(60);
  await touch("touchEnd", []);
  await page.waitForTimeout(700);
};
const swipe = async (x0, y0, x1, y1) => {
  await touch("touchStart", [[x0, y0]]);
  for (let i = 1; i <= 8; i++) {
    await touch("touchMove", [[x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8]]);
    await page.waitForTimeout(20);
  }
  await touch("touchEnd", []);
  await page.waitForTimeout(400);
};
const pickTool = async (id) => {
  const direct = page.locator(`.toolbar .tool-group button.tool[data-tool="${id}"]`);
  if (!(await direct.count())) {
    await page.locator(".toolbar .tool-group button.tool[aria-expanded]").tap();
    await page.locator(`.tool-sheet button.tool[data-tool="${id}"]`).tap();
  } else await direct.first().tap();
  await page.waitForTimeout(200);
};
const objects = () => page.locator(".page .obj").count();
const undoState = () => page.evaluate(() => {
  const b = document.querySelector("header .actions .icon-btn");
  return `${b.disabled ? "off" : "on"}:${b.title}`;
});
const propsHeight = () => page.evaluate(() => Math.round(document.querySelector(".props")?.getBoundingClientRect().height ?? 0));
const deselect = async () => {
  // パネルの入力欄にカーソルがあると Escape は欄のものになるので、先に欄から出る
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  if (await page.locator(".page .obj.selected").count()) await fail("選択を外せない: " + (await page.evaluate(() => `${document.querySelector(".page .obj.selected")?.className} / ${document.activeElement?.tagName} / ${document.querySelector(".toolbar .tool.on")?.dataset.tool}`)));
};
await deselect();
await pickTool("select");
await page.tap(".zoom-val"); // 全体表示に戻す
await page.waitForTimeout(400);

// 1) タップして開いたパネルに、同じタップのクリックが届かない
await page.evaluate(() => {
  window.__clicks = [];
  document.addEventListener("click", (e) => e.target.closest?.(".props") && window.__clicks.push(e.target.className || e.target.tagName), true);
});
const box = await page.locator(".page").boundingBox();
let n = 0;
for (const id of ["text", "note", "stamp"]) {
  for (const fy of [0.55, 0.7, 0.85]) {
    await deselect();
    await pickTool(id);
    // パネルが開くと隠れる高さ（ページの下のほう）を押す
    await tapAt(box.x + 50 + 36 * (n % 7), box.y + box.height * fy);
    n++;
    const state = await page.evaluate(() => ({
      clicks: window.__clicks.splice(0),
      grip: document.querySelector(".props-grip")?.getAttribute("aria-expanded"),
      checked: [...document.querySelectorAll('.props input[type="checkbox"]')].filter((c) => c.checked).length,
      select: document.activeElement?.tagName === "SELECT",
    }));
    if (state.clicks.length || state.grip !== "true" || state.checked || state.select) await fail(`${id}：ページのタップが、開いたパネルの部品に届いた: ${JSON.stringify(state)}`);
  }
}
if ((await objects()) < 6) await fail(`タップで置けていない: ${await objects()} 個`);
console.log(`ok  ページをタップして開いたパネルに、同じタップのクリックが届かない（${n} 回）`);

// 2) 2 本指：1 本目の指で付箋が置かれない。描く道具でも、2 本指でページを動かせる
await deselect();
await page.tap('.toolbar-row2 button[title="拡大"]');
await page.tap('.toolbar-row2 button[title="拡大"]');
await page.waitForTimeout(500);
const two = async (dy) => {
  const P = (y) => [[150, y, 1], [240, y, 2]];
  await touch("touchStart", [P(420)[0]]);
  await page.waitForTimeout(40);
  await touch("touchStart", P(420));
  for (let i = 1; i <= 8; i++) {
    await touch("touchMove", P(420 + (dy * i) / 8));
    await page.waitForTimeout(25);
  }
  await touch("touchEnd", [P(420 + dy)[0]]);
  await page.waitForTimeout(30);
  await touch("touchEnd", []);
  await page.waitForTimeout(500);
};
const scrollTop = () => page.evaluate(() => Math.round(document.querySelector(".stage").scrollTop));
for (const id of ["note", "stamp", "text", "ink", "measure", "rect"]) {
  await deselect();
  await pickTool(id);
  const before = { n: await objects(), undo: await undoState(), top: await scrollTop() };
  await two(-90);
  const after = { n: await objects(), undo: await undoState(), top: await scrollTop() };
  const toolNow = await page.evaluate(() => document.querySelector(".toolbar .tool-group .tool.on")?.dataset.tool ?? "");
  if (after.n !== before.n || after.undo !== before.undo) await fail(`${id}：2 本指の操作で、部品が置かれた・履歴が増えた: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  if (toolNow !== id) await fail(`${id}：2 本指の操作のあと、道具が変わっている: ${toolNow}`);
  if (Math.abs(after.top - before.top - 90) > 25) await fail(`${id}：2 本指でページが動かない: ${before.top} → ${after.top}`);
  await two(90);
}
console.log("ok  2 本指：何も置かれず、履歴も増えず、描く道具でもページを動かせる（6 種）");

// 3) ペン：描いている間はパネルが開かない（つまみで開ける）。道具を変えると開く。動かし方の知らせが出る
await deselect();
await pickTool("ink");
if (!(await page.locator(".touch-hint").count())) await fail("描く道具で、指の使い方の知らせが出ない");
const stroke = async (k) => swipe(90 + k * 20, 300, 200 + k * 20, 340);
const inks0 = await page.locator(".page .obj-ink").count();
await stroke(0);
await stroke(1);
if ((await page.locator(".page .obj-ink").count()) !== inks0 + 2) await fail("1 本指でペンの線が描けない");
if ((await propsHeight()) > 40) await fail(`ペンで描くたびにパネルが開く（${await propsHeight()}px）`);
await page.tap(".props-grip");
await page.waitForTimeout(300);
if ((await propsHeight()) < 100) await fail("ペンの最中に、つまみでパネルを開けない");
await stroke(2);
if ((await propsHeight()) > 40) await fail("次の線を描いても、パネルがたたまれない");
await pickTool("select");
await page.waitForTimeout(300);
if ((await propsHeight()) < 100) await fail("道具を変えても、パネルが開かない");
console.log("ok  ペンで描いている間はパネルが開かず、つまみで開ける");

// 4) つまみをなぞって開閉する
const grip = await page.locator(".props-grip").boundingBox();
await swipe(grip.x + grip.width / 2, grip.y + grip.height / 2, grip.x + grip.width / 2, grip.y + 80);
if ((await propsHeight()) > 40) await fail("つまみを下へなぞっても、パネルがたたまれない");
const grip2 = await page.locator(".props-grip").boundingBox();
await swipe(grip2.x + grip2.width / 2, grip2.y + grip2.height / 2, grip2.x + grip2.width / 2, grip2.y - 70);
if ((await propsHeight()) < 100) await fail("つまみを上へなぞっても、パネルが開かない");
console.log("ok  つまみをなぞって開閉できる");
if (errors.length) await fail("ページのエラー: " + errors[0]);
await browser.close();
console.log("tap-switch-flow: OK");

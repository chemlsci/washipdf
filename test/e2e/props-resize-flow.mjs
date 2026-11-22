// 右のパネルの幅を、境界をなぞって変える。文書側の倍率が合わせ直され、文字の枠がページの文字からずれないこと、
// 幅を覚えること、ダブルクリック・キー操作、狭い画面では出ないこと、右から左に書く言語でも向きが合うことを確かめる。
//   node scripts/build.mjs && node test/e2e/props-resize-flow.mjs
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = process.cwd();
const html = "file://" + join(root, "dist", "washi-pdf.html");
const pdf = join(root, "test", "fixtures", "ja-subset-identity.pdf");

let failed = 0;
const fail = (m) => {
  failed++;
  console.log("FAIL:", m);
};
const ok = (m) => console.log("ok:", m);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const browser = await chromium.launch();

async function open(context, { lang } = {}) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.addInitScript((lang) => {
    try {
      localStorage.setItem("washi-pdf.fit", "width");
      if (lang) localStorage.setItem("washi-pdf.lang", lang);
    } catch {}
  }, lang);
  await page.goto(html);
  await page.waitForSelector(".dropzone", { timeout: 30000 });
  await page.setInputFiles('input[type="file"][accept*="pdf"]', pdf);
  await page.waitForSelector(".card", { timeout: 30000 });
  await page.click('.rail button[role="tab"]:nth-of-type(2), button[role="tab"]:has-text("編集")').catch(() => {});
  await page.waitForSelector(".page-canvas", { timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector(".page-loading"));
  await page.click('.toolbar button.tool[data-tool="edit-text"]');
  await page.waitForSelector(".run-box");
  return { page, errors };
}

/** パネルの幅と、ページの幅、最初の文字の枠のページ内での位置（ページの幅で割った値） */
const measure = (page) =>
  page.evaluate(() => {
    const props = document.querySelector(".props").getBoundingClientRect();
    const canvas = document.querySelector(".page-canvas").getBoundingClientRect();
    const box = document.querySelector(".run-box").getBoundingClientRect();
    return {
      props: props.width,
      canvas: canvas.width,
      boxX: (box.left - canvas.left) / canvas.width,
      boxY: (box.top - canvas.top) / canvas.width,
      boxW: box.width / canvas.width,
    };
  });
const settle = (page) => page.waitForTimeout(600);

// 1. PC：なぞって広げる・覚える・ダブルクリックで戻す・キー操作・最小幅
{
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "ja-JP" });
  const { page, errors } = await open(context);
  const split = page.locator(".props-split");
  if (!(await split.isVisible())) fail("境界のつまみが出ていない");
  const before = await measure(page);
  if (!near(before.props, 260, 2)) fail(`最初の幅が 260 でない：${before.props}`);
  const sb = await split.boundingBox();
  const x = sb.x + sb.width / 2,
    y = sb.y + 200;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(x - i * 20, y);
  await page.mouse.up();
  await settle(page);
  const wide = await measure(page);
  if (!near(wide.props, 460, 4)) fail(`なぞったあとの幅が 460 付近でない：${wide.props}`);
  else ok(`なぞって広げた：260 → ${Math.round(wide.props)}`);
  if (!(wide.canvas < before.canvas - 50)) fail(`文書側の倍率が合わせ直されていない：${before.canvas} → ${wide.canvas}`);
  else ok(`文書の幅が合わせ直された：${Math.round(before.canvas)} → ${Math.round(wide.canvas)}`);
  for (const k of ["boxX", "boxY", "boxW"])
    if (!near(before[k], wide[k], 0.004)) fail(`文字の枠がページの文字からずれた（${k}：${before[k].toFixed(4)} → ${wide[k].toFixed(4)}）`);
  ok("文字の枠は、ページに対して同じ位置・大きさのまま");
  // 覚える
  await page.reload();
  await page.waitForSelector(".dropzone");
  const p2 = await open(context);
  const kept = await measure(p2.page);
  if (!near(kept.props, wide.props, 2)) fail(`開き直したら幅が戻った：${kept.props}`);
  else ok(`開き直しても幅を覚えている：${Math.round(kept.props)}`);
  // ダブルクリックで元の幅
  await p2.page.locator(".props-split").dblclick();
  await settle(p2.page);
  const reset = await measure(p2.page);
  if (!near(reset.props, 260, 2)) fail(`ダブルクリックで元の幅に戻らない：${reset.props}`);
  else ok("ダブルクリックで元の幅（260）");
  // キー操作（左で広く、右で狭く）
  await p2.page.locator(".props-split").focus();
  await p2.page.keyboard.press("ArrowLeft");
  await p2.page.keyboard.press("ArrowLeft");
  const k1 = await measure(p2.page);
  if (!near(k1.props, 292, 2)) fail(`← キーで広がらない：${k1.props}`);
  await p2.page.keyboard.press("ArrowRight");
  const k2 = await measure(p2.page);
  if (!near(k2.props, 276, 2)) fail(`→ キーで狭まらない：${k2.props}`);
  else ok("キー操作で幅を変えられる");
  // 最小幅より狭くならない／文書側を残す
  const sb2 = await p2.page.locator(".props-split").boundingBox();
  await p2.page.mouse.move(sb2.x + 4, 300);
  await p2.page.mouse.down();
  await p2.page.mouse.move(sb2.x + 400, 300, { steps: 5 });
  await p2.page.mouse.up();
  const min = await measure(p2.page);
  if (!near(min.props, 220, 2)) fail(`最小幅で止まらない：${min.props}`);
  const sb3 = await p2.page.locator(".props-split").boundingBox();
  await p2.page.mouse.move(sb3.x + 4, 300);
  await p2.page.mouse.down();
  await p2.page.mouse.move(sb3.x - 1200, 300, { steps: 5 });
  await p2.page.mouse.up();
  await settle(p2.page);
  const max = await measure(p2.page);
  if (!(max.props <= 560 + 1)) fail(`最大幅を超えた：${max.props}`);
  else ok(`最小 220・最大 ${Math.round(max.props)} で止まる`);
  // 境界にフォーカスがあるときの矢印キーは、ページ側で選んでいる図形を動かさない
  await p2.page.click('.toolbar button.tool[data-tool="rect"]');
  const cv = await p2.page.locator(".page-canvas").boundingBox();
  await p2.page.mouse.move(cv.x + 80, cv.y + 80);
  await p2.page.mouse.down();
  await p2.page.mouse.move(cv.x + 200, cv.y + 160, { steps: 6 });
  await p2.page.mouse.up();
  await p2.page.waitForSelector("[data-obj]");
  const objBox = () => p2.page.evaluate(() => {
    const r = document.querySelector("[data-obj]").getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top)];
  });
  const o1 = await objBox();
  const propsW = () => p2.page.evaluate(() => document.querySelector(".props").getBoundingClientRect().width);
  const w1 = await propsW();
  await p2.page.locator(".props-split").focus();
  await p2.page.keyboard.press("Shift+ArrowRight"); // いまは最大幅なので、狭める向き（Shift で、図形なら 10pt 動く大きさ）
  await settle(p2.page);
  const o2 = await objBox();
  const w2 = await propsW();
  const canvasMoved = Math.abs(w2 - w1) > 1; // 幅が変われば倍率も変わるので、位置はページに対する割合で比べる
  const rel = (o, c) => [(o[0] - c.x) / c.width, (o[1] - c.y) / c.width];
  const c2 = await p2.page.locator(".page-canvas").boundingBox();
  const r1 = rel(o1, cv),
    r2 = rel(o2, c2);
  if (!canvasMoved) fail("矢印キーで幅が変わらなかった");
  else if (Math.abs(r1[0] - r2[0]) > 0.006 || Math.abs(r1[1] - r2[1]) > 0.006) fail(`境界の矢印キーで、選んでいる図形が動いた：${r1.map((x) => x.toFixed(3))} → ${r2.map((x) => x.toFixed(3))}`);
  else ok("境界の矢印キーは、選んでいる図形を動かさない");

  // 窓を狭くしたら、表示の上だけ縮めて文書側を残す
  await p2.page.setViewportSize({ width: 1060, height: 900 });
  await settle(p2.page);
  const shrunk = await p2.page.evaluate(() => ({ props: document.querySelector(".props").getBoundingClientRect().width, stage: document.querySelector(".workspace").getBoundingClientRect().width }));
  if (!(shrunk.stage >= 318)) fail(`窓を狭くしたら文書側が狭くなりすぎた：${shrunk.stage}`);
  else ok(`窓を狭くしても文書側を残す（文書側 ${Math.round(shrunk.stage)}・パネル ${Math.round(shrunk.props)}）`);
  if ([...errors, ...p2.errors].length) fail("ページのエラー：" + [...errors, ...p2.errors].join(" / "));
  await context.close();
}

// 2. 横並びでない画面（タブレット幅・スマホ）では、つまみを出さない
for (const vp of [
  { width: 900, height: 1000 },
  { width: 390, height: 844 },
]) {
  const context = await browser.newContext({ viewport: vp, locale: "ja-JP", ...(vp.width < 500 ? { isMobile: true, hasTouch: true } : {}) });
  await context.addInitScript(() => localStorage.setItem("washi-pdf.propsWidth", "500"));
  const page = await context.newPage();
  await page.goto(html);
  await page.waitForSelector(".dropzone");
  await page.setInputFiles('input[type="file"][accept*="pdf"]', pdf);
  await page.waitForSelector(".card");
  await page.click('button[role="tab"]:has-text("編集")');
  await page.waitForSelector(".page-canvas");
  if (await page.locator(".props-split").count()) fail(`${vp.width}px でつまみが出ている`);
  else ok(`${vp.width}px ではつまみを出さない`);
  await context.close();
}

// 3. 右から左に書く言語（パネルが左側）：なぞる向きが逆になる
{
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "ar" });
  const { page, errors } = await open(context, { lang: "ar" });
  const dir = await page.evaluate(() => document.documentElement.dir);
  if (dir !== "rtl") console.log("（参考）右から左の表示にならなかった：", dir);
  const sb = await page.locator(".props-split").boundingBox();
  const props0 = await page.evaluate(() => document.querySelector(".props").getBoundingClientRect());
  await page.mouse.move(sb.x + sb.width / 2, 300);
  await page.mouse.down();
  // パネルの内側から外側へ（文書の側へ）なぞると広がる
  const outward = props0.left < 700 ? 1 : -1;
  for (let i = 1; i <= 5; i++) await page.mouse.move(sb.x + sb.width / 2 + outward * i * 20, 300);
  await page.mouse.up();
  await settle(page);
  const w = await page.evaluate(() => document.querySelector(".props").getBoundingClientRect().width);
  if (!near(w, 360, 4)) fail(`右から左の表示で、なぞった向きと幅が合わない：${w}（${dir}）`);
  else ok(`右から左の表示（${dir}）でも、文書の側へなぞると広がる：${Math.round(w)}`);
  if (errors.length) fail("ページのエラー：" + errors.join(" / "));
  await context.close();
}

await browser.close();
if (failed) {
  console.log(`FAIL (${failed})`);
  process.exit(1);
}
console.log("PASS");

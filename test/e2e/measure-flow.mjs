// 計測：距離はドラッグで、面積は 4 点を押してダブルクリックで閉じる。縮尺を 1:100・単位を m にすると、数値が実寸になる。
// 折れ線は点を順に押し、最後の点をもう一度押すと終わる。面積は最初の点を押しても閉じる。選んだ計測の点はつまんで動かせる。
// 線の実際の長さを入れると縮尺が決まり、ページのほかの計測もその縮尺になる。保存した PDF に数値が入る。
//   node test/e2e/measure-flow.mjs
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

const root = process.cwd();
const html = process.env.WASHI_HTML ? join(root, process.env.WASHI_HTML) : join(root, "dist", "washi-pdf.html");
const outDir = join(root, "dist", ".e2e");
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: "ja-JP", acceptDownloads: true })).newPage();
await page.addInitScript(() => {
  try {
    localStorage.setItem("washi-pdf.fit", "page");
  } catch {}
});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const fail = async (msg) => {
  console.error("FAIL:", msg);
  await page.screenshot({ path: join(outDir, "measure-fail.png") });
  await browser.close();
  process.exit(1);
};

await page.goto("file://" + html);
await page.waitForSelector(".dropzone");
await page.setInputFiles('input[type="file"][accept*="pdf"]', join(root, "test", "fixtures", "ja-libreoffice-writer.pdf"));
await page.waitForSelector(".card");
await page.click('button[role="tab"]:has-text("編集")');
await page.waitForSelector(".page-canvas");
const bb = await page.locator(".page-slot.current .page").boundingBox();
const zoom = bb.width / 595.28;
// 距離：72pt（= 25.4mm）だけ右へドラッグ
await page.click('button.tool:has-text("計測")');
const x0 = bb.x + bb.width * 0.2;
const y0 = bb.y + bb.height * 0.6;
await page.mouse.move(x0, y0);
await page.mouse.down();
await page.mouse.move(x0 + 72 * zoom, y0, { steps: 6 });
await page.mouse.up();
const label = async () => (await page.locator(".obj-measure.selected .measure-label, .obj-measure .measure-label").last().innerText()).trim();
const d1 = await label();
if (!/^25\.\d+ mm$/.test(d1) || Math.abs(parseFloat(d1) - 25.4) > 0.6) await fail(`距離の表示が違う: ${d1}`);
// 縮尺 1:100、単位 m
await page.fill('.props .measure-scale input', "100");
await page.selectOption(".props select", "m");
const d2 = await label();
if (!/ m$/.test(d2) || Math.abs(parseFloat(d2) - 2.54) > 0.06) await fail(`縮尺を変えた表示が違う: ${d2}`);
console.log(`ok  距離：${d1} → 縮尺 1:100・m で ${d2}`);
// 面積：72pt 四方を 4 点で（縮尺と単位は前の計測のものを使う）
await page.click('.toolbar-sub .seg button:has-text("面積")');
const ax = bb.x + bb.width * 0.3;
const ay = bb.y + bb.height * 0.75;
for (const [dx, dy] of [[0, 0], [72, 0], [72, 72], [0, 72]]) {
  await page.mouse.click(ax + dx * zoom, ay + dy * zoom);
  await page.waitForTimeout(80);
}
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
const a1 = await label();
if (!/ m²$/.test(a1) || Math.abs(parseFloat(a1) - 6.4516) > 0.3) await fail(`面積の表示が違う: ${a1}`);
console.log(`ok  面積：${a1}（72pt 四方・縮尺 1:100）`);
// 折れ線：72pt 右、72pt 下の 2 区間（= 50.8mm → 1:100・m で 5.08 m）。最後の点をもう一度押して終える
await page.click('.toolbar-sub .seg button:has-text("折れ線")');
const px = bb.x + bb.width * 0.55;
const py = bb.y + bb.height * 0.3;
for (const [dx, dy] of [[0, 0], [72, 0], [72, 72], [72, 72]]) {
  await page.mouse.click(px + dx * zoom, py + dy * zoom);
  await page.waitForTimeout(120);
}
await page.waitForTimeout(200);
const p1 = await label();
if (!/ m$/.test(p1) || Math.abs(parseFloat(p1) - 5.08) > 0.12) await fail(`折れ線の表示が違う: ${p1}`);
// 最後の点をつまんで 72pt 下へ（216pt = 76.2mm → 7.62 m）
const handle = page.locator(".obj-measure.selected [data-handle='v2'] circle").first();
const hb = await handle.boundingBox();
if (!hb) await fail("選んだ計測に点のつまみが出ない");
await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
await page.mouse.down();
await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + 72 * zoom, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(200);
const p2 = await label();
if (Math.abs(parseFloat(p2) - 7.62) > 0.15) await fail(`点を動かしたあとの表示が違う: ${p2}`);
console.log(`ok  折れ線：${p1}、最後の点を動かして ${p2}`);
// 線の実際の長さを 10 m と入れる → 縮尺が決まり、最初の距離（25.4mm）は 10 × 72/216 = 3.333 m になる
await page.fill(".props .measure-calibrate input", "10");
await page.click('.props .measure-calibrate button');
await page.waitForTimeout(200);
const p3 = await label();
const all = await page.locator(".obj-measure .measure-label").allInnerTexts();
if (Math.abs(parseFloat(p3) - 10) > 0.01) await fail(`縮尺を合わせた線の長さが違う: ${p3}`);
if (!all.some((v) => Math.abs(parseFloat(v) - 3.333) < 0.02)) await fail(`ほかの計測が新しい縮尺にならない: ${all}`);
console.log(`ok  実際の長さで縮尺を合わせた：${p3}、ほかの距離は ${all.find((v) => Math.abs(parseFloat(v) - 3.333) < 0.02)}`);
// 面積を、最初の点を押して閉じる（3 点の三角形）
await page.click('.toolbar-sub .seg button:has-text("面積")');
const before = await page.locator(".obj-measure").count();
const tx = bb.x + bb.width * 0.15;
const ty = bb.y + bb.height * 0.2;
for (const [dx, dy] of [[0, 0], [72, 0], [0, 72], [0, 0]]) {
  await page.mouse.click(tx + dx * zoom, ty + dy * zoom);
  await page.waitForTimeout(120);
}
await page.waitForTimeout(200);
if ((await page.locator(".obj-measure").count()) !== before + 1) await fail("最初の点を押しても面積が閉じない");
const tri = await page.locator(".obj-measure .measure-label").last().innerText();
console.log(`ok  面積を最初の点で閉じた：${tri}`);
await page.screenshot({ path: join(outDir, "measure.png") });
const [download] = await Promise.all([page.waitForEvent("download"), page.click('button.btn.primary:has-text("保存")')]);
const saved = join(outDir, "measure.pdf");
await download.saveAs(saved);
const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(saved)), isEvalSupported: false }).promise;
const text = (await (await pdf.getPage(1)).getTextContent()).items.map((it) => it.str ?? "").join(" ");
if (!text.includes(p3) || !text.includes(tri)) await fail(`保存した PDF に数値が無い: ${text.slice(-160)}`);
console.log("ok  保存した PDF に数値が入る");
if (errors.length) await fail("ページのエラー: " + errors[0]);
await browser.close();
console.log("measure-flow: OK");

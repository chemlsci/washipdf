// 承認欄：署名の画面の「承認欄」で見出しの候補を選んで置く。手書きの署名を押印欄へドラッグすると、
// 欄に合わせて大きさと位置がそろうこと。承認欄を動かすと署名も一緒に動くこと。保存した PDF に見出しの文字が入ること。
// 保存した PDF を開き直しても（承認欄はもう線と文字になっている）、署名を欄へドラッグすると合わせられること。
//   node test/e2e/approval-flow.mjs
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
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "ja-JP", acceptDownloads: true });
const page = await context.newPage();
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
  await page.screenshot({ path: join(outDir, "approval-fail.png") });
  await browser.close();
  process.exit(1);
};

await page.goto("file://" + html);
await page.waitForSelector(".dropzone");
await page.setInputFiles('input[type="file"][accept*="pdf"]', join(root, "test", "fixtures", "ja-libreoffice-writer.pdf"));
await page.waitForSelector(".card");
await page.click('button[role="tab"]:has-text("編集")');
await page.waitForSelector(".page-canvas");
await page.waitForFunction(() => !document.querySelector(".page-loading"));

// 1. 署名の画面の「承認欄」で置く。置いたあとも、設定パネルの候補で見出しを変えられる
const canvas = await page.locator(".page-canvas").boundingBox();
const openSign = async () => {
  await page.locator("button.tool").filter({ hasText: /^署名$/ }).click();
  await page.waitForSelector(".modal .seg");
};
await openSign();
await page.click('.modal .seg button:has-text("承認欄")');
if ((await page.locator(".modal .approval-sample > div").count()) !== 3) await fail("承認欄の見本が出ない");
await page.click(".modal .btn.primary");
await page.waitForSelector(".obj-approval");
const titles = async () => page.locator(".obj-approval .approval-title").allInnerTexts();
if ((await titles()).join() !== "部長,課長,担当") await fail(`見出しが既定と違う: ${await titles()}`);
await page.click('.props .chip:has-text("社長")');
if ((await titles()).join() !== "社長,部長,課長,担当") await fail(`候補を選んでも見出しが変わらない: ${await titles()}`);
console.log("ok  署名の画面から承認欄を置き、候補で見出しを 4 つにした");

// 2. 手書きの署名を作って、2 つ目の押印欄（部長）へドラッグする
const drawSignature = async () => {
  await openSign();
  const pad = await page.locator(".sign-pad").boundingBox();
  await page.mouse.move(pad.x + 40, pad.y + 120);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(pad.x + 40 + i * 12, pad.y + 120 - Math.sin(i / 2) * 60);
  await page.mouse.up();
  await page.click(".modal .btn.primary");
  await page.waitForSelector(".obj-image");
};
await drawSignature();
const box = async (sel) => (await page.locator(sel).first().boundingBox());
const sig0 = await box(".obj-image");
const grid = await box(".obj-approval");
const header = (await page.locator(".obj-approval .approval-title").first().boundingBox()).height;
const col = grid.width / 4;
const cell = { x: grid.x + col, y: grid.y + header, w: col, h: grid.height - header };
await page.mouse.move(sig0.x + sig0.width / 2, sig0.y + sig0.height / 2);
await page.mouse.down();
await page.mouse.move(cell.x + cell.w / 2 + 5, cell.y + cell.h / 2 - 4, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(200);
const sig = await box(".obj-image");
const inside = sig.x >= cell.x - 1 && sig.y >= cell.y - 1 && sig.x + sig.width <= cell.x + cell.w + 1 && sig.y + sig.height <= cell.y + cell.h + 1;
const centred = Math.abs(sig.x + sig.width / 2 - (cell.x + cell.w / 2)) < 2 && Math.abs(sig.y + sig.height / 2 - (cell.y + cell.h / 2)) < 2;
const ratio = sig0.width / sig0.height - sig.width / sig.height;
if (!inside || !centred || Math.abs(ratio) > 0.05) await fail(`署名が欄に合っていない: ${JSON.stringify({ sig, cell, ratio })}`);
console.log(`ok  署名を欄へドラッグ：${Math.round(sig0.width)}×${Math.round(sig0.height)} → ${Math.round(sig.width)}×${Math.round(sig.height)}、欄の中央`);

// 3. 承認欄を動かすと、署名も一緒に動く（見出しの段をつかんで動かす）
const g0 = await box(".obj-approval");
await page.mouse.move(g0.x + 8, g0.y + 6);
await page.mouse.down();
await page.mouse.move(g0.x + 8 - 120, g0.y + 6 - 200, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(200);
const g1 = await box(".obj-approval");
const sig2 = await box(".obj-image");
const dgx = g1.x - g0.x;
const dgy = g1.y - g0.y;
if (Math.abs(dgx + 120) > 3 || Math.abs(dgy + 200) > 3) await fail(`承認欄が動いていない: ${dgx}, ${dgy}`);
if (Math.abs(sig2.x - sig.x - dgx) > 2 || Math.abs(sig2.y - sig.y - dgy) > 2) await fail("承認欄を動かしても署名が一緒に動かない");
console.log("ok  承認欄を動かすと、中の署名も一緒に動く");
await page.mouse.click(canvas.x + 10, canvas.y + 10);
await page.screenshot({ path: join(outDir, "approval.png") });

// 4. 保存：見出しの文字が PDF に入る
const [download] = await Promise.all([page.waitForEvent("download"), page.click('button.btn.primary:has-text("保存")')]);
const saved = join(outDir, "approval.pdf");
await download.saveAs(saved);
const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(saved)), isEvalSupported: false }).promise;
const text = (await (await pdf.getPage(1)).getTextContent()).items.map((it) => it.str ?? "").join("");
for (const w of ["社長", "部長", "課長", "担当"]) if (!text.includes(w)) await fail(`保存した PDF に見出し「${w}」が無い`);
console.log("ok  保存した PDF に見出しが入る");

// 5. 保存した PDF を開き直す：承認欄は線と文字になっているが、署名を 3 つ目の欄（課長）へドラッグすると欄に合う
const gridSaved = await box(".obj-approval");
await page.click('button[title^="閉じる"], button[aria-label^="閉じる"]').catch(() => {});
await page.goto("file://" + html);
await page.waitForSelector(".dropzone");
if (await page.$('button:has-text("破棄する")')) await page.click('button:has-text("破棄する")');
await page.setInputFiles('input[type="file"][accept*="pdf"]', saved);
await page.waitForSelector(".card");
await page.click('button[role="tab"]:has-text("編集")');
await page.waitForSelector(".page-canvas");
await page.waitForFunction(() => !document.querySelector(".page-loading"));
if (await page.locator(".obj-approval").count()) await fail("開き直したのに承認欄が部品のまま");
// 開き直した画面での承認欄の位置（倍率が同じなので、保存前と同じ位置にある）
const c2 = await page.locator(".page-canvas").boundingBox();
const k = c2.width / canvas.width;
const gx = c2.x + (gridSaved.x - canvas.x) * k;
const gy = c2.y + (gridSaved.y - canvas.y) * k;
const cell3 = { x: gx + (gridSaved.width / 4) * 2 * k, y: gy + header * k, w: (gridSaved.width / 4) * k, h: (gridSaved.height - header) * k };
await drawSignature();
const s0 = await box(".obj-image");
await page.mouse.move(s0.x + s0.width / 2, s0.y + s0.height / 2);
await page.mouse.down();
await page.mouse.move(cell3.x + cell3.w / 2 - 6, cell3.y + cell3.h / 2 + 3, { steps: 10 });
await page.mouse.up();
await page.waitForFunction(([w]) => (document.querySelector(".obj-image")?.getBoundingClientRect().width ?? w) < w * 0.6, [s0.width], { timeout: 5000 }).catch(() => {});
const s1 = await box(".obj-image");
const ok3 = s1.x >= cell3.x - 2 && s1.y >= cell3.y - 2 && s1.x + s1.width <= cell3.x + cell3.w + 2 && s1.y + s1.height <= cell3.y + cell3.h + 2;
if (!ok3 || Math.abs(s1.x + s1.width / 2 - (cell3.x + cell3.w / 2)) > 2.5) await fail(`開き直したあと、署名が欄に合わない: ${JSON.stringify({ s1, cell3 })}`);
console.log(`ok  開き直した PDF でも、署名を欄へドラッグすると合う（${Math.round(s0.width)}×${Math.round(s0.height)} → ${Math.round(s1.width)}×${Math.round(s1.height)}）`);

if (network.length) await fail("通信が発生: " + network[0]);
if (errors.length) await fail("ページのエラー: " + errors[0]);
await browser.close();
console.log("approval-flow: OK");

// 署名：手書き・印鑑・画像の 3 通りで署名を作ってページに置き、保存すると画像としてページの内容に焼き込まれること
// （注釈としては入らないこと）を確かめる。通信ゼロも検証する。
//   node test/e2e/sign-flow.mjs [--browser=chromium|firefox|webkit] [--device="iPad Pro 11"]
//   --device は Playwright の端末の設定（画面の大きさ・タッチ・UA）。タッチの端末では、指でなぞる操作（pointerType=touch）で書く
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const pw = require("playwright");
const browserName = (process.argv.find((a) => a.startsWith("--browser=")) ?? "--browser=chromium").slice(10);
const deviceName = process.argv.find((a) => a.startsWith("--device="))?.slice(9);
const device = deviceName ? pw.devices[deviceName] : null;
if (deviceName && !device) throw new Error(`端末の設定がありません: ${deviceName}`);
const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, decodePDFRawStream } = require("pdf-lib");

const root = process.cwd();
const html = process.env.WASHI_HTML ? join(root, process.env.WASHI_HTML) : join(root, "dist", "washi-pdf.html");
const outDir = join(root, "dist", ".e2e");
mkdirSync(outDir, { recursive: true });

const browser = await pw[browserName].launch();
const context = await browser.newContext({ ...(device ?? { viewport: { width: 1400, height: 900 } }), locale: "ja-JP", acceptDownloads: true });
const touch = !!device?.hasTouch;
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

// 白い紙に書いた署名の写真をまねた画像（白地に黒い線）
const sample = join(outDir, "signature-photo.png");
{
  const p2 = await context.newPage();
  // 試験は「ページ全体を表示」で行う（ページ上の位置を、ページ全体が見えている前提で指す）
  await p2.addInitScript(() => {
    try {
      localStorage.setItem("washi-pdf.fit", "page");
    } catch {}
  });
  const b64 = await p2.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 400;
    c.height = 160;
    const g = c.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, 400, 160);
    g.strokeStyle = "#111";
    g.lineWidth = 6;
    g.beginPath();
    g.moveTo(60, 110);
    g.bezierCurveTo(120, 20, 180, 150, 240, 60);
    g.lineTo(330, 100);
    g.stroke();
    return c.toDataURL("image/png").split(",")[1];
  });
  writeFileSync(sample, Buffer.from(b64, "base64"));
  await p2.close();
}

await page.goto("file://" + html);
await page.waitForSelector(".dropzone", { timeout: 30000 });
await page.setInputFiles('input[type="file"][accept*="pdf"]', join(root, "test", "fixtures", "en-standard14.pdf"));
await page.waitForSelector(".card", { timeout: 30000 });
await page.click('button[role="tab"]:has-text("編集")');
await page.waitForSelector(".page-canvas");
await page.waitForFunction(() => !document.querySelector(".page-loading"));
const openSign = async () => {
  // 画面の幅によっては、並びに入りきらない道具は「その他」に入る（タブレット・スマホの幅）
  const direct = page.locator("button.tool:visible").filter({ hasText: /^署名$/ }).first();
  if (await direct.count()) await direct.click();
  else {
    await page.locator("button.tool:visible").filter({ hasText: /^その他$/ }).first().click();
    await page.locator(".tool-sheet button.tool").filter({ hasText: /^署名$/ }).first().click();
  }
  await page.waitForSelector(".modal .sign-pad, .modal .seg", { timeout: 10000 });
};
const images = () => page.locator(".obj-image").count();

// 1. 手書き
await openSign();
if (!(await page.locator(".modal .btn.primary").isDisabled())) await fail("何も描いていないのに置ける");
const pad = await page.locator(".sign-pad").boundingBox();
/** 線を引く：タッチの端末では指でなぞる操作（pointerType=touch の連続した pointer イベント）で、それ以外はマウスで */
const stroke = async (pts) => {
  if (!touch) {
    await page.mouse.move(pad.x + pts[0][0], pad.y + pts[0][1]);
    await page.mouse.down();
    for (const [x, y] of pts.slice(1)) await page.mouse.move(pad.x + x, pad.y + y);
    await page.mouse.up();
    return;
  }
  await page.locator(".sign-pad").evaluate((el, pts) => {
    const r = el.getBoundingClientRect();
    const fire = (type, [x, y]) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: "touch", isPrimary: true, clientX: r.left + x, clientY: r.top + y, pressure: type === "pointerup" ? 0 : 0.5, buttons: type === "pointerup" ? 0 : 1 }));
    fire("pointerdown", pts[0]);
    for (const p of pts.slice(1)) fire("pointermove", p);
    fire("pointerup", pts[pts.length - 1]);
  }, pts);
};
await stroke(Array.from({ length: 21 }, (_, i) => [40 + i * 12, 120 - Math.sin(i / 2) * 60]));
await stroke(Array.from({ length: 7 }, (_, i) => [80 + (220 * i) / 6, 150 - (10 * i) / 6]));
await page.click(".modal .btn.primary");
await page.waitForFunction(() => document.querySelectorAll(".obj-image").length === 1, null, { timeout: 15000 }).catch(() => fail("手書きの署名が置かれない"));
console.log("ok  手書きの署名を置いた");

// 2. 印鑑
await openSign();
await page.locator(".modal .seg button", { hasText: "印鑑" }).click();
await page.fill(".modal .sign-seal-form input", "山田");
await page.click(".modal .btn.primary");
await page.waitForFunction(() => document.querySelectorAll(".obj-image").length === 2, null, { timeout: 15000 }).catch(() => fail("印鑑が置かれない"));
console.log("ok  印鑑を置いた");

// 3. 画像（白い背景を透明にする）。前に作った署名が「もう一度置く」一覧に出ている
await openSign();
if ((await page.locator(".sign-recent-item").count()) !== 2) await fail("作った署名が一覧に出ていない");
await page.locator(".modal .seg button", { hasText: "画像" }).click();
await page.setInputFiles('.modal input[type="file"]', sample);
await page.waitForSelector(".sign-image-preview img", { timeout: 15000 });
await page.click(".modal .btn.primary");
await page.waitForFunction(() => document.querySelectorAll(".obj-image").length === 3, null, { timeout: 15000 }).catch(() => fail("画像の署名が置かれない"));
console.log("ok  画像の署名を置いた");
if ((await images()) !== 3) await fail("置いた数が合わない");

// 保存して中身を確かめる
const [download] = await Promise.all([page.waitForEvent("download"), page.click('button.btn.primary:has-text("保存")')]);
const saved = join(outDir, "signed.pdf");
await download.saveAs(saved);
const doc = await PDFDocument.load(readFileSync(saved));
const pg = doc.getPage(0);
const xobj = pg.node.Resources()?.lookup(PDFName.of("XObject"));
const imgs = xobj instanceof PDFDict ? xobj.entries().filter(([, v]) => doc.context.lookup(v)?.dict?.lookup(PDFName.of("Subtype")) === PDFName.of("Image")) : [];
if (imgs.length !== 3) await fail(`ページの画像が 3 つではない: ${imgs.length}`);
// どれも透明な部分を持つ（SMask）：背景を塗りつぶしていない
const masked = imgs.filter(([, v]) => doc.context.lookup(v).dict.has(PDFName.of("SMask"))).length;
if (masked !== 3) await fail(`透明な背景になっていない画像がある: ${masked}/3`);
// ページの内容に描かれている（注釈ではない）
const contents = pg.node.Contents();
const text = (contents instanceof PDFArray ? contents.asArray() : [contents])
  .map((r) => doc.context.lookup(r))
  .filter((s) => s instanceof PDFRawStream)
  .map((s) => Buffer.from(decodePDFRawStream(s).decode()).toString("latin1"))
  .join("\n");
const drawn = imgs.filter(([k]) => text.includes(`${k.toString()} Do`)).length;
if (drawn !== 3) await fail(`ページの内容に描かれていない画像がある: ${drawn}/3`);
const annots = pg.node.lookup(PDFName.of("Annots"));
if (annots instanceof PDFArray && annots.size() > 0) await fail("注釈として入っている");
console.log("ok  保存した PDF：画像 3 つがページの内容に描かれ、注釈は無い");

if (network.length) await fail("通信が発生: " + network[0]);
if (errors.length) await fail("ページのエラー: " + errors[0]);
await browser.close();
console.log("sign-flow: OK");

// ブラウザをまたいだ一巡の検査：開く → 元の文字の書き換え → 文字を足す → 編集の道具をすべて選ぶ →
// 「ツール」のカードをすべて開いて閉じる → 保存。どこかで例外やコンソールのエラーが出れば失敗。
//   node test/e2e/browsers-flow.mjs [--browser=chromium|firefox|webkit] [--mobile] [--device="iPad Pro 11"]
//   --device は Playwright の端末の設定（画面の大きさ・タッチ・UA）。iPhone のように狭い端末は --mobile も付ける
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const pw = require("playwright");
const { PDFDocument, PDFName } = require("pdf-lib");
const name = (process.argv.find((a) => a.startsWith("--browser=")) ?? "--browser=chromium").slice(10);
const mobile = process.argv.includes("--mobile");
const root = process.cwd();
const html = join(root, "dist", "washi-pdf.html");
const outDir = join(root, "dist", ".e2e");
mkdirSync(outDir, { recursive: true });
const deviceName = process.argv.find((a) => a.startsWith("--device="))?.slice(9);
const device = deviceName ? pw.devices[deviceName] : null;
if (deviceName && !device) throw new Error(`端末の設定がありません: ${deviceName}`);
const tag = `${name}${mobile ? "-mobile" : ""}${deviceName ? "-" + deviceName.replace(/\W+/g, "_") : ""}`;

const browser = await pw[name].launch();
// （Firefox は isMobile を受け付けないので、狭い画面とタッチだけを指定する）
const context = await browser.newContext(
  device ? { ...device, locale: "ja-JP", acceptDownloads: true } : mobile ? { viewport: { width: 390, height: 844 }, hasTouch: true, ...(name === "firefox" ? {} : { isMobile: true }), locale: "ja-JP", acceptDownloads: true } : { viewport: { width: 1400, height: 900 }, locale: "ja-JP", acceptDownloads: true },
);
const page = await context.newPage();
// 試験は「ページ全体を表示」で行う（ページ上の位置を、ページ全体が見えている前提で指す）
await page.addInitScript(() => {
  try {
    localStorage.setItem("washi-pdf.fit", "page");
  } catch {}
});
const errors = [];
const network = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
// Safari（WebKit）は、まだ対応していない viewport の指定（interactive-widget）を「無視した」とコンソールに出す。動作には影響しない
const HARMLESS = /Viewport argument key "interactive-widget" not recognized/;
page.on("console", (m) => m.type() === "error" && !HARMLESS.test(m.text()) && errors.push(`console: ${m.text()}`));
page.on("request", (r) => {
  const u = r.url();
  if (!u.startsWith("file://") && !u.startsWith("blob:") && !u.startsWith("data:")) network.push(u);
});
const fail = async (msg) => {
  await page.screenshot({ path: join(outDir, `browsers-${tag}-fail.png`) }).catch(() => {});
  console.error(`FAIL (${tag}): ${msg}`);
  if (errors.length) console.error(errors.join("\n"));
  await browser.close();
  process.exit(1);
};
const step = async (label, fn) => {
  const before = errors.length;
  try {
    await fn();
  } catch (e) {
    await fail(`${label}: ${String(e).split("\n")[0]}`);
  }
  if (errors.length > before) await fail(`${label}: エラーが出た`);
  console.log(`ok  ${label}`);
};
/** 開いているダイアログを閉じる（閉じるボタン → キャンセル → Esc の順に試す） */
const closeDialogs = async () => {
  for (let i = 0; i < 4 && (await page.locator(".modal").count()); i++) {
    const close = page.locator(".modal").last().locator('button[aria-label="閉じる"], button[title="閉じる"], .modal-close').first();
    if (await close.count()) await close.click().catch(() => {});
    else await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
  }
  if (await page.locator(".modal").count()) throw new Error("ダイアログが閉じない");
};

await step("開く", async () => {
  await page.goto("file://" + html);
  await page.waitForSelector(".dropzone", { timeout: 60000 });
  await page.setInputFiles('input[type="file"][accept*="pdf"]', join(root, "test", "fixtures", "en-standard14.pdf"));
  await page.waitForSelector(".card", { timeout: 60000 });
});

await step("編集画面を開く", async () => {
  await page.click('button[role="tab"]:has-text("編集")');
  await page.waitForFunction(() => !document.querySelector(".page-loading"), null, { timeout: 60000 });
});

// 編集の道具：並びに出ているものと、スマホでは「その他」の一覧にあるものを、すべて選ぶ
const pickTool = async (label) => {
  const direct = page.locator(`.tool-group > .tool-wrap button.tool:has-text("${label}"), .tool-group > button.tool:has-text("${label}")`).first();
  // 画面の幅によっては、並びに入りきらない道具は隠れて「その他」に入る（タブレットの幅など）
  if ((await direct.count()) && (await direct.isVisible())) return direct.click();
  // 前に開いた「その他」の一覧や、道具の設定の小窓が開いたままなら閉じてから押す
  if (await page.locator(".tool-sheet").isVisible().catch(() => false)) await page.keyboard.press("Escape");
  await page.locator('button.tool:visible:has-text("その他")').first().click({ timeout: 10000 }).catch(async () => {
    await page.keyboard.press("Escape");
    await page.locator('button.tool:visible:has-text("その他")').first().click();
  });
  await page.locator(`.tool-sheet button.tool:has-text("${label}")`).first().click();
};
const TOOL_LABELS = ["既存文字", "既存画像", "文字", "四角", "楕円", "線", "白塗り", "墨消し", "ハイライト", "下線", "取り消し線", "付箋", "ペン", "スタンプ", "リンク", "入力欄", "計測", "選択"];
await step(`編集の道具を順に選ぶ（${TOOL_LABELS.length} 個）`, async () => {
  for (const label of TOOL_LABELS) {
    await pickTool(label);
    await page.waitForTimeout(120);
    await closeDialogs();
  }
});

await step("元の文字を書き換える", async () => {
  await pickTool("既存文字");
  await page.waitForSelector(".run-box", { timeout: 60000 });
  await page.waitForTimeout(300);
  const titles = await page.$$eval(".run-box", (els) => els.map((e) => e.getAttribute("title") ?? ""));
  const i = titles.findIndex((x) => x.includes("Quarterly Report"));
  if (i < 0) throw new Error("行が見つからない");
  const box = page.locator(".run-box").nth(i);
  if (mobile) await box.tap();
  else await box.click();
  const ta = page.locator(".props textarea, .mobile-edit textarea, textarea").first();
  await ta.waitFor({ timeout: 20000 });
  await ta.fill((await ta.inputValue()).replace("Quarterly", "Annual"));
  await page.waitForTimeout(400);
});

// リンク・入力欄・計測：ページの上のほうに、横に並べてドラッグで置く（保存した PDF で確かめる）
let linkSet = false;
await step("リンク・入力欄・計測を置く", async () => {
  const drag = async (label, fx0, fx1) => {
    await pickTool(label);
    // スマホでは、行を選ぶと文字が読める大きさまで拡大している。全体表示に戻してから位置を測る
    if (mobile) {
      await page.click(".zoom-val");
      await page.waitForTimeout(400);
    }
    const bb = await page.locator(".page-slot.current .page").boundingBox();
    const y = bb.y + bb.height * 0.24;
    await page.mouse.move(bb.x + bb.width * fx0, y);
    await page.mouse.down();
    await page.mouse.move(bb.x + bb.width * fx1, y + bb.height * 0.04, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(300);
  };
  await drag("リンク", 0.12, 0.3);
  if (!(await page.locator(".obj-link").count())) throw new Error("リンクの枠ができない");
  // URL を入れられる画面（設定の欄が見えている）なら入れて、保存した PDF でも確かめる
  const url = page.locator('.props input[type="url"]').first();
  if (await url.isVisible().catch(() => false)) {
    await url.fill("https://example.com/");
    linkSet = true;
  }
  await drag("入力欄", 0.38, 0.58);
  if (!(await page.locator(".obj-field").count())) throw new Error("入力欄ができない");
  await drag("計測", 0.66, 0.86);
  if (!/mm/.test(await page.locator(".obj-measure .measure-label").first().innerText())) throw new Error("計測の数値が出ない");
  await page.keyboard.press("Escape");
});

await step("署名のダイアログを開いて閉じる", async () => {
  await pickTool("選択");
  await pickTool("署名");
  await page.waitForSelector(".modal", { timeout: 20000 });
  await closeDialogs();
});

await step("「ツール」のカードをすべて開いて閉じる", async () => {
  await page.click('button[role="tab"]:has-text("ツール")');
  await page.waitForSelector(".tool-card");
  const n = await page.locator(".tool-card").count();
  let opened = 0;
  for (let i = 0; i < n; i++) {
    const card = page.locator(".tool-card").nth(i);
    const title = (await card.locator("b").first().innerText().catch(() => "")).trim();
    // その場で実行される道具（並べ替え・書き出し・切り替え）は押さない：ここでは、設定画面が開いて閉じることを確かめる
    if ((await card.isDisabled()) || /逆順|白紙|選択ページ|注釈を外す|印刷|共有/.test(title)) continue;
    const before = errors.length;
    await card.click();
    await page.waitForTimeout(250);
    if (await page.locator(".modal").count()) opened++;
    await closeDialogs();
    if (errors.length > before) throw new Error(`「${title}」でエラー`);
    // 押すと切り替わる道具（グレースケール化など）は、もう一度押して元に戻す
    if ((await page.locator(".tool-card").nth(i).getAttribute("class"))?.includes("active") && !(await page.locator(".modal").count())) {
      await page.locator(".tool-card").nth(i).click();
      await page.waitForTimeout(150);
      await closeDialogs();
    }
  }
  if (opened < 8) throw new Error(`開いた設定画面が少ない（${opened}）`);
  console.log(`    カード ${n} 枚、設定画面 ${opened} 個`);
});

await step("保存する", async () => {
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.click('button.btn.primary:has-text("保存"), button.btn.primary[title*="保存"]')]);
  const saved = join(outDir, `browsers-${tag}.pdf`);
  await download.saveAs(saved);
  const bytes = readFileSync(saved);
  if (bytes.length < 1000) throw new Error(`保存した PDF が小さすぎる（${bytes.length} B）`);
  const doc = await PDFDocument.load(bytes);
  if (doc.getPageCount() !== 1) throw new Error("ページ数が違う");
  const pdfjs = await import(require.resolve("pdfjs-dist/legacy/build/pdf.mjs"));
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const text = (await (await pdf.getPage(1)).getTextContent()).items.map((it) => it.str ?? "").join(" ");
  if (!text.includes("Annual Report") || text.includes("Quarterly")) throw new Error(`書き換えが保存されていない: ${text.slice(0, 80)}`);
  if (!/\d mm/.test(text)) throw new Error("計測の数値が保存されていない");
  const subtypes = (doc.getPage(0).node.Annots()?.asArray() ?? []).map((r) => String(doc.context.lookup(r)?.get?.(PDFName.of("Subtype"))));
  if (!subtypes.includes("/Widget")) throw new Error(`入力欄が保存されていない: ${subtypes}`);
  if (linkSet && !subtypes.includes("/Link")) throw new Error(`リンクが保存されていない: ${subtypes}`);
  console.log(`    ${bytes.length} B（注釈：${subtypes.join(" ")}）`);
});

await browser.close();
if (network.length) {
  console.error(`FAIL (${tag}): 外部への通信`, network);
  process.exit(1);
}
console.log(`browsers-flow (${tag}): OK`);

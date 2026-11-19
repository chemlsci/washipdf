// 入力欄の作成：入力欄の道具で「罫線から入力欄を見つける」を押すと、表の空いた枠に入力欄が置かれ、名前は左の見出しになる
// （文字の入っている枠には置かない）。1 つをチェックボックスに、ドラッグで選択肢の入力欄を足して保存すると、PDF のフォームになる。
//   node test/e2e/form-create-flow.mjs
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { PDFDocument } = require("pdf-lib");

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
  await page.screenshot({ path: join(outDir, "form-create-fail.png") });
  await browser.close();
  process.exit(1);
};

await page.goto("file://" + html);
await page.waitForSelector(".dropzone");
await page.setInputFiles('input[type="file"][accept*="pdf"]', join(root, "test", "fixtures", "ja-form-table-libreoffice.pdf"));
await page.waitForSelector(".card");
await page.click('button[role="tab"]:has-text("編集")');
await page.waitForSelector(".page-canvas");
await page.click('button.tool:has-text("入力欄")');
await page.click('button:has-text("罫線から入力欄を見つける")');
await page.waitForSelector(".obj-field", { timeout: 15000 });
await page.waitForTimeout(300);
const names = await page.locator(".obj-field .field-name").allInnerTexts();
if (names.join("|") !== "氏名|住所|電話番号|備考") await fail(`見つけた入力欄が違う: ${names.join("|")}`);
console.log(`ok  罫線から入力欄を ${names.length} 個（${names.join("・")}）。文字の入った「部署」の枠には置かない`);
await page.screenshot({ path: join(outDir, "form-create.png") });

// 「電話番号」をチェックボックスに変える（試しに）、ドラッグで選択肢の入力欄を足す
await page.click('button.tool:has-text("選択")');
await page.locator('.obj-field:has(.field-name:text-is("電話番号"))').click();
await page.selectOption(".props select", "checkbox");
await page.click('button.tool:has-text("入力欄")');
const bb = await page.locator(".page-slot.current .page").boundingBox();
await page.mouse.move(bb.x + bb.width * 0.15, bb.y + bb.height * 0.6);
await page.mouse.down();
await page.mouse.move(bb.x + bb.width * 0.45, bb.y + bb.height * 0.63, { steps: 4 });
await page.mouse.up();
await page.selectOption(".props select", "dropdown");
await page.fill('.props input:not([type])', "区分");
await page.fill(".props textarea", "新規\n変更\n廃止");

const [download] = await Promise.all([page.waitForEvent("download"), page.click('button.btn.primary:has-text("保存")')]);
const saved = join(outDir, "form-created.pdf");
await download.saveAs(saved);
const form = (await PDFDocument.load(readFileSync(saved))).getForm();
const fields = form.getFields().map((f) => `${f.getName()}:${f.constructor.name.replace(/^PDF/, "")}`);
const want = ["氏名:TextField", "住所:TextField", "電話番号:CheckBox", "備考:TextField", "区分:Dropdown"];
if (JSON.stringify(fields.sort()) !== JSON.stringify(want.sort())) await fail(`保存したフォームが違う: ${fields.join(", ")}`);
if (!form.getTextField("備考").isMultiline()) await fail("備考が複数行になっていない");
if (form.getDropdown("区分").getOptions().join("|") !== "新規|変更|廃止") await fail("選択肢が違う");
console.log("ok  保存した PDF のフォーム：", fields.join(", "));

// 下線だけの記入欄（「氏名：＿＿＿」の文字の下線と、「住所：」の右に引いた線）を見つける。下線を引いた文字・区切りの線には置かない
await page.goto("file://" + html);
await page.waitForSelector(".dropzone");
if (await page.$('button:has-text("破棄する")')) await page.click('button:has-text("破棄する")');
await page.setInputFiles('input[type="file"][accept*="pdf"]', join(root, "test", "fixtures", "ja-form-blanks-libreoffice.pdf"));
await page.waitForSelector(".card");
await page.click('button[role="tab"]:has-text("編集")');
await page.waitForSelector(".page-canvas");
await page.click('button.tool:has-text("入力欄")');
await page.click('button:has-text("罫線から入力欄を見つける")');
await page.waitForSelector(".obj-field", { timeout: 15000 });
await page.waitForTimeout(300);
const blanks = await page.locator(".obj-field .field-name").allInnerTexts();
if (blanks.join("|") !== "氏名|住所") await fail(`下線だけの記入欄の検出が違う: ${blanks.join("|")}`);
console.log(`ok  下線だけの記入欄を見つけた：${blanks.join("・")}`);
// 住所を日付に（試しに）、ラジオボタン 2 つ（同じ組）と署名欄をドラッグで足す
await page.click('button.tool:has-text("選択")');
await page.locator('.obj-field:has(.field-name:text-is("住所"))').click();
await page.selectOption(".props select", "date");
const pb = await page.locator(".page-slot.current .page").boundingBox();
const dragField = async (fx, fy, w, h) => {
  await page.click('button.tool:has-text("入力欄")');
  await page.mouse.move(pb.x + pb.width * fx, pb.y + pb.height * fy);
  await page.mouse.down();
  await page.mouse.move(pb.x + pb.width * fx + w, pb.y + pb.height * fy + h, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(150);
};
for (const [i, v] of [[0, "男"], [1, "女"]]) {
  await dragField(0.2 + i * 0.1, 0.5, 14, 14);
  await page.selectOption(".props select", "radio");
  await page.fill('.props label:has-text("組の名前") input', "性別");
  await page.fill('.props label:has-text("この選択肢の値") input', v);
}
await dragField(0.2, 0.6, 160, 40);
await page.selectOption(".props select", "signature");
await page.fill('.props label:has-text("名前") input', "署名");
const [d2] = await Promise.all([page.waitForEvent("download"), page.click('button.btn.primary:has-text("保存")')]);
const saved2 = join(outDir, "form-blanks.pdf");
await d2.saveAs(saved2);
const doc2 = await PDFDocument.load(readFileSync(saved2));
const f2 = doc2.getForm().getFields().map((f) => `${f.getName()}:${f.constructor.name.replace(/^PDF/, "")}`).sort();
const want2 = ["性別:RadioGroup", "住所:TextField", "氏名:TextField", "署名:Signature"].sort();
if (JSON.stringify(f2) !== JSON.stringify(want2)) await fail(`保存したフォームが違う: ${f2.join(", ")}`);
if (doc2.getForm().getRadioGroup("性別").getOptions().join("|") !== "男|女") await fail("ラジオボタンの選択肢が違う");
const tu = doc2.getForm().getTextField("住所").acroField.dict.lookup(require("pdf-lib").PDFName.of("TU"));
if (!tu || !/2026/.test(tu.decodeText())) await fail("日付の欄に書き方の説明が無い");
console.log("ok  ラジオボタン（組）・日付・署名欄を保存：", f2.join(", "));
if (errors.length) await fail("ページのエラー: " + errors[0]);
await browser.close();
console.log("form-create-flow: OK");

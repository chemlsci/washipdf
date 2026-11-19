// テスト用 PDF コーパスを test/fixtures/ に生成する（自作のみ。実文書は入れない）。
//   npm run make-fixtures
// 日本語フォントはアプリと同じ自前サブセット化（src/lib/pdfFont.ts）で埋め込む。
// LibreOffice がある環境では、HTML から Writer 経由の PDF も作る（CI では生成済みのものを使う）。
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { degrees, PDFDict, PDFDocument, type PDFFont, PDFName, type PDFPage, PDFString, StandardFonts } from "pdf-lib";
import { embedSubsetFont, finishSubsetFonts } from "@/lib/pdfFont";

const root = process.cwd();
const out = join(root, "test", "fixtures");
mkdirSync(out, { recursive: true });

const gothic = new Uint8Array(readFileSync(join(root, "assets/fonts/BIZUDPGothic-Regular.ttf")));
const mincho = new Uint8Array(readFileSync(join(root, "assets/fonts/BIZUDPMincho-Regular.ttf")));

const subsetFonts = new WeakMap<PDFDocument, PDFFont[]>();
/** 使う文字だけのサブセットを、アプリと同じ方法で埋め込む */
async function embedJa(doc: PDFDocument, bytes: Uint8Array, text: string): Promise<PDFFont> {
  const f = await embedSubsetFont(doc, bytes, text);
  const arr = subsetFonts.get(doc) ?? [];
  arr.push(f);
  subsetFonts.set(doc, arr);
  return f;
}

const save = async (doc: PDFDocument, name: string) => {
  await finishSubsetFonts(doc, subsetFonts.get(doc) ?? []);
  const bytes = await doc.save({ useObjectStreams: false });
  writeFileSync(join(out, name), bytes);
  console.log("wrote", name, bytes.length);
};

/** pdf-lib の PDFFont をページのリソースに登録して名前を返す */
const addFont = (page: PDFPage, font: PDFFont) => page.node.newFontDictionary(font.name, font.ref).decodeText();

const hex = (font: PDFFont, text: string) => font.encodeText(text).toString();

const setContent = (doc: PDFDocument, page: PDFPage, content: string) => {
  const stream = doc.context.flateStream(content);
  page.node.set(PDFName.of("Contents"), doc.context.register(stream));
};

/* ---------- 1. 日本語・埋め込みサブセット（Identity-H）。Tj の連続・TJ・Td の混在 ---------- */
async function japaneseSubset() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const gothicText =
    "株式会社サンプル商事 御中お見積書（2026年11月8日）下記のとおりお見積り申し上げます。納期：備考：「禁則処理」のテスト、です。長い行がどのように折り返されるかを確認します。この行は編集しない。";
  const minchoText =
    "合計金額：１２３，４５６円（税込）ご発注後２週間以内。有効期限は発行日より３０日間です。本書は自動テスト用に生成した架空の文書です。実在の会社・人物・取引とは関係ありません。段落として編集したとき、この三行の幅と行数の中で折り返されることを確認します。最後の行は短い。";
  const fg = await embedJa(doc, gothic, gothicText);
  const fm = await embedJa(doc, mincho, minchoText);
  const page = doc.addPage([595.28, 841.89]);
  const g = addFont(page, fg);
  const m = addFont(page, fm);
  const lines = [
    "株式会社サンプル商事 御中",
    "お見積書（2026年11月8日）",
    "下記のとおりお見積り申し上げます。",
    "合計金額：１２３，４５６円（税込）",
    "納期：ご発注後２週間以内。有効期限は発行日より３０日間です。",
    "備考：「禁則処理」のテスト、です。長い行がどのように折り返されるかを確認します。",
  ];
  // 1行目：単一 Tj
  // 2行目：複数 Tj を Td 無しで連結（進み量に依存）
  // 3行目：TJ（カーニング付き）
  // 4行目：明朝、文字間隔 Tc
  // 5行目：Tm で絶対位置、別フォント混在（「納期：」だけゴシック）
  const content = [
    "BT",
    `/${g} 14 Tf 1 0 0 1 72 760 Tm ${hex(fg, lines[0])} Tj`,
    `0 -24 Td ${hex(fg, "お見積書")} Tj ${hex(fg, "（2026年")} Tj ${hex(fg, "11月8日）")} Tj`,
    `0 -24 Td [${hex(fg, "下記のとおり")} -120 ${hex(fg, "お見積り")} 80 ${hex(fg, "申し上げます。")}] TJ`,
    `/${m} 14 Tf 1 Tc 0 -24 Td ${hex(fm, lines[3])} Tj 0 Tc`,
    `/${g} 12 Tf 1 0 0 1 72 664 Tm ${hex(fg, "納期：")} Tj /${m} 12 Tf ${hex(fm, "ご発注後２週間以内。有効期限は発行日より３０日間です。")} Tj`,
    `/${g} 11 Tf 1 0 0 1 72 640 Tm ${hex(fg, lines[5])} Tj`,
    "ET",
    // 段落ブロック（3行、同じ行送り）
    "BT",
    `/${m} 10.5 Tf 1 0 0 1 72 600 Tm 15 TL`,
    `${hex(fm, "本書は自動テスト用に生成した架空の文書です。実在の会社・人物・取引とは関係ありません。")} Tj T*`,
    `${hex(fm, "段落として編集したとき、この三行の幅と行数の中で折り返されることを確認します。")} Tj T*`,
    `${hex(fm, "最後の行は短い。")} Tj`,
    "ET",
    // 下の図形（画像差分で変化しないことを確認する目印）
    "0.2 0.4 0.8 rg 72 500 200 40 re f",
    "0 g BT",
    `/${g} 10 Tf 1 0 0 1 72 480 Tm ${hex(fg, "この行は編集しない。")} Tj`,
    "ET",
  ].join("\n");
  setContent(doc, page, content);
  await save(doc, "ja-subset-identity.pdf");
}

/* ---------- 2. 英語・標準14フォント（WinAnsi、非埋め込み）。Tw / Tc / TJ ---------- */
async function englishStandard() {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const times = await doc.embedFont(StandardFonts.TimesRoman);
  const page = doc.addPage([612, 792]);
  const h = addFont(page, helv);
  const t = addFont(page, times);
  const content = [
    "BT",
    `/${h} 12 Tf 1 0 0 1 72 720 Tm (Quarterly Report 2026 Q3) Tj`,
    `0 -18 Td 2 Tw (Revenue grew by 12 percent compared to last year.) Tj 0 Tw`,
    `0 -18 Td [(Kerned) -250 (text) -250 (with) -250 (TJ) -250 (adjustments.)] TJ`,
    `/${t} 12 Tf 0 -18 Td 0.5 Tc (Times Roman line with character spacing.) Tj 0 Tc`,
    `/${h} 12 Tf 0 -18 Td (Part one, ) Tj (part two, ) Tj (part three.) Tj`,
    "ET",
    "0.9 0.3 0.2 rg 72 560 150 30 re f",
    "0 g BT",
    `/${h} 10 Tf 1 0 0 1 72 540 Tm (Unchanged footer line.) Tj`,
    "ET",
  ].join("\n");
  setContent(doc, page, content);
  await save(doc, "en-standard14.pdf");
}

/* ---------- 3. 回転ページ（/Rotate 90）＋ cm による変換 ---------- */
async function rotatedPage() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const fg = await embedJa(doc, gothic, "回転ページの見出し二行目のテキスト。cm で拡大した文字");
  const page = doc.addPage([595.28, 841.89]);
  page.setRotation(degrees(90));
  const g = addFont(page, fg);
  const content = [
    "q 1 0 0 1 0 0 cm",
    "BT",
    // 表示上で水平になるよう、ページ座標では 90 度回転した向きに書く
    `/${g} 14 Tf 0 1 -1 0 500 100 Tm ${hex(fg, "回転ページの見出し")} Tj`,
    `0 -24 Td ${hex(fg, "二行目のテキスト。")} Tj`,
    "ET",
    "Q",
    "q 2 0 0 2 0 0 cm BT",
    `/${g} 7 Tf 0 1 -1 0 200 60 Tm ${hex(fg, "cm で拡大した文字")} Tj`,
    "ET Q",
  ].join("\n");
  setContent(doc, page, content);
  await save(doc, "ja-rotated90.pdf");
}

/* ---------- 4. Form XObject 内のテキスト、透明テキスト（Tr 3）、縦書き（Identity-V） ---------- */
async function specialCases() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const fg = await embedJa(doc, gothic, "フォームの中の文字透明なOCRテキスト通常の編集できる行縦書きの文字列");
  const page = doc.addPage([595.28, 841.89]);
  const g = addFont(page, fg);

  // Form XObject
  const formContent = `BT /${g} 12 Tf 1 0 0 1 0 0 Tm ${hex(fg, "フォームの中の文字")} Tj ET`;
  const fontDict = doc.context.obj({ [g]: fg.ref });
  const form = doc.context.flateStream(formContent, {
    Type: "XObject",
    Subtype: "Form",
    BBox: [0, -5, 300, 20],
    Resources: { Font: fontDict },
  });
  const formRef = doc.context.register(form);
  page.node.Resources()!.set(PDFName.of("XObject"), doc.context.obj({ Fx1: formRef }));

  // 縦書きフォント（Identity-V）。フォント辞書は保存時に書かれるので先に埋め込む
  await fg.embed();
  const vFontDict = (doc.context.lookup(fg.ref) as PDFDict).clone(doc.context);
  vFontDict.set(PDFName.of("Encoding"), PDFName.of("Identity-V"));
  const vRef = doc.context.register(vFontDict);
  const v = page.node.newFontDictionary("Vert", vRef).decodeText();

  const content = [
    "q 1 0 0 1 72 700 cm /Fx1 Do Q",
    "BT",
    `/${g} 12 Tf 3 Tr 1 0 0 1 72 650 Tm ${hex(fg, "透明なOCRテキスト")} Tj 0 Tr`,
    `/${g} 12 Tf 1 0 0 1 72 620 Tm ${hex(fg, "通常の編集できる行")} Tj`,
    `/${v} 12 Tf 1 0 0 1 500 700 Tm ${hex(fg, "縦書きの文字列")} Tj`,
    "ET",
  ].join("\n");
  setContent(doc, page, content);
  await save(doc, "ja-special-cases.pdf");
}

/* ---------- 4b. 縦書きの段落（Identity-V、3 列）。列またぎの流し込みと縦中横のテスト用 ---------- */
async function verticalParagraph() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const cols = ["縦書きの段落です。", "第十二回の会議は、", "二〇二六年に開く。"];
  const fg = await embedJa(doc, gothic, cols.join("") + "横書きの行");
  const page = doc.addPage([595.28, 841.89]);
  const g = addFont(page, fg);
  await fg.embed();
  const vFontDict = (doc.context.lookup(fg.ref) as PDFDict).clone(doc.context);
  vFontDict.set(PDFName.of("Encoding"), PDFName.of("Identity-V"));
  const v = page.node.newFontDictionary("Vert", doc.context.register(vFontDict)).decodeText();
  const content = [
    "BT",
    `/${g} 12 Tf 1 0 0 1 72 780 Tm ${hex(fg, "横書きの行")} Tj`,
    ...cols.map((c, i) => `/${v} 14 Tf 1 0 0 1 ${500 - i * 22} 700 Tm ${hex(fg, c)} Tj`),
    "ET",
  ].join("\n");
  setContent(doc, page, content);
  await save(doc, "ja-vertical.pdf");
}

/* ---------- 5. 非埋め込み和文フォント（MS 明朝 + 90ms-RKSJ-H、ToUnicode 無し） ---------- */
async function nonEmbeddedJapanese() {
  const doc = await PDFDocument.create();
  const cidFont = doc.context.obj({
    Type: "Font",
    Subtype: "CIDFontType2",
    BaseFont: "MS-Mincho",
    CIDSystemInfo: { Registry: PDFString.of("Adobe"), Ordering: PDFString.of("Japan1"), Supplement: 2 },
    FontDescriptor: doc.context.register(
      doc.context.obj({
        Type: "FontDescriptor",
        FontName: "MS-Mincho",
        Flags: 6,
        FontBBox: [0, -141, 1000, 859],
        ItalicAngle: 0,
        Ascent: 859,
        Descent: -141,
        CapHeight: 859,
        StemV: 69,
      }),
    ),
    DW: 1000,
    W: [231, 632, 500],
  });
  const type0 = doc.context.obj({
    Type: "Font",
    Subtype: "Type0",
    BaseFont: "MS-Mincho",
    Encoding: "90ms-RKSJ-H",
    DescendantFonts: [doc.context.register(cidFont)],
  });
  const page = doc.addPage([595.28, 841.89]);
  const f = page.node.newFontDictionary("MSMincho", doc.context.register(type0)).decodeText();
  // Shift_JIS で「日本語タスト」（先頭 12 バイトぶん。字そのものに意味は無く、幅の分からないフォントの試験用）
  const sjis = "93fa967b8cea835e8358836783";
  const content = `BT /${f} 14 Tf 1 0 0 1 72 760 Tm <${sjis.slice(0, 24)}> Tj ET`;
  setContent(doc, page, content);
  await save(doc, "ja-nonembedded-rksj.pdf");
}

/* ---------- 6. LibreOffice Writer から出力した日本語 PDF（表・2段組み風） ---------- */
function libreOffice() {
  let soffice: string | null = null;
  for (const c of ["soffice", "libreoffice"]) {
    try {
      execFileSync("which", [c], { stdio: "ignore" });
      soffice = c;
      break;
    } catch {
      /* noop */
    }
  }
  if (!soffice) {
    console.log("LibreOffice が無いため ja-libreoffice-writer.pdf は生成しません（既存のファイルを使います）");
    return;
  }
  const tmp = mkdtempSync(join(tmpdir(), "fixtures-"));
  // LibreOffice に同梱フォントを使わせる
  const fontDir = join(process.env.HOME ?? tmp, ".fonts");
  mkdirSync(fontDir, { recursive: true });
  copyFileSync(join(root, "assets/fonts/BIZUDPGothic-Regular.ttf"), join(fontDir, "BIZUDPGothic-Regular.ttf"));
  copyFileSync(join(root, "assets/fonts/BIZUDPMincho-Regular.ttf"), join(fontDir, "BIZUDPMincho-Regular.ttf"));
  try {
    execFileSync("fc-cache", ["-f"], { stdio: "ignore" });
  } catch {
    /* noop */
  }
  const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
body { font-family: "BIZ UDPMincho"; font-size: 10.5pt; }
h1 { font-family: "BIZ UDPGothic"; font-size: 16pt; }
table { border-collapse: collapse; width: 100%; }
td, th { border: 1px solid #000; padding: 4px; font-family: "BIZ UDPGothic"; }
</style></head><body>
<h1>社内規程（テスト用サンプル）</h1>
<p>この文書は自動テストのために作成した架空の文書です。実在の企業・団体・個人とは一切関係ありません。日本語の折り返しと禁則処理を確認するため、句読点、「かぎ括弧」、（丸括弧）、長音「ー」などを含めています。</p>
<p>第１条　この規程は、PDF 編集ツールの検証を目的とする。第２条　検証は自動で行う。</p>
<table><tr><th>項目</th><th>内容</th><th>備考</th></tr>
<tr><td>結合</td><td>複数のPDFを１つにする</td><td>順序を保持</td></tr>
<tr><td>分割</td><td>ページ範囲で分ける</td><td>ZIP出力</td></tr></table>
<table style="border:none"><tr><td style="border:none;width:50%;vertical-align:top">左段：二段組みの左側の段落です。ここも折り返しの対象になります。English words like LibreOffice and PDF are mixed in.</td>
<td style="border:none;width:50%;vertical-align:top">右段：二段組みの右側の段落です。左右の段が別のブロックとして検出されることを確認します。</td></tr></table>
</body></html>`;
  const src = join(tmp, "ja-libreoffice-writer.html");
  writeFileSync(src, html);
  try {
    execFileSync(soffice, ["--headless", "--convert-to", "pdf:writer_web_pdf_Export", "--outdir", tmp, src], { stdio: "ignore", timeout: 120000 });
    const pdf = join(tmp, "ja-libreoffice-writer.pdf");
    if (existsSync(pdf)) {
      copyFileSync(pdf, join(out, "ja-libreoffice-writer.pdf"));
      console.log("wrote ja-libreoffice-writer.pdf");
    }
  } catch (e) {
    console.log("LibreOffice の変換に失敗しました:", e instanceof Error ? e.message : e);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/* ---------- 7. 画像（JPEG の赤、PNG の青）と文字。既存画像の削除・墨消し・圧縮のテスト用 ---------- */
async function imagesFixture() {
  let canvasMod: typeof import("@napi-rs/canvas");
  try {
    canvasMod = await import("@napi-rs/canvas");
  } catch {
    console.log("@napi-rs/canvas が無いので images.pdf は作りません");
    return;
  }
  const red = canvasMod.createCanvas(80, 60);
  red.getContext("2d").fillStyle = "#ff0000";
  red.getContext("2d").fillRect(0, 0, 80, 60);
  const blue = canvasMod.createCanvas(50, 50);
  blue.getContext("2d").fillStyle = "#0000ff";
  blue.getContext("2d").fillRect(0, 0, 50, 50);
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  const j = await doc.embedJpg(await red.encode("jpeg", 90));
  const p = await doc.embedPng(await blue.encode("png"));
  page.drawImage(j, { x: 50, y: 180, width: 120, height: 90 });
  page.drawImage(p, { x: 220, y: 60, width: 100, height: 100 });
  page.drawText("Hello Images", { x: 50, y: 40, size: 18, font: await doc.embedFont(StandardFonts.Helvetica) });
  await save(doc, "images.pdf");
}

/* ---------- 7. 図形（パス）だけのページ。墨消しのパス実削除のテスト用 ---------- */
async function vectorFixture() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const f = addFont(page, helv);
  const content = [
    "q 10 10 380 280 re W n", // ページ全体のクリップ（範囲より大きい：形は変えない）
    "0.85 g 50 150 200 60 re f", // 表のセル背景（範囲が一部掛かる）
    "0 G 1 w 50 150 m 250 150 l S 50 210 m 250 210 l S", // 横罫線（範囲を横切る）
    "150 100 m 150 260 l S", // 縦罫線（範囲の中を通る）
    "0 0 1 RG 2 w 50 50 m 100 250 200 250 250 50 c S", // ベジェ曲線（範囲を横切る）
    "1 0 0 rg 0 g 130 170 m 170 170 l 170 190 l 130 190 l h f", // 範囲に完全に入る塗り（消える）
    "0 0.6 0 rg 0 0 0 RG 1 w 260 60 m 340 60 l 300 120 l b", // 閉じた塗り＋線（範囲外：そのまま）
    "q 0.7071 0.7071 -0.7071 0.7071 160 40 cm 0.5 0 0.5 rg 0 0 60 24 re f Q", // 回転した CTM の矩形（範囲に一部掛かる）
    "q 0.9 0.8 0.2 rg 300 200 60 40 re W f Q", // クリップを伴う塗り（形は変えられない）
    `BT /${f} 14 Tf 60 30 Td (Vector) Tj ET`,
    "Q",
  ].join("\n");
  setContent(doc, page, content);
  await save(doc, "vector.pdf");
}

/* ---------- 8. 電子署名付き（署名辞書に /ByteRange がある。署名そのものはダミー） ---------- */
async function signedFixture() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  page.drawText("Signed document", { x: 50, y: 200, size: 18, font: await doc.embedFont(StandardFonts.Helvetica) });
  const sig = doc.context.obj({ Type: "Sig", Filter: "Adobe.PPKLite", SubFilter: "adbe.pkcs7.detached", ByteRange: [0, 0, 0, 0], Contents: PDFString.of("") });
  const sigRef = doc.context.register(sig);
  const field = doc.context.obj({ Type: "Annot", Subtype: "Widget", FT: "Sig", T: PDFString.of("Signature1"), Rect: [0, 0, 0, 0], F: 4, P: page.ref, V: sigRef });
  const fieldRef = doc.context.register(field);
  page.node.set(PDFName.of("Annots"), doc.context.obj([fieldRef]));
  doc.catalog.set(PDFName.of("AcroForm"), doc.context.obj({ Fields: [fieldRef], SigFlags: 3 }));
  await save(doc, "signed.pdf");
}

/* ---------- 9. Form XObject：同じフォームを 2 回描く・入れ子・中に文字と図形と画像 ---------- */
async function formsFixture() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const page = doc.addPage([400, 300]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const fg = await embedJa(doc, gothic, "フォーム内の和文テキスト書き換え後");
  const f = page.node.newFontDictionary(helv.name, helv.ref).decodeText();
  const g = addFont(page, fg);
  // 内側のフォーム：灰色の四角と欧文
  const inner = doc.context.flateStream(`0.85 g 0 0 120 30 re f BT /${f} 12 Tf 6 10 Td (Inner text) Tj ET`, {
    Type: "XObject",
    Subtype: "Form",
    BBox: [0, 0, 120, 30],
    Resources: { Font: { [f]: helv.ref } },
  });
  const innerRef = doc.context.register(inner);
  // 外側のフォーム：和文テキスト、縦線、内側のフォーム（/Matrix で 10,40 へ）
  const outer = doc.context.flateStream(
    [`BT /${g} 12 Tf 0 0 0 rg 10 90 Td ${hex(fg, "フォーム内の和文テキスト")} Tj ET`, "0 0 1 RG 2 w 60 0 m 60 80 l S", "q 1 0 0 1 10 40 cm /Fi Do Q"].join("\n"),
    {
      Type: "XObject",
      Subtype: "Form",
      BBox: [0, 0, 200, 110],
      Matrix: [1, 0, 0, 1, 0, 0],
      Resources: { Font: { [g]: fg.ref }, XObject: { Fi: innerRef } },
    },
  );
  const outerRef = doc.context.register(outer);
  page.node.Resources()!.set(PDFName.of("XObject"), doc.context.obj({ Fo: outerRef }));
  const content = [
    `BT /${f} 14 Tf 20 270 Td (Page level text) Tj ET`,
    "q 1 0 0 1 20 140 cm /Fo Do Q", // 1 回目：左下
    "q 0.8 0 0 0.8 210 20 cm /Fo Do Q", // 2 回目：右下、80%
  ].join("\n");
  setContent(doc, page, content);
  await save(doc, "forms.pdf");
}

// 引数に名前を付けると、その 1 つだけ作り直す（例：node scripts/make-fixtures.mjs images）
const only = process.argv[2];
const run = async (name: string, fn: () => unknown) => {
  if (!only || only === name) await fn();
};
await run("ja", japaneseSubset);
await run("en", englishStandard);
await run("rotated", rotatedPage);
await run("special", specialCases);
await run("vertical", verticalParagraph);
await run("nonembedded", nonEmbeddedJapanese);
await run("images", imagesFixture);
await run("vector", vectorFixture);
await run("signed", signedFixture);
await run("forms", formsFixture);
await run("libreoffice", libreOffice);

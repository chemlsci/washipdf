import assert from "node:assert/strict";
import { test } from "node:test";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFString } from "pdf-lib";
import { parseCff } from "@/lib/cff";
import { getFontInfo } from "@/lib/pdfFontInfo";
import { bundledHasGlyph, coverage, defaultFont, fontList, loadFontBytes, pickFont } from "@/lib/fonts";
import { embedSubsetFont, finishSubsetFonts } from "@/lib/pdfFont";
import { needsShaping, scriptsIn } from "@/lib/scripts";
import { setCurrentLang } from "@/lib/i18n";
import { openPdf, pageText, setupFonts } from "./helpers";

setupFonts();

test("同梱フォントの一覧が manifest から読める", () => {
  const ids = fontList().map((f) => f.id);
  assert.ok(ids.includes("gothic") && ids.includes("notosans") && ids.includes("thai"));
  assert.equal(defaultFont("sans"), "gothic");
  assert.equal(defaultFont("serif"), "mincho");
});

test("文字範囲の分類", () => {
  assert.deepEqual([...scriptsIn("東京 Tokyo")].sort(), ["han", "latin"]);
  assert.deepEqual([...scriptsIn("Việt Nam")].sort(), ["latin", "vietnamese"]);
  assert.ok(needsShaping("مرحبا"));
  assert.ok(needsShaping("สวัสดี"));
  assert.ok(!needsShaping("こんにちは Hello"));
});

test("テキストに合うフォントを選ぶ", () => {
  assert.equal(pickFont("sans", "日本語の文章"), "gothic");
  assert.equal(pickFont("serif", "日本語の文章"), "mincho");
  // ベトナム語の声調付き文字は BIZ UD に無いので Noto へ
  assert.equal(pickFont("sans", "Tiếng Việt"), "notosans");
  assert.equal(pickFont("serif", "Tiếng Việt"), "notoserif");
  assert.equal(pickFont("sans", "สวัสดี"), "thai");
  assert.equal(pickFont("sans", "مرحبا"), "arabic");
  assert.equal(pickFont("sans", "नमस्ते"), "devanagari");
  // 指定があり、描けるならそれを使う
  assert.equal(pickFont("sans", "Hello", "mincho"), "mincho");
  // 指定があっても描けない文字があれば選び直す
  assert.equal(pickFont("sans", "Tiếng Việt", "gothic"), "notosans");
});

test("グリフの有無と被覆率", () => {
  assert.ok(bundledHasGlyph("gothic", "漢".codePointAt(0)!));
  assert.ok(!bundledHasGlyph("notosans", "漢".codePointAt(0)!));
  assert.equal(coverage("gothic", "漢字 abc"), 1);
  assert.ok(coverage("notosans", "漢字 abc") < 1);
});

test("中国語・韓国語パック：UI 言語に合うフォントを先に選び、サブセットを埋め込んで読み戻せる", async () => {
  const ids = fontList().map((f) => f.id);
  assert.ok(ids.includes("notosanssc") && ids.includes("notoseriftc") && ids.includes("notosanskr"));
  try {
    setCurrentLang("zh-CN");
    assert.equal(pickFont("sans", "简体中文的文章"), "notosanssc");
    assert.equal(pickFont("serif", "简体中文的文章"), "notoserifsc");
    assert.equal(defaultFont("sans"), "notosanssc");
    setCurrentLang("zh-TW");
    assert.equal(pickFont("sans", "繁體中文的文章"), "notosanstc");
    setCurrentLang("ko");
    assert.equal(pickFont("sans", "한국어 문장"), "notosanskr");
    assert.equal(pickFont("serif", "한국어 문장"), "notoserifkr");
    setCurrentLang("en");
    // 英語 UI でもハングルは KR フォントにしか無い
    assert.equal(pickFont("sans", "한국어"), "notosanskr");
    setCurrentLang("ja");
    assert.equal(pickFont("sans", "日本語の文章"), "gothic");
    assert.equal(defaultFont("sans"), "gothic");
    // 簡体字（BIZ UD に無い字形）は SC へ
    assert.equal(pickFont("sans", "这是简体字"), "notosanssc");
  } finally {
    setCurrentLang("ja");
  }
  // サブセット埋め込み → pdf.js で読み戻す
  for (const [key, text] of [
    ["notosanssc", "简体中文：你好，世界"],
    ["notosanstc", "繁體中文：你好，世界"],
    ["notosanskr", "한국어: 안녕하세요"],
  ] as const) {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await embedSubsetFont(doc, await loadFontBytes(key), text);
    const page = doc.addPage([400, 200]);
    page.drawText(text, { x: 20, y: 100, size: 20, font });
    await finishSubsetFonts(doc, [font]);
    const bytes = await doc.save();
    assert.ok(bytes.length < 200_000, `${key}: サブセットが大きすぎる ${bytes.length}`);
    const got = await pageText(await openPdf(bytes), 1);
    assert.ok(got.includes(text), `${key}: ${got}`);
  }
});

/** 試験用の最小限の CFF：字形 0（.notdef）、字形 1（輪郭あり）、字形 2（何も描かない：字幅と endchar だけ） */
function tinyCff(cidKeyed: boolean): Uint8Array {
  const index = (items: number[][]) => {
    if (!items.length) return [0, 0];
    const out = [items.length >> 8, items.length & 255, 1];
    let off = 1;
    out.push(off);
    for (const it of items) out.push((off += it.length));
    for (const it of items) out.push(...it);
    return out;
  };
  const int5 = (n: number) => [29, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const header = [1, 0, 4, 1];
  const names = index([[0x54]]);
  const strings = index([]);
  const gsubrs = index([]);
  const glyphs = index([[14], [0xef, 0x8b, 21, 0xef, 0xef, 5, 14], [0xef, 14]]);
  const charset = [0, 0x00, 0x41, 0x00, 0xb2]; // 字形 1 = CID 0x41、字形 2 = CID 0xB2
  // Top DICT の長さは中身の数値によらず一定（数値は 5 バイトの形で書く）
  const topLen = (cidKeyed ? 3 + 2 + 5 + 1 : 0) + 5 + 1;
  const topIndexLen = 2 + 1 + 2 + topLen;
  const afterTop = header.length + names.length + topIndexLen + strings.length + gsubrs.length;
  const charsetAt = afterTop;
  const glyphsAt = afterTop + (cidKeyed ? charset.length : 0);
  const top = [...(cidKeyed ? [0x8b, 0x8b, 0x8b, 12, 30, ...int5(charsetAt), 15] : []), ...int5(glyphsAt), 17];
  return Uint8Array.from([...header, ...names, ...index([top]), ...strings, ...gsubrs, ...(cidKeyed ? charset : []), ...glyphs]);
}

test("CFF 形式のフォント：何も描かない字形（endchar だけ）は、輪郭なしと判定する", () => {
  const plain = parseCff(tinyCff(false))!;
  assert.ok(plain && !plain.cidKeyed);
  assert.equal(plain.glyphCount, 3);
  assert.equal(plain.hasOutline(1), true);
  assert.equal(plain.hasOutline(2), false);
  assert.equal(plain.gidOfCid(2), 2);
  const cid = parseCff(tinyCff(true))!;
  assert.ok(cid && cid.cidKeyed);
  assert.equal(cid.gidOfCid(0x41), 1);
  assert.equal(cid.gidOfCid(0xb2), 2);
  assert.equal(cid.gidOfCid(0x99), null);
  assert.equal(cid.hasOutline(cid.gidOfCid(0x41)!), true);
  assert.equal(cid.hasOutline(cid.gidOfCid(0xb2)!), false);
  // 読めないデータは null（判定しない）
  assert.equal(parseCff(Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7, 8)), null);
});

test("CFF 形式の一部埋め込みフォント：文字の対応表にあっても、字形が空の字は書けない扱いにする", async () => {
  // 太字と対応表（ToUnicode）を共有している文書：対応表には É があるが、このフォントの É の字形は空
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const cmap = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n2 beginbfchar\n<0041> <0041>\n<00B2> <00C9>\nendbfchar\nendcmap\nend\nend";
  const desc = ctx.register(ctx.obj({ Type: "FontDescriptor", FontName: "ABCDEF+Test", Flags: 4, FontBBox: [0, 0, 1000, 1000], ItalicAngle: 0, Ascent: 800, Descent: -200, CapHeight: 700, StemV: 80, FontFile3: ctx.register(ctx.flateStream(tinyCff(true), { Subtype: "CIDFontType0C" })) }));
  const cidFont = ctx.register(ctx.obj({ Type: "Font", Subtype: "CIDFontType0", BaseFont: "ABCDEF+Test", CIDSystemInfo: { Registry: PDFString.of("Adobe"), Ordering: PDFString.of("Identity"), Supplement: 0 }, FontDescriptor: desc, DW: 600 }));
  const font = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type0", BaseFont: "ABCDEF+Test", Encoding: "Identity-H", DescendantFonts: [cidFont], ToUnicode: ctx.register(ctx.flateStream(cmap)) }));
  const info = getFontInfo(doc, font)!;
  assert.ok(info);
  assert.deepEqual([...info.encode(0x41)!], [0x00, 0x41]);
  assert.equal(info.encode(0xc9), null);
});

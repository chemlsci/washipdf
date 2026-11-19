// タイ語：元の文字の書き換え。ำ を「丸（ニッカヒット）＋ า」に分けて描く文書、影付き文字、同梱フォントでの書き出し
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import { defaultSettings } from "@/lib/docOps";
import { createTextEdit } from "@/lib/editModel";
import { buildPdf } from "@/lib/exportPdf";
import { visualToLogical } from "@/lib/anchoredEdit";
import { glyphShape, sameShape } from "@/lib/glyphShape";
import { getPageText } from "@/lib/textRuns";
import { glyphIdForCodePoint, parseTtf } from "@/lib/ttfSubset";
import type { PageItem, TextObj } from "@/lib/types";
import { diffOutside, fixtures, loadSource, openPdf, pageText, renderPage, root } from "./helpers";

const outDir = join(root, "dist", ".test-out");
mkdirSync(outDir, { recursive: true });

interface Line {
  /** 描く字形の並び（1 字ずつ。ำ は「ํ」「า」に分けて渡す） */
  glyphs: string;
  x: number;
  y: number;
  size: number;
  gray?: number;
}

/**
 * タイ文字の文書を作る：フォントは Type0（Identity-H）で、文字コード＝字形番号。
 * 実際の文書にならって、ニッカヒット（ํ）の字形には ToUnicode で空白を割り当てる（spaceGlyph に指定した字）。
 */
async function makeThaiPdf(name: string, lines: Line[], spaceGlyph: string, raw: Map<string, number> = new Map(), fontFile = "NotoSansThai.ttf"): Promise<string> {
  const data = new Uint8Array(readFileSync(join(root, "assets/fonts", fontFile)));
  const font = fontkit.create(Buffer.from(data)) as unknown as { unitsPerEm: number; numGlyphs: number; glyphForCodePoint(cp: number): { id: number; advanceWidth: number }; getGlyph(id: number): { id: number; advanceWidth: number } };
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const ctx = doc.context;
  const used = new Map<number, { cp: number; w: number }>();
  const hex = (s: string) =>
    [...s]
      .map((ch) => {
        // raw に入れた字は、字形番号を直接指定する。文字の対応は「分からない」（U+FFFD）にする
        const g = raw.has(ch) ? font.getGlyph(raw.get(ch)!) : font.glyphForCodePoint(ch.codePointAt(0)!);
        used.set(g.id, { cp: raw.has(ch) ? 0xfffd : ch.codePointAt(0)!, w: Math.round((g.advanceWidth * 1000) / font.unitsPerEm) });
        return g.id.toString(16).padStart(4, "0");
      })
      .join("");
  const content = lines.map((l) => `BT ${l.gray ?? 0} g /F1 ${l.size} Tf 1 0 0 1 ${l.x} ${l.y} Tm <${hex(l.glyphs)}> Tj ET`).join("\n");
  const u4 = (n: number) => n.toString(16).padStart(4, "0");
  const bf = [...used].map(([gid, v]) => `<${u4(gid)}> <${u4(String.fromCodePoint(v.cp) === spaceGlyph ? 0x20 : v.cp)}>`);
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <ffff>\nendcodespacerange\n${bf.length} beginbfchar\n${bf.join("\n")}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
  const file = ctx.register(ctx.flateStream(data, { Length1: data.length }));
  const desc = ctx.register(ctx.obj({ Type: "FontDescriptor", FontName: "AAAAAA+ThaiTest", Flags: 4, FontBBox: [-500, -500, 1500, 1500], ItalicAngle: 0, Ascent: 1000, Descent: -300, CapHeight: 700, StemV: 80, FontFile2: file }));
  const W = [...used].flatMap(([gid, v]) => [gid, [v.w]]);
  const cid = ctx.register(ctx.obj({ Type: "Font", Subtype: "CIDFontType2", BaseFont: "AAAAAA+ThaiTest", CIDSystemInfo: { Registry: PDFString.of("Adobe"), Ordering: PDFString.of("Identity"), Supplement: 0 }, FontDescriptor: desc, DW: 1000, W, CIDToGIDMap: "Identity" }));
  const f = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type0", BaseFont: "AAAAAA+ThaiTest", Encoding: "Identity-H", DescendantFonts: [cid], ToUnicode: ctx.register(ctx.flateStream(cmap)) }));
  page.node.set(PDFName.of("Resources"), ctx.obj({ Font: { F1: f } }));
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(content)));
  const path = join(outDir, name);
  writeFileSync(path, await doc.save({ useObjectStreams: false }));
  return path;
}

test("タイ語：丸と า に分けて描かれた ำ が、文字列では ำ として読め、元のフォントで書き換えられる", async () => {
  const file = await makeThaiPdf(
    "thai-am.pdf",
    [
      { glyphs: "ทํางานที่นี่", x: 60, y: 700, size: 20 },
      { glyphs: "สําคัญ", x: 60, y: 660, size: 20 },
    ],
    "ํ",
  );
  const { doc, pages } = await loadSource(file);
  const { runs } = await getPageText(doc, pages[0]);
  const run = runs.find((r) => r.text.includes("งาน"));
  assert.ok(run, runs.map((r) => r.text).join(" / "));
  assert.equal(run.text, "ทำงานที่นี่");
  assert.ok(run.editable, `編集できない: ${run.reason}`);
  assert.equal(runs.find((r) => r.text.includes("คัญ"))?.text, "สำคัญ");

  // 文字を変えなければ、見た目は変わらない。変えた行は、元のフォントのまま（位置を保つ書き方）で書かれる
  const how: string[] = [];
  const same = createTextEdit([run], { cover: "#ffffff", fallbackColor: "#000000" });
  const item = (objs: PageItem["objects"]): PageItem => ({ ...pages[0], objects: objs });
  const unchanged = await buildPdf([item([same])], new Map([[doc.id, doc]]), new Map(), { rewriteUnchanged: true, onEditPath: (h) => how.push(h) });
  assert.deepEqual(how, ["anchored"]);
  const a = await renderPage(await openPdf(doc.bytes), 1, 2);
  const b = await renderPage(await openPdf(unchanged), 1, 2);
  let diff = 0;
  for (let i = 0; i < a.data.length; i += 4) if (Math.abs(a.data[i] - b.data[i]) > 40) diff++;
  assert.equal(diff, 0, "同じ文字での書き直しで見た目が変わった");

  // 「ทำงาน」→「ทำการ」：ำ を保ったまま、後ろの字だけが変わる
  how.length = 0;
  const e = createTextEdit([run], { cover: "#ffffff", fallbackColor: "#000000" });
  e.text = "ทำการที่นี่";
  const warnings: string[] = [];
  const bytes = await buildPdf([item([e])], new Map([[doc.id, doc]]), new Map(), { onEditPath: (h) => how.push(h), onWarning: (m) => warnings.push(m) });
  writeFileSync(join(outDir, "thai-am-edited.pdf"), bytes);
  assert.deepEqual(how, ["anchored"], warnings.join(" / "));
  // 書き換えた文書を開き直しても、同じように読める（ำ が า だけになったり、二重になったりしない）
  const reFile = join(outDir, "thai-am-edited.pdf");
  const re = await loadSource(reFile);
  const reRuns = (await getPageText(re.doc, re.pages[0])).runs.map((r) => r.text);
  assert.ok(reRuns.includes("ทำการที่นี่"), reRuns.join(" / "));
  assert.ok(reRuns.includes("สำคัญ"), reRuns.join(" / "));
});

test("タイ語：幅 0 の「空白」字形でも、直後に า が続かないものはニッカヒットとして読まない", async () => {
  // 単語の区切りに幅 0 の字形（ここでは U+200B）を使い、ToUnicode で空白を割り当てた文書
  const file = await makeThaiPdf("thai-zwsp.pdf", [{ glyphs: "งาน​ที่นี่", x: 60, y: 700, size: 20 }], "​");
  const { doc, pages } = await loadSource(file);
  const { runs } = await getPageText(doc, pages[0]);
  const text = runs.map((r) => r.text).join("");
  assert.ok(!/[ํำ]/.test(text), `区切りの字形をニッカヒットと読んだ: ${text}`);
  assert.ok(text.includes("งาน") && text.includes("ที่นี่"), text);
});

test("タイ語：影付きの見出し（少しずらして 2 回描く）は 1 回分の文字列になり、重なりの上下を保って書き直される", async () => {
  const glyphs = "ข้อมูลตัวเอง";
  const file = await makeThaiPdf(
    "thai-shadow.pdf",
    [
      { glyphs, x: 60.9, y: 699.6, size: 60, gray: 0.3 },
      { glyphs, x: 60, y: 700, size: 60, gray: 0.8 },
    ],
    "ํ",
  );
  const { doc, pages } = await loadSource(file);
  const { runs } = await getPageText(doc, pages[0]);
  assert.deepEqual(
    runs.map((r) => r.text),
    ["ข้อมูลตัวเอง"],
  );
  const how: string[] = [];
  const e = createTextEdit([runs[0]], { cover: "#ffffff", fallbackColor: "#000000" });
  const out = await buildPdf([{ ...pages[0], objects: [e] }], new Map([[doc.id, doc]]), new Map(), { rewriteUnchanged: true, onEditPath: (h) => how.push(h) });
  assert.deepEqual(how, ["anchored"]);
  const a = await renderPage(await openPdf(doc.bytes), 1, 2);
  const b = await renderPage(await openPdf(out), 1, 2);
  let diff = 0;
  for (let i = 0; i < a.data.length; i += 4) if (Math.abs(a.data[i] - b.data[i]) > 40) diff++;
  assert.equal(diff, 0, "影と本体の上下が入れ替わった");
});

test("タイ語：同梱フォントで書いた ำ・声調記号が、そのまま読み戻せ、記号の後ろに余分な空きができない", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "en-standard14.pdf"));
  const mk = (id: string, text: string, y: number): TextObj => ({ id, type: "text", x: 40, y, w: 400, h: 30, text, font: "thai", fontSize: 18, color: "#000000", rotation: 0, align: "left" }) as unknown as TextObj;
  const bytes = await buildPdf([{ ...pages[0], objects: [mk("t", "น้ำที่นี่สำคัญ", 350)] }], new Map([[doc.id, doc]]), new Map(), { settings: defaultSettings() });
  const pdf = await openPdf(bytes);
  const text = await pageText(pdf, 1);
  // ำ は「ํ」「า」の 2 つの字形で描かれ、その順に読まれる（タイ語の PDF の多くと同じ。「ำา」のように重複しない）
  assert.ok(text.replace(/\u0e4d\u0e32/g, "\u0e33").includes("น้ำที่นี่สำคัญ"), `読み戻せない: ${text}`);
  assert.ok(!text.includes("\u0e33\u0e32"), `ำ が重複している: ${text}`);
  // このソフトで開き直すと、ำ として読める
  const reFile = join(outDir, "thai-bundled.pdf");
  writeFileSync(reFile, bytes);
  const re = await loadSource(reFile);
  const reRuns = (await getPageText(re.doc, re.pages[0])).runs.map((r) => r.text);
  assert.ok(reRuns.includes("น้ำที่นี่สำคัญ"), reRuns.join(" / "));
  const items = (await (await pdf.getPage(1)).getTextContent()).items.filter((it) => "str" in it && /[฀-๿]/.test(it.str)) as { width: number; str: string }[];
  const width = items.reduce((s, it) => s + it.width, 0);
  // 14 字のうち幅のある字は 9 字ほど。記号ごとに 1 字分の空きが入ると 18pt × 14 に近づく
  assert.ok(width > 40 && width < 18 * 8, `行の幅がおかしい: ${width}`);
});

test("タイ語：文字の対応が付いていない声調記号（位置をずらした別の字形）を、形から求めて読める・書き換えられる", async () => {
  // 同梱のタイ文字フォントから、「่」と同じ形で別の字形（下の字に合わせて位置を変えたもの）を探す
  const ttf = parseTtf(new Uint8Array(readFileSync(join(root, "assets/fonts/NotoSansThai.ttf"))));
  const base = glyphIdForCodePoint(ttf, 0x0e48);
  const baseShape = glyphShape(ttf, base)!;
  assert.ok(baseShape, "「่」の形が読めない");
  let variant = -1;
  for (let g = 1; g < ttf.numGlyphs && variant < 0; g++) {
    const sh = g === base ? null : glyphShape(ttf, g);
    if (sh && sameShape(sh, baseShape)) variant = g;
  }
  assert.ok(variant > 0, "同じ形の別の字形が見つからない");
  // 1 行目は普通の「่」（形の手がかり）、2 行目は対応の無い字形で描いた「ชื่อ」
  const file = await makeThaiPdf(
    "thai-unknown-mark.pdf",
    [
      { glyphs: "ที\u0e48นี\u0e48", x: 60, y: 700, size: 20 },
      { glyphs: "ชื\ue000อโรค", x: 60, y: 660, size: 20 },
    ],
    "\u0e4d",
    new Map([["\ue000", variant]]),
  );
  const { doc, pages } = await loadSource(file);
  const { runs } = await getPageText(doc, pages[0]);
  const run = runs.find((r) => r.text.includes("โรค"));
  assert.ok(run, runs.map((r) => r.text).join(" / "));
  assert.equal(run.text, "ชื่อโรค");
  assert.ok(run.editable, `編集できない: ${run.reason}`);
  const how: string[] = [];
  const e = createTextEdit([run], { cover: "#ffffff", fallbackColor: "#000000" });
  e.text = "ชื่อยา";
  const bytes = await buildPdf([{ ...pages[0], objects: [e] }], new Map([[doc.id, doc]]), new Map(), { onEditPath: (h) => how.push(h) });
  assert.deepEqual(how, ["anchored"]);
  const out = join(outDir, "thai-unknown-mark-edited.pdf");
  writeFileSync(out, bytes);
  const re = await loadSource(out);
  const reRuns = (await getPageText(re.doc, re.pages[0])).runs.map((r) => r.text);
  assert.ok(reRuns.includes("ชื่อยา"), reRuns.join(" / "));
});

test("ヒンディー語：変えた語だけを同梱フォントで整形して書き、ほかの字は元の字形のまま残す", async () => {
  // 実際の文書と同じく、字形を見た目の順に並べる（「हिंदी」は ि が先）。文字列もその順で読まれる
  const file = await makeThaiPdf(
    "hindi-visual.pdf",
    [
      { glyphs: "\u093f\u0939\u0902\u0926\u0940 \u0928\u093e\u092e /Name", x: 60, y: 700, size: 20 },
      { glyphs: "\u0924\u093e\u0930\u0940\u0916", x: 60, y: 660, size: 20 },
    ],
    "",
    new Map(),
    "NotoSansDevanagari.ttf",
  );
  const { doc, pages } = await loadSource(file);
  const { runs } = await getPageText(doc, pages[0]);
  const run = runs.find((r) => r.text.includes("Name"));
  assert.ok(run, runs.map((r) => r.text).join(" / "));
  assert.ok(run.editable && run.complex, `語単位の書き換えの対象になっていない: ${run.reason}`);
  // 「नाम」→「स्त्री」（結合文字を含む語）
  const how: string[] = [];
  const warnings: string[] = [];
  const e = createTextEdit([run], { cover: "#ffffff", fallbackColor: "#000000" });
  e.text = run.text.replace("\u0928\u093e\u092e", "\u0938\u094d\u0924\u094d\u0930\u0940");
  const bytes = await buildPdf([{ ...pages[0], objects: [e] }], new Map([[doc.id, doc]]), new Map(), { onEditPath: (h) => how.push(h), onWarning: (m) => warnings.push(m) });
  writeFileSync(join(outDir, "hindi-visual-edited.pdf"), bytes);
  assert.deepEqual(how, ["anchored-mixed"], warnings.join(" / "));
  const after = await openPdf(bytes);
  const text = await pageText(after, 1);
  // 変えていない語は元の字形（見た目の順）のまま、変えた語は読める形で入っている
  assert.ok(text.includes("\u093f\u0939\u0902\u0926\u0940"), text);
  assert.ok(text.includes("\u0938") && text.includes("Name") && !text.includes("\u0928\u093e\u092e"), text);
  // 書き換えた行の外（2 行目）は変わらない
  const a = await renderPage(await openPdf(doc.bytes), 1, 2);
  const b = await renderPage(after, 1, 2);
  const { changed } = diffOutside(a, b, [{ x: 0, y: run.top - 8, w: 595, h: run.h + 16 }], 2);
  assert.equal(changed, 0);
  // 変えた語より前の字（हिंदी）は 1 画素も動かない
  const left = { x: 0, y: 0, w: 60 + 30, h: 842 };
  let moved = 0;
  for (let y = 0; y < a.height; y++) for (let x = 0; x < left.w * 2; x++) if (Math.abs(a.data[(y * a.width + x) * 4] - b.data[(y * a.width + x) * 4]) > 40) moved++;
  assert.equal(moved, 0);

  // 書けない場合（同梱フォントに無い文字：ここではグジャラート文字）は、元のまま残して知らせる
  const e2 = createTextEdit([run], { cover: "#ffffff", fallbackColor: "#000000" });
  e2.text = run.text.replace("\u0928\u093e\u092e", "\u0a97\u0ac1\u0a9c");
  const how2: string[] = [];
  const warn2: string[] = [];
  const kept = await buildPdf([{ ...pages[0], objects: [e2] }], new Map([[doc.id, doc]]), new Map(), { onEditPath: (h) => how2.push(h), onWarning: (m) => warn2.push(m) });
  assert.deepEqual(how2, ["unchanged"]);
  assert.equal(warn2.length, 1);
  const c = await renderPage(await openPdf(kept), 1, 2);
  let diff = 0;
  for (let i = 0; i < a.data.length; i += 4) if (Math.abs(a.data[i] - c.data[i]) > 40) diff++;
  assert.equal(diff, 0, "書き換えられなかった行が元のまま残っていない");
});

test("インド系の文字：字形の並び（子音の左の母音記号が先）を、入力するときの順に直す", () => {
  // हिंदी / किताब（見た目の順では ि が子音の前）、結合した子音（स्थिति の स्थ）、ベンガル語の কে
  assert.equal(visualToLogical("\u093f\u0939\u0902\u0926\u0940"), "\u0939\u093f\u0902\u0926\u0940");
  assert.equal(visualToLogical("\u093f\u0915\u0924\u093e\u092c"), "\u0915\u093f\u0924\u093e\u092c");
  assert.equal(visualToLogical("\u093f\u0938\u094d\u0925\u093f\u0924"), "\u0938\u094d\u0925\u093f\u0924\u093f");
  assert.equal(visualToLogical("\u09c7\u0995"), "\u0995\u09c7");
  // 記号を含まない語、欧文はそのまま
  assert.equal(visualToLogical("\u0928\u093e\u092e Name"), "\u0928\u093e\u092e Name");
});

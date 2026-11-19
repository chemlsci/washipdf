// 文字認識（OCR）：認識結果の読み取りと、見えない文字の層をページに足す処理。
// （認識のエンジンそのものは Web 版にだけ置くので、ここでは結果の扱いだけを確かめる）
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { langCodes, parseOcrConfig, parseTsv } from "@/lib/ocr";
import { addOcrLayer, glyphlessFont, ocrLayerContent, type OcrLine } from "@/lib/ocrLayer";
import { clearPageTextCache, getPageText } from "@/lib/textRuns";
import { parseTtf } from "@/lib/ttfSubset";
import { diffOutside, fixtures, loadSource, openPdf, pageText, renderPage, root } from "./helpers";

const outDir = join(root, "dist", ".test-out");
mkdirSync(outDir, { recursive: true });

// 実際の認識結果の形（位置は画素）
const TSV = [
  "1\t1\t0\t0\t0\t0\t0\t0\t1700\t2200\t-1\t",
  "2\t1\t1\t0\t0\t0\t200\t176\t807\t530\t-1\t",
  "3\t1\t1\t1\t0\t0\t201\t176\t381\t31\t-1\t",
  "4\t1\t1\t1\t1\t0\t201\t176\t381\t31\t-1\t",
  "5\t1\t1\t1\t1\t1\t201\t176\t136\t31\t91.4\tQuarterly",
  "5\t1\t1\t1\t1\t2\t349\t177\t97\t30\t96.3\tReport",
  "5\t1\t1\t1\t1\t3\t457\t177\t71\t23\t12.0\t~~",
  "4\t1\t1\t1\t2\t0\t201\t261\t468\t38\t-1\t",
  "5\t1\t1\t1\t2\t1\t201\t262\t59\t37\t93.2\t株式",
  "5\t1\t1\t1\t2\t2\t279\t262\t60\t36\t92.9\t会社",
  "5\t1\t1\t1\t2\t3\t360\t262\t90\t36\t92.9\tABC",
  // 表の罫線を字と見誤ったもの（記号だけで、極端に細長い／確からしさが低い）
  "4\t1\t1\t1\t3\t0\t201\t320\t400\t6\t-1\t",
  "5\t1\t1\t1\t3\t1\t201\t320\t400\t6\t85.0\t—",
  "5\t1\t1\t1\t3\t2\t640\t320\t10\t12\t40.0\t|",
].join("\n");

test("認識結果の読み取り：行と語に分け、位置を pt に直す。確からしさの低い語は捨てる", () => {
  const lines = parseTsv(TSV, 200 / 72);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0].words.map((w) => w.text), ["Quarterly", "Report"]);
  assert.ok(Math.abs(lines[0].words[0].x - 201 / (200 / 72)) < 1e-6);
  assert.equal(lines[0].vertical, false);
  // 縦書きとして読んだとき、縦長の行は列として扱う
  const v = parseTsv("4\t1\t1\t1\t1\t0\t1370\t395\t37\t347\t-1\t\n5\t1\t1\t1\t1\t1\t1370\t395\t37\t76\t72.3\t縦書", 2, true);
  assert.equal(v[0].vertical, true);
});

test("設定：同じサイトのファイルだけを受け付ける", () => {
  const same = (u: unknown) => (typeof u === "string" && u.startsWith("/") && !u.startsWith("//") ? `https://example.test${u}` : null);
  const c = parseOcrConfig(
    {
      engine: "/ocr/v1/engine.js",
      langs: [
        { code: "jpn", url: "/ocr/v1/lang-jpn.js", vertical: { code: "jpn_vert", url: "/ocr/v1/lang-jpn_vert.js" } },
        { code: "eng", url: "https://evil.example/lang.js" },
        { code: "../x", url: "/ocr/v1/x.js" },
      ],
    },
    same,
  )!;
  assert.equal(c.engine, "https://example.test/ocr/v1/engine.js");
  assert.deepEqual(c.langs.map((l) => l.code), ["jpn"]);
  assert.equal(langCodes(c.langs, false), "jpn");
  assert.equal(langCodes(c.langs, true), "jpn_vert");
  assert.equal(parseOcrConfig({ engine: "https://evil.example/e.js", langs: [{ code: "eng", url: "/a.js" }] }, same), null);
  assert.equal(parseOcrConfig(null, same), null);
});

test("字形を持たないフォント：読める TrueType になっている", async () => {
  const f = parseTtf(glyphlessFont(), false);
  assert.equal(f.numGlyphs, 2);
  // 別の実装（fontkit）でも開けて、文字 → 字形の表（cmap）と「字が無いとき」の字形（0 番）を持っている
  const fontkit = (await import("@pdf-lib/fontkit")).default as unknown as { create(b: Uint8Array): { numGlyphs: number; glyphForCodePoint(cp: number): { id: number }; hasGlyphForCodePoint(cp: number): boolean } };
  const fk = fontkit.create(glyphlessFont());
  assert.equal(fk.numGlyphs, 2);
  assert.equal(fk.glyphForCodePoint(0x20).id, 1);
  assert.equal(fk.hasGlyphForCodePoint(0x41), false);
});

test("文字の層：語の位置に見えない文字を書く。和文どうしの間には空白を入れない", () => {
  const lines = parseTsv(TSV, 200 / 72);
  const content = ocrLayerContent({ index: 0, viewTransform: [1, 0, 0, -1, 0, 792], lines }, "F1");
  assert.ok(content.includes("3 Tr") && content.includes("/F1 1 Tf"));
  const hex = (s: string) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  assert.ok(content.includes(`<${hex("Quarterly ")}> Tj`), "欧文の語の後ろに空白が無い");
  assert.ok(content.includes(`<${hex("株式")}> Tj`), "和文の語の後ろに空白が入っている");
  // 和文と欧文・数字のあいだにも空白を入れない（「2026年」「PDFを」のように続けて探せるように）
  assert.ok(content.includes(`<${hex("会社")}> Tj`) && !content.includes(`<${hex("会社 ")}> Tj`), "和文と欧文の間に空白が入っている");
});

test("文字の層を足した PDF：見た目は変わらず、文字として取り出せる（位置も合う）", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "scan.pdf"));
  const before = await getPageText(doc, pages[0]);
  assert.equal(before.runs.length, 0, "元から文字がある");
  const mk = (text: string, x: number, y: number, w: number, h: number): OcrLine => ({ x, y, w, h, vertical: false, words: text.split(" ").map((t, i, all) => ({ text: t, x: x + (w / all.length) * i, y, w: w / all.length - 4, h })) });
  const lines = [mk("Scanned invoice 2026", 72, 100, 300, 16), mk("株式会社 サンプル", 72, 140, 200, 16), mk("2026 年 11 月", 72, 180, 160, 16), { ...mk("縦書", 400, 100, 16, 60), vertical: true }];
  const bytes = await addOcrLayer(doc.bytes, [{ index: 0, viewTransform: pages[0].viewTransform, lines }]);
  const file = join(outDir, "ocr-layer.pdf");
  writeFileSync(file, bytes);
  const pdf = await openPdf(bytes);
  const text = await pageText(pdf, 1);
  for (const w of ["Scanned", "invoice", "2026", "株式会社", "サンプル", "縦", "書"]) assert.ok(text.includes(w), `${w} が取り出せない: ${text}`);
  // 和文の語どうしは、間の隙間を埋めて続けて書く（語をまたぐ言葉も探せる）
  assert.ok(text.includes("株式会社サンプル"), `和文の語の間が切れている: ${text}`);
  assert.ok(text.replace(/\s+/g, " ").includes("2026年11月"), `数字と和文の間が切れている: ${text}`);
  // 見た目は変わらない
  const a = await renderPage(await openPdf(doc.bytes), 1, 1);
  const b = await renderPage(pdf, 1, 1);
  assert.equal(diffOutside(a, b, [], 1).changed, 0);
  // アプリで開き直すと、文字の行として読める（見えない文字なので書き換えの対象ではないが、検索・墨消しの対象になる）
  clearPageTextCache();
  const again = await loadSource(file);
  const runs = (await getPageText(again.doc, again.pages[0])).runs;
  const line = runs.find((r) => r.text.includes("Scanned"));
  assert.ok(line, runs.map((r) => r.text).join(" | "));
  assert.ok(Math.abs(line.x - 72) < 3 && Math.abs(line.top - 100) < 6 && Math.abs(line.w - 296) < 12, `位置がずれている: x=${line.x} top=${line.top} w=${line.w}`);
  assert.equal(line.editable, false);
  // ほかのページには何も足さない
  assert.equal((await pageText(pdf, 2)).trim(), "");
});

test("文字の層：回転したページ（/Rotate 90）でも、表示上の位置に文字が入る", async () => {
  const { PDFDocument, degrees } = await import("pdf-lib");
  const src = await PDFDocument.load((await loadSource(join(fixtures, "scan.pdf"))).doc.bytes);
  src.getPage(0).setRotation(degrees(90));
  const rotated = join(outDir, "scan-rotated.pdf");
  writeFileSync(rotated, await src.save());
  const { doc, pages } = await loadSource(rotated);
  assert.equal(pages[0].baseRotation, 90);
  // 表示上（回転後）の位置で、横書きの 1 行
  const line: OcrLine = { x: 100, y: 200, w: 240, h: 18, vertical: false, words: [{ text: "Rotated", x: 100, y: 200, w: 110, h: 18 }, { text: "page", x: 220, y: 200, w: 120, h: 18 }] };
  const bytes = await addOcrLayer(doc.bytes, [{ index: 0, viewTransform: pages[0].viewTransform, lines: [line] }]);
  const file = join(outDir, "ocr-rotated.pdf");
  writeFileSync(file, bytes);
  clearPageTextCache();
  const again = await loadSource(file);
  const runs = (await getPageText(again.doc, again.pages[0])).runs;
  const run = runs.find((r) => r.text.includes("Rotated"));
  assert.ok(run, runs.map((r) => r.text).join(" | "));
  assert.ok(run.text.includes("page"));
  assert.ok(Math.abs(run.x - 100) < 3 && Math.abs(run.top - 200) < 6 && Math.abs(run.w - 240) < 14, `位置がずれている: x=${run.x} top=${run.top} w=${run.w}`);
});

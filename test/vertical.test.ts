import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { decodePDFRawStream, PDFDict, PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { defaultSettings } from "@/lib/docOps";
import { createTextEdit } from "@/lib/editModel";
import { buildPdf } from "@/lib/exportPdf";
import { getPageText } from "@/lib/textRuns";
import type { TextEditObj, TextObj } from "@/lib/types";
import { layoutVertical, verticalColumns, verticalColumnsBundledContent, verticalLength, verticalMeasurer, verticalUnits } from "@/lib/verticalText";
import { fixtures, loadSource, openPdf, pageText, renderPage, root } from "./helpers";

/** 非白画素の外接矩形（表示座標 pt、scale=1 の描画） */
function inkBox(img: { data: Uint8ClampedArray; width: number; height: number }, region: { x: number; y: number; w: number; h: number }) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (let y = region.y; y < region.y + region.h; y++) {
    for (let x = region.x; x < region.x + region.w; x++) {
      const i = (y * img.width + x) * 4;
      if (img.data[i] < 160) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

test("列の分割", () => {
  assert.deepEqual(verticalColumns("あいうえお\nかき", 3), ["あいう", "えお", "かき"]);
  assert.deepEqual(verticalColumns("abc", Infinity), ["abc"]);
});

test("縦書きの行が列として検出され、実編集できる", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "ja-special-cases.pdf"));
  const { runs } = await getPageText(doc, pages[0]);
  const v = runs.find((r) => r.vertical);
  assert.ok(v, "縦書きの列が無い");
  assert.equal(v.text, "縦書きの文字列");
  assert.ok(v.editable, v.reason ?? "");
  // 列の箱：x=500 を中心に幅 12、上端 y=841.89-700、長さ 84
  assert.ok(Math.abs(v.x + v.w / 2 - 500) < 1 && Math.abs(v.w - 12) < 0.5 && Math.abs(v.h - 84) < 2, JSON.stringify({ x: v.x, w: v.w, h: v.h, top: v.top }));
  assert.ok(Math.abs(v.top - (841.89 - 700)) < 1, String(v.top));
  assert.equal(v.removals.length, 1);
  // 横書きの行は従来どおり
  assert.ok(runs.some((r) => !r.vertical && r.text.includes("通常の編集できる行")));
});

for (const useOriginal of [false, true]) {
  test(`縦書きの実編集：${useOriginal ? "元の縦書きフォント" : "同梱フォント"}で書き換え、元の文字は消える`, async () => {
    const { doc, pages } = await loadSource(join(fixtures, "ja-special-cases.pdf"));
    const { runs } = await getPageText(doc, pages[0]);
    const v = runs.find((r) => r.vertical)!;
    const e = createTextEdit([v], { cover: "#ffffff", fallbackColor: "#000000", font: useOriginal ? undefined : "gothic" }) as TextEditObj;
    if (useOriginal) assert.equal(e.font, "original");
    e.text = "改訂した縦書";
    const bytes = await buildPdf([{ ...pages[0], objects: [e] }], new Map([[doc.id, doc]]), new Map(), { settings: defaultSettings() });
    const pdf = await openPdf(bytes);
    const text = (await pageText(pdf, 1)).replace(/\s/g, "");
    assert.ok(!text.includes("縦書きの文字列"), text);
    for (const ch of "改訂した縦書") assert.ok(text.includes(ch), `${ch} が無い: ${text}`);
    // 描画：元の列の位置に縦長のインクがある
    const img = await renderPage(pdf, 1, 1);
    const box = inkBox(img, { x: 480, y: 130, w: 40, h: 110 });
    assert.ok(box && box.h > box.w * 3, `縦に積まれていない: ${JSON.stringify(box)}`);
    assert.ok(box && box.w <= 16, `列の幅が広すぎる: ${JSON.stringify(box)}`);
  });
}

test("縦書きの文字オブジェクト：欧文と長音は回転し、2 行目は左の列になる", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "en-standard14.pdf"));
  const o = { id: "v", type: "text", x: 400, y: 100, w: 20, h: 200, text: "縦書きABC、ー。\n二列目", font: "gothic", fontSize: 14, color: "#000000", rotation: 0, align: "left", vertical: true } as unknown as TextObj;
  const bytes = await buildPdf([{ ...pages[0], objects: [o] }], new Map([[doc.id, doc]]), new Map(), { settings: defaultSettings() });
  const pdf = await openPdf(bytes);
  const text = (await pageText(pdf, 1)).replace(/\s/g, "");
  for (const ch of "縦書きABC二列目") assert.ok(text.includes(ch), `${ch} が無い: ${text}`);
  const img = await renderPage(pdf, 1, 1);
  const col1 = inkBox(img, { x: 398, y: 95, w: 22, h: 200 });
  const col2 = inkBox(img, { x: 380, y: 95, w: 18, h: 120 });
  assert.ok(col1 && col1.h > 100 && col1.w <= 18, `1 列目: ${JSON.stringify(col1)}`);
  assert.ok(col2 && col2.h > 30, `2 列目: ${JSON.stringify(col2)}`);
});

test("縦中横の単位分け：1〜3 桁の数字と「!?」は 1 文字分、4 桁以上は回転する 1 文字ずつ", () => {
  const kinds = (t: string) => verticalUnits(t).map((u) => `${u.kind}:${u.text}`);
  assert.deepEqual(kinds("第12回"), ["upright:第", "tcy:12", "upright:回"]);
  assert.deepEqual(kinds("1234年"), ["rotated:1", "rotated:2", "rotated:3", "rotated:4", "upright:年"]);
  assert.deepEqual(kinds("え!?"), ["upright:え", "tcy:!?"]);
  assert.deepEqual(kinds("A1"), ["rotated:A", "tcy:1"]);
  // 長さ：縦中横は 1 em
  assert.ok(Math.abs(verticalLength("gothic", "第12回", 10) - 30) < 0.01);
});

test("列またぎの流し込み：禁則（句読点が列頭に来ない）と、列数超過での縮小", () => {
  const m = verticalMeasurer("gothic");
  // 1 列 5 文字、句読点「。」は列頭に来ないので前の列にぶら下がる
  const l = layoutVertical("あいうえお。かきくけこ", 10, 50, 3, m);
  assert.deepEqual(l.lines, ["あいうえお。", "かきくけこ"]);
  assert.equal(l.shrunk, false);
  // 列数が足りなければ縮小する（15 文字を 1 列 50pt × 2 列に）
  const s = layoutVertical("あいうえおかきくけこさしすせそ", 10, 50, 2, m);
  assert.ok(s.shrunk && !s.overflow && s.lines.length <= 2, JSON.stringify(s));
  assert.ok(s.fontSize < 10 && s.fontSize >= 6);
});

test("縦書きの段落：隣り合う列がブロックになり、まとめて編集すると列をまたいで流し込まれる", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "ja-vertical.pdf"));
  const { runs } = await getPageText(doc, pages[0]);
  const cols = runs.filter((r) => r.vertical);
  assert.equal(cols.length, 3);
  assert.ok(cols.every((c) => c.blockId && c.blockId === cols[0].blockId), "3 列が同じブロックでない");
  const byIndex = [...cols].sort((a, b) => a.lineIndex - b.lineIndex);
  assert.equal(byIndex[0].text, "縦書きの段落です。");
  assert.ok(byIndex[0].x > byIndex[1].x && byIndex[1].x > byIndex[2].x, "右の列が lineIndex 0 でない");
  const e = createTextEdit(cols, { cover: "#ffffff", fallbackColor: "#000000", font: "gothic" }) as TextEditObj;
  assert.equal(e.lines, 3);
  assert.ok(Math.abs(e.lineHeight - 22) < 0.5, String(e.lineHeight));
  assert.equal(e.text, "縦書きの段落です。第十二回の会議は、二〇二六年に開く。");
  // 書き換え：数字を入れて縦中横に。文字数は同じ程度
  e.text = "改訂した段落です。第12回の会議は、二〇二七年に開く予定。";
  const warnings: string[] = [];
  const bytes = await buildPdf([{ ...pages[0], objects: [e] }], new Map([[doc.id, doc]]), new Map(), { settings: defaultSettings(), onWarning: (m) => warnings.push(m) });
  const pdf = await openPdf(bytes);
  const text = (await pageText(pdf, 1)).replace(/\s/g, "");
  assert.ok(!text.includes("縦書きの段落"), text);
  for (const ch of "改訂した段落第12回二〇二七年予定横書きの行") assert.ok(text.includes(ch), `${ch} が無い: ${text}`);
  assert.equal(warnings.length, 0, warnings.join("\n"));
  // 描画：3 列の位置（x=500, 478, 456 を中心）にそれぞれ縦長のインクがあり、その左（x≈434）には無い
  const img = await renderPage(pdf, 1, 1);
  for (const cx of [500, 478, 456]) {
    const box = inkBox(img, { x: cx - 10, y: 135, w: 20, h: 190 });
    assert.ok(box && box.h > 100 && box.w <= 16, `列 ${cx}: ${JSON.stringify(box)}`);
  }
  assert.equal(inkBox(img, { x: 424, y: 135, w: 20, h: 190 }), null, "4 列目に文字がある");
});

test("縦中横は Tz で 1 em に詰めた 1 つの Tj になる", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "en-standard14.pdf"));
  const content = verticalColumnsBundledContent(
    pages[0],
    { resName: "F1", simple: false, encode: (t) => `(${t})`, width: () => 0, canWrite: () => true },
    "gothic",
    ["第12回"],
    { cx: 100, top: 100, fontSize: 10, pitch: 12.5, color: [0, 0, 0] },
  );
  assert.ok(/[0-9.]+ Tz\n[^\n]+ Tm\n\(12\) Tj/.test(content), content);
  const tz = /([0-9.]+) Tz/.exec(content)!;
  assert.ok(parseFloat(tz[1]) < 100 && parseFloat(tz[1]) > 70, tz[1]);
  void doc;
});

test("縦書きを元の縦書きフォントのまま書き換えると、元の縦書きで使っていなかった字も検索・コピーで正しく取り出せる", async () => {
  // ja-vertical.pdf：横書き（Identity-H）と縦書き（Identity-V）が同じ一部埋め込みフォントを使う。
  // 「横」の字形はフォントにあるが、縦書きのフォントの文字対応表（ToUnicode）には無い
  // この資料は、縦書きのフォントの対応表にもフォントの全部の字が入っている。報告のあった PDF と同じく、
  // 「横」を縦書きのフォントの対応表から取り除いてから試す
  const src = await PDFDocument.load(readFileSync(join(fixtures, "ja-vertical.pdf")));
  for (const [, obj] of src.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || obj.get(PDFName.of("Encoding")) !== PDFName.of("Identity-V")) continue;
    const tu = obj.lookup(PDFName.of("ToUnicode"));
    if (!(tu instanceof PDFRawStream)) continue;
    const cmap = Buffer.from(decodePDFRawStream(tu).decode()).toString("latin1");
    const lines = cmap.split("\n");
    // bfchar の 1 行（<code> <6A2A>）を取り除き、その組の数を 1 減らす
    const i = lines.findIndex((l) => /^<[0-9A-F]+>\s*<6A2A>$/i.test(l.trim()));
    assert.ok(i >= 0, "資料の対応表に「横」が無い（試し方を見直す）");
    lines.splice(i, 1);
    for (let k = i - 1; k >= 0; k--) {
      const m = /^(\d+) beginbfchar$/.exec(lines[k].trim());
      if (m) {
        lines[k] = `${Number(m[1]) - 1} beginbfchar`;
        break;
      }
    }
    obj.set(PDFName.of("ToUnicode"), src.context.register(src.context.flateStream(Buffer.from(lines.join("\n"), "latin1"))));
  }
  mkdirSync(join(root, "dist", ".test-out"), { recursive: true });
  const file = join(root, "dist", ".test-out", "ja-vertical-no-yoko.pdf");
  writeFileSync(file, await src.save());
  const { doc, pages } = await loadSource(file);
  const { runs } = await getPageText(doc, pages[0]);
  const v = runs.find((r) => r.vertical && r.text.startsWith("縦書きの段落"))!;
  assert.ok(v, runs.map((r) => r.text).join("|"));
  const e = createTextEdit([v], { cover: "#ffffff", fallbackColor: "#000000" }) as TextEditObj;
  assert.equal(e.font, "original");
  // 字を増やす（その場での置き換えでは済まず、列を元のフォントで書き直す経路になる）
  e.text = v.text.replace("縦書き", "横書き横");
  const paths: string[] = [];
  const bytes = await buildPdf([{ ...pages[0], objects: [e] }], new Map([[doc.id, doc]]), new Map(), { settings: defaultSettings(), onEditPath: (p: string) => paths.push(p) } as never);
  const text = (await pageText(await openPdf(bytes), 1)).replace(/\s/g, "");
  assert.ok(paths.includes("vertical"), paths.join(","));
  assert.ok(text.includes("横書き横の段落"), `${paths.join(",")}: ${text}`);
  // pdf.js はフォントの中の対応からも字を決めるので、上だけでは確かめられない。対応表（ToUnicode）だけで字を決めるソフト
  // （pdftotext など）でも取り出せるよう、縦書きのフォントの対応表に「横」（U+6A2A）が入っていること
  const out = await PDFDocument.load(bytes);
  const maps: string[] = [];
  for (const [, obj] of out.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || obj.get(PDFName.of("Encoding")) !== PDFName.of("Identity-V")) continue;
    const tu = obj.lookup(PDFName.of("ToUnicode"));
    if (tu instanceof PDFRawStream) maps.push(Buffer.from(decodePDFRawStream(tu).decode()).toString("latin1"));
  }
  assert.ok(maps.length && maps.every((m) => /<6A2A>/i.test(m)), "縦書きのフォントの対応表に「横」が無い");
});

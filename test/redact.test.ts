import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PDFArray, PDFDocument } from "pdf-lib";
import { tokenizeContent } from "@/lib/contentStream";
import { buildPdf } from "@/lib/exportPdf";
import { pageContentBytes } from "@/lib/libDoc";
import { getPageImages } from "@/lib/pageImages";
import { getPageText } from "@/lib/textRuns";
import type { ImageEditObj, NoteObj, PageItem, RedactObj } from "@/lib/types";
import { defaultSettings } from "@/lib/docOps";
import { apply, multiply } from "@/lib/geometry";
import { redactedWords } from "@/lib/redactCheck";
import { num } from "@/lib/contentStream";
import type { Matrix } from "@/lib/types";
import { diffOutside, fixtures, loadSource, openPdf, pageText, renderPage, savePng } from "./helpers";

const tmpDir = join(fixtures, "..", "..", "dist", ".test");
mkdirSync(tmpDir, { recursive: true });

/** 画像 2 枚（JPEG の赤、PNG の青）と文字のある PDF（test/make-fixtures.ts で生成） */
const imagesPdf = join(fixtures, "images.pdf");

const pixel = (img: { data: Uint8ClampedArray; width: number }, x: number, y: number) => {
  const i = (Math.round(y) * img.width + Math.round(x)) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};

async function countDo(bytes: Uint8Array): Promise<number> {
  const lib = await PDFDocument.load(bytes);
  const ops = tokenizeContent(pageContentBytes(lib, lib.getPage(0)));
  return ops.filter((o) => o.op === "Do").length;
}

test("既存画像：位置を検出し、削除すると描画命令が消える", async () => {
  const { doc, pages } = await loadSource(imagesPdf);
  const imgs = await getPageImages(doc, pages[0]);
  assert.equal(imgs.length, 2);
  const red = imgs.find((i) => i.pixelW === 80)!;
  // 表示座標は左上原点：y=180..270 → top=30
  assert.ok(Math.abs(red.x - 50) < 0.5 && Math.abs(red.top - 30) < 0.5 && Math.abs(red.w - 120) < 0.5 && Math.abs(red.h - 90) < 0.5, JSON.stringify(red));
  const del: ImageEditObj = { id: "d", type: "imageedit", opIndex: red.opIndex, name: red.name, x: red.x, y: red.top, w: red.w, h: red.h };
  const bytes = await buildPdf([{ ...pages[0], objects: [del] }], new Map([[doc.id, doc]]), new Map());
  assert.equal(await countDo(bytes), 1);
  const img = await renderPage(await openPdf(bytes), 1, 1);
  assert.deepEqual(pixel(img, 110, 75), [255, 255, 255], "赤い画像が消えて白になる");
  assert.deepEqual(pixel(img, 270, 190), [0, 0, 255], "青い画像は残る");
  assert.ok((await pageText(await openPdf(bytes), 1)).includes("Hello Images"));
});

test("墨消し：範囲に掛かる文字だけが PDF から消え、残りの文字と位置は保たれる（和文・欧文）", async () => {
  for (const [fixture, lineText, removed, kept] of [
    ["ja-subset-identity.pdf", "株式会社サンプル商事 御中", "株式会社", "御中"],
    ["en-standard14.pdf", "Quarterly Report 2026 Q3", "Quarterly", "Q3"],
  ] as const) {
    const { doc, pages } = await loadSource(join(fixtures, fixture));
    const { runs } = await getPageText(doc, pages[0]);
    const run = runs.find((r) => r.text.includes(lineText));
    assert.ok(run, `${fixture}: 行が見つからない`);
    // 行の左 40% を墨消し
    const r: RedactObj = { id: "r", type: "redact", x: run.x - 1, y: run.top - 1, w: run.w * 0.4, h: run.h + 2, fill: "#000000" };
    const warnings: string[] = [];
    const bytes = await buildPdf([{ ...pages[0], objects: [r] }], new Map([[doc.id, doc]]), new Map(), { onWarning: (m) => warnings.push(m) });
    const pdf = await openPdf(bytes);
    const text = await pageText(pdf, 1);
    assert.ok(!text.includes(removed), `${fixture}: 「${removed}」が残っている: ${text.slice(0, 120)}`);
    assert.ok(text.includes(kept), `${fixture}: 「${kept}」が消えている: ${text.slice(0, 120)}`);
    // 塗りつぶしが描かれている
    const img = await renderPage(pdf, 1, 1);
    assert.deepEqual(pixel(img, run.x + run.w * 0.2, run.top + run.h / 2), [0, 0, 0], `${fixture}: 黒く塗られていない`);
    // 残った文字の位置が元と同じ（右側の文字の x）
    const items = await (await pdf.getPage(1)).getTextContent();
    const keptItem = items.items.find((it) => "str" in it && it.str.includes(kept));
    assert.ok(keptItem && "transform" in keptItem, "残った文字が取れない");
    const srcPdf = await openPdf(doc.bytes);
    const srcItems = await (await srcPdf.getPage(1)).getTextContent();
    const srcLine = srcItems.items.find((it) => "str" in it && it.str.includes(lineText));
    assert.ok(srcLine && "transform" in srcLine);
    // 元の行の開始 x + 消した分の幅 ≒ 残った部分の開始 x。少なくとも元の行より右にある
    assert.ok(keptItem.transform[4] > srcLine.transform[4] + 10, `${fixture}: 残りの文字が左に詰まっている`);
    assert.equal(warnings.length, 0, warnings.join("\n"));
  }
});

test("墨消し：範囲に一部だけ掛かる画像は残り（その範囲だけ塗りつぶす）、範囲外の文字も残る", async () => {
  const { doc, pages } = await loadSource(imagesPdf);
  // 赤い画像（x 50..170, top 30..120）の右下だけに掛かる範囲
  const r: RedactObj = { id: "r", type: "redact", x: 150, y: 100, w: 60, h: 40, fill: "#000000" };
  const bytes = await buildPdf([{ ...pages[0], objects: [r] }], new Map([[doc.id, doc]]), new Map());
  assert.equal(await countDo(bytes), 2);
  const pdf = await openPdf(bytes);
  assert.ok((await pageText(pdf, 1)).includes("Hello Images"));
  const img = await renderPage(pdf, 1, 1);
  assert.ok(pixel(img, 60, 40)[0] > 200 && pixel(img, 60, 40)[2] < 60, "赤い画像の、範囲の外は残る");
  assert.deepEqual(pixel(img, 180, 120), [0, 0, 0], "範囲は黒く塗られる");
  assert.deepEqual(pixel(img, 270, 190), [0, 0, 255], "青い画像は残る");
});

test("墨消し：範囲に掛かる元の注釈（付箋とポップアップ）が外れる", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "ja-subset-identity.pdf"));
  const note: NoteObj = { id: "n", type: "note", x: 400, y: 80, color: "#ffd43b", contents: "消える付箋", author: "" };
  const withNote = await buildPdf([{ ...pages[0], objects: [note] }], new Map([[doc.id, doc]]), new Map());
  const file = join(tmpDir, "with-note.pdf");
  writeFileSync(file, withNote);
  const src = await loadSource(file);
  const r: RedactObj = { id: "r", type: "redact", x: 390, y: 70, w: 40, h: 40, fill: "#000000" };
  const bytes = await buildPdf([{ ...src.pages[0], objects: [r] } as PageItem], new Map([[src.doc.id, src.doc]]), new Map());
  const lib = await PDFDocument.load(bytes);
  const annots = lib.getPage(0).node.Annots();
  assert.ok(!(annots instanceof PDFArray) || annots.size() === 0, "注釈が残っている");
});

/** 出力のコンテンツストリームにある全パスの点（ページ座標）を集める */
async function pathPoints(bytes: Uint8Array): Promise<{ pts: [number, number][]; ops: string[] }> {
  const lib = await PDFDocument.load(bytes);
  const page = lib.getPage(0);
  const ops = tokenizeContent(pageContentBytes(lib, page));
  const stack: Matrix[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const pts: [number, number][] = [];
  for (const op of ops) {
    const a = op.operands;
    if (op.op === "q") stack.push(ctm);
    else if (op.op === "Q") ctm = stack.pop() ?? ctm;
    else if (op.op === "cm") ctm = multiply(ctm, [num(a[0]), num(a[1]), num(a[2]), num(a[3]), num(a[4]), num(a[5])]);
    else if (op.op === "m" || op.op === "l") pts.push(apply(ctm, num(a[0]), num(a[1])));
    else if (op.op === "c") for (let k = 0; k < 6; k += 2) pts.push(apply(ctm, num(a[k]), num(a[k + 1])));
    else if (op.op === "re") {
      const [x, y, w, h] = [num(a[0]), num(a[1]), num(a[2]), num(a[3])];
      for (const [px, py] of [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]) pts.push(apply(ctm, px, py));
    }
  }
  return { pts, ops: ops.map((o) => o.op) };
}

test("墨消し：図形（パス）は範囲に掛かる部分だけが幾何的に切り取られ、範囲外の描画は変わらない", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "vector.pdf"));
  // 範囲：ページ座標 x 120..180, y 120..200（表示座標では top = 300-200 = 100）
  const r: RedactObj = { id: "r", type: "redact", x: 120, y: 100, w: 60, h: 80, fill: "#000000" };
  const warnings: string[] = [];
  const bytes = await buildPdf([{ ...pages[0], objects: [r] }], new Map([[doc.id, doc]]), new Map(), { onWarning: (m) => warnings.push(m) });
  writeFileSync(join(tmpDir, "vector-redacted.pdf"), bytes);
  // 1. 範囲の内側（端から 0.5pt 以上内側）に点を持つパスが無い
  const { pts, ops } = await pathPoints(bytes);
  const inside = pts.filter(([x, y]) => x > 120.5 && x < 179.5 && y > 120.5 && y < 199.5);
  assert.equal(inside.length, 0, `範囲内に点が残っている: ${JSON.stringify(inside.slice(0, 5))}`);
  // 2. 範囲に完全に入っていた赤い四角は消え、ページ全体のクリップ（W n）は残る
  assert.ok(ops.includes("W"), "クリップが消えている");
  assert.equal(warnings.length, 0, warnings.join("\n"));
  // 3. 描画：範囲の外は元と同じ、範囲の中は黒
  const before = await renderPage(await openPdf(doc.bytes), 1, 2);
  const after = await renderPage(await openPdf(bytes), 1, 2);
  await savePng(before, join(tmpDir, "vector-before.png"));
  await savePng(after, join(tmpDir, "vector-redacted.png"));
  const d = diffOutside(before, after, [{ x: 120, y: 100, w: 60, h: 80 }], 2);
  assert.ok(d.changed / d.total < 0.002, `範囲外が変わった: ${d.changed}/${d.total}`);
  const px = (x: number, y: number) => {
    const i = (y * 2 * after.width + x * 2) * 4;
    return [after.data[i], after.data[i + 1], after.data[i + 2]];
  };
  assert.deepEqual(px(150, 140), [0, 0, 0]);
  // 範囲のすぐ外にある罫線・セル背景・曲線は残っている
  assert.ok(px(100, 90)[0] < 230, "セル背景が消えた");
  assert.ok(px(60, 150)[0] < 100, "横罫線が消えた");
  assert.ok(px(150, 60)[0] < 100, "範囲の下の縦罫線が消えた");
  assert.ok((await pageText(await openPdf(bytes), 1)).includes("Vector"));
});

test("墨消し：クリップ付きのパスは形を変えず、警告で知らせる", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "vector.pdf"));
  // 右上の「re W f」（x 300..360, y 200..240 → 表示 top 60..100）に一部掛かる範囲
  const r: RedactObj = { id: "r", type: "redact", x: 340, y: 50, w: 40, h: 30, fill: "#000000" };
  const warnings: string[] = [];
  const bytes = await buildPdf([{ ...pages[0], objects: [r] }], new Map([[doc.id, doc]]), new Map(), { onWarning: (m) => warnings.push(m) });
  const { pts, ops } = await pathPoints(bytes);
  assert.equal(ops.filter((o) => o === "W").length, 2, "クリップが消えている");
  assert.ok(pts.some(([x, y]) => Math.abs(x - 360) < 0.01 && Math.abs(y - 240) < 0.01), "クリップ付きの矩形の形が変わった");
  assert.equal(warnings.length, 1, warnings.join("\n"));
  assert.match(warnings[0], /1/);
});

test("墨消し：回転した CTM の下の図形も、ページ座標で判定して切り取られる", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "vector.pdf"));
  // 45° 回転した紫の矩形（ページ座標 x 143..202, y 40..99）の右半分に掛かる範囲（表示 top = 300-99）
  const r: RedactObj = { id: "r", type: "redact", x: 175, y: 201, w: 50, h: 60, fill: "#000000" };
  const bytes = await buildPdf([{ ...pages[0], objects: [r] }], new Map([[doc.id, doc]]), new Map());
  const { pts } = await pathPoints(bytes);
  const inside = pts.filter(([x, y]) => x > 175.5 && x < 224.5 && y > 39.5 && y < 98.5);
  assert.equal(inside.length, 0, JSON.stringify(inside));
  const img = await renderPage(await openPdf(bytes), 1, 2);
  const px = (x: number, y: number) => {
    const i = (y * 2 * img.width + x * 2) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  };
  // 範囲の左側に残る紫（ページ (160, 60) → 表示 (160, 240)）と、範囲の黒
  assert.deepEqual(px(160, 240), [128, 0, 128]);
  assert.deepEqual(px(190, 230), [0, 0, 0]);
});

test("墨消しの取りこぼし：文書情報・しおり・他ページに同じ語が残っていれば警告する", async () => {
  assert.deepEqual(redactedWords(["株式会社 サンプル商事", "ab Quarterly 2026", "株式会社"]), ["株式会社", "サンプル商事", "Quarterly", "2026"]);
  const { doc, pages } = await loadSource(join(fixtures, "ja-subset-identity.pdf"));
  const { runs } = await getPageText(doc, pages[0]);
  const run = runs.find((r) => r.text.includes("株式会社サンプル商事"))!;
  const r: RedactObj = { id: "r", type: "redact", x: run.x - 1, y: run.top - 1, w: run.w * 0.4, h: run.h + 2, fill: "#000000" };
  const settings = defaultSettings();
  settings.meta = { ...settings.meta, title: "株式会社サンプル商事 御見積" };
  settings.outline = [{ id: "o1", title: "株式会社サンプル商事の概要", pageId: pages[0].id, level: 0 }];
  // 同じ元ページをもう 1 枚（墨消し無し）入れる → 2 ページ目に語が残る
  const second = { ...pages[0], id: "p2", objects: [] };
  const warnings: string[] = [];
  await buildPdf([{ ...pages[0], objects: [r] }, second], new Map([[doc.id, doc]]), new Map(), { settings, onWarning: (m) => warnings.push(m) });
  const w = warnings.find((m) => m.includes("株式会社"));
  assert.ok(w, warnings.join("\n"));
  // 残っている場所（「…に残っています」より前）に、文書情報・しおり・2 ページ目の文字が並ぶ
  const where = w.split("に残っています")[0];
  assert.ok(where.includes("文書情報") && where.includes("しおり") && where.includes("2 ページ目の文字"), w);
  // 本文に残っているので、検索での墨消しへ案内する
  assert.ok(w.includes("検索と置換・墨消し"), w);
  assert.ok(!w.includes("1 ページ目の文字"), w);
});

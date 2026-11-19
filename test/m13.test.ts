import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from "pdf-lib";
import { type AttachmentItem, readAttachments, writeAttachments } from "@/lib/attachments";
import { diffImages, diffLines } from "@/lib/compare";
import { defaultSettings } from "@/lib/docOps";
import { buildPdf } from "@/lib/exportPdf";
import { bookletOrder, defaultImpose, imposePdf } from "@/lib/impose";
import { readOutlines, writeOutlines } from "@/lib/outlines";
import type { RedactObj } from "@/lib/types";
import { fixtures, loadSource, openPdf, pageText, renderPage } from "./helpers";

/** "P1".."Pn" と書いた n ページの PDF */
async function numberedPdf(n: number, rotateThird = false): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= n; i++) {
    const p = doc.addPage([300, 400]);
    p.drawText(`P${i}`, { x: 40, y: 340, size: 36, font });
    if (rotateThird && i === 3) p.setRotation({ type: "degrees", angle: 90 } as never);
  }
  return doc.save();
}

test("小冊子の並びと N-up の面付け", async () => {
  assert.deepEqual(bookletOrder(5), [-1, 0, 1, -1, -1, 2, 3, 4]);
  assert.deepEqual(bookletOrder(4), [3, 0, 1, 2]);
  const src = await numberedPdf(5);
  // 小冊子：4 シート、横向き、1 枚目の表は右に P1 だけ
  const booklet = await imposePdf(src, { ...defaultImpose(), booklet: true });
  const b = await openPdf(booklet);
  assert.equal(b.numPages, 4);
  const vp = (await b.getPage(1)).getViewport({ scale: 1 });
  assert.ok(vp.width > vp.height, "横向きでない");
  assert.equal((await pageText(b, 1)).trim(), "P1");
  const last = await pageText(b, 4);
  assert.ok(last.includes("P4") && last.includes("P5"), last);
  // P1 は右半分にある
  const items = (await (await b.getPage(1)).getTextContent()).items.filter((it) => "str" in it && it.str === "P1");
  assert.ok(items.length && "transform" in items[0] && items[0].transform[4] > vp.width / 2, "P1 が右側にない");
  // 4-up：2 シート、1 枚目に P1〜P4
  const nup = await imposePdf(src, { ...defaultImpose(), perSheet: 4, paper: "A4", border: true });
  const u = await openPdf(nup);
  assert.equal(u.numPages, 2);
  const t1 = await pageText(u, 1);
  for (const s of ["P1", "P2", "P3", "P4"]) assert.ok(t1.includes(s), t1);
  assert.ok((await pageText(u, 2)).includes("P5"));
  await renderPage(u, 1, 1);
  // 右綴じ：P1 が左側
  const rtl = await imposePdf(src, { ...defaultImpose(), perSheet: 2, rightToLeft: true });
  const r = await openPdf(rtl);
  const vr = (await r.getPage(1)).getViewport({ scale: 1 });
  const it = (await (await r.getPage(1)).getTextContent()).items.filter((x) => "str" in x && x.str === "P1");
  assert.ok(it.length && "transform" in it[0] && it[0].transform[4] > vr.width / 2, "右綴じでは P1 が右（最初に読む側）");
});

test("面付け：回転したページも見た目の向きで枠に収まる", async () => {
  const src = await numberedPdf(3, true);
  const out = await imposePdf(src, { ...defaultImpose(), perSheet: 4 });
  const pdf = await openPdf(out);
  const text = await pageText(pdf, 1);
  assert.ok(text.includes("P3"), text);
  const img = await renderPage(pdf, 1, 1);
  assert.ok(img.width > 0);
});

test("添付ファイル：読み取り・引き継ぎ・追加", async () => {
  const src = await PDFDocument.create();
  src.addPage([200, 200]);
  await src.attach(new TextEncoder().encode("hello attachment"), "memo.txt", { mimeType: "text/plain", description: "メモ" });
  const bytes = await src.save();
  const items = readAttachments(await PDFDocument.load(bytes));
  assert.equal(items.length, 1);
  assert.equal(items[0].name, "memo.txt");
  assert.equal(items[0].mime, "text/plain");
  assert.equal(items[0].description, "メモ");
  assert.equal(new TextDecoder().decode(items[0].bytes), "hello attachment");
  // 出力に 2 つ書く（引き継ぎ＋新規）
  const out = await PDFDocument.create();
  out.addPage([100, 100]);
  const list: AttachmentItem[] = [
    { id: "a", srcId: "s", ...items[0] },
    { id: "b", srcId: null, name: "data.csv", bytes: new TextEncoder().encode("a,b\n1,2"), mime: "text/csv", description: "" },
  ];
  await writeAttachments(out, list);
  const again = readAttachments(await PDFDocument.load(await out.save()));
  assert.deepEqual(again.map((a) => a.name).sort(), ["data.csv", "memo.txt"]);
  // pdf.js でも添付として見える
  const pdf = await openPdf(await out.save());
  const att = await pdf.getAttachments();
  // pdf.js の版によって、Map か普通のオブジェクトで返る
  const names = att instanceof Map ? [...att.keys()] : Object.keys(att ?? {});
  assert.equal(names.length, 2, JSON.stringify(names));
});

test("しおり：階層付きで書き、読み戻せる。pdf.js の目次とページが一致する", async () => {
  const doc = await PDFDocument.load(await numberedPdf(4));
  const pageIds = ["pa", "pb", "pc", "pd"];
  writeOutlines(
    doc,
    [
      { id: "1", title: "第1章 はじめに", pageId: "pa", level: 0 },
      { id: "2", title: "1.1 背景", pageId: "pb", level: 1 },
      { id: "3", title: "1.2 目的", pageId: "pc", level: 1 },
      { id: "4", title: "第2章 まとめ", pageId: "pd", level: 0 },
      { id: "5", title: "ページ無し", pageId: null, level: 1 },
    ],
    (id) => pageIds.indexOf(id ?? ""),
  );
  const bytes = await doc.save();
  const back = readOutlines(await PDFDocument.load(bytes), pageIds);
  assert.deepEqual(
    back.map((b) => [b.title, b.pageId, b.level]),
    [
      ["第1章 はじめに", "pa", 0],
      ["1.1 背景", "pb", 1],
      ["1.2 目的", "pc", 1],
      ["第2章 まとめ", "pd", 0],
      ["ページ無し", null, 1],
    ],
  );
  const pdf = await openPdf(bytes);
  const outline = await pdf.getOutline();
  assert.ok(outline && outline.length === 2 && outline[0].items.length === 2, JSON.stringify(outline?.map((o) => o.title)));
  const idx = await pdf.getPageIndex(outline![0].items[1].dest![0] as never);
  assert.equal(idx, 2, "1.2 目的 は 3 ページ目");
});

test("文書比較：描画差分の矩形と行テキストの差分", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "ja-subset-identity.pdf"));
  const base = await renderPage(await openPdf(doc.bytes), 1, 1);
  const same = diffImages(base, base);
  assert.equal(same.boxes.length, 0);
  const r: RedactObj = { id: "r", type: "redact", x: 70, y: 70, w: 120, h: 20, fill: "#000000" };
  const edited = await buildPdf([{ ...pages[0], objects: [r] }], new Map([[doc.id, doc]]), new Map(), { settings: defaultSettings() });
  const after = await renderPage(await openPdf(edited), 1, 1);
  const d = diffImages(base, after);
  assert.ok(d.boxes.length >= 1, "差分が検出されない");
  const hit = d.boxes.some((b) => b.x <= 130 && b.x + b.w >= 130 && b.y <= 80 && b.y + b.h >= 80);
  assert.ok(hit, JSON.stringify(d.boxes));
  const lines = diffLines(["a", "b", "c", "d"], ["a", "x", "c"]);
  assert.deepEqual(lines, [
    { kind: "same", text: "a" },
    { kind: "del", text: "b" },
    { kind: "add", text: "x" },
    { kind: "same", text: "c" },
    { kind: "del", text: "d" },
  ]);
});

test("しおり：行き先を持たず、文書の構造の要素（/SE）だけを指すしおりは、その要素（または子の要素）のあるページへ飛ぶ", async () => {
  const doc = await PDFDocument.load(await numberedPdf(3));
  const ctx = doc.context;
  const pages = doc.getPages();
  // 構造の要素：親（ページを持たない）→ 子（2 ページ目）
  const kid = ctx.register(ctx.obj({ Type: "StructElem", S: "P", Pg: pages[1].ref }));
  const parent = ctx.register(ctx.obj({ Type: "StructElem", S: "Document", K: [kid] }));
  const direct = ctx.register(ctx.obj({ Type: "StructElem", S: "H1", Pg: pages[2].ref }));
  const root = ctx.nextRef();
  const a = ctx.nextRef();
  const b = ctx.nextRef();
  ctx.assign(a, ctx.obj({ Title: PDFHexString.fromText("子の要素から"), Parent: root, Next: b, SE: parent }));
  ctx.assign(b, ctx.obj({ Title: PDFHexString.fromText("要素そのものから"), Parent: root, Prev: a, SE: direct }));
  ctx.assign(root, ctx.obj({ Type: "Outlines", First: a, Last: b, Count: 2 }));
  doc.catalog.set(PDFName.of("Outlines"), root);
  const back = readOutlines(await PDFDocument.load(await doc.save()), ["p1", "p2", "p3"]);
  assert.deepEqual(back.map((x) => [x.title, x.pageId]), [["子の要素から", "p2"], ["要素そのものから", "p3"]]);
});

test("しおり：Web のアドレスを開くしおりは、保存しても同じアドレスを開く（javascript: などは引き継がない）", async () => {
  const doc = await PDFDocument.load(await numberedPdf(2));
  const ctx = doc.context;
  const root = ctx.nextRef();
  const a = ctx.nextRef();
  const b = ctx.nextRef();
  ctx.assign(a, ctx.obj({ Title: PDFHexString.fromText("サイト"), Parent: root, Next: b, A: { S: "URI", URI: PDFString.of("https://example.com/a(1)") } }));
  ctx.assign(b, ctx.obj({ Title: PDFHexString.fromText("あやしい"), Parent: root, Prev: a, A: { S: "URI", URI: PDFString.of("javascript:alert(1)") } }));
  ctx.assign(root, ctx.obj({ Type: "Outlines", First: a, Last: b, Count: 2 }));
  doc.catalog.set(PDFName.of("Outlines"), root);
  const read = readOutlines(await PDFDocument.load(await doc.save()), ["p1", "p2"]);
  assert.deepEqual(read.map((x) => [x.title, x.pageId, x.uri]), [["サイト", null, "https://example.com/a(1)"], ["あやしい", null, undefined]]);
  const out = await PDFDocument.load(await numberedPdf(2));
  writeOutlines(out, read, () => -1);
  const back = readOutlines(await PDFDocument.load(await out.save()), ["p1", "p2"]);
  assert.deepEqual(back.map((x) => [x.title, x.uri]), [["サイト", "https://example.com/a(1)"], ["あやしい", undefined]]);
});

test("面付け：中身（/Contents）の無い白紙ページを含んでいても作れる", async () => {
  const d = await PDFDocument.create();
  for (let i = 0; i < 3; i++) d.addPage([595, 842]).drawText(`page ${i + 1}`, { x: 50, y: 700, size: 24 });
  d.addPage([595, 842]);
  // pdf-lib は空のページにも中身を作るので、取り除いて「中身の無いページ」にする
  d.getPage(3).node.delete(PDFName.of("Contents"));
  const src = await d.save();
  const out = await PDFDocument.load(await imposePdf(src, { ...defaultImpose(), perSheet: 2, paper: "A4" }));
  assert.equal(out.getPageCount(), 2);
});

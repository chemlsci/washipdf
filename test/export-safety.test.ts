// 保存の安全性と正しさ：リンクの URL の書き方、読み込んだリンクだけの作り直し、複製したページの独立、
// 消す操作があるときのタグの扱い、回転・大きさ変更したページの入力欄と注釈、合わせた文書の入力欄の名前、消えたページの欄
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from "pdf-lib";
import { normalizeLinkUrl, safeLinkUrl } from "@/lib/annots";
import { defaultSettings } from "@/lib/docOps";
import { buildPdf } from "@/lib/exportPdf";
import { translate } from "@/lib/i18n";
import { readPageLinks } from "@/lib/pageLinks";
import type { FieldObj, LinkObj, MarkupObj, RedactObj } from "@/lib/types";
import { fixtures, loadSource, openPdf } from "./helpers";

const dir = mkdtempSync(join(tmpdir(), "washi-safety-"));
const save = async (d: PDFDocument, name: string) => {
  const file = join(dir, name);
  writeFileSync(file, await d.save({ useObjectStreams: false }));
  return file;
};
const annotsOf = (lib: PDFDocument, i: number) => {
  const a = lib.getPage(i).node.lookup(PDFName.of("Annots"));
  return a instanceof PDFArray ? a.asArray().map((r) => lib.context.lookup(r)).filter((d): d is PDFDict => d instanceof PDFDict) : [];
};

test("リンクの URL：書けるものだけを、国際化・%エンコードした ASCII にそろえる", () => {
  assert.equal(normalizeLinkUrl(" https://example.com/a b"), null, "空白を含むものは書かない");
  assert.equal(normalizeLinkUrl("javascript:alert(1)"), null);
  assert.equal(normalizeLinkUrl("https://"), null);
  assert.equal(normalizeLinkUrl("tel:0312345678"), null);
  assert.equal(normalizeLinkUrl("https://例え.jp/パス"), "https://xn--r8jz45g.jp/%E3%83%91%E3%82%B9");
  assert.equal(normalizeLinkUrl("mailto:山田@example.jp"), "mailto:%E5%B1%B1%E7%94%B0@example.jp");
  assert.equal(normalizeLinkUrl("https://example.com/wiki/Foo_(bar)"), "https://example.com/wiki/Foo_(bar)");
  assert.ok(safeLinkUrl("https://example.com/") && !safeLinkUrl("ftp://example.com/"));
});

test("リンクの URL はかっこ・\\ を含んでも構文を壊さず、別の命令（JavaScript）を差し込めない", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "ja-subset-identity.pdf"));
  const evil = "https://x.example/)/S/JavaScript/JS(app.alert(1)";
  const half = "https://example.com/a)b\\x";
  const links: LinkObj[] = [evil, half].map((url, i) => ({ id: `l${i}`, type: "link", x: 50, y: 50 + i * 40, w: 100, h: 20, target: { kind: "url", url } }));
  const bytes = await buildPdf([{ ...pages[0], objects: links }], new Map([[doc.id, doc]]), new Map());
  const lib = await PDFDocument.load(bytes);
  const acts = annotsOf(lib, 0).map((d) => d.lookup(PDFName.of("A")) as PDFDict);
  for (const a of acts) {
    assert.equal(a.get(PDFName.of("S")), PDFName.of("URI"));
    assert.equal(a.get(PDFName.of("JS")), undefined, "JavaScript の命令が差し込まれている");
  }
  const pdf = await openPdf(bytes);
  const urls = ((await (await pdf.getPage(1)).getAnnotations()) as { url?: string }[]).map((a) => a.url);
  assert.deepEqual(urls, [evil, "https://example.com/a)b/x"]);
});

test("リンクの道具で読み込んだリンクだけを作り直し、読み込めないリンク（tel:・ページ送り）は残す。ほかのファイルを開くリンクは外す", async () => {
  const d = await PDFDocument.create();
  const pg = d.addPage([300, 300]);
  d.addPage([300, 300]);
  const mk = (rect: number[], A: Record<string, unknown>) => d.context.register(d.context.obj({ Type: "Annot", Subtype: "Link", Rect: rect, Border: [0, 0, 0], A } as never));
  pg.node.set(
    PDFName.of("Annots"),
    d.context.obj([
      mk([10, 10, 50, 30], { S: "URI", URI: PDFString.of("tel:+81312345678") }),
      mk([10, 40, 50, 60], { S: "Named", N: PDFName.of("NextPage") }),
      mk([10, 70, 50, 90], { S: "GoToR", F: PDFString.of("other.pdf"), D: [0, PDFName.of("Fit")] }),
      mk([10, 100, 50, 120], { S: "URI", URI: PDFString.of("https://ok.example/") }),
    ]),
  );
  const { doc, pages } = await loadSource(await save(d, "links.pdf"));
  const { links, refs } = await readPageLinks(doc, pages[0], pages);
  assert.equal(links.length, 1);
  // 読み込んだリンクを消して保存：https のリンクだけが無くなる
  const bytes = await buildPdf([{ ...pages[0], linksImported: refs, objects: [] }, pages[1]], new Map([[doc.id, doc]]), new Map());
  const lib = await PDFDocument.load(bytes);
  // ほかのファイルを開くリンク（GoToR）は、動作が外れて押しても何も起きない
  const kinds = annotsOf(lib, 0).map((a) => {
    const act = a.lookup(PDFName.of("A")) as PDFDict | undefined;
    return act ? (act.get(PDFName.of("S")) as PDFName).decodeText() : "none";
  });
  assert.deepEqual(kinds.sort(), ["Named", "URI", "none"]);
});

test("複製したページに足した注釈は、元のページに出ない", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "forms.pdf"));
  const p0 = pages[0];
  const mk: MarkupObj = { id: "m", type: "markup", kind: "highlight", x: 70, y: 70, w: 100, h: 18, color: "#ffe234", opacity: 0.5, contents: "" };
  const before = annotsOf(await PDFDocument.load(doc.bytes), 0).length;
  const bytes = await buildPdf([{ ...p0, objects: [] }, { ...p0, id: "dup", objects: [mk] }], new Map([[doc.id, doc]]), new Map());
  const lib = await PDFDocument.load(bytes);
  const sub = (i: number) => annotsOf(lib, i).map((a) => (a.get(PDFName.of("Subtype")) as PDFName).decodeText());
  assert.equal(sub(0).length, before);
  assert.ok(!sub(0).includes("Highlight"));
  assert.ok(sub(1).includes("Highlight"));
  // 中身の命令列も別々（片方への書き込みがもう片方に出ない）
  assert.notEqual(lib.getPage(0).node.get(PDFName.of("Contents"))?.toString(), lib.getPage(1).node.get(PDFName.of("Contents"))?.toString());
});

test("墨消し・元の注釈の削除があるときは、タグ（説明文・注釈への参照）を引き継がない", async () => {
  const d = await PDFDocument.create();
  const pg = d.addPage([300, 300]);
  pg.drawText("Visit", { x: 20, y: 250, size: 20, font: await d.embedFont(StandardFonts.Helvetica) });
  const link = d.context.register(d.context.obj({ Type: "Annot", Subtype: "Link", Rect: [20, 240, 120, 270], A: { S: "URI", URI: PDFString.of("https://secret-site.example/") }, StructParent: 1 } as never));
  pg.node.set(PDFName.of("Annots"), d.context.obj([link]));
  const root = d.context.obj({ Type: "StructTreeRoot" }) as PDFDict;
  const rootRef = d.context.register(root);
  const fig = d.context.register(d.context.obj({ Type: "StructElem", S: "Figure", P: rootRef, Pg: pg.ref, Alt: PDFHexString.fromText("SECRETNAME") }));
  const el = d.context.register(d.context.obj({ Type: "StructElem", S: "Link", P: rootRef, Pg: pg.ref, K: [{ Type: "OBJR", Obj: link, Pg: pg.ref }] } as never));
  root.set(PDFName.of("K"), d.context.obj([fig, el]));
  d.catalog.set(PDFName.of("StructTreeRoot"), rootRef);
  d.catalog.set(PDFName.of("MarkInfo"), d.context.obj({ Marked: true }));
  const { doc, pages } = await loadSource(await save(d, "tagged.pdf"));
  // 何もしなければ引き継ぐ
  const b0 = await buildPdf([{ ...pages[0], objects: [] }], new Map([[doc.id, doc]]), new Map());
  assert.ok((await PDFDocument.load(b0)).catalog.get(PDFName.of("StructTreeRoot")));
  const red: RedactObj = { id: "r", type: "redact", x: 0, y: 0, w: 300, h: 300, fill: "#000000" };
  const b1 = await buildPdf([{ ...pages[0], objects: [red] }], new Map([[doc.id, doc]]), new Map());
  assert.ok(!(await PDFDocument.load(b1)).catalog.get(PDFName.of("StructTreeRoot")));
  const settings = { ...defaultSettings(), stripAnnotations: true };
  const b2 = await buildPdf([{ ...pages[0], objects: [] }], new Map([[doc.id, doc]]), new Map(), { settings });
  assert.ok(!(await PDFDocument.load(b2)).catalog.get(PDFName.of("StructTreeRoot")));
  // 外したリンクの URL も、説明文も、ファイルの中のどこにも残らない
  const lib2 = await PDFDocument.load(b2);
  const texts = lib2.context
    .enumerateIndirectObjects()
    .flatMap(([, o]) => (o instanceof PDFDict ? o.values() : []))
    .flatMap((v) => (v instanceof PDFDict ? [...v.values(), v] : [v]))
    .filter((v): v is PDFString | PDFHexString => v instanceof PDFString || v instanceof PDFHexString)
    .map((v) => v.decodeText());
  assert.ok(!texts.some((t) => t.includes("secret-site") || t.includes("SECRETNAME")), texts.join(" | "));
});

test("回転したページの入力欄は、画面で置いた向き・大きさで保存される", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "ja-rotated90.pdf"));
  const p = pages[0];
  assert.equal(p.baseRotation, 90);
  const f: FieldObj = { id: "f", type: "field", kind: "text", name: "nm", x: 100, y: 300, w: 200, h: 24, options: [] };
  const bytes = await buildPdf([{ ...p, objects: [f] }], new Map([[doc.id, doc]]), new Map());
  const lib = await PDFDocument.load(bytes);
  const w = annotsOf(lib, 0).find((a) => a.get(PDFName.of("Subtype")) === PDFName.of("Widget"))!;
  const [x0, y0, x1, y1] = (w.lookup(PDFName.of("Rect")) as PDFArray).asArray().map((n) => Number(n.toString()));
  // 90° 回したページでは、画面の横（幅 200）が PDF の縦になる
  assert.ok(Math.abs(Math.abs(y1 - y0) - 200) < 1.5 && Math.abs(Math.abs(x1 - x0) - 24) < 1.5, `${[x0, y0, x1, y1]}`);
  const mk = w.lookup(PDFName.of("MK")) as PDFDict;
  assert.equal(mk.get(PDFName.of("R"))?.toString(), "90");
});

test("ページの大きさを変えると、注釈・リンク・入力欄も同じ割合で動く", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "ja-subset-identity.pdf"));
  const p = pages[0];
  const l: LinkObj = { id: "l", type: "link", x: 400, y: 700, w: 100, h: 20, target: { kind: "url", url: "https://a.example/" } };
  const f: FieldObj = { id: "f", type: "field", kind: "text", name: "x", x: 400, y: 740, w: 100, h: 20, options: [] };
  const m: MarkupObj = { id: "m", type: "markup", kind: "highlight", x: 400, y: 660, w: 100, h: 20, color: "#ffff00", opacity: 0.5, contents: "" };
  const bytes = await buildPdf([{ ...p, scaleTo: { width: p.width / 2, height: p.height / 2 }, objects: [l, f, m] }], new Map([[doc.id, doc]]), new Map());
  const lib = await PDFDocument.load(bytes);
  const mb = lib.getPage(0).getMediaBox();
  for (const a of annotsOf(lib, 0)) {
    const [x0, y0, x1, y1] = (a.lookup(PDFName.of("Rect")) as PDFArray).asArray().map((n) => Number(n.toString()));
    assert.ok(x0 >= mb.x - 0.5 && x1 <= mb.x + mb.width + 0.5 && y0 >= mb.y - 0.5 && y1 <= mb.y + mb.height + 0.5, `ページの外：${[x0, y0, x1, y1]}`);
    assert.ok(Math.abs(x1 - x0 - 50) < 1, "幅が半分になっていない");
  }
});

test("合わせた文書の同じ名前の入力欄は別の名前にし、消したページの欄は文書の入力欄から外す", async () => {
  // 2 ページにまたがる欄（shared）と、2 ページ目だけの欄
  const d = await PDFDocument.create();
  const p1 = d.addPage([300, 300]);
  const p2 = d.addPage([300, 300]);
  const tf = d.getForm().createTextField("shared");
  tf.setText("VALUE");
  tf.addToPage(p1, { x: 20, y: 20, width: 100, height: 20 });
  tf.addToPage(p2, { x: 20, y: 20, width: 100, height: 20 });
  const file = await save(d, "two.pdf");
  const A = await loadSource(file);
  const only1 = await PDFDocument.load(await buildPdf([A.pages[0]], new Map([[A.doc.id, A.doc]]), new Map()));
  const ws = only1.getForm().getTextField("shared").acroField.getWidgets();
  assert.equal(ws.length, 1, "消したページの欄が残っている");
  // 同じ文書を 2 つ合わせる
  const B = await loadSource(file);
  const merged = await PDFDocument.load(await buildPdf([A.pages[0], B.pages[0]], new Map([[A.doc.id, A.doc], [B.doc.id, B.doc]]), new Map()));
  assert.deepEqual(merged.getForm().getFields().map((f) => f.getName()).sort(), ["shared", "shared_2"]);
});

test("新しく作った入力欄のフォントは、文書の入力欄の既定（/DR）にも入る", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "forms.pdf"));
  const f: FieldObj = { id: "f1", type: "field", kind: "text", name: "added", x: 50, y: 50, w: 100, h: 20, options: [] };
  const lib = await PDFDocument.load(await buildPdf([{ ...pages[0], objects: [f] }], new Map([[doc.id, doc]]), new Map()));
  const af = lib.catalog.lookup(PDFName.of("AcroForm")) as PDFDict;
  const fonts = (af.lookup(PDFName.of("DR")) as PDFDict).lookup(PDFName.of("Font")) as PDFDict;
  assert.ok(fonts.has(PDFName.of("Helvetica")));
});

test("英語の単数・複数", () => {
  assert.equal(translate("en", "common.pages", { n: 1 }), "1 page");
  assert.equal(translate("en", "common.pages", { n: 3 }), "3 pages");
  assert.equal(translate("ja", "common.pages", { n: 1 }), "1 ページ");
});

test("非表示のレイヤーは、保存しても非表示のまま（レイヤーの設定を引き継ぐ）", async () => {
  const d = await PDFDocument.create();
  const pg = d.addPage([300, 300]);
  const font = d.embedStandardFont(StandardFonts.Helvetica);
  const shown = d.context.register(d.context.obj({ Type: "OCG", Name: PDFString.of("Shown") }));
  const hidden = d.context.register(d.context.obj({ Type: "OCG", Name: PDFString.of("Hidden") }));
  pg.node.set(PDFName.of("Resources"), d.context.obj({ Font: { F1: font.ref }, Properties: { L1: shown, L2: hidden } }));
  pg.node.set(PDFName.of("Contents"), d.context.register(d.context.stream("/OC /L1 BDC BT /F1 14 Tf 20 250 Td (VISIBLE) Tj ET EMC\n/OC /L2 BDC 0 0 0 rg 20 100 200 60 re f EMC")));
  d.catalog.set(PDFName.of("OCProperties"), d.context.obj({ OCGs: [shown, hidden], D: { OFF: [hidden], Order: [shown, hidden] } }));
  const { doc, pages } = await loadSource(await save(d, "layers.pdf"));
  // 同じ文書を 2 つ合わせ、片方は複製もする（設定は足し合わせる）
  const other = await loadSource(await save(d, "layers2.pdf"));
  const bytes = await buildPdf([pages[0], { ...pages[0], id: "dup" }, other.pages[0]], new Map([[doc.id, doc], [other.doc.id, other.doc]]), new Map());
  const lib = await PDFDocument.load(bytes);
  const ocp = lib.catalog.lookup(PDFName.of("OCProperties")) as PDFDict;
  assert.equal((ocp.lookup(PDFName.of("OCGs")) as PDFArray).size(), 6);
  assert.equal(((ocp.lookup(PDFName.of("D")) as PDFDict).lookup(PDFName.of("OFF")) as PDFArray).size(), 3);
  // 見た目：黒い四角（非表示のレイヤー）は、どのページでも描かれない
  const pdf = await openPdf(bytes);
  const { renderPage } = await import("./helpers");
  for (let i = 1; i <= 3; i++) {
    const img = await renderPage(pdf, i, 1);
    const at = (x: number, y: number) => img.data[(y * img.width + x) * 4];
    assert.ok(at(100, 170) > 200, `${i} ページ目：非表示のレイヤーが見えている`);
  }
});

test("名前で指した行き先のリンクは、保存後も同じページへ飛ぶ（名前の表が無くなっても切れない）", async () => {
  const d = await PDFDocument.create();
  const p1 = d.addPage([300, 300]);
  d.addPage([300, 300]);
  const p3 = d.addPage([300, 300]);
  d.catalog.set(PDFName.of("Dests"), d.context.obj({ sec3: [p3.ref, PDFName.of("XYZ"), 0, 250, null] }));
  d.catalog.set(PDFName.of("Names"), d.context.obj({ Dests: { Names: [PDFString.of("tree3"), d.context.obj({ D: [p3.ref, PDFName.of("Fit")] })] } }));
  const mk = (rect: number[], extra: Record<string, unknown>) => d.context.register(d.context.obj({ Type: "Annot", Subtype: "Link", Rect: rect, Border: [0, 0, 0], ...extra } as never));
  p1.node.set(
    PDFName.of("Annots"),
    d.context.obj([mk([10, 10, 50, 30], { Dest: PDFName.of("sec3") }), mk([10, 40, 50, 60], { A: { S: PDFName.of("GoTo"), D: PDFString.of("tree3") } }), mk([10, 70, 50, 90], { Dest: PDFName.of("missing") })]),
  );
  const { doc, pages } = await loadSource(await save(d, "dests.pdf"));
  // 3 ページ目を 2 ページ目の位置へ動かして保存（2 ページ目は消す）
  const pdf = await openPdf(await buildPdf([pages[0], pages[2]], new Map([[doc.id, doc]]), new Map()));
  const annots = (await (await pdf.getPage(1)).getAnnotations()) as { dest?: unknown }[];
  const targets = [];
  for (const a of annots) targets.push(Array.isArray(a.dest) && a.dest[0] ? await pdf.getPageIndex(a.dest[0] as never) : null);
  assert.deepEqual(targets, [1, 1, null]);
  assert.equal((annots[0].dest as unknown[])[1] && ((annots[0].dest as { name: string }[])[1].name), "XYZ");
});

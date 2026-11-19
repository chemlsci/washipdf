import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFStream, StandardFonts } from "pdf-lib";
import { defaultSettings } from "@/lib/docOps";
import { buildPdf } from "@/lib/exportPdf";
import { decodeImageXObject } from "@/lib/imageCodec";
import type { CompressStats } from "@/lib/compress";
import { fixtures, loadSource, openPdf, pageText, renderPage } from "./helpers";
import { closePdf } from "@/lib/pdfjs";

const tmpDir = join(fixtures, "..", "..", "dist", ".test");
mkdirSync(tmpDir, { recursive: true });

/** 大きな JPEG（グラデーション）、半透明 PNG、小さな PNG を置いた PDF */
async function makeBigImagePdf(name = "big-images.pdf"): Promise<string> {
  const napi = await import("@napi-rs/canvas");
  const big = napi.createCanvas(1600, 1200);
  const g = big.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 1600, 0);
  grad.addColorStop(0, "#ff0000");
  grad.addColorStop(1, "#0000ff");
  g.fillStyle = grad;
  g.fillRect(0, 0, 1600, 1200);
  const alpha = napi.createCanvas(400, 400);
  const a = alpha.getContext("2d");
  a.fillStyle = "rgba(0, 160, 0, 1)";
  a.fillRect(0, 0, 200, 400); // 左半分だけ不透明、右半分は透明
  const small = napi.createCanvas(40, 40);
  small.getContext("2d").fillStyle = "#ffcc00";
  small.getContext("2d").fillRect(0, 0, 40, 40);
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  page.drawImage(await doc.embedJpg(await big.encode("jpeg", 95)), { x: 50, y: 230, width: 200, height: 150 });
  page.drawImage(await doc.embedPng(await alpha.encode("png")), { x: 50, y: 50, width: 100, height: 100 });
  page.drawImage(await doc.embedPng(await small.encode("png")), { x: 250, y: 50, width: 100, height: 100 });
  const file = join(tmpDir, name);
  writeFileSync(file, await doc.save({ useObjectStreams: false }));
  return file;
}

const pixel = (img: { data: Uint8ClampedArray; width: number }, x: number, y: number) => {
  const i = (Math.round(y) * img.width + Math.round(x)) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};
const near = (a: number[], b: number[], tol = 40) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

async function imageSizes(bytes: Uint8Array): Promise<{ w: number; h: number; filter: string; smask: boolean }[]> {
  const lib = await PDFDocument.load(bytes);
  const out: { w: number; h: number; filter: string; smask: boolean }[] = [];
  const xobj = lib.getPage(0).node.Resources()?.lookup(PDFName.of("XObject"));
  if (!xobj) return out;
  for (const [, v] of (xobj as import("pdf-lib").PDFDict).entries()) {
    const s = lib.context.lookup(v);
    if (!(s instanceof PDFStream)) continue;
    const f = s.dict.lookup(PDFName.of("Filter"));
    out.push({
      w: (s.dict.lookup(PDFName.of("Width")) as PDFNumber).asNumber(),
      h: (s.dict.lookup(PDFName.of("Height")) as PDFNumber).asNumber(),
      filter: f instanceof PDFName ? f.decodeText() : String(f),
      smask: s.dict.get(PDFName.of("SMask")) instanceof PDFRef,
    });
  }
  return out.sort((a, b) => b.w - a.w);
}

test("画像の復号：JPEG・Flate（RGB／RGBA の SMask）を読める", async () => {
  const file = await makeBigImagePdf();
  const lib = await PDFDocument.load(new Uint8Array((await import("node:fs")).readFileSync(file)));
  const xobj = lib.getPage(0).node.Resources()!.lookup(PDFName.of("XObject")) as import("pdf-lib").PDFDict;
  const decoded = xobj
    .entries()
    .map(([, v]) => lib.context.lookup(v))
    .filter((s): s is PDFStream => s instanceof PDFStream)
    .map((s) => decodeImageXObject(lib, s)!);
  assert.equal(decoded.length, 3);
  const jpeg = decoded.find((d) => d.kind === "jpeg")!;
  assert.ok(jpeg && jpeg.width === 1600 && jpeg.height === 1200);
  const withMask = decoded.find((d) => d.smask)!;
  assert.ok(withMask && withMask.kind === "rgb" && withMask.smask!.width === 400);
  assert.equal(withMask.smask!.data[10], 255, "左は不透明");
  assert.equal(withMask.smask!.data[390], 0, "右は透明");
});

test("圧縮：表示サイズに合わせて縮小・JPEG 化し、小さい画像と透明部分はそのまま", async () => {
  const file = await makeBigImagePdf();
  const { doc, pages } = await loadSource(file);
  const before = await renderPage(await openPdf(doc.bytes), 1, 1);
  const settings = defaultSettings();
  settings.compress = { enabled: true, dpi: 100, quality: 0.7, grayscale: false };
  let stats: CompressStats | null = null;
  const bytes = await buildPdf(pages, new Map([[doc.id, doc]]), new Map(), { settings, onCompressStats: (s) => (stats = s) });
  assert.ok(stats, "統計が無い");
  const st = stats as CompressStats;
  assert.equal(st.images, 3);
  assert.equal(st.recompressed, 2, JSON.stringify(st));
  assert.ok(bytes.length < doc.bytes.length * 0.5, `小さくなっていない: ${doc.bytes.length} → ${bytes.length}`);
  const sizes = await imageSizes(bytes);
  // 200pt × 100dpi ≒ 278px
  assert.ok(sizes[0].w <= 280 && sizes[0].w >= 270 && sizes[0].filter === "DCTDecode", JSON.stringify(sizes));
  assert.ok(sizes.some((s) => s.smask && s.filter === "DCTDecode" && s.w <= 140), "SMask 付き画像が縮小されていない");
  assert.ok(sizes.some((s) => s.w === 40), "小さい画像は触らない");
  // 見た目：グラデーションの色が保たれ、透明部分は白いまま
  const after = await renderPage(await openPdf(bytes), 1, 1);
  for (const [x, y] of [[60, 100], [240, 100], [150, 100]] as const) assert.ok(near(pixel(after, x, y), pixel(before, x, y)), `(${x},${y}) ${pixel(after, x, y)} vs ${pixel(before, x, y)}`);
  assert.deepEqual(pixel(after, 130, 300), [255, 255, 255], "透明だった部分");
  assert.ok(near(pixel(after, 70, 300), [0, 160, 0]), "不透明だった部分");
  assert.ok(near(pixel(after, 300, 300), [255, 204, 0]), "小さい画像");
});

test("圧縮：グレースケール化", async () => {
  const file = await makeBigImagePdf();
  const { doc, pages } = await loadSource(file);
  const settings = defaultSettings();
  settings.compress = { enabled: true, dpi: 72, quality: 0.6, grayscale: true };
  let stats: CompressStats | null = null;
  const bytes = await buildPdf(pages, new Map([[doc.id, doc]]), new Map(), { settings, onCompressStats: (s) => (stats = s) });
  // グレースケールにする指定のときは、小さくならない画像も（色を残さないように）置き換える
  assert.equal((stats as CompressStats | null)?.recompressed, 3, JSON.stringify(stats));
  const img = await renderPage(await openPdf(bytes), 1, 1);
  const p = pixel(img, 60, 100);
  assert.ok(Math.abs(p[0] - p[1]) < 8 && Math.abs(p[1] - p[2]) < 8, `灰色でない: ${p}`);
});

test("圧縮：重複して入っている同じデータを 1 つにまとめ、圧縮されていないデータを圧縮する（見た目は変わらない）", async () => {
  // 同じ画像のデータが 3 ページにそれぞれ入っていて、ページの内容は圧縮されていない文書
  const pdf = await PDFDocument.create();
  // なだらかな色の画像（JPEG にしても見た目がほとんど変わらないもの）
  const pixels = new Uint8Array(120 * 120 * 3);
  for (let y = 0; y < 120; y++) for (let x = 0; x < 120; x++) pixels.set([x * 2, y * 2, 128], (y * 120 + x) * 3);
  const text = Array.from({ length: 60 }, (_, i) => `BT /F1 10 Tf 40 ${800 - i * 12} Td (Line ${i} of the uncompressed page content) Tj ET`).join("\n");
  const font = pdf.embedStandardFont(StandardFonts.Helvetica);
  for (let n = 0; n < 3; n++) {
    const page = pdf.addPage([595, 842]);
    const img = pdf.context.register(pdf.context.stream(pixels, { Type: "XObject", Subtype: "Image", Width: 120, Height: 120, ColorSpace: "DeviceRGB", BitsPerComponent: 8 }));
    page.node.set(PDFName.of("Resources"), pdf.context.obj({ Font: { F1: font.ref }, XObject: { Im1: img } }));
    page.node.set(PDFName.of("Contents"), pdf.context.register(pdf.context.stream(`${text}\nq 120 0 0 120 400 40 cm /Im1 Do Q`)));
  }
  const file = join(tmpDir, "duplicates.pdf");
  writeFileSync(file, await pdf.save({ useObjectStreams: false }));
  const { doc, pages } = await loadSource(file);
  const src = new Map([[doc.id, doc]]);
  const plain = await buildPdf(pages, src, new Map(), {});
  const st = defaultSettings();
  st.compress.enabled = true;
  // 画像の再圧縮（JPEG 化）が起きない設定にして、画像以外の効果だけを見る
  st.compress.dpi = 600;
  const small = await buildPdf(pages, src, new Map(), { settings: st });
  assert.ok(small.length < plain.length * 0.6, `小さくなっていない: ${plain.length} → ${small.length}`);
  const a = await openPdf(plain);
  const b = await openPdf(small);
  assert.equal(b.numPages, 3);
  for (let p = 1; p <= 3; p++) {
    assert.equal(await pageText(b, p), await pageText(a, p));
    const x = await renderPage(a, p, 1);
    const y = await renderPage(b, p, 1);
    let d = 0;
    for (let i = 0; i < x.data.length; i += 4) if (Math.abs(x.data[i] - y.data[i]) > 24) d++;
    assert.ok(d < x.width * x.height * 0.002, `${p} ページ目の見た目が変わった: ${d}`);
  }
});

/* ---------- 見た目を変えない圧縮：フォント・付随データ ---------- */

/**
 * フォントを 1 字も削らずに埋め込んだ文書を作る（「Microsoft Print to PDF」などと同じ形：Type0・Identity-H・文字コード＝字形番号）。
 * ページの文字のほか、部品（Form XObject）の中にも別の字を書く。form = true なら、入力欄用のフォントとしても登録する
 */
async function makeFullFontPdf(name: string, form = false): Promise<string> {
  const { readFileSync } = await import("node:fs");
  const { glyphIdForCodePoint, parseTtf, advanceWidth, unitsPerEm } = await import("@/lib/ttfSubset");
  const data = new Uint8Array(readFileSync(join(fixtures, "..", "..", "assets", "fonts", "BIZUDPGothic-Regular.ttf")));
  const f = parseTtf(data);
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  const ctx = doc.context;
  const used = new Map<number, number>();
  const hex = (s: string) =>
    [...s]
      .map((ch) => {
        const gid = glyphIdForCodePoint(f, ch.codePointAt(0)!);
        used.set(gid, ch.codePointAt(0)!);
        return gid.toString(16).padStart(4, "0");
      })
      .join("");
  const inner = `BT /F1 18 Tf 1 0 0 1 40 120 Tm <${hex("部品の中の文字")}> Tj ET`;
  // 描画状態を保存（q）して別のフォントで書き、復元（Q）した後は、フォントを指定し直さずに元のフォントで書く
  // （Q でフォントも元に戻る。ここを見落とすと、復元後に書いた字が「使っていない字」として消える）
  const content = `BT /F1 24 Tf 1 0 0 1 40 220 Tm <${hex("圧縮のテスト ABC")}> Tj ET\nq BT /F2 10 Tf 1 0 0 1 40 60 Tm (other font) Tj ET Q\nBT 1 0 0 1 40 180 Tm <${hex("復元後に書く字")}> Tj ET\n/Fm1 Do`;
  const u4 = (n: number) => n.toString(16).padStart(4, "0");
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <ffff>\nendcodespacerange\n${used.size} beginbfchar\n${[...used].map(([g, cp]) => `<${u4(g)}> <${u4(cp)}>`).join("\n")}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
  const file = ctx.register(ctx.flateStream(data, { Length1: data.length }));
  const desc = ctx.register(ctx.obj({ Type: "FontDescriptor", FontName: "CIDFont+F1", Flags: 4, FontBBox: [-200, -300, 1200, 1000], ItalicAngle: 0, Ascent: 880, Descent: -120, CapHeight: 700, StemV: 80, FontFile2: file }));
  const upm = unitsPerEm(f);
  const W = [...used.keys()].flatMap((gid) => [gid, [Math.round((advanceWidth(f, gid) * 1000) / upm)]]);
  const cid = ctx.register(ctx.obj({ Type: "Font", Subtype: "CIDFontType2", BaseFont: "CIDFont+F1", CIDSystemInfo: { Registry: "Adobe", Ordering: "Identity", Supplement: 0 }, FontDescriptor: desc, DW: 1000, W, CIDToGIDMap: "Identity" }));
  const font = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type0", BaseFont: "CIDFont+F1", Encoding: "Identity-H", DescendantFonts: [cid], ToUnicode: ctx.register(ctx.flateStream(cmap)) }));
  const fm = ctx.register(ctx.flateStream(inner, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 400, 300], Resources: { Font: { F1: font } } }));
  const helv = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" }));
  page.node.set(PDFName.of("Resources"), ctx.obj({ Font: { F1: font, F2: helv }, XObject: { Fm1: fm } }));
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(content)));
  if (form) doc.catalog.set(PDFName.of("AcroForm"), ctx.obj({ Fields: [], DR: { Font: { F1: font } } }));
  const out = join(tmpDir, name);
  writeFileSync(out, await doc.save({ useObjectStreams: false }));
  return out;
}

/** 埋め込まれた TrueType フォント（FontFile2）の大きさの合計 */
async function fontBytes(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes);
  let n = 0;
  for (const [, o] of doc.context.enumerateIndirectObjects()) {
    if (!(o instanceof PDFDict)) continue;
    const ff = o.get(PDFName.of("FontFile2"));
    const s = ff instanceof PDFRef ? doc.context.lookup(ff) : null;
    if (s instanceof PDFStream) n += s.getContentsSize();
  }
  return n;
}

test("圧縮：丸ごと埋め込まれたフォントから、使っていない字を除く（見た目も、取り出せる文字も変わらない）", async () => {
  const { doc, pages } = await loadSource(await makeFullFontPdf("full-font.pdf"));
  const build = (compress: boolean) => {
    let stats: CompressStats | null = null;
    return buildPdf(pages, new Map([[doc.id, doc]]), new Map(), { settings: { ...defaultSettings(), compress: { enabled: compress, dpi: 150, quality: 0.8, grayscale: false, keepImages: true } }, onCompressStats: (s) => (stats = s) }).then((bytes) => ({ bytes, stats: stats as CompressStats | null }));
  };
  const plain = await build(false);
  const small = await build(true);
  assert.equal(small.stats?.fonts, 1);
  const before = await fontBytes(plain.bytes);
  const after = await fontBytes(small.bytes);
  assert.ok(before > 2_000_000 && after < before * 0.1, `フォントが小さくなっていない: ${before} → ${after}`);
  assert.ok(small.bytes.length < plain.bytes.length * 0.15);
  // 文字はそのまま取り出せる（ページの文字も、部品の中の文字も）
  const text = await pageText(await openPdf(small.bytes), 1);
  for (const w of ["圧縮のテスト", "ABC", "部品の中の文字", "復元後に書く字"]) assert.ok(text.includes(w), `${w} が取り出せない: ${text}`);
  // 見た目は変わらない
  const a = await renderPage(await openPdf(plain.bytes), 1, 2);
  const b = await renderPage(await openPdf(small.bytes), 1, 2);
  let diff = 0;
  let ink = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] < 128) ink++;
    if (Math.abs(a.data[i] - b.data[i]) > 24) diff++;
  }
  assert.ok(ink > 2000, "文字が描かれていない");
  assert.equal(diff, 0);
});

test("圧縮：入力欄（フォーム）が使うフォントは、あとから入力される字のために丸ごと残す", async () => {
  const { doc, pages } = await loadSource(await makeFullFontPdf("full-font-form.pdf", true));
  // 入力欄の定義（/AcroForm）は、ページを写した先の文書には付いて来ないことがある。フォントの処理そのものを確かめる
  const { shrinkFonts } = await import("@/lib/fontShrink");
  const lib = await PDFDocument.load(doc.bytes);
  assert.deepEqual(shrinkFonts(lib), { fonts: 0, saved: 0 });
  const free = await PDFDocument.load((await loadSource(join(tmpDir, "full-font.pdf"))).doc.bytes);
  assert.equal(shrinkFonts(free).fonts, 1);
  assert.ok(pages.length === 1);
});

test("圧縮：表示に使われない付随データ（個別のメタデータ・ほかのソフトの編集用データ・縮小画像）を外す", async () => {
  const src = await PDFDocument.load((await loadSource(await makeBigImagePdf("aux.pdf"))).doc.bytes);
  const ctx = src.context;
  const junk = () => ctx.register(ctx.stream(new Uint8Array(40_000).map((_, i) => (i * 7919) % 251)));
  const page = src.getPage(0);
  page.node.set(PDFName.of("PieceInfo"), ctx.obj({ Illustrator: { Private: junk() } }));
  page.node.set(PDFName.of("Thumb"), junk());
  for (const [, o] of ctx.enumerateIndirectObjects()) if (o instanceof PDFStream && o.dict.get(PDFName.of("Subtype"))?.toString() === "/Image") o.dict.set(PDFName.of("Metadata"), junk());
  const file = join(tmpDir, "aux-data.pdf");
  writeFileSync(file, await src.save({ useObjectStreams: false }));
  const { doc, pages } = await loadSource(file);
  const build = (enabled: boolean) => buildPdf(pages, new Map([[doc.id, doc]]), new Map(), { settings: { ...defaultSettings(), compress: { enabled, dpi: 150, quality: 0.8, grayscale: false, keepImages: true } } });
  const plain = await build(false);
  const small = await build(true);
  assert.ok(plain.length - small.length > 150_000, `付随データが残っている: ${plain.length} → ${small.length}`);
  const out = await PDFDocument.load(small);
  for (const [, o] of out.context.enumerateIndirectObjects()) {
    const d = o instanceof PDFStream ? o.dict : o instanceof PDFDict ? o : null;
    if (!d) continue;
    assert.ok(!d.has(PDFName.of("PieceInfo")) && !d.has(PDFName.of("Thumb")));
    if (d !== out.catalog) assert.ok(!d.has(PDFName.of("Metadata")));
  }
  // 画像はそのまま（見た目は変わらない）
  const a = await renderPage(await openPdf(plain), 1, 1);
  const b = await renderPage(await openPdf(small), 1, 1);
  assert.deepEqual(pixel(a, 150, 100), pixel(b, 150, 100));
});

test("圧縮：部品（Form XObject）の中の画像も、表示サイズに合わせて縮小する", async () => {
  const napi = await import("@napi-rs/canvas");
  const big = napi.createCanvas(1600, 1200);
  const g = big.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 1600, 1200);
  grad.addColorStop(0, "#00a0ff");
  grad.addColorStop(1, "#ff8000");
  g.fillStyle = grad;
  g.fillRect(0, 0, 1600, 1200);
  const src = await PDFDocument.create();
  const page = src.addPage([400, 400]);
  const img = await src.embedJpg(await big.encode("jpeg", 90));
  const ctx = src.context;
  // 部品の中で、画像を 200×150pt に描く。ページのリソースには、同じ名前の画像を置かない
  const fm = ctx.register(ctx.flateStream("q 200 0 0 150 0 0 cm /Im1 Do Q", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 200, 150], Resources: { XObject: { Im1: img.ref } } }));
  page.node.set(PDFName.of("Resources"), ctx.obj({ XObject: { Fm1: fm } }));
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream("q 1 0 0 1 100 120 cm /Fm1 Do Q")));
  const file = join(tmpDir, "image-in-form.pdf");
  writeFileSync(file, await src.save({ useObjectStreams: false }));
  const { doc, pages } = await loadSource(file);
  let stats: CompressStats | null = null;
  const bytes = await buildPdf(pages, new Map([[doc.id, doc]]), new Map(), { settings: { ...defaultSettings(), compress: { enabled: true, dpi: 150, quality: 0.8, grayscale: false } }, onCompressStats: (s) => (stats = s) });
  assert.equal((stats as CompressStats | null)?.recompressed, 1);
  // 文書の中の画像（部品の中にあるので、ページのリソースからは見えない）
  const out = await PDFDocument.load(bytes);
  const widths: number[] = [];
  for (const [, o] of out.context.enumerateIndirectObjects()) if (o instanceof PDFStream && o.dict.get(PDFName.of("Subtype"))?.toString() === "/Image") widths.push((o.dict.lookup(PDFName.of("Width")) as PDFNumber).asNumber());
  assert.equal(widths.length, 1);
  // 200pt × 150dpi ÷ 72 ≒ 417 画素
  assert.ok(widths[0] >= 410 && widths[0] <= 425, `縮小されていない: ${widths[0]}`);
});

test("圧縮：必要な解像度以下でも、品質の高い JPEG は指定の品質で圧縮し直す（品質の見積もり）", async () => {
  const { jpegQuality } = await import("@/lib/compress");
  const napi = await import("@napi-rs/canvas");
  const c = napi.createCanvas(300, 300);
  const g = c.getContext("2d");
  // 写真のように細かい変化のある画像
  for (let y = 0; y < 300; y += 4) for (let x = 0; x < 300; x += 4) {
    g.fillStyle = `rgb(${(x * 7 + y * 3) % 256}, ${(x * 2 + y * 5) % 256}, ${(x * y) % 256})`;
    g.fillRect(x, y, 4, 4);
  }
  const hi = new Uint8Array(await c.encode("jpeg", 95));
  const lo = new Uint8Array(await c.encode("jpeg", 60));
  assert.ok(Math.abs(jpegQuality(hi) - 95) <= 4, `品質の見積もり: ${jpegQuality(hi)}`);
  assert.ok(Math.abs(jpegQuality(lo) - 60) <= 6, `品質の見積もり: ${jpegQuality(lo)}`);
  assert.equal(jpegQuality(new Uint8Array([1, 2, 3])), 0);
  const make = async (jpeg: Uint8Array, name: string) => {
    const d = await PDFDocument.create();
    const p = d.addPage([400, 400]);
    // 300 画素を 144pt に：ちょうど 150dpi（縮小は要らない）
    p.drawImage(await d.embedJpg(jpeg), { x: 50, y: 50, width: 144, height: 144 });
    const file = join(tmpDir, name);
    writeFileSync(file, await d.save({ useObjectStreams: false }));
    return loadSource(file);
  };
  const run = async (jpeg: Uint8Array, name: string) => {
    const { doc, pages } = await make(jpeg, name);
    let stats: CompressStats | null = null;
    const bytes = await buildPdf(pages, new Map([[doc.id, doc]]), new Map(), { settings: { ...defaultSettings(), compress: { enabled: true, dpi: 150, quality: 0.7, grayscale: false } }, onCompressStats: (s) => (stats = s) });
    return { stats: stats as CompressStats | null, sizes: await imageSizes(bytes) };
  };
  const a = await run(hi, "jpeg-hi.pdf");
  assert.equal(a.stats?.recompressed, 1, "品質の高い JPEG が圧縮し直されていない");
  assert.equal(a.sizes[0].w, 300);
  const b = await run(lo, "jpeg-lo.pdf");
  assert.equal(b.stats?.recompressed, 0, "すでに十分圧縮されている JPEG を圧縮し直している");
});

/** 白黒の画素（1 = 黒）をファクス方式で入れた 1 ページの PDF */
async function g4Pdf(pixels: Uint8Array, w: number, h: number): Promise<Uint8Array> {
  const { encodeG4 } = await import("@/lib/ccitt");
  const { PDFRawStream } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const page = doc.addPage([w, h]);
  const dict = doc.context.obj({ Type: "XObject", Subtype: "Image", Width: w, Height: h, ColorSpace: "DeviceGray", BitsPerComponent: 1, Filter: "CCITTFaxDecode", DecodeParms: { K: -1, Columns: w, Rows: h } });
  const ref = doc.context.register(PDFRawStream.of(dict, encodeG4(pixels, w, h)));
  page.node.set(PDFName.of("Resources"), doc.context.obj({ XObject: { Im0: ref } }));
  const content = doc.context.flateStream(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`);
  page.node.set(PDFName.of("Contents"), doc.context.register(content));
  return doc.save({ useObjectStreams: false });
}

test("ファクス方式（G4）の符号化：別の実装（pdf.js）で読んで、元の画素と完全に一致する", async () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const cases: { name: string; w: number; h: number; at: (x: number, y: number) => number }[] = [
    { name: "白紙", w: 200, h: 20, at: () => 0 },
    { name: "真っ黒", w: 200, h: 20, at: () => 1 },
    { name: "雑音", w: 301, h: 60, at: () => (rnd() < 0.5 ? 1 : 0) },
    { name: "まばらな点", w: 640, h: 80, at: () => (rnd() < 0.02 ? 1 : 0) },
    { name: "市松", w: 97, h: 33, at: (x, y) => (x + y) & 1 },
    { name: "縦線と斜線", w: 500, h: 120, at: (x, y) => (x % 37 < 3 || (x + y * 2) % 53 < 5 ? 1 : 0) },
    { name: "幅 1", w: 1, h: 40, at: (_x, y) => (y % 3 === 0 ? 1 : 0) },
    // 64 を超える長さ（つなぎの符号）と、2560 を超える長さ
    { name: "長い連続", w: 5400, h: 12, at: (x, y) => (y % 4 === 0 ? 0 : y % 4 === 1 ? 1 : y % 4 === 2 ? (x > 2700 ? 1 : 0) : x % 1800 < 900 + y * 7 ? 1 : 0) },
    { name: "いろいろな長さ", w: 2100, h: 64, at: (x, y) => (Math.floor(x / (y * 33 + 1)) & 1) ^ (y & 1) },
  ];
  // 文字のある画像（実際の用途に近い）
  const napi = await import("@napi-rs/canvas");
  const c = napi.createCanvas(900, 300);
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, 900, 300);
  g.fillStyle = "#000";
  napi.GlobalFonts.registerFromPath(join(fixtures, "..", "..", "assets", "fonts", "NotoSerif.ttf"), "TestSerif");
  g.font = "28px TestSerif";
  for (let i = 0; i < 8; i++) g.fillText("The quick brown fox jumps over the lazy dog 0123456789", 10 + i * 3, 34 + i * 34);
  const tp = g.getImageData(0, 0, 900, 300).data;
  cases.push({ name: "文字", w: 900, h: 300, at: (x, y) => (tp[(y * 900 + x) * 4] < 128 ? 1 : 0) });
  for (const k of cases) {
    const px = new Uint8Array(k.w * k.h);
    for (let y = 0; y < k.h; y++) for (let x = 0; x < k.w; x++) px[y * k.w + x] = k.at(x, y);
    const pdf = await openPdf(await g4Pdf(px, k.w, k.h));
    const r = await renderPage(pdf, 1, 1);
    assert.equal(r.width, k.w, k.name);
    // pdf.js は、最後の行が黒で終わるとき、その行の最後の 1 バイト分（8 画素まで）を白にすることがある
    // （基準の実装 libtiff が作ったデータでも同じ。下の poppler では完全に一致する）。そこだけは比べない
    const upTo = px.length - (((k.w - 1) & 7) + 1);
    let bad = 0;
    const where: string[] = [];
    for (let i = 0; i < upTo; i++)
      if ((r.data[i * 4] < 128 ? 1 : 0) !== px[i]) {
        bad++;
        if (where.length < 12) where.push(`${i % k.w},${Math.floor(i / k.w)}`);
      }
    assert.equal(bad, 0, `${k.name}: ${bad} 画素が違う（${where.join(" ")}）`);
    await closePdf(pdf);
    // もう 1 つ別の実装（poppler の pdfimages）があれば、それでも確かめる
    const { spawnSync } = await import("node:child_process");
    const f = join(tmpDir, "g4-case.pdf");
    writeFileSync(f, await g4Pdf(px, k.w, k.h));
    const run = spawnSync("pdfimages", ["-png", f, join(tmpDir, "g4-case")]);
    if (!run.error && run.status === 0) {
      const im = await napi.loadImage(join(tmpDir, "g4-case-000.png"));
      const cc = napi.createCanvas(k.w, k.h);
      cc.getContext("2d").drawImage(im, 0, 0);
      const d = cc.getContext("2d").getImageData(0, 0, k.w, k.h).data;
      let bad2 = 0;
      for (let i = 0; i < px.length; i++) if ((d[i * 4] < 128 ? 1 : 0) !== px[i]) bad2++;
      assert.equal(bad2, 0, `${k.name}（poppler）: ${bad2} 画素が違う`);
    }
  }
});

test("圧縮：白黒 2 値化。スキャンした書類の画像を 1 ビットの白黒にして大きく減らし、文字は読める形で残る", async () => {
  const napi = await import("@napi-rs/canvas");
  // A5 相当の紙を 300dpi でカラースキャンしたような画像（紙の色むら・薄い雑音つき）
  const W = 1748;
  const H = 2480;
  const c = napi.createCanvas(W, H);
  const g = c.getContext("2d");
  g.fillStyle = "#f4f1e8";
  g.fillRect(0, 0, W, H);
  g.fillStyle = "#1c1c22";
  // 環境にフォントが無くても同じ絵になるよう、同梱のフォントを使う
  napi.GlobalFonts.registerFromPath(join(fixtures, "..", "..", "assets", "fonts", "NotoSerif.ttf"), "TestSerif");
  g.font = "44px TestSerif";
  // 行ごとに違う文（同じ行の繰り返しだと、汎用の圧縮が不自然に有利になる）
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  for (let i = 0; i < 45; i++) {
    let line = "";
    while (line.length < 52) line += `${Array.from({ length: 2 + (next() % 8) }, () => String.fromCharCode(97 + (next() >> 8) % 26)).join("")} `;
    g.fillText(line, 120, 160 + i * 50);
  }
  const id = g.getImageData(0, 0, W, H);
  for (let i = 0; i < id.data.length; i += 4) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const n = (seed % 13) - 6;
    id.data[i] = Math.max(0, Math.min(255, id.data[i] + n));
    id.data[i + 1] = Math.max(0, Math.min(255, id.data[i + 1] + n));
    id.data[i + 2] = Math.max(0, Math.min(255, id.data[i + 2] - n));
  }
  g.putImageData(id, 0, 0);
  const doc = await PDFDocument.create();
  const page = doc.addPage([419.5, 595.2]);
  page.drawImage(await doc.embedJpg(await c.encode("jpeg", 85)), { x: 0, y: 0, width: 419.5, height: 595.2 });
  const file = join(tmpDir, "scan-colour.pdf");
  writeFileSync(file, await doc.save({ useObjectStreams: false }));

  const { doc: src, pages, bytes } = await loadSource(file);
  const build = (compress: Record<string, unknown>) => buildPdf(pages, new Map([[src.id, src]]), new Map(), { settings: { ...defaultSettings(), compress: { enabled: true, dpi: 150, quality: 0.8, grayscale: false, ...compress } } });
  const jpeg = await build({});
  const out = await build({ bilevel: true });
  const [im] = await imageSizes(out);
  assert.equal(im.filter, "CCITTFaxDecode");
  assert.equal(im.w, W, "300dpi までは解像度を保つ（JPEG 用の 150dpi の指定に引きずられない）");
  assert.ok(out.length < bytes.length * 0.15, `元の 15% 未満になる（${bytes.length} → ${out.length}）`);
  assert.ok(out.length < jpeg.length * 0.6, `150dpi の JPEG より小さい（${jpeg.length} → ${out.length}）`);
  // 見た目：紙は白、文字は黒。元を同じしきい値で白黒にしたものとほぼ一致する
  const a = await renderPage(await openPdf(bytes), 1, 2);
  const b = await renderPage(await openPdf(out), 1, 2);
  let ink = 0;
  let differ = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const x = a.data[i] < 128 ? 1 : 0;
    const y = b.data[i] < 128 ? 1 : 0;
    ink += x;
    if (x !== y) differ++;
  }
  assert.ok(ink > 20000, "元に文字がある");
  assert.ok(differ < ink * 0.25, `文字の形が保たれている（違い ${differ} / 文字の画素 ${ink}）`);
  await closePdf(src.pdf);
});

test("圧縮：白黒 2 値化のしきい値は、白と黒の山の間に入る", async () => {
  const { otsuThreshold } = await import("@/lib/compress");
  const hist = new Array(256).fill(0);
  hist[20] = 100;
  hist[240] = 900;
  const t = otsuThreshold(hist);
  assert.ok(t >= 20 && t < 240, String(t));
  assert.ok(t > 60 && t < 200, `真ん中あたり（${t}）`);
});

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { decodePDFRawStream, PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { createTextEdit } from "@/lib/editModel";
import { buildPdf } from "@/lib/exportPdf";
import { getPageImages } from "@/lib/pageImages";
import { removedTextIsGone } from "@/lib/redactCheck";
import { getPageText } from "@/lib/textRuns";
import type { ImageEditObj, PageItem, RedactObj } from "@/lib/types";
import { fixtures, loadSource, openPdf, pageText, renderPage } from "./helpers";

/** 保存したファイルの中の全オブジェクトを調べる（ページからたどれないものも含む） */
async function scan(bytes: Uint8Array) {
  const d = await PDFDocument.load(bytes, { updateMetadata: false });
  const images: string[] = [];
  const contents: string[] = [];
  for (const [, obj] of d.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    if (String(obj.dict.get(PDFName.of("Subtype"))) === "/Image") {
      images.push(`${obj.dict.get(PDFName.of("Width"))}x${obj.dict.get(PDFName.of("Height"))}`);
      continue;
    }
    try {
      contents.push(Buffer.from(decodePDFRawStream(obj).decode()).toString("latin1"));
    } catch {
      /* 復号できないストリームは対象外 */
    }
  }
  return { images: images.sort(), contents };
}
const pixel = (img: { data: Uint8ClampedArray; width: number }, x: number, y: number) => {
  const i = (Math.round(y) * img.width + Math.round(x)) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};
const near = (a: number[], b: number[], tol = 40) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const imagesPdf = join(fixtures, "images.pdf");

test("消したものはファイルに残らない：墨消しした文字の入った元の内容ストリーム", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "en-standard14.pdf"));
  const { runs } = await getPageText(doc, pages[0]);
  const run = runs[0];
  const needle = run.text.slice(0, 8);
  assert.ok((await scan(doc.bytes)).contents.some((c) => c.includes(needle)), "前提：元のファイルには文字がそのまま入っている");
  const r: RedactObj = { id: "r", type: "redact", x: run.x - 1, y: run.top - 1, w: run.w + 2, h: run.h + 2, fill: "#000000" };
  const out = await scan(await buildPdf([{ ...pages[0], objects: [r] }], new Map([[doc.id, doc]]), new Map()));
  assert.equal(out.contents.filter((c) => c.includes(needle)).length, 0, "保存したファイルのどのストリームにも、消した文字が残っていない");
});

test("消したものはファイルに残らない：書き換えた行の元の文字", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "en-standard14.pdf"));
  const { runs } = await getPageText(doc, pages[0]);
  const run = runs.find((r) => r.editable)!;
  const needle = run.text.slice(0, 8);
  const o = createTextEdit([run], { cover: "#ffffff", fallbackColor: "#000000" });
  o.text = "Replaced";
  const out = await scan(await buildPdf([{ ...pages[0], objects: [o] }], new Map([[doc.id, doc]]), new Map()));
  assert.equal(out.contents.filter((c) => c.includes(needle)).length, 0, "書き換える前の文字が、保存したファイルに残っていない");
});

test("消したものはファイルに残らない：墨消し・削除した画像", async () => {
  const { doc, pages } = await loadSource(imagesPdf);
  assert.deepEqual((await scan(doc.bytes)).images, ["50x50", "80x60"]);
  // 赤い画像（80x60。x 50..170, top 30..120）を完全に覆う墨消し
  const r: RedactObj = { id: "r", type: "redact", x: 40, y: 20, w: 140, h: 110, fill: "#000000" };
  assert.deepEqual((await scan(await buildPdf([{ ...pages[0], objects: [r] }], new Map([[doc.id, doc]]), new Map()))).images, ["50x50"]);
  // 既存画像の削除でも同じ
  const red = (await getPageImages(doc, pages[0])).find((i) => i.pixelW === 80)!;
  const del: ImageEditObj = { id: "d", type: "imageedit", x: red.x, y: red.top, w: red.w, h: red.h, opIndex: red.opIndex, path: red.path, name: red.name };
  assert.deepEqual((await scan(await buildPdf([{ ...pages[0], objects: [del] }], new Map([[doc.id, doc]]), new Map()))).images, ["50x50"]);
});

test("消したものはファイルに残らない：リンクの飛び先になっているページ（隠れた写しができない）", async () => {
  // 1 ページ目に、2 ページ目へ飛ぶリンク。2 ページ目の文字を墨消しする
  const made = await PDFDocument.create();
  const font = await made.embedFont("Helvetica");
  const p1 = made.addPage([300, 200]);
  const p2 = made.addPage([300, 200]);
  p1.drawText("Index page", { x: 30, y: 150, size: 14, font });
  p2.drawText("TOPSECRET value", { x: 30, y: 150, size: 14, font });
  const link = made.context.obj({ Type: "Annot", Subtype: "Link", Rect: [30, 140, 150, 170], Border: [0, 0, 0], Dest: [p2.ref, "Fit"], P: p1.ref });
  p1.node.set(PDFName.of("Annots"), made.context.obj([made.context.register(link)]));
  const file = join(fixtures, "..", "..", "dist", ".test", "linked.pdf");
  (await import("node:fs")).writeFileSync(file, await made.save({ useObjectStreams: false }));
  const { doc, pages } = await loadSource(file);
  const { runs } = await getPageText(doc, pages[1]);
  const run = runs.find((r) => r.text.includes("TOPSECRET"))!;
  const r: RedactObj = { id: "r", type: "redact", x: run.x - 1, y: run.top - 1, w: run.w + 2, h: run.h + 2, fill: "#000000" };
  const bytes = await buildPdf([pages[0], { ...pages[1], objects: [r] }], new Map([[doc.id, doc]]), new Map());
  const out = await scan(bytes);
  assert.equal(out.contents.filter((c) => c.includes("TOPSECRET")).length, 0, "墨消しした文字が、リンクの飛び先の写しに残っていない");
  // リンクの飛び先は、出力の 2 ページ目そのものを指す
  const lib = await PDFDocument.load(bytes, { updateMetadata: false });
  const annots = lib.getPage(0).node.Annots()!;
  const dest = (lib.context.lookup(annots.get(0)) as import("pdf-lib").PDFDict).lookup(PDFName.of("Dest")) as import("pdf-lib").PDFArray;
  assert.equal(String(dest.get(0)), String(lib.getPage(1).ref), "リンクの飛び先が本物のページを指している");
  // 1 ページ目だけを取り出したときは、飛び先のページは出力に含めない（写しも残らない）
  const only = await scan(await buildPdf([pages[0]], new Map([[doc.id, doc]]), new Map()));
  assert.equal(only.contents.filter((c) => c.includes("TOPSECRET")).length, 0, "取り出さなかったページの内容が、リンク経由でファイルに入っていない");
});

test("同じ画像を別のページが使っているなら、そのページの分は残す", async () => {
  const { doc, pages } = await loadSource(imagesPdf);
  const r: RedactObj = { id: "r", type: "redact", x: 40, y: 20, w: 140, h: 110, fill: "#000000" };
  const second: PageItem = { ...pages[0], id: "copy", objects: [] };
  const bytes = await buildPdf([{ ...pages[0], objects: [r] }, second], new Map([[doc.id, doc]]), new Map());
  const pdf = await openPdf(bytes);
  assert.ok(near(pixel(await renderPage(pdf, 1, 1), 60, 40), [0, 0, 0]), "1 ページ目は黒く塗られている");
  assert.ok(near(pixel(await renderPage(pdf, 2, 1), 60, 40), [255, 0, 0]), "2 ページ目の赤い画像は残っている");
});

test("墨消し：一部だけ掛かる画像は、その範囲の画素だけが塗りつぶされ、元の画像はファイルに残らない", async () => {
  const { doc, pages } = await loadSource(imagesPdf);
  for (const [name, r, keep, gone] of [
    // 赤い画像（JPEG。x 50..170, top 30..120）の右下
    ["JPEG", { x: 150, y: 100, w: 60, h: 40 }, [60, 40, 255, 0, 0], [162, 112]],
    // 青い画像（PNG）の左上を少しだけ
    ["PNG", { x: 245, y: 165, w: 20, h: 18 }, [280, 195, 0, 0, 255], [258, 176]],
  ] as const) {
    const red: RedactObj = { id: "r", type: "redact", ...r, fill: "#000000" };
    const warnings: string[] = [];
    const bytes = await buildPdf([{ ...pages[0], objects: [red] }], new Map([[doc.id, doc]]), new Map(), { onWarning: (m) => warnings.push(m) });
    const s = await scan(bytes);
    assert.deepEqual(s.images, ["50x50", "80x60"], `${name}: 画像は 2 枚のまま（塗りつぶした複製に入れ替わり、元の画像は残らない）`);
    const pdf = await openPdf(bytes);
    assert.ok((await pageText(pdf, 1)).includes("Hello Images"));
    // 上に重ねる黒い四角を除いても消えていることを確かめるため、画像そのものの画素を調べる
    const lib = await PDFDocument.load(bytes, { updateMetadata: false });
    const page = lib.getPage(0);
    const xo = page.node.Resources()!.lookup(PDFName.of("XObject")) as import("pdf-lib").PDFDict;
    assert.ok([...xo.keys()].some((k) => k.decodeText().startsWith("WashiRedacted")), `${name}: 塗りつぶした複製が使われている`);
    const img = await renderPage(pdf, 1, 1);
    assert.ok(near(pixel(img, keep[0], keep[1]), [keep[2], keep[3], keep[4]]), `${name}: 範囲の外の画素は元のまま ${pixel(img, keep[0], keep[1])}`);
    assert.ok(near(pixel(img, gone[0], gone[1]), [0, 0, 0]), `${name}: 範囲の中は黒`);
    assert.equal(warnings.length, 0, warnings.join("\n"));
  }
});

test("墨消し：塗りつぶした画像の画素そのものが黒くなっている（上に重ねた四角に頼らない）", async () => {
  const { doc, pages } = await loadSource(imagesPdf);
  const red: RedactObj = { id: "r", type: "redact", x: 245, y: 165, w: 20, h: 18, fill: "#000000" };
  const lib = await PDFDocument.load(await buildPdf([{ ...pages[0], objects: [red] }], new Map([[doc.id, doc]]), new Map()), { updateMetadata: false });
  const xo = lib.getPage(0).node.Resources()!.lookup(PDFName.of("XObject")) as import("pdf-lib").PDFDict;
  const key = [...xo.keys()].find((k) => k.decodeText().startsWith("WashiRedacted"))!;
  const st = xo.lookup(key) as PDFRawStream;
  const data = decodePDFRawStream(st).decode();
  const w = Number(String(st.dict.get(PDFName.of("Width"))));
  const comps = String(st.dict.get(PDFName.of("ColorSpace"))) === "/DeviceGray" ? 1 : 3;
  let black = 0;
  let blue = 0;
  for (let i = 0; i < data.length; i += comps) {
    if (comps === 3 && data[i] < 20 && data[i + 1] < 20 && data[i + 2] < 20) black++;
    if (comps === 3 && data[i] < 40 && data[i + 1] < 40 && data[i + 2] > 200) blue++;
  }
  assert.ok(black > 0 && blue > 0, `黒 ${black} 画素・青 ${blue} 画素（幅 ${w}）`);
  assert.ok(black < blue, "塗ったのは一部だけ");
});

test("保存後の検証：消した語がその回数だけ減っていれば確認済みになる", () => {
  assert.equal(removedTextIsGone("会場は第1会議室です。第1会議室は3階。", "会場は です。第1会議室は3階。", ["第1会議室"]), true);
  assert.equal(removedTextIsGone("会場は第1会議室です。第1会議室は3階。", "会場は第1会議室です。第1会議室は3階。", ["第1会議室"]), false);
  assert.equal(removedTextIsGone("abc ODBC def ODBC", "abc def", ["ODBC", "ODBC"]), true);
  assert.equal(removedTextIsGone("abc ODBC def ODBC", "abc def ODBC", ["ODBC", "ODBC"]), false);
  // 字形を残した所は空白になって渡される
  assert.equal(removedTextIsGone("株式会社サンプル商事", "株式会社 商事", ["    サンプル  "]), true);
  // 文字を取り除いていない墨消し（画像・図形だけ）は、文字については確かめることが無い
  assert.equal(removedTextIsGone("abc", "abc", []), true);
});

test("スキャン文書：ページ全体の画像の一部だけを墨消しでき、形式が違っても（ファクス形式・JPEG 2000・JPEG）残りは残る", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "scan.pdf"));
  assert.equal(pages.length, 3);
  const src = await openPdf(doc.bytes);
  for (const [i, name] of [[0, "ファクス形式（CCITT）"], [1, "JPEG 2000"], [2, "JPEG・回転したページ"]] as const) {
    const page = pages[i];
    // 画像の画素 (px, py) が、表示座標でどこに出るか（1・2 ページ目はそのまま、3 ページ目は 90 度回転）
    const sx = 595.28 / 620;
    const sy = 841.89 / 877;
    const at = (px: number, py: number): [number, number] => (i === 2 ? [841.89 - py * sy, px * sx] : [px * sx, py * sy]);
    // 左の黒い帯（画素 100..300 × 400..450）を覆う範囲。右の帯（340..540）は残す
    const [ax, ay] = at(90, 390);
    const [bx, by] = at(310, 460);
    const r: RedactObj = { id: "r", type: "redact", x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay), fill: "#ffffff" };
    const warnings: string[] = [];
    const bytes = await buildPdf([{ ...page, objects: [r] }], new Map([[doc.id, doc]]), new Map(), { onWarning: (m) => warnings.push(m) });
    assert.equal(warnings.length, 0, `${name}: ${warnings.join(" / ")}`);
    const s = await scan(bytes);
    assert.equal(s.images.length, 1, `${name}: 画像は 1 枚（元の画像は残らない）`);
    const img = await renderPage(await openPdf(bytes), 1, 1);
    const before = await renderPage(src, i + 1, 1);
    const dark = (im: typeof img, p: [number, number]) => pixel(im, p[0], p[1])[0] < 90;
    assert.ok(dark(before, at(200, 425)) && dark(before, at(440, 425)), `${name}: 前提（元は両方の帯が黒い）`);
    // 白で塗ったので、左の帯は消えて白くなり、右の帯・上下の線は元のまま
    assert.ok(!dark(img, at(200, 425)), `${name}: 消したい帯が消えている ${pixel(img, ...at(200, 425))}`);
    assert.ok(dark(img, at(440, 425)), `${name}: 残したい帯は残っている ${pixel(img, ...at(440, 425))}`);
    assert.ok(dark(img, at(300, 64)) && dark(img, at(300, 564)), `${name}: 上下の線は残っている`);
    // 白黒 2 値・グレーのまま書き直すので、ファイルは極端に大きくならない
    assert.ok(bytes.length < 400_000, `${name}: ${bytes.length} bytes`);
  }
});

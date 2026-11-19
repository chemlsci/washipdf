import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { decodePDFRawStream, PDFArray, PDFDocument, PDFRawStream } from "pdf-lib";
import { defaultSettings } from "@/lib/docOps";
import { buildPdf } from "@/lib/exportPdf";
import { fontRuns, measureBundled } from "@/lib/fonts";
import { bidiRuns, prepareShapedEmbedding, shapedShowOps, shapeText } from "@/lib/shape";
import type { TextEditObj, TextObj } from "@/lib/types";
import { getPageText } from "@/lib/textRuns";
import { fixtures, loadSource, openPdf, pageText, renderPage, setupFonts } from "./helpers";

setupFonts();

test("双方向：アラビア語の段落では数字・欧文の走りが左に来る", () => {
  assert.deepEqual(bidiRuns("abc 123"), [{ text: "abc 123", dir: "ltr" }]);
  const r = bidiRuns("مرحبا 123 abc");
  assert.deepEqual(r.map((x) => x.dir), ["ltr", "rtl"]);
  assert.equal(r[0].text, "123 abc");
  assert.equal(r[1].text, "مرحبا ");
  // 左から右の段落に混じるアラビア語は、その走りだけ右から左
  const m = bidiRuns("Hello مرحبا world");
  assert.deepEqual(m.map((x) => [x.text, x.dir]), [
    ["Hello ", "ltr"],
    ["مرحبا", "rtl"],
    [" world", "ltr"],
  ]);
});

test("アラビア語：文脈で字形が変わり、表示順は左から右（数字は正順）", () => {
  const s = shapeText("arabic", "مرحبا 123");
  const cmapGids = new Set([..."مرحبا"].map((ch) => shapeText("arabic", ch).glyphs[0].gid));
  // 語中・語頭の形は単独形と違うグリフになる
  const letterGids = s.glyphs.filter((g) => g.cps.length && g.cps[0] >= 0x600).map((g) => g.gid);
  assert.ok(letterGids.some((g) => !cmapGids.has(g)), "文脈形が使われていない");
  // 左端は 1 2 3 の順
  const digits = s.glyphs.filter((g) => g.cps[0] >= 0x30 && g.cps[0] <= 0x39).map((g) => String.fromCodePoint(g.cps[0]));
  assert.deepEqual(digits, ["1", "2", "3"]);
  assert.ok(s.glyphs[0].cps[0] === 0x31, "数字が左端にない");
  assert.ok(s.width > 0);
  assert.ok(measureBundled("arabic", "مرحبا", 12) > 10);
});

test("タイ語・デーヴァナーガリー：結合記号の位置調整と合字", () => {
  const th = shapeText("thai", "ที่");
  // 上に付く記号は送り幅 0 で、位置がずれる
  assert.ok(th.glyphs.some((g) => g.adv === 0), "結合記号が無い");
  const dv = shapeText("devanagari", "क्ष");
  assert.equal(dv.glyphs.length, 1, "क्ष が 1 つの合字になっていない");
  assert.deepEqual(dv.glyphs[0].cps, [0x915, 0x94d, 0x937]);
  // i の母音記号は子音の前に動く
  const re = shapeText("devanagari", "कि");
  assert.equal(re.glyphs[0].cps[0], 0x93f);
  // TJ 命令はグリフ番号の hex と調整値で、Ts を使ったら 0 に戻す
  const ops = shapedShowOps("thai", "ที่", 12);
  assert.ok(/\[<[0-9a-f]+>/.test(ops), ops);
  if (ops.includes(" Ts")) assert.ok(ops.endsWith("0 Ts EMC"), ops);
});

test("埋め込み準備：整形後のグリフが含まれ、ToUnicode の対応がある。字形を共有する文字は複製で区別する", () => {
  const p = prepareShapedEmbedding("arabic", "مرحبا\nبكم");
  assert.ok(p.extraGids.size >= 5);
  const words = [...p.gidToUnicode.values()].join("");
  for (const ch of "مرحبابكم") assert.ok(words.includes(ch), `${ch} が ToUnicode に無い`);
  // ت と ي は同じ骨格の字形を使うので、片方は複製になる
  const q = prepareShapedEmbedding("arabic", "تقرير");
  assert.ok(q.clones.size >= 1, "複製が作られていない");
  const vals = [...q.gidToUnicode.values()];
  assert.ok(vals.includes("ت") && vals.includes("ي"));
  // 描画命令は ActualText を添える
  assert.ok(shapedShowOps("arabic", "تقرير", 12).startsWith("/Span << /ActualText <feff"));
});

test("書き出し：アラビア語・タイ語・ヒンディー語の文字オブジェクトが PDF から読み戻せる", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "en-standard14.pdf"));
  const mk = (id: string, font: string, text: string, y: number): TextObj => ({ id, type: "text", x: 40, y, w: 400, h: 30, text, font, fontSize: 18, color: "#000000", rotation: 0, align: "left" } as unknown as TextObj);
  const objs = [mk("a", "arabic", "مرحبا بكم 123", 300), mk("t", "thai", "สวัสดี ที่", 350), mk("d", "devanagari", "नमस्ते क्षत्रिय", 400), mk("b", "bengali", "বাংলা", 450)];
  const bytes = await buildPdf([{ ...pages[0], objects: objs }], new Map([[doc.id, doc]]), new Map(), { settings: defaultSettings() });
  // 整形したグリフ番号を直接書く経路（hex の TJ）で描かれている
  const lib = await PDFDocument.load(bytes);
  const contents = lib.getPage(0).node.Contents();
  const streams = (contents instanceof PDFArray ? contents.asArray() : [contents]).map((r) => lib.context.lookup(r)).filter((s): s is PDFRawStream => s instanceof PDFRawStream);
  const all = streams.map((s) => Buffer.from(decodePDFRawStream(s).decode()).toString("latin1")).join("\n");
  assert.ok(/\[<[0-9a-f]{4}/.test(all) && all.includes(" Ts"), "整形経路で書かれていない");
  const pdf = await openPdf(bytes);
  const text = await pageText(pdf, 1);
  // アラビア語は表示順（左から右）でグリフを書くため、抽出した文字列は論理順の逆になる（他の製作ソフトと同じ扱い）
  const rev = (s: string) => [...s].reverse().join("");
  // デーヴァナーガリーの i 母音記号は表示順（子音の前）で並ぶため、語全体ではなく部品で確認する
  for (const s of ["123", "สวัสดี", "ที่", "नमस्ते", "क्ष", "त्र", "य", "বাংলা"]) assert.ok(text.includes(s), `${s} が抽出できない: ${text}`);
  // pdf.js は双方向処理で論理順に戻すことがあるため、どちらでもよい
  for (const s of ["مرحبا", "بكم"]) assert.ok(text.includes(s) || text.includes(rev(s)), `${s} が抽出できない: ${text}`);
  assert.ok(!/[\ufe70-\ufeff\u013b]/.test(text), `表示形や化けた文字が混じっている: ${text}`);
  // 数字はアラビア語の左側（x が小さい）にある
  const items = (await (await pdf.getPage(1)).getTextContent()).items.filter((it) => "str" in it && it.str.trim());
  const arabic = items.find((it) => "str" in it && (it.str.includes("مرحبا") || it.str.includes(rev("مرحبا")))) as { transform: number[]; str: string } | undefined;
  assert.ok(arabic, JSON.stringify(items.map((it) => ("str" in it ? it.str : ""))));
  assert.ok(arabic.str.includes("123"), `数字が無い: ${arabic.str}`);
  const img = await renderPage(pdf, 1, 1);
  assert.ok(img.width > 0);
});

test("実編集：アラビア語への書き換えも整形して書ける", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "en-standard14.pdf"));
  const { runs } = await getPageText(doc, pages[0]);
  const run = runs.find((r) => r.text.includes("Quarterly Report"))!;
  const { createTextEdit } = await import("@/lib/editModel");
  const e = createTextEdit([run], { cover: "#ffffff", fallbackColor: "#000000", font: "arabic" }) as TextEditObj;
  e.text = "تقرير ربع سنوي 2026";
  const bytes = await buildPdf([{ ...pages[0], objects: [e] }], new Map([[doc.id, doc]]), new Map(), { settings: defaultSettings() });
  const text = await pageText(await openPdf(bytes), 1);
  assert.ok(!text.includes("Quarterly"), text);
  assert.ok((text.includes("تقرير") || text.includes([..."تقرير"].reverse().join(""))) && text.includes("2026"), text);
  assert.ok(text.includes("سنوي") || text.includes([..."سنوي"].reverse().join("")), `ن が別の文字になっている: ${text}`);
  assert.ok(text.includes("ربع") || text.includes([..."ربع"].reverse().join("")), text);
});

test("書き出し：1 つの文字オブジェクトに複数の文字が混ざっていても、字ごとに書けるフォントで書く（豆腐にならない）", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "en-standard14.pdf"));
  const mk = (id: string, font: string, text: string, y: number): TextObj => ({ id, type: "text", x: 40, y, w: 500, h: 30, text, font, fontSize: 18, color: "#000000", rotation: 0, align: "left" } as unknown as TextObj);
  // アラビア文字のフォントに日本語、日本語のフォントにタイ語・ヒンディー語・アラビア語
  const objs = [mk("a", "arabic", "مرحبا 日本語 2026", 300), mk("j", "gothic", "予約 สวัสดี नमस्ते مرحبا", 360)];
  assert.deepEqual(
    fontRuns("gothic" as never, objs[1].text).map((r) => r.key),
    ["gothic", "thai", "devanagari", "arabic"],
  );
  const bytes = await buildPdf([{ ...pages[0], objects: objs }], new Map([[doc.id, doc]]), new Map(), { settings: defaultSettings() });
  const pdf = await openPdf(bytes);
  const text = await pageText(pdf, 1);
  for (const s of ["日本語", "2026", "予約", "สวัสดี", "नमस्ते"]) assert.ok(text.includes(s), `${s} が抽出できない: ${text}`);
  const rev = (s: string) => [...s].reverse().join("");
  assert.ok(text.includes("مرحبا") || text.includes(rev("مرحبا")), text);
  // 字形の無い字（.notdef）を書いていない：どの区間も、その字を持つフォントで書かれている
  const items = (await (await pdf.getPage(1)).getTextContent()).items.filter((it) => "str" in it && /[؀-ۿ฀-๿ऀ-ॿ぀-鿿]/.test(it.str)) as { str: string; fontName: string; transform: number[]; width: number }[];
  assert.ok(new Set(items.map((it) => it.fontName)).size >= 4, `フォントが切り替わっていない: ${items.map((it) => `${it.fontName}:${it.str}`).join(" / ")}`);
  // アラビア語で始まる行は右から左：日本語の区間は、アラビア語の区間より左にある
  const ar = items.find((it) => /[؀-ۿ]/.test(it.str) && Math.abs(it.transform[5] - items.find((x) => x.str.includes("日本語"))!.transform[5]) < 2)!;
  const ja = items.find((it) => it.str.includes("日本語"))!;
  assert.ok(ja.transform[4] < ar.transform[4], `並びが逆: 日本語 x=${ja.transform[4]} アラビア語 x=${ar.transform[4]}`);
});

test("双方向：アラビア文字の数字（١٢٣）は桁を左から右に並べる。数字で始まる行でも、行の向きは文字で決める", () => {
  // 左から右の行の中：数字が先（左）、アラビア語が後（右）
  const ltr = bidiRuns("١٢٣ ريال", "L");
  assert.deepEqual(ltr.map((r) => r.dir), ["ltr", "rtl"]);
  assert.ok(ltr[0].text.startsWith("١٢٣"));
  // 向きの指定が無ければ、最初の文字（数字ではない）で決まる：右から左の行。数字は右端、桁の並びはそのまま
  const rtl = bidiRuns("2026 مرحبا");
  assert.deepEqual(rtl.map((r) => r.dir), ["rtl", "ltr"]);
  assert.ok(rtl[1].text.includes("2026"));
});

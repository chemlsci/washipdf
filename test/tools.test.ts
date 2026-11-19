import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { PDFDocument } from "pdf-lib";
import { defaultSettings, renderTemplate } from "@/lib/docOps";
import { buildPdf } from "@/lib/exportPdf";
import { interleave, interleaveHalves, reversePages } from "@/lib/pageOps";
import { pageSet, parsePageRanges } from "@/lib/pageRanges";
import { exportText } from "@/lib/textExport";
import type { PageItem } from "@/lib/types";
import { fixtures, loadSource, openPdf, pageText, renderPage } from "./helpers";

test("テンプレート：{n} {N} {p} {P} {file} {date} とゼロ埋め", () => {
  const v = { n: 7, N: 12, p: 9, P: 20, file: "contract", date: "2026-11-08" };
  assert.equal(renderTemplate("{n} / {N}", v), "7 / 12");
  assert.equal(renderTemplate("{file}-{n:6}", v), "contract-000007");
  assert.equal(renderTemplate("p{p}/{P} {date}", v), "p9/20 2026-11-08");
});

test("ページ範囲の解釈", () => {
  assert.deepEqual(parsePageRanges("1-3, 5, 8-", 10).groups, [[1, 2, 3], [5], [8, 9, 10]]);
  assert.equal(parsePageRanges("x", 10).badPart, "x");
  assert.equal(parsePageRanges("11", 10).outOfRange, "11");
  assert.deepEqual([...pageSet("", 3)], [0, 1, 2]);
  assert.deepEqual([...pageSet("2-", 3)], [1, 2]);
});

test("並べ替え：逆順・交互結合", () => {
  const mk = (id: string, src: string) => ({ id, srcId: src }) as PageItem;
  const pages = [mk("a1", "A"), mk("a2", "A"), mk("b1", "B"), mk("b2", "B")];
  assert.deepEqual(reversePages(pages).map((p) => p.id), ["b2", "b1", "a2", "a1"]);
  assert.deepEqual(interleave(pages, "A", "B", false).map((p) => p.id), ["a1", "b1", "a2", "b2"]);
  assert.deepEqual(interleave(pages, "A", "B", true).map((p) => p.id), ["a1", "b2", "a2", "b1"]);
  assert.deepEqual(interleaveHalves(pages, true).map((p) => p.id), ["a1", "b2", "a2", "b1"]);
});

test("ページ番号・ヘッダー・透かしが保存した PDF に入る", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "ja-subset-identity.pdf"));
  const settings = defaultSettings();
  settings.decor.numbering = { ...settings.decor.numbering, enabled: true, template: "{file}-{n:4}", start: 10 };
  settings.decor.header = { ...settings.decor.header, enabled: true, left: "{date}", center: "社外秘", right: "" };
  settings.decor.watermark = { ...settings.decor.watermark, enabled: true, text: "DRAFT" };
  const bytes = await buildPdf(pages, new Map([[doc.id, doc]]), new Map(), { settings, fileName: "estimate" });
  const pdf = await openPdf(bytes);
  const text = await pageText(pdf, 1);
  assert.ok(text.includes("estimate-0010"), text);
  assert.ok(text.includes("社外秘"), text);
  assert.ok(text.includes("DRAFT"), text);
  assert.ok(text.includes("株式会社サンプル商事"), "元の文字が消えている");
});

test("トリミングとサイズ変更が保存した PDF に反映される", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "ja-subset-identity.pdf"));
  const p = pages[0];
  const cropped: PageItem = { ...p, crop: { x: 50, y: 60, w: p.width - 100, h: p.height - 120 } };
  const scaled: PageItem = { ...p, id: "scaled", scaleTo: { width: p.width / 2, height: p.height / 2 } };
  const bytes = await buildPdf([cropped, scaled], new Map([[doc.id, doc]]), new Map());
  const lib = await PDFDocument.load(bytes);
  const c = lib.getPage(0).getCropBox();
  assert.ok(Math.abs(c.width - (p.width - 100)) < 0.5 && Math.abs(c.height - (p.height - 120)) < 0.5, JSON.stringify(c));
  const s = lib.getPage(1).getMediaBox();
  assert.ok(Math.abs(s.width - p.width / 2) < 0.5 && Math.abs(s.height - p.height / 2) < 0.5, JSON.stringify(s));
  // 縮小したページも描画でき、文字が残っている
  const pdf = await openPdf(bytes);
  const vp = (await pdf.getPage(2)).getViewport({ scale: 1 });
  assert.ok(Math.abs(vp.width - p.width / 2) < 1);
  assert.ok((await pageText(pdf, 2)).includes("株式会社サンプル商事"));
  await renderPage(pdf, 2, 1);
});

test("テキスト／Markdown の書き出し", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "ja-subset-identity.pdf"));
  const txt = await exportText(pages, new Map([[doc.id, doc]]), "txt");
  assert.ok(txt.includes("株式会社サンプル商事 御中\n"), txt.slice(0, 80));
  assert.ok(txt.includes("本書は自動テスト用に生成した架空の文書です。"));
  const md = await exportText(pages, new Map([[doc.id, doc]]), "md");
  assert.ok(md.startsWith("<!-- page 1 -->"));
});

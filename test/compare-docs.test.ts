// 文書比較：ページの対応づけ（追加・削除・移動）、語・文字単位の違い、改行の位置だけの違い、向き、スキャンした紙
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import fontkit from "@pdf-lib/fontkit";
import { degrees, PDFDocument, type PDFFont, rgb } from "pdf-lib";
import { itemsToLines, itemsToText, type CompareSide, compareDocs, entryChanged, type PageEntry, applyText } from "@/lib/compareDocs";
import { diffTokens, textHunks } from "@/lib/compare";
import { openPdf, root } from "./helpers";

const FONT = readFileSync(join(root, "assets/fonts/BIZUDPGothic-Regular.ttf"));

const SENT = [
  "作業の前に、保護具を着けること。",
  "This procedure applies to all operators.",
  "温度の記録は 12.5 ℃ 単位で残すこと。",
  "異常があれば supervisor に報告し、作業を止める。",
  "Check the valve pressure before starting the pump.",
  "月末に点検表を提出する。",
  "交換部品は指定の棚から取り出すこと。",
  "Record the result in the daily log.",
];

interface PageSpec {
  lines: string[];
  footer?: string;
  para?: string;
  rotate?: number;
  box?: boolean;
}

function basePages(n: number): PageSpec[] {
  const pages: PageSpec[] = [];
  for (let p = 1; p <= n; p++) {
    const lines = [`第${p}章 作業手順 Chapter ${p}`];
    for (let k = 1; k <= 22; k++) lines.push(`${p}-${String(k).padStart(2, "0")} ${SENT[(p * 3 + k) % SENT.length]}`);
    pages.push({ lines, para: `Operators must record every inspection result of page ${p} in the daily log and report any abnormal reading to the shift leader immediately so that the line can be stopped safely.` });
  }
  return pages;
}

function wrap(font: PDFFont, text: string, size: number, width: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const w of text.split(" ")) {
    const t = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(t, size) > width && cur) {
      out.push(cur);
      cur = w;
    } else cur = t;
  }
  if (cur) out.push(cur);
  return out;
}

async function makePdf(pages: PageSpec[], size: [number, number] = [595, 842]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(FONT, { subset: false });
  for (const sp of pages) {
    const p = doc.addPage(size);
    let y = size[1] - 60;
    for (const l of sp.lines) {
      p.drawText(l, { x: 50, y, size: 11, font });
      y -= 22;
    }
    if (sp.para) {
      y -= 10;
      for (const l of wrap(font, sp.para, 10, size[0] - 100 - 40)) {
        p.drawText(l, { x: 50, y, size: 10, font });
        y -= 14;
      }
    }
    if (sp.footer) p.drawText(sp.footer, { x: size[0] / 2 - 10, y: 30, size: 9, font });
    if (sp.box) p.drawRectangle({ x: 400, y: 60, width: 80, height: 50, color: rgb(0.9, 0.3, 0.3) });
    if (sp.rotate) p.setRotation(degrees(sp.rotate));
  }
  return doc.save();
}

/** 印刷してスキャンしたような PDF（画像だけ）。dx・dy は画素のずれ、angle は傾き（度） */
async function scanPdf(bytes: Uint8Array, dx = 0, dy = 0, angle = 0): Promise<Uint8Array> {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const pdf = await openPdf(bytes);
  const out = await PDFDocument.create();
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 2 });
    const c = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvas: c as unknown as HTMLCanvasElement, canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport: vp }).promise;
    const s = createCanvas(c.width, c.height);
    const sc = s.getContext("2d");
    sc.fillStyle = "#fbfaf6";
    sc.fillRect(0, 0, s.width, s.height);
    sc.translate(s.width / 2 + dx, s.height / 2 + dy);
    sc.rotate((angle * Math.PI) / 180);
    sc.drawImage(await loadImage(c.toBuffer("image/png")), -c.width / 2, -c.height / 2);
    const jpg = await out.embedJpg(s.toBuffer("image/jpeg", 80));
    const p = out.addPage([vp.width / 2, vp.height / 2]);
    p.drawImage(jpg, { x: 0, y: 0, width: vp.width / 2, height: vp.height / 2 });
  }
  return out.save();
}

async function side(bytes: Uint8Array): Promise<CompareSide> {
  const { createCanvas } = await import("@napi-rs/canvas");
  const pdf = await openPdf(bytes);
  const sizes: { w: number; h: number }[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const vp = (await pdf.getPage(i)).getViewport({ scale: 1 });
    sizes.push({ w: vp.width, h: vp.height });
  }
  return {
    pageCount: pdf.numPages,
    size: (i) => sizes[i],
    text: async (i) => {
      const page = await pdf.getPage(i + 1);
      const vp = page.getViewport({ scale: 1 });
      return itemsToText((await page.getTextContent()).items as never, (x, y) => vp.convertToViewportPoint(x, y) as [number, number]);
    },
    render: async (i, scale, extra) => {
      const page = await pdf.getPage(i + 1);
      const vp = page.getViewport({ scale, rotation: (page.rotate + extra) % 360 });
      const c = createCanvas(Math.max(1, Math.floor(vp.width)), Math.max(1, Math.floor(vp.height)));
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvas: c as unknown as HTMLCanvasElement, canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport: vp }).promise;
      const img = ctx.getImageData(0, 0, c.width, c.height);
      return { data: img.data as unknown as Uint8ClampedArray, width: c.width, height: c.height };
    },
  };
}

async function compare(a: Uint8Array, b: Uint8Array, loose = true) {
  const r = await compareDocs(await side(a), await side(b), { loose });
  assert.ok(r);
  const changed = r.entries.filter(entryChanged);
  return { r, entries: r.entries, changed, summary: `${changed.length} / ${r.entries.length}` };
}

const kinds = (es: PageEntry[]) => es.map((e) => `${e.kind}:${e.a ?? "-"}/${e.b ?? "-"}`).join(" ");
const marked = (segs: { text: string; mark: boolean }[]) =>
  segs
    .filter((s) => s.mark)
    .map((s) => s.text.trim())
    .join("|");

let base: PageSpec[];
let baseBytes: Uint8Array;
test("準備", async () => {
  base = basePages(6);
  baseBytes = await makePdf(base);
});

test("同じ文書：違いなし", async () => {
  const { summary } = await compare(baseBytes, await makePdf(base));
  assert.equal(summary, "0 / 6");
});

test("1 語・1 文字の変更：そのページだけで、違う語・文字だけに印が付く", async () => {
  const p = structuredClone(base);
  // 4 ページ目の 6 行目に 12.5、7 行目に supervisor がある
  assert.ok(p[3].lines[6].includes("12.5") && p[3].lines[7].includes("supervisor"));
  p[3].lines[6] = p[3].lines[6].replace("12.5", "12.6");
  p[3].lines[7] = p[3].lines[7].replace("supervisor", "manager");
  const { changed, summary } = await compare(baseBytes, await makePdf(p));
  assert.equal(summary, "1 / 6");
  const h = changed[0].hunks;
  assert.ok(h.length >= 1 && h.every((x) => x.kind === "change"), JSON.stringify(h));
  const ma = h.map((x) => marked(x.a)).join("|");
  const mb = h.map((x) => marked(x.b)).join("|");
  assert.ok(/^(5|supervisor)(\|(5|supervisor))*$/.test(ma), ma);
  assert.ok(/^(6|manager)(\|(6|manager))*$/.test(mb), mb);
});

test("途中にページを足す・削る：そのページだけが追加・削除になる", async () => {
  const extra: PageSpec = { lines: ["追加のページ Appendix", "This page was inserted.", "新しい手順を書いたページ。"] };
  const ins = await compare(baseBytes, await makePdf([...base.slice(0, 2), extra, ...base.slice(2)]));
  assert.equal(ins.summary, "1 / 7", kinds(ins.entries));
  assert.equal(ins.changed[0].kind, "add");
  assert.equal(ins.changed[0].b, 2);
  const del = await compare(baseBytes, await makePdf([...base.slice(0, 2), ...base.slice(3)]));
  assert.equal(del.summary, "1 / 6", kinds(del.entries));
  assert.equal(del.changed[0].kind, "del");
  assert.equal(del.changed[0].a, 2);
});

/** 枠で囲んだ区画の並んだページ（経歴書のような表） */
async function framedPdf(sections: string[][]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(FONT, { subset: false });
  const p = doc.addPage([595, 842]);
  let y = 800;
  for (const sec of sections) {
    const top = y;
    for (const l of sec) {
      y -= 16;
      p.drawText(l, { x: 60, y, size: 10, font });
    }
    y -= 10;
    p.drawRectangle({ x: 50, y, width: 495, height: top - y, borderColor: rgb(0.2, 0.2, 0.2), borderWidth: 0.8 });
    p.drawLine({ start: { x: 150, y }, end: { x: 150, y: top }, thickness: 0.8, color: rgb(0.2, 0.2, 0.2) });
    y -= 16;
  }
  return doc.save();
}

test("区画の途中で改行を入れて下がずれる：ずれた所は違いにせず、その行だけを示す", async () => {
  const secs = [0, 1, 2, 3].map((k) => [`□2011年${k + 2}月～2011年${k + 8}月 アグノーベル`, `◆事業内容：衛生・化学メーカー ${k}`, `業務内容 担当プロダクト 業務の概要`, `2011年${k + 2}月 品質管理 メンバー数：${k + 3}名`, "・顧客ニーズのヒアリング", "・品質改善の提案と実施"]);
  const a = await framedPdf(secs);
  const changedSecs = structuredClone(secs);
  // 1 つ目の区画の行を 2 行に分ける（改行を入れる）
  changedSecs[0].splice(1, 1, "◆事業内容：衛生・", "化学メーカー 0");
  const { changed, entries } = await compare(a, await framedPdf(changedSecs));
  assert.equal(changed.length, 1);
  const e = entries[0];
  assert.deepEqual(e.hunks.map((h) => h.kind), ["reflow"]);
  const below = (bs: { y: number; h: number }[]) => bs.filter((b) => b.y > 200 * e.scale);
  assert.deepEqual(below(e.boxesA ?? []), [], JSON.stringify(e.boxesA));
  assert.deepEqual(below(e.boxesB ?? []), [], JSON.stringify(e.boxesB));
  // 語を書き換えると、その語だけに印（ページの上の位置）が付く
  const w = structuredClone(secs);
  w[2][5] = "・品質改善の提案と検証";
  const r2 = await compare(a, await framedPdf(w));
  const e2 = r2.changed[0];
  assert.equal(e2.marksA.length, 1);
  assert.equal(e2.marksB.length, 1);
  assert.ok(e2.marksB[0].w < 30 && e2.marksB[0].y > 300 && e2.marksB[0].y < 600, JSON.stringify(e2.marksB));
  assert.deepEqual([...(e2.boxesA ?? []), ...(e2.boxesB ?? [])], []);
});

test("ページを足すと後ろのページ番号がすべて変わる：ページ番号の違いは文字の違いにしない", async () => {
  const withNo = (pages: PageSpec[]) => pages.map((pg, i) => ({ ...pg, lines: [...pg.lines], footer: `- ${i + 1} -` }));
  const a = await makePdf(withNo(base));
  const b = await makePdf(withNo([...base.slice(0, 2), { lines: ["追加のページ Appendix"] }, ...base.slice(2)]));
  const { summary, entries } = await compare(a, b);
  assert.equal(summary, "1 / 7", kinds(entries));
});

test("書き換えたページ：同じ位置のページは、追加と削除ではなく変更として組にする", async () => {
  const p = structuredClone(base);
  p[2] = { lines: ["第3章 書き換えた章 Rewritten", "Everything on this page is new.", "旧版とは別の内容です。", "Nothing here matches the old page."] };
  const { changed, summary, entries } = await compare(baseBytes, await makePdf(p));
  assert.equal(summary, "1 / 6", kinds(entries));
  assert.equal(changed[0].kind, "pair");
  assert.equal(changed[0].a, 2);
});

test("ページの入れ替え：移動として示し、文字の違いは出さない", async () => {
  const p = [base[0], base[3], base[2], base[1], base[4], base[5]];
  const { changed, summary, entries } = await compare(baseBytes, await makePdf(p));
  assert.equal(summary, "2 / 6", kinds(entries));
  assert.ok(changed.every((e) => e.kind === "move" && e.hunks.length === 0 && !e.visual), kinds(changed));
});

test("段落に 1 語足して折り返しがずれる：足した語だけに印。用紙を変えて折り返しだけ違うなら、改行の位置だけの違い", async () => {
  const p = structuredClone(base);
  p[1].para = p[1].para!.replace("must record", "must carefully record");
  const { changed, summary } = await compare(baseBytes, await makePdf(p));
  assert.equal(summary, "1 / 6");
  assert.equal(changed[0].hunks.length, 1);
  assert.equal(marked(changed[0].hunks[0].b), "carefully");
  assert.equal(marked(changed[0].hunks[0].a), "");
  // 用紙をレター判にして折り返しだけが変わる
  const letter = await compare(baseBytes, await makePdf(base, [612, 792]));
  for (const e of letter.changed) assert.ok(e.hunks.every((h) => h.kind === "reflow"), JSON.stringify(e.hunks));
});

test("空白・全角半角だけの違い：既定では文字の違いにしない（切り替えると出る）", async () => {
  const p = structuredClone(base);
  p[0].lines[6] = p[0].lines[6].replace("月末に", "月末 に").replace(/\d+/, (d) => d.replace(/\d/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)));
  p[0].lines[7] = p[0].lines[7].replace(/1/g, "１");
  const b = await makePdf(p);
  const loose = await compare(baseBytes, b, true);
  assert.ok(loose.entries.every((e) => e.hunks.length === 0));
  const strict = await compare(baseBytes, b, false);
  assert.equal(strict.entries.filter((e) => e.hunks.length > 0).length, 1);
  // 切り替えは文字の比較だけをやり直す
  applyText(loose.r, false);
  assert.equal(loose.r.entries.filter((e) => e.hunks.length > 0).length, 1);
});

test("1 ページだけ横向き：向きをそろえて比べる", async () => {
  const p = structuredClone(base);
  p[1].rotate = 90;
  const { changed, summary } = await compare(baseBytes, await makePdf(p));
  assert.equal(summary, "1 / 6");
  assert.ok(changed[0].rotate === 90 || changed[0].rotate === 270);
  assert.equal(changed[0].hunks.length, 0);
  assert.equal(changed[0].visual, false, JSON.stringify(changed[0].boxesA));
});

test("スキャンした紙：同じ紙のずれ・傾きは違いにせず、1 語の違い・ページの追加は見つける", async () => {
  const scanA = await scanPdf(baseBytes);
  const same = await compare(scanA, await scanPdf(baseBytes, 6, 4, 0.3));
  assert.ok(same.changed.length <= 1, `${same.summary} ${JSON.stringify(same.changed.map((e) => e.boxesA))}`);
  const p = structuredClone(base);
  p[2].lines[8] = p[2].lines[8].replace(/\S+$/, "差し替えた文章です。");
  const word = await compare(scanA, await scanPdf(await makePdf(p), 5, -3, 0.2));
  assert.ok(word.changed.some((e) => e.a === 2), word.summary);
  assert.ok(word.changed.length <= 2, word.summary);
  const extra: PageSpec = { lines: ["追加のページ Appendix", "This page was inserted."] };
  const ins = await compare(scanA, await scanPdf(await makePdf([...base.slice(0, 2), extra, ...base.slice(2)]), 4, 4, 0.2));
  assert.ok(ins.changed.some((e) => e.kind === "add" && e.b === 2), kinds(ins.entries));
  assert.ok(ins.changed.length <= 2, kinds(ins.changed));
});

test("文字のある PDF とそのスキャン：文字では比べず、見た目で比べる", async () => {
  const r = await compare(baseBytes, await scanPdf(baseBytes, 3, 3, 0.1));
  assert.equal(r.entries.length, 6, kinds(r.entries));
  assert.ok(r.entries.every((e) => e.kind === "pair" && e.textA && !e.textB && e.hunks.length === 0), kinds(r.entries));
  assert.ok(r.changed.length <= 2, r.summary);
});

test("大きな文書：途中のページ追加と 1 語の変更、図だけの変更も見つける", async () => {
  const big = basePages(150);
  const bigBytes = await makePdf(big);
  const p = structuredClone(big);
  p[99].box = true;
  const fig = await compare(bigBytes, await makePdf(p));
  assert.equal(fig.summary, "1 / 150");
  assert.equal(fig.changed[0].a, 99);
  const q = structuredClone(big);
  q[120].lines[3] = q[120].lines[3] + " 追記";
  q.splice(40, 0, { lines: ["追加のページ", "inserted"] });
  const ins = await compare(bigBytes, await makePdf(q));
  assert.equal(ins.summary, "2 / 151", kinds(ins.changed));
});

test("語の差分：英語は語ごと、日本語と数字は 1 文字ずつ", () => {
  const d = diffTokens("温度の記録は 12.5 ℃ 単位", "温度の記録は 12.6 ℃ 単位", true);
  assert.equal(marked(d.a), "5");
  assert.equal(marked(d.b), "6");
  const e = diffTokens("report to the supervisor now", "report to the manager now", true);
  assert.equal(marked(e.a), "supervisor");
  assert.equal(marked(e.b), "manager");
  const r = textHunks(["abc def", "ghi"], ["abc", "def ghi"], true);
  assert.deepEqual(r.map((h) => h.kind), ["reflow"]);
});

test("改行の印の無い PDF でも、上下に離れた文字は別の行にする", () => {
  const it = (str: string, y: number) => ({ str, hasEOL: false, transform: [10, 0, 0, 10, 50, y], height: 10 });
  assert.deepEqual(itemsToLines([it("Hello", 700), it(" world", 700), it("Next line", 680), it("x", 683)]), ["Hello world", "Next linex"]);
});


test("書き出し：Markdown・注釈付き PDF・報告のページ", async () => {
  const { setupFonts, pageText } = await import("./helpers");
  const { loadPdfFile } = await import("@/lib/loader");
  const { compareMarkdown, annotatedPdf, reportPdf } = await import("@/lib/compareExport");
  const { translate } = await import("@/lib/i18n");
  setupFonts();
  const t = (k: never, v?: never) => translate("ja", k, v);
  const p = structuredClone(base);
  p[3].lines[7] = p[3].lines[7].replace("supervisor", "manager");
  p.splice(2, 0, { lines: ["追加のページ Appendix"] });
  const bBytes = await makePdf(p);
  const { r } = await compare(baseBytes, bBytes);
  const names = { a: "いまの文書", b: "b.pdf", aPages: 6, bPages: 7, loose: true };
  const md = compareMarkdown(r, names, t as never);
  assert.ok(md.includes("~~supervisor~~") && md.includes("**manager**"), md);
  assert.ok(md.includes("追加"), md);
  const file = { name: "b.pdf", type: "application/pdf", arrayBuffer: async () => bBytes.buffer.slice(bBytes.byteOffset, bBytes.byteOffset + bBytes.byteLength) } as unknown as File;
  const B = await loadPdfFile(file);
  const annotated = await openPdf(await annotatedPdf(B, r, t as never));
  assert.equal(annotated.numPages, 7);
  const annots = (await Promise.all([1, 2, 3, 4, 5, 6, 7].map(async (n) => (await (await annotated.getPage(n)).getAnnotations()).map((a) => a.subtype)))).flat();
  assert.ok(annots.includes("Highlight") && annots.includes("Text"), annots.join(","));
  // 行の途中の文を消しただけの違い（比べた PDF の側に印を付ける文字が無い）も、付箋で残る
  const q = structuredClone(base);
  q[1].lines[4] = q[1].lines[4].replace(/\s\S+$/, "");
  const qBytes = await makePdf(q);
  const rq = (await compare(baseBytes, qBytes)).r;
  const qFile = { name: "q.pdf", type: "application/pdf", arrayBuffer: async () => qBytes.buffer.slice(qBytes.byteOffset, qBytes.byteOffset + qBytes.byteLength) } as unknown as File;
  const qa = await openPdf(await annotatedPdf(await loadPdfFile(qFile), rq, t as never));
  const qNotes = (await (await qa.getPage(2)).getAnnotations()).filter((a) => a.subtype === "Text");
  assert.equal(qNotes.length, 1, JSON.stringify(rq.entries[1].hunks.map((h) => h.kind)));
  // 報告のページ：表紙と、違いのあるページごと（画像は試験では省く）
  const report = await openPdf(await reportPdf(r, names, t as never, async () => null));
  assert.equal(report.numPages, 3);
  const cover = (await pageText(report, 1)).replace(/\s+/g, "");
  assert.ok(cover.includes("文書の比較の報告") && cover.includes("違いのあるページ：2/7"), cover);
  const detail = (await pageText(report, 3)).replace(/\s+/g, "");
  assert.ok(detail.includes("[-supervisor-]") && detail.includes("{+manager+}"), detail);
});

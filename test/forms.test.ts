import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { decodePDFRawStream, PDFDict, PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { apply, multiply } from "@/lib/geometry";
import { num } from "@/lib/contentStream";
import { createTextEdit } from "@/lib/editModel";
import { buildPdf } from "@/lib/exportPdf";
import { getLibDoc, pageContentBytes } from "@/lib/libDoc";
import { tokenizeContent } from "@/lib/contentStream";
import { getPageImages } from "@/lib/pageImages";
import { getPageText } from "@/lib/textRuns";
import type { Matrix, RedactObj, TextEditObj } from "@/lib/types";
import { diffOutside, fixtures, loadSource, openPdf, pageText, renderPage, savePng } from "./helpers";

const tmpDir = join(fixtures, "..", "..", "dist", ".test");
mkdirSync(tmpDir, { recursive: true });

/** フォーム 2 回分（左下 1 倍、右下 0.8 倍）と、入れ子の内側のフォーム */
const formsPdf = join(fixtures, "forms.pdf");

test("Form XObject の中の文字は、呼び出しごとに別の行として検出され、path 付きで実編集できる", async () => {
  const { doc, pages } = await loadSource(formsPdf);
  const { runs } = await getPageText(doc, pages[0]);
  const ja = runs.filter((r) => r.text.includes("フォーム内の和文テキスト"));
  const inner = runs.filter((r) => r.text.includes("Inner text"));
  assert.equal(ja.length, 2, runs.map((r) => r.text).join(" | "));
  assert.equal(inner.length, 2);
  assert.ok(ja.every((r) => r.editable), ja.map((r) => r.reason).join(","));
  assert.ok(inner.every((r) => r.editable));
  // 1 回目（左下）は 1 倍、2 回目（右下）は 0.8 倍
  const [a, b] = [...ja].sort((x, y) => x.x - y.x);
  assert.ok(Math.abs(a.fontSize - 12) < 0.1 && Math.abs(b.fontSize - 9.6) < 0.1, `${a.fontSize} ${b.fontSize}`);
  assert.deepEqual(a.removals[0].path, [7]);
  assert.deepEqual(b.removals[0].path, [11]);
  // 入れ子：外側の Do → 内側の Do
  const [ia] = [...inner].sort((x, y) => x.x - y.x);
  assert.equal(ia.removals[0].path?.length, 2);
  assert.ok(runs.some((r) => r.text.includes("Page level text") && r.removals[0].path?.length === 0));
});

test("Form XObject の中の文字を書き換えると、その呼び出しだけが変わり、同じフォームの他の呼び出しは元のまま", async () => {
  const { doc, pages } = await loadSource(formsPdf);
  const { runs } = await getPageText(doc, pages[0]);
  const ja = runs.filter((r) => r.text.includes("フォーム内の和文テキスト")).sort((x, y) => x.x - y.x);
  const inner = runs.filter((r) => r.text.includes("Inner text")).sort((x, y) => x.x - y.x);
  // 1 回目の和文は元フォントで、2 回目の内側の欧文は同梱フォントで書き換える
  const e1 = createTextEdit([ja[0]], { cover: "#ffffff", fallbackColor: "#000000" }) as TextEditObj;
  assert.equal(e1.font, "original");
  e1.text = "書き換え後の和文";
  const e2 = createTextEdit([inner[1]], { cover: "#ffffff", fallbackColor: "#000000", font: "notosans" }) as TextEditObj;
  e2.text = "Changed";
  const warnings: string[] = [];
  const bytes = await buildPdf([{ ...pages[0], objects: [e1, e2] }], new Map([[doc.id, doc]]), new Map(), { onWarning: (m) => warnings.push(m) });
  writeFileSync(join(tmpDir, "forms-edited.pdf"), bytes);
  assert.equal(warnings.length, 0, warnings.join("\n"));
  const pdf = await openPdf(bytes);
  const text = await pageText(pdf, 1);
  assert.equal((text.match(/フォーム内の和文テキスト/g) ?? []).length, 1, text);
  assert.ok(text.includes("書き換え後の和文"), text);
  assert.equal((text.match(/Inner text/g) ?? []).length, 1, text);
  assert.ok(text.includes("Changed"), text);
  assert.ok(text.includes("Page level text"));
  // 複製が新しい名前で足されている
  const lib = await PDFDocument.load(bytes);
  const content = Buffer.from(pageContentBytes(lib, lib.getPage(0))).toString("latin1");
  // 1 回目は和文の書き換え、2 回目は入れ子の内側の書き換えなので、どちらの呼び出しも複製に向く
  assert.match(content, /\/WashiF1 Do/);
  assert.match(content, /\/WashiF2 Do/);
  const xo = lib.getPage(0).node.Resources()!.lookup(PDFName.of("XObject")) as PDFDict;
  assert.ok(xo.has(PDFName.of("WashiF1")) && xo.has(PDFName.of("WashiF2")));
  // どの呼び出しからも使われなくなった元のフォーム（書き換える前の文字が入っている）は、ファイルに残さない
  assert.ok(!xo.has(PDFName.of("Fo")), "使われなくなった元のフォームがリソースに残っている");
  // 位置：新しい文字は元の文字の位置（2 回目の内側は 210 + 0.8 × (10 + 6)）
  const items = (await (await pdf.getPage(1)).getTextContent()).items;
  const changed = items.find((it) => "str" in it && it.str.includes("Changed"));
  assert.ok(changed && "transform" in changed);
  assert.ok(Math.abs(changed.transform[4] - (210 + 0.8 * 16)) < 2, String(changed.transform[4]));
  // 描画：書き換えた箇所以外は元のまま
  const before = await renderPage(await openPdf(doc.bytes), 1, 2);
  const after = await renderPage(pdf, 1, 2);
  await savePng(after, join(tmpDir, "forms-edited.png"));
  const d = diffOutside(before, after, [{ x: ja[0].x - 2, y: ja[0].top - 2, w: ja[0].w + 4, h: ja[0].h + 4 }, { x: inner[1].x - 2, y: inner[1].top - 2, w: inner[1].w + 4, h: inner[1].h + 4 }], 2);
  assert.ok(d.changed / d.total < 0.002, `範囲外が変わった: ${d.changed}/${d.total}`);
});

test("Form XObject の中の画像・図形・文字も墨消しでデータごと消え、他の呼び出しは残る", async () => {
  const { doc, pages } = await loadSource(formsPdf);
  const imgs = await getPageImages(doc, pages[0]);
  assert.equal(imgs.length, 0); // このフィクスチャに画像は無い（画像の path は Do と同じ仕組み）
  // 1 回目のフォーム（20,140 原点）：縦線 x=80, y 140..220、内側のフォーム（30..150 × 180..210）、和文（y≈230）
  // 範囲：x 60..100, y 150..240（表示 top = 300-240 = 60）→ 縦線の上側・内側フォームの一部・和文の一部に掛かる
  const r: RedactObj = { id: "r", type: "redact", x: 60, y: 60, w: 40, h: 90, fill: "#000000" };
  const warnings: string[] = [];
  const bytes = await buildPdf([{ ...pages[0], objects: [r] }], new Map([[doc.id, doc]]), new Map(), { onWarning: (m) => warnings.push(m) });
  writeFileSync(join(tmpDir, "forms-redacted.pdf"), bytes);
  assert.ok(!warnings.some((w) => w.includes("XObject")), warnings.join("\n"));
  // フォームの複製の中にも、範囲内の点を持つパスが無い
  const lib = await PDFDocument.load(bytes);
  const page = lib.getPage(0);
  const pts: [number, number][] = [];
  const walk = (bytes: Uint8Array, res: PDFDict | undefined, ctm0: Matrix) => {
    const ops = tokenizeContent(bytes);
    const stack: Matrix[] = [];
    let ctm = ctm0;
    for (const op of ops) {
      const a = op.operands;
      if (op.op === "q") stack.push(ctm);
      else if (op.op === "Q") ctm = stack.pop() ?? ctm;
      else if (op.op === "cm") ctm = multiply(ctm, [num(a[0]), num(a[1]), num(a[2]), num(a[3]), num(a[4]), num(a[5])]);
      else if (op.op === "m" || op.op === "l") pts.push(apply(ctm, num(a[0]), num(a[1])));
      else if (op.op === "re") {
        const [x, y, w, h] = [num(a[0]), num(a[1]), num(a[2]), num(a[3])];
        for (const [px, py] of [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]) pts.push(apply(ctm, px, py));
      } else if (op.op === "Do") {
        const xd = res?.lookup(PDFName.of("XObject"));
        const nm = a[0].kind === "name" ? a[0].value : "";
        const x = xd instanceof PDFDict ? xd.lookup(PDFName.of(nm)) : undefined;
        if (x instanceof PDFRawStream) {
          const inner = decodePDFRawStream(x).decode();
          const innerRes = x.dict.lookup(PDFName.of("Resources"));
          walk(inner, innerRes instanceof PDFDict ? innerRes : res, ctm);
        }
      }
    }
  };
  walk(pageContentBytes(lib, page), page.node.Resources(), [1, 0, 0, 1, 0, 0]);
  const inside = pts.filter(([x, y]) => x > 60.5 && x < 99.5 && y > 150.5 && y < 239.5);
  assert.equal(inside.length, 0, JSON.stringify(inside.slice(0, 5)));
  const pdf = await openPdf(bytes);
  const text = await pageText(pdf, 1);
  // 2 回目（右下）の和文・Inner text は残り、1 回目のうち範囲に掛かった文字は消える
  assert.ok(text.includes("Inner text"), text);
  assert.equal((text.match(/フォーム内の和文テキスト/g) ?? []).length, 1, text);
  const img = await renderPage(pdf, 1, 2);
  await savePng(img, join(tmpDir, "forms-redacted.png"));
  const px = (x: number, y: number) => {
    const i = (y * 2 * img.width + x * 2) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  };
  assert.deepEqual(px(80, 100), [0, 0, 0], "範囲が黒い");
  // 範囲の下に残る縦線（PDF y 140..150 → 表示 y 150..160）
  assert.ok(px(80, 157)[2] > 150 && px(80, 157)[0] < 100, `縦線が消えた: ${px(80, 157)}`);
  // 2 回目（右下）の縦線はそのまま（x = 210 + 0.8×60 = 258、表示 y = 300 − (20 + 0.8×40) = 248）
  assert.ok(px(258, 248)[2] > 150 && px(258, 248)[0] < 100, `2 回目の縦線が消えた: ${px(258, 248)}`);
});

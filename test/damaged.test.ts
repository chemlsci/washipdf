// 壊れた PDF：表示（pdf.js）では開けるものは、編集して保存もできる。保存できないときは、訳した知らせで止まる
import assert from "node:assert/strict";
import { test } from "node:test";
import { tokenizeContent } from "@/lib/contentStream";
import { buildPdf } from "@/lib/exportPdf";
import { loadPdfFile } from "@/lib/loader";
import { fitScale, MAX_CANVAS_PIXELS, MAX_CANVAS_SIDE } from "@/lib/render";
import type { EditObj } from "@/lib/types";
import { openPdf, pageText, setupFonts } from "./helpers";

/** オブジェクトの本文の列から、相互参照表つきの PDF を作る（i 番目が i+1 番のオブジェクト） */
function rawPdf(objects: string[], trailer = "/Root 1 0 R"): Uint8Array {
  let out = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} ${trailer} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const content = (s: string) => `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
const FONT = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

async function open(bytes: Uint8Array) {
  setupFonts();
  const fake = { name: "damaged.pdf", type: "application/pdf", arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } as unknown as File;
  return loadPdfFile(fake);
}

/** 文字を 1 つ足して保存し、開き直した文字列を返す */
async function saveWithText(bytes: Uint8Array, extra: EditObj[] = []) {
  const { doc, pages } = await open(bytes);
  const objects: EditObj[] = [{ id: "t", type: "text", x: 72, y: 120, w: 200, h: 24, text: "ADDED", font: "gothic", fontSize: 14, color: "#000000" } as EditObj, ...extra];
  const out = await buildPdf([{ ...pages[0], objects }], new Map([[doc.id, doc]]), new Map());
  return (await pageText(await openPdf(out), 1)).replace(/\s+/g, "");
}

test("ページの親子が輪になっている PDF も、編集して保存できる", async () => {
  const bytes = rawPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 6 0 R /Contents 5 0 R /Resources << /Font << /F1 4 0 R >> >> >>",
    FONT,
    content("BT /F1 24 Tf 72 700 Td (Hello cycle) Tj ET"),
    "<< /Type /Pages /Parent 7 0 R /MediaBox [0 0 612 792] >>",
    "<< /Type /Pages /Parent 6 0 R >>",
  ]);
  const text = await saveWithText(bytes);
  assert.ok(text.includes("Hellocycle") && text.includes("ADDED"), text);
});

test("ページの大きさに数でない値がある PDF も、編集して保存できる", async () => {
  const bytes = rawPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /MediaBox [0 0 NaN 792] >>",
    FONT,
    content("BT /F1 24 Tf 72 700 Td (Hello box) Tj ET"),
  ]);
  const text = await saveWithText(bytes);
  assert.ok(text.includes("Hellobox") && text.includes("ADDED"), text);
});

test("ページの内容（/Contents）がストリームでない PDF も、墨消しと文字を足して保存できる", async () => {
  const bytes = rawPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 3 0 R >>",
    FONT,
  ]);
  const text = await saveWithText(bytes, [{ id: "r", type: "redact", x: 300, y: 300, w: 40, h: 20, fill: "#000000" } as EditObj]);
  assert.ok(text.includes("ADDED"), text);
});

test("とても深く入れ子になった配列を含む内容でも、読み取りが止まらない", () => {
  const deep = "[".repeat(20000) + "]".repeat(20000);
  const ops = tokenizeContent(new TextEncoder().encode(`BT /F1 12 Tf 10 10 Td ${deep} TJ (ok) Tj ET`));
  assert.ok(ops.some((o) => o.op === "Tj"));
});

test("ページ・画像を描く canvas は、ブラウザーの上限に収める", () => {
  // A4 を 6 倍（スマホで 200%）：上限を超えないよう倍率を下げる
  const s = fitScale(595, 842, 6);
  assert.ok(595 * 842 * s * s <= MAX_CANVAS_PIXELS + 1);
  // とても大きいページ：一辺の上限にも収める
  const big = fitScale(14400, 14400, 1);
  assert.ok(14400 * big <= MAX_CANVAS_SIDE + 1);
  // 小さいものはそのまま
  assert.equal(fitScale(100, 100, 2), 2);
});

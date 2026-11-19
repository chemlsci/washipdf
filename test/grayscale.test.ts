import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { defaultSettings } from "@/lib/docOps";
import { buildPdf } from "@/lib/exportPdf";
import { grayscaleContent } from "@/lib/grayscale";
import type { MarkupObj, ShapeObj, TextObj } from "@/lib/types";
import { PDFDocument } from "pdf-lib";
import { fixtures, loadSource, openPdf, renderPage, savePng } from "./helpers";

test("色命令の書き換え：rg/RG/k/sc を灰色に、g はそのまま", async () => {
  const doc = await PDFDocument.create();
  const src = "1 0 0 rg 0 0 1 RG 0 1 1 0 k /DeviceRGB cs 0 1 0 sc 0.5 g (x) Tj";
  const out = Buffer.from(grayscaleContent(doc, new TextEncoder().encode(src), undefined)).toString("latin1");
  assert.equal(out, "0.299 g 0.114 G 0.299 g /DeviceRGB cs 0.587 g 0.5 g (x) Tj");
});

test("グレースケール化：赤い図形・色付き文字・画像が灰色になる", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "images.pdf"));
  const rect: ShapeObj = { id: "r", type: "rect", x: 20, y: 150, w: 60, h: 40, fill: "#00a000", stroke: "#0000ff", strokeWidth: 2, opacity: 1 };
  const text: TextObj = { id: "t", type: "text", x: 200, y: 200, w: 150, h: 20, text: "Red text", font: "notosans", fontSize: 16, color: "#ff0000", rotation: 0, align: "left" } as unknown as TextObj;
  const hl: MarkupObj = { id: "h", type: "markup", kind: "highlight", x: 50, y: 250, w: 100, h: 18, color: "#ffe234", opacity: 0.5, contents: "" };
  const settings = { ...defaultSettings(), grayscale: true };
  const bytes = await buildPdf([{ ...pages[0], objects: [rect, text, hl] }], new Map([[doc.id, doc]]), new Map(), { settings });
  const img = await renderPage(await openPdf(bytes), 1, 1);
  await savePng(img, join(fixtures, "..", "..", "dist", ".test", "grayscale.png"));
  let colored = 0;
  let total = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const r = img.data[i];
    const g = img.data[i + 1];
    const b = img.data[i + 2];
    if (r === 255 && g === 255 && b === 255) continue;
    total++;
    if (Math.abs(r - g) > 6 || Math.abs(g - b) > 6) colored++;
  }
  assert.ok(total > 100, "何も描かれていない");
  assert.ok(colored / total < 0.01, `色の付いた画素が残っている: ${colored}/${total}`);
  // 赤い画像（JPEG）の位置も灰色
  const i = (75 * img.width + 110) * 4;
  assert.ok(Math.abs(img.data[i] - img.data[i + 1]) <= 6 && img.data[i] < 200, `画像が灰色でない: ${img.data[i]},${img.data[i + 1]},${img.data[i + 2]}`);
});

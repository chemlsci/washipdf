// 計測：距離・面積の計算（縮尺と単位）、表示の文字、保存した PDF に数値が入ること
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { defaultSettings } from "@/lib/docOps";
import { buildPdf } from "@/lib/exportPdf";
import { measureArea, measureLabel, measureLength, withPoints } from "@/lib/measure";
import type { MeasureObj } from "@/lib/types";
import { fixtures, loadSource, openPdf, pageText, setupFonts } from "./helpers";

setupFonts();
const base: MeasureObj = { id: "m", type: "measure", kind: "distance", pts: [], x: 0, y: 0, w: 0, h: 0, scale: 1, unit: "mm", color: "#d6334a" };
// 72 pt = 1 インチ = 25.4 mm
test("距離：72pt は 25.4mm。縮尺 1:100・単位 m なら 2.54m", () => {
  const d = withPoints(base, [
    [100, 100],
    [172, 100],
  ]);
  assert.ok(Math.abs(measureLength(d) - 25.4) < 1e-9);
  assert.equal(measureLabel(d), "25.4 mm");
  const m = { ...d, scale: 100, unit: "m" as const };
  assert.ok(Math.abs(measureLength(m) - 2.54) < 1e-9);
  assert.equal(measureLabel(m), "2.54 m");
});

test("面積：72pt 四方は 25.4mm 四方（645.16mm²）。縮尺 1:100・単位 m なら 6.4516m²", () => {
  const a = withPoints({ ...base, kind: "area" }, [
    [0, 0],
    [72, 0],
    [72, 72],
    [0, 72],
  ]);
  assert.ok(Math.abs(measureArea(a) - 645.16) < 1e-6);
  const m = { ...a, scale: 100, unit: "m" as const };
  assert.ok(Math.abs(measureArea(m) - 6.4516) < 1e-9);
  assert.equal(measureLabel(m), "6.452 m²");
});

test("保存した PDF に、計測の数値が入る", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "ja-libreoffice-writer.pdf"));
  const d = withPoints({ ...base, scale: 100, unit: "m" }, [
    [100, 600],
    [172, 600],
  ]);
  const bytes = await buildPdf([{ ...pages[0], objects: [d] }], new Map([[doc.id, doc]]), new Map(), { settings: defaultSettings() });
  const text = await pageText(await openPdf(bytes), 1);
  assert.ok(text.includes("2.54 m"), text.slice(-80));
});

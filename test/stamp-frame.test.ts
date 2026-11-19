import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { buildPdf } from "@/lib/exportPdf";
import type { PageItem, StampObj } from "@/lib/types";
import { fixtures, loadSource, openPdf, pageText } from "./helpers";

test("スタンプの枠（四角・円・二重枠・枠なし）が保存でき、文字が抽出できる", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "ja-subset-identity.pdf"));
  const p = pages[0];
  const base = { type: "stamp" as const, color: "#d6334a", font: "gothic" as const, fontSize: 20, rotation: 0, opacity: 1 };
  const objs: PageItem["objects"] = [
    { ...base, id: "a", x: 60, y: 560, w: 140, h: 60, text: "四角", frame: "rect" } satisfies StampObj,
    { ...base, id: "b", x: 340, y: 560, w: 140, h: 60, text: "円枠", frame: "ellipse" } satisfies StampObj,
    { ...base, id: "c", x: 60, y: 340, w: 130, h: 130, text: "社外秘", frame: "ellipse", double: true } satisfies StampObj,
    { ...base, id: "d", x: 340, y: 360, w: 140, h: 70, text: "枠なし", frame: "none" } satisfies StampObj,
    // 後方互換：frame 未指定（= 四角扱い）でも落ちない
    { ...base, id: "e", x: 340, y: 200, w: 120, h: 50, text: "承認" } satisfies StampObj,
  ];
  const bytes = await buildPdf([{ ...p, objects: objs }], new Map([[doc.id, doc]]), new Map());
  const pdf = await openPdf(bytes);
  const txt = await pageText(pdf, 1);
  for (const s of ["四角", "円枠", "社外秘", "枠なし", "承認"]) assert.ok(txt.includes(s), `スタンプ文字「${s}」が無い`);
});

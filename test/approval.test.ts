// 承認欄：押印欄に合わせる計算と、ページの罫線から押印欄を見つける処理
//
// フィクスチャ hanko-table-libreoffice.pdf は、LibreOffice で作った「部長・課長・担当」の押印欄（見出しの下に高さ 70px の欄）と、
// 大きな備考欄（500×200px）の表を含む 1 ページ
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { approvalCells, cellFromRules, fitIntoCell, newApproval } from "@/lib/approval";
import { apply } from "@/lib/geometry";
import { analyzePage } from "@/lib/libDoc";
import type { ImageObj, StampObj } from "@/lib/types";
import { fixtures, loadSource, setupFonts } from "./helpers";

setupFonts();

const sig = (x: number, y: number): ImageObj => ({ id: "s", type: "image", x, y, w: 150, h: 80, imageId: "i", opacity: 1 });

test("承認欄の押印欄に置いた署名は、縦横比を保って欄に収まり、欄の中央に来る。欄の外なら変えない", () => {
  const box: StampObj = newApproval({ id: "b", type: "stamp", color: "#222222", font: "sans" as never, fontSize: 10, opacity: 1 }, 300, 400, "部長,課長,担当");
  const cell = approvalCells(box)[1];
  const out = fitIntoCell(sig(cell.x + cell.w / 2 - 75, cell.y + cell.h / 2 - 40), [box]) as ImageObj;
  assert.ok(out);
  assert.ok(out.w <= cell.w * 0.85 && out.h <= cell.h * 0.85);
  assert.ok(Math.abs(out.w / out.h - 150 / 80) < 1e-9);
  assert.ok(Math.abs(out.x + out.w / 2 - (cell.x + cell.w / 2)) < 1e-6 && Math.abs(out.y + out.h / 2 - (cell.y + cell.h / 2)) < 1e-6);
  assert.equal(fitIntoCell(sig(10, 10), [box]), null);
});

test("hanko-table-libreoffice.pdf：罫線から押印欄を見つける。大きな備考欄と、枠の無い所は欄とみなさない", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "hanko-table-libreoffice.pdf"));
  const a = await analyzePage(doc, 0);
  const vt = pages[0].viewTransform;
  const rules = a.rules.map(([x1, y1, x2, y2]) => [...apply(vt, x1, y1), ...apply(vt, x2, y2)] as [number, number, number, number]);
  assert.ok(rules.length >= 8, `罫線が見つからない: ${rules.length}`);
  // 「課長」（x 144〜169, y 94〜109）の下の押印欄
  const cell = cellFromRules(rules, 156, 150);
  assert.ok(cell, "押印欄が見つからない");
  assert.ok(cell.x < 144 && cell.x + cell.w > 169 && cell.y > 105 && cell.y < 135 && cell.h > 40 && cell.h < 80, JSON.stringify(cell));
  // 見出しの欄も枠（小さいので押印欄と同じ扱い）
  assert.ok(cellFromRules(rules, 156, 101));
  // 備考欄（500×200）は大きすぎるので合わせない。枠の外も無し
  assert.equal(cellFromRules(rules, 300, 300), null);
  assert.equal(cellFromRules(rules, 400, 600), null);
});

test("署名欄（入力欄の道具で置いたもの）に置いたサインも、欄に収まり中央に来る", () => {
  const field = { id: "f", type: "field" as const, kind: "signature" as const, name: "署名", x: 100, y: 500, w: 160, h: 40, options: [] };
  const out = fitIntoCell(sig(180 - 75, 520 - 40), [field]) as ImageObj;
  assert.ok(out && out.w <= 160 * 0.85 && out.h <= 40 * 0.85);
  assert.ok(Math.abs(out.x + out.w / 2 - 180) < 1e-6 && Math.abs(out.y + out.h / 2 - 520) < 1e-6);
});

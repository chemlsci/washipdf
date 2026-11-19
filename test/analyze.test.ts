import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { getPageText } from "@/lib/textRuns";
import { fixtures, loadSource } from "./helpers";

const show = (name: string) => process.env.SHOW_RUNS === "1" && console.log(name);

test("ja-subset-identity: 行と命令が対応付く", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "ja-subset-identity.pdf"));
  const { runs, pageError } = await getPageText(doc, pages[0]);
  assert.equal(pageError, null);
  for (const r of runs) show(`${r.editable ? "o" : "x"} [${r.removals.length}] ${r.fontSize.toFixed(1)} ${r.srcFontName} ${r.blockId ?? "-"} "${r.text}" ${r.reason ?? ""}`);
  const byText = (t: string) => runs.find((r) => r.text.includes(t));
  assert.ok(byText("株式会社サンプル商事")?.editable);
  // Td 無しで連結された 3 つの Tj は 1 つの行にまとまり、命令も 3 つ
  const r2 = byText("お見積書");
  assert.ok(r2?.editable);
  assert.equal(r2!.removals.length, 3);
  assert.equal(r2!.text, "お見積書（2026年11月8日）");
  // TJ（カーニング付き）
  const r3 = byText("下記のとおり");
  assert.ok(r3?.editable);
  assert.equal(r3!.removals.length, 1);
  // 文字間隔
  const r4 = byText("合計金額");
  assert.ok(r4?.editable);
  assert.ok(Math.abs(r4!.charSpacing - 1) < 1e-6);
  assert.equal(r4!.font, "mincho");
  // フォント混在の行
  const r5 = byText("納期");
  assert.ok(r5?.editable);
  assert.equal(r5!.removals.length, 2);
  // 段落ブロック（3行）
  const blk = runs.filter((r) => r.text.includes("自動テスト用") || r.text.includes("三行の幅") || r.text === "最後の行は短い。");
  assert.equal(blk.length, 3);
  assert.ok(blk.every((r) => r.blockId && r.blockId === blk[0].blockId));
  // 色
  assert.equal(byText("この行は編集しない")?.color, "#000000");
});

test("en-standard14: 標準フォントの幅が引ける", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "en-standard14.pdf"));
  const { runs } = await getPageText(doc, pages[0]);
  for (const r of runs) show(`${r.editable ? "o" : "x"} [${r.removals.length}] ${r.fontSize.toFixed(1)} ${r.srcFontName} "${r.text}" ${r.reason ?? ""} tw=${r.wordSpacing}`);
  const byText = (t: string) => runs.find((r) => r.text.includes(t));
  assert.ok(byText("Quarterly Report")?.editable);
  const parts = byText("Part one");
  assert.ok(parts?.editable);
  assert.equal(parts!.removals.length, 3);
  assert.equal(parts!.text, "Part one, part two, part three.");
  // 進み量に依存する連続 Tj では、削除時に進み量を残す置き換えが入る
  assert.match(parts!.removals[0].replacement, /TJ$/);
  assert.equal(parts!.removals[2].replacement, "");
  assert.equal(byText("Revenue grew")?.wordSpacing, 2);
  assert.ok(byText("Times Roman")?.originalFontUsable);
});

test("ja-special-cases: フォームの中は実編集でき、透明は編集不可、縦書きは列として実編集できる", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "ja-special-cases.pdf"));
  const { runs } = await getPageText(doc, pages[0]);
  for (const r of runs) show(`${r.editable ? "o" : "x"} [${r.removals.length}] "${r.text}" ${r.reason ?? ""}`);
  const byText = (t: string) => runs.find((r) => r.text.includes(t));
  const form = byText("フォームの中");
  assert.equal(form?.editable, true, form?.reason ?? "");
  assert.deepEqual(form!.removals[0].path, [2]);
  assert.equal(byText("透明な")?.editable, false);
  assert.ok(byText("通常の編集できる行")?.editable);
  // 縦書きは列として検出され、実編集できる（M7）
  const v = byText("縦書き");
  assert.ok(v?.vertical && v.editable, JSON.stringify(v && { vertical: v.vertical, editable: v.editable, reason: v.reason }));
});

test("ja-rotated90: 回転ページでも行が取れる", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "ja-rotated90.pdf"));
  const { runs } = await getPageText(doc, pages[0]);
  for (const r of runs) show(`${r.editable ? "o" : "x"} [${r.removals.length}] ${r.fontSize.toFixed(1)} "${r.text}" x=${r.x.toFixed(1)} base=${r.baseline.toFixed(1)} ${r.reason ?? ""}`);
  const byText = (t: string) => runs.find((r) => r.text.includes(t));
  assert.ok(byText("回転ページの見出し")?.editable);
  assert.ok(byText("二行目")?.editable);
  const cm = byText("cm で拡大");
  assert.ok(cm?.editable);
  assert.ok(Math.abs(cm!.fontSize - 14) < 0.5);
});

test("ja-nonembedded-rksj: 定義済み CMap は安全に扱う", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "ja-nonembedded-rksj.pdf"));
  const { runs } = await getPageText(doc, pages[0]);
  for (const r of runs) show(`${r.editable ? "o" : "x"} [${r.removals.length}] "${r.text}" ${r.reason ?? ""}`);
  // pdf.js が CMap を解決できれば行になる。その場合も命令の幅が不明なので削除対象は 1 つで済むこと
  for (const r of runs) assert.ok(r.removals.length <= 1);
});

test("ja-libreoffice-writer: LibreOffice 出力の行が編集可能", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "ja-libreoffice-writer.pdf"));
  const { runs, pageError } = await getPageText(doc, pages[0]);
  assert.equal(pageError, null);
  for (const r of runs) show(`${r.editable ? "o" : "x"} [${r.removals.length}] ${r.fontSize.toFixed(1)} ${r.srcFontName} ${r.blockId ?? "-"} "${r.text}" ${r.reason ?? ""}`);
  const editable = runs.filter((r) => r.editable);
  assert.ok(editable.length >= runs.length * 0.8, `編集可能な行が少なすぎる: ${editable.length}/${runs.length}`);
  assert.ok(runs.some((r) => r.text.includes("社内規程")));
});

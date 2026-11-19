import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { PDFArray, PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { defaultSettings } from "@/lib/docOps";
import { buildPdf } from "@/lib/exportPdf";
import { fillForm, readFormFields } from "@/lib/forms";
import type { InkObj, MarkupObj, NoteObj, PageItem, StampObj } from "@/lib/types";
import { fixtures, loadSource, openPdf, pageText, renderPage } from "./helpers";

test("ハイライト・下線・取り消し線・付箋・手書きが PDF の注釈として保存される", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "ja-subset-identity.pdf"));
  const p = pages[0];
  const objs: PageItem["objects"] = [
    { id: "h", type: "markup", kind: "highlight", x: 70, y: 70, w: 200, h: 18, color: "#ffe234", opacity: 0.5, contents: "重要" } satisfies MarkupObj,
    { id: "u", type: "markup", kind: "underline", x: 70, y: 100, w: 150, h: 16, color: "#e11d48", opacity: 1, contents: "" } satisfies MarkupObj,
    { id: "s", type: "markup", kind: "strikeout", x: 70, y: 130, w: 150, h: 16, color: "#e11d48", opacity: 1, contents: "" } satisfies MarkupObj,
    { id: "n", type: "note", x: 400, y: 80, color: "#ffd43b", contents: "確認してください", author: "テスト" } satisfies NoteObj,
    { id: "i", type: "ink", x: 100, y: 300, w: 100, h: 40, paths: [[[0, 0], [50, 40], [100, 0]]], stroke: "#2f55d4", strokeWidth: 2, opacity: 1 } satisfies InkObj,
    { id: "st", type: "stamp", x: 300, y: 300, w: 90, h: 36, text: "承認", color: "#d6334a", font: "gothic", fontSize: 18, rotation: -8, opacity: 0.9 } satisfies StampObj,
  ];
  const bytes = await buildPdf([{ ...p, objects: objs }], new Map([[doc.id, doc]]), new Map());
  const lib = await PDFDocument.load(bytes);
  const annots = lib.getPage(0).node.Annots();
  assert.ok(annots instanceof PDFArray);
  const subtypes = annots
    .asArray()
    .map((r) => lib.context.lookup(r))
    .filter((d): d is PDFDict => d instanceof PDFDict)
    .map((d) => (d.get(PDFName.of("Subtype")) as PDFName).decodeText());
  assert.deepEqual(subtypes.sort(), ["Highlight", "Ink", "Popup", "StrikeOut", "Text", "Underline"]);
  // 外観ストリームが付いている
  for (const r of annots.asArray()) {
    const d = lib.context.lookup(r) as PDFDict;
    if ((d.get(PDFName.of("Subtype")) as PDFName).decodeText() !== "Popup") assert.ok(d.has(PDFName.of("AP")), "AP が無い");
  }
  // pdf.js でも注釈として読める。スタンプは内容として描かれ、文字が抽出できる
  const pdf = await openPdf(bytes);
  const page = await pdf.getPage(1);
  const list = await page.getAnnotations();
  assert.ok(list.some((a) => a.subtype === "Text" && a.contentsObj?.str === "確認してください"), JSON.stringify(list.map((a) => a.subtype)));
  assert.ok((await pageText(pdf, 1)).includes("承認"));
  await renderPage(pdf, 1, 1);
});

test("元 PDF の注釈を外す設定", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "ja-subset-identity.pdf"));
  const p = pages[0];
  const objs: PageItem["objects"] = [{ id: "n", type: "note", x: 400, y: 80, color: "#ffd43b", contents: "残る付箋", author: "" } satisfies NoteObj];
  const settings = { ...defaultSettings(), stripAnnotations: true };
  const bytes = await buildPdf([{ ...p, objects: objs }], new Map([[doc.id, doc]]), new Map(), { settings });
  const lib = await PDFDocument.load(bytes);
  const annots = lib.getPage(0).node.Annots();
  assert.ok(annots instanceof PDFArray && annots.size() === 2, "自分で付けた付箋（本体とポップアップ）だけが残る");
});

test("フォーム入力：入力欄を読み、値を書き込み、固定化できる", async () => {
  // pdf-lib でフォーム付きの PDF を作る
  const src = await PDFDocument.create();
  const page = src.addPage([400, 300]);
  const form = src.getForm();
  const name = form.createTextField("name");
  name.addToPage(page, { x: 50, y: 200, width: 200, height: 24 });
  const agree = form.createCheckBox("agree");
  agree.addToPage(page, { x: 50, y: 150, width: 20, height: 20 });
  const color = form.createDropdown("color");
  color.addOptions(["red", "blue"]);
  color.addToPage(page, { x: 50, y: 100, width: 120, height: 24 });
  const bytes = await src.save();
  const fields = await readFormFields(bytes);
  assert.deepEqual(fields.map((f) => `${f.name}:${f.kind}`), ["name:text", "agree:checkbox", "color:dropdown"]);
  const filled = await fillForm(bytes, { name: "山田 太郎", agree: true, color: "blue" }, false);
  const again = await readFormFields(filled);
  assert.equal(again.find((f) => f.name === "name")?.value, "山田 太郎");
  assert.equal(again.find((f) => f.name === "agree")?.value, true);
  assert.equal(again.find((f) => f.name === "color")?.value, "blue");
  const flat = await fillForm(bytes, { name: "固定" }, true);
  assert.equal((await readFormFields(flat)).length, 0, "フラット化後は入力欄が無い");
});

test("入力欄：文字数の上限がある欄は、上限までが入る（丸ごと捨てない）", async () => {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const f = doc.getForm().createTextField("code");
  f.setMaxLength(4);
  f.addToPage(page, { x: 20, y: 100, width: 100, height: 20 });
  const bytes = await doc.save();
  const info = (await readFormFields(bytes)).find((x) => x.name === "code")!;
  assert.equal(info.maxLength, 4);
  const out = await fillForm(bytes, { code: "ABCDEFG" }, false);
  assert.equal((await readFormFields(out)).find((x) => x.name === "code")!.value, "ABCD");
});

test("フォーム：保存しても入力欄（/AcroForm）が残り、値もそのまま。ページを並べ替え・削除しても、残ったページの入力欄だけが一覧に入る。言語（/Lang）も残る", async () => {
  const { PDFDocument, PDFName, PDFString } = await import("pdf-lib");
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { root, loadSource } = await import("./helpers");
  const { buildPdf } = await import("@/lib/exportPdf");
  const { defaultSettings } = await import("@/lib/docOps");
  const src = await PDFDocument.create();
  const form = src.getForm();
  for (let i = 0; i < 2; i++) {
    const page = src.addPage([400, 300]);
    const f = form.createTextField(`name${i + 1}`);
    f.addToPage(page, { x: 50, y: 200, width: 200, height: 24 });
  }
  form.createCheckBox("agree").addToPage(src.getPage(0), { x: 50, y: 150, width: 20, height: 20 });
  src.catalog.set(PDFName.of("Lang"), PDFString.of("ja"));
  const filled = await fillForm(await src.save(), { name1: "山田", name2: "佐藤", agree: true }, false);
  mkdirSync(join(root, "dist", ".test-out"), { recursive: true });
  const file = join(root, "dist", ".test-out", "form-source.pdf");
  writeFileSync(file, filled);
  const { doc, pages } = await loadSource(file);
  const save = (list: typeof pages) => buildPdf(list, new Map([[doc.id, doc]]), new Map(), { settings: defaultSettings() });
  // そのまま保存
  const all = await readFormFields(await save(pages));
  assert.deepEqual(all.map((f) => `${f.name}=${f.value}`).sort(), ["agree=true", "name1=山田", "name2=佐藤"]);
  // 2 ページ目だけを残す：一覧には 2 ページ目の入力欄だけ
  const second = await readFormFields(await save([pages[1]]));
  assert.deepEqual(second.map((f) => f.name), ["name2"]);
  // 言語
  const out = await PDFDocument.load(await save(pages));
  assert.equal((out.catalog.lookup(PDFName.of("Lang")) as unknown as { decodeText(): string } | undefined)?.decodeText(), "ja");
});

test("タグ付きの PDF：開いて保存しても、タグ（構造）と MarkInfo が残り、ページが複製されない。ページを削ったときは引き継がない", async () => {
  const { PDFDocument, PDFName, PDFDict, PDFRef } = await import("pdf-lib");
  const { join } = await import("node:path");
  const { fixtures, loadSource } = await import("./helpers");
  const { buildPdf } = await import("@/lib/exportPdf");
  const { defaultSettings } = await import("@/lib/docOps");
  // LibreOffice の出力（タグ付き・1 ページ）
  const { doc, pages } = await loadSource(join(fixtures, "rtl-libreoffice-type3-ar.pdf"));
  const out = await PDFDocument.load(await buildPdf(pages, new Map([[doc.id, doc]]), new Map(), { settings: defaultSettings() }));
  assert.ok(out.catalog.get(PDFName.of("StructTreeRoot")), "タグが無い");
  assert.ok(out.catalog.get(PDFName.of("MarkInfo")), "MarkInfo が無い");
  // ページの辞書は 1 つだけ（タグが指すページが複製されていない）。タグの /Pg は保存したページを指す
  let pageObjs = 0;
  const pgRefs = new Set<string>();
  for (const [, obj] of out.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    if (obj.get(PDFName.of("Type")) === PDFName.of("Page")) pageObjs++;
    const pg = obj.get(PDFName.of("Pg"));
    if (pg instanceof PDFRef) pgRefs.add(pg.toString());
  }
  assert.equal(pageObjs, 1);
  assert.ok(pgRefs.size >= 1 && [...pgRefs].every((r) => r === out.getPage(0).ref.toString()), [...pgRefs].join(","));
});

test("リストボックス：選んだ行の色の帯が、その行の文字に重なる（和文フォントでもずれない）", async () => {
  const { PDFDocument } = await import("pdf-lib");
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { root, openPdf, renderPage } = await import("./helpers");
  const d = await PDFDocument.create();
  const fontkit = (await import("@pdf-lib/fontkit")).default;
  d.registerFontkit(fontkit);
  const jf = await d.embedFont(readFileSync(join(root, "assets", "fonts", "BIZUDPGothic-Regular.ttf")), { subset: true });
  const page = d.addPage([300, 300]);
  const list = d.getForm().createOptionList("dept");
  list.addOptions(["総務", "製造", "品証", "営業"]);
  list.addToPage(page, { x: 40, y: 120, width: 160, height: 90, font: jf });
  d.getForm().updateFieldAppearances(jf);
  const out = await fillForm(await d.save({ updateFieldAppearances: false }), { dept: "品証" }, false);
  const img = await renderPage(await openPdf(out), 1, 2);
  // 色の帯の行の範囲と、その範囲の中で文字（黒い画素）のある行の範囲
  const px = (x: number, y: number) => img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3);
  const isBlue = (p: Uint8Array | Uint8ClampedArray) => Math.abs(p[0] - 153) < 20 && Math.abs(p[1] - 193) < 20 && Math.abs(p[2] - 218) < 20;
  const isInk = (p: Uint8Array | Uint8ClampedArray) => p[0] < 90 && p[1] < 90 && p[2] < 90;
  const bandRows: number[] = [];
  for (let y = 0; y < img.height; y++) if (isBlue(px(300, y))) bandRows.push(y);
  assert.ok(bandRows.length > 10, "選んだ行の色の帯が無い");
  const [b0, b1] = [bandRows[0], bandRows[bandRows.length - 1]];
  const inkRows: number[] = [];
  for (let y = b0 - 30; y <= b1 + 30; y++) {
    let ink = false;
    for (let x = 84; x < 200 && !ink; x++) ink = isInk(px(x, y));
    if (ink) inkRows.push(y);
  }
  // 文字の行（黒い画素のある行の、続いている範囲）が、帯の上の端・下の端をまたがない（帯がちょうど 1 行分を覆う）
  const runs: [number, number][] = [];
  for (const y of inkRows) {
    const last = runs[runs.length - 1];
    if (last && y === last[1] + 1) last[1] = y;
    else runs.push([y, y]);
  }
  const crosses = runs.filter(([s0, e0]) => (s0 < b0 && e0 >= b0) || (s0 <= b1 && e0 > b1));
  assert.deepEqual(crosses, [], JSON.stringify({ band: [b0, b1], runs }));
  const inside = runs.find(([s0, e0]) => s0 >= b0 && e0 <= b1);
  assert.ok(inside, "帯の中に文字が無い");
  // 文字は帯の上下の中央：上の余白と下の余白がほぼ同じ（どちらも 1 画素以上）
  const [gapTop, gapBottom] = [inside[0] - b0, b1 - inside[1]];
  assert.ok(gapTop >= 1 && gapBottom >= 1 && Math.abs(gapTop - gapBottom) <= 3, JSON.stringify({ band: [b0, b1], runs }));
});

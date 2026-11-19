// 編集画面で置いた入力欄（FieldObj）を、PDF の入力欄（フォーム）として書く
import { degrees, PDFArray, PDFDict, type PDFDocument, type PDFFont, PDFHexString, PDFName, type PDFObject, type PDFPage, type PDFRadioGroup, PDFRef, PDFString, rgb } from "pdf-lib";
import { tr } from "./i18n";
import { userRect } from "./annots";
import { defaultFont, loadFontBytes } from "./fonts";
import { embedSubsetFont, finishSubsetFonts } from "./pdfFont";
import type { FieldObj, PageItem } from "./types";

export async function writeFields(out: PDFDocument, entries: { page: PDFPage; item: PageItem; obj: FieldObj }[]): Promise<void> {
  if (!entries.length) return;
  const form = out.getForm();
  // 選択肢の文字（和文など）を書けるフォント：選択肢に欧文以外があるときだけ、使う字だけを埋め込む
  const optionText = entries.flatMap((e) => (e.obj.kind === "dropdown" ? e.obj.options : [])).join("");
  let font: PDFFont | undefined;
  if (/[^ -~]/.test(optionText)) {
    const fontkit = (await import("@pdf-lib/fontkit")).default;
    out.registerFontkit(fontkit);
    font = await embedSubsetFont(out, await loadFontBytes(defaultFont("sans")), `${optionText} 0123456789`);
  }
  // 元の文書の入力欄の名前（ページと一緒に写した入力欄。文書の入力欄の一覧はまだ無いので、ページから集める）
  const used = new Set(form.getFields().map((f) => f.getName()));
  for (const page of out.getPages()) {
    const annots = page.node.lookup(PDFName.of("Annots"));
    if (!(annots instanceof PDFArray)) continue;
    for (const a of annots.asArray()) {
      let d = a instanceof PDFRef ? out.context.lookup(a) : a;
      for (let depth = 0; d instanceof PDFDict && depth < 20; depth++) {
        const parent: PDFObject | undefined = d.get(PDFName.of("Parent"));
        const pd: PDFObject | undefined = parent instanceof PDFRef ? out.context.lookup(parent) : undefined;
        if (!(pd instanceof PDFDict)) break;
        d = pd;
      }
      const tname = d instanceof PDFDict ? d.lookup(PDFName.of("T")) : undefined;
      if (tname instanceof PDFString || tname instanceof PDFHexString) used.add(tname.decodeText());
    }
  }
  for (const { page, item, obj } of entries) {
    // ラジオボタンは下でまとめて書く（同じ名前の欄が 1 つの組になるので、名前に番号を足さない）
    if (obj.kind === "radio") continue;
    // 名前の「.」は入れ子の区切りになるので使わない。重なる名前には番号を足す
    const base = (obj.name.trim() || "field").replace(/\./g, "_");
    let name = base;
    for (let k = 2; used.has(name); k++) name = `${base}_${k}`;
    used.add(name);
    const [x0, y0, x1, y1] = userRect(item, obj.x, obj.y, obj.w, obj.h);
    // 回転したページでは、欄の中身（文字・印）も画面の向きに合わせて回す
    const box = { ...widgetBox(x0, y0, x1, y1, pageRotation(page)), borderWidth: 1, borderColor: rgb(0.55, 0.6, 0.7), rotate: degrees(pageRotation(page)) };
    if (obj.kind === "signature") {
      addSignatureField(out, page, name, [x0, y0, x1, y1]);
    } else if (obj.kind === "checkbox") {
      form.createCheckBox(name).addToPage(page, box);
    } else if (obj.kind === "dropdown") {
      const d = form.createDropdown(name);
      const options = obj.options.map((o) => o.trim()).filter(Boolean);
      if (options.length) d.addOptions(options);
      d.addToPage(page, { ...box, font });
    } else {
      const f = form.createTextField(name);
      if (obj.kind === "multiline") f.enableMultiline();
      // 日付：書き方の説明（ほかのソフトで欄に指を置く・カーソルを重ねると出る）。書式を強制するスクリプトは入れない
      if (obj.kind === "date") f.acroField.dict.set(PDFName.of("TU"), PDFHexString.fromText(tr("field.dateTip")));
      f.addToPage(page, box);
    }
  }
  // ラジオボタン：名前ごとに組を作り、欄ごとに選択肢（値）を足す
  const groups = new Map<string, PDFRadioGroup>();
  for (const { page, item, obj } of entries) {
    if (obj.kind !== "radio") continue;
    const key = (obj.name.trim() || "radio").replace(/\./g, "_");
    let g = groups.get(key);
    if (!g) {
      let name = key;
      for (let k = 2; used.has(name); k++) name = `${key}_${k}`;
      used.add(name);
      g = form.createRadioGroup(name);
      groups.set(key, g);
    }
    const [x0, y0, x1, y1] = userRect(item, obj.x, obj.y, obj.w, obj.h);
    g.addOptionToPage((obj.value ?? "").trim() || String(g.getOptions().length + 1), page, { ...widgetBox(x0, y0, x1, y1, pageRotation(page)), borderWidth: 1, borderColor: rgb(0.55, 0.6, 0.7), rotate: degrees(pageRotation(page)) });
  }
  if (font) {
    form.updateFieldAppearances(font);
    await finishSubsetFonts(out, [font]);
  }
}

/** ページの /Rotate（0・90・180・270） */
const pageRotation = (page: PDFPage) => (((page.getRotation().angle % 360) + 360) % 360);

/**
 * pdf-lib の addToPage に渡す位置と大きさ。回転を付けると pdf-lib は欄の矩形を回して置く（90° なら幅と高さを入れ替え、
 * 左へずらす）ので、PDF の中の矩形が [x0, y0, x1, y1] になるように逆算する
 */
function widgetBox(x0: number, y0: number, x1: number, y1: number, rot: number) {
  const W = Math.max(4, x1 - x0);
  const H = Math.max(4, y1 - y0);
  if (rot === 90) return { x: x0 + W, y: y0, width: H, height: W };
  if (rot === 180) return { x: x0 + W, y: y0 + H, width: W, height: H };
  if (rot === 270) return { x: x0, y: y0 + H, width: H, height: W };
  return { x: x0, y: y0, width: W, height: H };
}

/** 署名欄（空の /Sig の入力欄）。pdf-lib には作る関数が無いので、入力欄の辞書を直接作る（文書の入力欄の一覧には、保存のときに入る） */
function addSignatureField(out: PDFDocument, page: PDFPage, name: string, rect: [number, number, number, number]) {
  const ctx = out.context;
  const widget = ctx.obj({ Type: "Annot", Subtype: "Widget", FT: "Sig", T: PDFHexString.fromText(name), Rect: rect, F: 4, P: page.ref, MK: { BC: [0.55, 0.6, 0.7] }, BS: { W: 1 } });
  const ref = ctx.register(widget);
  const annots = page.node.lookup(PDFName.of("Annots"));
  if (annots instanceof PDFArray) annots.push(ref);
  else page.node.set(PDFName.of("Annots"), ctx.obj([ref]));
}

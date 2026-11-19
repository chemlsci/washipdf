/** AcroForm の入力欄を読み、値を書き込む（元 PDF のバイト列を書き換える） */
import { hasOwn } from "./safeObject";
import {
  adjustDimsForRotation,
  type AppearanceProviderFor,
  beginMarkedContent,
  clip,
  closePath,
  componentsToColor,
  degrees,
  drawRectangle,
  drawTextLines,
  endMarkedContent,
  endPath,
  layoutMultilineText,
  lineTo,
  moveTo,
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  PDFArray,
  PDFName,
  PDFRef,
  popGraphicsState,
  pushGraphicsState,
  reduceRotation,
  rgb,
  rotateInPlace,
  TextAlignment,
} from "pdf-lib";
import { defaultFont, loadFontBytes } from "./fonts";
import { embedSubsetFont, finishSubsetFonts } from "./pdfFont";

export interface FormFieldInfo {
  name: string;
  kind: "text" | "checkbox" | "radio" | "dropdown" | "list" | "other";
  value: string | boolean;
  options?: string[];
  multiline?: boolean;
  /** 文字の欄の、入れられる文字数の上限（決まっていれば） */
  maxLength?: number;
}

export async function readFormFields(bytes: Uint8Array): Promise<FormFieldInfo[]> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const out: FormFieldInfo[] = [];
  for (const f of doc.getForm().getFields()) {
    const name = f.getName();
    if (f instanceof PDFTextField) out.push({ name, kind: "text", value: f.getText() ?? "", multiline: f.isMultiline(), maxLength: f.getMaxLength() });
    else if (f instanceof PDFCheckBox) out.push({ name, kind: "checkbox", value: f.isChecked() });
    else if (f instanceof PDFRadioGroup) out.push({ name, kind: "radio", value: f.getSelected() ?? "", options: f.getOptions() });
    else if (f instanceof PDFDropdown) out.push({ name, kind: "dropdown", value: f.getSelected()[0] ?? "", options: f.getOptions() });
    else if (f instanceof PDFOptionList) out.push({ name, kind: "list", value: f.getSelected()[0] ?? "", options: f.getOptions() });
    else out.push({ name, kind: "other", value: "" });
  }
  return out;
}

/** 値を書き込んだ新しい PDF を返す。flatten なら入力欄を固定化する */
export async function fillForm(bytes: Uint8Array, values: Record<string, string | boolean>, flatten: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const form = doc.getForm();
  // 見た目（外観）の生成には日本語が書けるフォントが要る。入力した文字と選択肢の文字を集めてサブセットを埋め込む
  const fontkit = (await import("@pdf-lib/fontkit")).default;
  doc.registerFontkit(fontkit);
  let text = Object.values(values)
    .map((v) => (typeof v === "string" ? v : ""))
    .join("");
  for (const f of form.getFields()) if (f instanceof PDFTextField) text += f.getText() ?? "";
  for (const f of form.getFields()) if (f instanceof PDFDropdown || f instanceof PDFOptionList || f instanceof PDFRadioGroup) text += f.getOptions().join("");
  text += " 0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const font = await embedSubsetFont(doc, await loadFontBytes(defaultFont("sans")), text);
  let n = 0;
  for (const f of form.getFields()) {
    const name = f.getName();
    // 欄の名前は PDF に書かれた文字列。自分で持っている項目だけを見る
    // （in で調べると、"constructor" のような名前の欄が、どのオブジェクトにもある関数を値として拾ってしまう）
    if (!hasOwn(values, name)) continue;
    const v = values[name];
    try {
      if (f instanceof PDFTextField) {
        // 文字数の上限がある欄は、上限までを入れる（超えた値を渡すと丸ごと入らないため。画面の入力欄でも上限を掛けている）
        const max = f.getMaxLength();
        const chars = [...String(v)];
        f.setText(max !== undefined && chars.length > max ? chars.slice(0, max).join("") : String(v));
      }
      else if (f instanceof PDFCheckBox) (v ? f.check() : f.uncheck());
      else if (f instanceof PDFRadioGroup) {
        if (v) f.select(String(v));
      } else if (f instanceof PDFDropdown) {
        if (v) f.select(String(v));
      } else if (f instanceof PDFOptionList) {
        if (v) f.select(String(v));
      } else continue;
      n++;
    } catch {
      /* 値が選択肢に無いなど。その項目は飛ばす */
    }
  }
  form.updateFieldAppearances(font);
  // リストボックスは、行の高さを 1 つに決めて描き直す（pdf-lib の既定では、和文フォントで選んだ行の色の帯が文字とずれる）
  for (const f of form.getFields()) if (f instanceof PDFOptionList) f.updateAppearances(font, optionListAppearance);
  if (flatten) {
    form.flatten();
    // 固定化で消した欄への参照が、ページの注釈の一覧（/Annots）に残らないようにする
    for (const page of doc.getPages()) {
      const annots = page.node.lookup(PDFName.of("Annots"));
      if (!(annots instanceof PDFArray)) continue;
      const keep = annots.asArray().filter((a) => !(a instanceof PDFRef) || doc.context.lookup(a) !== undefined);
      if (keep.length !== annots.size()) page.node.set(PDFName.of("Annots"), doc.context.obj(keep));
    }
  }
  await finishSubsetFonts(doc, [font]);
  return doc.save({ useObjectStreams: true });
}

/**
 * リストボックスの見た目：枠・背景、選んだ行の色の帯、選択肢の文字。
 * 行ごとに「行の上端〜下端」を 1 つの高さで決め、帯はその行の全体に、文字はその行の上下の中央に置く
 */
const optionListAppearance: AppearanceProviderFor<PDFOptionList> = (list, widget, font) => {
  const rect = widget.getRectangle();
  const ap = widget.getAppearanceCharacteristics();
  const borderWidth = widget.getBorderStyle()?.getWidth() ?? 0;
  const rotation = reduceRotation(ap?.getRotation());
  const { width, height } = adjustDimsForRotation(rect, rotation);
  const options = list.getOptions();
  if (list.isSorted()) options.sort();
  const selected = list.getSelected();
  const padding = 1;
  const bounds = { x: borderWidth + padding, y: borderWidth + padding, width: width - (borderWidth + padding) * 2, height: height - (borderWidth + padding) * 2 };
  const { lines, fontSize, lineHeight } = layoutMultilineText(options.join("\n"), { alignment: TextAlignment.Left, fontSize: undefined, font, bounds });
  const top = bounds.y + bounds.height;
  // 文字は、字の枠（1 em：ベースラインの下 0.12 em 〜 上 0.88 em。和文の字と欧文の大文字・小文字がおおむね収まる）を行の上下の中央に置く
  const rows = lines.map((line, i) => {
    const rowTop = top - i * lineHeight;
    const rowBottom = rowTop - lineHeight;
    return { line: { ...line, y: rowBottom + (lineHeight - fontSize) / 2 + fontSize * 0.12 }, rowBottom };
  });
  const textColor = rgb(0, 0, 0);
  list.acroField.setDefaultAppearance(`0 g\n/${font.name} ${fontSize} Tf`);
  const highlights = rows
    .filter((r) => selected.includes(r.line.text))
    .flatMap((r) =>
      drawRectangle({ x: borderWidth, y: r.rowBottom, width: width - borderWidth * 2, height: lineHeight, borderWidth: 0, color: rgb(153 / 255, 193 / 255, 218 / 255), borderColor: undefined, rotate: degrees(0), xSkew: degrees(0), ySkew: degrees(0) }),
    );
  const clipX = borderWidth / 2 + padding;
  const clipY = borderWidth / 2 + padding;
  const clipW = width - (borderWidth / 2 + padding) * 2;
  const clipH = height - (borderWidth / 2 + padding) * 2;
  return [
    ...rotateInPlace({ ...rect, rotation }),
    ...drawRectangle({ x: 0, y: 0, width, height, borderWidth, color: componentsToColor(ap?.getBackgroundColor()), borderColor: componentsToColor(ap?.getBorderColor()), rotate: degrees(0), xSkew: degrees(0), ySkew: degrees(0) }),
    beginMarkedContent("Tx"),
    pushGraphicsState(),
    moveTo(clipX, clipY),
    lineTo(clipX, clipY + clipH),
    lineTo(clipX + clipW, clipY + clipH),
    lineTo(clipX + clipW, clipY),
    closePath(),
    clip(),
    endPath(),
    ...highlights,
    ...drawTextLines(
      rows.map((r) => r.line),
      { color: textColor, font: font.name, size: fontSize, rotate: degrees(0), xSkew: degrees(0), ySkew: degrees(0) },
    ),
    popGraphicsState(),
    endMarkedContent(),
  ];
};

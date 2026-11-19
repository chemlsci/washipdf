/** 編集画面でのプレビュー用レイアウト（保存時と同じ layoutEdit を、同じ字幅で計算する） */
import { fallbackKey } from "./exportPdf";
import { measureBundled } from "./fonts";
import type { LayoutResult } from "./layout";
import { analyzePage } from "./libDoc";
import { samePath } from "./textOps";
import { layoutEdit, originalWriter, type TextWriter } from "./textEdit";
import type { SourceDoc, TextEditObj } from "./types";
import { layoutVertical, verticalFontMeasurer, verticalMeasurer } from "./verticalText";

/** 字幅だけ分かればよいので、同梱フォントの測定だけを持つ writer */
function bundledMeasureWriter(o: TextEditObj): TextWriter {
  const key = fallbackKey(o);
  return {
    resName: "",
    simple: false,
    encode: () => "",
    width: (t, s) => measureBundled(key, t, s),
    canWrite: () => true,
  };
}

/** 保存時に実際に使われる筆（元フォントが使えなければ同梱フォント） */
export async function writerFor(o: TextEditObj, source: SourceDoc | undefined, srcIndex: number): Promise<{ writer: TextWriter; usesOriginal: boolean }> {
  if (o.font === "original" && o.fontResName && source) {
    const a = await analyzePage(source, srcIndex);
    const show = a.shows.find((s) => s.index === o.removals[0]?.index && samePath(s.path, o.removals[0]?.path) && s.font);
    if (show?.font) {
      const w = originalWriter(o.fontResName, show.font);
      if (w.canWrite(o.text.replace(/\s/g, ""))) return { writer: w, usesOriginal: true };
    }
  }
  return { writer: bundledMeasureWriter(o), usesOriginal: false };
}

export interface PreviewLayout extends LayoutResult {
  usesOriginal: boolean;
}

export async function previewLayout(o: TextEditObj, source: SourceDoc | undefined, srcIndex: number): Promise<PreviewLayout> {
  const { writer, usesOriginal } = await writerFor(o, source, srcIndex);
  if (o.vertical) {
    // 縦書き：列の長さ（箱の高さ）と列数に流し込む。元の縦書きフォントなら 1 文字 1 em、同梱フォントなら回転・縦中横を含めた長さ
    const m = usesOriginal ? verticalFontMeasurer : verticalMeasurer(fallbackKey(o));
    return { ...layoutVertical(o.text, o.fontSize, o.h, o.lines, m), usesOriginal };
  }
  return { ...layoutEdit(o, writer), usesOriginal };
}

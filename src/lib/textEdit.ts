/**
 * 既存テキストの実編集を PDF に適用する。
 *  1. removeOriginalText … 元の文字描画命令をコンテンツストリームから取り除く（進み量だけ残す）
 *  2. drawTextEdits      … 新しい文字を元の位置・色・フォント設定で書き込む（箱内リフロー付き）
 */
import { type PDFDocument, type PDFFont, PDFName, type PDFPage } from "pdf-lib";
import { fmt, hex, spliceContent, tokenizeContent } from "./contentStream";
import { bundledCapHeight, measureBundled } from "./fonts";
import { isShapingFont, shapedShowOps } from "./shape";
import { tr, AppError } from "./i18n";
import { apply, invert } from "./geometry";
import { fitText, type LayoutResult, type Measurer } from "./layout";
import { pageContentBytes } from "./libDoc";
import { type FontInfo, fontCapHeight } from "./pdfFontInfo";
import type { FontKey, PageItem, TextEditObj } from "./types";

/** 文字を書くための「筆」。同梱フォント（pdf-lib の PDFFont）か、元 PDF のフォント */
export interface TextWriter {
  /** ページリソース上のフォント名（"/F1" の F1） */
  resName: string;
  /** 1バイト文字コードのフォントか（Tw がそのまま効く） */
  simple: boolean;
  /** テキスト → PDF 文字列（"<...>" または "(...)"） */
  encode(text: string): string;
  /** 文字列の幅（pt、文字間隔を含まない） */
  width(text: string, size: number): number;
  canWrite(text: string): boolean;
  /**
   * 書いた文字コードのうち、フォントの文字対応表（ToUnicode）に載っていないもの（文字コード → 文字）。
   * 元の文書で使っていなかった字を元フォントで書いたときに入る。対応表に足さないと、書いた字を検索・コピーできない
   */
  unmapped?: Map<number, string>;
  /** 大文字の高さ（em に対する比）。分かるときだけ。別のフォントの字を混ぜるとき、見た目の大きさをそろえるのに使う */
  capHeight?: number | null;
  /** 1 行分の描画命令を丸ごと作る（整形が必要なフォント）。無ければ encode + Tj/TJ。base は行の向き（行の一部だけを書くとき） */
  show?(text: string, size: number, wordSpacing: number, base?: "L" | "R"): string;
}

/** resName を渡すと、ページへのフォントの登録はしない（呼び出し側が、その名前で登録する） */
export function bundledWriter(page: PDFPage | null, key: FontKey, font: PDFFont, name?: string): TextWriter {
  const resName = name ?? page!.node.newFontDictionary(font.name, font.ref).decodeText();
  return {
    resName,
    simple: false,
    encode: (t) => font.encodeText(t).toString(),
    width: (t, s) => measureBundled(key, t, s),
    canWrite: () => true,
    capHeight: bundledCapHeight(key),
    show: isShapingFont(key) ? (t, s, ws, base) => shapedShowOps(key, t, s, ws, base) : undefined,
  };
}

/** 空白の字形を持たないフォント（空白を位置の調整で表している PDF）で、空白 1 つに充てる幅（1000 分率） */
const GAP_SPACE = 280;

export function originalWriter(resName: string, info: FontInfo): TextWriter {
  const hasSpace = info.encode(32) !== null && (info.widthOfCodePoint(32) ?? 0) > 0;
  const unmapped = new Map<number, string>();
  const enc = (t: string) => {
    const parts: number[] = [];
    for (const ch of t) {
      const b = info.encode(ch.codePointAt(0)!);
      if (!b) continue;
      parts.push(...b);
      if (info.kind === "type0" && b.length === 2) {
        const code = (b[0] << 8) | b[1];
        if (info.toUnicode({ code, cid: code, nbytes: 2, isSpace: false }) !== ch) unmapped.set(code, ch);
      }
    }
    return hex(Uint8Array.from(parts));
  };
  return {
    unmapped,
    capHeight: fontCapHeight(info),
    resName,
    simple: info.kind !== "type0",
    encode: enc,
    width: (t, s) => {
      let w = 0;
      for (const ch of t) w += (ch === " " && !hasSpace ? GAP_SPACE : (info.widthOfCodePoint(ch.codePointAt(0)!) ?? 0)) / 1000;
      return w * s;
    },
    canWrite: (t) => [...t].every((ch) => info.encode(ch.codePointAt(0)!) !== null),
    // 空白の字形が無いときは、空白の分だけ位置を進める（字形を書こうとすると、空白が詰まって語がつながる）
    show: hasSpace
      ? undefined
      : (t, s, ws) => {
          if (!t.includes(" ")) return `${enc(t)} Tj`;
          const adj = fmt(-(GAP_SPACE + (ws / s) * 1000));
          const items: string[] = [];
          t.split(" ").forEach((p, i, all) => {
            if (p) items.push(enc(p));
            if (i < all.length - 1) items.push(adj);
          });
          return `[${items.join(" ")}] TJ`;
        },
  };
}

/** 文字間隔・単語間隔・水平拡大率を含めた幅を返す Measurer */
export function measurerFor(w: TextWriter, e: Pick<TextEditObj, "charSpacing" | "wordSpacing" | "hscale">): Measurer {
  return {
    width: (text, size) => {
      const n = [...text].length;
      const spaces = (text.match(/ /g) ?? []).length;
      return (w.width(text, size) + e.charSpacing * n + e.wordSpacing * spaces) * e.hscale;
    },
  };
}

/** 新しい文字列をブロックに収めるレイアウト（UI と保存で同じ関数を使う） */
export function layoutEdit(e: TextEditObj, w: TextWriter): LayoutResult {
  const m = measurerFor(w, e);
  // 幅は元ブロックの幅＋わずかな余裕（元の行は末尾に空白が落ちていることがある）
  return fitText(e.text, e.fontSize, e.w + e.fontSize * 0.15, Math.max(1, e.lines), m);
}

/* ---------- 1. 元の文字描画命令を消す ---------- */

export function removeOriginalText(doc: PDFDocument, page: PDFPage, edits: TextEditObj[]): void {
  const bytes = pageContentBytes(doc, page);
  const ops = tokenizeContent(bytes);
  const seen = new Set<number>();
  const splices: { start: number; end: number; text: string }[] = [];
  for (const e of edits) {
    for (const r of e.removals) {
      if (seen.has(r.index)) continue;
      seen.add(r.index);
      const op = ops[r.index];
      if (!op || op.op !== r.op) throw new AppError(tr("export.contentMismatch"));
      splices.push({ start: op.start, end: op.end, text: r.replacement ? `${r.replacement}\n` : "" });
    }
  }
  if (!splices.length) return;
  const next = spliceContent(bytes, splices);
  const stream = doc.context.flateStream(next);
  const ref = doc.context.register(stream);
  page.node.set(PDFName.of("Contents"), ref);
}

/* ---------- 2. 新しい文字を書く ---------- */

function colorOpsFromHex(hexColor: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hexColor.trim());
  if (!m) return "0 g";
  const n = parseInt(m[1], 16);
  return `${fmt(((n >> 16) & 255) / 255)} ${fmt(((n >> 8) & 255) / 255)} ${fmt((n & 255) / 255)} rg`;
}

/** 単語間隔を Type0 フォントでも効かせるため、空白の後ろに TJ の調整値を入れる */
function showOp(w: TextWriter, text: string, size: number, wordSpacing: number): string {
  if (!text) return "";
  if (w.show) return w.show(text, size, wordSpacing);
  if (w.simple || !wordSpacing || !text.includes(" ")) return `${w.encode(text)} Tj`;
  const adj = fmt((-wordSpacing / size) * 1000);
  const parts = text.split(" ");
  const items: string[] = [];
  parts.forEach((p, i) => {
    const seg = i < parts.length - 1 ? p + " " : p;
    if (seg) items.push(w.encode(seg));
    if (i < parts.length - 1) items.push(adj);
  });
  return `[${items.join(" ")}] TJ`;
}

export interface DrawResult {
  layout: LayoutResult;
  content: string;
}

/** 1つの編集の描画命令列を作る */
export function buildTextEditContent(item: PageItem, e: TextEditObj, w: TextWriter): DrawResult {
  const layout = layoutEdit(e, w);
  const M = invert(item.viewTransform);
  const theta = Math.atan2(M[1], M[0]);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const m = measurerFor(w, e);
  const size = layout.fontSize;
  const out: string[] = ["BT"];
  out.push(e.fillColorOps ?? colorOpsFromHex(e.color));
  if (e.renderMode === 1 || e.renderMode === 2) {
    out.push(e.strokeColorOps ?? colorOpsFromHex(e.color));
    out.push(`${e.renderMode} Tr`);
  }
  out.push(`/${w.resName} ${fmt(size)} Tf`);
  if (e.charSpacing) out.push(`${fmt(e.charSpacing)} Tc`);
  if (w.simple && e.wordSpacing) out.push(`${fmt(e.wordSpacing)} Tw`);
  if (Math.abs(e.hscale - 1) > 1e-6) out.push(`${fmt(e.hscale * 100)} Tz`);
  layout.lines.forEach((line, i) => {
    if (!line) return;
    const lw = m.width(line, size);
    let x = e.x;
    if (e.align === "center") x = e.x + (e.w - lw) / 2;
    else if (e.align === "right") x = e.x + e.w - lw;
    const y = e.baseline + i * e.lineHeight;
    const [ux, uy] = apply(M, x, y);
    out.push(`${fmt(cos)} ${fmt(sin)} ${fmt(-sin)} ${fmt(cos)} ${fmt(ux)} ${fmt(uy)} Tm`);
    out.push(showOp(w, line, size, w.simple ? 0 : e.wordSpacing));
  });
  out.push("ET");
  return { layout, content: out.join("\n") };
}

export function appendContent(doc: PDFDocument, page: PDFPage, content: string): void {
  const stream = doc.context.flateStream(`q\n${content}\nQ\n`);
  page.node.addContentStream(doc.context.register(stream));
}

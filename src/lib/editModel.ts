/** 既存テキストの編集オブジェクトを、解析した行（TextRun）から作る。UI と テストで共有する */
import { uid } from "./geometry";
import type { TextRun } from "./textRuns";
import type { FontKey, TextEditObj } from "./types";

const latinEnd = (s: string) => /[A-Za-z0-9,.;:)\]'"]$/.test(s);
const latinStart = (s: string) => /^[A-Za-z0-9(\['"]/.test(s);

/** 複数行を1つの文字列にする（和文はそのまま連結、欧文は空白で区切る） */
export function joinLines(lines: string[]): string {
  let out = "";
  for (const l of lines) {
    if (out && latinEnd(out) && latinStart(l)) out += " ";
    out += l;
  }
  return out;
}

export interface CreateEditOptions {
  /** プレビューで元の文字を隠す色 */
  cover: string;
  /** 色が命令から分からなかったときの文字色 */
  fallbackColor: string;
  /** 同梱フォントで書くときのフォント。省略時は元フォントが使えれば元フォント、無理なら推定した同梱フォント */
  font?: FontKey | "original";
}

/** 1行（または同じブロックの複数行）から編集オブジェクトを作る */
export function createTextEdit(runs: TextRun[], opts: CreateEditOptions): TextEditObj {
  const sorted = [...runs].sort((a, b) => a.lineIndex - b.lineIndex || a.baseline - b.baseline);
  const first = sorted[0];
  if (first.vertical) {
    // 縦書き：列は右（lineIndex 0）から左へ。箱は全列を含む範囲、列の間隔は検出した列送り（1 列なら 1.25 em）
    const r = first;
    const fontSize = Math.round(r.fontSize * 100) / 100;
    const last = sorted[sorted.length - 1];
    const x = Math.min(...sorted.map((c) => c.x));
    const right = Math.max(...sorted.map((c) => c.x + c.w));
    const top = Math.min(...sorted.map((c) => c.top));
    const bottom = Math.max(...sorted.map((c) => c.top + c.h));
    const lines = sorted.length;
    const pitch = lines > 1 ? (first.x - last.x) / (lines - 1) : fontSize * 1.25;
    const original = joinLines(sorted.map((c) => c.text));
    return {
      id: uid(),
      type: "textedit",
      x,
      y: top,
      w: right - x,
      h: bottom - top,
      baseline: top,
      source: lines === 1 ? { x, baseline: top, fontSize, room: bottom - top } : undefined,
      lineHeight: pitch,
      lines,
      removals: sorted.flatMap((c) => c.removals),
      original,
      text: original,
      fontSize,
      font: opts.font ?? (sorted.every((c) => c.originalFontUsable) && r.fontResName ? "original" : r.font),
      fontResName: r.fontResName,
      originalUsable: sorted.every((c) => c.originalFontUsable) && !!r.fontResName,
      srcFontName: r.srcFontName,
      family: r.family,
      color: r.color ?? opts.fallbackColor,
      fillColorOps: r.fillColorOps,
      strokeColorOps: r.strokeColorOps,
      renderMode: r.renderMode,
      charSpacing: 0,
      wordSpacing: 0,
      hscale: 1,
      align: "left",
      cover: opts.cover,
      vertical: true,
    };
  }
  const last = sorted[sorted.length - 1];
  const x = Math.min(...sorted.map((r) => r.x));
  const right = Math.max(...sorted.map((r) => r.x + r.w));
  const top = Math.min(...sorted.map((r) => r.top));
  const bottom = Math.max(...sorted.map((r) => r.top + r.h));
  const lines = sorted.length;
  const lineHeight = lines > 1 ? (last.baseline - first.baseline) / (lines - 1) : first.fontSize * 1.2;
  const fontSize = Math.round(first.fontSize * 100) / 100;
  // 揃え：全行の左端がそろっていれば左、右端なら右、どちらでもなければ中央
  let align: TextEditObj["align"] = "left";
  if (lines > 1) {
    const leftOk = sorted.every((r) => Math.abs(r.x - x) < fontSize * 0.6);
    const rightOk = sorted.every((r) => Math.abs(r.x + r.w - right) < fontSize * 0.6);
    align = leftOk ? "left" : rightOk ? "right" : "center";
  }
  const original = joinLines(sorted.map((r) => r.text));
  const font = opts.font ?? (sorted.every((r) => r.originalFontUsable) && first.fontResName ? "original" : first.font);
  return {
    id: uid(),
    type: "textedit",
    x,
    y: top,
    w: right - x,
    h: bottom - top,
    baseline: first.baseline,
    source: lines === 1 ? { x, baseline: first.baseline, fontSize, room: Math.max(right, first.blockRight ?? right) - x, roomLeft: first.blockLeft !== undefined ? Math.max(0, x - first.blockLeft) : undefined } : undefined,
    previewFont: first.previewFont,
    parts:
      lines > 1
        ? sorted.map((r) => ({
            text: r.text,
            x: r.x,
            top: r.top,
            w: r.w,
            h: r.h,
            baseline: r.baseline,
            fontSize: Math.round(r.fontSize * 100) / 100,
            fontResName: r.fontResName,
            removals: r.removals,
            fillColorOps: r.fillColorOps,
            strokeColorOps: r.strokeColorOps,
            renderMode: r.renderMode,
            charSpacing: r.charSpacing,
            wordSpacing: r.wordSpacing,
            hscale: r.hscale,
            previewFont: r.previewFont,
          }))
        : undefined,
    origin: lines > 1 ? { x, y: top, fontSize } : undefined,
    lineHeight,
    lines,
    removals: sorted.flatMap((r) => r.removals),
    original,
    text: original,
    fontSize,
    font,
    fontResName: first.fontResName,
    originalUsable: sorted.every((r) => r.originalFontUsable) && !!first.fontResName,
    complex: sorted.some((r) => r.complex) || undefined,
    rtl: lines === 1 ? first.rtl : undefined,
    srcFontName: first.srcFontName,
    family: first.family,
    color: first.color ?? opts.fallbackColor,
    fillColorOps: first.fillColorOps,
    strokeColorOps: first.strokeColorOps,
    renderMode: first.renderMode,
    charSpacing: first.charSpacing,
    wordSpacing: first.wordSpacing,
    hscale: first.hscale,
    align,
    cover: opts.cover,
  };
}

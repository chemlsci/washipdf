/**
 * 縦書き：列ごとに 1 文字ずつ上から下へ積む。欧文・長音・括弧は 90° 回して縦に並べ、句読点は右上に寄せる。
 * 1〜3 桁の数字（と「!?」の組）は縦中横（1 文字分の高さに横組みで収める）。4 桁以上は回転。
 * 同梱フォント（横書き用の Identity-H 埋め込み）で書けるよう、縦組み用フォントを使わずに位置で表す。
 * 元 PDF のフォントが縦書き（Identity-V 等）なら、そのフォントで列ごとにそのまま書く。
 *
 * 列の分割（列またぎの流し込み）は横書きと同じ fitText を使う：
 * 「行の幅」を「列の長さ」と読み替え、禁則・単語単位の折り返し・はみ出し時の縮小がそのまま効く。
 */
import type { PDFFont, PDFPage } from "pdf-lib";
import { fmt } from "./contentStream";
import { ASCENT, LINE_HEIGHT, measureBundled } from "./fonts";
import { apply, invert } from "./geometry";
import { fitText, type LayoutResult, type Measurer } from "./layout";
import { appendContent, bundledWriter, type TextWriter } from "./textEdit";
import type { FontKey, PageItem } from "./types";

/** 回して縦に並べる文字（欧文・数字・長音・ダッシュ・括弧類） */
const ROTATE = /[ -ɏ‐-―‥…〈-】〔-〛ー〜～（）［］｛｝─│]/;
/** 右上に寄せる句読点 */
const PUNCT = /[、。，．]/;
/** 少し右上に寄せる小書き仮名 */
const SMALL = /[ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ]/;
/** 縦中横にする並び：1〜3 桁の数字（1 桁は正立）、「!?」「!!」「??」 */
const TCY = /(?<![0-9])[0-9]{1,3}(?![0-9])|[!?]{2}/g;

export const isRotatedInVertical = (ch: string) => ROTATE.test(ch);

export interface VerticalUnit {
  text: string;
  kind: "upright" | "rotated" | "tcy";
}

/** 1 列の文字列を、縦に積む単位（1 文字、または縦中横の組）に分ける */
export function verticalUnits(text: string): VerticalUnit[] {
  const units: VerticalUnit[] = [];
  let last = 0;
  const pushChars = (s: string) => {
    for (const ch of s) units.push({ text: ch, kind: isRotatedInVertical(ch) ? "rotated" : "upright" });
  };
  for (const m of text.matchAll(TCY)) {
    pushChars(text.slice(last, m.index));
    units.push({ text: m[0], kind: "tcy" });
    last = m.index! + m[0].length;
  }
  pushChars(text.slice(last));
  return units;
}

/** 1 列に入る文字数で改行して列に分ける（先頭が右端の列）。各行は必ず 1 列以上になる */
export function verticalColumns(text: string, capacity: number): string[] {
  const cols: string[] = [];
  for (const line of text.split("\n")) {
    const chars = [...line];
    if (!chars.length) {
      cols.push("");
      continue;
    }
    const cap = Math.max(1, Math.floor(capacity));
    for (let i = 0; i < chars.length; i += cap) cols.push(chars.slice(i, i + cap).join(""));
  }
  return cols;
}

/** 同梱フォントで 1 列を積んだときの長さ（pt）。縦中横は 1 文字分 */
export function verticalLength(key: FontKey, text: string, fontSize: number): number {
  let y = 0;
  for (const u of verticalUnits(text)) y += u.kind === "rotated" ? measureBundled(key, u.text, fontSize) : fontSize;
  return y;
}

/** 列の長さを「幅」として返す Measurer（fitText に渡す） */
export function verticalMeasurer(key: FontKey): Measurer {
  return { width: (text, size) => verticalLength(key, text, size) };
}

/** 縦書きフォント（Identity-V）で書くときの Measurer：1 文字 = 1 em 送り */
export const verticalFontMeasurer: Measurer = { width: (text, size) => [...text.replace(/\n/g, "")].length * size };

/** 文字列を列に流し込む。収まらなければ fitText と同じ段階で縮小する */
export function layoutVertical(text: string, fontSize: number, maxLength: number, maxColumns: number, m: Measurer): LayoutResult {
  return fitText(text, fontSize, maxLength + fontSize * 0.02, Math.max(1, maxColumns), m);
}

export interface VerticalDrawOptions {
  /** 最初（右端）の列の中心 x と上端 y（表示座標） */
  cx: number;
  top: number;
  fontSize: number;
  /** 列の間隔（右から左へ） */
  pitch: number;
  color: [number, number, number];
}

const hexToRgb = (hex: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
export const colorTriple = hexToRgb;

/**
 * 同梱フォントで縦書きの列を描く命令列（columns[0] が右端）。
 * 1 文字ずつ Tm で位置を決める。回転する文字は 90° 時計回り、縦中横は Tz で 1 em に詰める。
 */
export function verticalColumnsBundledContent(item: PageItem, w: TextWriter, key: FontKey, columns: string[], o: VerticalDrawOptions): string {
  const M = invert(item.viewTransform);
  const theta = Math.atan2(M[1], M[0]);
  const fs = o.fontSize;
  const mat = (angle: number, x: number, y: number) => {
    const [ux, uy] = apply(M, x, y);
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return `${fmt(c)} ${fmt(s)} ${fmt(-s)} ${fmt(c)} ${fmt(ux)} ${fmt(uy)} Tm`;
  };
  const out = ["BT", `${o.color.map((v) => fmt(v)).join(" ")} rg`, `/${w.resName} ${fmt(fs)} Tf`];
  let hscale = 100;
  const setScale = (v: number) => {
    const s = Math.round(v * 10) / 10;
    if (Math.abs(s - hscale) > 0.05) {
      hscale = s;
      out.push(`${fmt(s)} Tz`);
    }
  };
  columns.forEach((col, ci) => {
    const cx = o.cx - ci * o.pitch;
    let y = o.top;
    for (const u of verticalUnits(col)) {
      if (u.kind === "rotated") {
        const adv = measureBundled(key, u.text, fs);
        if (!/^\s$/.test(u.text)) {
          setScale(100);
          // 90° 時計回り：字の進む向きが下、上辺が右を向く。字面の中心を列の中心に合わせる
          out.push(mat(theta - Math.PI / 2, cx - 0.38 * fs, y), `${w.encode(u.text)} Tj`);
        }
        y += adv;
        continue;
      }
      if (/^\s$/.test(u.text)) {
        y += fs;
        continue;
      }
      const wd = measureBundled(key, u.text, fs);
      let dx = -wd / 2;
      let dy = ASCENT * fs;
      if (u.kind === "tcy") {
        // 1 em より広ければ横に詰める（高さはそのまま）
        const scale = wd > fs ? fs / wd : 1;
        setScale(scale * 100);
        dx = (-wd * scale) / 2;
      } else {
        setScale(100);
        if (PUNCT.test(u.text)) {
          dx += 0.55 * fs;
          dy -= 0.55 * fs;
        } else if (SMALL.test(u.text)) {
          dx += 0.1 * fs;
          dy -= 0.1 * fs;
        }
      }
      out.push(mat(theta, cx + dx, y + dy), `${w.encode(u.text)} Tj`);
      y += fs;
    }
  });
  out.push("ET");
  return out.join("\n");
}

/** 同梱フォントで縦書きの列をページに描く（columns[0] が右端） */
export function drawVerticalColumns(page: PDFPage, item: PageItem, key: FontKey, font: PDFFont, columns: string[], o: VerticalDrawOptions): void {
  const w = bundledWriter(page, key, font);
  appendContent(page.doc, page, verticalColumnsBundledContent(item, w, key, columns, o));
}

/** 元 PDF の縦書きフォント（Identity-V など）で列を書く命令列 */
export function verticalColumnsContent(item: PageItem, w: TextWriter, columns: string[], o: { cx: number; top: number; fontSize: number; pitch: number; colorOps: string }): string {
  const M = invert(item.viewTransform);
  const theta = Math.atan2(M[1], M[0]);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const out = ["BT", o.colorOps, `/${w.resName} ${fmt(o.fontSize)} Tf`];
  columns.forEach((col, ci) => {
    if (!col) return;
    const [ux, uy] = apply(M, o.cx - ci * o.pitch, o.top);
    out.push(`${fmt(cos)} ${fmt(sin)} ${fmt(-sin)} ${fmt(cos)} ${fmt(ux)} ${fmt(uy)} Tm`);
    out.push(`${w.encode(col)} Tj`);
  });
  out.push("ET");
  return out.join("\n");
}

export const VERTICAL_PITCH = LINE_HEIGHT;

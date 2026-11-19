/**
 * 編集中の行を、PDF に埋め込まれているフォントそのもので画面に出すための情報。
 *
 * 表示側（pdf.js）は、ページを描くときに埋め込みフォントをブラウザに登録している。その登録名を CSS の font-family に使えば、
 * 保存結果と同じ書体・同じ字幅で表示できる。ただし登録されたフォントは、字形を元の文字とは別の文字コード（私用領域など）に
 * 割り当てていることがあるので、「文字 → そのフォントで字形が出る文字」の対応表も返す。
 * 元の文書で使っていない字は表に無く、後ろに指定した同梱フォントで表示される（保存時に同梱フォントへ切り替わるのと同じ）。
 */
import { getPdfJs } from "./pdfjs";
import type { SourceDoc } from "./types";

export interface PreviewFont {
  /** CSS の font-family に使う名前 */
  family: string;
  /** 文字 → このフォントで字形が出る文字 */
  map: Map<string, string>;
  /** 空白の幅（文字サイズに対する割合）。分からなければ null */
  spaceEm: number | null;
}

const cache = new Map<string, Promise<PreviewFont | null>>();

export function previewFontFor(src: SourceDoc, srcIndex: number, pdfFont: string): Promise<PreviewFont | null> {
  const key = `${src.id}|${pdfFont}`;
  let p = cache.get(key);
  if (!p) {
    p = load(src, srcIndex, pdfFont).catch(() => null);
    cache.set(key, p);
    // 取れなかったとき（まだページを描いていない等）は、次の機会にもう一度試す
    void p.then((v) => {
      if (!v) cache.delete(key);
    });
  }
  return p;
}

async function load(src: SourceDoc, srcIndex: number, pdfFont: string): Promise<PreviewFont | null> {
  if (typeof document === "undefined" || !document.fonts) return null;
  const page = await src.pdf.getPage(srcIndex + 1);
  const list = await page.getOperatorList();
  type FontObj = { widths?: number[] | Record<string, number>; defaultWidth?: number; loadedName?: string; missingFile?: boolean; isType3Font?: boolean; toFontChar?: number[] | Record<string, number>; toUnicode?: { _map?: Record<string, string> | string[] } };
  let f: FontObj | undefined;
  try {
    f = page.commonObjs.get(pdfFont) as FontObj | undefined;
  } catch {
    return null;
  }
  const raw = f?.toUnicode?._map;
  // pdf.js 6 からは、対応表（toUnicode）が表示側に届かない。そのときは、ページで実際に描いた字形（文字と、フォントの中の字）から作る
  const drawn = raw ? null : drawnGlyphs(list, pdfFont, (await getPdfJs()).OPS);
  if (!f || f.missingFile || f.isType3Font || (!raw && !drawn?.map.size)) return null;
  const family = f.loadedName ?? pdfFont;
  // ブラウザに登録済みで、読み込めたか（ページをまだ描いていなければ未登録）。
  // ブラウザがフォントの中身を受け付けなかったとき（status が error）は使わない：使うと字が箱（□）になる。同梱フォントで出す
  const faces: FontFace[] = [];
  document.fonts.forEach((face) => {
    if (face.family.replace(/["']/g, "") === family) faces.push(face);
  });
  if (!faces.length) return null;
  await Promise.all(faces.map((face) => (face.status === "loading" ? face.loaded.catch(() => null) : null)));
  if (!faces.some((face) => face.status === "loaded")) return null;
  if (drawn) return { family, map: drawn.map, spaceEm: drawn.spaceEm };
  // pdf.js 6 では toFontChar が Map になった
  const tfc = f.toFontChar as unknown;
  const fontCharOf = (k: string): number | undefined =>
    tfc instanceof Map ? (tfc.get(Number(k)) as number | undefined) : (tfc as Record<string, number> | undefined)?.[k];
  const map = new Map<string, string>();
  let spaceEm: number | null = null;
  for (const k in raw) {
    const code = Number(k);
    const u = (raw as Record<string, string>)[k];
    if (u === " " && spaceEm == null) {
      const w = (f.widths as Record<string, number> | undefined)?.[k] ?? f.defaultWidth;
      if (typeof w === "number" && w > 0) spaceEm = w / 1000;
    }
    if (!Number.isFinite(code) || typeof u !== "string" || !u || [...u].length !== 1) continue;
    // 空白はそのまま出す。制御文字に割り当てられた字形は HTML では出せない（記号の箱になる）ので、対応表に入れない
    if (/\s/.test(u)) continue;
    const fc = fontCharOf(k) || code;
    if (fc < 0x21 || (fc >= 0x7f && fc < 0xa1) || fc > 0x10ffff) continue;
    const glyphChar = String.fromCodePoint(fc);
    // 同じ文字に複数の字形があるときは、文字コードがそのままのものを優先する
    if (!map.has(u) || glyphChar === u) map.set(u, glyphChar);
  }
  return map.size ? { family, map, spaceEm } : null;
}

/** ページの命令の一覧から、指定のフォントで描いた字の「文字 → フォントの中の字」と、空白の幅を集める */
function drawnGlyphs(list: { fnArray: number[]; argsArray: unknown[] }, pdfFont: string, OPS: { setFont: number; showText: number }): { map: Map<string, string>; spaceEm: number | null } {
  const map = new Map<string, string>();
  let spaceEm: number | null = null;
  let current = "";
  list.fnArray.forEach((fn, i) => {
    const a = list.argsArray[i] as unknown[] | null;
    if (!Array.isArray(a)) return;
    if (fn === OPS.setFont && typeof a[0] === "string") current = a[0];
    else if (fn === OPS.showText && current === pdfFont && Array.isArray(a[0]))
      for (const g of a[0] as unknown[]) {
        const gl = g as { unicode?: unknown; fontChar?: unknown; width?: unknown } | null;
        if (!gl || typeof gl !== "object" || typeof gl.unicode !== "string" || typeof gl.fontChar !== "string") continue;
        const u = gl.unicode;
        if (u === " " && spaceEm == null && typeof gl.width === "number" && gl.width > 0) spaceEm = gl.width / 1000;
        if (!u || [...u].length !== 1 || /\s/.test(u) || [...gl.fontChar].length !== 1) continue;
        const fc = gl.fontChar.codePointAt(0)!;
        if (fc < 0x21 || (fc >= 0x7f && fc < 0xa1)) continue;
        if (!map.has(u) || gl.fontChar === u) map.set(u, gl.fontChar);
      }
  });
  return { map, spaceEm };
}

/** 文字列を、フォントで字形が出る文字に置き換える（表に無い字はそのまま＝後ろのフォントで表示される） */
export function toPreviewText(pf: PreviewFont, text: string): string {
  let out = "";
  for (const ch of text) out += pf.map.get(ch) ?? ch;
  return out;
}

const spaceCache = new Map<string, number>();
/** CSS のフォント指定での、空白の幅（文字サイズに対する割合） */
export function cssSpaceEm(family: string): number {
  let v = spaceCache.get(family);
  if (v == null) {
    v = 0.3;
    try {
      const ctx = document.createElement("canvas").getContext("2d");
      if (ctx) {
        ctx.font = `100px ${family}`;
        v = ctx.measureText(" ").width / 100;
      }
    } catch {
      /* 測れなければ目安の値 */
    }
    spaceCache.set(family, v);
  }
  return v;
}

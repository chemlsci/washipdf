/**
 * PDF 内のフォント辞書から、文字コードの切り出し方・字幅・Unicode 対応を取り出す。
 *
 * コンテンツストリームの Tj / TJ がページ上のどこからどこまでを描くかを計算するため（textOps.ts）と、
 * 「元のフォントで新しい文字が書けるか」の判定（fontSubst.ts）に使う。
 */
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  type PDFDocument,
  PDFName,
  PDFNumber,
  type PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  PDFHexString,
} from "pdf-lib";
import { Font, FontNames } from "@pdf-lib/standard-fonts";
import { tokenizeContent, type Operand } from "./contentStream";
import { baseEncodingByName, glyphNameToUnicode, STANDARD_ENCODING } from "./encodings";
import { glyphArea, glyphShape, type GlyphShape, sameShape } from "./glyphShape";
import { type CffInfo, parseCff } from "./cff";
import { capHeightEm, glyphData, glyphIdForCode, glyphIdForCodePoint, glyphTopEm, parseTtf, type TtfInfo, unitsPerEm } from "./ttfSubset";

export interface DecodedCode {
  /** 文字コード（バイト列を整数にしたもの） */
  code: number;
  /** CID（単純フォントでは code と同じ） */
  cid: number;
  /** このコードのバイト数 */
  nbytes: number;
  /** 単純フォントで 1 バイトの 32（Tw の対象） */
  isSpace: boolean;
}

export interface FontInfo {
  dict: PDFDict;
  ref: PDFRef | null;
  subtype: string;
  baseFont: string;
  kind: "simple" | "type0" | "type3";
  vertical: boolean;
  /** 幅が引けるか（引けない場合は Tj の進み量が分からない） */
  widthsKnown: boolean;
  /** 埋め込みフォントか */
  embedded: boolean;
  /** 一部だけ埋め込んだフォント（ABCDEF+ 名） */
  subset: boolean;
  /** 文字列バイト列 → コード列 */
  decode(bytes: Uint8Array): DecodedCode[];
  /** コードの幅（テキスト空間 ×1000。Type3 は FontMatrix 適用後 ×1000） */
  width(c: DecodedCode): number;
  /** コード → Unicode 文字列（ToUnicode または エンコーディングから） */
  toUnicode(c: DecodedCode): string | null;
  /** Unicode コードポイント → この フォントで描くためのバイト列。描けなければ null */
  encode(cp: number): Uint8Array | null;
  /** 新しいテキストの文字幅（テキスト空間 ×1000）。encode できない文字は null */
  widthOfCodePoint(cp: number): number | null;
  /** 和文書体の判定用に、フォント名から推測した分類 */
  serifLike: boolean;
  /**
   * ToUnicode を持たない Type0 フォントか（印刷用ソフトが出力した PDF に多い）。この場合、文字コード → 文字の対応を
   * 自前では引けないので、表示に使っている pdf.js が求めた対応表を setExternalUnicode で受け取る。
   * 受け取った表は「読む」ためだけに使う（toUnicode）。書き込み（encode）には使わない。
   */
  needsExternalUnicode?: boolean;
  /**
   * タイ文字のニッカヒット（ำ の丸）として使われている文字コード。文書の中で「幅 0・空白と読まれる字形の直後に า が続く」
   * 並びを見つけたときに登録される（textOps.walkTextOps）。登録された文字コードは ํ として読む
   */
  nikhahitCodes?: Set<number>;
  setExternalUnicode?(map: Map<number, string>): void;
}

/** タイ文字の、上下に付く母音・声調記号 */
const THAI_MARKS = [0x0e31, 0x0e34, 0x0e35, 0x0e36, 0x0e37, 0x0e38, 0x0e39, 0x0e3a, 0x0e47, 0x0e48, 0x0e49, 0x0e4a, 0x0e4b, 0x0e4c, 0x0e4d, 0x0e4e];

const cache = new WeakMap<PDFDict, FontInfo>();
/** pdf.js から受け取った対応表（フォント名ごと）。ToUnicode の無い Type0 フォントの「読む」ためだけに使う */
const externalByName = new Map<string, Map<number, string>>();

/**
 * タイ文字の「ำ」（サラ・アム）は、多くの文書で「丸（ニッカヒット ํ）＋ า」の 2 つの字形に分けて描かれる。
 * Word などが出す PDF では、丸の字形（幅 0）に文字として空白が割り当てられているため、
 * そのまま読むと丸が抜けて「สำคัญ」が「สาคัญ」になる（検索で見つからない、書き直すと丸が消える）。
 * 幅 0 なのに空白と読まれる字形のうち、文書の中で直後に「า」が続いているものをニッカヒットとして読む
 * （同じく幅 0 の「空白」でも、単語の区切り用の字形はニッカヒットではないので、並びで見分ける。登録は textOps.walkTextOps が行う）。
 */
function fixThaiNikhahit(info: FontInfo): void {
  const base = info.toUnicode;
  const codes = new Set<number>();
  info.nikhahitCodes = codes;
  info.toUnicode = (c) => (codes.has(c.code) ? "\u0e4d" : base(c));
  // 書くとき：ニッカヒットの文字コードが分かっていれば、それを使う
  const encode = info.encode;
  info.encode = (cp) => {
    if (cp === 0x0e4d && codes.size) {
      const direct = encode(cp);
      if (direct) return direct;
      const code = [...codes][0];
      return info.kind === "type0" ? Uint8Array.of((code >> 8) & 255, code & 255) : Uint8Array.of(code & 255);
    }
    return encode(cp);
  };
  const widthOf = info.widthOfCodePoint;
  info.widthOfCodePoint = (cp) => (cp === 0x0e4d && codes.size && widthOf(cp) == null ? 0 : widthOf(cp));
}

export function getFontInfo(doc: PDFDocument, fontObj: PDFObject | undefined): FontInfo | null {
  if (!fontObj) return null;
  let ref: PDFRef | null = null;
  let dict: PDFDict | undefined;
  if (fontObj instanceof PDFRef) {
    ref = fontObj;
    const o = doc.context.lookup(fontObj);
    if (o instanceof PDFDict) dict = o;
  } else if (fontObj instanceof PDFDict) dict = fontObj;
  if (!dict) return null;
  let info = cache.get(dict);
  if (!info) {
    try {
      info = buildFontInfo(doc, dict, ref);
    } catch {
      info = unknownFont(dict, ref);
    }
    fixThaiNikhahit(info);
    cache.set(dict, info);
  }
  return info;
}

/* ---------- 共通ユーティリティ ---------- */

export function decodeStreamBytes(doc: PDFDocument, obj: PDFObject | undefined): Uint8Array | null {
  const s = obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
  if (!(s instanceof PDFStream)) return null;
  if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode();
  // pdf-lib が作ったストリーム（drawText などの内容）は圧縮前のバイト列を持っている
  const unencoded = (s as { getUnencodedContents?: () => Uint8Array }).getUnencodedContents;
  return typeof unencoded === "function" ? unencoded.call(s) : s.getContents();
}

/**
 * 大文字の高さ（em に対する比）。フォントの説明（CapHeight）から取る。書かれていない・あり得ない値（0 や、ascent と同じ値を
 * 入れただけのもの）は null
 */
const capCache = new WeakMap<PDFDict, number | null>();
export function fontCapHeight(info: FontInfo): number | null {
  const hit = capCache.get(info.dict);
  if (hit !== undefined) return hit;
  const v = readCapHeight(info);
  capCache.set(info.dict, v);
  return v;
}

function readCapHeight(info: FontInfo): number | null {
  try {
    const ctx = info.dict.context;
    const deref = (o: PDFObject | undefined) => (o instanceof PDFRef ? ctx.lookup(o) : o);
    let holder: PDFObject | undefined = info.dict;
    const df = deref(info.dict.get(PDFName.of("DescendantFonts")));
    if (df instanceof PDFArray) holder = deref(df.get(0));
    const desc = holder instanceof PDFDict ? deref(holder.get(PDFName.of("FontDescriptor"))) : undefined;
    if (!(desc instanceof PDFDict)) return null;
    // 埋め込まれた TrueType が持つ値（OS/2 表）を優先する：フォントの説明の CapHeight は、作成ソフトによって当てにならない
    // （負の値や、行の高さに近い値が入っていることがある）
    const file = deref(desc.get(PDFName.of("FontFile2")));
    if (file instanceof PDFRawStream) {
      try {
        const ttf = parseTtf(decodePDFRawStream(file).decode(), false);
        const own = capHeightEm(ttf);
        if (own !== null) return own;
        // OS/2 表を持たない一部埋め込みフォント：文書で使われている、上が平らな大文字の字形の高さを測る
        for (const ch of "HIEFLTBDPRKNMUXZ") {
          const b = info.encode(ch.codePointAt(0)!);
          if (!b) continue;
          const code = b.length === 2 ? (b[0] << 8) | b[1] : b[0];
          const gid = info.kind === "type0" ? code : glyphIdForCode(ttf, code);
          const top = gid ? glyphTopEm(ttf, gid) : null;
          if (top !== null && top > 0.5 && top < 0.9) return top;
        }
      } catch {
        /* 読めなければ、説明の値を見る */
      }
    }
    const cap = deref(desc.get(PDFName.of("CapHeight")));
    const asc = deref(desc.get(PDFName.of("Ascent")));
    if (!(cap instanceof PDFNumber)) return null;
    const v = cap.asNumber() / 1000;
    if (asc instanceof PDFNumber && Math.abs(asc.asNumber() - cap.asNumber()) < 1) return null;
    return v > 0.55 && v < 0.82 ? v : null;
  } catch {
    return null;
  }
}

const boldCache = new WeakMap<PDFDict, boolean>();
/**
 * 太字のフォントか。名前（Bold など）、フォントの説明（FontWeight・ForceBold）、埋め込まれた TrueType の太さ（OS/2 の usWeightClass）
 * の順に見る。どれからも分からなければ太字ではないとする
 */
export function isBoldFont(info: FontInfo): boolean {
  const hit = boldCache.get(info.dict);
  if (hit !== undefined) return hit;
  let bold = /bold|black|heavy|demi/i.test(info.baseFont);
  try {
    const ctx = info.dict.context;
    const deref = (o: PDFObject | undefined) => (o instanceof PDFRef ? ctx.lookup(o) : o);
    let holder: PDFObject | undefined = info.dict;
    const df = deref(info.dict.get(PDFName.of("DescendantFonts")));
    if (df instanceof PDFArray) holder = deref(df.get(0));
    const desc = holder instanceof PDFDict ? deref(holder.get(PDFName.of("FontDescriptor"))) : undefined;
    if (!bold && desc instanceof PDFDict) {
      const weight = deref(desc.get(PDFName.of("FontWeight")));
      const flags = deref(desc.get(PDFName.of("Flags")));
      if (weight instanceof PDFNumber) bold = weight.asNumber() >= 600;
      else if (flags instanceof PDFNumber && flags.asNumber() & 0x40000) bold = true;
      else {
        const file = deref(desc.get(PDFName.of("FontFile2")));
        const bytes = file instanceof PDFRawStream ? decodePDFRawStream(file).decode() : null;
        const os2 = bytes ? parseTtf(bytes, false).tables.get("OS/2") : undefined;
        if (bytes && os2 && os2.length >= 6) bold = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(os2.offset + 4) >= 600;
      }
    }
    if (!bold && info.kind === "type3") bold = type3Heavier(info.dict);
  } catch {
    /* 読めなければ、名前での判定のまま */
  }
  boldCache.set(info.dict, bold);
  return bold;
}

/** Type3 の字形の絵（塗りつぶす輪郭）の面積。座標は字形の空間（cm を反映）。曲線は数点で近似。読めなければ null */
function type3Area(bytes: Uint8Array): number | null {
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  const pt = (x: number, y: number): [number, number] => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
  let area = 0;
  let path: [number, number][] = [];
  const subs: [number, number][][] = [];
  const close = () => {
    if (path.length > 2) subs.push(path);
    path = [];
  };
  let filled = false;
  for (const op of tokenizeContent(bytes)) {
    const n = op.operands.map((o) => (o.kind === "num" ? o.value : NaN));
    switch (op.op) {
      case "q":
        stack.push(ctm);
        break;
      case "Q":
        ctm = stack.pop() ?? ctm;
        break;
      case "cm": {
        const [a, b, c, d, e, f] = n;
        ctm = [a * ctm[0] + b * ctm[2], a * ctm[1] + b * ctm[3], c * ctm[0] + d * ctm[2], c * ctm[1] + d * ctm[3], e * ctm[0] + f * ctm[2] + ctm[4], e * ctm[1] + f * ctm[3] + ctm[5]];
        break;
      }
      case "m":
        close();
        path.push(pt(n[0], n[1]));
        break;
      case "l":
        path.push(pt(n[0], n[1]));
        break;
      case "c": {
        const p0 = path[path.length - 1];
        if (!p0) return null;
        const [p1, p2, p3] = [pt(n[0], n[1]), pt(n[2], n[3]), pt(n[4], n[5])];
        for (const t of [0.25, 0.5, 0.75]) {
          const u = 1 - t;
          path.push([u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]);
        }
        path.push(p3);
        break;
      }
      case "re": {
        close();
        const [x, y, w, h] = n;
        path.push(pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h));
        close();
        break;
      }
      case "h":
        close();
        break;
      case "f":
      case "F":
      case "f*":
        filled = true;
        close();
        break;
      // 線で描く字形（輪郭をなぞるだけ）は面積で比べられない
      case "S":
      case "s":
      case "B":
      case "B*":
      case "b":
      case "b*":
        return null;
    }
  }
  if (!filled) return null;
  for (const sp of subs) for (let j = 0; j < sp.length; j++) {
    const [x0, y0] = sp[j];
    const [x1, y1] = sp[(j + 1) % sp.length];
    area += x0 * y1 - x1 * y0;
  }
  return Math.abs(area) / 2;
}

/**
 * Type3 フォントが、同じ名前で埋め込まれた TrueType フォントより太い字形か。
 * 可変フォントの標準の太さを TrueType で、ほかの太さ（太字）を字形の絵（Type3）で埋め込む PDF がある。
 * フォントの説明は元の名前（Regular など）のままで太さの手がかりにならないので、同じ字の字形の面積（黒い部分）を比べる
 */
function type3Heavier(dict: PDFDict): boolean {
  const ctx = dict.context;
  const strip = (o: PDFObject | undefined) => (o instanceof PDFName ? o.decodeText().replace(/^[A-Z]{6}\+/, "") : "");
  const desc = dict.lookup(PDFName.of("FontDescriptor"));
  const name = desc instanceof PDFDict ? strip(desc.get(PDFName.of("FontName"))) : "";
  const enc = dict.lookup(PDFName.of("Encoding"));
  const diffs = enc instanceof PDFDict ? enc.lookup(PDFName.of("Differences")) : undefined;
  const procs = dict.lookup(PDFName.of("CharProcs"));
  const fm = dict.lookup(PDFName.of("FontMatrix"));
  if (!name || !(diffs instanceof PDFArray) || !(procs instanceof PDFDict) || !(fm instanceof PDFArray)) return false;
  const m0 = fm.lookup(0);
  const m3 = fm.lookup(3);
  // 字形の空間 → 1000 単位
  const k = (m0 instanceof PDFNumber ? Math.abs(m0.asNumber()) : 0.001) * (m3 instanceof PDFNumber ? Math.abs(m3.asNumber()) : 0.001) * 1e6;
  // Type3 の字形の名前（uniXXXX：語頭・語中などの形でない、もとの字）→ 面積
  const t3 = new Map<string, number>();
  for (let i = 0; i < diffs.size(); i++) {
    const o = diffs.lookup(i);
    if (!(o instanceof PDFName)) continue;
    const m = /^uni([0-9A-F]{4})$/.exec(o.decodeText());
    const proc = procs.lookup(o);
    if (!m || !(proc instanceof PDFRawStream)) continue;
    const area = type3Area(decodePDFRawStream(proc).decode());
    if (area) t3.set(String.fromCharCode(parseInt(m[1], 16)), area * k);
  }
  if (t3.size < 3) return false;
  for (const [, o] of ctx.enumerateIndirectObjects()) {
    if (!(o instanceof PDFDict) || o === dict || o.get(PDFName.of("Type")) !== PDFName.of("Font") || o.get(PDFName.of("Subtype")) !== PDFName.of("TrueType")) continue;
    const d = o.lookup(PDFName.of("FontDescriptor"));
    const file = d instanceof PDFDict ? d.lookup(PDFName.of("FontFile2")) : undefined;
    const tu = o.lookup(PDFName.of("ToUnicode"));
    if (!(d instanceof PDFDict) || strip(d.get(PDFName.of("FontName"))) !== name || !(file instanceof PDFRawStream) || !(tu instanceof PDFRawStream)) continue;
    const ttf = parseTtf(decodePDFRawStream(file).decode(), false);
    const upm = unitsPerEm(ttf);
    // 同じ字に割り当てた符号が複数あるとき（アラビア文字の語頭・語中・語尾の形）は、どの形か分からないので、
    // いちばん面積の大きい形と比べる（太字と言い切れるときだけ太字にする）
    const byChar = new Map<string, number[]>();
    for (const [c, u] of parseCMap(decodePDFRawStream(tu).decode()).single) if (typeof u === "string") byChar.set(u, [...(byChar.get(u) ?? []), c]);
    const ratios: number[] = [];
    for (const [ch, a] of t3) {
      const areas = (byChar.get(ch) ?? []).map((c) => {
        const gid = glyphIdForCode(ttf, c);
        return gid ? (glyphArea(ttf, gid) ?? 0) : 0;
      });
      const b = Math.max(0, ...areas);
      if (b > 0 && areas.length <= 4) ratios.push(a / ((b * 1e6) / (upm * upm)));
    }
    if (ratios.length < 3) continue;
    ratios.sort((p, q) => p - q);
    return ratios[ratios.length >> 1] >= 1.15;
  }
  return false;
}

const lookupName = (doc: PDFDocument, d: PDFDict, key: string): string | null => {
  const v = d.lookup(PDFName.of(key));
  return v instanceof PDFName ? v.decodeText() : null;
};
const lookupNum = (d: PDFDict, key: string, def: number): number => {
  const v = d.lookup(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : def;
};
const lookupDict = (d: PDFDict, key: string): PDFDict | undefined => {
  const v = d.lookup(PDFName.of(key));
  return v instanceof PDFDict ? v : undefined;
};

function bytesToInt(bytes: Uint8Array): number {
  let v = 0;
  for (const b of bytes) v = v * 256 + b;
  return v;
}

function operandBytes(o: Operand | undefined): Uint8Array | null {
  return o && o.kind === "string" ? o.bytes : null;
}

function utf16beToString(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  if (bytes.length === 1) s = String.fromCharCode(bytes[0]);
  return s;
}

/* ---------- CMap ---------- */

interface CodespaceRange {
  nbytes: number;
  low: number;
  high: number;
}

export interface ParsedCMap {
  codespace: CodespaceRange[];
  /** code → 値（ToUnicode なら文字列、埋め込み CMap なら CID） */
  single: Map<number, string | number>;
  ranges: { lo: number; hi: number; nbytes: number; dst: string | number }[];
  vertical: boolean;
}

export function parseCMap(bytes: Uint8Array): ParsedCMap {
  const ops = tokenizeContent(bytes);
  const out: ParsedCMap = { codespace: [], single: new Map(), ranges: [], vertical: false };
  for (const op of ops) {
    const a = op.operands;
    switch (op.op) {
      case "endcodespacerange":
        for (let i = 0; i + 1 < a.length; i += 2) {
          const lo = operandBytes(a[i]);
          const hi = operandBytes(a[i + 1]);
          if (lo && hi) out.codespace.push({ nbytes: lo.length, low: bytesToInt(lo), high: bytesToInt(hi) });
        }
        break;
      case "endbfchar":
        for (let i = 0; i + 1 < a.length; i += 2) {
          const src = operandBytes(a[i]);
          const dst = a[i + 1];
          if (!src) continue;
          if (dst.kind === "string") out.single.set(bytesToInt(src), utf16beToString(dst.bytes));
          else if (dst.kind === "name") {
            const cp = glyphNameToUnicode(dst.value);
            if (cp != null) out.single.set(bytesToInt(src), String.fromCodePoint(cp));
          }
        }
        break;
      case "endbfrange":
        for (let i = 0; i + 2 < a.length; i += 3) {
          const lo = operandBytes(a[i]);
          const hi = operandBytes(a[i + 1]);
          const dst = a[i + 2];
          if (!lo || !hi) continue;
          const l = bytesToInt(lo);
          const h = bytesToInt(hi);
          if (dst.kind === "string") out.ranges.push({ lo: l, hi: h, nbytes: lo.length, dst: utf16beToString(dst.bytes) });
          else if (dst.kind === "array") {
            dst.items.forEach((it, k) => {
              if (it.kind === "string" && l + k <= h) out.single.set(l + k, utf16beToString(it.bytes));
            });
          }
        }
        break;
      case "endcidchar":
        for (let i = 0; i + 1 < a.length; i += 2) {
          const src = operandBytes(a[i]);
          const dst = a[i + 1];
          if (src && dst.kind === "num") out.single.set(bytesToInt(src), dst.value);
        }
        break;
      case "endcidrange":
        for (let i = 0; i + 2 < a.length; i += 3) {
          const lo = operandBytes(a[i]);
          const hi = operandBytes(a[i + 1]);
          const dst = a[i + 2];
          if (lo && hi && dst.kind === "num") out.ranges.push({ lo: bytesToInt(lo), hi: bytesToInt(hi), nbytes: lo.length, dst: dst.value });
        }
        break;
      case "def": {
        // /WMode 1 def
        const k = a[a.length - 2];
        const v = a[a.length - 1];
        if (k?.kind === "name" && k.value === "WMode" && v?.kind === "num" && v.value === 1) out.vertical = true;
        break;
      }
    }
  }
  return out;
}

function cmapLookup(m: ParsedCMap, code: number): string | number | undefined {
  const s = m.single.get(code);
  if (s !== undefined) return s;
  for (const r of m.ranges) {
    if (code >= r.lo && code <= r.hi) {
      const off = code - r.lo;
      if (typeof r.dst === "number") return r.dst + off;
      if (!r.dst) return r.dst;
      // 末尾の文字をずらす
      const last = r.dst.codePointAt(r.dst.length - 1)!;
      return r.dst.slice(0, -1) + String.fromCodePoint(last + off);
    }
  }
  return undefined;
}

/** codespace に従ってバイト列をコードに分ける */
function splitByCodespace(bytes: Uint8Array, ranges: CodespaceRange[]): { code: number; nbytes: number }[] {
  const out: { code: number; nbytes: number }[] = [];
  const lens = [...new Set(ranges.map((r) => r.nbytes))].sort((a, b) => a - b);
  let i = 0;
  while (i < bytes.length) {
    let matched = false;
    for (const n of lens) {
      if (i + n > bytes.length) continue;
      const code = bytesToInt(bytes.subarray(i, i + n));
      if (ranges.some((r) => r.nbytes === n && code >= r.low && code <= r.high)) {
        out.push({ code, nbytes: n });
        i += n;
        matched = true;
        break;
      }
    }
    if (!matched) {
      // 仕様では部分一致の最短長を使う。簡略化して最初の範囲の長さを採用
      const n = Math.min(lens[0] ?? 1, bytes.length - i);
      out.push({ code: bytesToInt(bytes.subarray(i, i + n)), nbytes: n });
      i += n;
    }
  }
  return out;
}

/* ---------- 標準14フォント ---------- */

const STD14: Record<string, FontNames> = {
  courier: FontNames.Courier,
  "courier-bold": FontNames.CourierBold,
  "courier-oblique": FontNames.CourierOblique,
  "courier-boldoblique": FontNames.CourierBoldOblique,
  helvetica: FontNames.Helvetica,
  "helvetica-bold": FontNames.HelveticaBold,
  "helvetica-oblique": FontNames.HelveticaOblique,
  "helvetica-boldoblique": FontNames.HelveticaBoldOblique,
  "times-roman": FontNames.TimesRoman,
  "times-bold": FontNames.TimesRomanBold,
  "times-italic": FontNames.TimesRomanItalic,
  "times-bolditalic": FontNames.TimesRomanBoldItalic,
  symbol: FontNames.Symbol,
  zapfdingbats: FontNames.ZapfDingbats,
};

function standardFontFor(baseFont: string, flags: number): Font | null {
  const n = baseFont.replace(/^[A-Z]{6}\+/, "");
  const lower = n.toLowerCase().replace(/[\s_]/g, "");
  const bold = /bold|black|heavy|semibold|demibold/.test(lower) || (flags & (1 << 18)) !== 0;
  const italic = /italic|oblique/.test(lower) || (flags & (1 << 6)) !== 0;
  let fam: "courier" | "helvetica" | "times" | "symbol" | "zapfdingbats";
  if (/courier|mono/.test(lower)) fam = "courier";
  else if (/times|georgia|book|garamond|roman|serif/.test(lower) && !/sans/.test(lower)) fam = "times";
  else if (lower.startsWith("symbol")) fam = "symbol";
  else if (/zapf|dingbat/.test(lower)) fam = "zapfdingbats";
  else if (/helvetica|arial|verdana|tahoma|calibri|segoe|sans/.test(lower)) fam = "helvetica";
  else if (flags & 2 && !(flags & 1)) fam = "times"; // Serif フラグ
  else fam = "helvetica";
  let key: string = fam;
  if (fam === "times") key = bold && italic ? "times-bolditalic" : bold ? "times-bold" : italic ? "times-italic" : "times-roman";
  else if (fam === "courier" || fam === "helvetica") key = fam + (bold && italic ? "-boldoblique" : bold ? "-bold" : italic ? "-oblique" : "");
  const fn = STD14[key];
  if (!fn) return null;
  try {
    return Font.load(fn);
  } catch {
    return null;
  }
}

/* ---------- フォント情報の構築 ---------- */

function unknownFont(dict: PDFDict, ref: PDFRef | null): FontInfo {
  return {
    dict,
    ref,
    subtype: "",
    baseFont: "",
    kind: "simple",
    vertical: false,
    widthsKnown: false,
    embedded: false,
    subset: false,
    decode: (b) => [...b].map((code) => ({ code, cid: code, nbytes: 1, isSpace: code === 32 })),
    width: () => 0,
    toUnicode: () => null,
    encode: () => null,
    widthOfCodePoint: () => null,
    serifLike: false,
  };
}

const isSerifName = (n: string) =>
  /mincho|明朝|serif|times|georgia|garamond|book|roman|song|ming|batang|kaku(?!go)|ryumin|hiragino ?mincho|yumin|yu ?mincho|ipamin|ipaexm|notoserif|sourcehanserif|bizudmincho|bizudpmincho/i.test(
    n.replace(/\s/g, ""),
  ) && !/sans|gothic|ゴシック/i.test(n);

function buildFontInfo(doc: PDFDocument, dict: PDFDict, ref: PDFRef | null): FontInfo {
  const subtype = lookupName(doc, dict, "Subtype") ?? "";
  const baseFont = lookupName(doc, dict, "BaseFont") ?? "";
  const subset = /^[A-Z]{6}\+/.test(baseFont);
  const serifLike = isSerifName(baseFont);

  // ToUnicode
  let toUni: ParsedCMap | null = null;
  const tuBytes = decodeStreamBytes(doc, dict.get(PDFName.of("ToUnicode")));
  if (tuBytes) {
    try {
      toUni = parseCMap(tuBytes);
    } catch {
      toUni = null;
    }
  }
  const toUnicodeFromMap = (code: number): string | null => {
    if (!toUni) return null;
    const v = cmapLookup(toUni, code);
    return typeof v === "string" ? v : null;
  };

  if (subtype === "Type0") return buildType0(doc, dict, ref, baseFont, subset, serifLike, toUni, toUnicodeFromMap);
  if (subtype === "Type3") return buildType3(doc, dict, ref, baseFont, toUnicodeFromMap);
  return buildSimple(doc, dict, ref, subtype, baseFont, subset, serifLike, toUni, toUnicodeFromMap);
}

function invertToUnicode(toUni: ParsedCMap | null, widthOf?: (code: number) => number): Map<number, number> {
  // Unicode コードポイント → コード（1文字に対応するものだけ）
  const m = new Map<number, number>();
  if (!toUni) return m;
  const put = (code: number, s: string) => {
    if ([...s].length !== 1) return;
    const cp = s.codePointAt(0)!;
    const w = widthOf ? widthOf(code) : 1;
    // 空白を書くときに、幅 0 の字形を選ばない（空白と読まれるが幅 0 の字形は、タイ文字のニッカヒットや語の区切りなど、別の役目のもの）
    if (cp === 0x20 && w === 0 && code !== 0x20) return;
    const cur = m.get(cp);
    // 同じ文字に複数の文字コードがあるときは、幅のあるほうを使う（幅 0 のほうは、別の役目の字形であることが多い）
    if (cur === undefined || (widthOf && widthOf(cur) === 0 && w > 0)) m.set(cp, code);
  };
  for (const [code, v] of toUni.single) if (typeof v === "string") put(code, v);
  for (const r of toUni.ranges) {
    if (typeof r.dst !== "string" || !r.dst) continue;
    if (r.hi - r.lo > 65535) continue;
    for (let c = r.lo; c <= r.hi; c++) {
      const v = cmapLookup(toUni, c);
      if (typeof v === "string") put(c, v);
    }
  }
  return m;
}

function buildSimple(
  doc: PDFDocument,
  dict: PDFDict,
  ref: PDFRef | null,
  subtype: string,
  baseFont: string,
  subset: boolean,
  serifLike: boolean,
  toUni: ParsedCMap | null,
  toUnicodeFromMap: (code: number) => string | null,
): FontInfo {
  const desc = lookupDict(dict, "FontDescriptor");
  const flags = desc ? lookupNum(desc, "Flags", 0) : 0;
  const symbolic = (flags & 4) !== 0 && (flags & 32) === 0;
  const embedded = !!desc && ["FontFile", "FontFile2", "FontFile3"].some((k) => desc.has(PDFName.of(k)));
  const missingWidth = desc ? lookupNum(desc, "MissingWidth", 0) : 0;

  // エンコーディング（code → グリフ名）
  let encoding: (string | null)[] | null = null;
  const encObj = dict.lookup(PDFName.of("Encoding"));
  const std = !embedded ? standardFontFor(baseFont, flags) : null;
  const builtinStd = std && /symbol|dingbat/i.test(std.FontName) ? null : STANDARD_ENCODING;
  if (encObj instanceof PDFName) encoding = baseEncodingByName(encObj.decodeText());
  else if (encObj instanceof PDFDict) {
    const base = encObj.lookup(PDFName.of("BaseEncoding"));
    encoding = [...((base instanceof PDFName ? baseEncodingByName(base.decodeText()) : null) ?? (symbolic ? [] : builtinStd ?? []))];
    while (encoding.length < 256) encoding.push(null);
    const diff = encObj.lookup(PDFName.of("Differences"));
    if (diff instanceof PDFArray) {
      let code = 0;
      for (let i = 0; i < diff.size(); i++) {
        const it = diff.lookup(i);
        if (it instanceof PDFNumber) code = it.asNumber();
        else if (it instanceof PDFName && code < 256) encoding[code++] = it.decodeText();
      }
    }
  }
  if (!encoding && !symbolic) encoding = builtinStd;

  // 幅
  const firstChar = lookupNum(dict, "FirstChar", -1);
  const widthsArr = dict.lookup(PDFName.of("Widths"));
  const widths = new Map<number, number>();
  if (widthsArr instanceof PDFArray && firstChar >= 0) {
    for (let i = 0; i < widthsArr.size(); i++) {
      const w = widthsArr.lookup(i);
      if (w instanceof PDFNumber) widths.set(firstChar + i, w.asNumber());
    }
  }
  const widthsKnown = widths.size > 0 || !!std;
  const stdWidth = (code: number): number | null => {
    if (!std) return null;
    const gname = encoding?.[code] ?? (STANDARD_ENCODING[code] || null);
    if (!gname) return null;
    const w = std.getWidthOfGlyph(gname);
    return typeof w === "number" ? w : null;
  };

  // Unicode → code（ToUnicode の逆引き + エンコーディング）
  const uniToCode = invertToUnicode(toUni, (code) => widths.get(code) ?? 1);
  // 同じ文字に複数の文字コードが対応していることがある（例：ハイフンが 0x2D と 0xAD）。一部だけ埋め込んだフォントでは
  // 片方にしか字形が無い（もう片方は幅 0）ので、幅のある文字コードを選び直す。選び損なうと、その字が空白になる
  if (toUni && widths.size) {
    for (const [cp, code] of [...uniToCode]) {
      if ((widths.get(code) ?? 0) > 0) continue;
      const ch = String.fromCodePoint(cp);
      for (const [c, w] of widths) {
        if (w > 0 && c !== code && cmapLookup(toUni, c) === ch) {
          uniToCode.set(cp, c);
          break;
        }
      }
    }
  }
  if (encoding) {
    encoding.forEach((g, code) => {
      if (!g) return;
      const cp = glyphNameToUnicode(g);
      if (cp != null && !uniToCode.has(cp)) uniToCode.set(cp, code);
    });
  }
  // 一部だけ埋め込んだフォント（ABCDEF+ 名）は、元の文書で使った字しか持っていない。/Widths が 0 で ToUnicode にも無い字は
  // 「エンコーディング上は書けるが字形が入っていない」字なので、書けない扱いにする（書くと空白や豆腐になる）
  // 対応表（ToUnicode）がある一部埋め込みフォントでは、対応表に無い文字コードは「元の文書で使っていない＝字形が入っていない」とみなす
  // （Word の出力は、使っていない字にも幅を書くので、幅だけでは見分けられない）
  const absentInSubset = (code: number) => subset && toUnicodeFromMap(code) == null && (toUni ? embedded : widths.get(code) === 0);
  const encodable = (code: number) => (widths.has(code) && !absentInSubset(code)) || (std ? stdWidth(code) != null : false);

  const toUnicode = (c: DecodedCode): string | null => {
    const s = toUnicodeFromMap(c.code);
    if (s != null) return s;
    const g = encoding?.[c.code];
    if (g) {
      const cp = glyphNameToUnicode(g);
      if (cp != null) return String.fromCodePoint(cp);
    }
    if (!symbolic && c.code >= 32 && c.code < 127) return String.fromCharCode(c.code);
    return null;
  };

  return {
    dict,
    ref,
    subtype,
    baseFont,
    kind: "simple",
    vertical: false,
    widthsKnown,
    embedded,
    subset,
    serifLike,
    decode: (b) => [...b].map((code) => ({ code, cid: code, nbytes: 1, isSpace: code === 32 })),
    width: (c) => widths.get(c.code) ?? stdWidth(c.code) ?? missingWidth,
    toUnicode,
    encode: (cp) => {
      const code = uniToCode.get(cp);
      if (code == null || !encodable(code)) return null;
      // Differences で別の字が割り当てられていないか（ToUnicode 優先なので逆引き結果を信用する）
      return Uint8Array.of(code);
    },
    widthOfCodePoint: (cp) => {
      const code = uniToCode.get(cp);
      if (code == null || !encodable(code)) return null;
      return widths.get(code) ?? stdWidth(code) ?? missingWidth;
    },
  };
}

function buildType0(
  doc: PDFDocument,
  dict: PDFDict,
  ref: PDFRef | null,
  baseFont: string,
  subset: boolean,
  serifLike: boolean,
  toUni: ParsedCMap | null,
  toUnicodeFromMap: (code: number) => string | null,
): FontInfo {
  const descFonts = dict.lookup(PDFName.of("DescendantFonts"));
  const cidFont = descFonts instanceof PDFArray ? descFonts.lookup(0) : undefined;
  const cf = cidFont instanceof PDFDict ? cidFont : undefined;
  const desc = cf ? lookupDict(cf, "FontDescriptor") : undefined;
  const embedded = !!desc && ["FontFile", "FontFile2", "FontFile3"].some((k) => desc.has(PDFName.of(k)));

  // エンコーディング CMap
  const encObj = dict.lookup(PDFName.of("Encoding"));
  let identity = false;
  let vertical = false;
  let cmap: ParsedCMap | null = null;
  let supported = false;
  if (encObj instanceof PDFName) {
    const n = encObj.decodeText();
    if (n === "Identity-H" || n === "Identity-V") {
      identity = true;
      supported = true;
      vertical = n.endsWith("-V");
    } else {
      // 定義済み CMap（90ms-RKSJ-H など）は表を持っていないため非対応
      vertical = n.endsWith("-V") || n === "V";
    }
  } else {
    const b = decodeStreamBytes(doc, dict.get(PDFName.of("Encoding")));
    if (b) {
      try {
        cmap = parseCMap(b);
        supported = cmap.codespace.length > 0;
        vertical = cmap.vertical;
      } catch {
        cmap = null;
      }
    }
  }

  // 幅（/W, /DW）
  const dw = cf ? lookupNum(cf, "DW", 1000) : 1000;
  const W = new Map<number, number>();
  const wArr = cf?.lookup(PDFName.of("W"));
  if (wArr instanceof PDFArray) {
    let i = 0;
    const n = wArr.size();
    while (i < n) {
      const a = wArr.lookup(i);
      if (!(a instanceof PDFNumber)) break;
      const b = wArr.lookup(i + 1);
      if (b instanceof PDFArray) {
        for (let k = 0; k < b.size(); k++) {
          const w = b.lookup(k);
          if (w instanceof PDFNumber) W.set(a.asNumber() + k, w.asNumber());
        }
        i += 2;
      } else if (b instanceof PDFNumber) {
        const w = wArr.lookup(i + 2);
        if (w instanceof PDFNumber) {
          const lo = a.asNumber();
          const hi = b.asNumber();
          if (hi - lo < 65536) for (let c = lo; c <= hi; c++) W.set(c, w.asNumber());
        }
        i += 3;
      } else break;
    }
  }

  const decode = (bytes: Uint8Array): DecodedCode[] => {
    if (identity || !cmap) {
      const out: DecodedCode[] = [];
      for (let i = 0; i < bytes.length; i += 2) {
        const code = i + 1 < bytes.length ? (bytes[i] << 8) | bytes[i + 1] : bytes[i] << 8;
        out.push({ code, cid: code, nbytes: 2, isSpace: false });
      }
      return out;
    }
    return splitByCodespace(bytes, cmap.codespace).map(({ code, nbytes }) => {
      const cid = cmapLookup(cmap!, code);
      return { code, cid: typeof cid === "number" ? cid : 0, nbytes, isSpace: nbytes === 1 && code === 32 };
    });
  };

  // Unicode → コード。ToUnicode の逆引きと、埋め込み TrueType の cmap（CIDToGIDMap が Identity の場合）
  const uniToCode = invertToUnicode(toUni, (code) => W.get(code) ?? dw);
  let ttf: TtfInfo | null = null;
  let cid2gidIdentity = true;
  /** 埋め込まれた TrueType の字形（cmap が無くても読む）と、文字コード → 字形番号の表（CIDToGIDMap が表のとき） */
  let glyphs: TtfInfo | null = null;
  let cidToGid: Uint8Array | null = null;
  let cff: CffInfo | null = null;
  if (identity && desc) {
    const c2g = cf?.lookup(PDFName.of("CIDToGIDMap"));
    cid2gidIdentity = !(c2g instanceof PDFStream);
    const ff2 = decodeStreamBytes(doc, desc.get(PDFName.of("FontFile2")));
    if (ff2) {
      try {
        glyphs = parseTtf(ff2, false);
        cidToGid = cid2gidIdentity ? null : decodeStreamBytes(doc, cf?.get(PDFName.of("CIDToGIDMap")));
        if (!cid2gidIdentity && !cidToGid) glyphs = null;
      } catch {
        glyphs = null;
      }
    }
    // CFF 形式（FontFile3）：一部だけ埋め込んだフォントでは、使っていない字の字形が「何も描かない字形」として残っていることがある
    if (!ff2) {
      const ff3 = decodeStreamBytes(doc, desc.get(PDFName.of("FontFile3")));
      cff = ff3 ? parseCff(ff3) : null;
    }
    if (ff2 && cid2gidIdentity) {
      try {
        ttf = parseTtf(ff2);
        if (!ttf.tables.has("cmap")) ttf = null;
      } catch {
        ttf = null;
      }
    }
  }
  // その文字コードの字形が、埋め込まれたフォントに実際に入っているか（分からないときは true）。
  // 一部だけ埋め込んだフォントでも、文字の対応表（ToUnicode）は全部の文字コードを載せた決まり文句のことがある
  // （PHP 系の PDF 作成ソフト：文字コード＝Unicode で、CIDToGIDMap で字形番号に直す）。対応表にあっても字形が無ければ、書くと空白になる
  const hasGlyph = (code: number): boolean => {
    if (cff) {
      const gid = cff.gidOfCid(code);
      return gid !== null && gid > 0 && cff.hasOutline(gid);
    }
    if (!glyphs) return true;
    const gid = cidToGid ? (code * 2 + 1 < cidToGid.length ? (cidToGid[code * 2] << 8) | cidToGid[code * 2 + 1] : 0) : code;
    return gid > 0 && gid < glyphs.numGlyphs && glyphData(glyphs, gid).length > 0;
  };
  /** 文字 → 字形のある文字コード（最初に選んだ文字コードの字形が無かったときに探した結果。無ければ null） */
  const withGlyph = new Map<number, number | null>();
  const codeFor = (cp: number): number | null => {
    const c = uniToCode.get(cp);
    // 空白や制御文字（タブの代わりに置かれた、輪郭の無い字形など）は、字形に輪郭が無くてよい
    if (c != null && !ttf && !/[\s\p{C}]/u.test(String.fromCodePoint(cp)) && !hasGlyph(c)) {
      // 同じ文字に複数の文字コードが対応していて（別の字形の文字コード、ほかのフォントと共有している対応表 など）、
      // 選んだものの字形がこのフォントに無い：字形のある文字コードを探す。無ければ書けない
      let alt = withGlyph.get(cp);
      if (alt === undefined) {
        alt = null;
        if (toUni) {
          const ch = String.fromCodePoint(cp);
          for (const [code, v] of toUni.single) {
            if (v === ch && hasGlyph(code)) {
              alt = code;
              break;
            }
          }
          for (const r of alt === null ? toUni.ranges : []) {
            if (typeof r.dst !== "string" || !r.dst || r.hi - r.lo > 65535) continue;
            const first = r.dst.codePointAt(0)!;
            // 範囲の対応は、先頭の文字から 1 ずつ増える
            const code = [...r.dst].length === 1 && cp >= first && cp - first <= r.hi - r.lo ? r.lo + (cp - first) : -1;
            if (code >= 0 && cmapLookup(toUni, code) === ch && hasGlyph(code)) {
              alt = code;
              break;
            }
          }
        }
        withGlyph.set(cp, alt);
      }
      return alt;
    }
    if (c != null) {
      // サブセットでグリフが空になっていないか確認できる場合は確認する
      if (ttf && c < ttf.numGlyphs && glyphData(ttf, c).length === 0 && !/\s/.test(String.fromCodePoint(cp))) {
        // ToUnicode にはあるがグリフが空：使われていない可能性が高い
        const g = glyphIdForCodePoint(ttf, cp);
        return g && glyphData(ttf, g).length ? g : null;
      }
      return c;
    }
    if (ttf) {
      const g = glyphIdForCodePoint(ttf, cp);
      if (g && (glyphData(ttf, g).length > 0 || /\s/.test(String.fromCodePoint(cp)))) return g;
    }
    return null;
  };
  const encodable = identity && (toUni != null || ttf != null);

  // タイ文字の母音・声調記号で、文字の対応（ToUnicode）が付いていない字形：同じフォントの中の、対応が分かっている記号と
  // 形を比べて、何の字かを求める（下の字に合わせてずらした・少し縮めた別の字形を使う文書。Word の出力に多い）
  let marks: { shape: GlyphShape; ch: string }[] | null = null;
  let outline: TtfInfo | null | undefined;
  const recovered = new Map<number, string | null>();
  const recoverThaiMark = (code: number): string | null => {
    // 記号は幅 0 の字形。幅のある字形（罫線や記号など、たまたま形が似たもの）は対象にしない
    if (!identity || !cid2gidIdentity || !toUni || (W.get(code) ?? dw) !== 0) return null;
    const hit = recovered.get(code);
    if (hit !== undefined) return hit;
    let found: string | null = null;
    try {
      if (outline === undefined) {
        const ff2 = desc ? decodeStreamBytes(doc, desc.get(PDFName.of("FontFile2"))) : null;
        outline = ff2 ? parseTtf(ff2, false) : null;
      }
      if (outline && !marks) {
        marks = [];
        for (const cp of THAI_MARKS) {
          const c = uniToCode.get(cp);
          const shape = c === undefined ? null : glyphShape(outline, c);
          if (shape) marks.push({ shape, ch: String.fromCodePoint(cp) });
        }
      }
      const shape = outline && marks?.length ? glyphShape(outline, code) : null;
      if (shape) {
        const same = marks!.filter((m) => sameShape(m.shape, shape));
        // 形が同じ記号が 1 つに決まるときだけ
        if (same.length === 1) found = same[0].ch;
      }
    } catch {
      found = null;
    }
    recovered.set(code, found);
    return found;
  };
  const readCode = (code: number): string | null => {
    const u = toUnicodeFromMap(code);
    if (u == null || u === "\ufffd") return recoverThaiMark(code) ?? u;
    return u;
  };
  /** pdf.js から受け取った文字コード → 文字の対応（ToUnicode が無いとき） */
  let external: Map<number, string> | null = null;

  return {
    dict,
    ref,
    subtype: "Type0",
    baseFont,
    kind: "type0",
    vertical,
    widthsKnown: supported,
    embedded,
    subset,
    serifLike,
    decode,
    width: (c) => W.get(c.cid) ?? dw,
    // 自前の表に無ければ、受け取った表を使う。保存用に複製した文書のフォント（別の辞書）でも引けるよう、名前でも探す
    toUnicode: (c) => readCode(c.code) ?? (external ?? (toUni == null ? externalByName.get(baseFont) : undefined))?.get(c.code) ?? null,
    // pdf.js 6 からは、表示したページの字の分しか対応が分からない（フォントの対応表そのものは届かない）。
    // そのため、ページを開くたびに求め、それまでの分に足していく
    needsExternalUnicode: toUni == null,
    setExternalUnicode: (map) => {
      const merged = new Map([...(external ?? externalByName.get(baseFont) ?? []), ...map]);
      external = merged;
      externalByName.set(baseFont, merged);
    },
    encode: (cp) => {
      if (!encodable) return null;
      const code = codeFor(cp);
      return code == null ? null : Uint8Array.of((code >> 8) & 255, code & 255);
    },
    widthOfCodePoint: (cp) => {
      if (!encodable) return null;
      const code = codeFor(cp);
      return code == null ? null : (W.get(code) ?? dw);
    },
  };
}

function buildType3(
  doc: PDFDocument,
  dict: PDFDict,
  ref: PDFRef | null,
  baseFont: string,
  toUnicodeFromMap: (code: number) => string | null,
): FontInfo {
  const fm = dict.lookup(PDFName.of("FontMatrix"));
  let sx = 0.001;
  if (fm instanceof PDFArray && fm.size() >= 4) {
    const a = fm.lookup(0);
    const b = fm.lookup(1);
    if (a instanceof PDFNumber && b instanceof PDFNumber) sx = Math.hypot(a.asNumber(), b.asNumber());
  }
  const firstChar = lookupNum(dict, "FirstChar", 0);
  const widthsArr = dict.lookup(PDFName.of("Widths"));
  const widths = new Map<number, number>();
  if (widthsArr instanceof PDFArray) {
    for (let i = 0; i < widthsArr.size(); i++) {
      const w = widthsArr.lookup(i);
      if (w instanceof PDFNumber) widths.set(firstChar + i, w.asNumber() * sx * 1000);
    }
  }
  return {
    dict,
    ref,
    subtype: "Type3",
    baseFont,
    kind: "type3",
    vertical: false,
    widthsKnown: widths.size > 0,
    embedded: true,
    subset: false,
    serifLike: false,
    decode: (b) => [...b].map((code) => ({ code, cid: code, nbytes: 1, isSpace: code === 32 })),
    width: (c) => widths.get(c.code) ?? 0,
    toUnicode: (c) => toUnicodeFromMap(c.code),
    encode: () => null,
    widthOfCodePoint: () => null,
  };
}

/** 文字列オペランド（PDFString / PDFHexString）をバイト列に */
export function pdfStringBytes(o: PDFObject): Uint8Array | null {
  if (o instanceof PDFHexString) return o.asBytes();
  if (o instanceof PDFString) return o.asBytes();
  return null;
}

/**
 * 縦書きの字の寸法（テキスト空間 ×1000）。w1：その字の縦の進み（下向きが負。既定 -1000）。
 * v：横書きの原点から見た、縦書きの原点（字の上端の中央）の位置 [vx, vy]（既定は [字の幅の半分, 880]）。
 * 子孫フォントの /DW2（[vy w1]）と /W2（字ごとの指定）から引く
 */
export interface VerticalMetrics {
  w1(cid: number): number;
  v(cid: number, w0: number): [number, number];
}
const verticalCache = new WeakMap<PDFDict, VerticalMetrics>();
export function verticalMetricsOf(font: FontInfo): VerticalMetrics {
  const hit = verticalCache.get(font.dict);
  if (hit) return hit;
  let dvy = 880;
  let dw1 = -1000;
  const per = new Map<number, [number, number, number]>();
  const ranges: [number, number, number, number, number][] = [];
  const desc = font.dict.lookup(PDFName.of("DescendantFonts"));
  const cid = desc instanceof PDFArray ? desc.lookup(0) : undefined;
  if (cid instanceof PDFDict) {
    const dw2 = cid.lookup(PDFName.of("DW2"));
    if (dw2 instanceof PDFArray && dw2.size() >= 2) {
      const a = dw2.lookup(0);
      const b = dw2.lookup(1);
      if (a instanceof PDFNumber && b instanceof PDFNumber) {
        dvy = a.asNumber();
        dw1 = b.asNumber();
      }
    }
    const w2 = cid.lookup(PDFName.of("W2"));
    if (w2 instanceof PDFArray) {
      const n = (o: PDFObject | undefined) => (o instanceof PDFNumber ? o.asNumber() : NaN);
      for (let i = 0; i < w2.size(); ) {
        const first = n(w2.lookup(i));
        const next = w2.lookup(i + 1);
        if (next instanceof PDFArray) {
          // c [w1 vx vy w1 vx vy …]：c から順に 1 字ずつ
          for (let k = 0; k + 2 < next.size(); k += 3) per.set(first + k / 3, [n(next.lookup(k)), n(next.lookup(k + 1)), n(next.lookup(k + 2))]);
          i += 2;
        } else {
          // cfirst clast w1 vx vy：その範囲の字すべて
          ranges.push([first, n(next), n(w2.lookup(i + 2)), n(w2.lookup(i + 3)), n(w2.lookup(i + 4))]);
          i += 5;
        }
        if (!Number.isFinite(first)) break;
      }
    }
  }
  const find = (c: number): [number, number, number] | null => {
    const p = per.get(c);
    if (p && p.every(Number.isFinite)) return p;
    for (const r of ranges) if (c >= r[0] && c <= r[1] && Number.isFinite(r[2]) && Number.isFinite(r[3]) && Number.isFinite(r[4])) return [r[2], r[3], r[4]];
    return null;
  };
  const m: VerticalMetrics = {
    w1: (c) => find(c)?.[0] ?? dw1,
    v: (c, w0) => {
      const f = find(c);
      return f ? [f[1], f[2]] : [w0 / 2, dvy];
    },
  };
  verticalCache.set(font.dict, m);
  return m;
}

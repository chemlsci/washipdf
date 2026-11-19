/**
 * コンテンツストリームを先頭から追いかけ、文字を描く命令（Tj / TJ / ' / "）ごとに
 * 「ページ座標でどこから始まり、どこまで進むか」と、その時点の文字状態（フォント・サイズ・色など）を求める。
 */
import { PDFArray, PDFDict, type PDFDocument, PDFName, PDFNumber, PDFStream } from "pdf-lib";
import { type ContentOp, fmt, latin1, name, num, type Operand, tokenizeContent } from "./contentStream";
import { multiply } from "./geometry";
import { decodeStreamBytes, type FontInfo, getFontInfo, verticalMetricsOf } from "./pdfFontInfo";
import type { Matrix } from "./types";

export interface ShowOp {
  /** ops 配列内の位置 */
  index: number;
  /** 所属するコンテンツストリーム：ページなら []、Form XObject の中なら Do 命令の index の列（外側から） */
  path: number[];
  op: "Tj" | "TJ" | "'" | '"';
  fontResName: string;
  font: FontInfo | null;
  size: number;
  charSpacing: number;
  wordSpacing: number;
  hscale: number;
  rise: number;
  renderMode: number;
  leading: number;
  /** この命令開始時点の Tm × CTM（' / " の改行適用後） */
  trm: Matrix;
  /** 開始点（ページ座標） */
  start: [number, number];
  /** 進み量（テキスト空間、Tm 適用前）。幅が分からないときは null */
  advance: number | null;
  /** 終点（ページ座標）。advance が null なら null */
  end: [number, number] | null;
  /** 塗り色を再現する命令列（"0 0 1 rg" など） */
  fillColorOps: string;
  strokeColorOps: string;
  /** 色の RGB 近似（表示用）。不明なら null */
  fillRgb: [number, number, number] | null;
  /** 文字列のバイト列 */
  text: string;
  /** この命令のあと、同じ BT 内で位置指定なしに続く文字描画命令があるか（削除時に進み量を残す必要がある） */
  nextDependsOnAdvance: boolean;
  /** 直前の文字描画命令からの続き（Td 等を挟まず）か */
  continuesPrevious: boolean;
  /** 所属する BT 命令の index */
  bt: number;
  /** 属する ExtGState などを含む q の深さ（参考） */
  depth: number;
  /**
   * 切り抜き（長方形のクリップ）の外にあって、表示されない文字か。
   * 印刷用ソフトが出力した PDF には、枠からあふれた文字が切り抜きの外に残っていることがある。
   * 見えない文字を見える文字と同じ行にまとめたり、書き換えて見えるようにしたりしないために使う。
   */
  clipped?: boolean;
  /**
   * この命令の時点の座標系（CTM）、行の先頭の文字行列（Tlm）、書き始めの文字行列（Tm）。
   * 命令のある場所に別の描画を差し込み、そのあと文字の状態を元に戻すために使う（' と " では改行適用後）
   */
  ctm?: Matrix;
  tlm?: Matrix;
  tm?: Matrix;
  /** 輪郭を描く文字（Tr 1・2：太字に見せるためなど）の線の太さ（ページ座標での太さ） */
  lineWidth?: number;
  /**
   * この命令を囲む、読みや説明（/ActualText・/Alt・/E）を持つ囲みの BDC 命令（同じストリームの中の位置。名前で指した指定は name も）
   */
  spans?: { index: number; name?: string }[];
  /**
   * この命令を囲む「代わりの文字」の指定（/Span <</ActualText …>> BDC … EMC）。
   * 1 つの字を複数の字形（本体と点など）に分けて描く文書で、字形の集まりが表す本当の文字。id は囲みごとの番号
   */
  actual?: { id: number; text: string };
}

/** 字形に割り当てられる「代わりの文字」が付いているか（1 字〜数字の短いもの。語や行をまるごと言い換えるものは除く） */
export function usableActualText(s: ShowOp): boolean {
  const text = s.actual?.text;
  return !!text && [...text].length <= 6 && !/[\s\u0000-\u001f]/.test(text);
}

/**
 * 「代わりの文字」の囲みの中にある字形に、その文字を割り当てる。
 * 囲みの中でいちばん幅の広い字形（字の本体）に文字を持たせ、残り（点などの部品）は「文字として数えない字形」（幅ゼロの空白）にする。
 * 長い文字列や空白を含む指定（語や行をまるごと言い換えるもの）は、字形との対応が取れないので使わない。
 * 囲みの中の字形がどれも文字を持っているときも、使わない
 */
export function applyActualText<T extends { show: ShowOp }>(glyphs: T[], width: (g: T) => number, textOf: (g: T) => string | null, set: (g: T, text: string) => void): void {
  const groups = new Map<number, T[]>();
  for (const g of glyphs) {
    const a = g.show.actual;
    if (a) groups.set(a.id, [...(groups.get(a.id) ?? []), g]);
  }
  for (const list of groups.values()) {
    const text = list[0].show.actual!.text;
    if (!usableActualText(list[0].show)) continue;
    // 字形がどれも自分の文字を持っているなら、そのまま読める（語をまるごと囲んで読む順の文字列を添えただけのもの：
    // このアプリが書き換えた語もそうなっている）。文字の分からない字形（点などの部品）があるときだけ、指定を使う
    // ただし、1 字だけの指定は、字形が文字を持っていても使う：LibreOffice は、形の同じ字（ت と ث、ي と ى など）に同じ字形を使い、
    // 字形には片方の文字だけを割り当てて、本当の文字を 1 字ずつこの指定で与える
    const oneLetter = [...text.normalize("NFC")].filter((ch) => !/\p{M}/u.test(ch)).length <= 1;
    if (!oneLetter && list.every((g) => (textOf(g) ?? "") !== "" && !textOf(g)!.includes("\ufffd"))) continue;
    let main = list[0];
    for (const g of list) if (Math.abs(width(g)) > Math.abs(width(main)) + 1e-6) main = g;
    for (const g of list) set(g, g === main ? text : "\u200b");
  }
}

/** 囲みの指定（BDC の辞書）から、代わりの文字（ActualText）を取り出す。無ければ null */
export function actualTextOf(raw: string): string | null {
  const at = raw.indexOf("/ActualText");
  if (at < 0) return null;
  const rest = raw.slice(at + 11).replace(/^\s+/, "");
  let bytes: number[] = [];
  if (rest[0] === "<" && rest[1] !== "<") {
    const hex = rest.slice(1, rest.indexOf(">")).replace(/\s+/g, "");
    for (let i = 0; i + 1 < hex.length + 1; i += 2) bytes.push(parseInt((hex.slice(i, i + 2) + "0").slice(0, 2), 16));
  } else if (rest[0] === "(") {
    let depth = 0;
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i];
      if (c === "\\") {
        const n = rest[++i];
        const oct = /^[0-7]{1,3}/.exec(rest.slice(i));
        if (oct) {
          bytes.push(parseInt(oct[0], 8) & 0xff);
          i += oct[0].length - 1;
        } else if (n === "n") bytes.push(10);
        else if (n === "r") bytes.push(13);
        else if (n === "t") bytes.push(9);
        else if (n !== "\n" && n !== undefined) bytes.push(n.charCodeAt(0) & 0xff);
        continue;
      }
      if (c === "(" && depth++ === 0) continue;
      if (c === ")" && --depth === 0) break;
      bytes.push(c.charCodeAt(0) & 0xff);
    }
  } else return null;
  if (bytes.some((b) => Number.isNaN(b))) return null;
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = "";
    for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return out;
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.slice(3);
  return new TextDecoder(bytes.every((b) => b < 0x80) ? "utf-8" : "latin1").decode(Uint8Array.from(bytes));
}

interface GState {
  ctm: Matrix;
  fillOps: string;
  strokeOps: string;
  fillRgb: [number, number, number] | null;
  fillCs: string;
  strokeCs: string;
  // 文字状態（PDF 仕様上はグラフィックス状態の一部）
  font: FontInfo | null;
  fontResName: string;
  size: number;
  tc: number;
  tw: number;
  th: number;
  tl: number;
  ts: number;
  tr: number;
  /** いまの切り抜きの範囲（ページ座標の長方形。長方形だけの切り抜きを追う。それ以外の形は無視＝狭めない） */
  clip: [number, number, number, number] | null;
  /** 線の太さ（w 命令。その時点の座標系での値） */
  lw: number;
}

const SHOW_OPS = new Set(["Tj", "TJ", "'", '"']);
const POSITION_OPS = new Set(["Td", "TD", "Tm", "T*", "BT", "ET"]);

const rawOperands = (bytes: Uint8Array, op: ContentOp): string => {
  // 命令名を除いたオペランド部分の生テキスト
  const s = latin1(bytes, op.start, op.end).trimEnd();
  return s.slice(0, s.length - op.op.length).trim();
};

function cmykToRgb(c: number, m: number, y: number, k: number): [number, number, number] {
  return [(1 - Math.min(1, c + k)) * 255, (1 - Math.min(1, m + k)) * 255, (1 - Math.min(1, y + k)) * 255];
}

export function colorFromOperands(cs: string, a: Operand[]): [number, number, number] | null {
  const nums = a.filter((o) => o.kind === "num").map((o) => (o as { value: number }).value);
  const n = nums.length;
  const csKind = cs;
  if (csKind === "DeviceGray" || (csKind === "" && n === 1) || (csKind === "ICC" && n === 1) || csKind === "CalGray") {
    if (n >= 1) return [nums[0] * 255, nums[0] * 255, nums[0] * 255];
  }
  if (csKind === "DeviceRGB" || csKind === "CalRGB" || (csKind === "ICC" && n === 3) || (csKind === "" && n === 3)) {
    if (n >= 3) return [nums[0] * 255, nums[1] * 255, nums[2] * 255];
  }
  if (csKind === "DeviceCMYK" || (csKind === "ICC" && n === 4) || (csKind === "" && n === 4)) {
    if (n >= 4) return cmykToRgb(nums[0], nums[1], nums[2], nums[3]);
  }
  if (csKind === "Separation" && n === 1) {
    // 単色（黒インク等）の近似：tint 1 = 黒
    const v = (1 - nums[0]) * 255;
    return [v, v, v];
  }
  return null;
}

/** ページ（または Form）のリソースから色空間の種類を大まかに判定する */
export function colorSpaceKind(doc: PDFDocument, resources: PDFDict | undefined, csName: string): string {
  if (/^Device(Gray|RGB|CMYK)$/.test(csName) || csName === "Pattern") return csName;
  if (csName === "CalRGB" || csName === "CalGray") return csName;
  const csDict = resources?.lookup(PDFName.of("ColorSpace"));
  const cs = csDict instanceof PDFDict ? csDict.lookup(PDFName.of(csName)) : undefined;
  if (!cs) return csName;
  const arr = doc.context.lookup(cs);
  if (arr instanceof PDFName) return arr.decodeText();
  if (arr && "size" in arr && typeof (arr as { size: () => number }).size === "function") {
    const first = (arr as unknown as { lookup: (i: number) => unknown }).lookup(0);
    if (first instanceof PDFName) {
      const fam = first.decodeText();
      if (fam === "ICCBased") return "ICC";
      return fam;
    }
  }
  return csName;
}

/** 画像の描画命令（Do／インライン画像 BI） */
export interface ImageDraw {
  /** ops 配列内の位置 */
  index: number;
  /** 所属するコンテンツストリーム（ShowOp.path と同じ） */
  path: number[];
  /** リソース名（インライン画像は空） */
  name: string;
  /** 描画時の CTM（単位正方形がこの行列で画像の位置になる） */
  ctm: Matrix;
  width: number;
  height: number;
  inline: boolean;
}

/** Form XObject の呼び出し 1 回分（同じフォームを 2 回描けば 2 つ） */
export interface FormInvocation {
  /** Do 命令の index の列（外側から）。最後がこのフォームを描く Do */
  path: number[];
  /** Do のオペランド（リソース名） */
  name: string;
  /** フォームの中身（デコード済み）と命令列 */
  bytes: Uint8Array;
  ops: ContentOp[];
  /** フォームの中で使うリソース（自前の /Resources が無ければ親のもの） */
  resources: PDFDict | undefined;
  /** フォームの中身に掛かる CTM（Do 時点の CTM × /Matrix） */
  ctm: Matrix;
}

export interface WalkResult {
  ops: ContentOp[];
  shows: ShowOp[];
  /** 中まで追えなかった Form XObject（深すぎる・循環・読めない）があるか。その中のテキストは編集対象外 */
  usesForms: boolean;
  images: ImageDraw[];
  /** 中まで追った Form XObject の呼び出し */
  forms: FormInvocation[];
  /** 水平・垂直の線（表の罫線など。線で描いたものと、細い塗りの四角）。ページの座標 [x1, y1, x2, y2] */
  rules: Rule[];
}

export type Rule = [number, number, number, number];

/** Form XObject の入れ子をどこまで追うか */
const MAX_FORM_DEPTH = 6;

export const pathKey = (path: number[], index: number) => `${path.join("/")}:${index}`;
export const samePath = (a: number[] | undefined, b: number[] | undefined) => {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/**
 * コンテンツストリームを解釈して、文字描画命令の一覧を返す。Form XObject の中も（入れ子 6 段まで）追い、
 * 中の命令には path（Do 命令の index の列）を付ける。
 * @param resources ページの /Resources（継承済み）
 */
/** 解析の途中でニッカヒットの文字コードを新しく見つけた回数（見つけたら、読み直す） */
let nikhahitFound = 0;

export function walkTextOps(doc: PDFDocument, bytes: Uint8Array, ops: ContentOp[], resources: PDFDict | undefined): WalkResult {
  const before = nikhahitFound;
  const r = walkTextOpsOnce(doc, bytes, ops, resources);
  // タイ文字のニッカヒット（ำ の丸）に使われている文字コードが分かったら、その読みで解析し直す
  return nikhahitFound === before ? r : walkTextOpsOnce(doc, bytes, ops, resources);
}

function walkTextOpsOnce(doc: PDFDocument, bytes: Uint8Array, ops: ContentOp[], resources: PDFDict | undefined): WalkResult {
  /** 直前の字形が「幅 0・空白と読まれる（文字コードは 0x20 以外）」だったときの、そのフォントと文字コード */
  let zeroSpace: { font: FontInfo; code: number } | null = null;
  const shows: ShowOp[] = [];
  let actualSeq = 0;
  const images: ImageDraw[] = [];
  const forms: FormInvocation[] = [];
  const rules: Rule[] = [];
  let usesForms = false;
  const base: GState = {
    ctm: [1, 0, 0, 1, 0, 0],
    fillOps: "0 g",
    strokeOps: "0 G",
    fillRgb: [0, 0, 0],
    fillCs: "DeviceGray",
    strokeCs: "DeviceGray",
    font: null,
    fontResName: "",
    size: 0,
    tc: 0,
    tw: 0,
    th: 1,
    tl: 0,
    ts: 0,
    tr: 0,
    clip: null,
    lw: 1,
  };

  const walk = (bytes: Uint8Array, ops: ContentOp[], resources: PDFDict | undefined, g0: GState, path: number[], chain: PDFStream[]) => {
    const fontsDict = resources?.lookup(PDFName.of("Font"));
    const fonts = fontsDict instanceof PDFDict ? fontsDict : undefined;
    const fontCache = new Map<string, FontInfo | null>();
    const getFont = (n: string) => {
      if (!fontCache.has(n)) fontCache.set(n, fonts ? getFontInfo(doc, fonts.get(PDFName.of(n))) : null);
      return fontCache.get(n)!;
    };
    const stack: GState[] = [];
    let g: GState = { ...g0 };
    let tm: Matrix = [1, 0, 0, 1, 0, 0];
    let tlm: Matrix = [1, 0, 0, 1, 0, 0];
    let btIndex = -1;
    let prevWasShow = false;
    // 囲み（BMC / BDC … EMC）の重なりと、いま効いている「代わりの文字」
    const marked: ({ id: number; text: string } | null)[] = [];
    // 囲みのうち、字の読みや説明（/ActualText・/Alt・/E）を持つもの：BDC 命令の位置と、名前で指した指定ならその名前。
    // 墨消しで中の字を消すとき、読みや説明も一緒に消すために覚える
    const spans: ({ index: number; name?: string } | null)[] = [];
    const propsDict = resources?.lookup(PDFName.of("Properties"));

    const setColorOps = (which: "fill" | "stroke", opName: string, op: ContentOp) => {
      const raw = rawOperands(bytes, op);
      const text = raw ? `${raw} ${opName}` : opName;
      if (which === "fill") {
        g.fillOps = /^(g|rg|k)$/.test(opName) ? text : `/${g.fillCs} cs ${text}`;
      } else {
        g.strokeOps = /^(G|RG|K)$/.test(opName) ? text : `/${g.strokeCs} CS ${text}`;
      }
    };

    const nextShowDepends = (i: number): boolean => {
      for (let k = i + 1; k < ops.length; k++) {
        const o = ops[k].op;
        if (SHOW_OPS.has(o)) return true;
        if (POSITION_OPS.has(o)) return false;
      }
      return false;
    };

    // 進み量：横書きは右へ（テキスト空間の x）、縦書きのフォントは下へ（テキスト空間の y。負の値）
    const measure = (font: FontInfo | null, items: Operand[], st: GState): { advance: number | null; text: string } => {
      let adv = 0;
      let known = !!font && font.widthsKnown;
      let text = "";
      const vm = font?.vertical ? verticalMetricsOf(font) : null;
      for (const it of items) {
        if (it.kind === "num") {
          adv -= (it.value / 1000) * st.size * (vm ? 1 : st.th);
          continue;
        }
        if (it.kind !== "string") continue;
        if (!font) {
          known = false;
          continue;
        }
        for (const c of font.decode(it.bytes)) {
          const w0 = font.width(c) / 1000;
          if (vm) adv += (vm.w1(c.cid) / 1000) * st.size + st.tc + (c.isSpace ? st.tw : 0);
          else adv += (w0 * st.size + st.tc + (c.isSpace ? st.tw : 0)) * st.th;
          const u = font.toUnicode(c);
          text += u ?? "\ufffd";
          if (zeroSpace && u === "\u0e32" && zeroSpace.font.nikhahitCodes && !zeroSpace.font.nikhahitCodes.has(zeroSpace.code)) {
            zeroSpace.font.nikhahitCodes.add(zeroSpace.code);
            nikhahitFound++;
          }
          zeroSpace = w0 === 0 && c.code !== 0x20 && (u === " " || u === "\u00a0") ? { font, code: c.code } : null;
        }
      }
      return { advance: known ? adv : null, text };
    };

    // 切り抜き（… W n）を追う：パスの外接矩形で切り抜きを狭める。実際の切り抜きは外接矩形より狭いこともあるが、
    // 外接矩形の外にある文字は確実に見えない（曲線は制御点の外に出ないので、制御点も含めた外接矩形で足りる）
    let pathRects: [number, number, number, number][] = [];
    let clipNext = false;
    // 線の記録（表の罫線を見つけるため）：いまのパスの、折れ線の部分（曲線で区切る）と四角
    let subs: { pts: [number, number][]; rect: boolean }[] = [];
    const addRule = (a: [number, number], b: [number, number]) => {
      const dx = Math.abs(a[0] - b[0]);
      const dy = Math.abs(a[1] - b[1]);
      if (Math.max(dx, dy) < 3 || Math.min(dx, dy) > 0.5 || rules.length > 20000) return;
      rules.push([a[0], a[1], b[0], b[1]]);
    };
    const strokeRules = (close: boolean) => {
      for (const sp of subs) {
        for (let k = 0; k + 1 < sp.pts.length; k++) addRule(sp.pts[k], sp.pts[k + 1]);
        if ((close || sp.rect) && sp.pts.length > 2) addRule(sp.pts[sp.pts.length - 1], sp.pts[0]);
      }
    };
    // 細い塗りの四角（Word などは罫線をこう描く）は、その中心線を線とみなす
    const fillRules = () => {
      for (const sp of subs) {
        if (sp.pts.length < 4) continue;
        const xs = sp.pts.map((q) => q[0]);
        const ys = sp.pts.map((q) => q[1]);
        const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
        if (y1 - y0 <= 2.5 && x1 - x0 >= 3) addRule([x0, (y0 + y1) / 2], [x1, (y0 + y1) / 2]);
        else if (x1 - x0 <= 2.5 && y1 - y0 >= 3) addRule([(x0 + x1) / 2, y0], [(x0 + x1) / 2, y1]);
      }
    };
    const endPath = () => {
      if (clipNext && pathRects.length) {
        const r: [number, number, number, number] = [Math.min(...pathRects.map((x) => x[0])), Math.min(...pathRects.map((x) => x[1])), Math.max(...pathRects.map((x) => x[2])), Math.max(...pathRects.map((x) => x[3]))];
        g.clip = g.clip ? [Math.max(g.clip[0], r[0]), Math.max(g.clip[1], r[1]), Math.min(g.clip[2], r[2]), Math.min(g.clip[3], r[3])] : r;
      }
      pathRects = [];
      clipNext = false;
      subs = [];
    };

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const a = op.operands;
      switch (op.op) {
        case "re":
          if (a.length >= 4) {
            const [x, y, w, h] = [num(a[0]), num(a[1]), num(a[2]), num(a[3])];
            const pts = [applyPt(g.ctm, x, y), applyPt(g.ctm, x + w, y), applyPt(g.ctm, x, y + h), applyPt(g.ctm, x + w, y + h)];
            pathRects.push([Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1])), Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1]))]);
            subs.push({ pts: [pts[0], pts[1], pts[3], pts[2]], rect: true });
          }
          break;
        case "m":
        case "l":
        case "c":
        case "v":
        case "y":
          for (let k = 0; k + 1 < a.length; k += 2) {
            const [px, py] = applyPt(g.ctm, num(a[k]), num(a[k + 1]));
            pathRects.push([px, py, px, py]);
          }
          if (a.length >= 2) {
            const end = applyPt(g.ctm, num(a[a.length - 2]), num(a[a.length - 1]));
            const last = subs[subs.length - 1];
            // 曲線は線として数えない（終点から新しい折れ線を始める）
            if (op.op === "l" && last && !last.rect) last.pts.push(end);
            else subs.push({ pts: [end], rect: false });
          }
          break;
        case "h": {
          const last = subs[subs.length - 1];
          if (last && !last.rect && last.pts.length > 2) last.pts.push(last.pts[0]);
          break;
        }
        case "W":
        case "W*":
          clipNext = true;
          break;
        case "n":
        case "f":
        case "F":
        case "f*":
        case "S":
        case "s":
        case "B":
        case "B*":
        case "b":
        case "b*":
          if (op.op === "f" || op.op === "F" || op.op === "f*") fillRules();
          else if (op.op !== "n") strokeRules(op.op === "s" || op.op === "b" || op.op === "b*");
          endPath();
          break;
        case "q":
          stack.push({ ...g });
          break;
        case "Q":
          if (stack.length) g = stack.pop()!;
          break;
        case "cm":
          if (a.length >= 6) g.ctm = multiply(g.ctm, [num(a[0]), num(a[1]), num(a[2]), num(a[3]), num(a[4]), num(a[5])]);
          break;
        case "BMC":
          marked.push(null);
          spans.push(null);
          break;
        case "BDC": {
          let text: string | null = null;
          const p = a[1];
          if (p?.kind === "dict") text = actualTextOf(p.raw);
          else if (p?.kind === "name" && propsDict instanceof PDFDict) {
            const d = propsDict.lookup(PDFName.of(p.value));
            const v = d instanceof PDFDict ? d.lookup(PDFName.of("ActualText")) : undefined;
            if (v && "decodeText" in v) text = (v as { decodeText(): string }).decodeText();
          }
          marked.push(text === null ? null : { id: actualSeq++, text });
          {
            const keys = ["ActualText", "Alt", "E"];
            let span: { index: number; name?: string } | null = null;
            if (p?.kind === "dict") {
              if (keys.some((k) => p.raw.includes(`/${k}`))) span = { index: i };
            } else if (p?.kind === "name" && propsDict instanceof PDFDict) {
              const d = propsDict.lookup(PDFName.of(p.value));
              if (d instanceof PDFDict && keys.some((k) => d.has(PDFName.of(k)))) span = { index: i, name: p.value };
            }
            spans.push(span);
          }
          break;
        }
        case "EMC":
          marked.pop();
          spans.pop();
          break;
        case "BT":
          tm = [1, 0, 0, 1, 0, 0];
          tlm = tm;
          btIndex = i;
          prevWasShow = false;
          break;
        case "ET":
          btIndex = -1;
          prevWasShow = false;
          break;
        case "Tf": {
          g.fontResName = name(a[0]) ?? "";
          g.size = num(a[1]);
          g.font = g.fontResName ? getFont(g.fontResName) : null;
          break;
        }
        case "gs": {
          // グラフィック状態の辞書からフォントを指定する書き方（/Font [フォント 大きさ]）。まれだが、見落とすと
          // そのあとの文字の位置を、前のフォントの幅で計算してしまう
          const gsName = name(a[0]);
          const dicts = resources?.lookup(PDFName.of("ExtGState"));
          const d = gsName && dicts instanceof PDFDict ? dicts.lookup(PDFName.of(gsName)) : undefined;
          const f = d instanceof PDFDict ? d.lookup(PDFName.of("Font")) : undefined;
          if (f instanceof PDFArray && f.size() >= 2) {
            const sz = f.lookup(1);
            // リソースの名前を持たないフォントなので、元のフォントでの書き換えはできない（消す・上に書くは位置が合う）
            g.fontResName = "";
            g.size = sz instanceof PDFNumber ? sz.asNumber() : 0;
            g.font = getFontInfo(doc, f.get(0));
          }
          break;
        }
        case "Td":
          tlm = multiply(tlm, [1, 0, 0, 1, num(a[0]), num(a[1])]);
          tm = tlm;
          prevWasShow = false;
          break;
        case "TD":
          g.tl = -num(a[1]);
          tlm = multiply(tlm, [1, 0, 0, 1, num(a[0]), num(a[1])]);
          tm = tlm;
          prevWasShow = false;
          break;
        case "Tm":
          if (a.length >= 6) tlm = [num(a[0]), num(a[1]), num(a[2]), num(a[3]), num(a[4]), num(a[5])];
          tm = tlm;
          prevWasShow = false;
          break;
        case "T*":
          tlm = multiply(tlm, [1, 0, 0, 1, 0, -g.tl]);
          tm = tlm;
          prevWasShow = false;
          break;
        case "TL":
          g.tl = num(a[0]);
          break;
        case "Tc":
          g.tc = num(a[0]);
          break;
        case "Tw":
          g.tw = num(a[0]);
          break;
        case "Tz":
          g.th = num(a[0], 100) / 100;
          break;
        case "Ts":
          g.ts = num(a[0]);
          break;
        case "Tr":
          g.tr = num(a[0]);
          break;
        case "w":
          g.lw = num(a[0]);
          break;
        case "g":
        case "rg":
        case "k": {
          g.fillCs = op.op === "g" ? "DeviceGray" : op.op === "rg" ? "DeviceRGB" : "DeviceCMYK";
          g.fillRgb = colorFromOperands(g.fillCs, a);
          setColorOps("fill", op.op, op);
          break;
        }
        case "G":
        case "RG":
        case "K": {
          g.strokeCs = op.op === "G" ? "DeviceGray" : op.op === "RG" ? "DeviceRGB" : "DeviceCMYK";
          setColorOps("stroke", op.op, op);
          break;
        }
        case "cs":
          g.fillCs = name(a[0]) ?? "DeviceGray";
          g.fillOps = `/${g.fillCs} cs`;
          g.fillRgb = g.fillCs === "DeviceGray" || g.fillCs === "DeviceRGB" || g.fillCs === "DeviceCMYK" ? [0, 0, 0] : null;
          break;
        case "CS":
          g.strokeCs = name(a[0]) ?? "DeviceGray";
          g.strokeOps = `/${g.strokeCs} CS`;
          break;
        case "sc":
        case "scn": {
          g.fillRgb = colorFromOperands(colorSpaceKind(doc, resources, g.fillCs), a);
          setColorOps("fill", op.op, op);
          break;
        }
        case "SC":
        case "SCN":
          setColorOps("stroke", op.op, op);
          break;
        case "Do": {
          const n = name(a[0]);
          const xd = resources?.lookup(PDFName.of("XObject"));
          const x = n && xd instanceof PDFDict ? xd.lookup(PDFName.of(n)) : undefined;
          if (n && x instanceof PDFStream && x.dict.lookup(PDFName.of("Subtype")) === PDFName.of("Image")) {
            const w = x.dict.lookup(PDFName.of("Width"));
            const h = x.dict.lookup(PDFName.of("Height"));
            images.push({ index: i, path, name: n, ctm: g.ctm, width: w instanceof PDFNumber ? w.asNumber() : 0, height: h instanceof PDFNumber ? h.asNumber() : 0, inline: false });
          } else if (n && x instanceof PDFStream && x.dict.lookup(PDFName.of("Subtype")) === PDFName.of("Form")) {
            // Form XObject：中身を同じ状態（色・フォント）で追う。座標は Do 時点の CTM × /Matrix
            const inner = decodeFormContent(doc, x);
            if (!inner || chain.length >= MAX_FORM_DEPTH || chain.includes(x)) {
              usesForms = true;
              break;
            }
            const m = formMatrix(x);
            const innerRes = x.dict.lookup(PDFName.of("Resources"));
            const res = innerRes instanceof PDFDict ? innerRes : resources;
            const innerOps = tokenizeContent(inner);
            const innerPath = [...path, i];
            forms.push({ path: innerPath, name: n, bytes: inner, ops: innerOps, resources: res, ctm: multiply(g.ctm, m) });
            walk(inner, innerOps, res, { ...g, ctm: multiply(g.ctm, m) }, innerPath, [...chain, x]);
          } else usesForms = true;
          break;
        }
        case "BI":
          images.push({ index: i, path, name: "", ctm: g.ctm, width: op.inlineSize?.[0] ?? 0, height: op.inlineSize?.[1] ?? 0, inline: true });
          break;
        case "Tj":
        case "TJ":
        case "'":
        case '"': {
          let items: Operand[];
          if (op.op === '"') {
            g.tw = num(a[0]);
            g.tc = num(a[1]);
            items = a[2] ? [a[2]] : [];
          } else if (op.op === "'") items = a[0] ? [a[0]] : [];
          else if (op.op === "TJ") items = a[0]?.kind === "array" ? a[0].items : [];
          else items = a[0] ? [a[0]] : [];
          if (op.op === "'" || op.op === '"') {
            tlm = multiply(tlm, [1, 0, 0, 1, 0, -g.tl]);
            tm = tlm;
          }
          // Trm = Tm × CTM（multiply(A, B) は「B を適用してから A」なので引数は ctm, tm の順）
          const trm = multiply(g.ctm, tm);
          const startPt = applyPt(trm, 0, g.ts);
          const { advance, text } = measure(g.font, items, g);
          const vertical = !!g.font?.vertical;
          const endPt = advance == null ? null : vertical ? applyPt(trm, 0, g.ts + advance) : applyPt(trm, advance, g.ts);
          // 切り抜きの外か：文字のおおよその範囲（始点・終点・字の高さ）が、切り抜きの長方形とまったく重ならない
          let clipped = false;
          if (g.clip && g.size) {
            const top = applyPt(trm, 0, g.ts + g.size * 0.8);
            const xs = [startPt[0], top[0], ...(endPt ? [endPt[0]] : [])];
            const ys = [startPt[1], top[1], ...(endPt ? [endPt[1]] : [])];
            const pad = 0.5;
            clipped = Math.max(...xs) < g.clip[0] - pad || Math.min(...xs) > g.clip[2] + pad || Math.max(...ys) < g.clip[1] - pad || Math.min(...ys) > g.clip[3] + pad;
            // 終点が分からない（幅の分からないフォント）ときは、右へ続くので左側の判定だけでは決めない
            if (!endPt && !(Math.min(...xs) > g.clip[2] + pad || Math.max(...ys) < g.clip[1] - pad || Math.min(...ys) > g.clip[3] + pad)) clipped = false;
          }
          shows.push({
            clipped,
            index: i,
            path,
            op: op.op,
            fontResName: g.fontResName,
            font: g.font,
            size: g.size,
            charSpacing: g.tc,
            wordSpacing: g.tw,
            hscale: g.th,
            rise: g.ts,
            renderMode: g.tr,
            leading: g.tl,
            trm,
            ctm: g.ctm,
            tlm,
            tm,
            start: startPt,
            advance,
            end: endPt,
            lineWidth: g.lw * Math.sqrt(Math.abs(g.ctm[0] * g.ctm[3] - g.ctm[1] * g.ctm[2])),
            fillColorOps: g.fillOps,
            strokeColorOps: g.strokeOps,
            fillRgb: g.fillRgb,
            text,
            nextDependsOnAdvance: nextShowDepends(i),
            continuesPrevious: prevWasShow,
            bt: btIndex,
            depth: stack.length,
            actual: marked.reduce<{ id: number; text: string } | undefined>((p, m) => m ?? p, undefined),
            spans: spans.filter((x): x is { index: number; name?: string } => x !== null),
          });
          if (advance != null) tm = multiply(tm, vertical ? [1, 0, 0, 1, 0, advance] : [1, 0, 0, 1, advance, 0]);
          prevWasShow = true;
          break;
        }
        default:
          break;
      }
    }
  };

  walk(bytes, ops, resources, base, [], []);
  return { ops, shows, usesForms, images, forms, rules };
}

/** Form XObject の /Matrix（無ければ単位行列） */
export function formMatrix(x: PDFStream): Matrix {
  const m = x.dict.lookup(PDFName.of("Matrix"));
  if (m instanceof PDFArray && m.size() === 6) {
    const v = m.asArray().map((o) => (o instanceof PDFNumber ? o.asNumber() : 0));
    return [v[0], v[1], v[2], v[3], v[4], v[5]];
  }
  return [1, 0, 0, 1, 0, 0];
}

function decodeFormContent(doc: PDFDocument, x: PDFStream): Uint8Array | null {
  try {
    return decodeStreamBytes(doc, x);
  } catch {
    return null;
  }
}

function applyPt(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** 削除する文字描画命令の代わりに置く「同じだけ進む」命令。進み量が不明なら空文字 */
export function advanceReplacement(s: ShowOp): string {
  const parts: string[] = [];
  if (s.op === '"') parts.push(`${fmt(s.wordSpacing)} Tw ${fmt(s.charSpacing)} Tc`);
  if (s.op === "'" || s.op === '"') parts.push("T*");
  if (s.nextDependsOnAdvance && s.advance != null && s.size && s.hscale) {
    // 縦書きは下へ進む（TJ の数は縦の位置から引かれる。横の倍率 Th は掛からない）
    const adj = (-s.advance / (s.font?.vertical ? s.size : s.size * s.hscale)) * 1000;
    if (Math.abs(adj) > 1e-6) parts.push(`[${fmt(adj)}] TJ`);
  }
  return parts.join(" ");
}

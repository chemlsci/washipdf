/**
 * 元ページの内容に対する削除をまとめて適用する：
 * - 実編集（textedit）で消す文字描画命令
 * - 既存画像の削除（imageedit）
 * - 墨消し（redact）：範囲に掛かる字形を命令から取り除き（字送りは残す）、範囲に掛かる画像は丸ごと消す
 *
 * - 図形（パス）：範囲に掛かるサブパスを幾何的に切り取る（redactPaths.ts）
 *
 * 命令番号は解析時（元のコンテンツストリーム）のものなので、1 回の差し替えで全部適用する。
 * Form XObject の中身・シェーディング・クリップ付きのパスは形を変えられないため、
 * clipRedactedAreas で範囲を除いたクリップを掛けて見えなくする（安全網）。
 */
import { PDFArray, PDFDict, type PDFDocument, PDFName, PDFNumber, type PDFObject, type PDFPage, PDFRef, PDFStream } from "pdf-lib";
import { type ContentOp, fmt, name, type Operand, spliceContent, tokenizeContent } from "./contentStream";
import { apply, invert } from "./geometry";
import { tr, AppError } from "./i18n";
import { pageContentBytes } from "./libDoc";
import { unitSquareBounds } from "./pageImages";
import { redactPathOps } from "./redactPaths";
import { decodeStreamBytes, verticalMetricsOf } from "./pdfFontInfo";
import { advanceReplacement, type FormInvocation, pathKey, samePath, type ShowOp, walkTextOps } from "./textOps";
import type { ImageEditObj, Matrix, PageItem, RedactObj, TextEditObj } from "./types";

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 表示座標の矩形（左上原点）→ PDF 座標の外接矩形 */
export function displayRectToPage(item: PageItem, r: { x: number; y: number; w: number; h: number }): Rect {
  const M = invert(item.viewTransform);
  const pts = [apply(M, r.x, r.y), apply(M, r.x + r.w, r.y), apply(M, r.x, r.y + r.h), apply(M, r.x + r.w, r.y + r.h)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

const overlap = (a: Rect, b: Rect) => {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
};
const inside = (r: Rect, x: number, y: number) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;

const toHex = (b: Uint8Array) => {
  let s = "<";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return `${s}>`;
};

/** 字形 1 つの外接矩形（テキスト空間 → ページ座標）。高さは字面の目安 */
export function glyphBounds(trm: Matrix, pos: number, tx: number, size: number, rise: number): Rect {
  const y0 = rise - 0.22 * size;
  const y1 = rise + 0.82 * size;
  const pts = [apply(trm, pos, y0), apply(trm, pos + tx, y0), apply(trm, pos, y1), apply(trm, pos + tx, y1)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/**
 * 縦書きの字形 1 つの外接矩形（テキスト空間 → ページ座標）。pos は字の位置（縦書きの原点＝字の上端の中央）の y。
 * 横書きの原点は、そこから v（[vx, vy]）だけ戻った所。字の枠は、横書きの原点から右へ字の幅、上へ 880・下へ 120（全角の枠）
 */
function verticalGlyphBounds(trm: Matrix, pos: number, w0: number, v: [number, number], w1: number, size: number, rise: number, band?: [number, number]): Rect {
  const w = Math.max(w0, 0.5) * size;
  const left = -(v[0] / 1000) * size;
  const base = pos - (v[1] / 1000) * size + rise;
  // 縦の広がりは、その字の進み（w1）ぶん（横書きで字の幅ぶんを見るのと同じ）。進みが分からない・0 のときは全角 1 字ぶん
  const tall = Math.abs(w1) > 1 ? Math.abs(w1) / 1000 : 1;
  // band：字の幅のうち、中ほどだけを見るとき（[0.2, 0.8] など）
  const x0 = left + w * (band ? band[0] : 0);
  const x1 = left + w * (band ? band[1] : 1);
  const top = base + 0.88 * size;
  const pts = [apply(trm, x0, top - tall * size), apply(trm, x1, top - tall * size), apply(trm, x0, top), apply(trm, x1, top)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** 横書きの字形の、字の中ほどの帯（ベースラインの少し下から、小文字の高さの少し上まで）。細い範囲が字に掛かっているかを見るのに使う */
function coreBounds(trm: Matrix, pos: number, tx: number, size: number, rise: number): Rect {
  const pts = [apply(trm, pos, rise - 0.05 * size), apply(trm, pos + tx, rise - 0.05 * size), apply(trm, pos, rise + 0.6 * size), apply(trm, pos + tx, rise + 0.6 * size)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/**
 * 範囲 r が字形（外接矩形 gb）を消す対象にするか。
 * - 字形の中心が範囲の中、または字形の半分以上が範囲に入っている
 * - 細い範囲（点線の「....」や「ー」だけを囲んだときなど、字の枠の半分も覆えない高さ・幅の範囲）：
 *   字の進む向きに半分以上重なり、字の中ほどの帯（core）に掛かっていれば対象にする（下線だけを囲んだ範囲は、帯に掛からないので対象にしない）
 * alongX：字の進む向きがページの横か
 */
function hitsGlyph(r: Rect, gb: Rect, core: Rect, alongX: boolean): boolean {
  const gw = gb.x1 - gb.x0;
  const gh = gb.y1 - gb.y0;
  const area = gw * gh;
  if (inside(r, (gb.x0 + gb.x1) / 2, (gb.y0 + gb.y1) / 2) || (area > 0 && overlap(r, gb) / area >= 0.5)) return true;
  const ox = Math.min(r.x1, gb.x1) - Math.max(r.x0, gb.x0);
  const oy = Math.min(r.y1, gb.y1) - Math.max(r.y0, gb.y0);
  if (alongX) return r.y1 - r.y0 < gh * 0.6 && ox >= gw * 0.5 && Math.min(r.y1, core.y1) - Math.max(r.y0, core.y0) > 0;
  return r.x1 - r.x0 < gw * 0.6 && oy >= gh * 0.5 && Math.min(r.x1, core.x1) - Math.max(r.x0, core.x0) > 0;
}

/**
 * 文字描画命令から、範囲に掛かる字形を取り除いた命令を作る。
 * 返り値：null = 触れていない、"unknown" = 幅が分からず判定できない、それ以外 = 置き換える命令文字列
 */
function redactShow(s: ShowOp, op: ContentOp, rects: Rect[], removed: string[]): string | null | "unknown" {
  const font = s.font;
  if (!font || !font.widthsKnown || !s.size || !s.hscale) {
    // 位置が分からない。開始点が範囲内か、全角の字が並ぶとみなした広さ（実際より広め）が範囲に掛かれば、安全側で丸ごと消す
    // （開始点が範囲の外でも、範囲の下の字を残さないように）
    const size = s.size || 12;
    // TJ の数値で空ける分（横書きは負の数で右へ、縦書きは正の数で下へ）も足す
    const nums = op.op === "TJ" && op.operands[0]?.kind === "array" ? op.operands[0].items.filter((it) => it.kind === "num").map((it) => (it.kind === "num" ? it.value / 1000 : 0)) : [];
    const count = [...s.text].length;
    let est: Rect;
    if (font?.vertical) {
      // 縦書き：字の位置（列の中央）から下へ、字数ぶん
      const len = (count + nums.reduce((g, v) => g + Math.max(0, v), 0)) * size;
      const pts = [apply(s.trm, -size / 2, s.rise), apply(s.trm, size / 2, s.rise), apply(s.trm, -size / 2, s.rise - len), apply(s.trm, size / 2, s.rise - len)];
      est = { x0: Math.min(...pts.map((q) => q[0])), y0: Math.min(...pts.map((q) => q[1])), x1: Math.max(...pts.map((q) => q[0])), y1: Math.max(...pts.map((q) => q[1])) };
    } else est = glyphBounds(s.trm, 0, (count + nums.reduce((g, v) => g + Math.max(0, -v), 0)) * size * (s.hscale || 1), size, s.rise);
    if (rects.some((r) => inside(r, s.start[0], s.start[1]) || overlap(r, est) > 0)) {
      removed.push(s.text);
      return `${advanceReplacement(s)}\n`;
    }
    return "unknown";
  }
  const a = op.operands;
  let items: Operand[];
  if (op.op === '"') items = a[2] ? [a[2]] : [];
  else if (op.op === "'") items = a[0] ? [a[0]] : [];
  else if (op.op === "TJ") items = a[0]?.kind === "array" ? a[0].items : [];
  else items = a[0] ? [a[0]] : [];

  const out: string[] = [];
  let keep: number[] = [];
  // 消した字の進み量は、続けて消した分（あいだにあった TJ の数値も含めて）を 1 つの数にまとめる。
  // 字ごとの数を並べると、消した字それぞれの幅がファイルに残り、何の字だったかを推し量れてしまう
  let gap = 0;
  let gapOpen = false;
  const flushGap = () => {
    if (gapOpen && Math.abs(gap) > 1e-6) out.push(fmt(gap));
    gap = 0;
    gapOpen = false;
  };
  const flushKeep = () => {
    if (keep.length) out.push(toHex(Uint8Array.from(keep)));
    keep = [];
  };
  let pos = 0;
  let changed = false;
  let removedText = "";
  // 縦書き（Identity-V など）：字は下へ進む（字ごとの /W2 も見る）
  const vm = font.vertical ? verticalMetricsOf(font) : null;
  // 字の進む向きが、ページの横か縦か
  const alongX = vm ? Math.abs(s.trm[2]) >= Math.abs(s.trm[3]) : Math.abs(s.trm[0]) >= Math.abs(s.trm[1]);
  for (const it of items) {
    if (it.kind === "num") {
      if (gapOpen) gap += it.value;
      else {
        flushKeep();
        out.push(fmt(it.value));
      }
      pos -= (it.value / 1000) * s.size * (vm ? 1 : s.hscale);
      continue;
    }
    if (it.kind !== "string") continue;
    let off = 0;
    for (const c of font.decode(it.bytes)) {
      const w0 = font.width(c) / 1000;
      const extra = s.charSpacing + (c.isSpace ? s.wordSpacing : 0);
      // 進み量：横書きは右へ tx、縦書きは下へ（pos はテキスト空間の y。w1 は負）
      const w1 = vm ? vm.w1(c.cid) : 0;
      const tx = vm ? (w1 / 1000) * s.size + extra : (w0 * s.size + extra) * s.hscale;
      let gb: Rect;
      let core: Rect;
      if (vm) {
        const v = vm.v(c.cid, w0 * 1000);
        gb = verticalGlyphBounds(s.trm, pos, w0, v, w1, s.size, s.rise);
        core = verticalGlyphBounds(s.trm, pos, w0, v, w1, s.size, s.rise, [0.2, 0.8]);
      } else {
        gb = glyphBounds(s.trm, pos, tx, s.size, s.rise);
        core = coreBounds(s.trm, pos, tx, s.size, s.rise);
      }
      const hit = rects.some((r) => hitsGlyph(r, gb, core, alongX));
      const n = Math.max(1, c.nbytes);
      const glyphBytes = it.bytes.subarray(off, off + n);
      off += n;
      if (hit) {
        flushKeep();
        // 消した字形と同じだけ進む調整値（TJ の単位は 1/1000 テキスト空間、Tfs と Th が掛かる。縦書きは下へ進む分）
        gap += vm ? -(w1 + (extra * 1000) / s.size) : -(w0 * 1000 + (extra * 1000) / s.size);
        gapOpen = true;
        changed = true;
        removedText += font.toUnicode(c) ?? "";
      } else {
        flushGap();
        keep.push(...glyphBytes);
        removedText += " ";
      }
      pos += tx;
    }
    if (off < it.bytes.length) {
      flushGap();
      keep.push(...it.bytes.subarray(off));
    }
  }
  flushKeep();
  // 命令の終わりまで消したとき：後ろの命令がこの命令の進み量に頼っていなければ、進み量は書かない（消した幅を残さない）
  if (gapOpen && !s.nextDependsOnAdvance) gap = 0;
  flushGap();
  if (!changed) return null;
  if (removedText.trim()) removed.push(removedText);
  let prefix = "";
  if (s.op === '"') prefix = `${fmt(s.wordSpacing)} Tw ${fmt(s.charSpacing)} Tc T* `;
  else if (s.op === "'") prefix = "T* ";
  return out.length ? `${prefix}[${out.join(" ")}] TJ\n` : prefix ? `${prefix}\n` : "\n";
}

/** リソースの /Properties の項目から、読み・説明（/ActualText・/Alt・/E）を取り除く */
function scrubProperty(resources: PDFDict | undefined, propName: string): void {
  const props = resources?.lookup(PDFName.of("Properties"));
  const d = props instanceof PDFDict ? props.lookup(PDFName.of(propName)) : undefined;
  if (d instanceof PDFDict) for (const k of ["ActualText", "Alt", "E"]) d.delete(PDFName.of(k));
}

/**
 * ページ（と、そこから呼ばれる部品）のリソースに、文字や画像を含むタイリングパターン・ソフトマスクがあるか。
 * 線や塗りだけの模様（網掛けなど）は、読める情報を持たないので数えない
 */
function hasHiddenContent(doc: PDFDocument, pageRes: PDFDict | undefined, forms: FormInvocation[]): boolean {
  const seen = new Set<PDFDict>();
  const carries = (st: PDFObject | undefined): boolean => {
    if (!(st instanceof PDFStream)) return false;
    const bytes = decodeStreamBytes(doc, st);
    if (!bytes) return true;
    try {
      return tokenizeContent(bytes).some((op) => op.op === "Tj" || op.op === "TJ" || op.op === "'" || op.op === '"' || op.op === "Do" || op.op === "BI");
    } catch {
      return true;
    }
  };
  const check = (res: PDFDict | undefined): boolean => {
    if (!res || seen.has(res)) return false;
    seen.add(res);
    const pats = res.lookup(PDFName.of("Pattern"));
    if (pats instanceof PDFDict) for (const [k] of pats.entries()) if (carries(pats.lookup(k))) return true;
    const gss = res.lookup(PDFName.of("ExtGState"));
    if (gss instanceof PDFDict)
      for (const [k] of gss.entries()) {
        const gs = gss.lookup(k);
        const sm = gs instanceof PDFDict ? gs.lookup(PDFName.of("SMask")) : undefined;
        if (sm instanceof PDFDict && carries(sm.lookup(PDFName.of("G")))) return true;
      }
    return false;
  };
  return check(pageRes) || forms.some((f) => check(f.resources));
}

export interface RewriteOptions {
  textEdits: TextEditObj[];
  imageDeletes: ImageEditObj[];
  redacts: RedactObj[];
  /** 消しきれたかを確かめられない内容があった（読めない部品、模様・マスクの中の文字や画像） */
  onUncertain?: () => void;
  onWarning?: (message: string) => void;
  /** 警告文に使うページ番号（1 始まり） */
  pageNo: number;
  /** 墨消しで取り除いた文字列（取りこぼし検査に使う） */
  onRemovedText?: (text: string) => void;
  /** 消した画像・書き換える前の Form XObject の参照（保存前に、ファイルに残らないよう取り除く対象） */
  onSensitiveRef?: (ref: PDFRef) => void;
  /** 一部だけ塗りつぶした画像への差し替え（ページ直下の Do の番号 → 塗りつぶした複製）。redactImageRegions の結果 */
  imageReplacements?: Map<string, PDFRef>;
  /** 範囲に掛かっていても、そのまま残す画像（消す画素が無いと分かっているもの） */
  imageKeep?: Set<string>;
}

/** 1 本のコンテンツストリーム（ページ、または Form XObject の呼び出し 1 回）に対する差し替え */
interface StreamEdits {
  splices: Map<number, string>;
  /** Do 命令の index → その呼び出しの中への差し替え */
  children: Map<number, StreamEdits>;
  /** この内容のリソースに足す XObject（名前と参照）。部品の中の画像を、塗りつぶした複製に差し替えるときに使う */
  xobjects: [string, PDFRef][];
}

const newEdits = (): StreamEdits => ({ splices: new Map(), children: new Map(), xobjects: [] });
const hasEdits = (e: StreamEdits): boolean => e.splices.size > 0 || [...e.children.values()].some(hasEdits);

function editsAt(root: StreamEdits, path: number[] | undefined): StreamEdits {
  let cur = root;
  for (const i of path ?? []) {
    let c = cur.children.get(i);
    if (!c) {
      c = newEdits();
      cur.children.set(i, c);
    }
    cur = c;
  }
  return cur;
}

export function lookupXObject(resources: PDFDict | undefined, n: string): PDFStream | null {
  const xd = resources?.lookup(PDFName.of("XObject"));
  const x = xd instanceof PDFDict ? xd.lookup(PDFName.of(n)) : undefined;
  return x instanceof PDFStream ? x : null;
}

/** リソース辞書の /XObject に新しい名前で登録する（辞書は複製してから触る） */
function addXObject(doc: PDFDocument, target: PDFDict, ref: PDFRef, cloned: Set<PDFDict>): string {
  const existing = target.lookup(PDFName.of("XObject"));
  let xo: PDFDict;
  if (!(existing instanceof PDFDict)) {
    xo = doc.context.obj({});
    target.set(PDFName.of("XObject"), xo);
  } else if (!cloned.has(existing)) {
    xo = existing.clone(doc.context);
    target.set(PDFName.of("XObject"), xo);
  } else xo = existing;
  cloned.add(xo);
  let n = 1;
  while (xo.has(PDFName.of(`WashiF${n}`))) n++;
  const nm = `WashiF${n}`;
  xo.set(PDFName.of(nm), ref);
  return nm;
}

/**
 * 差し替えを適用した新しいバイト列を返す。Do の先（Form XObject）に差し替えがあれば、
 * そのフォームを複製して中身を書き換え、Do を複製の名前に向ける（同じフォームを使う他のページ・他の呼び出しは変わらない）。
 * @param resources この内容の名前解決に使うリソース辞書
 * @param addTo 新しい XObject 名を登録する辞書（自前の /Resources が無いフォームは親に登録する）
 */
function applyStreamEdits(doc: PDFDocument, bytes: Uint8Array, ops: ContentOp[], resources: PDFDict | undefined, addTo: PDFDict, edits: StreamEdits, cloned: Set<PDFDict>, sensitive: PDFRef[]): Uint8Array {
  const splices = new Map(edits.splices);
  for (const [doIndex, child] of edits.children) {
    if (!hasEdits(child)) continue;
    const op = ops[doIndex];
    const n = op && op.op === "Do" ? name(op.operands[0]) : null;
    const stream = n ? lookupXObject(resources, n) : null;
    if (!stream) throw new AppError(tr("export.contentMismatch"));
    const inner = decodeStreamBytes(doc, stream);
    if (!inner) throw new AppError(tr("export.contentMismatch"));
    const ownRes = stream.dict.lookup(PDFName.of("Resources"));
    const resClone = ownRes instanceof PDFDict ? ownRes.clone(doc.context) : null;
    // 部品の中で使う新しい XObject（塗りつぶした画像の複製）を、部品のリソース（無ければ親）に足す
    for (const [nm, xref] of child.xobjects) {
      const target = resClone ?? addTo;
      const existing = target.lookup(PDFName.of("XObject"));
      let xo: PDFDict;
      if (!(existing instanceof PDFDict)) xo = doc.context.obj({});
      else if (!cloned.has(existing)) xo = existing.clone(doc.context);
      else xo = existing;
      target.set(PDFName.of("XObject"), xo);
      cloned.add(xo);
      xo.set(PDFName.of(nm), xref);
    }
    const newInner = applyStreamEdits(doc, inner, tokenizeContent(inner), resClone ?? resources, resClone ?? addTo, child, cloned, sensitive);
    const ns = doc.context.flateStream(newInner);
    for (const [k, v] of stream.dict.entries()) {
      const key = k.decodeText();
      if (key === "Length" || key === "Filter" || key === "DecodeParms") continue;
      ns.dict.set(k, v);
    }
    if (resClone) ns.dict.set(PDFName.of("Resources"), resClone);
    const ref = doc.context.register(ns);
    const nm = addXObject(doc, addTo, ref, cloned);
    splices.set(doIndex, `/${nm} Do\n`);
  }
  if (!splices.size) return bytes;
  // 外す・差し替える Do が指していた XObject（消した画像、書き換える前のフォーム）を覚えておく。
  // 保存の前に、リソース辞書に名前だけ残っていないかを調べて取り除くため（purge.ts）
  const xd = resources?.lookup(PDFName.of("XObject"));
  if (xd instanceof PDFDict) {
    for (const i of splices.keys()) {
      const op = ops[i];
      const n = op?.op === "Do" ? name(op.operands[0]) : null;
      const raw = n ? xd.get(PDFName.of(n)) : undefined;
      if (raw instanceof PDFRef) sensitive.push(raw);
    }
  }
  return spliceContent(
    bytes,
    [...splices].map(([i, text]) => ({ start: ops[i].start, end: ops[i].end, text })),
  );
}

export function rewritePageContent(doc: PDFDocument, page: PDFPage, item: PageItem, o: RewriteOptions): void {
  const bytes = pageContentBytes(doc, page);
  const ops = tokenizeContent(bytes);
  // 出力ページで解析し直す（内容は元と同じなので命令番号は解析時と一致する）。Form XObject の中も追う
  const walked = walkTextOps(doc, bytes, ops, page.node.Resources());
  const streamOf = (path: number[] | undefined): { ops: ContentOp[]; bytes: Uint8Array; ctm: Matrix } | null => {
    if (!path?.length) return { ops, bytes, ctm: [1, 0, 0, 1, 0, 0] };
    const f = walked.forms.find((x) => samePath(x.path, path));
    return f ? { ops: f.ops, bytes: f.bytes, ctm: f.ctm } : null;
  };
  const root = newEdits();
  /** ページのリソースに足す XObject（塗りつぶした画像の複製） */
  const newXObjects: [string, PDFRef][] = [];
  for (const e of o.textEdits) {
    for (const r of e.removals) {
      const st = streamOf(r.path);
      const op = st?.ops[r.index];
      if (!op || op.op !== r.op) throw new AppError(tr("export.contentMismatch"));
      const ed = editsAt(root, r.path);
      if (!ed.splices.has(r.index)) ed.splices.set(r.index, r.replacement ? `${r.replacement}\n` : "");
    }
  }
  for (const d of o.imageDeletes) {
    const st = streamOf(d.path);
    const op = st?.ops[d.opIndex];
    if (!op || (op.op !== "Do" && op.op !== "BI")) throw new AppError(tr("export.contentMismatch"));
    editsAt(root, d.path).splices.set(d.opIndex, "");
  }
  if (o.redacts.length) {
    const rects = o.redacts.map((r) => displayRectToPage(item, r));
    for (const im of walked.images) {
      const ed = editsAt(root, im.path);
      if (ed.splices.has(im.index)) continue;
      if (!rects.some((r) => overlap(r, unitSquareBounds(im.ctm)) > 0)) continue;
      // 一部だけ掛かる画像は、その範囲の画素を塗りつぶした複製に差し替える（redactImageRegions が用意したもの）。
      // 用意できなかった画像（復号できない形式など）と、全体が範囲に入る画像は、描画命令ごと取り除く（安全側）
      if (o.imageKeep?.has(pathKey(im.path, im.index))) continue;
      const replaced = o.imageReplacements?.get(pathKey(im.path, im.index));
      if (replaced) {
        // リソース辞書をページ間で共有していても重ならないよう、複製のオブジェクト番号を名前に入れる
        const nm = `WashiRedacted${replaced.objectNumber}`;
        if (im.path.length) ed.xobjects.push([nm, replaced]);
        else newXObjects.push([nm, replaced]);
        ed.splices.set(im.index, `/${nm} Do\n`);
      } else ed.splices.set(im.index, "");
    }
    let unknown = 0;
    const removed: string[] = [];
    // 1 字ずつ、または語の途中で命令が分かれている文書がある。続けて消した命令の字は 1 つの語としてつなぐ
    // （消した語がほかの所に残っていないかを調べるとき、1 字ずつでは語にならない）
    // つなぐのは、前の命令の終わりのすぐ後ろ（同じ行で、字 1 つぶんほどの間）から始まる命令だけ。
    // 別の行の命令をつなぐと「ALPHABRAVO」のような語になり、ほかの所に残った「BRAVO」を見逃す
    let chain = "";
    let chainPath: number[] = [];
    let chainEnd: [number, number] | null = null;
    const flushChain = () => {
      if (chain.trim()) removed.push(chain);
      chain = "";
      chainEnd = null;
    };
    const adjacent = (s: ShowOp) => {
      if (!chainEnd) return false;
      const size = Math.max(1, Math.hypot(s.trm[0], s.trm[1]) || s.size);
      return Math.hypot(s.start[0] - chainEnd[0], s.start[1] - chainEnd[1]) <= size * 1.2;
    };
    for (const s of walked.shows) {
      const ed = editsAt(root, s.path);
      if (ed.splices.has(s.index)) {
        flushChain();
        continue;
      }
      const st = streamOf(s.path);
      if (!st) continue;
      const one: string[] = [];
      const rep = redactShow(s, st.ops[s.index], rects, one);
      const t = one.join("");
      if (rep === null || rep === "unknown") flushChain();
      else if (chain && samePath(chainPath, s.path) && adjacent(s) && !/\s$/.test(chain) && !/^\s/.test(t)) {
        chain += t;
        chainEnd = s.end;
      } else {
        flushChain();
        chain = t;
        chainPath = s.path;
        chainEnd = s.end;
      }
      if (rep === "unknown") unknown++;
      else if (rep !== null) {
        ed.splices.set(s.index, rep);
        // 消した字を囲む「読み・説明」（/ActualText・/Alt・/E）も消す：囲みの指定を外して、札（タグ）だけの囲みにする。
        // 名前で指した指定（/Resources/Properties の項目）は、その項目からも読み・説明を取り除く
        for (const sp of s.spans ?? []) {
          const bdc = st.ops[sp.index];
          const tag = bdc?.op === "BDC" ? name(bdc.operands[0]) : null;
          if (!tag) continue;
          if (!ed.splices.has(sp.index)) ed.splices.set(sp.index, `/${tag} BMC\n`);
          if (sp.name) scrubProperty(s.path.length ? walked.forms.find((f) => samePath(f.path, s.path))?.resources : page.node.Resources(), sp.name);
        }
      }
    }
    flushChain();
    for (const text of removed) o.onRemovedText?.(text);
    let clippedOnly = 0;
    const streams = [{ path: [] as number[], ops, bytes, ctm: [1, 0, 0, 1, 0, 0] as Matrix }, ...walked.forms];
    for (const st of streams) {
      const paths = redactPathOps(st.ops, st.bytes, rects, st.ctm);
      const ed = editsAt(root, st.path);
      for (const [i, text] of paths.splices) if (!ed.splices.has(i)) ed.splices.set(i, text);
      clippedOnly += paths.clippedOnly;
    }
    // 模様（タイリングパターン）や透明度のマスク（ソフトマスク）の中の文字・画像は、内容として追っていないので消せない
    // （範囲を除いた切り抜きで見えなくなるだけ）。あれば知らせて、「確認できた」とは言わない
    if (hasHiddenContent(doc, page.node.Resources(), walked.forms)) {
      o.onWarning?.(tr("redact.patternWarning", { page: o.pageNo }));
      o.onUncertain?.();
    }
    if (walked.usesForms) o.onUncertain?.();
    if (walked.usesForms) o.onWarning?.(tr("redact.formsWarning", { page: o.pageNo }));
    if (unknown) o.onWarning?.(tr("redact.unknownWidths", { page: o.pageNo }));
    if (clippedOnly) o.onWarning?.(tr("redact.clipPaths", { page: o.pageNo, count: clippedOnly }));
  }
  if (!hasEdits(root)) return;
  page.node.normalize();
  const resources = page.node.Resources()!;
  if (newXObjects.length) {
    // リソース辞書はほかのページと共有されていることがある。名前を足すだけなので、そのまま足して差し支えない
    let xo = resources.lookup(PDFName.of("XObject"));
    if (!(xo instanceof PDFDict)) {
      xo = doc.context.obj({});
      resources.set(PDFName.of("XObject"), xo);
    }
    for (const [nm, ref] of newXObjects) (xo as PDFDict).set(PDFName.of(nm), ref);
  }
  const sensitive: PDFRef[] = [];
  const next = applyStreamEdits(doc, bytes, ops, resources, resources, root, new Set(), sensitive);
  for (const r of sensitive) o.onSensitiveRef?.(r);
  // normalize() 後は Contents が配列である前提なので、配列で置く
  page.node.set(PDFName.of("Contents"), doc.context.obj([doc.context.register(doc.context.flateStream(next))]));
}

/**
 * Form XObject の中の文字を元フォントで書き直すとき、そのフォントをページのリソースに登録して名前を返す
 * （ページの内容からはフォームの中のフォント名が見えないため）。見つからなければ null
 */
export function pageFontForShow(doc: PDFDocument, page: PDFPage, forms: FormInvocation[], path: number[], fontResName: string): string | null {
  let res: PDFDict | undefined = page.node.Resources();
  for (let k = 1; k <= path.length; k++) {
    const f = forms.find((x) => samePath(x.path, path.slice(0, k)));
    const stream = f ? lookupXObject(res, f.name) : null;
    if (!stream) return null;
    const own = stream.dict.lookup(PDFName.of("Resources"));
    if (own instanceof PDFDict) res = own;
  }
  const fonts = res?.lookup(PDFName.of("Font"));
  const font = fonts instanceof PDFDict ? fonts.get(PDFName.of(fontResName)) : undefined;
  if (!font) return null;
  const ref = font instanceof PDFRef ? font : doc.context.register(font);
  return page.node.newFontDictionary("WashiFont", ref).decodeText();
}

/** 既存の内容全体に「範囲を除いたクリップ」を掛ける（isolateExistingContent の後、オブジェクトを描く前に呼ぶ） */
export function clipRedactedAreas(doc: PDFDocument, page: PDFPage, item: PageItem, redacts: RedactObj[]): void {
  let s = "q\n";
  for (const r of redacts) {
    const b = displayRectToPage(item, r);
    // 偶奇規則：大きな矩形から範囲の矩形を抜いた形。範囲が重なっても困らないよう 1 つずつ掛ける
    s += `-100000 -100000 200000 200000 re ${fmt(b.x0)} ${fmt(b.y0)} ${fmt(b.x1 - b.x0)} ${fmt(b.y1 - b.y0)} re W* n\n`;
  }
  const ctx = doc.context;
  page.node.normalize();
  page.node.wrapContentStreams(ctx.register(ctx.flateStream(s)), ctx.register(ctx.flateStream("Q\n")));
}

/** 範囲に掛かる元の注釈（と、そのポップアップ）を外す */
export function removeAnnotsIn(doc: PDFDocument, page: PDFPage, rects: Rect[]): void {
  const annots = page.node.Annots();
  if (!(annots instanceof PDFArray)) return;
  const num = (v: unknown) => {
    const o = v instanceof PDFRef ? doc.context.lookup(v) : v;
    return o instanceof PDFNumber ? o.asNumber() : NaN;
  };
  // 範囲の下の注釈：参照で置いたものも、配列に直接書いたものも同じに扱う
  const entries = annots.asArray().map((r) => ({ r, d: doc.context.lookup(r) }));
  const removed = new Set<PDFDict>();
  for (const { d } of entries) {
    if (!(d instanceof PDFDict)) continue;
    const rect = d.lookup(PDFName.of("Rect"));
    if (!(rect instanceof PDFArray) || rect.size() !== 4) continue;
    const n = rect.asArray().map(num);
    // 位置の分からない注釈は、どこにあるか分からないので外す（残すと、範囲の下の文字が残っているかもしれない）
    if (n.some((v) => !Number.isFinite(v))) {
      removed.add(d);
      continue;
    }
    const rr: Rect = { x0: Math.min(n[0], n[2]), y0: Math.min(n[1], n[3]), x1: Math.max(n[0], n[2]), y1: Math.max(n[1], n[3]) };
    // 縁が少し触れているだけ（1pt 未満の重なり）の注釈は残す。範囲の外の、関係のない注釈まで消さないため
    const touches = (x: Rect) => Math.min(x.x1, rr.x1) - Math.max(x.x0, rr.x0) >= 1 && Math.min(x.y1, rr.y1) - Math.max(x.y0, rr.y0) >= 1;
    // 大きさのない注釈（点・線）は、範囲の中にあれば外す
    const tiny = rr.x1 - rr.x0 < 1 || rr.y1 - rr.y0 < 1;
    if (rects.some((x) => (tiny ? overlap(x, { x0: rr.x0 - 0.5, y0: rr.y0 - 0.5, x1: rr.x1 + 0.5, y1: rr.y1 + 0.5 }) > 0 : touches(x)))) removed.add(d);
  }
  if (!removed.size) return;
  const kept = entries
    .filter(({ d }) => {
      if (d instanceof PDFDict && removed.has(d)) return false;
      // 外した注釈に付いた吹き出し（/Popup。親を /Parent で指す）も外す
      const parent = d instanceof PDFDict ? d.lookup(PDFName.of("Parent")) : undefined;
      return !(parent instanceof PDFDict && removed.has(parent));
    })
    .map((e) => e.r);
  page.node.set(PDFName.of("Annots"), doc.context.obj(kept));
}

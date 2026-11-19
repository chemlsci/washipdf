/**
 * 1 行の書き換えを「変えた部分だけ」組み直す。
 *
 * 行を丸ごと組み直すと、元の PDF が字の間隔を細かく指定している場合（両端ぞろえ、空白を字形でなく位置で表している、
 * 1 行に複数のフォントが混ざる、上付きの注記が挟まる など）に、変えていない部分まで見た目が変わってしまう。
 * ここでは、元の文字列と新しい文字列で共通する先頭と末尾は、元の字形をそのままの位置・フォントで書き戻し、
 * 変わった部分だけを元フォントで書いて、その後ろを幅の差だけずらす。
 *
 * 使える条件に合わないとき（回転した行、字形と文字列の対応が取れない、箱を動かした、はみ出す など）は null を返し、
 * 呼び出し側が従来どおり行全体を組み直す。
 */
import type { ContentOp, Operand } from "./contentStream";
import { visualToLogical } from "./indic";
import { isBoldFont } from "./pdfFontInfo";
import { fmt, hex } from "./contentStream";
import { apply, invert, multiply } from "./geometry";
import type { PageAnalysis } from "./libDoc";
import { measureBundled } from "./fonts";
import { hasRtl, rtlLine, visualOrder, wordDiff, wordDirs } from "./rtl";
import { wordPieces } from "./rtlWrite";
import { bidiRuns, isShapingFont, mirrored } from "./shape";
import { applyActualText, pathKey, samePath, type ShowOp, usableActualText } from "./textOps";
import type { TextWriter } from "./textEdit";
import type { FontKey, Matrix, PageItem, TextEditObj } from "./types";

interface G {
  /** フォントの文字対応（ToUnicode）で読んだ文字。「代わりの文字」で text を置き換えても、こちらは元のまま */
  raw?: string;
  show: ShowOp;
  /** 命令の中での順番 */
  order: number;
  text: string;
  /** そろえた文字列（空白を除き、互換文字をそろえたもの） */
  sq: string;
  /** テキスト空間での開始位置と進み量（pt） */
  pos: number;
  tx: number;
  /** 表示座標での左端・右端・ベースライン */
  x0: number;
  x1: number;
  base: number;
  keep: boolean;
  shift: number;
  /** 同じ字を同じ位置に重ねて描いたもの（輪郭と塗りなど）の、もう一方 */
  twin?: G;
  /** 何の字か分からない字形（合字などで、フォントの対応表に無い）。前後の字から、行の文字列のどこに当たるかを決める */
  unknown?: boolean;
}

// 空白と制御文字（目次の点線の前に入るタブなど）は対応付けに使わない
/** 前後の字で形が変わる・字形が並び替わる文字（インド系、タイ、ラオス、クメール、ミャンマー、チベット、アラビア系、ヘブライ） */
const SHAPED = /[\u0590-\u08ff\u0900-\u0dff\u0e80-\u0fff\u1000-\u109f\u1780-\u17ff\ufb1d-\ufdff\ufe70-\ufeff]/;

/**
 * 語をまとめて書き直す必要のある字：整形の要る文字（タイ文字を含む）と、何の字か分からない字形から来た字
 * （U+FFFD・私用領域・発音記号や結合記号の領域に化けたもの。インド系の合字に文字の対応が無い文書で、語の途中に出る）
 */
export const WORDISH = /[\u0250-\u036f\u0590-\u109f\u1780-\u17ff\ue000-\uf8ff\ufb1d-\ufdff\ufe70-\ufeff\ufffd]/;

export { visualToLogical };

/** 語をまとめて書き直す字：上の字と、欧文（ラテン・ギリシャ・キリル文字） */
export const WORDCHAR = new RegExp(`${WORDISH.source.slice(0, -1)}A-Za-z\\u00c0-\\u024f\\u0370-\\u052f\\u1e00-\\u1fff]`);

/** 変えた 1 か所：元の文字列の [p, e) を、新しい文字列の [bp, be) に置き換える */
interface Hunk {
  p: number;
  e: number;
  bp: number;
  be: number;
}

/**
 * 語の単位で比べて、変えた所を求める（2 か所以上あるときだけ返す。1 か所なら null）。
 * 語：欧文や整形の要る文字の続き、数字の続き、空白の続き。そのほかの字（和文・記号）は 1 字ずつ。
 * 空白だけを挟んで隣り合う変更は、1 か所にまとめる。
 */
export function wordHunks(a: string, b: string): Hunk[] | null {
  const split = (s: string) => {
    const out: { t: string; at: number }[] = [];
    const re = new RegExp(`${WORDCHAR.source}+|\\d+|\\s+|[\\s\\S]`, "gu");
    for (const m of s.matchAll(re)) out.push({ t: m[0], at: m.index });
    return out;
  };
  const x = split(a);
  const y = split(b);
  if (!x.length || !y.length || x.length * y.length > 250000) return null;
  // 最長共通部分列
  const L = Array.from({ length: x.length + 1 }, () => new Uint16Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) L[i][j] = x[i].t === y[j].t ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const hunks: Hunk[] = [];
  const posA = (i: number) => (i < x.length ? x[i].at : a.length);
  const posB = (j: number) => (j < y.length ? y[j].at : b.length);
  let i = 0;
  let j = 0;
  let open: Hunk | null = null;
  /** 直前の変更の後ろに続いている、空白だけの一致の数（次の変更とまとめるかどうかの判断用） */
  let blanks = false;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i].t === y[j].t) {
      if (open && /^\s+$/.test(x[i].t) && !blanks) blanks = true;
      else if (open) {
        // 空白以外の一致が来たら、ここまでの変更を閉じる（直前の空白は変更に含めない）
        hunks.push(open);
        open = null;
        blanks = false;
      }
      i++;
      j++;
      continue;
    }
    if (!open) open = { p: posA(i), e: posA(i), bp: posB(j), be: posB(j) };
    blanks = false;
    if (j < y.length && (i >= x.length || L[i][j + 1] >= L[i + 1][j])) j++;
    else i++;
    open.e = posA(i);
    open.be = posB(j);
  }
  if (open) hunks.push(open);
  return hunks.length > 1 ? hunks : null;
}

const squash = (s: string) => s.normalize("NFKC").replace(/[\s\u0000-\u001f\u007f]+/g, "");

function showItems(op: ContentOp): Operand[] {
  const a = op.operands;
  if (op.op === '"') return a[2] ? [a[2]] : [];
  if (op.op === "TJ") return a[0]?.kind === "array" ? a[0].items : [];
  return a[0] ? [a[0]] : [];
}

const mat = (v: number) => (Math.abs(v) < 1e-9 ? "0" : v.toFixed(8).replace(/\.?0+$/, ""));

const median = (v: number[]) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/* ---------- タイ文字：前後の字で変わる字形と位置を、文書の中の実例から選ぶ ---------- */

const THAI = /[\u0e00-\u0e7f]/;
const isThaiCons = (c: number) => c >= 0x0e01 && c <= 0x0e2e;
const isThaiUpper = (c: number) => c === 0x0e31 || (c >= 0x0e34 && c <= 0x0e37) || c === 0x0e47 || c === 0x0e4d;
const isThaiTone = (c: number) => c >= 0x0e48 && c <= 0x0e4c;
const isThaiBelow = (c: number) => c >= 0x0e38 && c <= 0x0e3a;
/** 上に伸びる子音（ป ฝ ฟ ฬ）：上に付く記号を左へ寄せた字形が使われる */
const THAI_ASC = new Set([0x0e1b, 0x0e1d, 0x0e1f, 0x0e2c]);
/** 下に伸びる子音（ฎ ฏ）：下に付く記号を下げた字形が使われる */
const THAI_DESC = new Set([0x0e0e, 0x0e0f]);
/** 下の部分を持つ子音（ญ ฐ）：下に記号が付くときは、下の部分の無い字形が使われる */
const THAI_LOW = new Set([0x0e0d, 0x0e10]);

/**
 * その字の「前後の並びの種類」。同じ種類なら同じ字形・同じ位置になる。前後で変わらない字は null。
 *  - 声調記号：台の子音が上に伸びるか／直前に上の母音記号があるか／直後がサラ・アムか
 *  - 上の母音記号：台の子音が上に伸びるか
 *  - 下の母音記号：台の子音が下に伸びるか、下の部分を持つか
 *  - ญ ฐ：直後に下の母音記号が付くか
 *  - サラ・アム：台の子音が上に伸びるか／直前に声調記号があるか
 */
function thaiContext(all: string[], i: number): string | null {
  const c = all[i]?.codePointAt(0) ?? 0;
  const prev = i > 0 ? (all[i - 1].codePointAt(0) ?? 0) : 0;
  const next = i + 1 < all.length ? (all[i + 1].codePointAt(0) ?? 0) : 0;
  let base = 0;
  for (let k = i - 1; k >= 0 && k >= i - 3 && !base; k--) {
    const x = all[k].codePointAt(0) ?? 0;
    if (isThaiCons(x)) base = x;
  }
  if (isThaiTone(c)) return `${THAI_ASC.has(base) ? "A" : "-"}${isThaiUpper(prev) ? "U" : "-"}${next === 0x0e33 ? "M" : "-"}`;
  if (isThaiUpper(c)) return THAI_ASC.has(base) ? "A" : "-";
  if (isThaiBelow(c)) return THAI_DESC.has(base) ? "D" : THAI_LOW.has(base) ? "L" : "-";
  if (THAI_LOW.has(c)) return isThaiBelow(next) ? "B" : "-";
  if (c === 0x0e33) return `${THAI_ASC.has(base) ? "A" : "-"}${isThaiTone(prev) ? "T" : "-"}`;
  return null;
}

interface ThaiGlyph {
  bytes: Uint8Array;
  /** 字形の進み量（文字サイズに対する割合） */
  adv: number;
  /** 直前の字の終わりから、この字形を置く位置までのずれ */
  dx: number;
  /** 直前の字の終わりから、次の字が始まる位置まで */
  ret: number;
  n: number;
}

/** 文書（このページ）の中で、同じフォントのタイ文字が「どの並びのとき、どの字形で、どこに」置かれているかを集める */
function learnThai(a: PageAnalysis, ref: ShowOp, opsOf: (s: ShowOp) => ContentOp[] | undefined): Map<string, ThaiGlyph> {
  const seen = new Map<string, Map<string, { g: ThaiGlyph; dxs: number[]; rets: number[] }>>();
  for (const s of a.shows) {
    if (s.fontResName !== ref.fontResName || !samePath(s.path, ref.path) || !s.font || !s.size) continue;
    const op = opsOf(s)?.[s.index];
    if (!op) continue;
    const list: { u: string; bytes: Uint8Array; pos: number; adv: number }[] = [];
    let pos = 0;
    for (const it of showItems(op)) {
      if (it.kind === "num") {
        pos -= it.value / 1000;
        continue;
      }
      if (it.kind !== "string") continue;
      let off = 0;
      for (const c of s.font.decode(it.bytes)) {
        const n = Math.max(1, c.nbytes);
        const adv = s.font.width(c) / 1000;
        list.push({ u: s.font.toUnicode(c) ?? "", bytes: it.bytes.slice(off, off + n), pos, adv });
        off += n;
        pos += adv + (s.charSpacing + (c.isSpace ? s.wordSpacing : 0)) / s.size;
      }
    }
    const us = list.map((g) => ([...g.u].length === 1 ? g.u : "\u0000"));
    list.forEach((g, i) => {
      if ([...g.u].length !== 1) return;
      const ctx = thaiContext(us, i);
      if (ctx === null) return;
      const prev = list[i - 1];
      const next = list[i + 1];
      const end = prev ? prev.pos + prev.adv : g.pos;
      const dx = g.pos - end;
      const ret = next ? next.pos - end : dx + g.adv;
      const key = `${g.u}|${ctx}`;
      const code = hex(g.bytes);
      const byCode = seen.get(key) ?? new Map();
      const e = byCode.get(code) ?? { g: { bytes: g.bytes, adv: g.adv, dx: 0, ret: 0, n: 0 }, dxs: [], rets: [] };
      e.g.n++;
      e.dxs.push(dx);
      // 行や命令の最後の字は「次の字」が無いので、戻りの量には数えない
      if (next) e.rets.push(ret);
      byCode.set(code, e);
      seen.set(key, byCode);
    });
  }
  const out = new Map<string, ThaiGlyph>();
  for (const [key, byCode] of seen) {
    const best = [...byCode.values()].sort((p, q) => q.g.n - p.g.n)[0];
    best.g.dx = median(best.dxs) ?? 0;
    best.g.ret = median(best.rets) ?? best.g.dx + best.g.adv;
    out.set(key, best.g);
  }
  return out;
}

/** 新しい文字列の i 文字目に使う字形。その並びの実例が文書に無ければ null（フォントの既定の字形で書く） */
function pickThai(learned: Map<string, ThaiGlyph>, all: string[], i: number): ThaiGlyph | null {
  const ctx = thaiContext(all, i);
  if (ctx === null) return null;
  return learned.get(`${all[i]}|${ctx}`) ?? null;
}

/** why には、使えなかった理由（検査用の短い名前）が渡される */
export function buildAnchoredContent(
  item: PageItem,
  o: TextEditObj,
  a: PageAnalysis,
  ref: ShowOp,
  w: TextWriter,
  why?: (reason: string) => void,
  /** 部品（Form XObject）の中の命令が使うフォントを、ページから使える名前にして返す。使えなければ null */
  formFont?: (s: ShowOp) => string | null,
  /**
   * 変えた部分を元のフォントで書けないときに使う、同梱フォントの書き手。渡すと、変えた語だけをこのフォントで書き、
   * 前後の字は元の字形のまま残す（行全体を同梱フォントに切り替えない）。使ったときは why に "mixed" を渡す
   */
  alt?: TextWriter | null,
  /** 右から左へ書く文字の行で、変えた語を書く同梱フォントの書き手（フォントごと）。無いフォントは null */
  altFor?: (key: FontKey) => TextWriter | null,
): string | null {
  const no = (reason: string): null => {
    why?.(reason);
    return null;
  };
  if (o.vertical || o.lines !== 1 || o.align !== "left" || o.text.includes("\n") || o.original.includes("\n")) return no("multi");
  if (!o.removals.length) return no("ops");
  // 命令列（ページ直下か、部品の中か）
  const opsOf = (s: ShowOp) => (s.path.length ? a.forms.find((f) => samePath(f.path, s.path))?.ops : a.ops);
  const fontNames = new Map<ShowOp, string>();
  const vt = item.viewTransform as Matrix;

  // 行を描いている命令の字形を集める
  const wanted = new Set(o.removals.map((r) => pathKey(r.path ?? [], r.index)));
  const shows = a.shows.filter((s) => wanted.has(pathKey(s.path, s.index)));
  if (shows.length !== wanted.size) return no("ops");
  const glyphs: G[] = [];
  for (const s of shows) {
    const font = s.font;
    if (!font || !font.widthsKnown || !s.size || !s.hscale || font.vertical) return no("font");
    const m = multiply(vt, s.trm);
    // 表示上、左から右へ水平に進む行だけを扱う
    if (!(m[0] > 0) || Math.abs(m[1]) > Math.abs(m[0]) * 0.01) return no("rotated");
    const op = opsOf(s)?.[s.index];
    if (!op) return no("ops");
    if (s.path.length) {
      // 部品の中の文字：フォントをページから使えるようにする。色が部品の中の名前付き色空間なら、近い RGB で代える
      const name = formFont?.(s);
      if (!name) return no("form");
      fontNames.set(s, name);
      if (s.fillColorOps.includes("/") && !s.fillRgb) return no("form");
    } else fontNames.set(s, s.fontResName);
    let pos = 0;
    let order = 0;
    for (const it of showItems(op)) {
      if (it.kind === "num") {
        pos -= (it.value / 1000) * s.size * s.hscale;
        continue;
      }
      if (it.kind !== "string") continue;
      for (const c of font.decode(it.bytes)) {
        const tx = ((font.width(c) / 1000) * s.size + s.charSpacing + (c.isSpace ? s.wordSpacing : 0)) * s.hscale;
        const p0 = apply(m, pos, 0);
        const p1 = apply(m, pos + tx, 0);
        const uni = font.toUnicode(c);
        const unknown = !c.isSpace && tx > 0 && (uni == null || uni === "" || uni.includes("\uFFFD"));
        const text = unknown ? "" : (uni ?? "");
        glyphs.push({ show: s, order: order++, text, raw: text, sq: squash(text), pos, tx, x0: p0[0], x1: p1[0], base: p0[1], keep: false, shift: 0, unknown });
        pos += tx;
      }
    }
  }
  // 1 つの字を複数の字形（本体と点など）で描き、本当の文字を「代わりの文字」で与えている文書：行の文字列を作ったときと同じ読み方にする
  // （右から左の行だけ：ほかの行の文字列は表示側から得ていて、この指定を読んでいない）
  if (o.rtl)
    applyActualText(
      glyphs,
      (g) => g.x1 - g.x0,
      (g) => (g.unknown ? null : g.text),
      (g, text) => {
        g.text = text;
        g.sq = squash(text);
        g.unknown = false;
      },
    );
  /** 変えた所に書くもの：書き始めの位置（表示座標）、書く内容、使うフォント、色などを引き継ぐ元の命令 */
  interface Mid {
    midX: number;
    shaped: string | null;
    items: string[];
    mw: TextWriter;
    scale: number;
    show: ShowOp;
  }
  // 書き出す：残す字形（g.keep。g.shift だけ横にずらす）と、変えた所に書くもの（mids）を、左から順に並べる
  // （文字の取り出しや検索は、書かれた順に読むため）
  // whole：縮めるとき、基準の位置（pivot）より左にあるものも含めて、行全体を縮める（右端を基準に縮める行で使う）
  const emit = (mids: Mid[], squeeze: number, pivot: number, moveX: number, moveY: number, baseY: number, size: number, whole = false): string => {
    const M = invert(vt);
    // 横に縮める変換（表示座標で、基準の位置を動かさずに）をページ座標の変換に直したもの
    const T: Matrix | null = squeeze < 1 ? multiply(M, multiply([squeeze, 0, 0, 1, (pivot + moveX) * (1 - squeeze), 0], vt)) : null;
    const tmOf = (m: Matrix, viewX: number) => {
      const r = T && (whole || viewX >= pivot - 0.01) ? multiply(T, m) : m;
      // 行列の成分は桁を多めに書く：大きな文字サイズ × 小さな倍率（例 327.68 × 0.0527）の PDF では、丸めると字の大きさが変わる
      return `${mat(r[0])} ${mat(r[1])} ${mat(r[2])} ${mat(r[3])} ${fmt(r[4])} ${fmt(r[5])} Tm`;
    };
    // 色を変えたか：行の中に、編集対象が覚えている色（行の代表の色）と同じ色の命令があれば、変えていない。
    // 変えていなければ、字ごとに元の色のまま書く（1 行の中で一部だけ色が違うことがある）
    const userColor = o.fillColorOps === null || !shows.some((s) => s.fillColorOps === o.fillColorOps);
    const toStroke = (fill: string) => fill.replace(/\brg$/, "RG").replace(/\bg$/, "G").replace(/\bk$/, "K").replace(/\bcs\b/, "CS").replace(/\bscn?$/, (m) => m.toUpperCase());
    const pieces: { x: number; ops: string[]; actual?: { id: number; text: string } }[] = [];
    const state = (s: ShowOp, resName: string, charSpacing: number, wordSpacing: number) => {
      const named = s.path.length > 0 && s.fillColorOps.includes("/");
      const own = named && s.fillRgb ? `${s.fillRgb.map((v) => fmt(v / 255)).join(" ")} rg` : s.fillColorOps;
      const st: string[] = [userColor ? (o.fillColorOps ?? fallbackColor(o.color)) : own];
      if (s.renderMode === 1 || s.renderMode === 2) {
        // 輪郭の色は、その字を描いた命令のもの（行の代表の色ではない：太字に見せる輪郭は、その字だけに付いている）。
        // 色を変えたとき、または部品の中の名前付き色空間（ページから使えない）のときは、塗りと同じ色にする
        const asStroke = st[0].replace(/\brg$/, "RG").replace(/\bg$/, "G").replace(/\bk$/, "K").replace(/\bcs\b/, "CS").replace(/\bscn?$/, (m) => m.toUpperCase());
        st.push(userColor || (s.path.length && s.strokeColorOps.includes("/")) ? asStroke : s.strokeColorOps);
        if (s.lineWidth !== undefined) st.push(`${fmt(s.lineWidth)} w`);
      }
      st.push(`/${resName} ${fmt(s.size)} Tf ${fmt(charSpacing)} Tc ${fmt(wordSpacing)} Tw ${fmt(s.hscale * 100)} Tz ${fmt(s.rise)} Ts ${s.renderMode} Tr`);
      return st;
    };
    const tm = (s: ShowOp, pos: number, shiftView: number, viewX: number) => {
      const [ox, oy] = apply(s.trm, pos, 0);
      // 表示座標でのずれを、ページ座標のずれに直す
      const dx = M[0] * (shiftView + moveX) + M[2] * moveY;
      const dy = M[1] * (shiftView + moveX) + M[3] * moveY;
      return tmOf([s.trm[0], s.trm[1], s.trm[2], s.trm[3], ox + dx, oy + dy], viewX);
    };
    const byShow = new Map<ShowOp, G[]>();
    for (const g of glyphs) byShow.set(g.show, [...(byShow.get(g.show) ?? []), g]);
    for (const s of shows) {
      const gs = byShow.get(s) ?? [];
      if (!gs.some((g) => g.keep)) continue;
      const op = opsOf(s)![s.index];
      let gi = 0;
      let items: string[] = [];
      let bytes: number[] = [];
      let cur: { x: number; ops: string[]; actual?: { id: number; text: string } } | null = null;
      let curShift = 0;
      const flushStr = () => {
        if (bytes.length) items.push(hex(Uint8Array.from(bytes)));
        bytes = [];
      };
      const close = () => {
        flushStr();
        if (cur && items.length) {
          cur.ops.push(`[${items.join(" ")}] TJ`);
          pieces.push(cur);
        }
        items = [];
        cur = null;
      };
      for (const it of showItems(op)) {
        if (it.kind === "num") {
          if (cur) {
            flushStr();
            items.push(fmt(it.value));
          }
          continue;
        }
        if (it.kind !== "string") continue;
        let off = 0;
        for (const c of s.font!.decode(it.bytes)) {
          const g = gs[gi++];
          const n = Math.max(1, c.nbytes);
          const b = it.bytes.subarray(off, off + n);
          off += n;
          if (!g?.keep) {
            close();
            continue;
          }
          if (cur && Math.abs(g.shift - curShift) > 1e-6) close();
          if (!cur) {
            cur = { x: g.x0 + g.shift, ops: [...state(s, fontNames.get(s)!, s.charSpacing, s.wordSpacing), tm(s, g.pos, g.shift, g.x0 + g.shift)], actual: o.rtl && usableActualText(s) ? s.actual : undefined };
            curShift = g.shift;
          }
          for (const x of b) bytes.push(x);
        }
      }
      close();
    }
    // 「代わりの文字」の囲みの中にあった字形（本体と点に分けて描いた字など）は、囲みごとまとめて、同じ指定を付け直す
    // （付け直さないと、残した字が、ほかのソフトでも、このアプリで開き直したときも、正しく読めなくなる）
    const spans = new Map<number, (typeof pieces)[number]>();
    for (let i = 0; i < pieces.length; i++) {
      const pc = pieces[i];
      if (!pc.actual) continue;
      const first = spans.get(pc.actual.id);
      if (first) {
        first.ops.push(...pc.ops);
        first.x = Math.min(first.x, pc.x);
        pieces.splice(i--, 1);
      } else spans.set(pc.actual.id, pc);
    }
    for (const pc of spans.values()) {
      let hexText = "feff";
      for (let i = 0; i < pc.actual!.text.length; i++) hexText += pc.actual!.text.charCodeAt(i).toString(16).padStart(4, "0");
      pc.ops = [`/Span << /ActualText <${hexText}> >> BDC`, ...pc.ops, "EMC"];
    }
    for (const pl of mids) {
      if (!pl.shaped && !pl.items.some((x) => x.startsWith("<") || x.startsWith("("))) continue;
      // 書き足す字の色は、置き換える字（無ければ直前、それも無ければ直後の字）に合わせる
      const midShow = pl.show;
      const midState: ShowOp = { ...ref, fillColorOps: midShow.fillColorOps, fillRgb: midShow.fillRgb, strokeColorOps: midShow.strokeColorOps, path: midShow.path };
      // 同梱フォントは標準の太さしか無い。元が太字のフォントなら、輪郭を同じ色でなぞって太く見せる。
      // 太字かどうかは、置き換える字（無ければ行の代表）を描いていたフォントで決める
      const boldFont = midShow.font ?? ref.font;
      const bold = !!boldFont && isBoldFont(boldFont) && midState.renderMode === 0 && !!midState.fillColorOps;
      const altBase: ShowOp = { ...midState, rise: 0, size: midState.size * pl.scale };
      const altState: ShowOp = bold ? { ...altBase, renderMode: 2, strokeColorOps: toStroke(midState.fillColorOps), lineWidth: size * 0.03 } : altBase;
      const [ux, uy] = apply(M, pl.midX + moveX, baseY + moveY);
      pieces.push({
        // 同じ位置から始まる末尾側（ずらした字）より前に置く
        x: pl.midX - 1e-3,
        ops: [...state(pl.mw === w ? midState : altState, pl.mw.resName, 0, 0), tmOf([ref.trm[0], ref.trm[1], ref.trm[2], ref.trm[3], ux, uy], pl.midX), pl.shaped ?? `[${pl.items.join(" ")}] TJ`],
      });
    }
    if (mids.some((pl) => pl.mw !== w)) why?.("mixed");
    // ほぼ同じ位置から始まるもの（影付き文字の影と本体など）は、元の描画順のままにする（重なりの上下を入れ替えない）
    const sameX = Math.max(0.6, o.fontSize * 0.03);
    pieces.sort((p1, p2) => (Math.abs(p1.x - p2.x) < sameX && Math.abs(p1.x - p2.x) > 1e-2 ? 0 : p1.x - p2.x));
    return ["BT", ...pieces.flatMap((p) => p.ops), "ET"].join("\n");
  };

  // 同じ字を同じ位置に重ねて描いたもの（輪郭と塗りを別の命令で描く など）は、1 つ目に従わせる
  const line: G[] = [];
  // ページの外にはみ出している字（見開きを 2 ページに分けた文書など）は、行の文字列に入っていない。対応付けから外し、元のまま残す
  const off = (g: G) => g.x1 < -0.5 || g.x0 > item.width + 0.5;
  for (const g of glyphs) if (off(g)) g.keep = true;
  for (const g of glyphs.filter((x) => (x.sq || x.unknown) && !off(x)).sort((p, q) => p.x0 - q.x0 || p.order - q.order)) {
    // 幅の狭い字・幅 0 の記号でも、影付き文字のずれ（文字の大きさの数 %）を同じ位置とみなす（textRuns.overprintText と同じ基準）
    // 字の幅は、表示上の幅で見る（g.tx は文字空間の値で、行列で拡大している文書では桁が違う）
    const tol = Math.max(0.6, Math.abs(g.x1 - g.x0) * 0.12, o.fontSize * 0.03);
    const first = line.slice(-6).find((p) => p.show !== g.show && !g.unknown && p.sq === g.sq && Math.abs(p.x0 - g.x0) < tol && Math.abs(p.base - g.base) < tol);
    if (first) g.twin = first;
    else line.push(g);
  }
  if (!line.length) return no("empty");

  // 文字の大きさを変えていれば、従来の組み直しに任せる。箱を動かしただけなら、その分だけ全体をずらす
  if (!o.source || Math.abs(o.fontSize - o.source.fontSize) > 1e-6) return no("resized");
  const moveX = o.x - o.source.x;
  const moveY = o.baseline - o.source.baseline;
  const k = Math.hypot(multiply(vt, ref.trm)[0], multiply(vt, ref.trm)[1]);
  // 行の高さの基準にする字：行の文字のいちばん多い高さにある字（アラビア文字の点のように、本体と別の高さに描いた部品が
  // 行の先頭にあると、その高さを基準にして、新しく書く語が下がってしまう）
  const refGlyph = (() => {
    const first = line.find((g) => g.show === ref) ?? line[0];
    const real = line.filter((g) => g.text.replace(/[\p{Cc}\p{Cf}\uFFFD\s]/gu, ""));
    if (!real.length) return first;
    const tol = Math.max(0.5, o.fontSize * 0.05);
    let best = first;
    let bestN = -1;
    for (const g of real) {
      const n = real.filter((h) => Math.abs(h.base - g.base) < tol).length;
      if (n > bestN) [best, bestN] = [g, n];
    }
    return Math.abs(best.base - first.base) < tol ? first : best;
  })();

  // ---- 右から左へ書く文字（アラビア系・ヘブライ）の行：語の単位で書き換える ----
  // 字形から語と読む順の文字列を組み立て（行の文字列を作ったときと同じ方法）、変えた語だけを同梱フォントで書く。
  // 変えていない語は元の字形のまま残し、行の進む側（右から左の行なら左側）にある語を、幅の差だけずらす
  if (o.rtl) {
    if (line.some((g) => g.unknown)) return no("glyph");
    const rl = rtlLine<G>([...line, ...glyphs.filter((g) => !g.sq && !g.unknown && !off(g))], o.fontSize, o.original.trim().split(/\s+/).length, { base: o.rtl });
    if (!rl || rl.text !== o.original.trim()) return no("mismatch");
    const R = rl.base === "R";
    const words = rl.words;
    const Aw = words.map((x) => x.text);
    const Bw = o.text.trim().split(/\s+/).filter(Boolean);
    /** 行の向きと逆向きの語か（右から左の行の中の数字・欧文など） */
    const against = (rtl: boolean) => (R ? !rtl : rtl);
    const oldVis = visualOrder(words.map((x) => against(x.rtl)), rl.base, Aw);
    const byX = words.map((_, i) => i).sort((p, q) => words[p].x0 - words[q].x0);
    if (oldVis.some((v, i) => v !== byX[i])) return no("mismatch");
    const newAgainst = wordDirs(Bw, rl.base).map(against);
    const wantVis = visualOrder(newAgainst, rl.base, Bw);
    type Item = { old: number } | { hunk: number };
    type WH = ReturnType<typeof wordDiff>[number];
    // 変えた所ごとに「元の語のまとまりを、新しい語のまとまりで置き換える」として並べたときの、表示上の語の並び。
    // 元の語のまとまりが表示上で離れている・足す位置を決められない ときは null
    const localOrder = (hs: WH[]): { items: Item[]; seq: number[] } | null => {
      const toNew = new Map<number, number>();
      let i = 0;
      let j = 0;
      for (const h of hs) {
        while (i < h.a0) toNew.set(i++, j++);
        i = h.a1;
        j = h.b1;
      }
      while (i < Aw.length) toNew.set(i++, j++);
      const hunkOf = new Map<number, number>();
      hs.forEach((h, n) => {
        for (let x = h.a0; x < h.a1; x++) hunkOf.set(x, n);
      });
      const items: Item[] = [];
      const placed = new Set<number>();
      for (const ow of oldVis) {
        const n = hunkOf.get(ow);
        if (n === undefined) items.push({ old: ow });
        else if (!placed.has(n)) {
          placed.add(n);
          items.push({ hunk: n });
        } else {
          const lastItem = items[items.length - 1];
          if (!("hunk" in lastItem) || lastItem.hunk !== n) return null;
        }
      }
      for (let n = 0; n < hs.length; n++) {
        const h = hs[n];
        if (h.a1 > h.a0) continue;
        // 語を足すだけの所：読む順で 1 つ前の語の、行の進む側の隣に置く（行の先頭に足すなら、行の始まる側の端）
        const prev = h.a0 - 1;
        if (prev < 0) items.splice(R ? items.length : 0, 0, { hunk: n });
        else {
          const at = items.findIndex((it) => "old" in it && it.old === prev);
          if (at < 0 || against(words[prev].rtl)) return null;
          items.splice(R ? at : at + 1, 0, { hunk: n });
        }
      }
      const seq = items.flatMap((it) => ("old" in it ? [toNew.get(it.old)!] : visualOrder(newAgainst.slice(hs[it.hunk].b0, hs[it.hunk].b1), rl.base, Bw.slice(hs[it.hunk].b0, hs[it.hunk].b1)).map((x) => x + hs[it.hunk].b0)));
      return { items, seq };
    };
    // 置き換えた結果の並びが、新しい行を組んだときの並びと合わない（数字の続きの途中を変えた など）ときは、
    // 変える範囲を前後の語まで広げてやり直す（最後は行全体を書き直すことになり、必ず合う）
    let hunks = wordDiff(Aw, Bw);
    let local: ReturnType<typeof localOrder> = null;
    const oldAgainst = words.map((x) => against(x.rtl));
    for (let guard = 0; guard <= Aw.length + 1; guard++) {
      // 行の向きと逆向きの語の続き（数字・欧文の続き）は、端に付く記号の位置が続き全体で決まるので、まとめて書き直す：
      // 変える範囲に逆向きの語があれば、その続きの端まで範囲を広げる
      for (const h of hunks) {
        if (!oldAgainst.slice(h.a0, h.a1).some(Boolean) && !newAgainst.slice(h.b0, h.b1).some(Boolean)) continue;
        while (h.a0 > 0 && oldAgainst[h.a0 - 1]) {
          h.a0--;
          h.b0--;
        }
        while (h.a1 < Aw.length && oldAgainst[h.a1]) {
          h.a1++;
          h.b1++;
        }
      }
      hunks = hunks.reduce<WH[]>((list, h) => {
        const prev = list[list.length - 1];
        if (prev && h.a0 <= prev.a1) {
          prev.a1 = Math.max(prev.a1, h.a1);
          prev.b1 = Math.max(prev.b1, h.b1);
        } else list.push(h);
        return list;
      }, []);
      local = localOrder(hunks);
      if (local && local.seq.length === wantVis.length && local.seq.every((v, i) => v === wantVis[i])) break;
      local = null;
      const merged: WH[] = [];
      for (const h of hunks) {
        const wide = { a0: Math.max(0, h.a0 - 1), a1: Math.min(Aw.length, h.a1 + 1), b0: h.a0 > 0 ? h.b0 - 1 : h.b0, b1: h.a1 < Aw.length ? h.b1 + 1 : h.b1 };
        const prev = merged[merged.length - 1];
        if (prev && wide.a0 <= prev.a1) {
          prev.a1 = Math.max(prev.a1, wide.a1);
          prev.b1 = Math.max(prev.b1, wide.b1);
        } else merged.push(wide);
      }
      hunks = merged;
    }
    if (!local) return no("order");

    const size = ref.size * k;
    const clampTo = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    const gaps = byX.slice(1).map((wi, n) => words[wi].x0 - words[byX[n]].x1);
    const spaceW = clampTo(median(gaps) ?? 0.3 * size, 0.1 * size, 1.5 * size);
    const lineLeft = Math.min(...words.map((x) => x.x0));
    const lineRight = Math.max(...words.map((x) => x.x1));

    // 新しい語を書く区間。数字・欧文・記号は、元のフォントで書けるならそれで書く。ほかは同梱フォント
    interface Piece {
      mw: TextWriter;
      /** 書く文字列（元のフォントと、整形しないフォントは、表示順に直したもの） */
      text: string;
      dir: "L" | "R";
      width: number;
      scale: number;
      /** まとまりの左端からの位置 */
      x: number;
      /** 整形しないフォントで、右から左の区間を見た目の順・左右逆の形のかっこで書いたもの（text は書く字そのもの） */
      mirror?: boolean;
    }
    const writers = new Map<FontKey, TextWriter | null>();
    // 同梱フォントのアラビア文字・ヘブライ文字は、元のフォントと字面の大きさが大きく違うことがある（同じ文字サイズでも、
    // 元のフォントの字が 6 割ほどの大きさ、など）。元の行の語を同梱フォントで組んだときの幅と、元の幅との比（中央値）で、
    // 文字の大きさをそろえる（フォントごと）
    const widthRatios = new Map<FontKey, number[]>();
    for (const wd of words) {
      if (!hasRtl(wd.text) || [...wd.text].length < 2) continue;
      const ps = wordPieces(o.family, wd.text, rl.base);
      if (!ps || ps.length !== 1 || !isShapingFont(ps[0].key)) continue;
      const own = measureBundled(ps[0].key, wd.text, size) * ref.hscale;
      if (own > 0 && wd.x1 > wd.x0) widthRatios.set(ps[0].key, [...(widthRatios.get(ps[0].key) ?? []), (wd.x1 - wd.x0) / own]);
    }
    const scriptScale = (key: FontKey): number => {
      const v = median(widthRatios.get(key) ?? []);
      if (v === null) return 1;
      const k2 = clampTo(Math.round(v * 50) / 50, 0.55, 1.3);
      return Math.abs(k2 - 1) < 0.06 ? 1 : k2;
    };
    // 元のフォントの、右から左の文字のそばのかっこの流儀。多くの作成ソフト（LibreOffice・Chrome など）は、表示する字形を
    // 左右逆の形にしたうえで、文字の対応（ToUnicode）は読む順の文字のままにする（見た目の左端に「)」の文字コード、形は「(」）。
    // そうでないソフトは、見た目どおりの文字を対応させる。行の中の、右から左の語の端にあるかっこを見て決める（無ければ前者）
    const BR_OPEN = "([{<\u00ab";
    const BR_CLOSE = ")]}>\u00bb";
    let logicalVotes = 0;
    let visualVotes = 0;
    for (const wd of words) {
      if (!wd.rtl) continue;
      // （文字の対応そのものを見る：「代わりの文字」で読む順に直した文字ではなく）
      const gs = wd.glyphs.filter((g) => (g.raw ?? g.text).trim() && !/^\u200b$/.test(g.text)).sort((p, q) => p.x0 - q.x0);
      const left = gs[0] && (gs[0].raw ?? gs[0].text);
      const right = gs[gs.length - 1] && (gs[gs.length - 1].raw ?? gs[gs.length - 1].text);
      // 右から左の語では、見た目の左端は読む順の終わり（閉じる側）、右端は始まり（開く側）
      if (left && BR_CLOSE.includes(left)) logicalVotes++;
      else if (left && BR_OPEN.includes(left)) visualVotes++;
      if (gs.length > 1 && right && BR_OPEN.includes(right)) logicalVotes++;
      else if (gs.length > 1 && right && BR_CLOSE.includes(right)) visualVotes++;
    }
    const logicalBrackets = logicalVotes >= visualVotes;
    /** 空白を含まない、向きが 1 つの文字列を書く区間（表示順）。書けなければ null */
    const tokenPieces = (token: string, dir: "L" | "R"): Omit<Piece, "x">[] | null => {
      const visible = (t: string) => (dir === "R" ? [...mirrored(t)].reverse().join("") : t);
      // 元のフォントで書くとき：かっこの文字は、そのフォントの流儀に合わせる（読む順の文字のままなら、並びだけ逆にする）
      const inOriginal = dir === "R" && logicalBrackets ? [...token].reverse().join("") : visible(token);
      if (!hasRtl(token) && !SHAPED.test(token) && w.canWrite(inOriginal))
        return [{ mw: w, text: inOriginal, dir: "L", width: w.width(inOriginal, size) * ref.hscale, scale: 1, mirror: dir === "R" && !logicalBrackets }];
      const ps = wordPieces(o.family, token, dir);
      if (!ps) return null;
      const out: Omit<Piece, "x">[] = [];
      for (const p of ps) {
        if (!writers.has(p.key)) writers.set(p.key, altFor?.(p.key) ?? null);
        const mw = writers.get(p.key);
        if (!mw) return null;
        // 欧文のフォントは、大文字の高さを元のフォントにそろえる（整形の要る文字のフォントは、欧文の高さでは比べられない）
        const scale = mw.show ? scriptScale(p.key) : mw.capHeight && w.capHeight ? clampTo(w.capHeight / mw.capHeight, 0.8, 1.15) : 1;
        // 整形しないフォントで右から左の区間（ヘブライ文字の語に付いた句読点・かっこ）を書くとき：並びを逆にし、かっこは左右逆の形にする
        out.push({ mw, text: mw.show ? p.text : visible(p.text), dir: p.dir, width: mw.width(p.text, size * scale) * ref.hscale, scale, mirror: !mw.show && dir === "R" });
      }
      return out;
    };
    /**
     * 新しい語の並び（読む順）を組む。行の向きの語は 1 語ずつ、逆向きの語の続き（数字・欧文の続き）はひとまとまりで、
     * 向きごとの区間に分けて表示順に並べる（続きの端に付いた句点・かっこは、行の向きに従って反対側に回る）
     */
    const layout = (list: string[], dirs: boolean[]): { pieces: Piece[]; W: number } | null => {
      const segs: string[] = [];
      for (let i = 0; i < list.length; ) {
        let j = i;
        if (dirs[i]) while (j + 1 < list.length && dirs[j + 1]) j++;
        segs.push(list.slice(i, j + 1).join(" "));
        i = j + 1;
      }
      const pieces: Piece[] = [];
      let x = 0;
      (R ? segs.reverse() : segs).forEach((seg, si) => {
        if (si) x += spaceW;
        for (const run of bidiRuns(seg, rl.base)) {
          const dir = run.dir === "rtl" ? "R" : "L";
          const tokens = run.text.split(" ");
          (dir === "R" ? tokens.reverse() : tokens).forEach((token, ti) => {
            if (ti) x += spaceW;
            if (!token) return;
            const ps = tokenPieces(token, dir);
            if (!ps) throw new Error("glyph");
            for (const p of ps) {
              pieces.push({ ...p, x });
              x += p.width;
            }
          });
        }
      });
      return { pieces, W: x };
    };

    // 行の始まる側（右から左の行なら右）から順に、変えた所の位置と、その先をずらす量を決める
    const mids: Mid[] = [];
    /** 変えた所：[x0, x1] にある元の字形は消し、そこより先（行の進む側）の字形は after だけずらす */
    const zones: { x0: number; x1: number; after: number }[] = [];
    let acc = 0;
    const order = R ? [...local.items].reverse() : local.items;
    for (let n = 0; n < order.length; n++) {
      const it = order[n];
      if ("old" in it) continue;
      const h = hunks[it.hunk];
      const olds = words.slice(h.a0, h.a1);
      const news = Bw.slice(h.b0, h.b1);
      let laid: ReturnType<typeof layout>;
      try {
        laid = layout(news, newAgainst.slice(h.b0, h.b1));
      } catch {
        laid = null;
      }
      if (!laid) return no("glyph");
      const W = laid.W;
      const nearItem = order.slice(0, n).reverse().find((x) => "old" in x) as { old: number } | undefined;
      const farItem = order.slice(n + 1).find((x) => "old" in x) as { old: number } | undefined;
      const near = nearItem ? words[nearItem.old] : null;
      const far = farItem ? words[farItem.old] : null;
      let start: number; // 新しい内容の、行の始まる側の端
      if (olds.length) {
        const X0 = Math.min(...olds.map((x) => x.x0));
        const X1 = Math.max(...olds.map((x) => x.x1));
        start = (R ? X1 : X0) + acc;
        let grow = W - (X1 - X0);
        let zx0 = X0;
        let zx1 = X1;
        if (!news.length && far) {
          // 語を消した：先の語との間の空白も 1 つ分詰める
          grow -= Math.max(0, R ? X0 - far.x1 : far.x0 - X1);
          if (R) zx0 = far.x1 + 1e-3;
          else zx1 = far.x0 - 1e-3;
        } else if (!news.length && near) {
          // 行の最後の語を消した：手前の空白の字形も消す
          if (R) zx1 = near.x0 - 1e-3;
          else zx0 = near.x1 + 1e-3;
        }
        acc += R ? -grow : grow;
        zones.push({ x0: zx0, x1: zx1, after: acc });
      } else {
        const edge = near ? (R ? near.x0 : near.x1) : R ? lineRight + 1e-3 : lineLeft - 1e-3;
        start = edge + acc + (near ? (R ? -spaceW : spaceW) : 0);
        acc += (R ? -1 : 1) * (W + spaceW);
        zones.push({ x0: edge, x1: edge, after: acc });
      }
      // 色などを引き継ぐ元の字：置き換える語（無ければ隣の語）の字
      const show = olds[0]?.glyphs[0]?.show ?? near?.glyphs[0]?.show ?? far?.glyphs[0]?.show ?? ref;
      const left = R ? start - W : start;
      for (const p of laid.pieces) {
        let shaped = p.mw.show && p.mw !== w ? p.mw.show(p.text, ref.size * p.scale, 0, p.dir) : null;
        // 左右逆の形で書いたかっこ：字形は「(」でも、文としては「)」。取り出したときに正しい向きになるよう、
        // その字にだけ「代わりの文字」を添える（LibreOffice などと同じ書き方）
        if (shaped === null && p.mirror && mirrored(p.text) !== p.text) {
          const parts: string[] = [];
          let plain = "";
          const flush = () => {
            if (plain) parts.push(`[${p.mw.encode(plain)}] TJ`);
            plain = "";
          };
          for (const ch of p.text) {
            const logical = mirrored(ch);
            if (logical === ch) {
              plain += ch;
              continue;
            }
            flush();
            parts.push(`/Span << /ActualText <feff${logical.charCodeAt(0).toString(16).padStart(4, "0")}> >> BDC [${p.mw.encode(ch)}] TJ EMC`);
          }
          flush();
          shaped = parts.join(" ");
        }
        mids.push({ midX: left + p.x, shaped, items: shaped === null ? [p.mw.encode(p.text)] : [], mw: p.mw, scale: p.scale, show });
      }
    }
    /** その位置（元の位置）にある字形をずらす量。消す範囲の中なら null */
    const shiftAtX = (c: number): number | null => {
      let sh = 0;
      for (const z of zones) {
        if (z.x1 > z.x0 && c > z.x0 - 1e-6 && c < z.x1 + 1e-6) return null;
        if (R ? c < z.x0 : c > z.x1) sh = z.after;
      }
      return sh;
    };
    for (const it of local.items) {
      if (!("old" in it)) continue;
      const wd = words[it.old];
      const sh = shiftAtX((wd.x0 + wd.x1) / 2) ?? 0;
      for (const g of wd.glyphs) {
        g.keep = true;
        g.shift = sh;
      }
    }
    // 空白などの字形（語には入れていない）は、消す範囲の外にあれば、その位置のずれに合わせて残す
    for (const g of glyphs) {
      if (g.sq || g.unknown || off(g)) continue;
      const sh = shiftAtX((g.x0 + g.x1) / 2);
      if (sh === null) continue;
      g.keep = true;
      g.shift = sh;
    }
    for (const g of glyphs) {
      if (!g.twin) continue;
      g.keep = g.twin.keep;
      g.shift = g.twin.shift;
    }
    // 字が増えて、行の進む側へはみ出すときは、行の始まる側の端を基準に、行全体を横に縮める。
    // 縮めすぎになるなら、縮められる所まで縮めて、はみ出す分はそのまま書く（編集中のページに保存結果がそのまま出る）
    let squeeze = 1;
    const pivot = R ? lineRight : lineLeft;
    if (R) {
      const limit = o.source.x - (o.source.roomLeft ?? 0) - o.fontSize * 0.15;
      const end = lineLeft + acc;
      if (acc < -0.01 && end < limit) squeeze = (pivot - limit) / (pivot - end);
    } else {
      const limit = o.source.x + Math.max(o.w, o.source.room) + o.fontSize * 0.15;
      const end = lineRight + acc;
      if (acc > 0.01 && end > limit) squeeze = (limit - pivot) / (end - pivot);
    }
    if (!(squeeze > 0)) squeeze = 0.6;
    return emit(mids, Math.min(1, Math.max(squeeze, 0.6)), pivot, moveX, moveY, refGlyph.base, size, true);
  }

  // 行の文字列と字形の対応
  const posAt: number[] = []; // 元の文字列の位置 → そろえた文字列の位置
  let rText = "";
  for (const ch of o.original) {
    for (let i = 0; i < ch.length; i++) posAt.push(rText.length);
    rText += squash(ch);
  }
  posAt.push(rText.length);
  // ページの端にかかって一部だけ見えている字は、行の文字列に入っていないことがある。それを除けば合うなら、元のまま残す
  // （左端の字だけ・右端の字だけ・両方、の順に試す。端にかかっていても文字列に入っている字は、そのまま対応付ける）
  if (line.map((g) => g.sq).join("") !== rText) {
    const left = (g: G) => g.x0 < -0.5;
    const right = (g: G) => g.x1 > item.width + 0.5;
    for (const out of [left, right, (g: G) => left(g) || right(g)]) {
      const rest = line.filter((g) => !out(g));
      if (!rest.length || rest.length === line.length || rest.map((g) => g.sq).join("") !== rText) continue;
      for (const g of line) if (out(g)) g.keep = true;
      line.splice(0, line.length, ...rest);
      break;
    }
  }
  if (line.some((g) => g.unknown)) {
    // 何の字か分からない字形（合字「fi」など）：次の分かる字が合う所まで、行の文字列の 1〜4 字をその字形のものとする
    let at = 0;
    for (let i = 0; i < line.length; i++) {
      const g = line[i];
      if (!g.unknown) {
        if (!rText.startsWith(g.sq, at)) return no("mismatch");
        at += g.sq.length;
        continue;
      }
      const next = line.slice(i + 1).find((x) => !x.unknown);
      let k = -1;
      for (let n = 1; n <= 4 && k < 0; n++) if (next ? rText.startsWith(next.sq, at + n) : at + n === rText.length) k = n;
      // 分からない字形が続くときは 1 字ずつ
      if (line[i + 1]?.unknown) k = 1;
      if (k < 0 || at + k > rText.length) return no("mismatch");
      g.sq = rText.slice(at, at + k);
      at += k;
    }
    if (at !== rText.length) return no("mismatch");
  } else if (line.map((g) => g.sq).join("") !== rText) {
    // 左からの並びが文字列の順と少し違うことがある（数式の根号、位置を戻して重ねた約物など）。
    // 文字列の順に、近くにある同じ字の字形を当てていき、全部を使い切れたらその順を採る
    const used = new Array<boolean>(line.length).fill(false);
    const order: G[] = [];
    let at = 0;
    let cursor = 0;
    while (at < rText.length) {
      let best = -1;
      for (let i = 0; i < line.length; i++) {
        if (used[i] || !rText.startsWith(line[i].sq, at)) continue;
        if (best < 0 || Math.abs(i - cursor) < Math.abs(best - cursor)) best = i;
      }
      if (best < 0) return no("mismatch");
      used[best] = true;
      order.push(line[best]);
      at += line[best].sq.length;
      cursor = best + 1;
    }
    if (order.length !== line.length) return no("mismatch");
    line.splice(0, line.length, ...order);
  }
  const starts: number[] = []; // 字形ごとの、そろえた文字列での開始位置
  let gText = "";
  for (const g of line) {
    starts.push(gText.length);
    gText += g.sq;
  }
  const glyphAt = new Map(starts.map((s, i) => [s, i]));
  glyphAt.set(gText.length, line.length);

  // 変えた所を求める。1 行の中で離れた 2 か所以上を変えたときは、それぞれを別々に書き換え、間の変えていない語は元の字形のまま残す
  // （まとめて 1 か所として扱うと、間の語まで組み直すことになる。同梱フォントで書く場合は、間の語まで書体が変わってしまう）。
  // 別々に扱えない並び（切れ目が字形の境目に合わない、同じ語の中に 2 か所ある 等）なら、最初の変更から最後の変更までを 1 か所として扱う
  const A = o.original;
  const B = o.text;
  const low = (c: number) => c >= 0xdc00 && c <= 0xdfff;
  const cut = (i: number) => glyphAt.has(posAt[i]) && !low(A.charCodeAt(i));
  // タイ文字の「ำ」：1 つの字形を持たないフォント（丸＋ า に分けて描く文書）では、同じように 2 つに分けて書く
  const expand = (list: string[]) => list.flatMap((ch) => (ch === "ำ" && !w.canWrite(ch) ? ["ํ", "า"] : [ch]));
  const writable = (t: string) => w.canWrite(expand([...t]).join("").replace(/\s/g, ""));
  // 語の切れ目：空白・記号・数字・和文（1 字ずつ独立している字）との境目。整形は語の中だけで行われるので、そこで切ってよい。
  // 欧文も語の単位で切る（1 語の中で書体が混ざらないように）。和文は 1 字単位（無い字だけが同梱フォントになる）
  const sp = (c: string | undefined) => c === undefined || !WORDCHAR.test(c);

  // 元の行の、字と字の間・空白の幅の目安
  const charGaps: number[] = [];
  const spaceGaps: number[] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const gap = line[i + 1].x0 - line[i].x1;
    const endOfThis = starts[i] + line[i].sq.length;
    // 元の文字列で、この字形と次の字形の間に空白があるか
    let between = false;
    for (let j = 0; j < A.length; j++) if (posAt[j] === endOfThis && posAt[j + 1] === endOfThis && /\s/.test(A[j])) between = true;
    (between ? spaceGaps : charGaps).push(gap);
  }
  const size = ref.size * k;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const charGap = clamp(median(charGaps) ?? 0, -0.15 * size, 0.6 * size);
  const natural = (w.width(" ", size) + (w.simple ? o.wordSpacing : 0)) * ref.hscale;
  const spaceW = clamp(median(spaceGaps) ?? (natural > 0.05 * size ? natural : 0.3 * size), 0.1 * size, 1.5 * size);
  const last = line[line.length - 1];
  const allChars = expand([...B]);

  /** 変えた 1 か所の書き方：元の行のどの字形を置き換えるか、何をどこに書くか、後ろの字をどれだけずらすか */
  interface Plan {
    nPre: number;
    nSuf: number;
    mw: TextWriter;
    startX: number;
    midX: number;
    shaped: string | null;
    items: string[];
    pen: number;
    shift: number;
    /** 同梱フォントで書くときの、文字の大きさの倍率（大文字の高さを元のフォントにそろえる） */
    scale: number;
  }
  // 同梱フォントの字を混ぜるとき、字面の大きさは書体ごとに違う（和文フォントの欧文は大きめ、など）。大文字の高さが元のフォントと
  // 同じになるよう、文字の大きさを変える（整形の要る文字のフォントは、欧文の高さでは比べられないので、そのまま）
  const altScale = alt && !alt.show && alt.capHeight && w.capHeight ? clamp(w.capHeight / alt.capHeight, 0.8, 1.15) : 1;
  const planHunks = (hs: Hunk[]): Plan[] | string => {
    const plans: Plan[] = [];
    let base = 0; // ここまでの書き換えで、後ろの字がずれた量
    let lo = 0; // 前の書き換えの終わり（元の文字列での位置）
    for (let n = 0; n < hs.length; n++) {
      let { p, e, bp, be } = hs[n];
      const hi = n + 1 < hs.length ? hs[n + 1].p : A.length;
      // 字形の切れ目に合わせる（広げる分は、前後の変えていない部分から取る）
      while (p > lo && !cut(p)) {
        p--;
        bp--;
      }
      while (e < hi && !cut(e)) {
        e++;
        be++;
      }
      if (!cut(p) || !cut(e)) return "cut";
      // 語の切れ目まで広げる前の、実際に変えた範囲
      const [p0, e0, bp0, be0] = [p, e, bp, be];
      // 変えた部分を元のフォントで書けない（字が無い／前後の字で形が変わる文字で、1 字ずつ並べても正しい形にならない）ときは、
      // 同梱フォントで書く。語の途中でフォントが変わらないよう、変える範囲を語の切れ目まで広げる
      let mw = w;
      const changed = B.slice(bp, be);
      if (alt && (!writable(changed) || (o.complex && SHAPED.test(changed)))) {
        const startOk = () => (sp(A[p - 1]) || (sp(A[p]) && sp(B[bp]))) && cut(p);
        const endOk = () => (sp(A[e]) || (sp(A[e - 1]) && sp(B[be - 1]))) && cut(e);
        while (p > lo && !startOk()) {
          p--;
          bp--;
        }
        while (e < hi && !endOk()) {
          e++;
          be++;
        }
        // 隣の書き換えと同じ語の中でぶつかった：別々には書けない
        if (hs.length > 1 && (!startOk() || !endOk())) return "merge";
        mw = alt;
      }
      const nPre = glyphAt.get(posAt[p]);
      const nSuf = glyphAt.get(posAt[e]);
      if (nPre === undefined || nSuf === undefined || nSuf < nPre) return "cut";
      // 前の書き換えとの間に残る字形が無い（間が空白だけ 等）：書き始めの位置を元の字から決められない
      if (plans.length && nPre <= plans[plans.length - 1].nSuf) return "merge";
      // 広げた分（変えていないが、語ごと書き直す字）は、PDF の中の並び（見た目の順）になっている。整形に渡す前に、入力するときの順に直す
      const middle = mw === w ? B.slice(bp, be) : visualToLogical(A.slice(p, p0)) + B.slice(bp0, be0) + visualToLogical(A.slice(e0, e));
      if (mw === w ? !writable(middle) : !alt!.canWrite(middle.replace(/\s/g, ""))) return "glyph";
      // 前後の字で形が変わる文字の行は、変えた語を同梱フォントで書く以外の方法では書き換えない
      if (o.complex && mw === w && SHAPED.test(middle)) return "glyph";

      // 変わった部分の開始位置と、後ろをずらす量
      const oldMid = line.slice(nPre, nSuf);
      const oldText = A.slice(p, e);
      // 前の字に続けて書くか（消した部分が空白で始まる／語の末尾に字を足した）、元の字の位置から書くか
      const afterPrev = nPre > 0 && (/^\s/.test(oldText) || (oldText === "" && !/\s/.test(A[p - 1] ?? " ")));
      const startOld = afterPrev ? line[nPre - 1].x1 : oldMid.length ? oldMid[0].x0 : nSuf < line.length ? line[nSuf].x0 : last.x1;
      const oldEnd = /\s$/.test(oldText) && nSuf < line.length ? line[nSuf].x0 : oldMid.length ? oldMid[oldMid.length - 1].x1 : startOld;
      const startX = startOld + base;
      let pen = startX;
      const items: string[] = [];
      const scale = mw === w ? 1 : altScale;
      const fsz = size * scale;
      const tjs = (d: number) => fmt((-d / (fsz * ref.hscale)) * 1000);
      const chars = expand([...middle]);
      const before = expand([...B.slice(0, bp)]).length;
      const thai = mw === w && THAI.test(middle) ? learnThai(a, ref, opsOf) : null;
      // 整形の要るフォント（同梱のタイ・インド系・アラビア文字）は、語をまとめて整形して書く
      let shaped: string | null = null;
      let midX = startX;
      if (mw.show) {
        const lead = /^\s*/.exec(middle)![0].length;
        const core = middle.trim();
        const trail = middle.length - lead - core.length;
        midX = startX + (core ? lead : 0) * spaceW;
        pen = midX;
        if (core) {
          shaped = mw.show(core, ref.size, 0);
          pen += mw.width(core, size) * ref.hscale;
        }
        pen += (core ? trail : middle.length) * spaceW;
      }
      (shaped === null && !mw.show ? chars : []).forEach((ch, i) => {
        if (/\s/.test(ch)) {
          // 空白の字形があるフォントなら字形も書く（文字として取り出せるように）。幅の差は位置の調整で埋める
          const sw = ch === " " && mw.canWrite(" ") ? mw.width(" ", fsz) * ref.hscale : 0;
          if (sw > 0) items.push(mw.encode(" "));
          if (Math.abs(spaceW - sw) > 1e-6) items.push(tjs(spaceW - sw));
          pen += spaceW;
          return;
        }
        // タイ文字：上下に付く記号などは、前後の字によって使う字形と置く位置が変わる。この文書で同じ並びのときに使われていた字形と位置に合わせる
        const learned = thai ? pickThai(thai, allChars, before + i) : null;
        if (learned) {
          const unit = fsz * ref.hscale;
          if (Math.abs(learned.dx) > 1e-4) items.push(tjs(learned.dx * unit));
          items.push(hex(learned.bytes));
          const post = learned.ret - learned.dx - learned.adv;
          if (Math.abs(post) > 1e-4) items.push(tjs(post * unit));
          pen += learned.ret * unit;
        } else {
          items.push(mw.encode(ch));
          pen += mw.width(ch, fsz) * ref.hscale;
        }
        const next = chars[i + 1];
        if (next !== undefined && !/\s/.test(next) && charGap) {
          items.push(tjs(charGap));
          pen += charGap;
        }
      });
      // 字を足しただけのとき（消す字が無い）は、後ろとの間にも元の字間を入れる
      if (oldText === "" && chars.length && !/\s$/.test(middle)) pen += charGap;
      // 後ろの字形をずらす量（元の位置から。ここまでの書き換えの分も含む）
      const shift = pen - oldEnd;
      plans.push({ nPre, nSuf, mw, startX, midX, shaped, items, pen, shift, scale });
      base = shift;
      lo = e;
    }
    return plans;
  };

  // 最初の変更から最後の変更までを 1 か所とした場合（共通する先頭と末尾を除いた部分）
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let q = 0;
  while (q < A.length - p && q < B.length - p && A[A.length - 1 - q] === B[B.length - 1 - q]) q++;
  const several = wordHunks(A, B);
  let plans = several ? planHunks(several) : "single";
  if (typeof plans === "string") plans = planHunks([{ p, e: A.length - q, bp: p, be: B.length - q }]);
  if (typeof plans === "string") return no(plans);
  const first = plans[0];
  const final = plans[plans.length - 1];
  const shift = final.shift;
  const lastX = final.nSuf < line.length ? line[line.length - 1].x1 + shift : final.pen;
  // 字が増えて右へはみ出すときは、行全体を横に縮めて収める（字間・空白の比は保つ）。縮めすぎになるなら従来の処理へ
  const limit = o.source.x + Math.max(o.w, o.source.room) + o.fontSize * 0.15;
  // まず変えた所から後ろだけを縮める（前の部分は元の位置のまま）。それでは詰まりすぎるなら行全体を縮める
  let squeeze = 1;
  let pivot = first.startX;
  if (shift > 0.01 && lastX > limit) {
    squeeze = (limit - first.startX) / (lastX - first.startX);
    if (!(squeeze >= 0.8)) {
      pivot = line[0].x0;
      squeeze = (limit - pivot) / (lastX - pivot);
      if (!(squeeze >= 0.7)) {
        if (!o.complex) return no("overflow");
        // 字形の並びのままの行は、文字を小さくして組み直す方法が使えない。縮められる所まで縮めて、はみ出す分はそのまま書く
        // （編集中のページに保存結果がそのまま出るので、見て語を短くできる）
        squeeze = Math.max(squeeze, 0.6);
      }
    }
  }

  // 変えていない字形は残す。変えた所より後ろの字形は、そこまでの書き換えで伸び縮みした分だけずらす
  const shiftAt = (i: number): number | null => {
    if (i < first.nPre) return 0;
    for (let n = 0; n < plans.length; n++) if (i >= plans[n].nSuf && (n + 1 === plans.length || i < plans[n + 1].nPre)) return plans[n].shift;
    return null;
  };
  for (let i = 0; i < line.length; i++) {
    const sh = shiftAt(i);
    if (sh === null) continue;
    line[i].keep = true;
    line[i].shift = sh;
  }
  // 空白の字形（文字列との対応には入れていない）は、左隣の字形が残るときだけ、それと一緒に残す
  // （行の先頭にある空白は、先頭の字形が残るとき）
  for (const g of glyphs) {
    if (g.sq || off(g)) continue;
    let li = -1;
    for (let i = 0; i < line.length; i++) if (line[i].x0 <= g.x0) li = i;
    const sh = li >= 0 ? shiftAt(li) : first.nPre > 0 ? 0 : first.nSuf === 0 && line.length > 0 ? first.shift : null;
    if (sh === null) continue;
    g.keep = true;
    g.shift = sh;
  }

  for (const g of glyphs) {
    if (!g.twin) continue;
    g.keep = g.twin.keep;
    g.shift = g.twin.shift;
  }

  return emit(
    plans.map((pl) => ({ midX: pl.midX, shaped: pl.shaped, items: pl.items, mw: pl.mw, scale: pl.scale, show: line[pl.nPre < pl.nSuf ? pl.nPre : -1]?.show ?? line[pl.nPre - 1]?.show ?? line[pl.nSuf]?.show ?? ref })),
    squeeze,
    pivot,
    moveX,
    moveY,
    refGlyph.base,
    size,
  );
}

function fallbackColor(hexColor: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hexColor.trim());
  if (!m) return "0 g";
  const n = parseInt(m[1], 16);
  return `${fmt(((n >> 16) & 255) / 255)} ${fmt(((n >> 8) & 255) / 255)} ${fmt((n & 255) / 255)} rg`;
}

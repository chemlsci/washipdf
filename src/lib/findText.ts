/**
 * 文書内の検索（一括置換・一括墨消しの土台）。
 * - 文字列の照合は、解析済みの行（TextRun）の文字列に対して行う。
 * - 墨消しでは、見つけた部分の「字形の位置」が要る。行を描いている文字描画命令から字形ごとの外接矩形を求め、
 *   行の文字列と 1 対 1 に対応が取れたときだけ、その範囲を返す（取れないときは呼び出し側が行全体を対象にする）。
 */
import { logicalWithMap } from "./indic";
import type { ContentOp, Operand } from "./contentStream";
import { apply } from "./geometry";
import { analyzePage } from "./libDoc";
import { glyphBounds } from "./redact";
import { rtlLine } from "./rtl";
import { applyActualText, type ShowOp } from "./textOps";
import type { TextRun } from "./textRuns";
import type { PageItem, SourceDoc } from "./types";

export interface Match {
  /** 元の文字列での位置（end は含まない） */
  start: number;
  end: number;
}

/** 照合用にそろえる：全角・半角と大文字・小文字の違いを無視する */
const fold = (s: string) => s.normalize("NFKC").toLowerCase();

/** 探すもの：文字列か、決まった形（電話番号などのひな形。全角・半角をそろえた文字列に当てる正規表現） */
export type Query = string | RegExp;

/** 正規表現で探す。全角・半角をそろえた文字列に当て、見つかった範囲を元の文字列の位置に戻す */
function findPattern(text: string, re: RegExp): Match[] {
  let folded = "";
  const origin: number[] = [];
  const lens = new Map<number, number>();
  for (const m of text.matchAll(/[\s\S][\uFF9E\uFF9F\p{M}]*/gu)) {
    const f = fold(m[0]);
    for (let k = 0; k < f.length; k++) origin.push(m.index);
    folded += f;
    lens.set(m.index, m[0].length);
  }
  const out: Match[] = [];
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  for (const m of folded.matchAll(g)) {
    if (!m[0]) continue;
    const start = origin[m.index];
    const last = origin[m.index + m[0].length - 1];
    out.push({ start, end: last + (lens.get(last) ?? 1) });
  }
  return out;
}

/**
 * 個人情報のひな形（墨消し用）。全角・半角をそろえた文字列（数字は半角、英字は小文字）に当てる。
 * 数字の続きの途中から始まったり、途中で終わったりする一致は取らない（長い番号の一部を電話番号と見なさない）
 */
const DASH = "[-‐‑‒–—―−ー]";
// 前後に数字（または「区切り＋数字」）が続く所では始まらない・終わらない：長い番号や、ハイフンでつないだ番号の一部を拾わない
const NB = `(?<![\\d]|[\\d]${DASH})`;
const NA = `(?![\\d]|${DASH}[\\d])`;
export const PII_PATTERNS = {
  // 電話番号：0 から（または +81 から）始まる番号。市外局番のかっこ「(03) 3333-4444」、+81 の後の空白、
  // 携帯などの番号（050・070・080・090）を点で区切った「090.1111.2222」も拾う
  // （点区切りをそれ以外にも広げると、「03.11.2025」のような日付まで拾ってしまう）
  phone: new RegExp(
    `${NB}(?:0[5789]0\\.\\d{4}\\.\\d{4}|(?:\\+81[\\s-]?\\(?0?|\\(?0)\\d{1,4}\\)?(?:${DASH}|\\(|\\)|\\s)?\\d{1,4}(?:${DASH}|\\)|\\s)?\\d{3,4})${NA}`,
    "u",
  ),
  // メールアドレス：各部分の長さに上限を付け、語の途中からは始めない（長い文字列で、探す時間が字数の 2 乗に膨らまないように）
  email: /(?<![a-z0-9._%+-])[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){0,8}\.[a-z]{2,24}/u,
  // 郵便番号：123-4567。〒 が付いていれば、ハイフンの無い 7 桁も
  postal: new RegExp(`${NB}(?:(?:〒\\s?)?\\d{3}${DASH}\\d{4}|〒\\s?\\d{7})${NA}`, "u"),
  mynumber: new RegExp(`${NB}\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}${NA}`, "u"),
  // カード番号：16 桁（4-4-4-4）と、15 桁（4-6-5）
  card: new RegExp(`${NB}(?:\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}|\\d{4}[\\s-]?\\d{6}[\\s-]?\\d{5})${NA}`, "u"),
} as const;
export type PiiKind = keyof typeof PII_PATTERNS;

/**
 * text から query を探す（重ならない一致を先頭から順に）。
 * exact でなければ、全角・半角と大文字・小文字を区別しない。
 */
export function findMatches(text: string, query: Query, exact = false): Match[] {
  if (!query) return [];
  const out: Match[] = [];
  if (query instanceof RegExp) return findPattern(text, query);
  if (exact) {
    for (let i = text.indexOf(query); i >= 0; i = text.indexOf(query, i + query.length)) out.push({ start: i, end: i + query.length });
    return out;
  }
  // そろえた文字列の各文字が、元の何文字目から来たかを覚えておく（NFKC で文字数が変わるため）。
  // 濁点・半濁点などの結合文字は前の文字と一緒にそろえる（ｶﾞ → ガ）
  let folded = "";
  const origin: number[] = [];
  const lens = new Map<number, number>();
  for (const m of text.matchAll(/[\s\S][\uFF9E\uFF9F\p{M}]*/gu)) {
    const f = fold(m[0]);
    for (let k = 0; k < f.length; k++) origin.push(m.index);
    folded += f;
    lens.set(m.index, m[0].length);
  }
  const q = fold(query);
  if (!q) return [];
  for (let p = folded.indexOf(q); p >= 0; p = folded.indexOf(q, p + q.length)) {
    const start = origin[p];
    const lastOrigin = origin[p + q.length - 1];
    // 1 文字が複数文字に広がる場合（㍻ → 平成 など）、その途中で始まる・終わる一致は元の文字に戻せないので採らない
    if ((p > 0 && origin[p - 1] === start) || (p + q.length < origin.length && origin[p + q.length] === lastOrigin)) continue;
    out.push({ start, end: lastOrigin + (lens.get(lastOrigin) ?? 1) });
  }
  return out;
}

/**
 * 元の PDF の行から探す。インド系の文字の行は、字が PDF の中の並び（見た目の順：子音の左の母音記号が先）で入っているので、
 * 入力するときの順に直した文字列からも探し、見つかった範囲を元の並びでの範囲に戻す（その語の字をすべて含む、ひと続きの範囲）。
 */
export function findMatchesInRun(text: string, query: Query, exact = false): Match[] {
  const direct = findMatches(text, query, exact);
  const lg = logicalWithMap(text);
  if (!lg) return direct;
  const out = [...direct];
  for (const m of findMatches(lg.text, query, exact)) {
    const idx = lg.from.slice(m.start, m.end);
    if (!idx.length) continue;
    const start = Math.min(...idx);
    const end = Math.max(...idx) + 1;
    if (!out.some((d) => d.start < end && start < d.end)) out.push({ start, end });
  }
  return out.sort((a, b) => a.start - b.start);
}

const latinEnd = (s: string) => /[A-Za-z0-9,.;:)\]'"]$/.test(s);
const latinStart = (s: string) => /^[A-Za-z0-9(\['"]/.test(s);

/**
 * 行の終わりから次の行の頭へまたがる一致を探す（a が上の行、b が次の行）。
 * 欧文どうしの行は間に空白 1 つ、和文は空白なしでつながっているものとして照合する（editModel.joinLines と同じ決まり）。
 * 返り値は、a の中の部分と b の中の部分（どちらも空でない）。
 */
export function findSpanning(a: string, b: string, query: Query, exact = false): { a: Match; b: Match }[] {
  if (!a || !b || !query) return [];
  const sep = latinEnd(a) && latinStart(b) ? " " : "";
  const out: { a: Match; b: Match }[] = [];
  for (const m of findMatches(a + sep + b, query, exact)) {
    const bStart = a.length + sep.length;
    if (m.start >= a.length || m.end <= bStart) continue; // どちらか 1 行に収まっている一致は、行ごとの検索で見つかる
    out.push({ a: { start: m.start, end: a.length }, b: { start: 0, end: m.end - bStart } });
  }
  return out;
}

/** 一致した部分を置き換えた文字列 */
export function replaceMatches(text: string, matches: Match[], replacement: string): string {
  let out = "";
  let at = 0;
  for (const m of [...matches].sort((a, b) => a.start - b.start)) {
    out += text.slice(at, m.start) + replacement;
    at = m.end;
  }
  return out + text.slice(at);
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Glyph {
  text: string;
  /** 表示座標の外接矩形 */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function showItems(op: ContentOp): Operand[] {
  const a = op.operands;
  if (op.op === '"') return a[2] ? [a[2]] : [];
  if (op.op === "TJ") return a[0]?.kind === "array" ? a[0].items : [];
  return a[0] ? [a[0]] : [];
}

/** 文字描画命令 1 つの字形を、表示座標の矩形つきで並べる。幅が分からないフォントなら null */
function glyphsOfShow(s: ShowOp, op: ContentOp, page: PageItem): Glyph[] | null {
  const font = s.font;
  if (!font || !font.widthsKnown || !s.size || !s.hscale || font.vertical) return null;
  const out: Glyph[] = [];
  let pos = 0;
  for (const it of showItems(op)) {
    if (it.kind === "num") {
      pos -= (it.value / 1000) * s.size * s.hscale;
      continue;
    }
    if (it.kind !== "string") continue;
    for (const c of font.decode(it.bytes)) {
      const tx = ((font.width(c) / 1000) * s.size + s.charSpacing + (c.isSpace ? s.wordSpacing : 0)) * s.hscale;
      const b = glyphBounds(s.trm, pos, tx, s.size, s.rise);
      const pts = [apply(page.viewTransform, b.x0, b.y0), apply(page.viewTransform, b.x1, b.y0), apply(page.viewTransform, b.x0, b.y1), apply(page.viewTransform, b.x1, b.y1)];
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      out.push({ text: font.toUnicode(c) ?? "", x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
      pos += tx;
    }
  }
  return out;
}

/** 対応付け用にそろえる：空白を除き、互換文字をそろえる（行の文字列は断片の間に空白を補っていることがある） */
const squash = (s: string) => s.normalize("NFKC").replace(/\s+/g, "");

/**
 * 行（横書き）の中の一致それぞれについて、字形の外接矩形（表示座標）を返す。
 * 行の文字列と字形の並びが一致しないとき（ToUnicode が無い、合字、Form XObject の中、縦書きなど）は null。
 */
/** 行を描いている文字描画命令ごとの字形（ページ直下の命令のみ）。幅の分からないフォントや Form XObject の中なら null */
export async function glyphsByShow(doc: SourceDoc, page: PageItem, run: TextRun): Promise<Glyph[][] | null> {
  if (run.vertical || !run.removals.length || run.removals.some((r) => r.path?.length)) return null;
  const analysis = await analyzePage(doc, page.srcIndex);
  if (analysis.error) return null;
  const wanted = new Set(run.removals.map((r) => r.index));
  const out: Glyph[][] = [];
  const flat: { show: ShowOp; g: Glyph }[] = [];
  for (const s of analysis.shows) {
    if (s.path.length || !wanted.has(s.index)) continue;
    const op = analysis.ops[s.index];
    const g = op ? glyphsOfShow(s, op, page) : null;
    if (!g) return null;
    out.push(g);
    for (const x of g) flat.push({ show: s, g: x });
  }
  // 「代わりの文字」で本当の文字を与えている字形（本体と点に分けて描いた字など）は、行の文字列と同じ読み方にする
  // （右から左の行だけ：ほかの行の文字列は表示側から得ていて、この指定を読んでいない）
  if (run.rtl)
    applyActualText(
      flat,
      (x) => x.g.x1 - x.g.x0,
      (x) => x.g.text || null,
      (x, text) => (x.g.text = text),
    );
  return out;
}

const union = (used: Glyph[]): Box => {
  const x0 = Math.min(...used.map((g) => g.x0));
  const y0 = Math.min(...used.map((g) => g.y0));
  const x1 = Math.max(...used.map((g) => g.x1));
  const y1 = Math.max(...used.map((g) => g.y1));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

/** 右から左に書く文字 */
export const RTL_SCRIPT = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;
/**
 * 字形と文字の対応が取りにくく、語の位置を字形から決められない文字（インド系、タイ・ラオス、チベット、ミャンマー、クメール）。
 * 字形が見た目の順に並び、1 つの字形が複数の字を表したり、母音記号が前後に動いたりする
 */
export const SHAPED_SCRIPT = /[\u0e80-\u0eff\u0f00-\u0fff\u1000-\u109f\u1780-\u17ff]/;
/** タイ文字（字形は読む順に並ぶ。上下に付く記号は幅 0 の字形） */
const THAI = /[\u0e00-\u0e7f]/;
/**
 * タイ文字の語の範囲の調整。上下に付く記号（声調記号・母音記号）は幅 0 の字形で、直前の字の右端の位置に置かれる。
 * そのため、語の左端ちょうどには「前の字に付く記号」が、右端ちょうどには「語の最後の字に付く記号」がある。
 * 左端を少し内側に、右端を少し外側にずらして、前の字の記号は残し、語の最後の字の記号は一緒に消えるようにする
 */
const thaiAdjust = (b: Box): Box => ({ x: b.x + 0.4, y: b.y, w: b.w, h: b.h });

/** 対応付け用：空白・制御文字・つなぎの記号（ゼロ幅の接合子、アラビア文字の伸ばし棒）を除き、互換文字をそろえる */
const squashRtl = (s: string) => s.normalize("NFKC").replace(/[\s\u0000-\u001f\u007f\u0640\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g, "");

/**
 * 行の文字列（読む順）を、表示順（左→右）に並べ替えたときの、各文字の元の位置。
 * 右から左の行として扱う：アラビア系の字は右から左、欧文と数字のまとまりは左から右のまま、
 * どちらでもない字（空白・記号）は両隣が同じ向きならそれに、違えば行の向き（右から左）に従う。
 */
export function visualOrder(text: string): number[] {
  const idx: number[] = [];
  const chars: string[] = [];
  for (let i = 0; i < text.length; ) {
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    idx.push(i);
    chars.push(ch);
    i += ch.length;
  }
  const type = chars.map((c) => (RTL_SCRIPT.test(c) ? "R" : /\p{L}|\p{Nd}/u.test(c) ? "L" : /\p{M}/u.test(c) ? "M" : "N"));
  // 結合記号は直前の字と同じ向き
  for (let i = 0; i < type.length; i++) if (type[i] === "M") type[i] = i > 0 ? type[i - 1] : "R";
  const dir: ("L" | "R")[] = [];
  for (let i = 0; i < type.length; i++) {
    if (type[i] !== "N") {
      dir.push(type[i] as "L" | "R");
      continue;
    }
    let prev = "N";
    for (let j = i - 1; j >= 0 && prev === "N"; j--) prev = type[j];
    let next = "N";
    for (let j = i + 1; j < type.length && next === "N"; j++) next = type[j];
    dir.push(prev === "L" && next === "L" ? "L" : "R");
  }
  // 左から右のまとまりの中を逆にしてから、行全体を逆にする（＝右から左の行の表示順）
  const order = chars.map((_, i) => i);
  for (let i = 0; i < order.length; ) {
    if (dir[i] !== "L") {
      i++;
      continue;
    }
    let j = i;
    while (j < order.length && dir[j] === "L") j++;
    order.splice(i, j - i, ...order.slice(i, j).reverse());
    i = j;
  }
  return order.reverse().map((k) => idx[k]);
}

/**
 * 右から左の行で、一致それぞれの字形の範囲を求める。
 * 表示順に並べた文字と、左から並べた字形を順に突き合わせる。字形 1 つが複数の字（合字）のときや、
 * 記号の位置が 1〜2 字前後するときに備えて、少し先まで見て同じ字を探す。全部の字形を使い切れなければ null（行全体を対象にする）。
 */
function rtlBoxes(text: string, glyphs: Glyph[], matches: Match[]): (Box | null)[] | null {
  const vis = visualOrder(text)
    .map((i) => ({ i, ch: squashRtl(String.fromCodePoint(text.codePointAt(i)!)) }))
    .flatMap((v) => [...v.ch].map((ch) => ({ i: v.i, ch })));
  const used = new Array<boolean>(vis.length).fill(false);
  const glyphOf = new Map<number, Glyph[]>(); // 元の位置 → その字を描く字形
  let from = 0;
  for (const g of glyphs) {
    const t = [...squashRtl(g.text)];
    for (const ch of t) {
      while (from < vis.length && used[from]) from++;
      let k = -1;
      for (let j = from; j < Math.min(vis.length, from + 6); j++) {
        if (!used[j] && vis[j].ch === ch) {
          k = j;
          break;
        }
      }
      if (k < 0) return null;
      used[k] = true;
      glyphOf.set(vis[k].i, [...(glyphOf.get(vis[k].i) ?? []), g]);
    }
  }
  if (used.some((u) => !u)) return null;
  return matches.map((m) => {
    const gs: Glyph[] = [];
    for (let i = m.start; i < m.end; i++) for (const g of glyphOf.get(i) ?? []) gs.push(g);
    if (!gs.length) return null;
    // 語の字形が 1 か所にまとまっていること（離れていたら対応を誤っている）
    const b = union(gs);
    const sum = gs.reduce((n, g) => n + (g.x1 - g.x0), 0);
    return b.w > sum * 1.6 + 4 ? null : b;
  });
}

/**
 * 右から左の行（文字列を字形から組み立てたもの）で、一致それぞれの範囲を、語の単位で求める：一致に掛かる語の字形をまとめた範囲。
 * 語の一部だけが一致していても、語全体を範囲にする（アラビア文字は語の中で字がつながっているので、途中では切らない）。
 * 行を組み立て直した文字列が行の文字列と合わなければ null
 */
function rtlWordBoxes(run: TextRun, glyphs: Glyph[], matches: Match[]): (Box | null)[] | null {
  // 同じ字を同じ位置に重ねて描いたもの（影・太く見せる重ね書き）は 1 つとして数える（行の文字列を作ったときと同じ）
  const kept: Glyph[] = [];
  for (const g of glyphs) {
    const sq = squash(g.text).replace(/[\u0000-\u001f\u007f]/g, "");
    const tol = Math.max(0.6, Math.abs(g.x1 - g.x0) * 0.12, run.fontSize * 0.03);
    if (sq && kept.slice(-6).some((p) => squash(p.text) === sq && Math.abs(p.x0 - g.x0) < tol && Math.abs(p.y1 - g.y1) < tol)) continue;
    kept.push(g);
  }
  const rl = rtlLine(kept, run.fontSize, run.text.trim().split(/\s+/).length, { base: run.rtl });
  if (!rl || rl.text !== run.text) return null;
  let at = 0;
  const spans = rl.words.map((w) => {
    const start = at;
    at += w.text.length + 1;
    return { start, end: start + w.text.length, glyphs: w.glyphs };
  });
  return matches.map((m) => {
    const hit = spans.filter((w) => w.start < m.end && w.end > m.start);
    return hit.length ? union(hit.flatMap((w) => w.glyphs)) : null;
  });
}

/**
 * 行（横書き）の中の一致それぞれについて、字形の外接矩形（表示座標）を返す。
 * 1. 行の文字列と、字形を左から並べた文字列が一致すれば、位置をそのまま対応させる。
 * 2. 一致しないとき（表や段組みで、離れた文字が 1 行にまとめられている等）は、文字描画命令 1 つずつの中で同じ語を探す。
 *    見つかった数が行の中の一致の数と同じなら、それを使う。
 * どちらでも決まらないとき（文字の対応表が無い、合字、Form XObject の中、縦書きなど）は null。
 */
export async function matchBoxes(doc: SourceDoc, page: PageItem, run: TextRun, matches: Match[]): Promise<(Box | null)[] | null> {
  const perShow = await glyphsByShow(doc, page, run);
  if (!perShow) return null;
  const glyphs = perShow.flat();
  // 行の文字列と同じ並び（左から右）にする
  glyphs.sort((a, b) => a.x0 - b.x0);
  // そろえた文字ごとに、どの字形から来たか
  let gText = "";
  const gOf: number[] = [];
  glyphs.forEach((g, gi) => {
    const t = squash(g.text);
    for (let k = 0; k < t.length; k++) gOf.push(gi);
    gText += t;
  });
  // 行の文字列の各位置が、そろえた文字列の何文字目に当たるか
  let rText = "";
  const posAt: number[] = [];
  for (let i = 0; i < run.text.length; ) {
    const cp = run.text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    for (let k = 0; k < ch.length; k++) posAt.push(rText.length);
    rText += squash(ch);
    i += ch.length;
  }
  posAt.push(rText.length);
  // 0. 右から左に書く文字（アラビア系・ヘブライ）：字形は見た目の順（左→右）に並ぶ。
  // 行の文字列を字形から組み立てた行（語と字形の対応が決まっている）は、語の単位で範囲を求める。
  // そうでない行は、行の文字列を表示順に並べ替えてから対応を取る
  if (run.rtl) {
    const boxes = rtlWordBoxes(run, glyphs, matches);
    if (boxes) return boxes;
  }
  if (RTL_SCRIPT.test(run.text)) return rtlBoxes(run.text, glyphs, matches);
  // タイ文字の ำ：丸と า の間に声調記号が入る並び（ซ้ำ）では、字形の順（丸→声調→า）と文字の順（声調→丸→า）が入れ替わる。そろえてから比べる
  const amOrder = (t: string) => t.replace(/\u0e4d([\u0e48-\u0e4c])/g, "$1\u0e4d");
  // 何の字か分からない字形（U+FFFD）は、行の文字列では別の字に化けていることがある。その位置は何の字でも合うものとして比べる
  const sameText = (g: string, r: string) => {
    if (g === r) return true;
    if (g.length !== r.length || !g.includes("\ufffd")) return false;
    for (let i = 0; i < g.length; i++) if (g[i] !== r[i] && g[i] !== "\ufffd") return false;
    return true;
  };
  if (gText && sameText(amOrder(gText), amOrder(rText))) {
    return matches.map((m) => {
      const a = posAt[m.start];
      const b = posAt[m.end];
      if (b <= a) return null;
      const box = union(glyphs.slice(gOf[a], gOf[b - 1] + 1));
      return THAI.test(run.text.slice(m.start, m.end)) ? thaiAdjust(box) : box;
    });
  }
  // 2. 命令ごとに探す
  const found = new Map<string, Box[]>();
  const need = new Map<string, number>();
  const words = matches.map((m) => squash(run.text.slice(m.start, m.end)));
  for (const w of words) need.set(w, (need.get(w) ?? 0) + 1);
  for (const w of need.keys()) {
    if (!w) return null;
    const boxes: Box[] = [];
    for (const show of perShow) {
      let text = "";
      const of: number[] = [];
      show.forEach((g, gi) => {
        const t = squash(g.text);
        for (let k = 0; k < t.length; k++) of.push(gi);
        text += t;
      });
      for (let i = text.indexOf(w); i >= 0; i = text.indexOf(w, i + w.length)) boxes.push(union(show.slice(of[i], of[i + w.length - 1] + 1)));
    }
    if (boxes.length !== need.get(w)) return null;
    found.set(w, boxes.sort((p, q) => p.y - q.y || p.x - q.x));
  }
  const used = new Map<string, number>();
  return words.map((w) => {
    const k = used.get(w) ?? 0;
    used.set(w, k + 1);
    return found.get(w)![k] ?? null;
  });
}

/**
 * 位置を特定できなかった行を丸ごと墨消しするときの範囲。行の箱（表示用に推定したもの）ではなく、
 * その行を描いている文字描画命令それぞれの字形の範囲を返す（離れた文字が 1 行にまとめられていても取りこぼさない）。
 * 字形の位置が分からないフォントなら、行の箱 1 つを返す。
 */
export async function lineBoxes(doc: SourceDoc, page: PageItem, run: TextRun): Promise<Box[]> {
  const perShow = await glyphsByShow(doc, page, run).catch(() => null);
  const boxes = perShow?.filter((g) => g.length).map((g) => {
    const b = union(g);
    return { x: b.x - 0.5, y: b.y - 0.5, w: b.w + 1, h: b.h + 1 };
  });
  return boxes?.length ? boxes : [runBox(run)];
}

/** 位置を特定できないときに使う、行全体の範囲 */
export const runBox = (run: TextRun): Box => ({ x: run.x - 0.5, y: run.top - 0.5, w: run.w + 1, h: run.h + 1 });

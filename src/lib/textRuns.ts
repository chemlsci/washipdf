import { type FontFamily, pickFont } from "./fonts";
import { rtlLine } from "./rtl";
import { apply, multiply } from "./geometry";
import { tr } from "./i18n";
import { analyzePage, type PageAnalysis } from "./libDoc";
import { advanceReplacement, applyActualText, samePath, type ShowOp } from "./textOps";
import type { FontKey, Matrix, PageItem, SourceDoc } from "./types";

/**
 * 字の形が前後の字で変わる、または字形が見た目の順に並ぶ文字（アラビア系・ヘブライ、インド系、ラオス、チベット、ミャンマー、クメール）。
 * タイ文字は入れない：字形が読む順に並び、文字と 1 対 1 で対応する（実文書 10 件・1,442 行のうち 98％ で対応が取れた）ので、書き換えの対象にする
 */
export const COMPLEX_SCRIPT = /[\u0590-\u08ff\u0900-\u0dff\u0e80-\u0eff\u0f00-\u0fff\u1000-\u109f\u1780-\u17ff\ufb1d-\ufdff\ufe70-\ufeff]/;

/** 既存テキストの「ひとかたまり」（同じ行で近接している断片を結合したもの） */
export interface TextRun {
  id: string;
  text: string;
  /** 表示座標（pt、左上原点） */
  x: number;
  top: number;
  w: number;
  h: number;
  baseline: number;
  fontSize: number;
  /** 代替に使う同梱フォント（元フォント名とテキストから推定） */
  font: FontKey;
  /** 書体の系統（ゴシック＝sans／明朝＝serif） */
  family: FontFamily;
  /** 実編集できるか */
  editable: boolean;
  /** 実編集できない理由（ユーザー向け） */
  reason: string | null;
  /** 消す命令（index と命令名、置き換え文字列） */
  removals: { index: number; op: string; replacement: string; path?: number[] }[];
  /** 元フォント */
  srcFontName: string;
  fontResName: string | null;
  /** 元フォントで新しい文字を書けるか（M3） */
  originalFontUsable: boolean;
  /** 字形の並びのままの行（インド系の文字、何の字か分からない字形を含む行）。変えた語だけを書き直す方法でだけ書き換えられる */
  complex?: boolean;
  /**
   * 右から左へ書く文字（アラビア系・ヘブライ）を含む行の、行の向き。text は、字形から組み立てた「語を読む順に並べた文字列」。
   * 語の単位で書き換える
   */
  rtl?: "R" | "L";
  color: string | null;
  fillColorOps: string | null;
  strokeColorOps: string | null;
  renderMode: number;
  charSpacing: number;
  wordSpacing: number;
  hscale: number;
  /** 段落ブロック（同じ幅・行送りで続く行）の id。同じ値の行をまとめて編集できる */
  blockId: string | null;
  /** 段落ブロックの右端（表示座標）。短い行に字を足すとき、ここまでは広げてよい */
  blockRight?: number;
  /** 右から左の行で、字を足すとき、左へここまでは広げてよい（表示座標） */
  blockLeft?: number;
  /** 表示側（pdf.js）でのフォントの登録名。編集中の行を、埋め込みフォントそのもので画面に出すのに使う */
  previewFont?: string;
  /** ブロック内の行番号 */
  lineIndex: number;
  /** 縦書きの列（x,top,w,h は列の箱。text は上から下の文字） */
  vertical?: boolean;
}

export interface PageText {
  runs: TextRun[];
  /** ページ全体で実編集できない理由（暗号化など）。null なら個々の run の editable を見る */
  pageError: string | null;
}

interface Frag {
  str: string;
  x: number;
  right: number;
  baseline: number;
  fs: number;
  ascent: number;
  descent: number;
  font: FontFamily;
  /** 表示側（pdf.js）でのフォントの登録名 */
  pdfFont?: string;
}

interface DispOp {
  show: ShowOp;
  x0: number;
  x1: number; // 不明なら Infinity
  baseline: number;
  fs: number;
  horizontal: boolean;
}

/** 縦書きの断片（pdf.js は列の上端中央を原点、height を送り量の合計として返す） */
interface VFrag {
  str: string;
  x: number;
  top: number;
  len: number;
  fs: number;
  font: FontFamily;
}

/** 縦書きの命令（列の上端中央と下端） */
interface VOp {
  show: ShowOp;
  x: number;
  y0: number;
  y1: number;
  fs: number;
}

const isWide = (s: string) => /[^\u0000-ɏ]/.test(s);

/** 康熙部首などの「見た目は漢字だが別の文字」を通常の漢字に直す（Word等のPDFでよくある） */
const fixRadicals = (s: string) => s.replace(/[⺀-⿟]/g, (c) => c.normalize("NFKC"));

const cache = new Map<string, Promise<PageText>>();

/** 言語を切り替えたときなど、文言を含む解析結果を作り直す */
export function clearPageTextCache(): void {
  cache.clear();
}

export function getPageText(doc: SourceDoc, page: PageItem): Promise<PageText> {
  const key = `${doc.id}:${page.srcIndex}`;
  let p = cache.get(key);
  if (!p) {
    p = extract(doc, page);
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}

/** フォント名から、代替に使う書体の系統（ゴシック＝sans／明朝＝serif）を推定する */
export function familyForName(name: string, pdfjsFamily = ""): FontFamily {
  const n = (name + " " + pdfjsFamily).toLowerCase().replace(/\s/g, "");
  if (/sans|gothic|ゴシック|arial|helvetica|meiryo|メイリオ|yugo|hiragino(kaku|sans)|noto(sans)?jp|sourcehansans|verdana|segoe|calibri/.test(n)) return "sans";
  // 非埋め込みの和文フォント名（MS 明朝、游明朝、ヒラギノ明朝、小塚明朝、HG 明朝、IPA 明朝 など）は明朝に寄せる
  if (/mincho|明朝|serif|times|georgia|garamond|roman|yumin|hiraginomin|heiseimin|song|ming|ryumin|ipamin|ipaexm|kozmin|hgs?mincho|hgp?mincho|bookman|century|cambria|palatino/.test(n)) return "serif";
  return "sans";
}

/** フォント名とテキストから、代替に使う同梱フォントを選ぶ */
export function fontKeyForName(name: string, pdfjsFamily: string, text = ""): FontKey {
  return pickFont(familyForName(name, pdfjsFamily), text);
}

async function extract(doc: SourceDoc, page: PageItem): Promise<PageText> {
  const pdfPage = await doc.pdf.getPage(page.srcIndex + 1);
  const content = await pdfPage.getTextContent({ disableNormalization: false });
  const analysis = await analyzePage(doc, page.srcIndex);
  const vt = page.viewTransform;
  const frags: Frag[] = [];
  const vfrags: VFrag[] = [];

  for (const it of content.items) {
    if (!("str" in it)) continue;
    const str = fixRadicals(it.str);
    if (!str || !str.trim()) continue;
    const style = content.styles[it.fontName];
    const tx = multiply(vt, it.transform as Matrix);
    if (style?.vertical) {
      const vfs = Math.hypot(tx[2], tx[3]);
      if (vfs >= 1 && Math.abs(tx[1]) <= 0.01 * Math.abs(tx[0])) vfrags.push({ str, x: tx[4], top: tx[5], len: it.height * (vfs / (Math.hypot(it.transform[2], it.transform[3]) || 1)), fs: vfs, font: familyForName("", style?.fontFamily || "") });
      continue;
    }
    // 表示上で水平なテキストのみ扱う
    if (Math.abs(tx[1]) > 0.01 * Math.abs(tx[0]) || tx[0] <= 0) continue;
    const fs = Math.hypot(tx[2], tx[3]);
    if (fs < 1) continue;
    const ascent = style?.ascent && style.ascent > 0.3 ? Math.min(style.ascent, 1.1) : 0.88;
    const descent = style?.descent && style.descent < 0 ? Math.max(style.descent, -0.4) : -0.12;
    const family = style?.fontFamily || "";
    const font = familyForName("", family);
    const width = it.width > 0 ? it.width : fs * str.length * 0.5;
    // 同じ文字を同じ位置（またはごくわずかにずらした位置）に重ねて描いた 2 回目以降は、文字列に入れない。
    // 太字に見せるための重ね書きや、輪郭と塗りを別々に描く PDF で、行の文字列が「総総総総務務務務…」のようになるのを防ぐ
    // （描いている命令は、どれもその行の命令として残る＝書き換え・墨消しでは全部が対象になる）
    const near = Math.max(0.6, fs * 0.08);
    if (frags.some((g) => g.str === str && Math.abs(g.x - tx[4]) < near && Math.abs(g.baseline - tx[5]) < near && Math.abs(g.fs - fs) < fs * 0.05)) continue;
    frags.push({ str, x: tx[4], right: tx[4] + width, baseline: tx[5], fs, ascent, descent, font, pdfFont: it.fontName });
  }

  // 命令を表示座標に変換
  const dops: DispOp[] = [];
  const vops: VOp[] = [];
  for (const s of analysis.shows) {
    const t = multiply(vt, s.trm);
    if (s.font?.vertical) {
      const [x, y0] = apply(vt, s.start[0], s.start[1]);
      const y1 = s.end ? apply(vt, s.end[0], s.end[1])[1] : Infinity;
      vops.push({ show: s, x, y0, y1, fs: Math.hypot(t[2], t[3]) * (s.size || 1) || 1 });
      continue;
    }
    const dirX = t[0];
    const dirY = t[1];
    const horizontal = dirX > 0 && Math.abs(dirY) <= 0.01 * Math.abs(dirX);
    const fs = Math.hypot(t[2], t[3]) * (s.size || 1);
    const [x0, y0] = apply(vt, s.start[0], s.start[1]);
    // 終点が始点より左にある命令（字を書いたあと大きく戻す：約物を半角幅に詰める Word の出力など）でも、字のある範囲を持たせる
    const x1 = s.end ? Math.max(apply(vt, s.end[0], s.end[1])[0], x0 + (fs || 1) * 0.3) : Infinity;
    dops.push({ show: s, x0, x1, baseline: y0, fs: fs || 1, horizontal });
  }
  // 字形の部品（アラビア文字の点を、点のない字と別の字形で描く PDF。点は文字としては取り出せず、同じ字の本体と一緒に
  // 「代わりの文字」の囲みに入っている）は、字の上下にずれた高さに置かれる。その高さのままだと、行の並べ替えが乱れて
  // 1 行が 2 つに分かれたり、点だけの小さな行（上書きのみ）ができたりして、書き換えた行に点が取り残される。
  // 同じ囲みの本体と同じ高さにあるものとして扱う
  const pieceText = (t: string) => !t.replace(/[\p{Cc}\p{Cf}\uFFFD\s]/gu, "");
  const bodyOf = new Map<string, DispOp>();
  for (const d of dops) if (d.horizontal && d.show.actual && !pieceText(d.show.text)) bodyOf.set(`${d.show.path.join("/")}#${d.show.actual.id}`, d);
  const snapped = new Map<DispOp, number>();
  for (const d of dops) {
    if (!d.horizontal || !d.show.actual || !pieceText(d.show.text)) continue;
    const body = bodyOf.get(`${d.show.path.join("/")}#${d.show.actual.id}`);
    if (!body || Math.abs(body.baseline - d.baseline) > Math.max(body.fs, d.fs)) continue;
    snapped.set(d, d.baseline);
    d.baseline = body.baseline;
  }
  // 表示側の断片（部品は意味のない記号として取り出される）も、描いた部品の本体の高さにそろえる
  if (snapped.size) {
    for (const f of frags) {
      let best: DispOp | null = null;
      for (const [d, y] of snapped) {
        const tol = Math.max(f.fs, d.fs) * 0.35;
        if (Math.abs(y - f.baseline) < Math.min(tol, 1) && Math.abs(f.x - d.x0) < tol && (!best || Math.abs(f.x - d.x0) < Math.abs(f.x - best.x0))) best = d;
      }
      if (best) f.baseline = best.baseline;
    }
  }

  // 複数の行が同じ x から始まる位置（段組み・表の列の左端）か
  const hops = dops.filter((d) => d.horizontal);
  const isColumnStart = (x: number) => {
    const bases = new Set<number>();
    for (const d of hops) if (Math.abs(d.x0 - x) < 1) bases.add(Math.round(d.baseline));
    return bases.size >= 2;
  };

  // 各断片がどの命令から描かれたか（開始位置が範囲に入る最も近い命令）
  const opOfFrag = (f: Frag): DispOp | null => {
    let best: DispOp | null = null;
    let bestD = Infinity;
    for (const d of dops) {
      if (!d.horizontal) continue;
      const tol = Math.max(f.fs, d.fs) * 0.35;
      if (Math.abs(d.baseline - f.baseline) > tol) continue;
      if (d.show.clipped && Math.abs(f.fs - d.fs) > Math.max(f.fs, d.fs) * 0.3) continue;
      if (f.x < d.x0 - tol || f.x > d.x1 + tol) continue;
      const dist = Math.abs(f.x - d.x0);
      if (dist < bestD) {
        bestD = dist;
        best = d;
      }
    }
    return best;
  };

  // ページ全体の向き：右から左へ書く字が、欧文の字以上にあれば右から左（1 行ごとの向きを決めるときの手がかりにする）
  let rtlLetters = 0;
  let ltrLetters = 0;
  for (const f of frags) for (const ch of f.str) (RTL.test(ch) ? rtlLetters++ : /\p{L}/u.test(ch) ? ltrLetters++ : 0);
  const prior: "R" | "L" = rtlLetters > 0 && rtlLetters >= ltrLetters ? "R" : "L";

  // 行ごと → 左から右に並べて近いものを結合
  frags.sort((a, b) => (Math.abs(a.baseline - b.baseline) > a.fs * 0.3 ? a.baseline - b.baseline : a.x - b.x));
  type Line = Frag & { text: string; lastOp: DispOp | null; fsWidth: number };
  const lines: Line[] = [];
  let cur: Line | null = null;
  const flush = () => {
    if (cur) lines.push(cur);
    cur = null;
  };
  for (const f of frags) {
    const op = opOfFrag(f);
    if (cur) {
      const sameLine = Math.abs(f.baseline - cur.baseline) < cur.fs * 0.25;
      // 右から左へ書く文字の行では、語ごとに文字の大きさの違うフォントが混ざることがある（アラビア文字と欧文で大きさを変えて
      // 見た目をそろえる、書き換えた語を別のフォントで書いた 等）。1 行として読めるよう、大きさの違いを広めに認める
      const rtlish = RTL.test(cur.text) || RTL.test(f.str);
      const sameSize = Math.abs(f.fs - cur.fs) < (rtlish ? Math.max(cur.fs, f.fs) * 0.5 : cur.fs * 0.2);
      const gap = f.x - cur.right;
      // 別の BT ブロック（表の隣のセルなど）で、かつ隙間があるなら別の行として扱う
      // 隙間が小さくても、他の行もそこから始まる位置（列の左端）なら別の列とみなす
      // （右から左へ書く文字の行は、向きの変わる所ごとに別のブロックで書かれ、語の始まる位置が行どうしでそろいやすい。列の左端とはみなさない）
      const otherBlock =
        !!op && !!cur.lastOp && op !== cur.lastOp && op.show.bt !== cur.lastOp.show.bt && (gap > cur.fs * 0.5 || (!rtlish && gap > -cur.fs * 0.1 && isColumnStart(op.x0) && Math.abs(f.x - op.x0) < cur.fs * 0.2));
      if (sameLine && sameSize && gap > -cur.fs * 0.5 && gap < cur.fs * 1.2 && !otherBlock) {
        appendFrag(cur, f, gap);
        if (op) cur.lastOp = op;
        // 大きさの違う断片をまとめたときは、幅のいちばん広い断片の大きさを、行の文字の大きさとする
        if (rtlish && f.right - f.x > cur.fsWidth && Math.abs(f.fs - cur.fs) >= cur.fs * 0.05) {
          cur.fs = f.fs;
          cur.fsWidth = f.right - f.x;
          cur.pdfFont = f.pdfFont;
        }
        continue;
      }
      flush();
    }
    cur = { ...f, text: f.str, lastOp: op, fsWidth: f.right - f.x };
  }
  flush();

  // 行と命令の対応付け（1つの命令が複数行にまたがるなら行を結合する）
  const parent = lines.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[b] = a;
  };
  const lineOps = lines.map(() => [] as DispOp[]);
  for (const d of dops) {
    if (!d.horizontal) continue;
    // 空白だけの命令（セル末尾の空白など）は、隣の列と結合する原因になるので、一番近い行に付けるだけにする
    const blank = !d.show.text.trim();
    let first = -1;
    let nearest = -1;
    let nearestD = Infinity;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const tol = Math.max(l.fs, d.fs) * 0.35;
      if (Math.abs(l.baseline - d.baseline) > tol) continue;
      // 見えない文字（切り抜きの外）で、大きさも大きく違う命令は別の行（枠からあふれた小さな文字が、同じ高さに残っていることがある）。
      // 見えている文字は、大きさが違っても同じ行に入れる（見出しの「1040 (and …」のように、行の途中で大きさが変わることがある）
      if (d.show.clipped && Math.abs(l.fs - d.fs) > Math.max(l.fs, d.fs) * 0.3) continue;
      const ov = Math.min(l.right, d.x1 + tol * 0.5) - Math.max(l.x, d.x0 - tol * 0.5);
      if (ov <= 0) continue;
      if (blank) {
        const dist = Math.min(Math.abs(l.right - d.x0), Math.abs(l.x - d.x1));
        if (dist < nearestD) {
          nearestD = dist;
          nearest = i;
        }
        continue;
      }
      lineOps[i].push(d);
      if (first < 0) first = i;
      else union(first, i);
    }
    if (blank && nearest >= 0) lineOps[nearest].push(d);
  }
  const groups = new Map<number, number[]>();
  lines.forEach((_, i) => {
    const r = find(i);
    const g = groups.get(r) ?? [];
    g.push(i);
    groups.set(r, g);
  });

  const runs: TextRun[] = [];
  for (const idxs of groups.values()) {
    idxs.sort((a, b) => lines[a].x - lines[b].x);
    const merged: Line = { ...lines[idxs[0]] };
    for (const k of idxs.slice(1)) {
      const f = lines[k];
      appendFrag(merged, { ...f, str: f.text }, f.x - merged.right);
    }
    const opsSet = new Map<number, DispOp>();
    for (const k of idxs) for (const d of lineOps[k]) opsSet.set(d.show.index, d);
    const ops = [...opsSet.values()].sort((a, b) => a.show.index - b.show.index);
    // 見えている文字と、その見えない写し（同じ文を少しずらして置き、切り抜きで隠したもの）が 1 行にまとまっていることがある。
    // 別々の行にする：一緒に書き直すと、隠れていた写しまで見えるようになる（文字が二重になる）。
    // 見えない写しも行として残す（書き換えの対象にはならないが、語を探しての墨消しでは一緒に消せる）
    const visible = ops.filter((d) => !d.show.clipped);
    const hidden = ops.filter((d) => d.show.clipped);
    const flat = (list: DispOp[]) => list.map((d) => d.show.text).join("").replace(/\s+/g, "");
    if (visible.length && hidden.length && flat(visible) && flat(visible) === flat(hidden)) {
      const part = (list: DispOp[]): Line | null => {
        const x0 = Math.min(...list.map((d) => d.x0));
        const x1 = Math.max(...list.map((d) => d.x1));
        if (!Number.isFinite(x0) || !Number.isFinite(x1)) return null;
        // 字の間の空白は、字形の位置から補ったものを使う（文字が同じ場合だけ）。そうでなければ、命令の文字をそのままつなぐ
        const joined = list.map((d) => d.show.text).join("").trim();
        const spaced = overprintText(list, analysis, vt, merged.fs, true);
        const text = spaced && spaced.replace(/\s+/g, "") === flat(list) ? spaced : joined;
        return { ...merged, text, x: x0, right: x1 };
      };
      const v = part(visible);
      const h = part(hidden);
      if (v && h) {
        runs.push(makeRun(v, visible, analysis, runs.length, vt, page.width, prior));
        runs.push(makeRun(h, hidden, analysis, runs.length, vt, page.width, prior));
        continue;
      }
    }
    runs.push(makeRun(merged, ops, analysis, runs.length, vt, page.width, prior));
  }
  runs.sort((a, b) => (Math.abs(a.baseline - b.baseline) > Math.min(a.fontSize, b.fontSize) * 0.5 ? a.baseline - b.baseline : a.x - b.x));
  detectBlocks(runs);
  assignRoom(runs);
  // 縦書きの列：同じ x で縦に続く断片をまとめ、列の範囲に掛かる命令を対応付ける
  vfrags.sort((a, b) => (Math.abs(a.x - b.x) > Math.min(a.fs, b.fs) * 0.3 ? b.x - a.x : a.top - b.top));
  type Col = VFrag & { text: string };
  const cols: Col[] = [];
  let vcur: Col | null = null;
  for (const f of vfrags) {
    if (vcur && Math.abs(f.x - vcur.x) < vcur.fs * 0.3 && Math.abs(f.fs - vcur.fs) < vcur.fs * 0.2 && f.top - (vcur.top + vcur.len) < vcur.fs * 0.6 && f.top - (vcur.top + vcur.len) > -vcur.fs * 1.1) {
      // 重なりは 1 字分まで許す：「・」などの約物が半分の高さで組まれていると、表示側の断片は高さを 1 字分と数えるので、次の断片と半字ぶん重なる
      vcur.text += f.str;
      vcur.len = Math.max(vcur.len, f.top + f.len - vcur.top);
      continue;
    }
    vcur = { ...f, text: f.str };
    cols.push(vcur);
  }
  for (const c of cols) {
    const tol = c.fs * 0.6;
    const ops = vops
      .filter((d) => Math.abs(d.x - c.x) < tol && d.y1 > c.top - tol && d.y0 < c.top + c.len + tol)
      .sort((a, b) => a.show.index - b.show.index);
    runs.push(makeVerticalRun(c, ops, analysis, runs.length));
  }
  detectVerticalBlocks(runs.filter((r) => r.vertical));
  runs.forEach((r, i) => (r.id = `run_${i}`));
  return { runs: runs.filter((r) => r.text.length > 0), pageError: analysis.error };
}

function makeVerticalRun(c: { x: number; top: number; len: number; fs: number; text: string; font: FontFamily }, ops: VOp[], analysis: { error: string | null; usesForms: boolean }, n: number): TextRun {
  const main = ops.map((d) => d.show).sort((a, b) => b.text.length - a.text.length)[0] ?? null;
  let reason: string | null = null;
  if (analysis.error) reason = analysis.error;
  else if (!ops.length) reason = analysis.usesForms ? tr("reason.form") : tr("reason.noOp");
  else if (ops.every((d) => d.show.renderMode === 3)) reason = tr("reason.invisible");
  else if (ops.some((d) => d.show.renderMode >= 4)) reason = tr("reason.clip");
  const srcFontName = main?.font?.baseFont ?? "";
  const text = c.text.replace(/\s+$/, "");
  const family: FontFamily = main?.font?.serifLike ? "serif" : srcFontName ? familyForName(srcFontName) : c.font;
  return {
    id: `run_${n}`,
    text,
    x: c.x - c.fs / 2,
    top: c.top,
    w: c.fs,
    h: c.len,
    baseline: c.top,
    fontSize: c.fs,
    font: pickFont(family, text),
    family,
    editable: reason === null,
    reason,
    removals: ops.map((d) => ({ index: d.show.index, op: d.show.op, replacement: "", path: d.show.path })),
    srcFontName,
    fontResName: main?.fontResName ?? null,
    originalFontUsable: !!main?.font && [...text].every((ch) => /\s/.test(ch) || main!.font!.encode(ch.codePointAt(0)!) !== null),
    color: main?.fillRgb ? toHex(main.fillRgb) : null,
    fillColorOps: main?.fillColorOps ?? null,
    strokeColorOps: main?.strokeColorOps ?? null,
    renderMode: main?.renderMode ?? 0,
    charSpacing: 0,
    wordSpacing: 0,
    hscale: 1,
    blockId: null,
    lineIndex: 0,
    vertical: true,
  };
}

function appendFrag(cur: Frag & { text: string }, f: Frag, gap: number) {
  const wide = isWide(cur.text.slice(-1)) || isWide(f.str[0]);
  const spaced = /\s$/.test(cur.text) || /^\s/.test(f.str);
  // 欧文は小さな隙間で半角スペース、和文は1文字分近い隙間で全角スペースを補う
  const sep = spaced ? "" : !wide && gap > cur.fs * 0.2 ? " " : wide && gap > cur.fs * 0.6 ? "　" : "";
  cur.text += sep + f.str;
  cur.right = Math.max(cur.right, f.right);
  cur.ascent = Math.max(cur.ascent, f.ascent);
  cur.descent = Math.min(cur.descent, f.descent);
}

function toHex(c: [number, number, number]): string {
  return "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
}

/** 行を描いている命令の字形を、文字と表示上の位置つきで並べる。位置や文字が分からないフォントがあれば null */
function lineGlyphs(ops: DispOp[], analysis: PageAnalysis, vt: Matrix): { ch: string; x: number; y: number; w: number; show: ShowOp }[] | null {
  const all: { ch: string; x: number; y: number; w: number; show: ShowOp; raw: string | null }[] = [];
  for (const d of ops) {
    const s = d.show;
    const font = s.font;
    const list = s.path.length ? analysis.forms.find((f) => samePath(f.path, s.path))?.ops : analysis.ops;
    const op = list?.[s.index];
    if (!op || !font || !font.widthsKnown || !s.size || !s.hscale || font.vertical) return null;
    const a = op.operands;
    const items = op.op === '"' ? (a[2] ? [a[2]] : []) : op.op === "TJ" ? (a[0]?.kind === "array" ? a[0].items : []) : a[0] ? [a[0]] : [];
    const m = multiply(vt, s.trm);
    let pos = 0;
    for (const it of items) {
      if (it.kind === "num") {
        pos -= (it.value / 1000) * s.size * s.hscale;
        continue;
      }
      if (it.kind !== "string") continue;
      for (const c of font.decode(it.bytes)) {
        const tx = ((font.width(c) / 1000) * s.size + s.charSpacing + (c.isSpace ? s.wordSpacing : 0)) * s.hscale;
        const ch = font.toUnicode(c);
        const [x, y] = apply(m, pos, 0);
        const [x1] = apply(m, pos + tx, 0);
        all.push({ ch: ch ?? "", raw: ch ?? null, x, y, w: x1 - x, show: s });
        pos += tx;
      }
    }
  }
  // 1 つの字を複数の字形（本体と点など）で描き、本当の文字を「代わりの文字」で与えている文書（LibreOffice など）
  applyActualText(
    all,
    (g) => g.w,
    (g) => g.raw,
    (g, text) => (g.ch = g.raw = text),
  );
  if (all.some((g) => g.raw == null || g.raw.includes("\uFFFD"))) return null;
  return all;
}

/**
 * 右から左へ書く文字の行を、字形から「語」と「読む順の文字列」に組み立てる（rtl.ts）。
 * 同じ字を同じ位置に重ねて描いたもの（影・太く見せる重ね書き）は 1 つとして数える（保存側 anchoredEdit と同じ基準）。
 * 字形の文字や位置が分からない行は null
 */
function rtlText(text: string, ops: DispOp[], analysis: PageAnalysis, vt: Matrix, fs: number, pageWidth: number, prior: "R" | "L"): { text: string; base: "R" | "L" } | null {
  const all = lineGlyphs(ops, analysis, vt);
  if (!all) return null;
  const sq = (t: string) => t.normalize("NFKC").replace(/[\s\u0000-\u001f\u007f]+/g, "");
  const kept: { text: string; sq: string; x0: number; x1: number; y: number; show: ShowOp }[] = [];
  const input: { text: string; x0: number; x1: number }[] = [];
  const list = all.map((g, order) => ({ text: g.ch, sq: sq(g.ch), x0: g.x, x1: g.x + g.w, y: g.y, show: g.show, order }));
  // ページの外にはみ出している字は、行の文字列に入れない
  const on = list.filter((g) => !(g.x1 < -0.5 || g.x0 > pageWidth + 0.5));
  for (const g of on.filter((x) => x.sq).sort((p, q) => p.x0 - q.x0 || p.order - q.order)) {
    const tol = Math.max(0.6, Math.abs(g.x1 - g.x0) * 0.12, fs * 0.03);
    if (kept.slice(-6).some((p) => p.show !== g.show && p.sq === g.sq && Math.abs(p.x0 - g.x0) < tol && Math.abs(p.y - g.y) < tol)) continue;
    kept.push(g);
  }
  input.push(...kept, ...on.filter((x) => !x.sq));
  const rl = rtlLine(input, fs, text.trim().split(/\s+/).length, { prior });
  return rl ? { text: rl.text, base: rl.base } : null;
}

/**
 * タイ文字の「ำ」を補う。「丸（ニッカヒット）＋ า」に分けて描かれ、丸に文字として空白が割り当てられている文書では、
 * 表示側から得た文字列で丸が抜けて「า」だけになる（丸のあった所に空白が入ることもある）。
 * 字形の位置を見て、丸のすぐそばにある「า」を見つけ、行の文字列の中の同じ順番の「า」を「ำ」に直す。
 * 「า」の数が字形と文字列で合わない行は、そのまま返す（別の「า」を取り違えると、ำ でない語を ำ にしてしまう）。
 */
function restoreSaraAm(text: string, ops: DispOp[], analysis: PageAnalysis, vt: Matrix, fs: number): string {
  if (!text.includes("\u0e32") || !ops.some((d) => d.show.text.includes("\u0e4d"))) return text;
  const glyphs = lineGlyphs(ops, analysis, vt);
  if (!glyphs) return text;
  const aas = glyphs.filter((g) => g.ch === "\u0e32").sort((p, q) => p.x - q.x);
  const marked = new Set<number>();
  for (const n of glyphs) {
    if (n.ch !== "\u0e4d") continue;
    // 丸は、対になる า の左肩に描かれる
    let best = -1;
    for (let i = 0; i < aas.length; i++) {
      const dx = aas[i].x - n.x;
      if (Math.abs(aas[i].y - n.y) > fs * 0.3 || dx < -fs * 0.25 || dx > fs * 0.7) continue;
      if (best < 0 || Math.abs(dx) < Math.abs(aas[best].x - n.x)) best = i;
    }
    if (best < 0) return text;
    marked.add(best);
  }
  const inText = [...text].filter((ch) => ch === "\u0e32").length;
  if (!marked.size || inText !== aas.length) return text;
  let k = 0;
  let out = "";
  for (const ch of text) {
    if (ch !== "\u0e32") {
      out += ch;
      continue;
    }
    // 丸が空白として入っていたら、その空白は捨てる。丸そのもの（ํ）が文字列に入っている文書では、二重にならないよう取り除く
    if (marked.has(k)) out = out.replace(/[ \u00a0]+$/, "").replace(/\u0e4d([\u0e48-\u0e4c]?)$/, "$1") + "\u0e33";
    else out += ch;
    k++;
  }
  return out;
}

/**
 * 同じ字を同じ位置に重ねて描いている行（太字に見せるために 2〜4 回重ねる古い出力など）の、1 回分の文字列を作る。
 * 表示側から得た文字列は、重ねた分が入り交じって「平成平成 22 42244 年…」のようになるので、字形の位置から組み直す。
 * 重ね書きが無い行、字形の位置や文字が分からないフォントの行では null（表示側の文字列をそのまま使う）。
 */
function overprintText(ops: DispOp[], analysis: PageAnalysis, vt: Matrix, fs: number, force = false): string | null {
  const near = Math.max(0.6, fs * 0.08);
  const stacked = ops.some((d, i) => ops.some((e, j) => j > i && Math.abs(e.x0 - d.x0) < near && Math.abs(e.baseline - d.baseline) < near && e.show.text.trim() && e.show.text[0] === d.show.text[0]));
  if (!stacked && !force) return null;
  const all: { ch: string; x: number; y: number; w: number }[] = [];
  for (const d of ops) {
    const s = d.show;
    const font = s.font;
    const list = s.path.length ? analysis.forms.find((f) => samePath(f.path, s.path))?.ops : analysis.ops;
    const op = list?.[s.index];
    if (!op || !font || !font.widthsKnown || !s.size || !s.hscale || font.vertical) return null;
    const a = op.operands;
    const items = op.op === '"' ? (a[2] ? [a[2]] : []) : op.op === "TJ" ? (a[0]?.kind === "array" ? a[0].items : []) : a[0] ? [a[0]] : [];
    const m = multiply(vt, s.trm);
    let pos = 0;
    for (const it of items) {
      if (it.kind === "num") {
        pos -= (it.value / 1000) * s.size * s.hscale;
        continue;
      }
      if (it.kind !== "string") continue;
      for (const c of font.decode(it.bytes)) {
        const tx = ((font.width(c) / 1000) * s.size + s.charSpacing + (c.isSpace ? s.wordSpacing : 0)) * s.hscale;
        const ch = font.toUnicode(c);
        if (ch == null || ch.includes("\uFFFD")) return null;
        const [x, y] = apply(m, pos, 0);
        const [x1] = apply(m, pos + tx, 0);
        all.push({ ch, x, y, w: x1 - x });
        pos += tx;
      }
    }
  }
  all.sort((p, q) => p.x - q.x);
  const kept: typeof all = [];
  let dropped = 0;
  for (const g of all) {
    // 幅の狭い字・幅 0 の記号（タイ文字の母音・声調記号）でも、影付き文字のずれ（文字の大きさの数 %）を同じ位置とみなす
    const tol = Math.max(0.6, Math.abs(g.w) * 0.12, fs * 0.03);
    if (kept.slice(-6).some((k) => k.ch === g.ch && Math.abs(k.x - g.x) < tol && Math.abs(k.y - g.y) < tol)) dropped++;
    else kept.push(g);
  }
  if (!dropped && !force) return null;
  // 欧文どうしの間が広く空いている所にだけ空白を補う（字間を広げた和文の見出しには入れない）
  const gaps = kept.slice(1).map((g, i) => g.x - (kept[i].x + kept[i].w)).sort((p, q) => p - q);
  const typical = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
  const latin = (c: string) => /[\u0021-\u024f]/.test(c);
  let out = "";
  kept.forEach((g, i) => {
    const prev = kept[i - 1];
    if (prev && latin(prev.ch) && latin(g.ch) && g.x - (prev.x + prev.w) > Math.max(fs * 0.25, typical * 2) && !/\s$/.test(out)) out += " ";
    out += /^\s+$/.test(g.ch) ? (/\s$/.test(out) || !out ? "" : g.ch[0]) : g.ch;
  });
  return out.trim() || null;
}

/**
 * 行の文字列の U+FFFD を、描画命令から読んだ文字列の同じ位置の字で置き換える。
 * 空白を除いた字数が同じで、U+FFFD 以外の字がすべて一致するときだけ（順番や字数が違う行は、そのまま返す）。
 */
function repairUnknown(text: string, fromOps: string): string {
  const b = [...fromOps].filter((ch) => !/\s/.test(ch));
  let j = 0;
  const out: string[] = [];
  for (const ch of text) {
    if (/\s/.test(ch)) {
      out.push(ch);
      continue;
    }
    const g = b[j++];
    if (g === undefined) return text;
    if (ch === "\ufffd") {
      // 上下に付く記号の前に、表示側が入れた空白があれば取り除く（記号は前の字に付くもので、空白の後には来ない）
      if (/^[\u0e31\u0e34-\u0e3a\u0e47-\u0e4e]$/.test(g)) while (out.length && /\s/.test(out[out.length - 1])) out.pop();
      out.push(g);
    } else if (ch.normalize("NFKC") !== g.normalize("NFKC")) return text;
    else out.push(ch);
  }
  return j === b.length ? out.join("") : text;
}

/** 字形の並び替えが大きく、語単位の書き換えでも対応が取れない文字（ラオス、チベット、ミャンマー、クメール）。上書きのみ */
const UNTESTED = /[\u0e80-\u0fff\u1000-\u109f\u1780-\u17ff]/;
/** 右から左へ書く文字（ヘブライ、アラビア系とその表示形） */
const RTL = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;

function makeRun(l: Frag & { text: string }, ops: DispOp[], analysis: PageAnalysis, n: number, vt: Matrix, pageWidth = Infinity, prior: "R" | "L" = "L"): TextRun {
  const top = l.baseline - l.ascent * l.fs;
  const bottom = l.baseline - l.descent * l.fs;
  // 主となる命令（進み量が最大のもの）
  let main: ShowOp | null = null;
  let best = -1;
  for (const d of ops) {
    const w = d.x1 === Infinity ? d.show.text.length * d.fs * 0.5 : d.x1 - d.x0;
    if (w > best) {
      best = w;
      main = d.show;
    }
  }
  // 表示側の文字列で「何の字か分からない」（U+FFFD）になっている字を、字形から求めた字で補う（タイ文字の記号）
  if (l.text.includes("\ufffd")) l = { ...l, text: repairUnknown(l.text, ops.map((d) => d.show.text).join("")) };
  // 和文の字の間の隙間から補った全角スペース：元の命令に全角スペースが無く、半角スペースがあれば、半角スペースにする
  // （字幅の分からないフォントでは半角スペースの幅が 1 字分に見え、書き換えると全角スペースに変わってしまう）
  if (l.text.includes("\u3000")) {
    const raw = ops.map((d) => d.show.text).join("");
    if (!raw.includes("\u3000") && raw.includes(" ")) l = { ...l, text: l.text.replace(/\u3000/g, " ") };
  }
  let reason: string | null = null;
  let complex = false;
  /** 右から左の行の、読む順の文字列と行の向き（組み立てられたとき） */
  let rtl: { text: string; base: "R" | "L" } | null = null;
  if (analysis.error) reason = analysis.error;
  else if (!ops.length) reason = analysis.usesForms ? tr("reason.form") : tr("reason.noOp");
  else if (ops.every((d) => d.show.renderMode === 3)) reason = tr("reason.invisible");
  else if (ops.some((d) => d.show.renderMode >= 4)) reason = tr("reason.clip");
  // 切り抜きの外にあって表示されない文字：書き換えると見えるようになってしまうので、書き換えの対象にしない（墨消しはできる）
  else if (ops.every((d) => d.show.clipped)) reason = tr("reason.invisible");
  // 字の形が前後の字で変わる・字形が見た目の順に並ぶ文字（アラビア系、インド系、クメールなど）：
  // 元のフォントで 1 字ずつ書き直すと、つながりが崩れたり字が欠けたりするので、書き換えの対象にしない（上書きはできる）
  // 何の字か分からない字形（対応表が無い・私用領域）を含む行も、同じ理由で書き換えない（どの字を書けばよいか決められない）
  // 行の文字列だけでなく、行を描いている命令の文字も見る（欧文の語だけが別の行として切り出されていても、命令は周りの字と一緒のことがある）
  // ただし、字が左から右へ並ぶインド系の文字と、何の字か分からない字形を含むだけの行は、変えた語だけを同梱フォントで書き、ほかの字形を元のまま残す方法でなら
  // 書き換えられる（complex）。右から左へ書く文字（アラビア系、ヘブライ）は、文字列と字形の順が逆で対応が取れないので、上書きのみ
  else if ([l.text, ...ops.map((d) => d.show.text)].some((x) => COMPLEX_SCRIPT.test(x) || /[\ufffd\ue000-\uf8ff]/.test(x))) {
    // 何の字か分からない字形ばかりの行（文字の対応を持たないフォントで、行の文字列がほとんど読めない）も、上書きのみ
    const all = [...ops.map((d) => d.show.text).join("")].filter((ch) => !/\s/.test(ch));
    const unknown = all.filter((ch) => /[\ufffd\ue000-\uf8ff]/.test(ch)).length;
    const unreadable = !COMPLEX_SCRIPT.test(l.text) && unknown > all.length * 0.5;
    const texts = [l.text, ...ops.map((d) => d.show.text)];
    if (unreadable || texts.some((x) => UNTESTED.test(x)) || ops.some((d) => d.show.path.length > 0)) reason = tr("reason.complexScript");
    else if (texts.some((x) => RTL.test(x))) {
      // 右から左へ書く文字：字形から語と読む順の文字列を組み立てられた行は、語の単位で書き換えられる
      rtl = rtlText(l.text, ops, analysis, vt, l.fs, pageWidth, prior);
      if (!rtl?.text) reason = tr("reason.complexScript");
      else complex = true;
    } else complex = true;
  }
  const srcFontName = main?.font?.baseFont ?? "";
  let text = l.text.replace(/\s+$/, "");
  // 同じ文字を同じ位置に 2 度描いている行（輪郭と塗りを別々に描く、太く見せる など）は、文字列が 2 回分になる。1 回分に直す
  const twice = ops.some((d, i) => ops.some((e, j) => j > i && e.show.text === d.show.text && Math.abs(e.show.start[0] - d.show.start[0]) < 0.5 && Math.abs(e.show.start[1] - d.show.start[1]) < 0.5));
  text = restoreSaraAm(text, ops, analysis, vt, l.fs);
  const single = complex && rtl ? null : overprintText(ops, analysis, vt, l.fs);
  if (complex && rtl) text = rtl.text;
  else if (single) text = single;
  else if (twice) {
    // 2 回とは限らない（ページ番号を 3 回重ねている文書がある）
    for (let k = Math.min(4, ops.length); k >= 2; k--) {
      for (const sep of ["", " "]) {
        const n = (text.length - sep.length * (k - 1)) / k;
        if (Number.isInteger(n) && n > 0 && text === Array.from({ length: k }, () => text.slice(0, n)).join(sep)) {
          text = text.slice(0, n);
          k = 0;
          break;
        }
      }
    }
  }
  const family: FontFamily = main?.font?.serifLike ? "serif" : srcFontName ? familyForName(srcFontName) : l.font;
  const font: FontKey = pickFont(family, text);
  // 書き換えられない行（上から重ねて隠す行）は、行の範囲を、描いている命令の字のある範囲まで広げる。
  // 文字の対応が読めないフォントでは、表示側から得た断片の幅が実際より狭いことがあり、そのままでは元の字が隠し切れずに残る
  let boxX = l.x;
  let boxRight = l.right;
  if (reason !== null) {
    for (const d of ops) {
      if (!d.horizontal || d.x1 === Infinity || d.show.clipped) continue;
      boxX = Math.min(boxX, d.x0);
      boxRight = Math.max(boxRight, d.x1);
    }
    boxX = Math.max(0, boxX);
    boxRight = Math.min(pageWidth, boxRight);
  }
  return {
    id: `run_${n}`,
    text,
    x: boxX,
    top,
    w: boxRight - boxX,
    h: bottom - top,
    baseline: l.baseline,
    fontSize: l.fs,
    font,
    family,
    editable: reason === null,
    reason,
    removals: ops.map((d) => ({ index: d.show.index, op: d.show.op, replacement: advanceReplacement(d.show), path: d.show.path })),
    srcFontName,
    fontResName: main?.fontResName ?? null,
    previewFont: l.pdfFont,
    // 元のフォントで書き直せるか：行の字がどれも、その行を描いているフォントのどれかで書けること。
    // 1 行に複数のフォントが混ざる（記号だけ別フォント、太字が混ざる など）とき、変えていない字は元の字形のまま残すので、
    // 主なフォントだけで全部を書ける必要はない（変えた部分は、保存時に主なフォントで書けるかを確かめる）
    // （タイ文字の ำ は、丸と า の 2 つの字形で書けるフォントなら書ける）
    complex,
    rtl: complex && rtl ? rtl.base : undefined,
    originalFontUsable:
      !!main?.font &&
      (complex || [...text].every((ch) => /\s/.test(ch) || ops.some((d) => d.show.font?.encode(ch.codePointAt(0)!) != null || (ch === "\u0e33" && d.show.font?.encode(0x0e4d) != null && d.show.font?.encode(0x0e32) != null)))),
    color: main?.fillRgb ? toHex(main.fillRgb) : null,
    fillColorOps: main?.fillColorOps ?? null,
    strokeColorOps: main?.strokeColorOps ?? null,
    renderMode: main?.renderMode ?? 0,
    charSpacing: main?.charSpacing ?? 0,
    wordSpacing: main?.wordSpacing ?? 0,
    hscale: main?.hscale ?? 1,
    blockId: null,
    lineIndex: 0,
  };
}

/**
 * 段落ブロックの検出：同じ文字サイズで、行送りがほぼ一定、左端（または右端）がそろっている連続行をまとめる。
 * 箱内リフローの「箱」の高さ（行数）を決めるために使う。
 */
function detectBlocks(runs: TextRun[]) {
  let blockNo = 0;
  const assigned = new Set<string>();
  for (const first of runs) {
    // 字形の並びのままの行（語単位でだけ書き換えられる行）は、段落にまとめない：段落の流し込みは、行を丸ごと組み直すので使えない
    if (assigned.has(first.id) || first.complex) continue;
    const members = [first];
    let pitch = 0;
    for (;;) {
      const prev = members[members.length - 1];
      // prev より下にある行のうち、左端（または右端）がそろい、行送りが一定のものを探す（段組みでは間に他の列の行が挟まる）
      let next: TextRun | null = null;
      for (const r of runs) {
        if (assigned.has(r.id) || members.includes(r)) continue;
        const dy = r.baseline - prev.baseline;
        if (dy <= prev.fontSize * 0.5) continue;
        if (dy > prev.fontSize * 2.2) continue;
        const sameSize = Math.abs(r.fontSize - prev.fontSize) < prev.fontSize * 0.05;
        const leftAligned = Math.abs(r.x - first.x) < first.fontSize * 0.6;
        const rightAligned = Math.abs(r.x + r.w - (first.x + first.w)) < first.fontSize * 0.6;
        const okPitch = dy > prev.fontSize * 0.8 && (pitch === 0 || Math.abs(dy - pitch) < pitch * 0.1);
        if (!sameSize || !okPitch || !(leftAligned || rightAligned) || r.editable !== first.editable || r.complex) continue;
        if (!next || r.baseline < next.baseline) next = r;
      }
      if (!next) break;
      if (pitch === 0) pitch = next.baseline - prev.baseline;
      members.push(next);
    }
    if (members.length > 1) {
      const id = `blk_${blockNo++}`;
      const blockRight = Math.max(...members.map((m) => m.x + m.w));
      members.forEach((m, k) => {
        m.blockRight = blockRight;
        m.blockId = id;
        m.lineIndex = k;
        assigned.add(m.id);
      });
    }
  }
}

/**
 * 縦書きの段落ブロック：同じ文字サイズで、列の間隔がほぼ一定、上端（または下端）がそろっている列を右から左へまとめる。
 * lineIndex 0 が右端の列。
 */
function detectVerticalBlocks(cols: TextRun[]) {
  let blockNo = 0;
  const assigned = new Set<string>();
  const sorted = [...cols].sort((a, b) => b.x - a.x);
  for (const first of sorted) {
    if (assigned.has(first.id)) continue;
    const members = [first];
    let pitch = 0;
    for (;;) {
      const prev = members[members.length - 1];
      let next: TextRun | null = null;
      for (const r of sorted) {
        if (assigned.has(r.id) || members.includes(r)) continue;
        const dx = prev.x - r.x;
        if (dx <= prev.fontSize * 0.8 || dx > prev.fontSize * 2.5) continue;
        const sameSize = Math.abs(r.fontSize - prev.fontSize) < prev.fontSize * 0.05;
        const topAligned = Math.abs(r.top - first.top) < first.fontSize * 0.6;
        const bottomAligned = Math.abs(r.top + r.h - (first.top + first.h)) < first.fontSize * 0.6;
        const okPitch = pitch === 0 || Math.abs(dx - pitch) < pitch * 0.1;
        if (!sameSize || !okPitch || !(topAligned || bottomAligned) || r.editable !== first.editable) continue;
        if (!next || r.x > next.x) next = r;
      }
      if (!next) break;
      if (pitch === 0) pitch = prev.x - next.x;
      members.push(next);
    }
    if (members.length > 1) {
      const id = `vblk_${blockNo++}`;
      members.forEach((m, k) => {
        m.blockId = id;
        m.lineIndex = k;
        assigned.add(m.id);
      });
    }
  }
}

/**
 * 行ごとに「字を足したとき、右へどこまで広げてよいか」を決める。
 * 同じ段（左端が近く、上下に近い行）の中でいちばん右まで。ただし同じ高さで右隣に別の文字があれば、その手前まで。
 */
function assignRoom(runs: TextRun[]) {
  const rows = runs.filter((r) => !r.vertical);
  for (const r of rows) {
    const right = r.x + r.w;
    let room = Math.max(right, r.blockRight ?? right);
    let wall = Infinity;
    for (const o of rows) {
      if (o === r) continue;
      const dy = Math.abs(o.baseline - r.baseline);
      // 右隣の文字（表の隣のセル、段組みの隣の段など）
      if (o.x >= right - r.fontSize * 0.2 && o.top < r.top + r.h && o.top + o.h > r.top) wall = Math.min(wall, o.x - r.fontSize * 0.5);
      // 同じ段の近くの行
      if (dy > 0 && dy <= r.fontSize * 4 && Math.abs(o.fontSize - r.fontSize) < r.fontSize * 0.1 && o.x <= r.x + r.fontSize * 1.5 && o.x + o.w > r.x) room = Math.max(room, o.x + o.w);
    }
    r.blockRight = Math.max(right, Math.min(room, wall));
    if (!r.rtl) continue;
    // 右から左の行は、字を足すと左へ伸びる。同じ段の行のいちばん左まで。同じ高さで左隣に別の文字があれば、その手前まで
    let roomLeft = r.x;
    let wallLeft = -Infinity;
    for (const o of rows) {
      if (o === r) continue;
      const dy = Math.abs(o.baseline - r.baseline);
      if (o.x + o.w <= r.x + r.fontSize * 0.2 && o.top < r.top + r.h && o.top + o.h > r.top) wallLeft = Math.max(wallLeft, o.x + o.w + r.fontSize * 0.5);
      if (dy > 0 && dy <= r.fontSize * 4 && Math.abs(o.fontSize - r.fontSize) < r.fontSize * 0.1 && o.x + o.w >= right - r.fontSize * 1.5 && o.x < right) roomLeft = Math.min(roomLeft, o.x);
    }
    r.blockLeft = Math.min(r.x, Math.max(roomLeft, wallLeft));
  }
}

/** 描画済み canvas から、指定領域の背景色と文字色を推定する */
export function sampleColors(
  canvas: HTMLCanvasElement,
  pxPerPt: number,
  box: { x: number; y: number; w: number; h: number },
): { bg: string; fg: string } {
  const fallback = { bg: "#ffffff", fg: "#000000" };
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return fallback;
  const pad = 2;
  const x0 = Math.max(0, Math.floor(box.x * pxPerPt) - pad);
  const y0 = Math.max(0, Math.floor(box.y * pxPerPt) - pad);
  const x1 = Math.min(canvas.width, Math.ceil((box.x + box.w) * pxPerPt) + pad);
  const y1 = Math.min(canvas.height, Math.ceil((box.y + box.h) * pxPerPt) + pad);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 2 || h <= 2) return fallback;
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(x0, y0, w, h).data;
  } catch {
    return fallback;
  }
  const px = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    return [data[i], data[i + 1], data[i + 2]] as const;
  };
  // 背景：外周ピクセルの最頻色（量子化）
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>();
  const add = (x: number, y: number) => {
    const [r, g, b] = px(x, y);
    const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const e = counts.get(k);
    if (e) {
      e.n++;
      e.r += r;
      e.g += g;
      e.b += b;
    } else counts.set(k, { n: 1, r, g, b });
  };
  for (let x = 0; x < w; x++) {
    add(x, 0);
    add(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    add(0, y);
    add(w - 1, y);
  }
  let bestC = { n: 0, r: 255, g: 255, b: 255 };
  for (const e of counts.values()) if (e.n > bestC.n) bestC = e;
  const bg: [number, number, number] = [bestC.r / bestC.n, bestC.g / bestC.n, bestC.b / bestC.n];

  // 文字色：背景から最も遠いピクセル群の平均
  const dists: { d: number; c: readonly [number, number, number] }[] = [];
  for (let y = pad; y < h - pad; y++) {
    for (let x = pad; x < w - pad; x++) {
      const c = px(x, y);
      const d = Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]);
      if (d > 60) dists.push({ d, c });
    }
  }
  let fg: [number, number, number] = [0, 0, 0];
  if (dists.length) {
    dists.sort((a, b) => b.d - a.d);
    const top = dists.slice(0, Math.max(1, Math.floor(dists.length * 0.2)));
    fg = [0, 1, 2].map((i) => top.reduce((s, t) => s + t.c[i], 0) / top.length) as [number, number, number];
  }
  return { bg: toHex(bg), fg: toHex(fg) };
}

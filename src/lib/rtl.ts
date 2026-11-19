// 右から左へ書く文字（アラビア系・ヘブライ）の行を、字形から「読む順の文字列」と「語」に組み立てる。
//
// PDF の中では、字形は見た目の順（左から右）に並んでいる。表示側（pdf.js）が返す文字列は、語の中は読む順でも、
// 語の並びは見た目の順のままだったり、合字の字の順が入れ替わっていたりして、そのままでは「どの字形がどの語か」を決められない。
// そこで、字形の位置から語（空白で区切られたまとまり）を作り、語ごとに読む順の文字列を組み立てる。
// こうして作った文字列は、語と字形の対応が最初から決まっているので、語単位の書き換え・墨消しに使える。

export interface RtlGlyphIn {
  /** その字形の文字（ToUnicode で読んだもの。合字は複数字） */
  text: string;
  /** 表示座標での左端と右端 */
  x0: number;
  x1: number;
}

export interface RtlWord<G> {
  /** 読む順の文字列 */
  text: string;
  /** この語を描いている字形（左から右） */
  glyphs: G[];
  x0: number;
  x1: number;
  /** 右から左に読む語か（右から左の字を含む語。記号だけの語は、前後の語と行の向きで決まる） */
  rtl: boolean;
}

export interface RtlLine<G> {
  /** 行全体（語を読む順に並べ、空白 1 つでつないだもの） */
  text: string;
  /** 語（読む順） */
  words: RtlWord<G>[];
  /** 行の向き */
  base: "R" | "L";
}

const RTL_CHAR = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
/**
 * 向きを決める字（右から左の字のうち、数字とその区切りを除いたもの）。アラビア文字の数字 ١٢٣ と区切り（٪ ٫ ٬）は、
 * 欧文の数字と同じく、桁を左から右へ並べる
 */
const NUMERIC = /[\u0660-\u066c\u06f0-\u06f9]/g;
const strongRtl = (text: string) => RTL_CHAR.test(text.replace(NUMERIC, ""));
/**
 * 右から左の行の中で、行の向きと逆向き（左から右）の語が続く所を、「ひと続きに左から右へ読むまとまり」に分ける。
 * 欧文の語から始まるまとまりは、あとに続く語（数字も）を含めてひと続き（「Low Income Taxpayer Clinic」「Form 1040」）。
 * 欧文の語より前にある数字は、1 つずつ別のまとまりになる：空白で区切った数字の並び（電話番号「+966 50 123 4567」など）は、
 * それぞれの数字は左から右のまま、並ぶ順は行の向き（右から左）に従う。
 * 渡す語の並びは、読む順でも、見た目の左から右の順でもよい（まとまりの中では両者は同じ）。返すのは、まとまりごとの番号の列
 */
export function ltrGroups(texts: string[]): number[][] {
  const groups: number[][] = [];
  let cur: number[] | null = null;
  texts.forEach((t, i) => {
    if (cur) cur.push(i);
    else if (/\p{L}/u.test(t)) groups.push((cur = [i]));
    else groups.push([i]);
  });
  return groups;
}
/** かっこ：開く形 → 閉じる形 */
const CLOSE: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">", "\u00ab": "\u00bb" };
const OPEN: Record<string, string> = Object.fromEntries(Object.entries(CLOSE).map(([o, c]) => [c, o]));
/** 表示形（語頭・語中・語尾の形、合字）を、もとの字にそろえる */
const plain = (s: string) => s.normalize("NFKC");
const isMark = (s: string) => s.length > 0 && /^\p{M}+$/u.test(s);
/** 文字として数えない字形（幅ゼロの空白・向きの指定など。字の部品だけの字形に割り当てられていることがある） */
const IGNORABLE = /[\u00ad\u061c\u200b\u200e\u200f\u2060\ufeff]/g;
const isIgnorable = (s: string) => s.length > 0 && s.replace(IGNORABLE, "") === "";
const isSpace = (s: string) => s.length > 0 && !s.trim();

type Kind = "R" | "L" | "N";
function kindOf(text: string): Kind {
  if (strongRtl(text)) return "R";
  if (/[\p{L}\p{Nd}]/u.test(text)) return "L";
  return "N";
}

/** 語の中の字形（左から右）から、読む順の文字列を作る */
function logicalText(parts: { text: string; marks: string }[]): { text: string; rtl: boolean } {
  const kinds = parts.map((p) => kindOf(p.text));
  if (!kinds.includes("R")) return { text: parts.map((p) => p.text + p.marks).join(""), rtl: false };
  // どちらでもない字（記号）：両隣が欧文・数字ならそれに続くもの（12/03/2026 の「/」など）、そうでなければ右から左
  const dir: ("R" | "L")[] = kinds.map((k, i) => {
    if (k !== "N") return k;
    let prev: Kind = "N";
    for (let j = i - 1; j >= 0 && prev === "N"; j--) prev = kinds[j];
    let next: Kind = "N";
    for (let j = i + 1; j < kinds.length && next === "N"; j++) next = kinds[j];
    return prev === "L" && next === "L" ? "L" : "R";
  });
  // 右から読む：字形の並びを逆にし、欧文・数字のまとまりだけは左から右のままにする
  const out: string[] = [];
  for (let i = parts.length - 1; i >= 0; ) {
    if (dir[i] === "R") {
      out.push(parts[i].text + parts[i].marks);
      i--;
      continue;
    }
    let j = i;
    while (j >= 0 && dir[j] === "L") j--;
    for (let k = j + 1; k <= i; k++) out.push(parts[k].text + parts[k].marks);
    i = j;
  }
  return { text: fixBrackets(out).join(""), rtl: true };
}

/**
 * かっこの向きをそろえる。右から左の行では、かっこは左右が逆の形で表示される。PDF の中の文字は、作成ソフトによって
 * 「表示されている形」のことも「読む順での形」のこともあるので、位置で決める：語の先頭（字より前）にあるかっこは開く形、
 * 語の末尾（字より後ろ）にあるかっこは閉じる形にする。語の途中のかっこは、そのままにする。
 */
function fixBrackets(tokens: string[]): string[] {
  const out = [...tokens];
  const isLetter = (t: string) => /[\p{L}\p{Nd}]/u.test(t);
  const first = out.findIndex(isLetter);
  if (first < 0) return out;
  let last = out.length - 1;
  while (last > first && !isLetter(out[last])) last--;
  for (let i = 0; i < first; i++) out[i] = [...out[i]].map((c) => OPEN[c] ?? c).join("");
  for (let i = last + 1; i < out.length; i++) out[i] = [...out[i]].map((c) => CLOSE[c] ?? c).join("");
  return out;
}

/**
 * 行の字形から、語と、読む順の文字列を作る。
 * - 語の切れ目：空白の字形、または字形の間の広い隙間。hintWords（表示側の文字列での語の数）があれば、
 *   隙間の広い順にその数になるまで切る（字間の広い組版でも、語の途中で切らない）
 * - 何の字か分からない字形があれば null（文字列を作れない）
 * - 行の向き：base を渡せばそれ。無ければ字の数で決める。欧文の長い語句を含む右から左の行（「… (U.S. Court of Federal Claims) …」）は
 *   字の数だけでは決められないので、ページ全体の向き（prior）が右から左なら、行の両端の語も見て決める
 */
export function rtlLine<G extends RtlGlyphIn>(input: G[], fontSize: number, hintWords?: number, dir?: { base?: "R" | "L"; prior?: "R" | "L" }): RtlLine<G> | null {
  // 制御文字だけの字形（目次の点線の前に入るタブなど）は、文字列に入れない
  const all = input.filter((g) => (g.text !== "" || g.x1 - g.x0 > 0) && !/^[\u0000-\u001f\u007f]+$/.test(g.text));
  if (!all.length) return null;
  if (all.some((g) => g.text === "" || g.text.includes("�") || /[-]/.test(g.text))) return null;
  const sorted = [...all].sort((a, b) => a.x0 - b.x0);
  // 上下に付く記号と、文字として数えない字形（字の部品など）は、いちばん近い字に付ける（その字と一緒に残す・消す）
  const attached = (g: G) => isMark(plain(g.text)) || isIgnorable(g.text);
  const bases = sorted.filter((g) => !attached(g) && !isSpace(g.text));
  if (!bases.length) return null;
  const marksOf = new Map<G, G[]>();
  // 記号の中心が字の幅の中にあれば、その字。字と字の境目のあたり（幅ゼロの記号は、付く字の端から少しはみ出した位置に
  // 置かれることがある）では、中心の近いほうの字にする
  const edge = Math.max(0.3, fontSize * 0.03);
  for (const m of sorted.filter(attached)) {
    const c = (m.x0 + m.x1) / 2;
    const dist = (b: G) => (c >= b.x0 && c <= b.x1 ? 0 : Math.min(Math.abs(c - b.x0), Math.abs(c - b.x1)));
    const inside = (b: G) => c >= b.x0 + edge && c <= b.x1 - edge;
    let best = bases[0];
    let bestD = Infinity;
    for (const b of bases) {
      const d = dist(b);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    if (!inside(best)) {
      const near = bases.filter((b) => dist(b) <= edge);
      const mid = (b: G) => Math.abs(c - (b.x0 + b.x1) / 2);
      if (near.length > 1) best = near.reduce((p, q) => (mid(q) < mid(p) ? q : p));
    }
    marksOf.set(best, [...(marksOf.get(best) ?? []), m]);
  }
  // 語の切れ目
  const spaces = sorted.filter((g) => isSpace(g.text));
  const between = (left: G, right: G) =>
    spaces.some((s) => {
      const c = (s.x0 + s.x1) / 2;
      const half = (s.x1 - s.x0) / 2 + 0.01;
      return c >= left.x1 - half && c <= right.x0 + half;
    });
  const gaps = bases.slice(1).map((g, i) => ({ at: i + 1, gap: g.x0 - bases[i].x1, space: between(bases[i], g) }));
  const cuts = new Set(gaps.filter((g) => g.space).map((g) => g.at));
  const others = gaps.filter((g) => !g.space).sort((a, b) => b.gap - a.gap);
  // 空白の字形がある行：空白の字形は無いが、空白のある所と同じくらい空いている所も、語の切れ目
  // （向きの変わる所で位置だけ進めている文書、語を別のフォントで書き足した所）
  const spaceGaps = gaps.filter((g) => g.space).map((g) => g.gap).sort((a, b) => a - b);
  if (spaceGaps.length) {
    const typical = spaceGaps[Math.floor(spaceGaps.length / 2)];
    for (const g of others) if (g.gap >= Math.max(fontSize * 0.1, typical * 0.6)) cuts.add(g.at);
  }
  if (hintWords !== undefined) {
    for (const g of others) {
      if (cuts.size >= hintWords - 1 || g.gap < fontSize * 0.1) break;
      cuts.add(g.at);
    }
  } else for (const g of others) if (g.gap > fontSize * 0.22) cuts.add(g.at);
  const chunks: G[][] = [[]];
  bases.forEach((g, i) => {
    if (cuts.has(i)) chunks.push([]);
    chunks[chunks.length - 1].push(g);
  });
  const visual: RtlWord<G>[] = chunks.map((c) => {
    const lt = logicalText(c.map((g) => ({ text: plain(g.text).replace(IGNORABLE, ""), marks: (marksOf.get(g) ?? []).map((m) => plain(m.text).replace(IGNORABLE, "")).join("") })));
    const glyphs = c.flatMap((g) => [g, ...(marksOf.get(g) ?? [])]);
    return { text: lt.text, rtl: lt.rtl, glyphs, x0: Math.min(...glyphs.map((g) => g.x0)), x1: Math.max(...glyphs.map((g) => g.x1)) };
  });
  // 行の向き：右から左の字が、欧文の字以上にあれば右から左（数字は数えない：日付や番号の多い行でも、文の向きで決める）
  let r = 0;
  let l = 0;
  for (const w of visual) for (const ch of w.text) (strongRtl(ch) ? r++ : /\p{L}/u.test(ch) ? l++ : 0);
  // ページ全体が右から左のとき：行の両端が欧文の語（左端の語の頭に句読点が無い）で、欧文の字のほうが多い行だけを、左から右とする
  // （右から左の行は、欧文の長い語句を含んでいても、どちらかの端は右から左の語か、文の句読点・番号になる）
  const latinWord = (t: string) => !strongRtl(t) && /\p{L}/u.test(t);
  const ltrInRtlPage = latinWord(visual[0].text) && latinWord(visual[visual.length - 1].text) && !/^[.,:;!?]/.test(visual[0].text) && l > r;
  const base: "R" | "L" = dir?.base ?? (r > 0 && (dir?.prior === "R" ? !ltrInRtlPage : r >= l) ? "R" : "L");
  // 記号だけの語の向きを、前後の語から決める
  wordDirs(visual.map((w) => w.text), base).forEach((d, i) => (visual[i].rtl = d));
  // 右から左の行の中の、数字や欧文の語の続き（「2026」「Low Income Taxpayer Clinic」など）：その左端・右端に付いた記号
  // （句点、かっこ）は文のもので、読む順では反対側に来る（見た目「.2026」→ 読む順「2026.」）。続きの途中の記号は動かさない
  const words: RtlWord<G>[] = [];
  if (base === "R") {
    // 見た目の左から右に、「右から左の語 1 つ」または「左から右へ読むまとまり」を並べる
    const units: RtlWord<G>[][] = [];
    for (let i = 0; i < visual.length; ) {
      if (visual[i].rtl) {
        units.push([visual[i++]]);
        continue;
      }
      let j = i;
      while (j + 1 < visual.length && !visual[j + 1].rtl) j++;
      const run = visual.slice(i, j + 1);
      for (const g of ltrGroups(run.map((w) => w.text))) units.push(g.map((k) => run[k]));
      i = j + 1;
    }
    for (const u of units) {
      if (u[0].rtl) continue;
      const first = u[0];
      const last = u[u.length - 1];
      const lead = /^[^\p{L}\p{Nd}]*/u.exec(first.text)![0];
      const trail = /[^\p{L}\p{Nd}]*$/u.exec(last.text)![0];
      // （まとまりの両端は、字のある語。記号だけの語は、そのまま）
      if ((lead || trail) && lead.length < first.text.length && trail.length < last.text.length) {
        const flip = (t: string, table: Record<string, string>) => [...t].reverse().map((c) => table[c] ?? c).join("");
        const head = flip(trail, OPEN);
        const tail = flip(lead, CLOSE);
        if (u.length === 1) first.text = head + first.text.slice(lead.length, first.text.length - trail.length) + tail;
        else {
          first.text = head + first.text.slice(lead.length);
          last.text = last.text.slice(0, last.text.length - trail.length) + tail;
        }
      }
    }
    // 読む順：まとまりを右から。まとまりの中は左から右
    for (let i = units.length - 1; i >= 0; i--) words.push(...units[i]);
  } else {
    // 左から右の行：右から左の語が続く所は、その中の順を入れ替える
    for (let i = 0; i < visual.length; ) {
      if (!visual[i].rtl) {
        words.push(visual[i++]);
        continue;
      }
      let j = i;
      while (j < visual.length && visual[j].rtl) j++;
      for (let k = j - 1; k >= i; k--) words.push(visual[k]);
      i = j;
    }
  }
  return { text: words.map((w) => w.text).join(" "), words, base };
}

/** 右から左へ書く字（ヘブライ、アラビア系とその表示形）を含むか */
export const hasRtl = (text: string) => RTL_CHAR.test(text);

/**
 * 語ごとの向き（右から左なら true）。右から左の字を含む語は右から左、数字・欧文の語は左から右。
 * 記号だけの語（「—」「•」など）は、前後の語（記号だけの語は飛ばす）がどちらも左から右ならそれに続き、そうでなければ行の向きに従う。
 * 語の並びは、読む順でも表示順でもよい（隣り合う語は同じなので、結果は変わらない）
 */
export function wordDirs(texts: string[], base: "R" | "L"): boolean[] {
  const strong = texts.map((t) => (strongRtl(t) ? "R" : /[\p{L}\p{Nd}]/u.test(t) ? "L" : "N"));
  return strong.map((k, i) => {
    if (k !== "N") return k === "R";
    let prev = "N";
    for (let j = i - 1; j >= 0 && prev === "N"; j--) prev = strong[j];
    let next = "N";
    for (let j = i + 1; j < strong.length && next === "N"; j++) next = strong[j];
    return prev === "L" && next === "L" ? false : base === "R";
  });
}

/**
 * 語の並び（読む順）を、表示上の左から右の順に並べたときの番号の列を返す。against は、行の向きと逆向きの語か
 * （右から左の行の中の数字・欧文、左から右の行の中のアラビア語・ヘブライ語）。逆向きの語が続く所は、その中だけ向きが逆になる
 */
export function visualOrder(against: boolean[], base: "R" | "L", texts?: string[]): number[] {
  const n = against.length;
  const seq = Array.from({ length: n }, (_, i) => (base === "R" ? n - 1 - i : i));
  const out: number[] = [];
  for (let i = 0; i < n; ) {
    if (!against[seq[i]]) {
      out.push(seq[i++]);
      continue;
    }
    let j = i;
    while (j < n && against[seq[j]]) j++;
    // 逆向きの語の続き（読む順）
    const run: number[] = [];
    for (let k = j - 1; k >= i; k--) run.push(seq[k]);
    if (base === "R" && texts) {
      // 右から左の行：左から右へ読むまとまりごとに、あとのまとまりほど左に来る（ltrGroups）
      const groups = ltrGroups(run.map((k) => texts[k]));
      for (let g = groups.length - 1; g >= 0; g--) out.push(...groups[g].map((k) => run[k]));
    } else out.push(...run);
    i = j;
  }
  return out;
}

/** 語の単位で比べて、変えた所を求める（元の語 [a0, a1) を、新しい語 [b0, b1) に置き換える） */
export function wordDiff(a: string[], b: string[]): { a0: number; a1: number; b0: number; b1: number }[] {
  const L = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: { a0: number; a1: number; b0: number; b1: number }[] = [];
  let i = 0;
  let j = 0;
  let open: { a0: number; a1: number; b0: number; b1: number } | null = null;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      if (open) out.push(open);
      open = null;
      i++;
      j++;
      continue;
    }
    if (!open) open = { a0: i, a1: i, b0: j, b1: j };
    if (j < b.length && (i >= a.length || L[i][j + 1] >= L[i + 1][j])) j++;
    else i++;
    open.a1 = i;
    open.b1 = j;
  }
  if (open) out.push(open);
  return out;
}

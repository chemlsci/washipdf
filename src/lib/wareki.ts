/**
 * 和暦 ⇄ 西暦の変換。既存文字の中にある日付を見つけ、置き換え後の文字列を作る。
 * 実際の書き換えは既存の実編集（TextEditObj）に乗せるので、ここは純粋な文字列処理だけを持つ。
 *
 * - 対応元号：明治・大正・昭和・平成・令和（単漢字略記 明/大/昭/平/令 も可）
 * - 元年（＝1年）に対応
 * - 月日は任意。月だけ・年だけでも変換する
 * - 全角数字（０-９）で書かれていれば、変換後も全角にそろえる
 */

export type WarekiDirection = "toWestern" | "toWareki";

interface Era {
  name: string;
  /** 略記（単漢字） */
  abbr: string;
  /** 改元日（グレゴリオ暦）。元年＝startYear */
  sy: number;
  sm: number;
  sd: number;
}

// 新しい順。西暦→和暦の判定でこの順に見る
const ERAS: Era[] = [
  { name: "令和", abbr: "令", sy: 2019, sm: 5, sd: 1 },
  { name: "平成", abbr: "平", sy: 1989, sm: 1, sd: 8 },
  { name: "昭和", abbr: "昭", sy: 1926, sm: 12, sd: 25 },
  { name: "大正", abbr: "大", sy: 1912, sm: 7, sd: 30 },
  { name: "明治", abbr: "明", sy: 1868, sm: 10, sd: 23 },
];

const FULL = "０１２３４５６７８９";
const isFullWidth = (s: string) => /[０-９]/.test(s);
const toHalf = (s: string) => s.replace(/[０-９]/g, (c) => String(FULL.indexOf(c)));
const toFull = (s: string) => s.replace(/[0-9]/g, (c) => FULL[Number(c)]);
/** 元のかたまりが全角なら全角、そうでなければ半角で数字を書く */
const widthOf = (sample: string) => (isFullWidth(sample) ? toFull : (s: string) => s);
const numOf = (s: string | undefined): number | null => (s == null ? null : parseInt(toHalf(s), 10));

export interface DateMatch {
  /** text 内の位置 [start, end) */
  start: number;
  end: number;
  /** 元の文字列（そのまま） */
  original: string;
  /** 置き換え後の文字列 */
  converted: string;
  /** 月を省いた境界年など、確認してほしいとき */
  warning: boolean;
}

/** 西暦の年・月・日 → 和暦（元号・年・境界の警告） */
export function westernToWareki(y: number, m: number | null, d: number | null): { era: Era; year: number; warning: boolean } | null {
  for (const e of ERAS) {
    const after = y > e.sy || (y === e.sy && (m == null || m > e.sm || (m === e.sm && (d == null || d >= e.sd))));
    if (after) {
      // 改元の年で月が無い＝どちらの元号か確定できない（例：2019 年は平成 31 か令和元か）
      const warning = y === e.sy && m == null;
      return { era: e, year: y - e.sy + 1, warning };
    }
  }
  return null;
}

/** 和暦の元号・年 → 西暦の年 */
export function warekiToWestern(era: Era, year: number): number {
  return era.sy + year - 1;
}

const eraByName = (s: string): Era | undefined => ERAS.find((e) => e.name === s || e.abbr === s);

function buildDate(y: number, m: number | null, d: number | null, full: (s: string) => string): string {
  let out = `${full(String(y))}年`;
  if (m != null) out += `${full(String(m))}月`;
  if (d != null) out += `${full(String(d))}日`;
  return out;
}

const WAREKI_RE = /(令和|平成|昭和|大正|明治|令|平|昭|大|明)\s*(元|[0-9０-９]{1,2})\s*年(?:\s*([0-9０-９]{1,2})\s*月(?:\s*([0-9０-９]{1,2})\s*日)?)?/g;
const WESTERN_RE = /([0-9０-９]{4})\s*年(?:\s*([0-9０-９]{1,2})\s*月(?:\s*([0-9０-９]{1,2})\s*日)?)?/g;

/** 文字列の中の日付を見つけ、指定方向に変換した候補を返す（重複しない範囲） */
export function findDates(text: string, dir: WarekiDirection): DateMatch[] {
  const out: DateMatch[] = [];
  if (dir === "toWestern") {
    for (const m of text.matchAll(WAREKI_RE)) {
      const era = eraByName(m[1]);
      if (!era) continue;
      const yr = m[2] === "元" ? 1 : numOf(m[2]);
      if (yr == null || yr < 1) continue;
      const mon = numOf(m[3]);
      const day = numOf(m[4]);
      const full = widthOf(m[2] === "元" ? m[0] : m[2]);
      const y = warekiToWestern(era, yr);
      const converted = buildDate(y, mon, day, full);
      if (converted !== m[0].replace(/\s+/g, "")) out.push({ start: m.index!, end: m.index! + m[0].length, original: m[0], converted, warning: false });
    }
  } else {
    for (const m of text.matchAll(WESTERN_RE)) {
      const y = numOf(m[1])!;
      if (y < 1868 || y > 2099) continue;
      const mon = numOf(m[2]);
      const day = numOf(m[3]);
      const w = westernToWareki(y, mon, day);
      if (!w) continue;
      const full = widthOf(m[1]);
      const yearStr = w.year === 1 ? "元" : full(String(w.year));
      let converted = `${w.era.name}${yearStr}年`;
      if (mon != null) converted += `${full(String(mon))}月`;
      if (day != null) converted += `${full(String(day))}日`;
      out.push({ start: m.index!, end: m.index! + m[0].length, original: m[0], converted, warning: w.warning });
    }
  }
  return out;
}

/** 選んだ範囲（右から左へ）を置き換えた新しい文字列。matches は findDates の部分集合 */
export function applyMatches(text: string, matches: DateMatch[]): string {
  let out = text;
  for (const m of [...matches].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, m.start) + m.converted + out.slice(m.end);
  }
  return out;
}

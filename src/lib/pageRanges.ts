/** ページ範囲の文字列（"1-3, 5, 8-"）の解釈。分割・ページ番号・透かしなどで共有する */

export interface RangeResult {
  /** 1 始まりのページ番号の配列（グループごと） */
  groups: number[][];
  /** 解釈できなかった部分（空なら成功） */
  badPart: string | null;
  /** 範囲外だった部分 */
  outOfRange: string | null;
}

export function parsePageRanges(input: string, total: number): RangeResult {
  const groups: number[][] = [];
  const parts = input
    .replace(/[，、]/g, ",")
    .replace(/[〜～ー―−–]/g, "-")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const part of parts) {
    const m = /^(\d+)\s*(?:-\s*(\d*))?$/.exec(part.normalize("NFKC"));
    if (!m) return { groups, badPart: part, outOfRange: null };
    const a = parseInt(m[1], 10);
    const b = m[2] === undefined ? a : m[2] === "" ? total : parseInt(m[2], 10);
    if (a < 1 || b < 1 || a > total || b > total) return { groups, badPart: null, outOfRange: part };
    const g: number[] = [];
    if (a <= b) for (let i = a; i <= b; i++) g.push(i);
    else for (let i = a; i >= b; i--) g.push(i);
    groups.push(g);
  }
  return { groups, badPart: null, outOfRange: null };
}

/** 範囲文字列を「対象ページの集合（0 始まり）」にする。空文字なら全ページ */
export function pageSet(input: string, total: number): Set<number> {
  const s = new Set<number>();
  if (!input.trim()) {
    for (let i = 0; i < total; i++) s.add(i);
    return s;
  }
  const r = parsePageRanges(input, total);
  for (const g of r.groups) for (const n of g) s.add(n - 1);
  return s;
}

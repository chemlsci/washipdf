// 表の罫線から、文字の入っていない枠（記入欄）を見つけて、入力欄の候補にする
import { cellFromRules } from "./approval";
import type { TextRun } from "./textRuns";

export interface FieldCandidate {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 左隣（同じ行）にある見出しの文字。入力欄の名前に使う */
  label: string;
}

/** 入力欄にする枠の大きさ（pt）：1 行の記入欄から、数行の記入欄まで */
const LIMITS = { minW: 24, minH: 12, maxW: 560, maxH: 90 };

/**
 * rules：表示座標の水平・垂直の線。runs：ページの行。width / height：ページの大きさ。
 * ページを細かい間隔で調べ、点を囲む閉じた枠のうち、中に文字の無いものを返す（重なるものは 1 つにする）
 */
export function detectFieldCells(rules: readonly [number, number, number, number][], runs: readonly TextRun[], width: number, height: number): FieldCandidate[] {
  const found: FieldCandidate[] = [];
  const inside = (c: { x: number; y: number; w: number; h: number }, x: number, y: number) => x > c.x && x < c.x + c.w && y > c.y && y < c.y + c.h;
  const step = 6;
  for (let y = step / 2; y < height; y += step) {
    for (let x = step / 2; x < width; x += step) {
      if (found.some((c) => inside(c, x, y))) continue;
      const cell = cellFromRules(rules, x, y, LIMITS);
      if (!cell || found.some((c) => Math.abs(c.x - cell.x) < 1 && Math.abs(c.y - cell.y) < 1)) continue;
      // 文字の入っている枠（見出し・記入済み）は除く
      const filled = runs.some((r) => inside(cell, r.x + r.w / 2, r.top + r.h / 2));
      if (filled) {
        found.push({ ...cell, label: "\u0000" });
        continue;
      }
      // 名前：同じ行で、左にある、いちばん近い文字
      const midY = cell.y + cell.h / 2;
      let label = "";
      let best = Infinity;
      for (const r of runs) {
        if (r.top > midY || r.top + r.h < midY || r.x + r.w > cell.x + 2) continue;
        const d = cell.x - (r.x + r.w);
        if (d < best) {
          best = d;
          label = r.text;
        }
      }
      found.push({ ...cell, label: label.replace(/[：:\s]+$/u, "").trim().slice(0, 30) });
    }
  }
  return found.filter((c) => c.label !== "\u0000");
}

type Rect = { x: number; y: number; w: number; h: number };
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * 下線だけの記入欄（「氏名 ＿＿＿＿＿」のように、見出しの右に線だけを引いたもの）を見つける。
 * 枠や表の一部の線（端や途中に縦の線が付いているもの）・見出しの無い線（区切りの線）・上に文字のある線（下線を引いた文字）は除く
 */
export function detectUnderlineFields(rules: readonly [number, number, number, number][], runs: readonly TextRun[], taken: readonly Rect[]): FieldCandidate[] {
  const H: { y: number; a: number; b: number }[] = [];
  const V: { x: number; a: number; b: number }[] = [];
  for (const [x1, y1, x2, y2] of rules) {
    if (Math.abs(y1 - y2) <= 0.5) H.push({ y: (y1 + y2) / 2, a: Math.min(x1, x2), b: Math.max(x1, x2) });
    else if (Math.abs(x1 - x2) <= 0.5) V.push({ x: (x1 + x2) / 2, a: Math.min(y1, y2), b: Math.max(y1, y2) });
  }
  // 同じ高さで続いている線をつなぐ（下線を引いた空白は、空白 1 つごとの短い線で描かれることがある）
  H.sort((p, q) => p.y - q.y || p.a - q.a);
  const joined: typeof H = [];
  for (const h of H) {
    const last = joined[joined.length - 1];
    if (last && Math.abs(last.y - h.y) <= 0.5 && h.a <= last.b + 1.5) last.b = Math.max(last.b, h.b);
    else joined.push({ ...h });
  }
  const out: FieldCandidate[] = [];
  for (const h of joined) {
    if (h.b - h.a < 36) continue;
    // 枠・表の線：線の範囲に縦の線が付いている
    if (V.some((v) => v.x >= h.a - 2 && v.x <= h.b + 2 && v.a <= h.y + 1 && v.b >= h.y - 1 && (v.a < h.y - 3 || v.b > h.y + 3))) continue;
    // 見出し：線の左にあって、行の下端が線の近くにある文字
    let label: TextRun | null = null;
    let best = Infinity;
    for (const r of runs) {
      const right = r.x + r.w;
      const bottom = r.top + r.h;
      if (right > h.a + 4 || right < h.a - 80) continue;
      if (bottom < h.y - r.fontSize * 0.9 || bottom > h.y + r.fontSize * 0.6) continue;
      const d = h.a - right;
      if (d < best) {
        best = d;
        label = r;
      }
    }
    if (!label) continue;
    const height = Math.max(12, label.fontSize * 1.5);
    const cell = { x: h.a, y: h.y - height, w: h.b - h.a, h: height };
    // 上に文字がある（下線を引いた文字・記入済み）
    if (runs.some((r) => r !== label && r.x + r.w / 2 > cell.x && r.x + r.w / 2 < cell.x + cell.w && r.top + r.h / 2 > cell.y && r.top + r.h / 2 < h.y)) continue;
    if (taken.some((c) => overlap(c, cell)) || out.some((c) => overlap(c, cell))) continue;
    out.push({ ...cell, label: label.text.replace(/[：:\s]+$/u, "").trim().slice(0, 30) });
  }
  return out;
}

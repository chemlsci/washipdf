/**
 * 数値の入力の上限・下限。画面の入力欄だけでなく、処理の入口でも同じ範囲に収める
 * （極端な値や、数でない値で、固まったり巨大なデータを作ったりしないように）。
 */

/** 数値を [min, max] に収める。数でない値（NaN・無限大・文字など）は fallback（省略時は min）にする */
export function clamp(v: unknown, min: number, max: number, fallback = min): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 同じく整数に収める */
export const clampInt = (v: unknown, min: number, max: number, fallback = min) => Math.round(clamp(v, min, max, fallback));

export const LIMITS = {
  /** ゼロ埋めの桁数（{n:6}） */
  padDigits: 20,
  /** 画像として保存するときの解像度（dpi） */
  dpi: { min: 36, max: 600 },
  /** 余白・間隔（pt。約 176 mm まで） */
  marginPt: 500,
  /** 文字の大きさ（pt） */
  fontSize: { min: 1, max: 1000 },
  /** ページの大きさ（pt。PDF の実装上の上限 14,400 pt = 200 インチ） */
  pagePt: { min: 3, max: 14400 },
  /** ページ番号の開始番号 */
  startNumber: { min: -999_999_999, max: 999_999_999 },
} as const;

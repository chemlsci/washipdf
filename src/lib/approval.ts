// 承認欄（役職の見出しと押印欄が横に並んだ枠）。スタンプの一種（frame: "grid"）として持つ。
// 見出しは text に「,」区切りで入れる（例：部長,課長,担当）。
// サインや印鑑を欄の中に置くと、欄に合わせて大きさと位置を整える（fitIntoCell）。
import type { EditObj, StampObj } from "./types";

export const isApproval = (o: EditObj): o is StampObj => o.type === "stamp" && o.frame === "grid";

/** 見出しの並び（「,」「、」「，」「/」で区切る。空の見出しも欄として数える） */
export function approvalTitles(text: string): string[] {
  const list = text.split(/[,、，/|]/).map((s) => s.trim());
  return list.length ? list : [""];
}

export interface ApprovalLayout {
  titles: string[];
  /** 見出しの段の高さ */
  header: number;
  /** 線の太さ */
  line: number;
  /** 欄の幅 */
  col: number;
}

export function approvalLayout(o: StampObj): ApprovalLayout {
  const titles = approvalTitles(o.text);
  return {
    titles,
    header: Math.min(o.fontSize * 1.8, o.h * 0.45),
    line: Math.max(0.5, o.fontSize * 0.07),
    col: o.w / titles.length,
  };
}

/** 押印欄（見出しの下）の位置。ページの表示座標（pt） */
export function approvalCells(o: StampObj): { x: number; y: number; w: number; h: number }[] {
  const l = approvalLayout(o);
  return l.titles.map((_, i) => ({ x: o.x + i * l.col, y: o.y + l.header, w: l.col, h: o.h - l.header }));
}

/** 新しく置く承認欄（中心を指定） */
export function newApproval(base: Omit<StampObj, "text" | "w" | "h" | "x" | "y" | "frame" | "double" | "rotation">, cx: number, cy: number, text: string): StampObj {
  const n = approvalTitles(text).length;
  const fontSize = 10;
  const w = n * 56;
  const h = fontSize * 1.8 + 52;
  return { ...base, text, fontSize, x: cx - w / 2, y: cy - h / 2, w, h, frame: "grid", double: false, rotation: 0, opacity: 1, color: "#222222" };
}

/** 欄に入れられるもの（サインなどの画像・印鑑） */
const fits = (o: EditObj): o is Extract<EditObj, { type: "image" }> | StampObj => o.type === "image" || (o.type === "stamp" && !isApproval(o));

/**
 * obj の中心が、ページのどれかの承認欄の押印欄の中にあれば、その欄に収まる大きさ（縦横比はそのまま。欄の 84%）にして、
 * 欄の中央に置いたものを返す。欄の外なら null。回転した承認欄は扱わない
 */
export function fitIntoCell(obj: EditObj, objects: readonly EditObj[]): EditObj | null {
  if (!fits(obj)) return null;
  const cx = obj.x + obj.w / 2;
  const cy = obj.y + obj.h / 2;
  for (const box of objects) {
    // 署名欄（入力欄の道具で置いたもの）にも合わせる
    if (box.type === "field" && box.kind === "signature" && cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h) return fitToRect(obj, box);
    if (box.id === obj.id || !isApproval(box) || box.rotation) continue;
    for (const c of approvalCells(box)) {
      if (cx < c.x || cx > c.x + c.w || cy < c.y || cy > c.y + c.h) continue;
      return fitToRect(obj, c);
    }
  }
  return null;
}

type Rect = { x: number; y: number; w: number; h: number };

/** 枠に収まる大きさ（縦横比はそのまま。枠の 84%）にして、枠の中央に置く */
export function fitToRect(obj: EditObj, c: Rect): EditObj | null {
  if (!fits(obj)) return null;
  const k = Math.min((c.w * 0.84) / obj.w, (c.h * 0.84) / obj.h);
  const w = obj.w * k;
  const h = obj.h * k;
  // 印鑑は文字の大きさも一緒に変える
  const extra = obj.type === "stamp" ? { fontSize: Math.max(4, obj.fontSize * k) } : {};
  return { ...obj, ...extra, w, h, x: c.x + (c.w - w) / 2, y: c.y + (c.h - h) / 2 };
}

/** 押印欄とみなす枠の大きさ（pt）。これより大きい枠（備考欄など）には合わせない */
const CELL_MIN = 12;
const CELL_MAX_W = 260;
const CELL_MAX_H = 160;

/**
 * ページに描かれた罫線（表示座標の水平・垂直の線）から、点 (cx, cy) を囲む閉じた枠を探す。
 * 保存して開き直した承認欄や、ほかのソフトで作った書類の押印欄（表）に、サインを合わせるのに使う。
 * 上下左右のいちばん近い線が、それぞれ枠の辺をほぼ（9 割以上）覆っているときだけ枠とみなす
 */
export function cellFromRules(
  rules: readonly [number, number, number, number][],
  cx: number,
  cy: number,
  limits: { minW: number; minH: number; maxW: number; maxH: number } = { minW: CELL_MIN, minH: CELL_MIN, maxW: CELL_MAX_W, maxH: CELL_MAX_H },
): Rect | null {
  const tol = 1.5;
  const H: { y: number; a: number; b: number }[] = [];
  const V: { x: number; a: number; b: number }[] = [];
  for (const [x1, y1, x2, y2] of rules) {
    if (Math.abs(y1 - y2) <= 0.5) H.push({ y: (y1 + y2) / 2, a: Math.min(x1, x2), b: Math.max(x1, x2) });
    else if (Math.abs(x1 - x2) <= 0.5) V.push({ x: (x1 + x2) / 2, a: Math.min(y1, y2), b: Math.max(y1, y2) });
  }
  let top = -Infinity;
  let bottom = Infinity;
  let left = -Infinity;
  let right = Infinity;
  for (const h of H) {
    if (cx < h.a - tol || cx > h.b + tol) continue;
    if (h.y < cy && h.y > top) top = h.y;
    if (h.y > cy && h.y < bottom) bottom = h.y;
  }
  for (const v of V) {
    if (cy < v.a - tol || cy > v.b + tol) continue;
    if (v.x < cx && v.x > left) left = v.x;
    if (v.x > cx && v.x < right) right = v.x;
  }
  if (![top, bottom, left, right].every(Number.isFinite)) return null;
  const w = right - left;
  const h = bottom - top;
  if (w < limits.minW || h < limits.minH || w > limits.maxW || h > limits.maxH) return null;
  // 辺がどれだけ線で覆われているか（同じ位置の線をつないで数える）
  const covered = (segs: { a: number; b: number }[], lo: number, hi: number) => {
    const parts = segs.map((s) => [Math.max(lo, s.a), Math.min(hi, s.b)] as const).filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
    let sum = 0;
    let end = lo;
    for (const [a, b] of parts) {
      if (b <= end) continue;
      sum += b - Math.max(a, end);
      end = b;
    }
    return sum / (hi - lo);
  };
  const along = (list: { y?: number; x?: number; a: number; b: number }[], at: number, key: "x" | "y", lo: number, hi: number) =>
    covered(
      list.filter((s) => Math.abs((s[key] ?? NaN) - at) <= tol),
      lo,
      hi,
    );
  if (along(H, top, "y", left, right) < 0.9 || along(H, bottom, "y", left, right) < 0.9) return null;
  if (along(V, left, "x", top, bottom) < 0.9 || along(V, right, "x", top, bottom) < 0.9) return null;
  return { x: left, y: top, w, h };
}

/** 承認欄の枠の中に中心があるもの（承認欄を動かすとき、一緒に動かす） */
export function insideApproval(box: StampObj, objects: readonly EditObj[]): EditObj[] {
  return objects.filter((o) => {
    if (o.id === box.id || !fits(o)) return false;
    const cx = o.x + o.w / 2;
    const cy = o.y + o.h / 2;
    return cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h;
  });
}

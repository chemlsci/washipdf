// 計測：距離・面積の計算と、表示の文字、保存のときの描画
import { degrees, type PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "pdf-lib";
import { apply, invert } from "./geometry";
import type { MeasureObj, PageItem } from "./types";

/** 1 pt の長さ（mm） */
const MM_PER_PT = 25.4 / 72;
const UNIT_MM: Record<MeasureObj["unit"], number> = { mm: 1, cm: 10, m: 1000 };

/** 距離（実寸。単位は o.unit） */
export function measureLength(o: MeasureObj): number {
  let len = 0;
  for (let i = 1; i < o.pts.length; i++) len += Math.hypot(o.pts[i][0] - o.pts[i - 1][0], o.pts[i][1] - o.pts[i - 1][1]);
  return (len * MM_PER_PT * o.scale) / UNIT_MM[o.unit];
}


/** 縮尺（1 : n）として受け付ける範囲 */
export const MIN_SCALE = 1e-6;
export const MAX_SCALE = 1e9;
/**
 * 縮尺を合わせる：この線の実際の長さ（o.unit で real）から、縮尺（1 : scale の scale）を求める。
 * 図面の寸法が分かっている線を引いて長さを入れると、ほかの計測もその縮尺で測れる。求められなければ null
 */
export function scaleForLength(o: MeasureObj, real: number): number | null {
  let len = 0;
  for (let i = 1; i < o.pts.length; i++) len += Math.hypot(o.pts[i][0] - o.pts[i - 1][0], o.pts[i][1] - o.pts[i - 1][1]);
  if (!(real > 0) || !(len > 0) || o.kind !== "distance") return null;
  const s = (real * UNIT_MM[o.unit]) / (len * MM_PER_PT);
  // 極端な値（数として表せない・桁あふれする縮尺）は採らない
  return Number.isFinite(s) && s >= MIN_SCALE && s <= MAX_SCALE ? s : null;
}

/** 面積（実寸。単位は o.unit の 2 乗）。多角形の頂点の座標から求める */
export function measureArea(o: MeasureObj): number {
  let a = 0;
  const n = o.pts.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = o.pts[i];
    const [x2, y2] = o.pts[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  const mm = (Math.abs(a) / 2) * MM_PER_PT * MM_PER_PT * o.scale * o.scale;
  return mm / (UNIT_MM[o.unit] * UNIT_MM[o.unit]);
}

/** 数の表し方：大きい数は小数を少なく（有効数字 4 桁ほど） */
function fmtNum(v: number): string {
  const digits = v >= 1000 ? 0 : v >= 100 ? 1 : v >= 10 ? 2 : 3;
  return v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

/** 表示する文字（例：「12.35 m」「4.5 m²」） */
export function measureLabel(o: MeasureObj): string {
  return o.kind === "area" ? `${fmtNum(measureArea(o))} ${o.unit}²` : `${fmtNum(measureLength(o))} ${o.unit}`;
}

/** 文字を置く位置（距離は線の長さの真ん中、面積は頂点の平均）。(x, y) からの相対位置 */
export function labelAnchor(o: MeasureObj): [number, number] {
  if (o.kind === "distance" && o.pts.length >= 2) {
    const seg = o.pts.slice(1).map((p, i) => Math.hypot(p[0] - o.pts[i][0], p[1] - o.pts[i][1]));
    let rest = seg.reduce((s, v) => s + v, 0) / 2;
    for (let i = 0; i < seg.length; i++) {
      if (rest <= seg[i] || i === seg.length - 1) {
        const k = seg[i] ? Math.min(1, rest / seg[i]) : 0;
        const [a, b] = [o.pts[i], o.pts[i + 1]];
        return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
      }
      rest -= seg[i];
    }
  }
  const n = o.pts.length || 1;
  return [o.pts.reduce((s, p) => s + p[0], 0) / n, o.pts.reduce((s, p) => s + p[1], 0) / n];
}

/** 点の並びから、(x, y)・大きさ・相対位置を作り直す（点はページの座標で渡す） */
export function withPoints(o: MeasureObj, abs: [number, number][]): MeasureObj {
  const xs = abs.map((p) => p[0]);
  const ys = abs.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { ...o, x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, pts: abs.map(([px, py]) => [px - x, py - y] as [number, number]) };
}

const helvetica = new WeakMap<PDFDocument, Promise<PDFFont>>();

/** 保存：線（面積は閉じた多角形と薄い塗り）と、白地の上の数値をページに描く */
export async function drawMeasure(doc: PDFDocument, page: PDFPage, item: PageItem, o: MeasureObj): Promise<void> {
  if (o.pts.length < 2) return;
  const M = invert(item.viewTransform);
  const P = (px: number, py: number) => {
    const [x, y] = apply(M, o.x + px, o.y + py);
    return { x, y };
  };
  const hex = /^#?([0-9a-f]{6})$/i.exec(o.color)?.[1] ?? "d6334a";
  const n = parseInt(hex, 16);
  const color = rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  const pts = o.kind === "area" ? [...o.pts, o.pts[0]] : o.pts;
  for (let i = 1; i < pts.length; i++) page.drawLine({ start: P(...pts[i - 1]), end: P(...pts[i]), thickness: 1.2, color });
  // 距離の両端には短い印
  if (o.kind === "distance") {
    for (const [px, py] of [o.pts[0], o.pts[o.pts.length - 1]]) page.drawCircle({ ...P(px, py), size: 1.8, color });
  }
  let fontP = helvetica.get(doc);
  if (!fontP) helvetica.set(doc, (fontP = doc.embedFont(StandardFonts.Helvetica)));
  const font = await fontP;
  const text = measureLabel(o);
  const size = 9;
  const tw = font.widthOfTextAtSize(text, size);
  const [ax, ay] = labelAnchor(o);
  const c = P(ax, ay);
  // 回転したページでも、画面で見た向き（横書き）に数値を書く：画面の横向きが PDF の中でどちらを向くか
  const rad = Math.atan2(M[1], M[0]);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const at = (dx: number, dy: number) => ({ x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos });
  const rotate = degrees((rad * 180) / Math.PI);
  page.drawRectangle({ ...at(-tw / 2 - 2, -size / 2 - 2), width: tw + 4, height: size + 4, rotate, color: rgb(1, 1, 1), opacity: 0.85 });
  page.drawText(text, { ...at(-tw / 2, -size * 0.35), size, font, color, rotate });
}

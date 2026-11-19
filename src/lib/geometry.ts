import type { Matrix } from "./types";

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function invert(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!det) return IDENTITY;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function multiply(m1: Matrix, m2: Matrix): Matrix {
  // pdf.js の Util.transform と同じ規約（m1 * m2）
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export const normRot = (deg: number) => (((Math.round(deg / 90) * 90) % 360) + 360) % 360;

/** CSSで表示用に回転させた要素上のクライアント座標を、回転前のローカル座標に戻す */
export function unrotatePoint(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  innerW: number,
  innerH: number,
  rotation: number,
): [number, number] {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = clientX - cx;
  const dy = clientY - cy;
  const r = (-rotation * Math.PI) / 180;
  const cos = Math.round(Math.cos(r));
  const sin = Math.round(Math.sin(r));
  const rx = dx * cos - dy * sin;
  const ry = dx * sin + dy * cos;
  return [rx + innerW / 2, ry + innerH / 2];
}

/** 角度を -180 < deg <= 180 にそろえる */
export const normAngle = (deg: number) => {
  const r = ((((deg + 180) % 360) + 360) % 360) - 180;
  return r === -180 ? 180 : Math.round(r * 10) / 10;
};

let counter = 0;
export const uid = (p = "o") => `${p}_${Date.now().toString(36)}_${(counter++).toString(36)}`;

// TrueType の字形の「形」を取り出す（位置の違いを除いた輪郭）。
// タイ文字の文書では、母音・声調記号を下の字に合わせてずらした別の字形で描き、その字形に文字の対応（ToUnicode）が
// 付いていないことがある（Word の出力など）。同じフォントの中の、対応が分かっている記号と形を比べて、何の字かを求める。
import { glyphData, type TtfInfo } from "./ttfSubset";

export interface GlyphShape {
  /** 輪郭の構成（輪郭ごとの点の数と、曲線上の点かどうか）。これが違えば別の形 */
  key: string;
  /** 点の座標（最初の点を原点に、輪郭全体の大きいほうの辺を 1 とした値） */
  pts: number[];
}

/**
 * 字形の輪郭を、位置と大きさの違いを除いた形にする。平行移動・拡大縮小しただけの字形は（ほぼ）同じ値になる。
 * 形の無い字形・読めない字形は null。部品 1 つを置いただけの合成字形は、その部品の形を返す。
 */
export function glyphShape(f: TtfInfo, gid: number): GlyphShape | null {
  const g = glyphPoints(f, gid);
  if (!g) return null;
  const { ends, flags, xs, ys } = g;
  const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (!(size > 0)) return null;
  return { key: `${ends.join(",")}|${flags.map((fl) => fl & 1).join("")}`, pts: xs.flatMap((px, i) => [(px - xs[0]) / size, (ys[i] - ys[0]) / size]) };
}

/** 単純な字形（部品 1 つを置いただけの合成字形はその部品）の輪郭の点。読めなければ null */
function glyphPoints(f: TtfInfo, gid: number, depth = 0): { ends: number[]; flags: number[]; xs: number[]; ys: number[] } | null {
  let d: Uint8Array;
  try {
    d = glyphData(f, gid);
  } catch {
    return null;
  }
  if (d.length < 12) return null;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const nc = v.getInt16(0);
  try {
    if (nc < 0) {
      if (depth > 2) return null;
      const flags = v.getUint16(10);
      const sub = v.getUint16(12);
      // 続きの部品がある・縦横で違う拡大縮小や回転がある合成字形は扱わない
      if (flags & (0x20 | 0x40 | 0x80)) return null;
      return glyphPoints(f, sub, depth + 1);
    }
    if (nc === 0) return null;
    let p = 10;
    const ends: number[] = [];
    for (let i = 0; i < nc; i++, p += 2) ends.push(v.getUint16(p));
    const n = ends[ends.length - 1] + 1;
    if (n <= 0 || n > 2000) return null;
    p += 2 + v.getUint16(p);
    const flags: number[] = [];
    while (flags.length < n) {
      const fl = d[p++];
      flags.push(fl);
      if (fl & 8) {
        let r = d[p++];
        while (r-- > 0 && flags.length < n) flags.push(fl);
      }
    }
    const xs: number[] = [];
    let x = 0;
    for (const fl of flags) {
      if (fl & 2) {
        const dx = d[p++];
        x += fl & 16 ? dx : -dx;
      } else if (!(fl & 16)) {
        x += v.getInt16(p);
        p += 2;
      }
      xs.push(x);
    }
    const ys: number[] = [];
    let y = 0;
    for (const fl of flags) {
      if (fl & 4) {
        const dy = d[p++];
        y += fl & 32 ? dy : -dy;
      } else if (!(fl & 32)) {
        y += v.getInt16(p);
        p += 2;
      }
      ys.push(y);
    }
    if (p > d.length) return null;
    return { ends, flags, xs, ys };
  } catch {
    return null;
  }
}

/** 輪郭の囲む面積（向きの逆な輪郭＝穴を引いた値。曲線は数点で近似）。単位は字形の座標の 2 乗。読めなければ null */
export function glyphArea(f: TtfInfo, gid: number): number | null {
  const g = glyphPoints(f, gid);
  if (!g) return null;
  let area = 0;
  let start = 0;
  for (const end of g.ends) {
    const pts: [number, number, boolean][] = [];
    for (let i = start; i <= end; i++) pts.push([g.xs[i], g.ys[i], !!(g.flags[i] & 1)]);
    start = end + 1;
    if (pts.length < 3) continue;
    // 曲線の外の点が続くところには、間に曲線上の点を補う。曲線は中点で近似する
    const on: [number, number][] = [];
    const k = pts.length;
    let s0 = pts.findIndex((q) => q[2]);
    if (s0 < 0) s0 = 0;
    for (let j = 0; j < k; j++) {
      const q = pts[(s0 + j) % k];
      const nx = pts[(s0 + j + 1) % k];
      if (q[2]) on.push([q[0], q[1]]);
      else {
        const prev = on[on.length - 1] ?? [q[0], q[1]];
        const next: [number, number] = nx[2] ? [nx[0], nx[1]] : [(q[0] + nx[0]) / 2, (q[1] + nx[1]) / 2];
        on.push([(prev[0] + 2 * q[0] + next[0]) / 4, (prev[1] + 2 * q[1] + next[1]) / 4]);
        if (!nx[2]) on.push(next);
      }
    }
    for (let j = 0; j < on.length; j++) {
      const [x0, y0] = on[j];
      const [x1, y1] = on[(j + 1) % on.length];
      area += x0 * y1 - x1 * y0;
    }
  }
  return Math.abs(area) / 2;
}

/** 2 つの字形が同じ形か（位置と大きさの違いは無視。点のずれは、字形の大きさの 4% まで） */
export function sameShape(a: GlyphShape, b: GlyphShape): boolean {
  if (a.key !== b.key || a.pts.length !== b.pts.length) return false;
  for (let i = 0; i < a.pts.length; i++) if (Math.abs(a.pts[i] - b.pts[i]) > 0.04) return false;
  return true;
}

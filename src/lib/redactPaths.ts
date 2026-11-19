/**
 * 墨消し：図形（パス）の実削除。
 * コンテンツストリームのパス構築命令（m l c v y h re）と塗り命令（S s f F f* B B* b b* n）を追い、
 * 範囲に掛かるサブパスを幾何的に切り取る：
 * - 範囲に完全に入るサブパスは捨てる
 * - 一部が掛かるサブパスは、塗りは「多角形 − 矩形」、線は「範囲の外側の線分」に置き換える
 *   （範囲に掛かる曲線だけ折れ線に近似し、掛からない曲線はそのまま残す）
 * - 範囲に掛からないサブパスは元の命令のまま残す
 * クリップ（W / W*）を伴うパスは形を変えず、全体が範囲内なら塗りだけやめる（クリップは残す）。
 *
 * 座標はその時点の CTM でページ座標に変換して判定し、出力は逆行列で元のユーザー座標に戻す。
 */
import { type ContentOp, fmt, latin1, num } from "./contentStream";
import { apply, invert, multiply } from "./geometry";
import type { Matrix } from "./types";

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

type Pt = [number, number];

/** 多角形の頂点。c があれば次の頂点までが 3 次ベジェ（制御点 2 つ）。gap は「範囲の中を通る弦」（線としては描かない） */
interface PNode {
  p: Pt;
  c?: [Pt, Pt];
  gap?: boolean;
}

interface Segment {
  /** 終点（l）または制御点 2 つと終点（c）。ユーザー座標 */
  pts: Pt[];
}

interface Subpath {
  /** 構築命令の [最初の op index, 最後の op index] */
  from: number;
  to: number;
  start: Pt;
  segs: Segment[];
  /** h または re で閉じている */
  closed: boolean;
}

const PAINT_OPS = new Set(["S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n"]);
const CONSTRUCT_OPS = new Set(["m", "l", "c", "v", "y", "h", "re"]);

const EPS = 1e-3;
/** 曲線と範囲の交わりを探す標本数 */
const CURVE_SAMPLES = 128;

export interface PathRedactResult {
  /** op index → 置き換え文字列（"" は削除） */
  splices: Map<number, string>;
  /** 切り取ったパスの数 */
  changed: number;
  /** クリップを伴うため形を変えられず、見えなくするだけにしたパスの数 */
  clippedOnly: number;
}

/* ---------- 幾何の小道具 ---------- */

const near = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

function cubicAt(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}

/** 区間 [t0, t1] の部分曲線（de Casteljau） */
function subCubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t0: number, t1: number): [Pt, Pt, Pt, Pt] {
  const right = (q0: Pt, q1: Pt, q2: Pt, q3: Pt, t: number): [Pt, Pt, Pt, Pt] => {
    const a = lerp(q0, q1, t);
    const b = lerp(q1, q2, t);
    const c = lerp(q2, q3, t);
    const d = lerp(a, b, t);
    const e = lerp(b, c, t);
    const f = lerp(d, e, t);
    return [f, e, c, q3];
  };
  const left = (q0: Pt, q1: Pt, q2: Pt, q3: Pt, t: number): [Pt, Pt, Pt, Pt] => {
    const a = lerp(q0, q1, t);
    const b = lerp(q1, q2, t);
    const c = lerp(q2, q3, t);
    const d = lerp(a, b, t);
    const e = lerp(b, c, t);
    const f = lerp(d, e, t);
    return [q0, a, d, f];
  };
  const r = t0 > 0 ? right(p0, p1, p2, p3, t0) : ([p0, p1, p2, p3] as [Pt, Pt, Pt, Pt]);
  const u = t0 < 1 ? (t1 - t0) / (1 - t0) : 1;
  return u < 1 ? left(r[0], r[1], r[2], r[3], u) : r;
}

/**
 * 範囲に掛かる曲線を、範囲の外側の部分曲線と、範囲の中を通る弦（gap）に分ける。
 * 返り値は始点の次からの辺の列（各要素は「その点までの辺」）。
 */
function splitCurveByRects(p0: Pt, p1: Pt, p2: Pt, p3: Pt, rects: Rect[]): { p: Pt; c?: [Pt, Pt]; gap?: boolean }[] {
  // 範囲を 2EPS 広げた矩形で内外を判定する：境界で切った点は、EPS 広げた矩形（多角形の切り抜きで使う）の外側に落ちる
  const wide = rects.map((r) => ({ x0: r.x0 - 2 * EPS, y0: r.y0 - 2 * EPS, x1: r.x1 + 2 * EPS, y1: r.y1 + 2 * EPS }));
  const inside = (t: number) => {
    const q = cubicAt(p0, p1, p2, p3, t);
    return wide.some((r) => inRect(q, r));
  };
  const N = CURVE_SAMPLES;
  const flags: boolean[] = [];
  for (let k = 0; k <= N; k++) flags.push(inside(k / N));
  // 内外が変わる所を二分法で詰める
  const refine = (a: number, b: number): number => {
    let lo = a;
    let hi = b;
    const fa = inside(lo);
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (inside(mid) === fa) lo = mid;
      else hi = mid;
    }
    return fa ? hi : lo; // 外側の点を返す
  };
  const cuts: { t: number; enter: boolean }[] = [];
  for (let k = 0; k < N; k++) {
    if (flags[k] !== flags[k + 1]) cuts.push({ t: refine(k / N, (k + 1) / N), enter: flags[k + 1] });
  }
  const edges: { p: Pt; c?: [Pt, Pt]; gap?: boolean }[] = [];
  let t = 0;
  let inRange = flags[0];
  for (const cut of [...cuts, { t: 1, enter: !inRange }]) {
    if (cut.t > t + 1e-12) {
      if (inRange) edges.push({ p: cubicAt(p0, p1, p2, p3, cut.t), gap: true });
      else {
        const q = subCubic(p0, p1, p2, p3, t, cut.t);
        edges.push({ p: q[3], c: [q[1], q[2]] });
      }
    }
    t = cut.t;
    inRange = cut.enter;
  }
  if (edges.length) edges[edges.length - 1].p = p3;
  return edges;
}

function boundsOf(pts: Pt[]): Rect {
  const r: Rect = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const [x, y] of pts) {
    r.x0 = Math.min(r.x0, x);
    r.y0 = Math.min(r.y0, y);
    r.x1 = Math.max(r.x1, x);
    r.y1 = Math.max(r.y1, y);
  }
  return r;
}

const intersects = (b: Rect, r: Rect) => b.x0 < r.x1 - EPS && b.x1 > r.x0 + EPS && b.y0 < r.y1 - EPS && b.y1 > r.y0 + EPS;
const contains = (r: Rect, b: Rect) => b.x0 >= r.x0 - EPS && b.x1 <= r.x1 + EPS && b.y0 >= r.y0 - EPS && b.y1 <= r.y1 + EPS;
const inRect = (p: Pt, r: Rect) => p[0] > r.x0 && p[0] < r.x1 && p[1] > r.y0 && p[1] < r.y1;

/** 線分 a→b のうち矩形の内側にある区間 [t0, t1]（無ければ null）。Liang–Barsky */
function insideInterval(a: Pt, b: Pt, r: Rect): [number, number] | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  const checks: [number, number][] = [
    [-dx, a[0] - r.x0],
    [dx, r.x1 - a[0]],
    [-dy, a[1] - r.y0],
    [dy, r.y1 - a[1]],
  ];
  for (const [p, q] of checks) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  if (t1 - t0 < 1e-9) return null;
  return [t0, t1];
}

/** サブパスをページ座標の頂点列にする。範囲に掛からない曲線は曲線のまま、掛かる曲線は折れ線にする */
function toNodes(sp: Subpath, ctm: Matrix, rects: Rect[]): PNode[] {
  const P = (p: Pt): Pt => apply(ctm, p[0], p[1]);
  const nodes: PNode[] = [{ p: P(sp.start) }];
  let cur = P(sp.start);
  for (const s of sp.segs) {
    if (s.pts.length === 3) {
      const c1 = P(s.pts[0]);
      const c2 = P(s.pts[1]);
      const end = P(s.pts[2]);
      const b = boundsOf([cur, c1, c2, end]);
      if (rects.some((r) => intersects(b, r))) {
        for (const e of splitCurveByRects(cur, c1, c2, end, rects)) {
          const last = nodes[nodes.length - 1];
          if (e.c) last.c = e.c;
          if (e.gap) last.gap = true;
          nodes.push({ p: e.p });
        }
      } else {
        nodes[nodes.length - 1].c = [c1, c2];
        nodes.push({ p: end });
      }
      cur = end;
    } else {
      cur = P(s.pts[0]);
      nodes.push({ p: cur });
    }
  }
  return nodes;
}

function nodeBounds(nodes: PNode[]): Rect {
  const pts: Pt[] = [];
  for (const n of nodes) {
    pts.push(n.p);
    if (n.c) pts.push(n.c[0], n.c[1]);
  }
  return boundsOf(pts);
}

/* ---------- 多角形 − 矩形（塗り） ---------- */

function signedArea(poly: PNode[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i].p;
    const [x1, y1] = poly[(i + 1) % poly.length].p;
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/** 向きを逆にする（曲線の制御点は前の頂点へ移す） */
function reversePoly(poly: PNode[]): PNode[] {
  const n = poly.length;
  const out: PNode[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const prev = poly[(i - 1 + n) % n];
    const n2: PNode = prev.c ? { p: poly[i].p, c: [prev.c[1], prev.c[0]] } : { p: poly[i].p };
    if (prev.gap) n2.gap = true;
    out.push(n2);
  }
  return out;
}

function pointInPolygon(p: Pt, poly: PNode[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i].p;
    const [xj, yj] = poly[j].p;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 矩形の周上の位置（0..4：下辺→右辺→上辺→左辺、反時計回り） */
function perimeterParam(p: Pt, r: Rect): number {
  const w = r.x1 - r.x0 || 1;
  const h = r.y1 - r.y0 || 1;
  if (Math.abs(p[1] - r.y0) < 1e-6) return (p[0] - r.x0) / w;
  if (Math.abs(p[0] - r.x1) < 1e-6) return 1 + (p[1] - r.y0) / h;
  if (Math.abs(p[1] - r.y1) < 1e-6) return 2 + (r.x1 - p[0]) / w;
  return 3 + (r.y1 - p[1]) / h;
}

interface XNode extends PNode {
  /** 交点か */
  x: boolean;
  /** 交点：矩形の周上の位置 */
  s: number;
  /** 交点：ここから矩形の中へ入る（多角形の進行方向で）か */
  entry: boolean;
  visited: boolean;
}

/**
 * 単純多角形（反時計回り）から矩形を抜く（Weiler–Atherton）。
 * 多角形の外側の部分を進み、矩形に入る交点で矩形の周を時計回りにたどって次の出口へ移る。
 */
function subtractRectCCW(poly: PNode[], r0: Rect): PNode[][] {
  // 境界上の頂点を避けるため、矩形をわずかに広げる
  const r: Rect = { x0: r0.x0 - EPS, y0: r0.y0 - EPS, x1: r0.x1 + EPS, y1: r0.y1 + EPS };
  const n = poly.length;
  const an: XNode[] = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    an.push({ ...a, x: false, s: 0, entry: false, visited: false });
    if (a.c) continue; // 範囲に掛からない曲線：交点は無い
    const iv = insideInterval(a.p, b.p, r);
    if (!iv) continue;
    const [t0, t1] = iv;
    if (t0 > 1e-9) an.push({ p: lerp(a.p, b.p, t0), x: true, s: 0, entry: true, visited: false });
    if (t1 < 1 - 1e-9) an.push({ p: lerp(a.p, b.p, t1), x: true, s: 0, entry: false, visited: false });
  }
  const xs = an.filter((v) => v.x);
  if (!xs.length) {
    // 交点なし：矩形が多角形の中に丸ごと入っていれば穴を開ける（時計回りの矩形）。離れていればそのまま
    const center: Pt = [(r0.x0 + r0.x1) / 2, (r0.y0 + r0.y1) / 2];
    if (pointInPolygon(center, poly)) {
      return [poly, [{ p: [r0.x0, r0.y0] }, { p: [r0.x0, r0.y1] }, { p: [r0.x1, r0.y1] }, { p: [r0.x1, r0.y0] }]];
    }
    return [poly];
  }
  for (const v of xs) v.s = perimeterParam(v.p, r);
  // 矩形の周：角と交点を周上の位置順に
  const corners: XNode[] = [
    { p: [r.x0, r.y0], x: false, s: 0, entry: false, visited: false },
    { p: [r.x1, r.y0], x: false, s: 1, entry: false, visited: false },
    { p: [r.x1, r.y1], x: false, s: 2, entry: false, visited: false },
    { p: [r.x0, r.y1], x: false, s: 3, entry: false, visited: false },
  ];
  const bn = [...corners, ...xs].sort((a, b) => a.s - b.s);
  const out: PNode[][] = [];
  for (const start of xs) {
    if (start.entry || start.visited) continue;
    const ring: PNode[] = [];
    let cur = start;
    let guard = 0;
    for (;;) {
      if (++guard > an.length * 4 + bn.length * 4) break;
      // 多角形を進む（出口から次の入口まで）
      let i = an.indexOf(cur);
      cur.visited = true;
      for (;;) {
        ring.push({ p: an[i].p, ...(an[i].c ? { c: an[i].c } : {}), ...(an[i].gap ? { gap: true } : {}) });
        i = (i + 1) % an.length;
        if (an[i].x) break;
      }
      const entryNode = an[i];
      if (entryNode === start) break;
      ring.push({ p: entryNode.p });
      entryNode.visited = true;
      // 矩形の周を時計回り（位置が減る向き）に進んで次の出口へ
      let k = bn.indexOf(entryNode);
      for (;;) {
        k = (k - 1 + bn.length) % bn.length;
        const node = bn[k];
        if (node.x) {
          cur = node;
          break;
        }
        ring.push({ p: node.p });
      }
      if (cur === start) break;
    }
    if (ring.length >= 3) out.push(ring);
  }
  return out;
}

/** 多角形から矩形を抜く。向きは元のまま保つ */
function subtractRect(poly: PNode[], r: Rect): PNode[][] {
  if (poly.length < 3) return [];
  const ccw = signedArea(poly) >= 0;
  const res = subtractRectCCW(ccw ? poly : reversePoly(poly), r);
  return ccw ? res : res.map(reversePoly);
}

/* ---------- 折れ線 − 矩形（線） ---------- */

/** 折れ線（直線のみ）から矩形の内側を取り除く。各片は点列 */
function subtractRectFromPolyline(pts: Pt[], r: Rect): Pt[][] {
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  const flush = () => {
    if (cur.length >= 2) out.push(cur);
    cur = [];
  };
  if (pts.length === 1) return inRect(pts[0], r) ? [] : [pts];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const iv = insideInterval(a, b, r);
    if (!iv) {
      if (!cur.length) cur.push(a);
      cur.push(b);
      continue;
    }
    const [t0, t1] = iv;
    if (t0 > 1e-9) {
      if (!cur.length) cur.push(a);
      cur.push(lerp(a, b, t0));
    }
    flush();
    if (t1 < 1 - 1e-9) cur = [lerp(a, b, t1), b];
  }
  flush();
  return out;
}

/* ---------- 出力 ---------- */

class PathWriter {
  private parts: string[] = [];
  private open = false;
  constructor(private inv: Matrix) {}
  private xy(p: Pt) {
    const [x, y] = apply(this.inv, p[0], p[1]);
    return `${fmt(x)} ${fmt(y)}`;
  }
  moveTo(p: Pt) {
    this.parts.push(`${this.xy(p)} m`);
    this.open = true;
  }
  lineTo(p: Pt) {
    if (!this.open) this.moveTo(p);
    else this.parts.push(`${this.xy(p)} l`);
  }
  curveTo(c1: Pt, c2: Pt, p: Pt) {
    this.parts.push(`${this.xy(c1)} ${this.xy(c2)} ${this.xy(p)} c`);
  }
  close() {
    if (this.open) this.parts.push("h");
    this.open = false;
  }
  end() {
    this.open = false;
  }
  polygon(poly: PNode[]) {
    poly.forEach((n, i) => {
      if (i === 0) this.moveTo(n.p);
      else this.lineOrCurveTo(poly[i - 1], n.p);
    });
    const last = poly[poly.length - 1];
    if (last.c) this.curveTo(last.c[0], last.c[1], poly[0].p);
    this.close();
  }
  private lineOrCurveTo(prev: PNode, p: Pt) {
    if (prev.c) this.curveTo(prev.c[0], prev.c[1], p);
    else this.lineTo(p);
  }
  /** 線：範囲に掛かる区間を取り除きながら書く */
  polylineMinus(nodes: PNode[], rects: Rect[]) {
    let drawing = false; // 直前の区間の終点まで線が続いているか
    for (let i = 0; i + 1 < nodes.length; i++) {
      const a = nodes[i];
      const b = nodes[i + 1];
      if (a.gap) {
        drawing = false;
        continue;
      }
      if (a.c) {
        if (!drawing) this.moveTo(a.p);
        this.curveTo(a.c[0], a.c[1], b.p);
        drawing = true;
        continue;
      }
      let pieces: Pt[][] = [[a.p, b.p]];
      for (const r of rects) pieces = pieces.flatMap((l) => subtractRectFromPolyline(l, r));
      let endsAtB = false;
      for (const piece of pieces) {
        if (!(drawing && near(piece[0], a.p))) this.moveTo(piece[0]);
        for (let k = 1; k < piece.length; k++) this.lineTo(piece[k]);
        endsAtB = near(piece[piece.length - 1], b.p);
      }
      drawing = pieces.length > 0 && endsAtB;
    }
    this.end();
  }
  toString() {
    return this.parts.join("\n");
  }
}

/* ---------- 本体 ---------- */

export function redactPathOps(ops: ContentOp[], bytes: Uint8Array, rects: Rect[], initialCtm: Matrix = [1, 0, 0, 1, 0, 0]): PathRedactResult {
  const splices = new Map<number, string>();
  let changed = 0;
  let clippedOnly = 0;
  const stack: Matrix[] = [];
  let ctm: Matrix = initialCtm;
  let subpaths: Subpath[] = [];
  let cur: Subpath | null = null;
  let clip = false;
  let current: Pt = [0, 0];
  let subStart: Pt = [0, 0];

  const reset = () => {
    subpaths = [];
    cur = null;
    clip = false;
  };

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const a = op.operands;
    if (CONSTRUCT_OPS.has(op.op)) {
      switch (op.op) {
        case "m":
          current = [num(a[0]), num(a[1])];
          subStart = current;
          cur = { from: i, to: i, start: current, segs: [], closed: false };
          subpaths.push(cur);
          break;
        case "re": {
          const x = num(a[0]);
          const y = num(a[1]);
          const w = num(a[2]);
          const h = num(a[3]);
          cur = { from: i, to: i, start: [x, y], segs: [{ pts: [[x + w, y]] }, { pts: [[x + w, y + h]] }, { pts: [[x, y + h]] }], closed: true };
          subpaths.push(cur);
          current = [x, y];
          subStart = current;
          break;
        }
        case "l":
        case "c":
        case "v":
        case "y": {
          if (!cur) {
            // m 無しの構築（不正）：現在点から始める
            cur = { from: i, to: i, start: current, segs: [], closed: false };
            subpaths.push(cur);
          }
          let seg: Segment;
          if (op.op === "l") seg = { pts: [[num(a[0]), num(a[1])]] };
          else if (op.op === "c") seg = { pts: [[num(a[0]), num(a[1])], [num(a[2]), num(a[3])], [num(a[4]), num(a[5])]] };
          else if (op.op === "v") seg = { pts: [current, [num(a[0]), num(a[1])], [num(a[2]), num(a[3])]] };
          else seg = { pts: [[num(a[0]), num(a[1])], [num(a[2]), num(a[3])], [num(a[2]), num(a[3])]] };
          cur.segs.push(seg);
          cur.to = i;
          current = seg.pts[seg.pts.length - 1];
          break;
        }
        case "h":
          if (cur) {
            cur.closed = true;
            cur.to = i;
            current = subStart;
          }
          break;
      }
      continue;
    }
    if (op.op === "W" || op.op === "W*") {
      clip = true;
      continue;
    }
    if (!PAINT_OPS.has(op.op)) {
      if (op.op === "q") stack.push(ctm);
      else if (op.op === "Q") ctm = stack.pop() ?? ctm;
      else if (op.op === "cm" && a.length >= 6) ctm = multiply(ctm, [num(a[0]), num(a[1]), num(a[2]), num(a[3]), num(a[4]), num(a[5])]);
      continue;
    }
    // 塗り命令
    const paint = op.op;
    const subs = subpaths;
    const wasClip = clip;
    reset();
    if (paint === "n" || !subs.length) continue; // クリップだけのパス（W n）や空のパスは形を変えない
    const det = ctm[0] * ctm[3] - ctm[1] * ctm[2];
    if (Math.abs(det) < 1e-12) continue;
    const inv = invert(ctm);
    const hits = subs.map((sp) => {
      const nodes = toNodes(sp, ctm, rects);
      const b = nodeBounds(nodes);
      const hit = rects.filter((r) => intersects(b, r));
      return { sp, nodes, hit, inside: hit.some((r) => contains(r, b)) };
    });
    if (!hits.some((h) => h.hit.length)) continue;
    const fills = paint !== "S" && paint !== "s";
    const strokes = paint === "S" || paint === "s" || paint[0] === "B" || paint[0] === "b";
    if (wasClip) {
      // クリップを伴う：形は変えず、全体が範囲内なら塗りをやめる（クリップは残る）
      if (hits.every((h) => h.inside)) {
        splices.set(i, "n\n");
        changed++;
      } else clippedOnly++;
      continue;
    }
    const closedByOp = paint === "s" || paint === "b" || paint === "b*";
    const fillOp = paint === "f" || paint === "F" || paint === "B" || paint === "b" ? "f" : "f*";
    const keep: string[] = [];
    const fillW = new PathWriter(inv);
    const strokeW = new PathWriter(inv);
    let fillParts = 0;
    let strokeParts = 0;
    for (const h of hits) {
      if (h.inside) continue;
      if (!h.hit.length) {
        keep.push(latin1(bytes, ops[h.sp.from].start, ops[h.sp.to].end).trim() + (closedByOp && !h.sp.closed ? " h" : ""));
        continue;
      }
      if (fills) {
        // 閉じた多角形として扱う（塗りは暗黙に閉じる）。始点と終点が同じなら重複を落とす
        const poly = h.nodes.length > 1 && near(h.nodes[0].p, h.nodes[h.nodes.length - 1].p) ? h.nodes.slice(0, -1) : h.nodes;
        let polys = [poly];
        for (const r of h.hit) polys = polys.flatMap((p) => subtractRect(p, r));
        for (const p of polys) {
          fillW.polygon(p);
          fillParts++;
        }
      }
      if (strokes) {
        const nodes = h.sp.closed || closedByOp ? [...h.nodes, { p: h.nodes[0].p }] : h.nodes;
        strokeW.polylineMinus(nodes, h.hit);
        strokeParts++;
      }
    }
    const out: string[] = [];
    const fillText = fillW.toString();
    const strokeText = strokeW.toString();
    if (fills && (keep.length || fillParts)) out.push([...keep, fillText].filter(Boolean).join("\n"), fillOp);
    if (strokes && (keep.length || strokeParts)) out.push([...keep, strokeText].filter(Boolean).join("\n"), "S");
    // 構築命令をすべて消し、塗り命令の位置に新しいパスを置く
    for (const sp of subs) for (let k = sp.from; k <= sp.to; k++) if (CONSTRUCT_OPS.has(ops[k].op)) splices.set(k, "");
    splices.set(i, out.length ? `${out.join("\n")}\n` : "n\n");
    changed++;
  }
  return { splices, changed, clippedOnly };
}

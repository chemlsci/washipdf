/**
 * 文書比較の流れ（画面に依存しない）：文字を取り出す → ページを対応づける → 組ごとに文字と見た目を比べる。
 * 描画と文字の取り出しは CompareSide で受け取る（画面ではブラウザーの canvas、試験では Node の canvas）
 */
import {
  alignPages,
  type DiffBox,
  diffImages,
  diffImagesAligned,
  type Hunk,
  type ImageLike,
  imagePrint,
  imageSim,
  MAX_LINES,
  type PagePair,
  rotatePrint,
  textHunks,
  textPrint,
  textSim,
} from "./compare";

/** 表示座標（pt、左上原点、ページの回転を含む）の矩形 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** ページの文字：行と、行の各文字の位置（boxes[行][文字]。文字の位置が分からなければ空） */
export interface PageText {
  lines: string[];
  boxes: Rect[][];
  /** ページの高さ（pt。柱・ページ番号の見分けに使う） */
  height?: number;
}

/** ページ番号だけの行（「3」「- 3 -」「3 / 10」「p. 3」「3 ページ」「iv」など） */
const PAGE_NO = /^[-–—\s]*(?:(?:p|pp|page|pg|s|seite|página|pagina|стр)\.?\s*)?(?:\d{1,4}|[ivxlc]{1,7})(?:\s*(?:\/|／|of|von|de|из)\s*\d{1,4})?\s*(?:ページ|頁|页|쪽|페이지)?[-–—\s]*$/i;

/**
 * 上下の余白（ページの高さの 1 割）にある、ページ番号だけの行。ページを足したり削ったりすると後ろのページ番号が
 * すべて変わるので、文字の比較からは外す
 */
export function pageNumberLines(t: PageText): Set<number> {
  const out = new Set<number>();
  const h = t.height;
  if (!h) return out;
  t.lines.forEach((l, i) => {
    if (!PAGE_NO.test(l.trim())) return;
    const bs = t.boxes[i]?.filter((b) => b.h > 0) ?? [];
    if (!bs.length) return;
    const cy = bs.reduce((s, b) => s + b.y + b.h / 2, 0) / bs.length;
    if (cy < h * 0.1 || cy > h * 0.9) out.add(i);
  });
  return out;
}

export interface CompareSide {
  pageCount: number;
  /** ページの表示の大きさ（pt。ページの回転を含む） */
  size(i: number): { w: number; h: number };
  /** ページの文字 */
  text(i: number): Promise<PageText>;
  /** ページを描く。extraRotation はページの回転にさらに足す角度 */
  render(i: number, scale: number, extraRotation: number): Promise<ImageLike>;
}

export interface PageEntry extends PagePair {
  /** 比べた PDF のページに足して描く角度（向きをそろえるため。0・90・270） */
  rotate: number;
  /** それぞれのページに文字の情報があるか */
  textA: boolean;
  textB: boolean;
  /** 行が多く、先頭だけを比べた */
  truncated: boolean;
  hunks: Hunk[];
  /** 違う語・文字の位置（表示座標 pt。いまの文書のページ・比べた PDF のページ（回す前）） */
  marksA: Rect[];
  marksB: Rect[];
  /** 違いごとの位置（一覧から、その場所へ移るため。削除だけの違いは、比べた PDF ではその次の行） */
  hunkRects: { a: Rect | null; b: Rect | null }[];
  /** 図・画像などの描画の差分（表示の倍率 scale での画素。未計算なら null。大きな文書では表示したページだけ計算する） */
  boxesA: DiffBox[] | null;
  boxesB: DiffBox[] | null;
  /** 見た目に違いがあるか（未確認なら null） */
  visual: boolean | null;
  /** 表示の倍率 */
  scale: number;
}

/** 文字の指紋：よく似ている（同じページの手直し）・少し似ている（書き換え）・移動と見る下限 */
const TEXT_STRONG = 0.85;
const TEXT_WEAK = 0.3;
const TEXT_MOVE = 0.9;
/** 見た目の指紋：同じ紙と見る下限・少し似ている・移動と見る下限 */
const IMAGE_STRONG = 0.7;
const IMAGE_WEAK = 0.55;
const IMAGE_MOVE = 0.75;
/** これ以下のページ数なら、描画の差分も全ページで調べる */
export const FULL_VISUAL_LIMIT = 40;
/** これ以下のページ数なら、縮小した見た目でざっと全ページを調べる */
export const QUICK_VISUAL_LIMIT = 1000;
/** 文字の無いページがあるとき、見た目の指紋を作るページ数の上限（両方の合計） */
export const PRINT_LIMIT = 400;
const FIT_WIDTH = 700;
const QUICK_WIDTH = 300;
const PRINT_WIDTH = 96;

export function entryChanged(e: PageEntry): boolean {
  return e.kind !== "pair" || e.rotate !== 0 || e.hunks.length > 0 || e.visual === true;
}

/** スキャンした紙を含む組は、ずれ・にじみを打ち消して比べる */
export const tolerantFor = (e: PageEntry) => !e.textA || !e.textB;

/** 横向きと縦向き（ほぼ正方形は除く） */
const orient = (s: { w: number; h: number }) => (s.w > s.h * 1.05 ? 1 : s.h > s.w * 1.05 ? -1 : 0);

interface TextItemLike {
  str?: string;
  hasEOL?: boolean;
  transform?: number[];
  width?: number;
  height?: number;
}

const union = (rs: Rect[]): Rect | null => {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rs) {
    if (!r || !(r.w > 0 || r.h > 0)) continue;
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

/**
 * pdf.js の文字の並びを行にし、各文字の位置も求める。改行の印に加えて、横書きで文字の高さほど上下に離れたら別の行とする
 * （改行の印を持たない PDF で、離れた行がつながらないように）。toView は PDF の座標 → 表示座標（無ければそのまま）
 */
export function itemsToText(items: TextItemLike[], toView: (x: number, y: number) => [number, number] = (x, y) => [x, y]): PageText {
  const lines: string[] = [];
  const boxes: Rect[][] = [];
  let cur = "";
  let curBoxes: Rect[] = [];
  let prev: { y: number; h: number } | null = null;
  const push = () => {
    const lead = cur.length - cur.trimStart().length;
    const t = cur.trim();
    if (t) {
      lines.push(t);
      boxes.push(curBoxes.slice(lead, lead + t.length));
    }
    cur = "";
    curBoxes = [];
  };
  const EMPTY: Rect = { x: 0, y: 0, w: 0, h: 0 };
  for (const it of items) {
    if (typeof it.str !== "string") continue;
    const t = it.transform;
    const horizontal = t && Math.abs(t[1]) < 1e-6 && Math.abs(t[2]) < 1e-6 && t[0] > 0;
    if (horizontal && it.str.trim()) {
      const y = t[5];
      const h = Math.abs(it.height || t[3] || 0);
      if (prev && cur.trim() && Math.abs(y - prev.y) > Math.max(h, prev.h) * 0.9) push();
      prev = { y, h };
    } else if (!horizontal && it.str.trim()) prev = null;
    // 文字の位置：幅を文字数で等分する（おおよその位置。色を付ける場所に使う）
    const n = it.str.length;
    if (t && n) {
      const dl = Math.hypot(t[0], t[1]) || 1;
      const ul = Math.hypot(t[2], t[3]) || 1;
      const dx = t[0] / dl;
      const dy = t[1] / dl;
      const ux = t[2] / ul;
      const uy = t[3] / ul;
      const w = it.width ?? 0;
      const h = Math.abs(it.height || ul);
      for (let k = 0; k < n; k++) {
        const s0 = (w * k) / n;
        const s1 = (w * (k + 1)) / n;
        const pts = [
          [s0, -0.22 * h],
          [s1, -0.22 * h],
          [s0, 0.92 * h],
          [s1, 0.92 * h],
        ].map(([a, b]) => toView(t[4] + dx * a + ux * b, t[5] + dy * a + uy * b));
        const xs = pts.map((q) => q[0]);
        const ys = pts.map((q) => q[1]);
        curBoxes.push({ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) });
      }
    } else for (let k = 0; k < n; k++) curBoxes.push(EMPTY);
    cur += it.str;
    if (it.hasEOL) push();
  }
  push();
  return { lines, boxes };
}

/** 行だけ（試験と、文字の位置の要らないところ用） */
export const itemsToLines = (items: TextItemLike[]) => itemsToText(items).lines;

/** 表示の大きさ (w, h) のページを、時計回りに deg 度回したときの矩形 */
export function rotRect(r: Rect, w: number, h: number, deg: number): Rect {
  switch (((deg % 360) + 360) % 360) {
    case 90:
      return { x: h - r.y - r.h, y: r.x, w: r.h, h: r.w };
    case 180:
      return { x: w - r.x - r.w, y: h - r.y - r.h, w: r.w, h: r.h };
    case 270:
      return { x: r.y, y: w - r.x - r.w, w: r.h, h: r.w };
    default:
      return r;
  }
}

export interface CompareResult {
  entries: PageEntry[];
  textsA: PageText[];
  textsB: PageText[];
}

export interface CompareOptions {
  loose: boolean;
  alive?: () => boolean;
  /** 進み具合。phase：text（文字）・match（対応づけ）・visual（見た目） */
  progress?: (phase: "text" | "match" | "visual", done: number, total: number) => void;
  /** 途中の結果（文字の比較が済んだところ） */
  partial?: (r: CompareResult) => void;
}

class Cancelled extends Error {}

/** 2 つの文書を比べる */
export async function compareDocs(A: CompareSide, B: CompareSide, opts: CompareOptions): Promise<CompareResult | null> {
  const alive = opts.alive ?? (() => true);
  const check = () => {
    if (!alive()) throw new Cancelled();
  };
  try {
    // 1. 文字
    const totalPages = A.pageCount + B.pageCount;
    const textsA: PageText[] = [];
    const textsB: PageText[] = [];
    for (let i = 0; i < A.pageCount; i++) {
      check();
      textsA.push({ ...(await A.text(i)), height: A.size(i).h });
      opts.progress?.("text", i + 1, totalPages);
    }
    for (let i = 0; i < B.pageCount; i++) {
      check();
      textsB.push({ ...(await B.text(i)), height: B.size(i).h });
      opts.progress?.("text", A.pageCount + i + 1, totalPages);
    }
    const tpA = textsA.map((x) => textPrint(x.lines));
    const tpB = textsB.map((x) => textPrint(x.lines));
    // 2. 文字の無いページがあれば、見た目の指紋も作る
    let ipA: (Float32Array | null)[] | null = null;
    let ipB: (Float32Array | null)[] | null = null;
    if ((tpA.includes(null) || tpB.includes(null)) && totalPages <= PRINT_LIMIT) {
      ipA = [];
      ipB = [];
      for (let i = 0; i < A.pageCount; i++) {
        check();
        ipA.push(imagePrint(await A.render(i, PRINT_WIDTH / Math.max(1, A.size(i).w), 0)));
        opts.progress?.("match", i + 1, totalPages);
      }
      for (let i = 0; i < B.pageCount; i++) {
        check();
        ipB.push(imagePrint(await B.render(i, PRINT_WIDTH / Math.max(1, B.size(i).w), 0)));
        opts.progress?.("match", A.pageCount + i + 1, totalPages);
      }
    }
    const imgSim = (i: number, j: number): number | null => {
      if (!ipA || !ipB) return null;
      const a = ipA[i];
      const b = ipB[j];
      if (!a && !b) return 1; // どちらも白紙
      if (!a || !b) return 0;
      if (orient(A.size(i)) * orient(B.size(j)) < 0) return Math.max(imageSim(a, rotatePrint(b, 1)), imageSim(a, rotatePrint(b, 3)));
      return imageSim(a, b);
    };
    /** 似ている度合い（文字があれば文字で、無ければ見た目で）。kind：文字のときと見た目のときの下限 */
    const scorer = (tMin: number, iMin: number, noPrint: number) => (i: number, j: number) => {
      const a = tpA[i];
      const b = tpB[j];
      if (a && b) {
        const s = textSim(a, b);
        return s >= tMin ? s : -1;
      }
      const s = imgSim(i, j);
      if (s == null) return noPrint; // 指紋が無い（大きな文書）：順に組にする
      return s >= iMin ? s : -1;
    };
    const pairs = alignPages(A.pageCount, B.pageCount, scorer(TEXT_STRONG, IMAGE_STRONG, 0.4), scorer(TEXT_WEAK, IMAGE_WEAK, 0.4), scorer(TEXT_MOVE, IMAGE_MOVE, -1));
    const entries: PageEntry[] = pairs.map((p) => {
      const sa = p.a != null ? A.size(p.a) : null;
      const sb = p.b != null ? B.size(p.b) : null;
      const w = sa?.w ?? (sb ? Math.max(sb.w, 1) : 595);
      return {
        ...p,
        rotate: 0,
        textA: p.a != null && textsA[p.a].lines.length > 0,
        textB: p.b != null && textsB[p.b].lines.length > 0,
        truncated: false,
        hunks: [],
        marksA: [],
        marksB: [],
        hunkRects: [],
        boxesA: null,
        boxesB: null,
        visual: null,
        scale: Math.min(1.5, FIT_WIDTH / w),
      };
    });
    // 向きの違う組：比べた PDF のページを回してそろえる（90 度か 270 度の、よく重なる方）
    for (const e of entries) {
      if (e.a == null || e.b == null) continue;
      if (orient(A.size(e.a)) * orient(B.size(e.b)) >= 0) continue;
      check();
      const pa = imagePrint(await A.render(e.a, PRINT_WIDTH / Math.max(1, A.size(e.a).w), 0));
      let best = 90;
      let bestSim = -1;
      for (const r of [90, 270]) {
        const pb = imagePrint(await B.render(e.b, PRINT_WIDTH / Math.max(1, B.size(e.b).h), r));
        const s = pa && pb ? imageSim(pa, pb) : 0;
        if (s > bestSim) {
          bestSim = s;
          best = r;
        }
      }
      e.rotate = best;
    }
    const result: CompareResult = { entries, textsA, textsB };
    applyText(result, opts.loose);
    opts.partial?.(result);
    // 3. 見た目：小さな文書は全ページ、大きな文書は縮小してざっと
    const total = Math.max(A.pageCount, B.pageCount);
    const both = entries.filter((e) => e.a != null && e.b != null);
    if (total <= FULL_VISUAL_LIMIT) {
      for (let k = 0; k < both.length; k++) {
        check();
        const e = both[k];
        const d = await visualDiff(A, B, e, result);
        e.boxesA = d.boxesA;
        e.boxesB = d.boxesB;
        e.visual = d.boxesA.length + d.boxesB.length > 0;
        opts.progress?.("visual", k + 1, both.length);
        opts.partial?.(result);
      }
    } else if (entries.length <= QUICK_VISUAL_LIMIT) {
      for (let k = 0; k < both.length; k++) {
        check();
        const e = both[k];
        if (e.hunks.length === 0) {
          const d = await visualDiff(A, B, e, result, QUICK_WIDTH / Math.max(1, A.size(e.a!).w), 8);
          e.visual = d.boxesA.length + d.boxesB.length > 0;
        }
        if (k % 5 === 4 || k === both.length - 1) {
          opts.progress?.("visual", k + 1, both.length);
          opts.partial?.(result);
        }
      }
    }
    return result;
  } catch (e) {
    if (e instanceof Cancelled) return null;
    throw e;
  }
}

/** 文字の比較（空白の扱いを切り替えたときは、これだけをやり直す） */
export function applyText(r: CompareResult, loose: boolean) {
  for (const e of r.entries) {
    e.truncated = false;
    e.hunks = [];
    e.marksA = [];
    e.marksB = [];
    e.hunkRects = [];
    if (e.a == null || e.b == null || !e.textA || !e.textB) continue;
    const ta = r.textsA[e.a];
    const tb = r.textsB[e.b];
    e.truncated = ta.lines.length > MAX_LINES || tb.lines.length > MAX_LINES;
    // ページ番号だけの行を外して比べ、行の番号を元に戻す
    const keep = (t: PageText) => {
      const skip = pageNumberLines(t);
      return t.lines.map((_, i) => i).filter((i) => !skip.has(i));
    };
    const ka = keep(ta);
    const kb = keep(tb);
    e.hunks = textHunks(
      ka.map((i) => ta.lines[i]),
      kb.map((i) => tb.lines[i]),
      loose,
    ).map((h) => ({
      ...h,
      aLines: h.aLines.map((i) => ka[i]),
      bLines: h.bLines.map((i) => kb[i]),
      anchorB: kb[h.anchorB] ?? Math.max(0, tb.lines.length - 1),
      aRefs: h.aRefs.map((c) => ({ ...c, line: ka[c.line] })),
      bRefs: h.bRefs.map((c) => ({ ...c, line: kb[c.line] })),
    }));
    for (const h of e.hunks) {
      const ra = h.aRefs.map((c) => union(ta.boxes[c.line]?.slice(c.start, c.end) ?? [])).filter((x): x is Rect => !!x);
      const rb = h.bRefs.map((c) => union(tb.boxes[c.line]?.slice(c.start, c.end) ?? [])).filter((x): x is Rect => !!x);
      e.marksA.push(...ra);
      e.marksB.push(...rb);
      const lineBox = (t: PageText, ls: number[]) => union(ls.flatMap((l) => t.boxes[l] ?? []));
      e.hunkRects.push({ a: union(ra) ?? lineBox(ta, h.aLines), b: union(rb) ?? lineBox(tb, h.bLines.length ? h.bLines : [h.anchorB]) });
    }
  }
}

/** 画像の上で、文字のある所を白く塗る（文字の違いは語の色付けで示すので、見た目の比較からは外す） */
function maskText(img: ImageLike, rects: Rect[], scale: number) {
  const pad = 1.5;
  for (const r of rects) {
    if (!(r.w > 0 && r.h > 0)) continue;
    const x0 = Math.max(0, Math.floor((r.x - pad / scale) * scale));
    const y0 = Math.max(0, Math.floor((r.y - pad / scale) * scale));
    const x1 = Math.min(img.width, Math.ceil((r.x + r.w) * scale + pad));
    const y1 = Math.min(img.height, Math.ceil((r.y + r.h) * scale + pad));
    for (let y = y0; y < y1; y++) img.data.fill(255, (y * img.width + x0) * 4, (y * img.width + x1) * 4);
  }
}

/**
 * 組のページの、図・画像などの描画の差分（既定は表示の倍率で）。
 * 文字のあるページどうしは、文字を外してから、行を合わせて比べる（上で行が増えて下がずれても、ずれた所は違いにしない）。
 * スキャンした紙を含む組は、ずれ・傾き・にじみを打ち消して比べる
 */
export async function visualDiff(A: CompareSide, B: CompareSide, e: PageEntry, r: CompareResult, scale = e.scale, cell = 12): Promise<{ boxesA: DiffBox[]; boxesB: DiffBox[] }> {
  if (e.a == null || e.b == null) return { boxesA: [], boxesB: [] };
  const [ia, ib] = await Promise.all([A.render(e.a, scale, 0), B.render(e.b, scale, e.rotate)]);
  if (tolerantFor(e)) {
    const boxes = diffImages(ia, ib, cell, 48, { tolerant: true }).boxes;
    return { boxesA: boxes, boxesB: boxes };
  }
  const sb = B.size(e.b);
  maskText(ia, r.textsA[e.a].boxes.flat(), scale);
  maskText(
    ib,
    r.textsB[e.b].boxes.flat().map((x) => rotRect(x, sb.w, sb.h, e.rotate)),
    scale,
  );
  return diffImagesAligned(ia, ib, cell);
}

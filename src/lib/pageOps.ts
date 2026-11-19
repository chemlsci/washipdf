/** ページ一覧に対する一括操作（並べ替え・交互結合・白紙の検出）と、トリミング・サイズ変更の計算 */
import { uid } from "./geometry";
import { clamp, LIMITS } from "./limits";
import { renderToCanvas } from "./render";
import type { PageItem, SourceDoc } from "./types";

export const reversePages = (pages: PageItem[]) => [...pages].reverse();

/**
 * 交互結合：元 PDF A（表）と B（裏）のページを a1, b1, a2, b2 … の順に並べる。
 * reverseB は、両面スキャンで裏面が最後から読み込まれている場合に使う。
 */
export function interleave(pages: PageItem[], srcA: string, srcB: string, reverseB: boolean): PageItem[] {
  const a = pages.filter((p) => p.srcId === srcA);
  let b = pages.filter((p) => p.srcId === srcB);
  if (reverseB) b = [...b].reverse();
  const rest = pages.filter((p) => p.srcId !== srcA && p.srcId !== srcB);
  const out: PageItem[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i]) out.push(a[i]);
    if (b[i]) out.push(b[i]);
  }
  return [...out, ...rest];
}

/** 前半と後半を交互に（1 つの PDF の中で表を先、裏を後にスキャンした場合） */
export function interleaveHalves(pages: PageItem[], reverseSecond: boolean): PageItem[] {
  const half = Math.ceil(pages.length / 2);
  const a = pages.slice(0, half);
  let b = pages.slice(half);
  if (reverseSecond) b = [...b].reverse();
  const out: PageItem[] = [];
  for (let i = 0; i < half; i++) {
    out.push(a[i]);
    if (b[i]) out.push(b[i]);
  }
  return out;
}

export function duplicatePages(pages: PageItem[], ids: string[]): PageItem[] {
  const out: PageItem[] = [];
  for (const x of pages) {
    out.push(x);
    if (ids.includes(x.id)) out.push({ ...x, id: uid("pg"), objects: x.objects.map((o) => ({ ...o, id: uid() })) });
  }
  return out;
}

/**
 * 白紙ページの検出：低解像度で描画し、白でない画素の割合がしきい値未満なら白紙とみなす。
 * 追加したオブジェクトがあるページは白紙としない。
 */
export async function findBlankPages(pages: PageItem[], sources: Map<string, SourceDoc>, threshold = 0.002): Promise<Set<string>> {
  const blank = new Set<string>();
  for (const p of pages) {
    if (p.objects.length) continue;
    if (!p.srcId) {
      blank.add(p.id);
      continue;
    }
    const src = sources.get(p.srcId);
    if (!src) continue;
    const canvas = document.createElement("canvas");
    await renderToCanvas(canvas, src, p.srcIndex, 0.25, p.baseRotation);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) continue;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let dark = 0;
    const total = canvas.width * canvas.height;
    for (let i = 0; i < data.length; i += 4) if (data[i] < 235 || data[i + 1] < 235 || data[i + 2] < 235) dark++;
    if (dark / total < threshold) blank.add(p.id);
  }
  return blank;
}

/** 用紙サイズ（pt） */
export const PAPER_SIZES: { id: string; w: number; h: number }[] = [
  { id: "A4", w: 595.28, h: 841.89 },
  { id: "A3", w: 841.89, h: 1190.55 },
  { id: "A5", w: 419.53, h: 595.28 },
  { id: "B5", w: 515.91, h: 728.5 },
  { id: "B4", w: 728.5, h: 1031.81 },
  { id: "Letter", w: 612, h: 792 },
  { id: "Legal", w: 612, h: 1008 },
  { id: "Tabloid", w: 792, h: 1224 },
];

/** 画像のピクセル数から、用紙に収めたときのページサイズ（pt）を求める */
export function fitImageToPaper(pxW: number, pxH: number, paper: { w: number; h: number } | null, margin = 0): { w: number; h: number; imgW: number; imgH: number } {
  // 用紙指定なし：96dpi として実寸（ただし、PDF で扱えるページの大きさまで。とても大きな画像は、縦横比を保って縮める）
  if (!paper) {
    const k = Math.min(0.75, LIMITS.pagePt.max / Math.max(pxW, pxH, 1));
    const w = Math.max(LIMITS.pagePt.min, pxW * k);
    const h = Math.max(LIMITS.pagePt.min, pxH * k);
    return { w, h, imgW: w, imgH: h };
  }
  const landscape = pxW > pxH;
  const pw = landscape ? Math.max(paper.w, paper.h) : Math.min(paper.w, paper.h);
  const ph = landscape ? Math.min(paper.w, paper.h) : Math.max(paper.w, paper.h);
  // 余白は、画像を置く場所が少しは残る範囲にする（大きすぎる・負の・数でない値で、画像が裏返ったり消えたりしないように）
  const mg = clamp(margin, 0, Math.max(0, (Math.min(pw, ph) - 10) / 2), 0);
  const k = Math.min((pw - mg * 2) / pxW, (ph - mg * 2) / pxH);
  return { w: pw, h: ph, imgW: pxW * k, imgH: pxH * k };
}

/**
 * サイズ変更後の、ページ全体の大きさ（scaleTo）を求める。
 * 用紙に合わせるときは、見えている範囲（トリミング後）が用紙に収まる倍率にする
 * （ページ全体を基準にすると、トリミングしたページは用紙より小さく仕上がってしまう）。
 * 倍率は、できあがるページが PDF で扱える大きさに収まる範囲にする
 */
export function resizeTarget(p: PageItem, to: { percent: number } | { paper: { w: number; h: number } }): { width: number; height: number } {
  const vw = p.crop ? Math.max(1, Math.min(p.width, p.crop.w)) : p.width;
  const vh = p.crop ? Math.max(1, Math.min(p.height, p.crop.h)) : p.height;
  let k: number;
  if ("percent" in to) k = clamp(to.percent, 10, 400, 100) / 100;
  else {
    // 用紙に収まるように縮小／拡大（縦横比を保つ。向きは見えている範囲に合わせる）
    const landscape = vw > vh;
    const pw = landscape ? Math.max(to.paper.w, to.paper.h) : Math.min(to.paper.w, to.paper.h);
    const ph = landscape ? Math.min(to.paper.w, to.paper.h) : Math.max(to.paper.w, to.paper.h);
    k = Math.min(pw / vw, ph / vh);
  }
  const big = Math.max(p.width, p.height);
  const small = Math.min(p.width, p.height);
  k = Math.min(Math.max(k, LIMITS.pagePt.min / small), LIMITS.pagePt.max / big);
  return { width: p.width * k, height: p.height * k };
}

import type { SourceDoc } from "./types";

/**
 * 1 枚の canvas の画素数と一辺の上限。ブラウザーにはこれを超える canvas を作ると、何も言わずに白紙になる上限がある
 * （iPhone / iPad の Safari は約 1,677 万画素、Chrome は約 2.7 億画素だが、その前にメモリが足りなくなる）。
 * 超えるときは倍率を下げて描く（拡大したときに少しぼやけるが、白紙や強制終了にはならない）
 */
const isIOS =
  typeof navigator !== "undefined" && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
export const MAX_CANVAS_PIXELS = isIOS ? 16_000_000 : 32_000_000;
export const MAX_CANVAS_SIDE = isIOS ? 8192 : 16384;

/** 幅 w・高さ h（倍率 1 のとき）のものを、上限に収まる倍率にする */
export function fitScale(w: number, h: number, scale: number): number {
  const area = w * h * scale * scale;
  let s = scale;
  if (area > MAX_CANVAS_PIXELS) s = Math.min(s, Math.sqrt(MAX_CANVAS_PIXELS / (w * h)));
  s = Math.min(s, MAX_CANVAS_SIDE / Math.max(w, h, 1));
  return s;
}

/** ページを canvas に描画する。rotation は /Rotate を含めた絶対角度。倍率は上限に収める（実際に使った倍率を返す） */
export async function renderToCanvas(
  canvas: HTMLCanvasElement,
  doc: SourceDoc,
  index: number,
  scale: number,
  rotation: number,
  signal?: { cancelled: boolean },
): Promise<number> {
  const page = await doc.pdf.getPage(index + 1);
  if (signal?.cancelled) return scale;
  const vp1 = page.getViewport({ scale: 1, rotation });
  const used = fitScale(vp1.width, vp1.height, scale);
  const vp = page.getViewport({ scale: used, rotation });
  const w = Math.max(1, Math.floor(vp.width));
  const h = Math.max(1, Math.floor(vp.height));
  // 描画中に別の描画が始まっても壊れないよう、オフスクリーンに描いてから転写する
  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  const ctx = off.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  try {
    await page.render({ canvas: off, canvasContext: ctx, viewport: vp }).promise;
    if (signal?.cancelled) return used;
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")!.drawImage(off, 0, 0);
  } finally {
    // 描き終えた下書きの canvas はすぐ放す（iPhone / iPad は canvas の合計の大きさにも上限がある）
    off.width = 0;
    off.height = 0;
  }
  return used;
}

const thumbCache = new Map<string, Promise<string>>();

// サムネイル描画は同時に2件まで（大量ページでも画面が固まらないように）
let running = 0;
const queue: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= 2) await new Promise<void>((r) => queue.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    queue.shift()?.();
  }
}

/** サムネイル（dataURL）を取得。回転ごとにキャッシュする。 */
export function getThumbnail(doc: SourceDoc, index: number, rotation: number, targetWidth = 180): Promise<string> {
  const key = `${doc.id}:${index}:${rotation}:${targetWidth}`;
  let p = thumbCache.get(key);
  if (!p) {
    p = limited(async () => {
      const page = await doc.pdf.getPage(index + 1);
      const vp1 = page.getViewport({ scale: 1, rotation });
      // 高 DPR の端末でも 2 倍までにする（サムネイルは縮小表示なので十分。描画と toDataURL が軽くなる）
      const scale = (targetWidth / Math.max(vp1.width, vp1.height)) * Math.min(window.devicePixelRatio || 1, 2);
      const c = document.createElement("canvas");
      await renderToCanvas(c, doc, index, scale, rotation);
      return c.toDataURL("image/jpeg", 0.85);
    });
    p.catch(() => thumbCache.delete(key));
    thumbCache.set(key, p);
  }
  return p;
}

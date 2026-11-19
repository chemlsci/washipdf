/** 元ページにある画像（Do／インライン画像）の位置を表示座標で返す。「既存画像」ツールの枠に使う */
import { apply, multiply } from "./geometry";
import { analyzePage } from "./libDoc";
import type { Matrix, PageItem, SourceDoc } from "./types";

export interface PageImage {
  id: string;
  opIndex: number;
  path: number[];
  name: string;
  /** 表示座標（pt、左上原点） */
  x: number;
  top: number;
  w: number;
  h: number;
  pixelW: number;
  pixelH: number;
  inline: boolean;
}

/** 単位正方形を行列で写した外接矩形 */
export function unitSquareBounds(m: Matrix): { x0: number; y0: number; x1: number; y1: number } {
  const pts = [apply(m, 0, 0), apply(m, 1, 0), apply(m, 0, 1), apply(m, 1, 1)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

export async function getPageImages(doc: SourceDoc, page: PageItem): Promise<PageImage[]> {
  const a = await analyzePage(doc, page.srcIndex);
  const out: PageImage[] = [];
  a.images.forEach((im, i) => {
    const b = unitSquareBounds(multiply(page.viewTransform, im.ctm));
    const w = b.x1 - b.x0;
    const h = b.y1 - b.y0;
    if (w < 0.5 || h < 0.5) return;
    out.push({ id: `img_${page.srcIndex}_${i}`, opIndex: im.index, path: im.path, name: im.name, x: b.x0, top: b.y0, w, h, pixelW: im.width, pixelH: im.height, inline: im.inline });
  });
  return out;
}

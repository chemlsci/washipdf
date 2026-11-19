// 書き換えた行の、保存結果そのものの見た目。
// 字形の並びのままの行（インド系の文字など）は、変えた語だけを同梱フォントで書き直し、ほかは元の字形を残す。
// 画面の文字（DOM）ではこの結果を再現できないので、その 1 ページを実際に書き出して描画し、行の帯を切り出して見せる。
import { buildPdf } from "./exportPdf";
import { closePdf, documentOptions, getPdfJs } from "./pdfjs";
import type { PageItem, SourceDoc, TextEditObj } from "./types";

export interface ExactBand {
  /** 帯の画像（PNG の data URL） */
  url: string;
  /** 帯の位置と大きさ（ページの表示座標、pt） */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 書き換えが反映されたか（false なら、保存しても元のまま残る） */
  applied: boolean;
}

export async function exactEditBand(page: PageItem, source: SourceDoc, obj: TextEditObj, scale: number): Promise<ExactBand | null> {
  let applied = false;
  const item: PageItem = { ...page, extraRotation: 0, crop: undefined, scaleTo: undefined, objects: [obj] };
  const bytes = await buildPdf([item], new Map([[source.id, source]]), new Map(), {
    onEditPath: (how) => {
      if (how !== "unchanged") applied = true;
    },
  });
  const pdfjs = await getPdfJs();
  const pdf = await pdfjs.getDocument({ ...documentOptions(), data: bytes }).promise;
  try {
    const p = await pdf.getPage(1);
    const vp = p.getViewport({ scale });
    const full = document.createElement("canvas");
    full.width = Math.ceil(vp.width);
    full.height = Math.ceil(vp.height);
    const ctx = full.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, full.width, full.height);
    await p.render({ canvas: full, canvasContext: ctx, viewport: vp }).promise;
    // 行の上下に少し余裕を持たせた帯（上下に付く記号や、少し大きい同梱フォントの字が切れないように）。横はページの幅いっぱい
    const y = Math.max(0, obj.y - obj.h * 0.35);
    const h = Math.min(page.height - y, obj.h * 1.7);
    const band = document.createElement("canvas");
    band.width = full.width;
    band.height = Math.max(1, Math.round(h * scale));
    band.getContext("2d")?.drawImage(full, 0, Math.round(y * scale), full.width, band.height, 0, 0, full.width, band.height);
    return { url: band.toDataURL("image/png"), x: 0, y, w: full.width / scale, h: band.height / scale, applied };
  } finally {
    void closePdf(pdf);
  }
}

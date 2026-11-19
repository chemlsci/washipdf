/**
 * 画像の再圧縮に使う canvas の抽象。ブラウザでは HTMLCanvasElement、Node のテストでは @napi-rs/canvas を差し込む。
 * JPEG のデコード／エンコードはブラウザ（または napi）に任せ、純 JS のコーデックは持たない。
 */
import { MAX_CANVAS_PIXELS, MAX_CANVAS_SIDE } from "./render";
export interface RasterCanvas {
  width: number;
  height: number;
  ctx: CanvasRenderingContext2D;
  /** 実体（drawFrom の転送元に使う） */
  el: unknown;
  putPixels(rgba: Uint8ClampedArray): void;
  getPixels(): Uint8ClampedArray;
  /** 別の canvas をこの大きさに縮小して描く */
  drawFrom(src: RasterCanvas, w: number, h: number): void;
  toJpeg(quality: number): Promise<Uint8Array>;
}

export interface DecodedBitmap {
  width: number;
  height: number;
  drawTo(ctx: CanvasRenderingContext2D, w: number, h: number): void;
  close?(): void;
}

export interface CanvasAdapter {
  create(w: number, h: number): RasterCanvas;
  decodeJpeg(bytes: Uint8Array): Promise<DecodedBitmap>;
}

let adapter: CanvasAdapter | null = null;

export function setCanvasAdapter(a: CanvasAdapter): void {
  adapter = a;
}

export function getCanvasAdapter(): CanvasAdapter {
  if (adapter) return adapter;
  if (typeof document === "undefined") throw new Error("canvas adapter is not set");
  adapter = browserAdapter();
  return adapter;
}

function browserAdapter(): CanvasAdapter {
  return {
    create(w, h) {
      // 大きすぎる canvas は、作れたように見えても何も描けない（真っ黒・真っ白の画像になる）。作らずに例外にして、呼び出し側に飛ばさせる
      if (w * h > MAX_CANVAS_PIXELS || Math.max(w, h) > MAX_CANVAS_SIDE) throw new Error(`canvas too large: ${w}x${h}`);
      const el = document.createElement("canvas");
      el.width = w;
      el.height = h;
      const ctx = el.getContext("2d")!;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      return {
        width: w,
        height: h,
        ctx,
        el,
        putPixels: (rgba) => ctx.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0),
        getPixels: () => ctx.getImageData(0, 0, w, h).data,
        drawFrom: (src, dw, dh) => ctx.drawImage(src.el as HTMLCanvasElement, 0, 0, dw, dh),
        toJpeg: async (q) => {
          const blob = await new Promise<Blob>((res, rej) => el.toBlob((b) => (b ? res(b) : rej(new Error("toBlob"))), "image/jpeg", q));
          return new Uint8Array(await blob.arrayBuffer());
        },
      };
    },
    async decodeJpeg(bytes) {
      const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: "image/jpeg" }));
      return {
        width: bmp.width,
        height: bmp.height,
        drawTo: (ctx, w, h) => ctx.drawImage(bmp, 0, 0, w, h),
        close: () => bmp.close(),
      };
    },
  };
}

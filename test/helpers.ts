/**
 * Node.js 上でアプリのライブラリをそのまま動かすための補助。
 * - 同梱フォントを DOM なしで登録する
 * - pdf.js（legacy ビルド）で読み込み・文字抽出・描画する
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PDFDocumentProxy } from "pdfjs-dist";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { preloadAsset } from "@/lib/assets";
import { setCanvasAdapter } from "@/lib/canvasAdapter";
import { setFontRegistry } from "@/lib/fonts";
import { loadPdfFile } from "@/lib/loader";
import { setDocumentOptions } from "@/lib/pdfjs";
import type { PageItem, SourceDoc } from "@/lib/types";

const require = createRequire(import.meta.url);
// テストは esbuild で dist/.test に束ねてから実行するため、import.meta.url ではなく cwd（リポジトリ直下）を基準にする
export const root = process.cwd();
export const fixtures = join(root, "test", "fixtures");

const pdfjsDir = dirname(require.resolve("pdfjs-dist/package.json"));
pdfjs.GlobalWorkerOptions.workerSrc = join(pdfjsDir, "legacy", "build", "pdf.worker.mjs");
const docOptions = {
  isEvalSupported: false,
  useSystemFonts: false,
  cMapUrl: join(pdfjsDir, "cmaps") + "/",
  cMapPacked: true,
  standardFontDataUrl: join(pdfjsDir, "standard_fonts") + "/",
  // JPEG 2000・JBIG2・ICC の復号に使う WASM（アプリでは HTML に同梱している）
  wasmUrl: join(pdfjsDir, "wasm") + "/",
  verbosity: 0,
  // アプリと同じ：フォントごとの文字の対応表も受け取る
  fontExtraProperties: true,
};
setDocumentOptions(docOptions);

// 画像の再圧縮に使う canvas（ブラウザの代わりに @napi-rs/canvas）
{
  const napi = await import("@napi-rs/canvas");
  setCanvasAdapter({
    create(w, h) {
      const el = napi.createCanvas(w, h);
      const ctx = el.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      return {
        width: w,
        height: h,
        ctx: ctx as unknown as CanvasRenderingContext2D,
        el,
        putPixels: (rgba) => ctx.putImageData(new napi.ImageData(rgba as unknown as Uint8ClampedArray, w, h), 0, 0),
        getPixels: () => ctx.getImageData(0, 0, w, h).data as unknown as Uint8ClampedArray,
        drawFrom: (src, dw, dh) => ctx.drawImage(src.el as import("@napi-rs/canvas").Canvas, 0, 0, dw, dh),
        toJpeg: async (q) => new Uint8Array(await el.encode("jpeg", Math.round(q * 100))),
      };
    },
    async decodeJpeg(bytes) {
      const img = await napi.loadImage(Buffer.from(bytes));
      return { width: img.width, height: img.height, drawTo: (ctx, w, h) => (ctx as unknown as import("@napi-rs/canvas").SKRSContext2D).drawImage(img, 0, 0, w, h) };
    },
  });
}

let fontsReady = false;
export function setupFonts() {
  if (fontsReady) return;
  // ビルドと同じ manifest から、全パックのフォントを登録する
  const m = JSON.parse(readFileSync(join(root, "assets/fonts/fonts.json"), "utf8")) as { packs: Record<string, string[]>; fonts: Record<string, { file: string; name: string; family: "sans" | "serif"; scripts: string[]; shaping?: boolean }> };
  const ids = [...new Set(Object.values(m.packs).flat())];
  for (const id of ids) preloadAsset(`font-${id}`, new Uint8Array(readFileSync(join(root, "assets/fonts", m.fonts[id].file))));
  setFontRegistry(ids.map((id) => ({ id, ...m.fonts[id] })));
  fontsReady = true;
}

export async function openPdf(bytes: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  return pdfjs.getDocument({ ...docOptions, data: bytes.slice(), password }).promise;
}

/** アプリと同じ経路（loader.ts）で SourceDoc / PageItem を作る */
export async function loadSource(file: string): Promise<{ doc: SourceDoc; pages: PageItem[]; bytes: Uint8Array }> {
  setupFonts();
  const bytes = new Uint8Array(readFileSync(file));
  // loader は File を受け取るので最小限の互換オブジェクトを渡す
  const fake = { name: file.split("/").pop()!, type: "application/pdf", arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } as unknown as File;
  const r = await loadPdfFile(fake);
  return { ...r, bytes };
}

/** ページの文字列（pdf.js の getTextContent を行単位で結合） */
export async function pageText(pdf: PDFDocumentProxy, pageNo: number): Promise<string> {
  const page = await pdf.getPage(pageNo);
  const c = await page.getTextContent();
  return c.items
    .map((it) => ("str" in it ? it.str : ""))
    .join("")
    .replace(/\u200b/g, "") // 整形フォントの部品グリフは幅ゼロ空白に対応付けている
    .replace(/[⺀-⿟]/g, (ch) => ch.normalize("NFKC"));
}

/** ページを描画して RGBA のピクセル配列を返す */
export async function renderPage(pdf: PDFDocumentProxy, pageNo: number, scale = 2): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const { createCanvas } = await import("@napi-rs/canvas");
  const page = await pdf.getPage(pageNo);
  const vp = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport: vp }).promise;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: img.data as unknown as Uint8ClampedArray, width: canvas.width, height: canvas.height };
}

/** 指定した領域（表示座標 pt）の外側で、変化したピクセルの割合 */
export function diffOutside(
  a: { data: Uint8ClampedArray; width: number; height: number },
  b: { data: Uint8ClampedArray; width: number; height: number },
  exclude: { x: number; y: number; w: number; h: number }[],
  scale: number,
): { changed: number; total: number } {
  let changed = 0;
  let total = 0;
  const ex = exclude.map((r) => ({ x0: (r.x - 2) * scale, y0: (r.y - 2) * scale, x1: (r.x + r.w + 2) * scale, y1: (r.y + r.h + 2) * scale }));
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      if (ex.some((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1)) continue;
      total++;
      const i = (y * a.width + x) * 4;
      const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
      if (d > 40) changed++;
    }
  }
  return { changed, total };
}

export async function savePng(img: { data: Uint8ClampedArray; width: number; height: number }, file: string) {
  const { createCanvas, ImageData } = await import("@napi-rs/canvas");
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.putImageData(new ImageData(img.data as unknown as Uint8ClampedArray, img.width, img.height), 0, 0);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(file, c.toBuffer("image/png"));
}

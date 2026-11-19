/**
 * 圧縮：ページに直接描かれている画像を、表示サイズに対して必要な解像度まで縮小し JPEG で再エンコードする。
 * 元より小さくならない画像は触らない。対応外の形式（JPX・CCITT・マスク付き等）も触らない。
 */
import { PDFDict, type PDFDocument, PDFName, PDFRawStream, PDFRef, PDFStream } from "pdf-lib";
import { getCanvasAdapter } from "./canvasAdapter";
import { encodeG4 } from "./ccitt";
import { tokenizeContent } from "./contentStream";
import { decodeImageXObject, toRgba } from "./imageCodec";
import { pageContentBytes } from "./libDoc";
import { samePath, walkTextOps } from "./textOps";

export interface CompressSettings {
  enabled: boolean;
  /** 表示サイズに対する上限解像度（dpi） */
  dpi: number;
  /** JPEG 品質 0〜1 */
  quality: number;
  grayscale: boolean;
  /** 画像は圧縮しない（見た目が変わらない処理だけを行う） */
  keepImages?: boolean;
  /** 画像を白黒 2 値にする（スキャンした書類向け。写真や色は失われる） */
  bilevel?: boolean;
  /** 小さくならなくても置き換える（グレースケール化で使う） */
  force?: boolean;
}

export const defaultCompress = (): CompressSettings => ({ enabled: false, dpi: 150, quality: 0.8, grayscale: false });

export interface CompressStats {
  images: number;
  recompressed: number;
  skipped: number;
  /** 画像ストリームの合計（バイト）。前後 */
  before: number;
  after: number;
  /** 再圧縮に失敗した画像のエラー（診断用） */
  errors: string[];
  /** 画像以外：1 つにまとめた重複データの数と、圧縮し直したデータの数 */
  merged?: number;
  repacked?: number;
  /** 使っていない字を除いたフォントの数と、それで減った大きさ（バイト） */
  fonts?: number;
  fontSaved?: number;
}

/** 2 値化するときの上限解像度：文字が読める細かさを保つ（JPEG 用の指定より高くする） */
const BILEVEL_DPI = 300;

/** 明るさの分布から、白と黒を分けるしきい値を決める（大津の方法） */
export function otsuThreshold(hist: Uint32Array | number[]): number {
  let total = 0;
  let sum = 0;
  for (let i = 0; i < 256; i++) {
    total += hist[i];
    sum += i * hist[i];
  }
  let wB = 0;
  let sumB = 0;
  let best = -1;
  let lo = 127;
  let hi = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const d = sumB / wB - (sum - sumB) / wF;
    const v = wB * wF * d * d;
    // 同点が続くとき（白と黒の間に何もない画像）は、その真ん中を採る
    if (v > best) {
      best = v;
      lo = hi = i;
    } else if (v === best) hi = i;
  }
  return (lo + hi) >> 1;
}

interface Drawn {
  ref: PDFRef;
  /** 描かれる最大の大きさ（pt） */
  w: number;
  h: number;
}

/** JPEG の標準の量子化表（輝度）。品質の見積もりに使う */
const STD_LUMA = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const ZIGZAG = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];

/**
 * JPEG の品質（1〜100）を、量子化表から見積もる（標準の表の何倍かを、一般的な品質の決め方に当てはめる）。
 * 表が読めなければ 0（＝圧縮し直さない）
 */
export function jpegQuality(data: Uint8Array): number {
  let i = 2;
  while (i + 4 <= data.length && data[i] === 0xff) {
    const marker = data[i + 1];
    const len = (data[i + 2] << 8) | data[i + 3];
    if (marker === 0xda || len < 2) break;
    if (marker === 0xdb) {
      let p = i + 4;
      const end = i + 2 + len;
      while (p < end) {
        const precision = data[p] >> 4;
        const id = data[p] & 15;
        const size = precision ? 128 : 64;
        if (id === 0 && p + 1 + size <= data.length) {
          let ratio = 0;
          for (let k = 0; k < 64; k++) {
            const v = precision ? (data[p + 1 + k * 2] << 8) | data[p + 2 + k * 2] : data[p + 1 + k];
            ratio += v / STD_LUMA[ZIGZAG[k]];
          }
          const scale = (ratio / 64) * 100;
          return Math.max(1, Math.min(100, Math.round(scale <= 100 ? (200 - scale) / 2 : 5000 / scale)));
        }
        p += 1 + size;
      }
    }
    i += 2 + len;
  }
  return 0;
}

/** 各ページの内容を走査して、画像 XObject ごとの最大表示サイズを集める */
function collectDrawnImages(doc: PDFDocument): Map<string, Drawn> {
  const out = new Map<string, Drawn>();
  for (const page of doc.getPages()) {
    let resources: PDFDict | undefined;
    try {
      resources = page.node.Resources();
    } catch {
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = pageContentBytes(doc, page);
    } catch {
      continue;
    }
    const { images, forms } = walkTextOps(doc, bytes, tokenizeContent(bytes), resources);
    for (const im of images) {
      if (im.inline) continue;
      // 画像の名前は、それを描いている内容（ページ、または部品）のリソースで引く。
      // 部品（Form XObject）の中の画像は、その部品のリソースにある（ページのリソースで引くと、見つからないか、別の画像に当たる）
      const res = im.path?.length ? forms.find((f) => samePath(f.path, im.path))?.resources : resources;
      const xobj = res?.lookup(PDFName.of("XObject"));
      const ref = xobj instanceof PDFDict ? xobj.get(PDFName.of(im.name)) : undefined;
      if (!(ref instanceof PDFRef)) continue;
      const w = Math.hypot(im.ctm[0], im.ctm[1]);
      const h = Math.hypot(im.ctm[2], im.ctm[3]);
      const key = ref.toString();
      const cur = out.get(key);
      if (cur) {
        cur.w = Math.max(cur.w, w);
        cur.h = Math.max(cur.h, h);
      } else out.set(key, { ref, w, h });
    }
  }
  return out;
}

export async function compressImages(doc: PDFDocument, s: CompressSettings, onProgress?: (done: number, total: number) => void): Promise<CompressStats> {
  const stats: CompressStats = { images: 0, recompressed: 0, skipped: 0, before: 0, after: 0, errors: [] };
  if (s.keepImages) return stats;
  const drawn = collectDrawnImages(doc);
  const adapter = getCanvasAdapter();
  const ctx = doc.context;
  let done = 0;
  for (const { ref, w, h } of drawn.values()) {
    onProgress?.(++done, drawn.size);
    const stream = ctx.lookup(ref);
    if (!(stream instanceof PDFStream)) continue;
    stats.images++;
    const img = decodeImageXObject(doc, stream);
    if (!img) {
      stats.skipped++;
      continue;
    }
    stats.before += img.bytes;
    // 表示サイズ × dpi が必要な画素数。それより大きければ縮小する
    const dpi = s.bilevel ? BILEVEL_DPI : s.dpi;
    const targetW = Math.max(1, Math.ceil((w / 72) * dpi));
    const targetH = Math.max(1, Math.ceil((h / 72) * dpi));
    const scale = Math.min(1, targetW / img.width, targetH / img.height);
    if (s.bilevel) {
      // 白黒 2 値：透明度のある画像は対象外（下が透けて見える部分の扱いが変わってしまう）
      if (img.smask) {
        stats.after += img.bytes;
        stats.skipped++;
        continue;
      }
      try {
        const newW = Math.max(1, Math.round(img.width * scale));
        const newH = Math.max(1, Math.round(img.height * scale));
        const canvas = adapter.create(newW, newH);
        if (img.kind === "jpeg") {
          const bmp = await adapter.decodeJpeg(img.data);
          bmp.drawTo(canvas.ctx, newW, newH);
          bmp.close?.();
        } else {
          const full = adapter.create(img.width, img.height);
          full.putPixels(toRgba({ kind: img.kind, data: img.data, width: img.width, height: img.height }));
          canvas.drawFrom(full, newW, newH);
        }
        const px = canvas.getPixels();
        const luma = new Uint8Array(newW * newH);
        const hist = new Uint32Array(256);
        for (let i = 0; i < luma.length; i++) hist[(luma[i] = Math.round(0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]))]++;
        const th = otsuThreshold(hist);
        for (let i = 0; i < luma.length; i++) luma[i] = luma[i] <= th ? 1 : 0;
        // ファクス方式（G4）と、1 画素 1 ビットの汎用圧縮の小さいほうを採る（網点や雑音の多い画像は後者が小さい）
        const g4 = encodeG4(luma, newW, newH);
        const rowBytes = (newW + 7) >> 3;
        const packed = new Uint8Array(rowBytes * newH).fill(0xff);
        for (let y = 0; y < newH; y++) for (let x = 0; x < newW; x++) if (luma[y * newW + x]) packed[y * rowBytes + (x >> 3)] &= ~(0x80 >> (x & 7));
        const base = { Type: "XObject", Subtype: "Image", Width: newW, Height: newH, ColorSpace: "DeviceGray", BitsPerComponent: 1 };
        const flate = ctx.flateStream(packed, base);
        const useG4 = g4.length < flate.getContentsSize();
        const total = useG4 ? g4.length : flate.getContentsSize();
        if (!s.force && total >= img.bytes) {
          stats.after += img.bytes;
          stats.skipped++;
          continue;
        }
        ctx.assign(ref, useG4 ? PDFRawStream.of(ctx.obj({ ...base, Filter: "CCITTFaxDecode", DecodeParms: { K: -1, Columns: newW, Rows: newH } }), g4) : flate);
        stats.after += total;
        stats.recompressed++;
      } catch (e) {
        stats.errors.push(e instanceof Error ? e.message : String(e));
        stats.after += img.bytes;
        stats.skipped++;
      }
      continue;
    }
    // すでに必要な解像度以下の JPEG：品質が指定より十分に高いもの（高品質で保存された写真など）だけ、指定の品質で圧縮し直す。
    // そうでないものは触らない（圧縮し直しても小さくならず、画質だけが落ちる）
    if (scale >= 1 && img.kind === "jpeg" && !s.grayscale && jpegQuality(img.data) < s.quality * 100 + 9) {
      stats.after += img.bytes;
      stats.skipped++;
      continue;
    }
    // 解像度を変えない圧縮のやり直しは、1 割以上小さくなるときだけ採る
    const needGain = scale >= 1 && img.kind === "jpeg" && !s.grayscale ? 0.9 : 1;
    const newW = Math.max(1, Math.round(img.width * scale));
    const newH = Math.max(1, Math.round(img.height * scale));
    try {
      const canvas = adapter.create(newW, newH);
      if (img.kind === "jpeg") {
        const bmp = await adapter.decodeJpeg(img.data);
        bmp.drawTo(canvas.ctx, newW, newH);
        bmp.close?.();
      } else {
        const full = adapter.create(img.width, img.height);
        full.putPixels(toRgba({ kind: img.kind, data: img.data, width: img.width, height: img.height }));
        canvas.drawFrom(full, newW, newH);
      }
      if (s.grayscale) {
        const px = canvas.getPixels();
        for (let i = 0; i < px.length; i += 4) {
          const g = Math.round(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]);
          px[i] = px[i + 1] = px[i + 2] = g;
        }
        canvas.putPixels(px);
      }
      const jpeg = await canvas.toJpeg(s.quality);
      let smaskRef: PDFRef | null = null;
      let smaskBytes = 0;
      let smaskData: Uint8Array | null = null;
      if (img.smask) {
        const full = adapter.create(img.smask.width, img.smask.height);
        full.putPixels(toRgba({ kind: "gray", data: img.smask.data, width: img.smask.width, height: img.smask.height }));
        const small = adapter.create(newW, newH);
        small.drawFrom(full, newW, newH);
        const px = small.getPixels();
        smaskData = new Uint8Array(newW * newH);
        for (let i = 0; i < smaskData.length; i++) smaskData[i] = px[i * 4];
      }
      let total = jpeg.length;
      let smaskStream: PDFStream | null = null;
      if (smaskData) {
        smaskStream = ctx.flateStream(smaskData, { Type: "XObject", Subtype: "Image", Width: newW, Height: newH, ColorSpace: "DeviceGray", BitsPerComponent: 8 });
        smaskBytes = smaskStream.getContentsSize();
        total += smaskBytes;
      }
      // グレースケールにする指定のときは、小さくならなくても色のある画像は置き換える（色が残らないように）
      const mustGray = s.grayscale && img.kind !== "gray";
      if (!s.force && !mustGray && total >= img.bytes * needGain) {
        stats.after += img.bytes;
        stats.skipped++;
        continue;
      }
      const oldSmask = stream.dict.get(PDFName.of("SMask"));
      if (smaskStream) smaskRef = ctx.register(smaskStream);
      const dict = ctx.obj({
        Type: "XObject",
        Subtype: "Image",
        Width: newW,
        Height: newH,
        ColorSpace: "DeviceRGB",
        BitsPerComponent: 8,
        Filter: "DCTDecode",
        ...(smaskRef ? { SMask: smaskRef } : {}),
      });
      ctx.assign(ref, PDFRawStream.of(dict, jpeg));
      // 古い SMask は参照されなくなるので消す（pdf-lib は未参照でも書き出してしまうため）
      if (oldSmask instanceof PDFRef) ctx.delete(oldSmask);
      stats.after += total;
      stats.recompressed++;
    } catch (e) {
      stats.errors.push(e instanceof Error ? e.message : String(e));
      stats.after += img.bytes;
      stats.skipped++;
    }
  }
  return stats;
}

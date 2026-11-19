/**
 * 画像 XObject を 8bit の RGB／グレー（または JPEG のバイト列そのもの）に復号する。
 * 対応：Flate／LZW／ASCII 系（PNG・TIFF 予測子付き）、DCTDecode（JPEG、RGB／グレーのみ）、
 *       DeviceRGB／DeviceGray／DeviceCMYK／ICCBased／Indexed／CalRGB／CalGray、1〜16 bpc、SMask（グレー）。
 * 対応外（JPX・CCITT・JBIG2・ステンシルマスク・/Mask 付き・CMYK JPEG）は null を返し、呼び出し側が触らない。
 */
import { decodePDFRawStream, PDFArray, PDFDict, type PDFDocument, PDFHexString, PDFName, PDFNumber, type PDFObject, PDFRawStream, PDFStream, PDFString } from "pdf-lib";

export interface DecodedImage {
  width: number;
  height: number;
  /** jpeg：data は JPEG ファイルそのもの。rgb／gray：8bit の生データ */
  kind: "jpeg" | "rgb" | "gray";
  data: Uint8Array;
  /** ソフトマスク（8bit グレー）。無ければ null */
  smask: { width: number; height: number; data: Uint8Array } | null;
  /** 元のストリーム長の合計（本体＋SMask）。縮小の効果判定に使う */
  bytes: number;
}

const num = (o: PDFObject | undefined, def: number) => (o instanceof PDFNumber ? o.asNumber() : def);

function filterNames(dict: PDFDict, doc: PDFDocument): string[] {
  const f = dict.lookup(PDFName.of("Filter"));
  if (f instanceof PDFName) return [f.decodeText()];
  if (f instanceof PDFArray) return f.asArray().map((x) => doc.context.lookup(x)).map((x) => (x instanceof PDFName ? x.decodeText() : ""));
  return [];
}

function decodeParms(dict: PDFDict, doc: PDFDocument): PDFDict | undefined {
  const p = dict.lookup(PDFName.of("DecodeParms")) ?? dict.lookup(PDFName.of("DP"));
  if (p instanceof PDFDict) return p;
  if (p instanceof PDFArray && p.size()) {
    const last = doc.context.lookup(p.get(p.size() - 1));
    return last instanceof PDFDict ? last : undefined;
  }
  return undefined;
}

/** PNG／TIFF 予測子を外す（pdf-lib の Flate 復号は予測子を扱わない） */
function unpredict(data: Uint8Array, predictor: number, colors: number, bpc: number, columns: number): Uint8Array {
  if (predictor < 2) return data;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  if (predictor === 2) {
    if (bpc !== 8) return data;
    const out = data.slice();
    const rows = Math.floor(out.length / rowLen);
    for (let r = 0; r < rows; r++) {
      const o = r * rowLen;
      for (let i = bpp; i < rowLen; i++) out[o + i] = (out[o + i] + out[o + i - bpp]) & 0xff;
    }
    return out;
  }
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  const prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    const ft = data[r * (rowLen + 1)];
    const src = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
    const dst = out.subarray(r * rowLen, (r + 1) * rowLen);
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? dst[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let x = src[i];
      switch (ft) {
        case 1:
          x += a;
          break;
        case 2:
          x += b;
          break;
        case 3:
          x += (a + b) >> 1;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          x += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
      }
      dst[i] = x & 0xff;
    }
    prev.set(dst);
  }
  return out;
}

/** 行ごとにバイト境界で詰められたサンプルを 1 サンプル 1 要素に展開する（値はそのまま） */
function unpackSamples(data: Uint8Array, width: number, height: number, comps: number, bpc: number): Uint16Array {
  const out = new Uint16Array(width * height * comps);
  const rowBytes = Math.ceil((width * comps * bpc) / 8);
  let o = 0;
  for (let y = 0; y < height; y++) {
    const base = y * rowBytes;
    if (bpc === 8) {
      for (let i = 0; i < width * comps; i++) out[o++] = data[base + i] ?? 0;
    } else if (bpc === 16) {
      for (let i = 0; i < width * comps; i++) out[o++] = ((data[base + i * 2] ?? 0) << 8) | (data[base + i * 2 + 1] ?? 0);
    } else {
      const mask = (1 << bpc) - 1;
      let bit = 0;
      for (let i = 0; i < width * comps; i++) {
        const byte = data[base + (bit >> 3)] ?? 0;
        const shift = 8 - bpc - (bit & 7);
        out[o++] = (byte >> shift) & mask;
        bit += bpc;
      }
    }
  }
  return out;
}

type ColorSpace = { kind: "gray" | "rgb" | "cmyk" } | { kind: "indexed"; base: "gray" | "rgb" | "cmyk"; palette: Uint8Array };

function resolveColorSpace(cs: PDFObject | undefined, doc: PDFDocument, depth = 0): ColorSpace | null {
  if (depth > 4) return null;
  const o = cs ? doc.context.lookup(cs) : undefined;
  if (o instanceof PDFName) {
    switch (o.decodeText()) {
      case "DeviceGray":
      case "G":
      case "CalGray":
        return { kind: "gray" };
      case "DeviceRGB":
      case "RGB":
      case "CalRGB":
        return { kind: "rgb" };
      case "DeviceCMYK":
      case "CMYK":
        return { kind: "cmyk" };
      default:
        return null;
    }
  }
  if (o instanceof PDFArray && o.size()) {
    const fam = doc.context.lookup(o.get(0));
    const name = fam instanceof PDFName ? fam.decodeText() : "";
    if (name === "ICCBased") {
      const s = doc.context.lookup(o.get(1));
      const n = s instanceof PDFStream ? num(s.dict.lookup(PDFName.of("N")), 0) : 0;
      if (n === 1) return { kind: "gray" };
      if (n === 3) return { kind: "rgb" };
      if (n === 4) return { kind: "cmyk" };
      return s instanceof PDFStream ? resolveColorSpace(s.dict.get(PDFName.of("Alternate")), doc, depth + 1) : null;
    }
    if (name === "CalRGB") return { kind: "rgb" };
    if (name === "CalGray") return { kind: "gray" };
    if (name === "Indexed" || name === "I") {
      const base = resolveColorSpace(o.get(1), doc, depth + 1);
      if (!base || base.kind === "indexed") return null;
      const lookup = doc.context.lookup(o.get(3));
      let palette: Uint8Array | null = null;
      if (lookup instanceof PDFString || lookup instanceof PDFHexString) palette = lookup.asBytes();
      else if (lookup instanceof PDFRawStream) palette = decodePDFRawStream(lookup).decode();
      if (!palette) return null;
      return { kind: "indexed", base: base.kind, palette };
    }
    if (name === "DeviceN" || name === "Separation") return null;
  }
  return null;
}

function toRgbOrGray(samples: Uint16Array, width: number, height: number, cs: ColorSpace, bpc: number, invert: boolean): { kind: "rgb" | "gray"; data: Uint8Array } {
  const n = width * height;
  const max = (1 << bpc) - 1;
  const scale = (v: number) => (bpc === 8 ? v : bpc === 16 ? v >> 8 : Math.round((v * 255) / max));
  if (cs.kind === "indexed") {
    const comps = cs.base === "rgb" ? 3 : cs.base === "cmyk" ? 4 : 1;
    const outKind = cs.base === "gray" ? "gray" : "rgb";
    const out = new Uint8Array(n * (outKind === "rgb" ? 3 : 1));
    for (let i = 0; i < n; i++) {
      const idx = samples[i] * comps;
      if (cs.base === "gray") out[i] = cs.palette[idx] ?? 0;
      else if (cs.base === "rgb") {
        out[i * 3] = cs.palette[idx] ?? 0;
        out[i * 3 + 1] = cs.palette[idx + 1] ?? 0;
        out[i * 3 + 2] = cs.palette[idx + 2] ?? 0;
      } else {
        const k = cs.palette[idx + 3] ?? 0;
        out[i * 3] = ((255 - (cs.palette[idx] ?? 0)) * (255 - k)) / 255;
        out[i * 3 + 1] = ((255 - (cs.palette[idx + 1] ?? 0)) * (255 - k)) / 255;
        out[i * 3 + 2] = ((255 - (cs.palette[idx + 2] ?? 0)) * (255 - k)) / 255;
      }
    }
    return { kind: outKind, data: out };
  }
  if (cs.kind === "gray") {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const v = scale(samples[i]);
      out[i] = invert ? 255 - v : v;
    }
    return { kind: "gray", data: out };
  }
  if (cs.kind === "rgb") {
    const out = new Uint8Array(n * 3);
    for (let i = 0; i < n * 3; i++) out[i] = scale(samples[i]);
    return { kind: "rgb", data: out };
  }
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const c = scale(samples[i * 4]);
    const m = scale(samples[i * 4 + 1]);
    const y = scale(samples[i * 4 + 2]);
    const k = scale(samples[i * 4 + 3]);
    out[i * 3] = ((255 - c) * (255 - k)) / 255;
    out[i * 3 + 1] = ((255 - m) * (255 - k)) / 255;
    out[i * 3 + 2] = ((255 - y) * (255 - k)) / 255;
  }
  return { kind: "rgb", data: out };
}

/** 画像 XObject を復号する。対応外なら null */
export function decodeImageXObject(doc: PDFDocument, stream: PDFStream): DecodedImage | null {
  if (!(stream instanceof PDFRawStream)) return null;
  const d = stream.dict;
  const width = num(d.lookup(PDFName.of("Width")) ?? d.lookup(PDFName.of("W")), 0);
  const height = num(d.lookup(PDFName.of("Height")) ?? d.lookup(PDFName.of("H")), 0);
  if (width <= 0 || height <= 0) return null;
  const mask = d.lookup(PDFName.of("ImageMask")) ?? d.lookup(PDFName.of("IM"));
  if (mask && "asBoolean" in mask && typeof mask.asBoolean === "function" && mask.asBoolean()) return null;
  if (d.has(PDFName.of("Mask"))) return null;
  const filters = filterNames(d, doc);
  const cs = resolveColorSpace(d.get(PDFName.of("ColorSpace")) ?? d.get(PDFName.of("CS")), doc);
  if (!cs) return null;
  let smask: DecodedImage["smask"] = null;
  let smaskBytes = 0;
  const sm = d.lookup(PDFName.of("SMask"));
  if (sm instanceof PDFStream) {
    const s = decodeImageXObject(doc, sm);
    if (!s || s.kind === "jpeg") return null;
    let data = s.data;
    if (s.kind === "rgb") {
      data = new Uint8Array(s.width * s.height);
      for (let i = 0; i < data.length; i++) data[i] = s.data[i * 3];
    }
    smask = { width: s.width, height: s.height, data };
    smaskBytes = s.bytes;
  }
  const bytes = stream.contents.length + smaskBytes;

  if (filters.includes("DCTDecode") || filters.includes("DCT")) {
    if (filters.length !== 1 || cs.kind === "cmyk" || cs.kind === "indexed") return null;
    return { width, height, kind: "jpeg", data: stream.contents, smask, bytes };
  }
  if (filters.some((f) => f === "JPXDecode" || f === "CCITTFaxDecode" || f === "CCF" || f === "JBIG2Decode")) return null;
  let raw: Uint8Array;
  try {
    raw = filters.length ? decodePDFRawStream(stream).decode() : stream.contents;
  } catch {
    return null;
  }
  const bpc = num(d.lookup(PDFName.of("BitsPerComponent")) ?? d.lookup(PDFName.of("BPC")), 8);
  if (![1, 2, 4, 8, 16].includes(bpc)) return null;
  const comps = cs.kind === "rgb" ? 3 : cs.kind === "cmyk" ? 4 : 1;
  const parms = decodeParms(d, doc);
  if (parms) {
    const predictor = num(parms.lookup(PDFName.of("Predictor")), 1);
    raw = unpredict(raw, predictor, num(parms.lookup(PDFName.of("Colors")), comps), num(parms.lookup(PDFName.of("BitsPerComponent")), bpc), num(parms.lookup(PDFName.of("Columns")), width));
  }
  if (raw.length < Math.ceil((width * comps * bpc) / 8) * height) return null;
  const decodeArr = d.lookup(PDFName.of("Decode")) ?? d.lookup(PDFName.of("D"));
  const invert = cs.kind === "gray" && decodeArr instanceof PDFArray && decodeArr.size() >= 2 && num(doc.context.lookup(decodeArr.get(0)), 0) === 1;
  const samples = unpackSamples(raw, width, height, comps, bpc);
  const px = toRgbOrGray(samples, width, height, cs, bpc, invert);
  return { width, height, kind: px.kind, data: px.data, smask, bytes };
}

/** 復号結果を RGBA に広げる（canvas に置くため） */
export function toRgba(img: { kind: "rgb" | "gray"; data: Uint8Array; width: number; height: number }): Uint8ClampedArray {
  const n = img.width * img.height;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    if (img.kind === "gray") {
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = img.data[i];
    } else {
      out[i * 4] = img.data[i * 3];
      out[i * 4 + 1] = img.data[i * 3 + 1];
      out[i * 4 + 2] = img.data[i * 3 + 2];
    }
    out[i * 4 + 3] = 255;
  }
  return out;
}

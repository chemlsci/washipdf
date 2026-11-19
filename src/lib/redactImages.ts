/**
 * 墨消し：範囲に一部だけ掛かる画像は、丸ごと消さずに「その範囲の画素だけ」を塗りつぶした画像に差し替える。
 * スキャンした文書（ページ全体が 1 枚の画像）でも、消したい所だけを消せるようにするため。
 * - 元の画像データは出力に残さない（塗りつぶした複製を新しく作り、ページの描画命令をそちらに向ける）。
 *   同じ画像を使うほかのページは変わらない。
 * - JPEG は復号して塗り、JPEG で書き直す（わずかに再圧縮される）。それ以外は可逆（Flate）で書き直す。
 * - 自前で復号できない形式（ファクス形式〈CCITT〉・JBIG2・JPEG 2000 など。白黒のスキャンに多い）は、表示に使っている
 *   pdf.js が復号した画素を使う。白黒 2 値の画像は 2 値のまま書き直す（大きくなりすぎないように）。
 * - マスク付きの画像、型抜き（ImageMask）、インライン画像、Form XObject の中の画像、pdf.js の描画の並びと対応が取れない
 *   ページは対象外。それらは従来どおり画像全体を取り除く（呼び出し側が警告を出す）。
 */
import { type PDFDocument, PDFName, type PDFPage, PDFRawStream, type PDFRef, type PDFStream } from "pdf-lib";
import { getCanvasAdapter } from "./canvasAdapter";
import { tokenizeContent } from "./contentStream";
import { apply, invert } from "./geometry";
import { decodeImageXObject, toRgba } from "./imageCodec";
import { pageContentBytes } from "./libDoc";
import { unitSquareBounds } from "./pageImages";
import { displayRectToPage, lookupXObject, type Rect } from "./redact";
import { pathKey, samePath, walkTextOps } from "./textOps";
import { getPdfJs } from "./pdfjs";
import type { PageItem, RedactObj, SourceDoc } from "./types";

export interface ImageRedaction {
  /** 画像の描画命令（ページ直下の Do）の番号 → 差し替える画像（塗りつぶした複製） */
  /** 差し替える画像：描画命令の場所（pathKey）→ 塗りつぶした複製 */
  replacements: Map<string, PDFRef>;
  /** 範囲に掛かるが、消す画素が無いのでそのまま残す画像（範囲より大きい画素だけの背景、外周の余白にだけ掛かった画像） */
  keep: Set<string>;
  /** 一部だけ塗りつぶした画像の数 */
  partial: number;
  /** 一部だけを消せず、画像全体を取り除くことになる画像の数 */
  whole: number;
}

const hexColor = (c: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c.trim());
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
};

interface PdfJsImage {
  width: number;
  height: number;
  kind?: number;
  data?: Uint8Array | Uint8ClampedArray;
  bitmap?: unknown;
}

/**
 * pdf.js が復号した画像を RGBA で取り出す。ordinal は、ページの内容の中で何番目の画像の描画か（Form XObject の中も含めた実行順）。
 * pdf.js 側の画像の描画の数が合わない（まとめ描きの最適化が掛かった等）ときや、大きさが合わないときは null。
 */
async function pixelsViaPdfJs(
  src: SourceDoc,
  pageIndex: number,
  ordinal: number,
  total: number,
  W: number,
  H: number,
  /** 同じ大きさの画像の中での順番と、その数（ページ全体の数が合わないときに、大きさで対応を取る） */
  sameSize?: { ordinal: number; total: number },
): Promise<{ px: Uint8ClampedArray; bilevel: boolean } | null> {
  const pdfjs = await getPdfJs();
  const page = await src.pdf.getPage(pageIndex + 1);
  const list = await page.getOperatorList();
  const OPS = pdfjs.OPS as Record<string, number>;
  // 画像を描く命令を、実行順に並べる。1 つの命令が 1 回の描画に当たるものだけを数え、それ以外が混ざっていたら対応付けをあきらめる
  const single = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject]);
  const grouped = new Set([OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObjectGroup, OPS.paintImageMaskXObjectRepeat, OPS.paintInlineImageXObjectGroup, OPS.paintSolidColorImageMask].filter((x) => x != null));
  const draws: { fn: number; args: unknown[] }[] = [];
  let hasGrouped = false;
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i];
    if (grouped.has(fn)) hasGrouped = true;
    if (single.has(fn)) draws.push({ fn, args: list.argsArray[i] as unknown[] });
  }
  let d: { fn: number; args: unknown[] } | undefined;
  if (!hasGrouped && draws.length === total) d = draws[ordinal];
  else if (sameSize) {
    // 数が合わない（大きさ 0 の画像が省かれた、小さな画像がまとめ描きになった 等）：同じ大きさの画像どうしで、順番を合わせる
    const same = draws.filter((x) => x.fn === OPS.paintImageXObject && x.args[1] === W && x.args[2] === H);
    if (same.length === sameSize.total) d = same[sameSize.ordinal];
  }
  if (!d || d.fn !== OPS.paintImageXObject || typeof d.args[0] !== "string") return null;
  const id = d.args[0];
  const store = (id.startsWith("g_") ? page.commonObjs : page.objs) as unknown as { get(id: string, cb: (o: unknown) => void): void };
  const obj = await new Promise<PdfJsImage | null>((resolve) => {
    const tm = setTimeout(() => resolve(null), 20_000);
    try {
      store.get(id, (o) => {
        clearTimeout(tm);
        resolve((o as PdfJsImage) ?? null);
      });
    } catch {
      clearTimeout(tm);
      resolve(null);
    }
  });
  if (!obj || obj.width !== W || obj.height !== H) return null;
  const px = new Uint8ClampedArray(W * H * 4);
  if (obj.data) {
    const data = obj.data;
    if (obj.kind === 1) {
      // 1 画素 1 ビット（行ごとにバイト境界へ詰める）。1 が白、0 が黒
      const row = (W + 7) >> 3;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const v = (data[y * row + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
          const i = (y * W + x) * 4;
          px[i] = px[i + 1] = px[i + 2] = v;
          px[i + 3] = 255;
        }
      }
      return { px, bilevel: true };
    }
    if (obj.kind === 2 && data.length >= W * H * 3) {
      for (let i = 0, o = 0; i < W * H; i++, o += 4) {
        px[o] = data[i * 3];
        px[o + 1] = data[i * 3 + 1];
        px[o + 2] = data[i * 3 + 2];
        px[o + 3] = 255;
      }
      return { px, bilevel: false };
    }
    if (obj.kind === 3 && data.length >= W * H * 4) {
      px.set(data.subarray(0, W * H * 4));
      for (let o = 3; o < px.length; o += 4) px[o] = 255;
      return { px, bilevel: false };
    }
    return null;
  }
  if (obj.bitmap) {
    // ブラウザでは、復号済みのビットマップで渡されることがある
    const canvas = getCanvasAdapter().create(W, H);
    (canvas.ctx as CanvasRenderingContext2D).drawImage(obj.bitmap as CanvasImageSource, 0, 0, W, H);
    return { px: canvas.getPixels(), bilevel: false };
  }
  return null;
}

const contains = (outer: Rect, inner: Rect) => outer.x0 <= inner.x0 + 0.01 && outer.y0 <= inner.y0 + 0.01 && outer.x1 >= inner.x1 - 0.01 && outer.y1 >= inner.y1 - 0.01;
const overlaps = (a: Rect, b: Rect) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0;

export async function redactImageRegions(doc: PDFDocument, page: PDFPage, item: PageItem, redacts: RedactObj[], src?: SourceDoc): Promise<ImageRedaction> {
  const res: ImageRedaction = { replacements: new Map(), keep: new Set(), partial: 0, whole: 0 };
  if (!redacts.length) return res;
  const bytes = pageContentBytes(doc, page);
  const ops = tokenizeContent(bytes);
  const resources = page.node.Resources();
  const walked = walkTextOps(doc, bytes, ops, resources);
  const areas = redacts.map((r) => ({ rect: displayRectToPage(item, r), color: hexColor(r.fill) }));
  // 同じ大きさ（画素数）のページ直下の画像の中で、何番目か
  const sameSizeOf = (im: (typeof walked.images)[number]) => {
    const same = walked.images.filter((x) => !x.inline && x.width === im.width && x.height === im.height);
    return { ordinal: same.indexOf(im), total: same.length };
  };
  for (const im of walked.images) {
    const bounds = unitSquareBounds(im.ctm);
    const hits = areas.filter((a) => overlaps(a.rect, bounds));
    if (!hits.length) continue;
    // 画像全体が範囲に入るなら、従来どおり描画命令ごと取り除く
    if (hits.some((a) => contains(a.rect, bounds))) continue;
    if (im.inline) {
      res.whole++;
      continue;
    }
    try {
      // 部品（Form XObject）の中の画像は、その部品のリソースから探す
      const stream = lookupXObject(im.path.length ? walked.forms.find((f) => samePath(f.path, im.path))?.resources : resources, im.name);
      if (!stream) {
        res.whole++;
        continue;
      }
      const img = decodeImageXObject(doc, stream);
      const adapter = getCanvasAdapter();
      let W = img?.width ?? im.width;
      let H = img?.height ?? im.height;
      let px: Uint8ClampedArray;
      /** 書き直すときの形式 */
      let mode: "jpeg" | "rgb" | "gray" | "bilevel";
      if (!img) {
        // 自前で復号できない形式：マスクの無い画像に限り、pdf.js が復号した画素を使う
        const has = (k: string) => stream.dict.has(PDFName.of(k));
        const isMask = String(stream.dict.lookup(PDFName.of("ImageMask"))) === "true";
        const alt = !src || isMask || has("SMask") || has("Mask") || !W || !H ? null : await pixelsViaPdfJs(src, item.srcIndex, walked.images.indexOf(im), walked.images.length, W, H, sameSizeOf(im));
        if (!alt) {
          res.whole++;
          continue;
        }
        px = alt.px;
        mode = alt.bilevel ? "bilevel" : "rgb";
      } else if (img.kind === "jpeg") {
        W = img.width;
        H = img.height;
        mode = "jpeg";
        const canvas = adapter.create(W, H);
        const bmp = await adapter.decodeJpeg(img.data);
        bmp.drawTo(canvas.ctx, W, H);
        bmp.close?.();
        px = canvas.getPixels();
      } else {
        px = toRgba({ kind: img.kind, data: img.data, width: W, height: H });
        mode = img.kind;
      }

      // 画像の単位正方形（左下原点）→ ページ座標が im.ctm。画素 (x, y)（上の行が y=0）の中心をページ座標へ写し、範囲内なら塗る
      const inv = invert(im.ctm);
      let painted = 0;
      // 塗った画素（透明度のマスクも、同じ所を不透明にするために覚える）
      const hitPx = new Uint8Array(W * H);
      for (const a of hits) {
        const r = a.rect;
        const corners = [apply(inv, r.x0, r.y0), apply(inv, r.x1, r.y0), apply(inv, r.x0, r.y1), apply(inv, r.x1, r.y1)];
        const us = corners.map((c) => c[0] * W);
        const vs = corners.map((c) => (1 - c[1]) * H);
        // 範囲に少しでも掛かる画素を候補にする（端の画素を取りこぼさないよう 1 画素広げる）
        const x0 = Math.max(0, Math.floor(Math.min(...us)) - 1);
        const x1 = Math.min(W - 1, Math.ceil(Math.max(...us)) + 1);
        const y0 = Math.max(0, Math.floor(Math.min(...vs)) - 1);
        const y1 = Math.min(H - 1, Math.ceil(Math.max(...vs)) + 1);
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            // 画素がページ上で占める四角（外接矩形）が範囲と重なれば塗る。
            // 画素の大きさで範囲を広げる方法は、1 画素が大きい画像（1 画素幅の帯を引き伸ばした背景など）で全体を塗ってしまう
            const [ax, ay] = apply(im.ctm, x / W, 1 - y / H);
            const [bx, by] = apply(im.ctm, (x + 1) / W, 1 - (y + 1) / H);
            const [cx, cy] = apply(im.ctm, (x + 1) / W, 1 - y / H);
            const [dx, dy] = apply(im.ctm, x / W, 1 - (y + 1) / H);
            if (Math.max(ax, bx, cx, dx) <= r.x0 || Math.min(ax, bx, cx, dx) >= r.x1 || Math.max(ay, by, cy, dy) <= r.y0 || Math.min(ay, by, cy, dy) >= r.y1) continue;
            // 範囲より大きい画素（帯やグラデーションを引き伸ばした背景）は塗らない：塗ると範囲の外まで色が変わる。
            // そのような画素は 1 色の面でしかなく、読める情報を持たない（見た目は、上に描く墨消しの四角で隠れる）
            if (Math.max(ax, bx, cx, dx) - Math.min(ax, bx, cx, dx) > r.x1 - r.x0 || Math.max(ay, by, cy, dy) - Math.min(ay, by, cy, dy) > r.y1 - r.y0) continue;
            const i = (y * W + x) * 4;
            px[i] = a.color[0];
            px[i + 1] = a.color[1];
            px[i + 2] = a.color[2];
            px[i + 3] = 255;
            hitPx[y * W + x] = 1;
            painted++;
          }
        }
      }
      if (!painted) {
        res.keep.add(pathKey(im.path, im.index));
        continue;
      } // 画像の外周の余白にだけ掛かっていた（消す画素が無い）

      const ctx = doc.context;
      // 透明度のマスク（SMask）：元のまま付け直すと、消した所の形（文字の輪郭など）がマスクに残る。
      // 塗った所を「不透明」にした写しを作って付ける。マスクを読めない形式のときは、画像ごと取り除く（安全側）
      let smask: PDFRef | undefined;
      if (stream.dict.has(PDFName.of("SMask"))) {
        const m = img?.smask;
        if (!m || !m.width || !m.height) {
          res.whole++;
          continue;
        }
        const data = m.data.slice();
        for (let y = 0; y < m.height; y++) {
          const sy = Math.min(H - 1, Math.floor(((y + 0.5) / m.height) * H));
          for (let x = 0; x < m.width; x++) {
            const sx = Math.min(W - 1, Math.floor(((x + 0.5) / m.width) * W));
            if (hitPx[sy * W + sx]) data[y * m.width + x] = 255;
          }
        }
        smask = ctx.register(ctx.flateStream(data, { Type: "XObject", Subtype: "Image", Width: m.width, Height: m.height, ColorSpace: "DeviceGray", BitsPerComponent: 8 }));
      }
      const base = { Type: "XObject", Subtype: "Image", Width: W, Height: H, BitsPerComponent: 8, ...(smask ? { SMask: smask } : {}) };
      const grayFill = hits.every((a) => a.color[0] === a.color[1] && a.color[1] === a.color[2]);
      // ブラウザでは白黒 2 値の画像もビットマップで渡されることがある。画素がすべて真っ黒か真っ白なら 2 値として書く
      if (mode === "rgb" && grayFill && hits.every((a) => a.color[0] === 0 || a.color[0] === 255)) {
        let two = true;
        for (let i = 0; i < px.length; i += 4) {
          const v = px[i];
          if ((v !== 0 && v !== 255) || px[i + 1] !== v || px[i + 2] !== v) {
            two = false;
            break;
          }
        }
        if (two) mode = "bilevel";
      }
      let next: PDFStream;
      if (mode === "jpeg") {
        const canvas = adapter.create(W, H);
        canvas.putPixels(px);
        const jpeg = await canvas.toJpeg(0.92);
        next = PDFRawStream.of(ctx.obj({ ...base, ColorSpace: "DeviceRGB", Filter: "DCTDecode" }), jpeg);
      } else if (mode === "bilevel" && grayFill) {
        // 白黒 2 値のまま（1 画素 1 ビット）。塗る色は、明るさで黒か白に寄せる
        const row = (W + 7) >> 3;
        const data = new Uint8Array(row * H);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (px[(y * W + x) * 4] >= 128) data[y * row + (x >> 3)] |= 0x80 >> (x & 7);
        next = ctx.flateStream(data, { ...base, BitsPerComponent: 1, ColorSpace: "DeviceGray" });
      } else {
        let gray = (mode === "gray" || mode === "bilevel") && grayFill;
        if (mode === "rgb" && grayFill) {
          // 灰色だけの画像（スキャンに多い）は 1 成分で書いて小さくする
          gray = true;
          for (let i = 0; i < px.length; i += 4) {
            if (px[i] !== px[i + 1] || px[i] !== px[i + 2]) {
              gray = false;
              break;
            }
          }
        }
        const data = new Uint8Array(W * H * (gray ? 1 : 3));
        for (let i = 0, o = 0; i < W * H; i++) {
          if (gray) data[o++] = px[i * 4];
          else {
            data[o++] = px[i * 4];
            data[o++] = px[i * 4 + 1];
            data[o++] = px[i * 4 + 2];
          }
        }
        next = ctx.flateStream(data, { ...base, ColorSpace: gray ? "DeviceGray" : "DeviceRGB" });
      }
      // ここではページのリソースに登録しない（登録するとページが正規化されて内容の命令番号がずれる）。
      // 名前を付けて登録するのは、内容を書き換える rewritePageContent の側
      res.replacements.set(pathKey(im.path, im.index), ctx.register(next));
      res.partial++;
    } catch {
      res.whole++;
    }
  }
  return res;
}

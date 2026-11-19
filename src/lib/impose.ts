/**
 * 面付け：N-up（1 枚に複数ページ）と小冊子（中綴じの順に 2-up）。
 * 組み立て済みの PDF バイト列を受け取り、新しい PDF を返す。
 */
import { degrees, PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, type PDFPage, PDFRef, PDFStream, rgb } from "pdf-lib";
import { clamp, LIMITS } from "./limits";
import { PAPER_SIZES } from "./pageOps";
import { encryptDocument, type SecuritySettings } from "./security";

export type PerSheet = 2 | 4 | 6 | 8 | 9 | 16;

export interface ImposeOptions {
  perSheet: PerSheet;
  /** 用紙 id（PAPER_SIZES）。"same" なら元の 1 ページ目と同じ大きさ */
  paper: string;
  /** "auto"：枠が横長になる配置なら横向き */
  orientation: "auto" | "portrait" | "landscape";
  /** 余白（pt） */
  margin: number;
  /** ページ間の間隔（pt） */
  gap: number;
  /** 小冊子（中綴じ）。perSheet は 2 になる */
  booklet: boolean;
  /** 右綴じ（右から左へ並べる） */
  rightToLeft: boolean;
  /** 各ページに細い枠線を引く */
  border: boolean;
}

export const defaultImpose = (): ImposeOptions => ({ perSheet: 2, paper: "A4", orientation: "auto", margin: 28.35, gap: 14.17, booklet: false, rightToLeft: false, border: false });

export function gridFor(perSheet: PerSheet): { cols: number; rows: number } {
  switch (perSheet) {
    case 2:
      return { cols: 2, rows: 1 };
    case 4:
      return { cols: 2, rows: 2 };
    case 6:
      return { cols: 3, rows: 2 };
    case 8:
      return { cols: 4, rows: 2 };
    case 9:
      return { cols: 3, rows: 3 };
    case 16:
      return { cols: 4, rows: 4 };
  }
}

/**
 * 中綴じの並び。n ページを 4 の倍数に切り上げ、各シートの表（左・右）、裏（左・右）の順にページ番号（0 始まり）を返す。
 * 足りない分は -1（白紙）。例：5 ページ → 8 に切り上げ、[7,0, 1,6, 5,2, 3,4] の 5 以上を -1 にして [-1,0, 1,-1, -1,2, 3,4]
 */
export function bookletOrder(n: number): number[] {
  const total = Math.ceil(n / 4) * 4;
  const out: number[] = [];
  for (let k = 0; k < total / 4; k++) {
    out.push(total - 1 - 2 * k, 2 * k, 2 * k + 1, total - 2 - 2 * k);
  }
  return out.map((i) => (i < n ? i : -1));
}

const num = (o: unknown): number | null => (o instanceof PDFNumber && Number.isFinite(o.asNumber()) ? o.asNumber() : null);

/** 数値 4 つの配列（矩形）を [x0, y0, x1, y1]（左下・右上）にそろえて返す */
function rectOf(o: unknown): [number, number, number, number] | null {
  if (!(o instanceof PDFArray) || o.size() < 4) return null;
  const v = [0, 1, 2, 3].map((i) => num(o.lookup(i)));
  if (v.some((x) => x === null)) return null;
  const [a, b, c, d] = v as number[];
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}

/**
 * 注釈と入力欄を、見た目（外観ストリーム /AP /N）のままページの内容に描き込む。
 * 面付けはページの内容だけを写すので、そのままではハイライト・付箋・手書き・入力欄の中身が消えてしまう。
 * 見た目を持たない注釈（リンク、ビューアーが描く注釈）と、付箋のコメントの吹き出しは対象外。
 * 返り値は、描き込んだ注釈の数。
 */
export function flattenAnnotations(doc: PDFDocument): number {
  const ctx = doc.context;
  let count = 0;
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    const draws: string[] = [];
    const toDraw: { ref: PDFRef; m: number[] }[] = [];
    for (const a of annots.asArray()) {
      const d = a instanceof PDFRef ? ctx.lookup(a) : a;
      if (!(d instanceof PDFDict)) continue;
      const subtype = d.lookup(PDFName.of("Subtype"));
      const kind = subtype instanceof PDFName ? subtype.decodeText() : "";
      if (kind === "Link" || kind === "Popup") continue;
      // 隠してある注釈（Hidden・NoView）は、画面でも見えていない
      const flags = num(d.lookup(PDFName.of("F"))) ?? 0;
      if (flags & 2 || flags & 32) continue;
      const ap = d.lookup(PDFName.of("AP"));
      if (!(ap instanceof PDFDict)) continue;
      // /N は外観そのものか、状態ごとの外観の辞書（チェックボックスなど。いまの状態は /AS）
      let nRef = ap.get(PDFName.of("N"));
      let n = ap.lookup(PDFName.of("N"));
      if (n instanceof PDFDict && !(n instanceof PDFStream)) {
        const as = d.lookup(PDFName.of("AS"));
        if (!(as instanceof PDFName)) continue;
        nRef = n.get(as);
        n = n.lookup(as);
      }
      if (!(n instanceof PDFStream) || !(nRef instanceof PDFRef)) continue;
      const rect = rectOf(d.lookup(PDFName.of("Rect")));
      const bbox = rectOf(n.dict.lookup(PDFName.of("BBox")));
      if (!rect || !bbox) continue;
      const mArr = n.dict.lookup(PDFName.of("Matrix"));
      const mv = mArr instanceof PDFArray && mArr.size() >= 6 ? [0, 1, 2, 3, 4, 5].map((i) => num(mArr.lookup(i))) : null;
      const M = mv && mv.every((x) => x !== null) ? (mv as number[]) : [1, 0, 0, 1, 0, 0];
      // 外観の枠（BBox を Matrix で動かしたものの外接矩形）を、注釈の矩形（Rect）にぴったり重ねる変換を求める
      const corners = [
        [bbox[0], bbox[1]],
        [bbox[2], bbox[1]],
        [bbox[0], bbox[3]],
        [bbox[2], bbox[3]],
      ].map(([x, y]) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]]);
      const tx0 = Math.min(...corners.map((c) => c[0]));
      const ty0 = Math.min(...corners.map((c) => c[1]));
      const tw = Math.max(...corners.map((c) => c[0])) - tx0;
      const th = Math.max(...corners.map((c) => c[1])) - ty0;
      if (!(tw > 0) || !(th > 0) || !(rect[2] > rect[0]) || !(rect[3] > rect[1])) continue;
      const sx = (rect[2] - rect[0]) / tw;
      const sy = (rect[3] - rect[1]) / th;
      if (!n.dict.has(PDFName.of("Subtype"))) n.dict.set(PDFName.of("Subtype"), PDFName.of("Form"));
      toDraw.push({ ref: nRef, m: [sx, 0, 0, sy, rect[0] - tx0 * sx, rect[1] - ty0 * sy] });
    }
    if (!toDraw.length) continue;
    // 元の内容の描画状態を持ち越さないよう q/Q で包んでから、その後ろに描く
    page.node.normalize();
    for (const t of toDraw) {
      const name = page.node.newXObject("FlatAnnot", t.ref);
      draws.push(`q ${t.m.map((v) => +v.toFixed(6)).join(" ")} cm ${name.asString()} Do Q`);
      count++;
    }
    page.node.addContentStream(ctx.register(ctx.flateStream(draws.join("\n") + "\n")));
  }
  return count;
}

/** 面付けに使うページの範囲：見えている範囲（CropBox。無ければページ全体）。ページ全体（MediaBox）からはみ出す分は切る */
function visibleBox(page: PDFPage): { left: number; bottom: number; right: number; top: number } {
  const mb = page.getMediaBox();
  const cb = page.getCropBox();
  const left = Math.max(mb.x, cb.x);
  const bottom = Math.max(mb.y, cb.y);
  const right = Math.min(mb.x + mb.width, cb.x + cb.width);
  const top = Math.min(mb.y + mb.height, cb.y + cb.height);
  if (!(right - left > 0.5) || !(top - bottom > 0.5)) return { left: mb.x, bottom: mb.y, right: mb.x + mb.width, top: mb.y + mb.height };
  return { left, bottom, right, top };
}

const PER_SHEET: readonly number[] = [2, 4, 6, 8, 9, 16];

/**
 * security：できあがった PDF に掛ける保護（文書の「パスワード保護」）。
 * 渡すバイト列（bytes）は保護なしであること（ここで読み直すため）。
 */
export async function imposePdf(bytes: Uint8Array, o: ImposeOptions, security?: SecuritySettings): Promise<Uint8Array> {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const n = src.getPageCount();
  if (!n) return bytes;
  // 中身（/Contents）の無いページ（Word などの白紙ページ）は、そのままでは埋め込めない。空の中身を入れて白紙として扱う
  for (const p of src.getPages()) if (!p.node.Contents()) p.node.set(PDFName.of("Contents"), src.context.register(src.context.stream(new Uint8Array(0))));
  // 注釈・入力欄は、見た目のままページに描き込んでから面付けする
  flattenAnnotations(src);
  const perSheet: PerSheet = o.booklet ? 2 : PER_SHEET.includes(o.perSheet) ? o.perSheet : 2;
  const { cols, rows } = gridFor(perSheet);
  const srcPages = src.getPages();
  const boxes = srcPages.map(visibleBox);
  const firstRot = ((srcPages[0].getRotation().angle % 360) + 360) % 360;
  const fw = boxes[0].right - boxes[0].left;
  const fh = boxes[0].top - boxes[0].bottom;
  const firstW = firstRot % 180 ? fh : fw;
  const firstH = firstRot % 180 ? fw : fh;
  const paper = PAPER_SIZES.find((p) => p.id === o.paper);
  let W = paper ? paper.w : firstW;
  let H = paper ? paper.h : firstH;
  const landscape = o.orientation === "landscape" || (o.orientation === "auto" && cols > rows);
  if (landscape ? W < H : W > H) [W, H] = [H, W];
  // 余白と間隔は、1 面に少なくとも MIN_CELL pt 残る範囲に収める（大きすぎる値で、面の大きさが 0 や負にならないように）
  const MIN_CELL = 10;
  const margin = clamp(o.margin, 0, Math.min(LIMITS.marginPt, (Math.min(W, H) - MIN_CELL) / 2), 0);
  const gap = clamp(o.gap, 0, Math.max(0, Math.min(LIMITS.marginPt, (W - 2 * margin - cols * MIN_CELL) / Math.max(1, cols - 1), (H - 2 * margin - rows * MIN_CELL) / Math.max(1, rows - 1))), 0);

  const order = o.booklet ? bookletOrder(n) : Array.from({ length: Math.ceil(n / perSheet) * perSheet }, (_, i) => (i < n ? i : -1));
  const out = await PDFDocument.create();
  out.setProducer("Washi PDF (pdf-lib)");
  out.setCreator("Washi PDF");
  // 見えている範囲（トリミング後）だけを写す。ページ全体を写すと、切り落としたはずの部分が出てきてしまう
  const embedded = await out.embedPages(srcPages, boxes);
  const rotations = srcPages.map((p) => ((p.getRotation().angle % 360) + 360) % 360);
  const cellW = (W - 2 * margin - (cols - 1) * gap) / cols;
  const cellH = (H - 2 * margin - (rows - 1) * gap) / rows;

  for (let s = 0; s < order.length; s += perSheet) {
    const sheet = out.addPage([W, H]);
    for (let k = 0; k < perSheet; k++) {
      const idx = order[s + k];
      let col = k % cols;
      const row = Math.floor(k / cols);
      if (o.rightToLeft) col = cols - 1 - col;
      const cx = margin + col * (cellW + gap);
      const cy = H - margin - (row + 1) * cellH - row * gap;
      if (o.border) sheet.drawRectangle({ x: cx, y: cy, width: cellW, height: cellH, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 0.5 });
      if (idx < 0) continue;
      const emb = embedded[idx];
      const rot = rotations[idx];
      // /Rotate を含めた見た目の大きさで枠に収める
      const visW = rot % 180 ? emb.height : emb.width;
      const visH = rot % 180 ? emb.width : emb.height;
      const scale = Math.min(cellW / visW, cellH / visH);
      const dw = visW * scale;
      const dh = visH * scale;
      const x0 = cx + (cellW - dw) / 2;
      const y0 = cy + (cellH - dh) / 2;
      const w = emb.width * scale;
      const h = emb.height * scale;
      // 回転は原点 (x, y) を中心に反時計回り。表示上の枠が (x0, y0, dw, dh) になるよう原点をずらす
      if (rot === 90) sheet.drawPage(emb, { x: x0, y: y0 + w, width: w, height: h, rotate: degrees(-90) });
      else if (rot === 180) sheet.drawPage(emb, { x: x0 + w, y: y0 + h, width: w, height: h, rotate: degrees(180) });
      else if (rot === 270) sheet.drawPage(emb, { x: x0 + h, y: y0, width: w, height: h, rotate: degrees(90) });
      else sheet.drawPage(emb, { x: x0, y: y0, width: w, height: h });
    }
  }
  if (security?.enabled) {
    // 暗号化はオブジェクト単位。保存時に作られるオブジェクトストリームには掛けられないので使わない
    await out.flush();
    await encryptDocument(out, security);
    return out.save({ useObjectStreams: false });
  }
  return out.save({ useObjectStreams: true });
}

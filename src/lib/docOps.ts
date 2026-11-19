/**
 * 文書全体にかかる設定：ページ番号・ヘッダー／フッター・透かし・メタデータ。
 * 編集画面のオブジェクトとは別に、保存時に全ページへまとめて描く（履歴の対象）。
 */
import { degrees, type PDFDict, type PDFDocument, type PDFFont, PDFHexString, type PDFImage, PDFName, type PDFPage, rgb } from "pdf-lib";
import { ASCENT, defaultFont, measureBundled } from "./fonts";
import { apply, invert, multiply, normRot } from "./geometry";
import { clamp, clampInt, LIMITS } from "./limits";
import { pageSet } from "./pageRanges";
import { drawTextMaybeShaped } from "./shape";
import type { AttachmentItem } from "./attachments";
import { type CompressSettings, defaultCompress } from "./compress";
import type { OutlineItem } from "./outlines";
import { defaultSecurity, type SecuritySettings } from "./security";
import type { FontKey, Matrix, PageItem } from "./types";

/** 配置の基準（表示上の向きで、上段・中段・下段 × 左・中・右） */
export type Anchor = "tl" | "tc" | "tr" | "ml" | "mc" | "mr" | "bl" | "bc" | "br";

export interface StampStyle {
  font: FontKey;
  fontSize: number;
  color: string;
  opacity: number;
}

export interface PageNumbering {
  enabled: boolean;
  /** 例 "{n} / {N}", "- {n} -", "ABC-{n:6}"（Bates）。{N} は対象ページ数、{p} は文書内の通し番号 */
  template: string;
  /** 最初の対象ページに付ける番号 */
  start: number;
  anchor: Anchor;
  margin: number;
  style: StampStyle;
  /** 対象ページ（"" は全部。"2-" で 2 ページ目から） */
  pages: string;
}

export interface HeaderFooter {
  enabled: boolean;
  left: string;
  center: string;
  right: string;
  margin: number;
  style: StampStyle;
  pages: string;
}

export interface Watermark {
  enabled: boolean;
  kind: "text" | "image";
  text: string;
  imageId: string | null;
  /** 表示上の時計回り（度）。斜めの透かしは -30 など */
  rotation: number;
  /** 画像のとき：ページ幅に対する割合（0.1〜1） */
  scale: number;
  anchor: Anchor;
  style: StampStyle;
  pages: string;
}

export interface DocDecor {
  numbering: PageNumbering;
  header: HeaderFooter;
  footer: HeaderFooter;
  watermark: Watermark;
}

export interface DocMeta {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  /** true なら作成者・作成ソフト・XMP などの情報を全部消す */
  sanitize: boolean;
}

export interface DocSettings {
  decor: DocDecor;
  meta: DocMeta;
  /** 元 PDF の注釈（リンク・コメントなど）を保存時に外す */
  stripAnnotations: boolean;
  /** パスワード保護・権限 */
  security: SecuritySettings;
  /** 画像の再圧縮 */
  compress: CompressSettings;
  /** 文書全体をグレースケールにする */
  grayscale: boolean;
  /** しおり（目次） */
  outline: OutlineItem[];
  /** 添付ファイル */
  attachments: AttachmentItem[];
}

export function defaultStyle(fontSize = 10): StampStyle {
  return { font: defaultFont("sans"), fontSize, color: "#333333", opacity: 1 };
}

export function defaultSettings(): DocSettings {
  return {
    decor: {
      numbering: { enabled: false, template: "{n} / {N}", start: 1, anchor: "bc", margin: 24, style: defaultStyle(10), pages: "" },
      header: { enabled: false, left: "", center: "", right: "", margin: 24, style: defaultStyle(9), pages: "" },
      footer: { enabled: false, left: "", center: "", right: "", margin: 24, style: defaultStyle(9), pages: "" },
      watermark: {
        enabled: false,
        kind: "text",
        text: "CONFIDENTIAL",
        imageId: null,
        rotation: -30,
        scale: 0.5,
        anchor: "mc",
        style: { font: defaultFont("sans"), fontSize: 64, color: "#d6334a", opacity: 0.18 },
        pages: "",
      },
    },
    meta: { title: "", author: "", subject: "", keywords: "", sanitize: false },
    stripAnnotations: false,
    security: defaultSecurity(),
    compress: defaultCompress(),
    grayscale: false,
    outline: [],
    attachments: [],
  };
}

export const hasDecor = (d: DocDecor) => d.numbering.enabled || d.header.enabled || d.footer.enabled || d.watermark.enabled;

/* ---------- テンプレート ---------- */

export interface TemplateVars {
  /** 対象ページの中での番号（start を加えたもの） */
  n: number;
  /** 対象ページ数 */
  N: number;
  /** 文書内の通し番号（1 始まり） */
  p: number;
  /** 文書のページ数 */
  P: number;
  file: string;
  date: string;
}

/** {n} {N} {p} {P} {file} {date} と、ゼロ埋め {n:6} を展開する */
export function renderTemplate(tpl: string, v: TemplateVars): string {
  return tpl.replace(/\{(n|N|p|P|file|date)(?::(\d+))?\}/g, (_, key: keyof TemplateVars, pad?: string) => {
    const val = v[key];
    const s = String(val);
    // 桁数は上限までにする（{n:999999999} のような指定で、巨大な文字列を作って固まらないように）
    return pad && typeof val === "number" ? s.padStart(clampInt(pad, 0, LIMITS.padDigits), "0") : s;
  });
}

export function todayString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 保存時に書き込む可能性のある文字を全部集める（フォントのサブセット用） */
export function decorTexts(decor: DocDecor, pageCount: number, file: string): Map<FontKey, string> {
  const out = new Map<FontKey, string>();
  const add = (font: FontKey, s: string) => out.set(font, (out.get(font) ?? "") + s);
  const vars = (i: number, n: number, N: number): TemplateVars => ({ n, N, p: i + 1, P: pageCount, file, date: todayString() });
  if (decor.numbering.enabled) {
    const set = pageSet(decor.numbering.pages, pageCount);
    let k = 0;
    const start = clampInt(decor.numbering.start, LIMITS.startNumber.min, LIMITS.startNumber.max, 1);
    for (let i = 0; i < pageCount; i++) if (set.has(i)) add(decor.numbering.style.font, renderTemplate(decor.numbering.template, vars(i, start + k++, set.size)));
  }
  for (const hf of [decor.header, decor.footer]) {
    if (!hf.enabled) continue;
    const set = pageSet(hf.pages, pageCount);
    let k = 0;
    for (let i = 0; i < pageCount; i++) {
      if (!set.has(i)) continue;
      const v = vars(i, 1 + k++, set.size);
      add(hf.style.font, renderTemplate(hf.left, v) + renderTemplate(hf.center, v) + renderTemplate(hf.right, v));
    }
  }
  if (decor.watermark.enabled && decor.watermark.kind === "text") add(decor.watermark.style.font, decor.watermark.text);
  return out;
}

/* ---------- 座標：表示上の向き（回転適用後）→ PDF のユーザー空間 ---------- */

/** 最終的な表示（extraRotation 適用後）のサイズ */
export function displaySize(item: PageItem): { w: number; h: number } {
  const swap = normRot(item.extraRotation) % 180 !== 0;
  return { w: swap ? item.height : item.width, h: swap ? item.width : item.height };
}

/**
 * 見えている範囲（トリミング後）を、最終的な表示（extraRotation 適用後）の座標で返す。トリミングが無ければページ全体。
 * ページ番号・ヘッダー／フッター・透かしは、この範囲を基準に置く（ページ全体を基準にすると、切り落とした部分に出てしまう）
 */
export function visibleRect(item: PageItem): { x: number; y: number; w: number; h: number } {
  const W = item.width;
  const H = item.height;
  const c = item.crop;
  if (!c) return { x: 0, y: 0, ...displaySize(item) };
  // ページからはみ出す指定は、ページの中に収める
  const x0 = Math.max(0, Math.min(W, c.x));
  const y0 = Math.max(0, Math.min(H, c.y));
  const cw = Math.max(0, Math.min(W, c.x + c.w) - x0);
  const ch = Math.max(0, Math.min(H, c.y + c.h) - y0);
  if (!(cw > 0) || !(ch > 0)) return { x: 0, y: 0, ...displaySize(item) };
  switch (normRot(item.extraRotation)) {
    case 90:
      return { x: H - y0 - ch, y: x0, w: ch, h: cw };
    case 180:
      return { x: W - x0 - cw, y: H - y0 - ch, w: cw, h: ch };
    case 270:
      return { x: y0, y: W - x0 - cw, w: ch, h: cw };
    default:
      return { x: x0, y: y0, w: cw, h: ch };
  }
}

/** 最終表示座標 → ユーザー空間 の行列 */
export function displayToUser(item: PageItem): Matrix {
  const W = item.width;
  const H = item.height;
  let rInv: Matrix;
  switch (normRot(item.extraRotation)) {
    case 90:
      rInv = [0, -1, 1, 0, 0, H];
      break;
    case 180:
      rInv = [-1, 0, 0, -1, W, H];
      break;
    case 270:
      rInv = [0, 1, -1, 0, W, 0];
      break;
    default:
      rInv = [1, 0, 0, 1, 0, 0];
  }
  // multiply(A, B) は「B を適用してから A」
  return multiply(invert(item.viewTransform), rInv);
}

/** 表示上の向きで水平な文字を描くための、ユーザー空間での回転角（度） */
export function uprightAngle(m: Matrix): number {
  const [x0, y0] = apply(m, 0, 0);
  const [x1, y1] = apply(m, 1, 0);
  return (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI;
}

function hexToRgb(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0;
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** anchor と余白から、幅 w・高さ h の箱の左上（表示座標）を求める */
export function anchorBox(anchor: Anchor, page: { w: number; h: number }, w: number, h: number, margin: number): { x: number; y: number } {
  const col = anchor[1];
  const row = anchor[0];
  const x = col === "l" ? margin : col === "r" ? page.w - margin - w : (page.w - w) / 2;
  const y = row === "t" ? margin : row === "b" ? page.h - margin - h : (page.h - h) / 2;
  return { x, y };
}

/** 幅 w・高さ h の箱を rotation 度傾けたとき、その外接矩形をページの anchor の位置（余白 36pt）に置いた中心 */
export function rotatedCenter(anchor: Anchor, page: { w: number; h: number }, w: number, h: number, rotation: number): { x: number; y: number } {
  const t = (rotation * Math.PI) / 180;
  const bw = Math.abs(w * Math.cos(t)) + Math.abs(h * Math.sin(t));
  const bh = Math.abs(w * Math.sin(t)) + Math.abs(h * Math.cos(t));
  const box = anchorBox(anchor, page, bw, bh, 36);
  return { x: box.x + bw / 2, y: box.y + bh / 2 };
}

export interface DrawCtx {
  fonts: Map<FontKey, PDFFont>;
  getImage: (id: string) => Promise<PDFImage>;
}

/** 表示座標で指定した位置に、表示上まっすぐな（または rotation 度傾いた）文字を描く */
export function drawDisplayText(
  page: PDFPage,
  item: PageItem,
  text: string,
  x: number,
  baselineY: number,
  style: StampStyle,
  font: PDFFont,
  rotation = 0,
) {
  const m = displayToUser(item);
  const [ux, uy] = apply(m, x, baselineY);
  if (drawTextMaybeShaped(page, style.font, font, text, { x: ux, y: uy, size: style.fontSize, color: style.color, opacity: style.opacity, rotateDeg: uprightAngle(m) - rotation })) return;
  page.drawText(text, {
    x: ux,
    y: uy,
    size: style.fontSize,
    font,
    color: hexToRgb(style.color),
    opacity: style.opacity,
    rotate: degrees(uprightAngle(m) - rotation),
  });
}

/** 文書全体の飾り（ページ番号・ヘッダー／フッター・透かし）を 1 ページ分描く */
export async function drawDecor(doc: PDFDocument, page: PDFPage, item: PageItem, index: number, items: PageItem[], decor: DocDecor, file: string, ctx: DrawCtx) {
  // 位置は、見えている範囲（トリミング後）を基準に決める
  const vis = visibleRect(item);
  const size = { w: vis.w, h: vis.h };
  // 極端な値（巨大な文字・余白、数でない値）は、描ける範囲に収める
  const margin = (v: number) => clamp(v, 0, LIMITS.marginPt, 0);
  const sane = (st: StampStyle): StampStyle => ({ ...st, fontSize: clamp(st.fontSize, LIMITS.fontSize.min, LIMITS.fontSize.max, 10), opacity: clamp(st.opacity, 0, 1, 1) });
  const P = items.length;
  const vars = (n: number, N: number): TemplateVars => ({ n, N, p: index + 1, P, file, date: todayString() });

  // ページ番号
  if (decor.numbering.enabled) {
    const set = pageSet(decor.numbering.pages, P);
    if (set.has(index)) {
      const k = [...set].filter((i) => i < index).length;
      const text = renderTemplate(decor.numbering.template, vars(clampInt(decor.numbering.start, LIMITS.startNumber.min, LIMITS.startNumber.max, 1) + k, set.size));
      const font = ctx.fonts.get(decor.numbering.style.font);
      if (font && text) {
        const st = sane(decor.numbering.style);
        const w = measureBundled(st.font, text, st.fontSize);
        const box = anchorBox(decor.numbering.anchor, size, w, st.fontSize, margin(decor.numbering.margin));
        drawDisplayText(page, item, text, vis.x + box.x, vis.y + box.y + ASCENT * st.fontSize, st, font);
      }
    }
  }
  // ヘッダー／フッター
  for (const [hf, row] of [
    [decor.header, "t"],
    [decor.footer, "b"],
  ] as const) {
    if (!hf.enabled) continue;
    const set = pageSet(hf.pages, P);
    if (!set.has(index)) continue;
    const k = [...set].filter((i) => i < index).length;
    const v = vars(1 + k, set.size);
    const hs = sane(hf.style);
    const font = ctx.fonts.get(hs.font);
    if (!font) continue;
    for (const [tpl, col] of [
      [hf.left, "l"],
      [hf.center, "c"],
      [hf.right, "r"],
    ] as const) {
      const text = renderTemplate(tpl, v);
      if (!text) continue;
      const w = measureBundled(hs.font, text, hs.fontSize);
      const box = anchorBox(`${row}${col}` as Anchor, size, w, hs.fontSize, margin(hf.margin));
      drawDisplayText(page, item, text, vis.x + box.x, vis.y + box.y + ASCENT * hs.fontSize, hs, font);
    }
  }
  // 透かし
  const wm = { ...decor.watermark, style: sane(decor.watermark.style), rotation: clamp(decor.watermark.rotation, -360, 360, 0) };
  if (wm.enabled && pageSet(wm.pages, P).has(index)) {
    const m = displayToUser(item);
    const angle = uprightAngle(m) - wm.rotation;
    if (wm.kind === "text" && wm.text) {
      const font = ctx.fonts.get(wm.style.font);
      if (font) {
        const w = measureBundled(wm.style.font, wm.text, wm.style.fontSize);
        const h = wm.style.fontSize;
        // 傾けた後の外接矩形で位置を決める（端や角に置いても、傾けた文字がページからはみ出さないように）
        const c0 = rotatedCenter(wm.anchor, size, w, h, wm.rotation);
        const cx = vis.x + c0.x;
        const cy = vis.y + c0.y;
        // 箱の中心を軸に回す：中心を求め、回転後の左下（ベースライン左端）を逆算する
        // 表示座標は y が下向きなので、見た目の反時計回り（負の rotation）は数学上は正の回転になる
        const t = (wm.rotation * Math.PI) / 180;
        const dx = -w / 2;
        const dy = h / 2 - (h - ASCENT * h); // ベースラインまで
        const bx = cx + dx * Math.cos(t) - dy * Math.sin(t);
        const by = cy + dx * Math.sin(t) + dy * Math.cos(t);
        const [ux, uy] = apply(m, bx, by);
        page.drawText(wm.text, { x: ux, y: uy, size: h, font, color: hexToRgb(wm.style.color), opacity: wm.style.opacity, rotate: degrees(angle) });
      }
    } else if (wm.kind === "image" && wm.imageId) {
      const img = await ctx.getImage(wm.imageId);
      const w = size.w * Math.max(0.05, Math.min(1, wm.scale));
      const h = (w * img.height) / img.width;
      const c0 = rotatedCenter(wm.anchor, size, w, h, wm.rotation);
      const cx = vis.x + c0.x;
      const cy = vis.y + c0.y;
      const t = (wm.rotation * Math.PI) / 180;
      // pdf-lib は画像の左下を軸に回すので、表示座標の「左下」（y が大きい側）を回転後の位置に置く
      const dx = -w / 2;
      const dy = h / 2;
      const bx = cx + dx * Math.cos(t) - dy * Math.sin(t);
      const by = cy + dx * Math.sin(t) + dy * Math.cos(t);
      const [ux, uy] = apply(m, bx, by);
      page.drawImage(img, { x: ux, y: uy, width: w, height: h, opacity: wm.style.opacity, rotate: degrees(angle) });
    }
  }
}

/** メタデータを書く（sanitize なら全部消す） */
export function applyMeta(doc: PDFDocument, meta: DocMeta) {
  // pdf-lib の文書情報の辞書（/Info）。公開の関数が無いので、内部の関数で取る
  const info = (doc as unknown as { getInfoDict(): PDFDict }).getInfoDict();
  if (meta.sanitize) {
    // 作成日・更新日も含めて、文書情報を全部消す
    for (const k of info.keys()) info.delete(k);
    return;
  }
  if (meta.title) doc.setTitle(meta.title);
  if (meta.author) doc.setAuthor(meta.author);
  if (meta.subject) doc.setSubject(meta.subject);
  // キーワードは、入れた区切り（「,」など）のまま残す（pdf-lib の setKeywords は空白でつなぐ）
  if (meta.keywords.trim()) info.set(PDFName.of("Keywords"), PDFHexString.fromText(meta.keywords.trim()));
}

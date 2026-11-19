/**
 * 注釈の書き込み：ハイライト・下線・取り消し線・付箋・手書きを、PDF 仕様の注釈辞書（Annots）として追加する。
 * どのビューアでも見えるように、外観ストリーム（/AP /N）も自分で作る。
 */
import { PDFArray, PDFDict, type PDFDocument, PDFHexString, PDFName, type PDFObject, type PDFPage, PDFRef, PDFString } from "pdf-lib";
import { fmt } from "./contentStream";
import { apply, invert } from "./geometry";
import type { InkObj, LinkObj, MarkupObj, NoteObj, PageItem } from "./types";

function rgb01(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const nowPdfDate = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** 表示座標の矩形 → ユーザー空間の [x0 y0 x1 y1] */
export function userRect(item: PageItem, x: number, y: number, w: number, h: number): [number, number, number, number] {
  const M = invert(item.viewTransform);
  const pts = [apply(M, x, y), apply(M, x + w, y), apply(M, x, y + h), apply(M, x + w, y + h)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** 外観ストリーム（Form XObject）を作る */
function appearance(doc: PDFDocument, ops: string, bbox: [number, number, number, number], opacity: number, blend?: string): PDFRef {
  const gs: Record<string, string | number> = { Type: "ExtGState", CA: opacity, ca: opacity };
  if (blend) gs.BM = blend;
  const stream = doc.context.flateStream(`/GS gs\n${ops}`, {
    Type: "XObject",
    Subtype: "Form",
    BBox: bbox,
    Resources: { ExtGState: { GS: gs } },
  });
  return doc.context.register(stream);
}

function baseDict(subtype: string, rect: [number, number, number, number], color: string, opacity: number, contents: string, author = "") {
  const [r, g, b] = rgb01(color);
  const d: Record<string, unknown> = {
    Type: "Annot",
    Subtype: subtype,
    Rect: rect,
    C: [r, g, b],
    CA: opacity,
    F: 4,
    M: PDFString.of(nowPdfDate()),
    NM: PDFString.of(`washi-${Math.random().toString(36).slice(2, 10)}`),
  };
  if (contents) d.Contents = PDFHexString.fromText(contents);
  if (author) d.T = PDFHexString.fromText(author);
  return d;
}

export function addMarkup(doc: PDFDocument, page: PDFPage, item: PageItem, o: MarkupObj) {
  const rect = userRect(item, o.x, o.y, o.w, o.h);
  const [x0, y0, x1, y1] = rect;
  const [r, g, b] = rgb01(o.color);
  const subtype = o.kind === "highlight" ? "Highlight" : o.kind === "underline" ? "Underline" : "StrikeOut";
  // QuadPoints は 左上, 右上, 左下, 右下 の順（仕様のとおり y 上向き）
  const quad = [x0, y1, x1, y1, x0, y0, x1, y0];
  const w = x1 - x0;
  const h = y1 - y0;
  let ops: string;
  let blend: string | undefined;
  if (o.kind === "highlight") {
    ops = `${fmt(r)} ${fmt(g)} ${fmt(b)} rg ${fmt(x0)} ${fmt(y0)} ${fmt(w)} ${fmt(h)} re f`;
    blend = "Multiply";
  } else {
    const lw = Math.max(0.6, h * 0.06);
    const ly = o.kind === "underline" ? y0 + lw : y0 + h * 0.5;
    ops = `${fmt(r)} ${fmt(g)} ${fmt(b)} RG ${fmt(lw)} w ${fmt(x0)} ${fmt(ly)} m ${fmt(x1)} ${fmt(ly)} l S`;
  }
  const ap = appearance(doc, ops, rect, o.opacity, blend);
  const dict = doc.context.obj({ ...baseDict(subtype, rect, o.color, o.opacity, o.contents, o.author ?? ""), QuadPoints: quad, AP: { N: ap } });
  page.node.addAnnot(doc.context.register(dict));
}

export const NOTE_SIZE = 20;

export function addNote(doc: PDFDocument, page: PDFPage, item: PageItem, o: NoteObj) {
  const rect = userRect(item, o.x, o.y, NOTE_SIZE, NOTE_SIZE);
  const [x0, y0, x1, y1] = rect;
  const [r, g, b] = rgb01(o.color);
  // 吹き出し風のアイコン
  const w = x1 - x0;
  const h = y1 - y0;
  const ops = [
    `${fmt(r)} ${fmt(g)} ${fmt(b)} rg 0.25 0.25 0.25 RG 0.8 w`,
    `${fmt(x0 + 1)} ${fmt(y0 + 5)} m ${fmt(x0 + 1)} ${fmt(y1 - 1)} l ${fmt(x1 - 1)} ${fmt(y1 - 1)} l ${fmt(x1 - 1)} ${fmt(y0 + 5)} l ${fmt(x0 + w * 0.45)} ${fmt(y0 + 5)} l ${fmt(x0 + w * 0.3)} ${fmt(y0 + 1)} l ${fmt(x0 + w * 0.3)} ${fmt(y0 + 5)} l h B`,
    `0.25 0.25 0.25 RG 0.7 w ${fmt(x0 + 4)} ${fmt(y0 + h * 0.7)} m ${fmt(x1 - 4)} ${fmt(y0 + h * 0.7)} l S ${fmt(x0 + 4)} ${fmt(y0 + h * 0.5)} m ${fmt(x1 - 6)} ${fmt(y0 + h * 0.5)} l S`,
  ].join("\n");
  const ap = appearance(doc, ops, rect, 1);
  const dict = doc.context.obj({ ...baseDict("Text", rect, o.color, 1, o.contents, o.author), Name: "Comment", Open: false, AP: { N: ap } });
  const ref = doc.context.register(dict);
  page.node.addAnnot(ref);
  // ポップアップ（内容を表示する窓）
  // 窓は付箋の右に出す。ページ（MediaBox）の右・下からはみ出すときは、内側へ寄せる
  const mb = page.getMediaBox();
  const pw = 180;
  const ph = Math.max(100, y1 - y0 + 100);
  let px0 = x1 + 10;
  if (px0 + pw > mb.x + mb.width) px0 = Math.max(mb.x, x0 - 10 - pw);
  const py0 = Math.max(mb.y, y1 - ph);
  const popup = doc.context.obj({ Type: "Annot", Subtype: "Popup", Rect: [px0, py0, px0 + pw, py0 + ph], Parent: ref, Open: false, F: 28 });
  const popupRef = doc.context.register(popup);
  dict.set(PDFName.of("Popup"), popupRef);
  page.node.addAnnot(popupRef);
}

export function addInk(doc: PDFDocument, page: PDFPage, item: PageItem, o: InkObj) {
  const M = invert(item.viewTransform);
  const [r, g, b] = rgb01(o.stroke);
  const inkList: number[][] = [];
  const parts: string[] = [`${fmt(r)} ${fmt(g)} ${fmt(b)} RG ${fmt(o.strokeWidth)} w 1 J 1 j`];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const path of o.paths) {
    const pts = path.map(([px, py]) => apply(M, o.x + px, o.y + py));
    if (!pts.length) continue;
    inkList.push(pts.flat());
    for (const [x, y] of pts) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    parts.push(pts.map(([x, y], i) => `${fmt(x)} ${fmt(y)} ${i === 0 ? "m" : "l"}`).join(" ") + " S");
  }
  if (!inkList.length) return;
  const pad = o.strokeWidth + 1;
  const rect: [number, number, number, number] = [minX - pad, minY - pad, maxX + pad, maxY + pad];
  const ap = appearance(doc, parts.join("\n"), rect, o.opacity);
  const dict = doc.context.obj({ ...baseDict("Ink", rect, o.stroke, o.opacity, ""), InkList: inkList, BS: { W: o.strokeWidth }, AP: { N: ap } });
  page.node.addAnnot(doc.context.register(dict));
}

/** ページにある注釈をすべて取り除く（リンクも含む）。後から addAnnot できるよう空の配列に置き換える */
export function stripAnnotations(page: PDFPage) {
  const annots = page.node.Annots();
  if (annots instanceof PDFArray && annots.size() > 0) page.node.set(PDFName.of("Annots"), page.node.context.obj([]));
}

/**
 * リンクの URL を、PDF に書ける形にそろえる。書けないもの（javascript: など、http(s)・mailto 以外）は null。
 * http(s) は URL として読み直し（ホスト名の国際化・パスの %エンコード）、mailto は ASCII 以外と記号を %エンコードする。
 * 結果は空白・制御文字を含まない ASCII だけ（PDF には 16 進の文字列で書くので、かっこ・\\ で壊れない）
 */
export function normalizeLinkUrl(url: string): string | null {
  const u = url.trim();
  if (!u || /[\s\u0000-\u001f\u007f]/.test(u)) return null;
  let out: string;
  if (/^https?:\/\//i.test(u)) {
    try {
      const p = new URL(u);
      if ((p.protocol !== "http:" && p.protocol !== "https:") || !p.hostname) return null;
      out = p.href;
    } catch {
      return null;
    }
  } else if (/^mailto:/i.test(u)) {
    const rest = u.slice(7);
    if (!rest) return null;
    out = "mailto:" + rest.replace(/[^A-Za-z0-9@.\-_~!$&'*+,;=:?/%]/g, (c) => encodeURIComponent(c));
  } else return null;
  return /^[\x21-\x7e]+$/.test(out) ? out : null;
}

/** URL として書いてよいもの（押すと開くもの。javascript: などは書かない） */
export const safeLinkUrl = (url: string) => normalizeLinkUrl(url) !== null;

/** ASCII の文字列を、PDF の 16 進の文字列にする（かっこ・\\ などをそのまま入れても構文が壊れない） */
const asciiHex = (s: string) => PDFHexString.of([...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(""));

/**
 * リンク注釈を足す（枠は見せない）。行き先は URL か、出力の中のページ（pageRef）。行き先の無いもの・書けない URL は足さない
 */
export function addLink(doc: PDFDocument, page: PDFPage, item: PageItem, o: LinkObj, pageRef: (pageId: string) => PDFRef | undefined) {
  const rect = userRect(item, o.x, o.y, o.w, o.h);
  const d: Record<string, unknown> = { Type: "Annot", Subtype: "Link", Rect: rect, Border: [0, 0, 0], F: 4, NM: PDFString.of(`washi-${Math.random().toString(36).slice(2, 10)}`) };
  if (o.target.kind === "url") {
    const url = normalizeLinkUrl(o.target.url);
    if (!url) return;
    d.A = { Type: "Action", S: "URI", URI: asciiHex(url) };
  } else {
    const ref = pageRef(o.target.pageId);
    if (!ref) return;
    d.Dest = [ref, PDFName.of("XYZ"), null, null, null];
  }
  const ref = doc.context.register(doc.context.obj(d as never));
  const annots = page.node.lookup(PDFName.of("Annots"));
  if (annots instanceof PDFArray) annots.push(ref);
  else page.node.set(PDFName.of("Annots"), doc.context.obj([ref]));
}

/**
 * ページの元のリンク注釈を外す（リンクを編集できる部品として読み込んだページ：保存するときは部品から作り直す）。
 * imported：読み込んだリンクの元の参照（pdf.js の注釈 id、例 "12R"）。外すのはそれだけで、読み込めなかったリンク
 * （ほかのファイルを開く・JavaScript・ページ送りなど）は残す。true は古い形式（リンクを全部外す）。
 * 出力のページの /Annots は元のページの /Annots と同じ順に写してあるので、元のページで位置を調べて同じ位置を外す
 */
export function removeLinkAnnots(page: PDFPage, srcPage: PDFPage | undefined, imported: true | readonly string[]) {
  const annots = page.node.lookup(PDFName.of("Annots"));
  if (!(annots instanceof PDFArray)) return;
  let drop: (a: PDFObject, i: number) => boolean;
  if (imported === true) {
    drop = (a) => {
      const d = a instanceof PDFRef ? page.node.context.lookup(a) : a;
      return d instanceof PDFDict && d.get(PDFName.of("Subtype")) === PDFName.of("Link");
    };
  } else {
    const ids = new Set(imported);
    const srcAnnots = srcPage?.node.lookup(PDFName.of("Annots"));
    const at = new Set<number>();
    if (srcAnnots instanceof PDFArray)
      srcAnnots.asArray().forEach((a, i) => {
        if (a instanceof PDFRef && ids.has(a.generationNumber ? `${a.objectNumber}R${a.generationNumber}` : `${a.objectNumber}R`)) at.add(i);
      });
    drop = (_a, i) => at.has(i);
  }
  const keep = annots.asArray().filter((a, i) => !drop(a, i));
  page.node.set(PDFName.of("Annots"), page.node.context.obj(keep));
}

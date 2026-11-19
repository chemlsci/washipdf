/**
 * 墨消しの取りこぼし検査：ページ内容から取り除いた語が、文書の他の場所に残っていないか探す。
 * 対象：文書情報（タイトル等）、XMP メタデータ、しおり、添付ファイル名、注釈の本文、他ページの文字。
 * ページ内容は保存後のバイト列を pdf.js で読んで調べる（編集・墨消しを反映した後の状態を見るため）。
 */
import { PDFArray, PDFDict, type PDFDocument, PDFHexString, PDFName, PDFRef, PDFString } from "pdf-lib";
import type { AttachmentItem } from "./attachments";
import { tr } from "./i18n";
import type { OutlineItem } from "./outlines";
import { decodeStreamBytes } from "./pdfFontInfo";
import { closePdf, documentOptions, getPdfJs } from "./pdfjs";

export type Place = { kind: "info" | "xmp" | "outline" | "attachment" | "labels" } | { kind: "annot" | "page"; page: number };

export interface Leftover {
  word: string;
  places: Place[];
}

const isCJK = (ch: string) => /[　-鿿가-힯豈-﫿]/.test(ch);

/** 比較用に正規化する（互換文字を統一し、空白を落とし、小文字に） */
export const normalizeText = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();

/** 取り除いた文字列から、探す価値のある語を取り出す（空白区切り。和文は 2 文字以上、欧文は 3 文字以上） */
export function redactedWords(texts: string[], limit = 100): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of texts) {
    for (const raw of t.split(/[\s　]+/)) {
      const w = raw.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
      if (!w) continue;
      const chars = [...w];
      const min = chars.some(isCJK) ? 2 : 3;
      if (chars.length < min) continue;
      // 右から左の文字（ヘブライ文字・アラビア文字）は、内容の中では見た目の順（左から）に並んでいることが多い。
      // 文書情報などには読む順で書かれているので、並びを逆にした語も探す（逆にした語を先に。知らせに出すのは読む順の語）
      const rtl = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/.test(w);
      for (const v of rtl ? [chars.slice().reverse().join(""), w] : [w]) {
        const key = normalizeText(v);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(v);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

/** 保存後の検証の結果 */
export interface RedactCheck {
  /** 墨消しのあるページ数 */
  pages: number;
  /** 消した文字が保存後のページから減っていることを確かめられたページ数 */
  verified: number;
  /** 確かめられなかったページ（1 始まり） */
  unverified: number[];
}

const countOf = (hay: string, needle: string): number => {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++;
  return n;
};

/**
 * 元のページの文字（before）と保存後のページの文字（after）を比べ、取り除いた文字列（removed。字形を残した所は空白）が
 * その回数だけ減っているかを確かめる。取り除いた語それぞれについて「保存後の出現回数 ≦ 元の出現回数 − 取り除いた回数」。
 * 同じページに文字を書き足していると回数が増えて確かめられないことがある（その場合は false＝未確認。失敗とは限らない）。
 */
export function removedTextIsGone(before: string, after: string, removed: string[]): boolean {
  const b = normalizeText(before);
  const a = normalizeText(after);
  const counts = new Map<string, number>();
  for (const t of removed) {
    for (const raw of t.split(/[\s　]+/)) {
      const w = normalizeText(raw);
      if (w) counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  // 文字を 1 つも取り除いていない（画像や図形だけの墨消し）なら、文字については確かめることが無い
  for (const [w, n] of counts) if (countOf(a, w) > Math.max(0, countOf(b, w) - n)) return false;
  return true;
}

const str = (o: unknown): string => (o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : "");

/** 保存前の文書（暗号化前）から、ページ内容以外の文字列を集める */
export function collectNonPageTexts(doc: PDFDocument, outline: OutlineItem[], attachments: AttachmentItem[]): { place: Place; text: string }[] {
  const out: { place: Place; text: string }[] = [];
  const info = [doc.getTitle(), doc.getAuthor(), doc.getSubject(), doc.getKeywords(), doc.getCreator(), doc.getProducer()].filter(Boolean).join("\n");
  if (info) out.push({ place: { kind: "info" }, text: info });
  const meta = doc.catalog.get(PDFName.of("Metadata"));
  if (meta) {
    const bytes = decodeStreamBytes(doc, meta);
    if (bytes) out.push({ place: { kind: "xmp" }, text: new TextDecoder().decode(bytes) });
  }
  if (outline.length) out.push({ place: { kind: "outline" }, text: outline.map((o) => (o.uri ? `${o.title}\n${o.uri}` : o.title)).join("\n") });
  if (attachments.length) out.push({ place: { kind: "attachment" }, text: attachments.map((a) => `${a.name}\n${a.description}`).join("\n") });
  // ページ番号のラベル（/PageLabels の接頭辞）と、レイヤーの名前（/OCProperties の名前と、一覧の見出し）
  const labels: string[] = [];
  const seen = new Set<unknown>();
  const look = (o: unknown) => (o instanceof PDFRef ? doc.context.lookup(o) : o);
  const walkLabels = (node: unknown, depth: number) => {
    const n = look(node);
    if (!(n instanceof PDFDict) || seen.has(n) || depth > 20) return;
    seen.add(n);
    const nums = n.lookup(PDFName.of("Nums"));
    if (nums instanceof PDFArray)
      for (const v of nums.asArray()) {
        const d = look(v);
        if (d instanceof PDFDict) labels.push(str(d.lookup(PDFName.of("P"))));
      }
    const kids = n.lookup(PDFName.of("Kids"));
    if (kids instanceof PDFArray) for (const k of kids.asArray()) walkLabels(k, depth + 1);
  };
  walkLabels(doc.catalog.get(PDFName.of("PageLabels")), 0);
  const walkOrder = (o: unknown, depth: number) => {
    const v = look(o);
    if (depth > 20 || seen.has(v)) return;
    seen.add(v);
    if (v instanceof PDFArray) for (const x of v.asArray()) walkOrder(x, depth + 1);
    else if (v instanceof PDFString || v instanceof PDFHexString) labels.push(v.decodeText());
    else if (v instanceof PDFDict) labels.push(str(v.lookup(PDFName.of("Name"))));
  };
  const ocp = look(doc.catalog.get(PDFName.of("OCProperties")));
  if (ocp instanceof PDFDict) {
    walkOrder(ocp.get(PDFName.of("OCGs")), 0);
    const configs = [look(ocp.get(PDFName.of("D"))), ...((look(ocp.get(PDFName.of("Configs"))) as PDFArray | undefined)?.asArray?.() ?? []).map(look)];
    for (const c of configs) {
      if (!(c instanceof PDFDict)) continue;
      labels.push(str(c.lookup(PDFName.of("Name"))));
      walkOrder(c.get(PDFName.of("Order")), 0);
    }
  }
  const labelText = labels.filter(Boolean).join("\n");
  if (labelText) out.push({ place: { kind: "labels" }, text: labelText });
  doc.getPages().forEach((page, i) => {
    const annots = page.node.Annots();
    if (!(annots instanceof PDFArray)) return;
    const parts: string[] = [];
    for (const r of annots.asArray()) {
      const d = doc.context.lookup(r);
      if (!(d instanceof PDFDict)) continue;
      // 注釈の中の文字：内容・作者・件名・入力欄の説明と値、リンクの行き先（URL）、添付ファイルの注釈の名前と説明
      for (const k of ["Contents", "T", "Subj", "RC", "TU", "V", "DV"]) parts.push(str(d.lookup(PDFName.of(k))));
      const act = d.lookup(PDFName.of("A"));
      if (act instanceof PDFDict) parts.push(str(act.lookup(PDFName.of("URI"))));
      const fs = d.lookup(PDFName.of("FS"));
      if (fs instanceof PDFDict) for (const k of ["F", "UF", "Desc"]) parts.push(str(fs.lookup(PDFName.of(k))));
    }
    const text = parts.filter(Boolean).join("\n");
    if (text) out.push({ place: { kind: "annot", page: i + 1 }, text });
  });
  return out;
}

/** 文字のまとまり（pdf.js の読み取り結果）：文字列・位置の行列・幅・高さ・向き */
export interface TextRunLite {
  str: string;
  transform: number[];
  width: number;
  height: number;
  dir: string;
}

/** 保存後のバイト列から各ページの文字を取り出す（位置つきのまとまりも返す） */
export async function pageTextsOf(bytes: Uint8Array, password?: string): Promise<{ texts: string[]; runs: TextRunLite[][] }> {
  const pdfjs = await getPdfJs();
  const pdf = await pdfjs.getDocument({ ...documentOptions(), data: bytes.slice(), password }).promise;
  const texts: string[] = [];
  const runs: TextRunLite[][] = [];
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const c = await (await pdf.getPage(i)).getTextContent();
      texts.push(c.items.map((it) => ("str" in it ? it.str : "")).join(" "));
      runs.push(c.items.flatMap((it) => ("str" in it ? [{ str: it.str, transform: it.transform as number[], width: it.width, height: it.height, dir: it.dir }] : [])));
    }
  } finally {
    await closePdf(pdf);
  }
  return { texts, runs };
}

/**
 * 墨消しの範囲（ページ座標）の中に、まだ文字が残っているか。まとまりの幅（縦書きは高さ）を字数で等分して
 * 字ごとの中心を見積もり、範囲を字の大きさの 1/4 だけ内側に縮めた中に中心がある字を「残っている」とみなす
 * （範囲の縁にかかるだけの隣の字は、墨消しでも残すので数えない）。見つかった字を返す
 */
export function textInRects(runs: TextRunLite[], rects: { x0: number; y0: number; x1: number; y1: number }[]): string[] {
  const found: string[] = [];
  for (const r of runs) {
    const chars = [...r.str];
    if (!chars.length || !chars.some((c) => c.trim())) continue;
    const [a, b, c, d, e, f] = r.transform;
    const size = Math.hypot(a, b) || Math.hypot(c, d) || 1;
    const ux = [a / (Math.hypot(a, b) || 1), b / (Math.hypot(a, b) || 1)];
    const uy = [c / (Math.hypot(c, d) || 1), d / (Math.hypot(c, d) || 1)];
    const ttb = r.dir === "ttb";
    chars.forEach((ch, i) => {
      if (!ch.trim()) return;
      const t = (i + 0.5) / chars.length;
      // 縦書き：pdf.js の位置は列の中央・上端。そこから下へ並ぶ
      const along = ttb ? [-uy[0] * r.height * t, -uy[1] * r.height * t] : [ux[0] * r.width * t + uy[0] * size * 0.35, ux[1] * r.width * t + uy[1] * size * 0.35];
      const x = e + along[0];
      const y = f + along[1];
      // 範囲を内側へ縮める量：字の大きさの 1/4。ただし細い範囲がつぶれないよう、範囲の幅・高さの 1/4 まで
      if (rects.some((q) => {
        const mx = Math.min(size * 0.25, (q.x1 - q.x0) * 0.25);
        const my = Math.min(size * 0.25, (q.y1 - q.y0) * 0.25);
        return x > q.x0 + mx && x < q.x1 - mx && y > q.y0 + my && y < q.y1 - my;
      }))
        found.push(ch);
    });
  }
  return found;
}

/**
 * ページ番号のラベル（接頭辞）と、レイヤーの名前・一覧の見出しに墨消しした語があれば、その部分を取り除く。
 * どちらもこのアプリの画面では直せず、消しても文書の中身（ページ・文字）は変わらない（ラベルは数字だけに、レイヤーは「Layer 1」などになる）
 */
export function scrubLabels(doc: PDFDocument, words: string[]): void {
  const keys = words.map(normalizeText).filter(Boolean);
  const hit = (s: string) => {
    const n = normalizeText(s);
    return !!n && keys.some((k) => n.includes(k));
  };
  const look = (o: unknown) => (o instanceof PDFRef ? doc.context.lookup(o) : o);
  const seen = new Set<unknown>();
  const walkLabels = (node: unknown, depth: number) => {
    const n = look(node);
    if (!(n instanceof PDFDict) || seen.has(n) || depth > 20) return;
    seen.add(n);
    const nums = n.lookup(PDFName.of("Nums"));
    if (nums instanceof PDFArray)
      for (const v of nums.asArray()) {
        const d = look(v);
        if (d instanceof PDFDict && hit(str(d.lookup(PDFName.of("P"))))) d.delete(PDFName.of("P"));
      }
    const kids = n.lookup(PDFName.of("Kids"));
    if (kids instanceof PDFArray) for (const k of kids.asArray()) walkLabels(k, depth + 1);
  };
  walkLabels(doc.catalog.get(PDFName.of("PageLabels")), 0);
  const ocp = look(doc.catalog.get(PDFName.of("OCProperties")));
  if (!(ocp instanceof PDFDict)) return;
  const ocgs = look(ocp.get(PDFName.of("OCGs")));
  if (ocgs instanceof PDFArray)
    ocgs.asArray().forEach((g, i) => {
      const d = look(g);
      if (d instanceof PDFDict && hit(str(d.lookup(PDFName.of("Name"))))) d.set(PDFName.of("Name"), PDFHexString.fromText(`Layer ${i + 1}`));
    });
  const fixOrder = (o: unknown, depth: number) => {
    const v = look(o);
    if (!(v instanceof PDFArray) || depth > 20 || seen.has(v)) return;
    seen.add(v);
    v.asArray().forEach((x, i) => {
      if ((x instanceof PDFString || x instanceof PDFHexString) && hit(x.decodeText())) v.set(i, PDFHexString.fromText(""));
      else fixOrder(x, depth + 1);
    });
  };
  const configs = [look(ocp.get(PDFName.of("D"))), ...((look(ocp.get(PDFName.of("Configs"))) as PDFArray | undefined)?.asArray?.() ?? []).map(look)];
  for (const c of configs) {
    if (!(c instanceof PDFDict)) continue;
    if (hit(str(c.lookup(PDFName.of("Name"))))) c.delete(PDFName.of("Name"));
    fixOrder(c.get(PDFName.of("Order")), 0);
  }
}

export function findLeftovers(words: string[], targets: { place: Place; text: string }[]): Leftover[] {
  const normalized = targets.map((t) => ({ place: t.place, text: normalizeText(t.text) }));
  const out: Leftover[] = [];
  for (const w of words) {
    const key = normalizeText(w);
    const places = normalized.filter((t) => t.text.includes(key)).map((t) => t.place);
    if (places.length) out.push({ word: w, places });
  }
  return out;
}

export function describePlace(p: Place): string {
  switch (p.kind) {
    case "info":
      return tr("redact.where.info");
    case "xmp":
      return tr("redact.where.xmp");
    case "outline":
      return tr("redact.where.outline");
    case "labels":
      return tr("redact.where.labels");
    case "attachment":
      return tr("redact.where.attachment");
    case "annot":
      return tr("redact.where.annot", { n: p.page });
    case "page":
      return tr("redact.where.page", { n: p.page });
  }
}

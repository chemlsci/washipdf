/**
 * 文書比較の書き出し：
 * - 注釈付き PDF：比べた PDF の、違う所にハイライト・付箋を付ける
 * - 報告のページ：表紙（件数・一覧）と、違いのあるページごとの画像と文字の違い（いまの文書に挿入する）
 * - Markdown：文字の違いの一覧
 */
import type { Hunk, Segment } from "./compare";
import { type CompareResult, entryChanged, type PageEntry, type Rect, rotRect } from "./compareDocs";
import { buildPdf } from "./exportPdf";
import { measureBundled, pickFont } from "./fonts";
import { uid } from "./geometry";
import type { Key, Vars } from "./i18n";
import { blankPage } from "./loader";
import type { EditObj, MarkupObj, NoteObj, PageItem, SourceDoc, StoredImage, TextObj } from "./types";

type T = (key: Key, vars?: Vars) => string;

export interface Side {
  doc: SourceDoc;
  pages: PageItem[];
}

export type EntryState = "same" | "changed" | "add" | "del" | "move";
export function stateOf(e: PageEntry): EntryState {
  if (e.kind === "add" || e.kind === "del" || e.kind === "move") return e.kind;
  return entryChanged(e) ? "changed" : "same";
}
export const STATE_KEY: Record<EntryState, Key> = { same: "compare.st.same", changed: "compare.st.changed", add: "compare.st.add", del: "compare.st.del", move: "compare.st.move" };

const pageNo = (n: number | null) => (n == null ? "—" : String(n + 1));
const plain = (segs: Segment[]) => segs.map((s) => s.text).join("");

/** 違いを 1 行の文字にする（[-消えた部分-] {+増えた部分+}） */
export function hunkLines(h: Hunk, t: T): string[] {
  const mark = (segs: Segment[], open: string, close: string) => segs.map((s) => (s.mark ? `${open}${s.text}${close}` : s.text)).join("");
  if (h.kind === "reflow") return [`↵ ${t("compare.reflow")} ${plain(h.a)}`];
  const out: string[] = [];
  if (h.a.length) out.push(`− ${mark(h.a, "[-", "-]")}`);
  if (h.b.length) out.push(`+ ${mark(h.b, "{+", "+}")}`);
  return out;
}

const counts = (r: CompareResult) => {
  const c = { changed: 0, added: 0, deleted: 0, moved: 0 };
  for (const e of r.entries) {
    const s = stateOf(e);
    if (s === "changed") c.changed++;
    else if (s === "add") c.added++;
    else if (s === "del") c.deleted++;
    else if (s === "move") c.moved++;
  }
  return c;
};

export interface Names {
  a: string;
  b: string;
  aPages: number;
  bPages: number;
  loose: boolean;
}

// ───────────────────────── Markdown ─────────────────────────

/** Markdown として意味が変わる記号だけに \ を付ける（行頭の見出し・箇条書きの記号と、強調・リンク・表の記号） */
const mdEscape = (s: string) => s.replace(/([\\`*_[\]<>|~])/g, "\\$1").replace(/^(\s*)([#>+-]|\d+\.)(?=\s)/, "$1\\$2");

export function compareMarkdown(r: CompareResult, n: Names, t: T): string {
  const changed = r.entries.filter(entryChanged);
  const md: string[] = [];
  md.push(`# ${mdEscape(t("compare.r.title"))}`, "");
  md.push(`- ${mdEscape(t("compare.r.files", { a: n.a, an: n.aPages, b: n.b, bn: n.bPages }))}`);
  md.push(`- ${mdEscape(changed.length ? t("compare.summary", { changed: changed.length, total: r.entries.length }) : t("compare.identical"))}`);
  md.push(`- ${mdEscape(t("compare.counts", counts(r)))}`);
  if (n.loose) md.push(`- ${mdEscape(t("compare.r.loose"))}`);
  for (const e of changed) {
    md.push("", `## ${mdEscape(`${t("compare.pairInfo", { a: pageNo(e.a), b: pageNo(e.b) })}（${t(STATE_KEY[stateOf(e)])}）`)}`, "");
    if (e.kind === "del") md.push(`- ${mdEscape(t("compare.onlyA"))}`);
    if (e.kind === "add") md.push(`- ${mdEscape(t("compare.onlyB"))}`);
    if (e.kind === "move") md.push(`- ${mdEscape(t("compare.moved"))}`);
    if (e.rotate) md.push(`- ${mdEscape(t("compare.rotated"))}`);
    if (e.a != null && e.b != null && e.textA !== e.textB) md.push(`- ${mdEscape(t("compare.noTextOne"))}`);
    if (e.visual) md.push(`- ${mdEscape(t("compare.r.visual"))}`);
    for (const h of e.hunks) {
      if (h.kind === "reflow") md.push(`- ↵ ${mdEscape(t("compare.reflow"))} ${mdEscape(plain(h.a))}`);
      if (h.a.length && h.kind !== "reflow") md.push(`- − ${h.a.map((s) => (s.mark && s.text.trim() ? `~~${mdEscape(s.text)}~~` : mdEscape(s.text))).join("")}`);
      if (h.b.length && h.kind !== "reflow") md.push(`- \\+ ${h.b.map((s) => (s.mark && s.text.trim() ? `**${mdEscape(s.text)}**` : mdEscape(s.text))).join("")}`);
    }
  }
  return md.join("\n") + "\n";
}

// ───────────────────────── 注釈付き PDF ─────────────────────────

const GREEN = "#7bd88f";

/** 比べた PDF に、違う所の注釈を付けた PDF を作る */
export async function annotatedPdf(B: Side, r: CompareResult, t: T): Promise<Uint8Array> {
  const pages: PageItem[] = B.pages.map((p) => ({ ...p, objects: [...p.objects] }));
  const author = t("compare.n.author");
  const note = (page: PageItem, x: number, y: number, contents: string): NoteObj => ({
    id: uid("cmp"),
    type: "note",
    x: Math.max(0, Math.min(page.width - 20, x)),
    y: Math.max(0, Math.min(page.height - 20, y)),
    color: "#f5c542",
    contents,
    author,
  });
  // 削除されたページ：比べた PDF の次のページに書く
  let pendingDeleted: number[] = [];
  for (const e of r.entries) {
    if (e.kind === "del") {
      pendingDeleted.push(e.a! + 1);
      continue;
    }
    if (e.b == null) continue;
    const page = pages[e.b];
    const objs: EditObj[] = [];
    if (pendingDeleted.length) {
      objs.push(note(page, 4, 4, t("compare.n.deletedPages", { pages: pendingDeleted.join(", ") })));
      pendingDeleted = [];
    }
    if (e.kind === "add") objs.push(note(page, 24, 4, t("compare.n.addedPage")));
    if (e.kind === "move") objs.push(note(page, 24, 4, t("compare.n.movedPage", { n: e.a! + 1 })));
    e.hunks.forEach((h, k) => {
      if (h.kind === "reflow") return;
      const before = plain(h.a).trim();
      const contents = h.kind === "add" ? t("compare.n.added") : before ? t("compare.n.before", { text: before }) : "";
      const rects = h.bRefs.length ? markRectsOfHunk(r, e, h) : [];
      rects.forEach((rc, q) => {
        // 1 つの違いが何行にもまたがるときは、最初のハイライトにだけ内容を入れる（注釈の一覧に同じものが並ばないように）
        const m: MarkupObj = { id: uid("cmp"), type: "markup", kind: "highlight", x: rc.x, y: rc.y, w: rc.w, h: rc.h, color: GREEN, opacity: 0.5, contents: q === 0 ? contents : "", author };
        objs.push(m);
      });
      // 消えただけの違い（比べた PDF の側に印を付ける文字が無い）：その場所に付箋で示す
      if (h.kind === "del" || (!rects.length && before)) {
        const at = e.hunkRects[k]?.b;
        objs.push(note(page, (at?.x ?? 20) - 22, (at?.y ?? 20) - 4, t("compare.n.deleted", { text: before })));
      }
    });
    // 図・画像などの見た目の違い：枠ごとに付箋（表示の倍率の画素 → 比べた PDF の表示座標）
    const sb = { w: page.width, h: page.height };
    const rotated = e.rotate % 180 ? { w: sb.h, h: sb.w } : sb;
    for (const bx of mergeBoxes(e.boxesB ?? [], 24 * e.scale).slice(0, 20)) {
      const rc = rotRect({ x: bx.x / e.scale, y: bx.y / e.scale, w: bx.w / e.scale, h: bx.h / e.scale }, rotated.w, rotated.h, (360 - e.rotate) % 360);
      objs.push(note(page, rc.x - 22, rc.y, t("compare.n.visual")));
    }
    page.objects.push(...objs);
  }
  return buildPdf(pages, new Map([[B.doc.id, B.doc]]), new Map());
}

/** 近い枠（間が gap 以下）をまとめる。スキャンの図 1 つが細かい枠に分かれても、付箋は 1 つにする */
function mergeBoxes<B extends { x: number; y: number; w: number; h: number }>(boxes: B[], gap: number): { x: number; y: number; w: number; h: number }[] {
  const out = boxes.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h }));
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < out.length && !merged; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i];
        const b = out[j];
        if (a.x - gap <= b.x + b.w && b.x - gap <= a.x + a.w && a.y - gap <= b.y + b.h && b.y - gap <= a.y + a.h) {
          const x = Math.min(a.x, b.x);
          const y = Math.min(a.y, b.y);
          out[i] = { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
          out.splice(j, 1);
          merged = true;
          break;
        }
      }
    }
  }
  return out;
}

/** 違いの、比べた PDF の側の語の位置（表示座標） */
function markRectsOfHunk(r: CompareResult, e: PageEntry, h: Hunk): Rect[] {
  const tb = r.textsB[e.b!];
  const out: Rect[] = [];
  for (const c of h.bRefs) {
    const bs = tb.boxes[c.line]?.slice(c.start, c.end).filter((b) => b.w > 0 || b.h > 0) ?? [];
    if (!bs.length) continue;
    const x0 = Math.min(...bs.map((b) => b.x));
    const y0 = Math.min(...bs.map((b) => b.y));
    const x1 = Math.max(...bs.map((b) => b.x + b.w));
    const y1 = Math.max(...bs.map((b) => b.y + b.h));
    out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  return out;
}

// ───────────────────────── 報告のページ ─────────────────────────

export interface Snapshot {
  bytes: Uint8Array;
  width: number;
  height: number;
}

const A4 = { w: 595.28, h: 841.89 };
const M = 40;
/** 画像を載せるページ数の上限（それより後は文字だけ） */
const MAX_IMAGE_ENTRIES = 60;

/** 文字を幅に収まるよう折り返す */
function wrap(text: string, font: string, size: number, width: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of text) {
    const next = cur + ch;
    if (cur && measureBundled(font, next, size) > width) {
      // 英字の語の途中なら、語の頭で折り返す
      const sp = cur.lastIndexOf(" ");
      if (/\S/.test(ch) && sp > cur.length * 0.6) {
        out.push(cur.slice(0, sp));
        cur = cur.slice(sp + 1) + ch;
      } else {
        out.push(cur);
        cur = ch === " " ? "" : ch;
      }
    } else cur = next;
  }
  if (cur || !out.length) out.push(cur);
  return out;
}

/**
 * 比較の報告を PDF にする（いまの文書に挿入する用）。snapshot は、違いのあるページの画像（色付け済み）を作る
 */
export async function reportPdf(r: CompareResult, n: Names, t: T, snapshot: (e: PageEntry, side: "a" | "b") => Promise<Snapshot | null>): Promise<Uint8Array> {
  const allText = [n.a, n.b, ...r.entries.flatMap((e) => e.hunks.flatMap((h) => hunkLines(h, t)))].join("");
  const font = pickFont("sans", allText + t("compare.r.title"));
  const pages: PageItem[] = [];
  const images = new Map<string, StoredImage>();
  let page = blankPage(A4.w, A4.h);
  let y = M;
  const newPage = () => {
    pages.push(page);
    page = blankPage(A4.w, A4.h);
    y = M;
  };
  const text = (s: string, size: number, color = "#222222", indent = 0) => {
    for (const line of wrap(s, font, size, A4.w - 2 * M - indent)) {
      if (y + size * 1.4 > A4.h - M) newPage();
      const o: TextObj = { id: uid("cmp"), type: "text", x: M + indent, y, text: line, fontSize: size, font, color };
      page.objects.push(o);
      y += size * 1.4;
    }
  };
  // 表紙
  text(t("compare.r.title"), 18);
  y += 6;
  text(t("compare.r.files", { a: n.a, an: n.aPages, b: n.b, bn: n.bPages }), 10);
  const changed = r.entries.filter(entryChanged);
  text(changed.length ? t("compare.summary", { changed: changed.length, total: r.entries.length }) : t("compare.identical"), 10);
  text(t("compare.counts", counts(r)), 10);
  if (n.loose) text(t("compare.r.loose"), 9, "#555555");
  text(t("compare.r.legend"), 9, "#555555");
  if (changed.length > MAX_IMAGE_ENTRIES) text(t("compare.r.noImages", { n: changed.length - MAX_IMAGE_ENTRIES }), 9, "#555555");
  y += 8;
  for (const e of changed) text(`・${t("compare.pairInfo", { a: pageNo(e.a), b: pageNo(e.b) })}（${t(STATE_KEY[stateOf(e)])}）`, 9);
  // 違いのあるページごと
  let imaged = 0;
  for (const e of changed) {
    newPage();
    text(`${t("compare.pairInfo", { a: pageNo(e.a), b: pageNo(e.b) })}（${t(STATE_KEY[stateOf(e)])}）`, 12);
    y += 4;
    if (imaged < MAX_IMAGE_ENTRIES) {
      imaged++;
      const colW = (A4.w - 2 * M - 12) / 2;
      let maxH = 0;
      for (const [k, side] of (["a", "b"] as const).entries()) {
        const snap = await snapshot(e, side);
        if (!snap) continue;
        const id = uid("cmpimg");
        images.set(id, { id, bytes: snap.bytes, mime: "image/jpeg", url: "", width: snap.width, height: snap.height });
        const w = colW;
        const h = Math.min(380, (w * snap.height) / snap.width);
        const ww = (h * snap.width) / snap.height;
        page.objects.push({ id: uid("cmp"), type: "image", x: M + k * (colW + 12), y: y + 12, w: ww, h, imageId: id, opacity: 1 });
        page.objects.push({ id: uid("cmp"), type: "text", x: M + k * (colW + 12), y, text: side === "a" ? t("compare.current") : n.b, fontSize: 8, font, color: "#555555" });
        page.objects.push({ id: uid("cmp"), type: "rect", x: M + k * (colW + 12), y: y + 12, w: ww, h, stroke: "#999999", fill: null, strokeWidth: 0.5, opacity: 1 });
        maxH = Math.max(maxH, h);
      }
      y += maxH + 22;
    }
    if (e.kind === "del") text(t("compare.onlyA"), 9, "#555555");
    if (e.kind === "add") text(t("compare.onlyB"), 9, "#555555");
    if (e.kind === "move") text(t("compare.moved"), 9, "#555555");
    if (e.rotate) text(t("compare.rotated"), 9, "#555555");
    if (e.visual) text(t("compare.r.visual"), 9, "#555555");
    for (const h of e.hunks) for (const l of hunkLines(h, t)) text(l, 9, l.startsWith("−") ? "#b3261e" : l.startsWith("+") ? "#1e7a3c" : "#555555", 4);
  }
  pages.push(page);
  return buildPdf(pages, new Map(), images);
}

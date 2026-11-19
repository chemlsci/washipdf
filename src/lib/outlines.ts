/**
 * しおり（目次／アウトライン）の読み取りと書き込み。
 * アプリ内では「階層の深さ付きの平らな一覧」で持ち、ページは PageItem の id で指す（並べ替えや削除に追随するため）。
 */
import { PDFArray, PDFDict, type PDFDocument, PDFHexString, PDFName, PDFNumber, type PDFObject, PDFRef, PDFString } from "pdf-lib";
import { normalizeLinkUrl } from "./annots";
import { uid } from "./geometry";

export interface OutlineItem {
  id: string;
  title: string;
  /** 指すページ（PageItem の id）。無ければ null */
  pageId: string | null;
  /** 0 がトップレベル */
  level: number;
  /** 行き先のページの中の高さ（PDF の座標。元のしおりが位置を指していたとき）。無ければページ全体を表示する */
  top?: number;
  /** ページではなく Web のアドレスを開くしおり（元の PDF にあったもの。http(s)・mailto だけ） */
  uri?: string;
}

const text = (o: PDFObject | undefined): string => (o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : "");

/** 名前付き宛先を探す（/Dests 辞書と /Names /Dests 名前ツリー） */
export function findNamedDest(doc: PDFDocument, name: string): PDFObject | undefined {
  const dests = doc.catalog.lookup(PDFName.of("Dests"));
  if (dests instanceof PDFDict) {
    const d = dests.lookup(PDFName.of(name));
    if (d) return d;
  }
  const names = doc.catalog.lookup(PDFName.of("Names"));
  const tree = names instanceof PDFDict ? names.lookup(PDFName.of("Dests")) : undefined;
  if (!(tree instanceof PDFDict)) return undefined;
  const seen = new Set<PDFDict>();
  const walk = (node: PDFDict, depth: number): PDFObject | undefined => {
    if (seen.has(node) || depth > 32) return undefined;
    seen.add(node);
    const arr = node.lookup(PDFName.of("Names"));
    if (arr instanceof PDFArray) {
      for (let i = 0; i + 1 < arr.size(); i += 2) {
        if (text(doc.context.lookup(arr.get(i))) === name) return doc.context.lookup(arr.get(i + 1));
      }
    }
    const kids = node.lookup(PDFName.of("Kids"));
    if (kids instanceof PDFArray) {
      for (const k of kids.asArray()) {
        const kd = doc.context.lookup(k);
        const r = kd instanceof PDFDict ? walk(kd, depth + 1) : undefined;
        if (r) return r;
      }
    }
    return undefined;
  };
  return walk(tree, 0);
}

/** 宛先（配列・名前・アクション）から、ページの中の高さ（/XYZ・/FitH などの「上」の値）を得る。指していなければ undefined */
function destTop(doc: PDFDocument, dest: PDFObject | undefined, depth = 0): number | undefined {
  if (!dest || depth > 4) return undefined;
  const d = doc.context.lookup(dest);
  if (d instanceof PDFArray && d.size() >= 2) {
    const kind = String(doc.context.lookup(d.get(1)));
    const at = kind === "/XYZ" ? 3 : kind === "/FitH" || kind === "/FitBH" ? 2 : kind === "/FitR" ? 5 : -1;
    const v = at >= 0 && at < d.size() ? doc.context.lookup(d.get(at)) : undefined;
    return v instanceof PDFNumber ? v.asNumber() : undefined;
  }
  if (d instanceof PDFString || d instanceof PDFHexString || d instanceof PDFName) return destTop(doc, findNamedDest(doc, d.decodeText()), depth + 1);
  if (d instanceof PDFDict) return destTop(doc, d.get(PDFName.of("D")), depth + 1);
  return undefined;
}

/** 宛先（配列・名前・アクション）からページ番号（0 始まり）を得る */
function destPageIndex(doc: PDFDocument, dest: PDFObject | undefined, pageRefs: PDFRef[], depth = 0): number {
  if (!dest || depth > 4) return -1;
  const d = doc.context.lookup(dest);
  if (d instanceof PDFArray && d.size()) {
    const first = d.get(0);
    if (first instanceof PDFRef) return pageRefs.findIndex((r) => r.objectNumber === first.objectNumber && r.generationNumber === first.generationNumber);
    const n = doc.context.lookup(first);
    if (n instanceof PDFNumber) return n.asNumber();
    return -1;
  }
  if (d instanceof PDFString || d instanceof PDFHexString) return destPageIndex(doc, findNamedDest(doc, d.decodeText()), pageRefs, depth + 1);
  if (d instanceof PDFName) return destPageIndex(doc, findNamedDest(doc, d.decodeText()), pageRefs, depth + 1);
  if (d instanceof PDFDict) return destPageIndex(doc, d.get(PDFName.of("D")), pageRefs, depth + 1);
  return -1;
}

/** しおりを読む。pageIds[元のページ番号] = PageItem の id */
export function readOutlines(doc: PDFDocument, pageIds: string[]): OutlineItem[] {
  const out: OutlineItem[] = [];
  const root = doc.catalog.lookup(PDFName.of("Outlines"));
  if (!(root instanceof PDFDict)) return out;
  const pageRefs = doc.getPages().map((p) => p.ref);
  const seen = new Set<string>();
  const walk = (first: PDFObject | undefined, level: number) => {
    let cur = first;
    while (cur instanceof PDFRef && !seen.has(cur.toString()) && out.length < 5000) {
      seen.add(cur.toString());
      const item = doc.context.lookup(cur);
      if (!(item instanceof PDFDict)) break;
      let dest = item.get(PDFName.of("Dest"));
      if (!dest) {
        const a = item.lookup(PDFName.of("A"));
        if (a instanceof PDFDict && a.lookup(PDFName.of("S")) === PDFName.of("GoTo")) dest = a.get(PDFName.of("D"));
      }
      let idx = destPageIndex(doc, dest, pageRefs);
      // Web のアドレスを開くしおり（行き先のページは無い）
      let uri: string | undefined;
      if (!dest) {
        const a = item.lookup(PDFName.of("A"));
        const u = a instanceof PDFDict && a.lookup(PDFName.of("S")) === PDFName.of("URI") ? a.lookup(PDFName.of("URI")) : undefined;
        uri = (u instanceof PDFString || u instanceof PDFHexString ? normalizeLinkUrl(u.decodeText()) : null) ?? undefined;
      }
      // 行き先を持たず、文書の構造の要素（/SE。タグ付き PDF の見出しなど）だけを指すしおり：その要素のあるページへ飛ぶ
      if (idx < 0 && !dest) {
        // 要素そのものにページ（/Pg）が無ければ、子の要素を順にたどって最初に見つかるページを使う
        const pageOf = (o: PDFObject | undefined, depth: number): PDFRef | null => {
          const e = o instanceof PDFRef ? doc.context.lookup(o) : o;
          if (depth > 12 || !e) return null;
          if (e instanceof PDFArray) {
            for (const k of e.asArray().slice(0, 64)) {
              const r = pageOf(k, depth + 1);
              if (r) return r;
            }
            return null;
          }
          if (!(e instanceof PDFDict)) return null;
          const pg = e.get(PDFName.of("Pg"));
          return pg instanceof PDFRef ? pg : pageOf(e.get(PDFName.of("K")), depth + 1);
        };
        const pg = pageOf(item.get(PDFName.of("SE")), 0);
        if (pg) idx = pageRefs.findIndex((r) => r.objectNumber === pg.objectNumber && r.generationNumber === pg.generationNumber);
      }
      const top = idx >= 0 ? destTop(doc, dest) : undefined;
      out.push({ id: uid("ol"), title: text(item.lookup(PDFName.of("Title"))), pageId: idx >= 0 ? (pageIds[idx] ?? null) : null, level, ...(top !== undefined ? { top } : {}), ...(uri && idx < 0 ? { uri } : {}) });
      // とても深い階層（16 段より下）は、消さずに 16 段目にそろえる
      walk(item.get(PDFName.of("First")), Math.min(level + 1, 15));
      cur = item.get(PDFName.of("Next"));
    }
  };
  walk(root.get(PDFName.of("First")), 0);
  return out;
}

/** しおりを書く（既存の /Outlines は置き換える）。pageIndexOf は PageItem id → 出力ページ番号（無ければ -1） */
export function writeOutlines(doc: PDFDocument, items: OutlineItem[], pageIndexOf: (pageId: string | null) => number): void {
  const ctx = doc.context;
  doc.catalog.delete(PDFName.of("Outlines"));
  // 行き先のページがこの PDF に無いしおりは入れない（分割したファイルや、ページを削った PDF で、どこにも飛ばない項目を残さない）。
  // 行き先の無い見出しだけのしおりは残す
  const usable = items.filter((it) => it.title.trim() && (it.pageId === null || pageIndexOf(it.pageId) >= 0));
  if (!usable.length) return;
  const pages = doc.getPages();
  interface Node {
    item: OutlineItem;
    ref: PDFRef;
    children: Node[];
    parent: Node | null;
  }
  const rootRef = ctx.nextRef();
  const roots: Node[] = [];
  const stack: Node[] = [];
  for (const it of usable) {
    const level = Math.max(0, Math.min(it.level, stack.length));
    stack.length = level;
    const node: Node = { item: it, ref: ctx.nextRef(), children: [], parent: stack[level - 1] ?? null };
    (node.parent ? node.parent.children : roots).push(node);
    stack.push(node);
  }
  const countOf = (n: Node): number => n.children.reduce((s, c) => s + 1 + countOf(c), 0);
  const emit = (nodes: Node[], parentRef: PDFRef) => {
    nodes.forEach((n, i) => {
      const idx = pageIndexOf(n.item.pageId);
      const dict: Record<string, PDFObject> = {
        Title: PDFHexString.fromText(n.item.title),
        Parent: parentRef,
      };
      if (i > 0) dict.Prev = nodes[i - 1].ref;
      if (i < nodes.length - 1) dict.Next = nodes[i + 1].ref;
      if (n.children.length) {
        dict.First = n.children[0].ref;
        dict.Last = n.children[n.children.length - 1].ref;
        dict.Count = PDFNumber.of(countOf(n));
      }
      // 元のしおりがページの中の位置を指していたら、その高さへ飛ぶ（倍率はそのまま）。無ければページ全体を表示
      if (idx >= 0 && idx < pages.length) dict.Dest = typeof n.item.top === "number" ? ctx.obj([pages[idx].ref, PDFName.of("XYZ"), null, n.item.top, null]) : ctx.obj([pages[idx].ref, PDFName.of("Fit")]);
      // 行き先のページが無く、Web のアドレスを持つしおり（アドレスは ASCII だけにそろえてあるので、16 進の文字列で書く）
      else if (n.item.uri && n.item.pageId === null) {
        const u = normalizeLinkUrl(n.item.uri);
        if (u) dict.A = ctx.obj({ S: "URI", URI: PDFHexString.of([...u].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("")) });
      }
      ctx.assign(n.ref, ctx.obj(dict));
      emit(n.children, n.ref);
    });
  };
  emit(roots, rootRef);
  ctx.assign(rootRef, ctx.obj({ Type: "Outlines", First: roots[0].ref, Last: roots[roots.length - 1].ref, Count: PDFNumber.of(roots.reduce((s, r) => s + 1 + countOf(r), 0)) }));
  doc.catalog.set(PDFName.of("Outlines"), rootRef);
}

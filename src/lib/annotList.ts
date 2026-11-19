// 注釈の一覧：このアプリで付けた注釈（ハイライト・付箋・手書き・スタンプなど）と、元の PDF の注釈を、ページ順に並べる
import { apply } from "./geometry";
import type { Key } from "./i18n";
import type { EditObj, PageItem, SourceDoc } from "./types";

export interface AnnotEntry {
  key: string;
  pageId: string;
  pageNo: number;
  /** 種類の名前（文言のキー） */
  kind: Key;
  author: string;
  text: string;
  /** ページの上の位置（表示座標） */
  rect: { x: number; y: number; w: number; h: number };
  /** このアプリで付けたもの（部品の id）。元の PDF の注釈なら undefined */
  objId?: string;
}

/**
 * 元の PDF の注釈の種類 → 文言のキー（一覧に出すもの。リンク・入力欄・付箋の吹き出しなどは出さない）。
 * 種類の名前は PDF に書かれた文字列そのものなので、Map で引く
 * （普通のオブジェクトで引くと、"constructor" や "toString" といった名前が、どのオブジェクトにもある関数に当たってしまう）
 */
const SOURCE_KINDS = new Map<string, Key>([
  ["Text", "tool.note"],
  ["FreeText", "annot.freeText"],
  ["Highlight", "tool.highlight"],
  ["Underline", "tool.underline"],
  ["StrikeOut", "tool.strikeout"],
  ["Squiggly", "annot.squiggly"],
  ["Square", "tool.rect"],
  ["Circle", "tool.ellipse"],
  ["Line", "tool.line"],
  ["Ink", "tool.ink"],
  ["Stamp", "tool.stamp"],
  ["Polygon", "annot.polygon"],
  ["PolyLine", "annot.polygon"],
  ["Caret", "annot.caret"],
  ["FileAttachment", "annot.file"],
]);

/** 元の PDF の注釈の種類に対応する文言のキー。一覧に出さない種類・知らない種類は undefined */
export const sourceKind = (subtype: unknown): Key | undefined => (typeof subtype === "string" ? SOURCE_KINDS.get(subtype) : undefined);

function ownKind(o: EditObj): Key | null {
  if (o.type === "markup") return o.kind === "highlight" ? "tool.highlight" : o.kind === "underline" ? "tool.underline" : "tool.strikeout";
  if (o.type === "note") return "tool.note";
  if (o.type === "ink") return "tool.ink";
  if (o.type === "stamp") return o.frame === "grid" ? "sign.approval" : "tool.stamp";
  return null;
}

type RawAnnot = { subtype?: string; rect?: number[]; contentsObj?: { str?: string }; titleObj?: { str?: string }; contents?: string; title?: string; id?: string };

export async function listAnnotations(pages: PageItem[], sources: Map<string, SourceDoc>, includeSource: boolean): Promise<AnnotEntry[]> {
  const out: AnnotEntry[] = [];
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    // 元の PDF の注釈（「元の注釈を削除」を選んでいれば、保存で消えるので出さない）
    const src = includeSource && page.srcId ? sources.get(page.srcId) : undefined;
    if (src) {
      try {
        const annots = (await (await src.pdf.getPage(page.srcIndex + 1)).getAnnotations()) as RawAnnot[];
        annots.forEach((a, k) => {
          const kind = sourceKind(a.subtype);
          if (!kind || !Array.isArray(a.rect) || a.rect.length < 4 || !a.rect.slice(0, 4).every((v) => typeof v === "number" && Number.isFinite(v))) return;
          const [x0, y0, x1, y1] = a.rect;
          const pts = [apply(page.viewTransform, x0, y0), apply(page.viewTransform, x1, y1)];
          const rect = { x: Math.min(pts[0][0], pts[1][0]), y: Math.min(pts[0][1], pts[1][1]), w: Math.abs(pts[1][0] - pts[0][0]), h: Math.abs(pts[1][1] - pts[0][1]) };
          // 作成者・本文は PDF に書かれた値。文字列でなければ空として扱う
          const str = (...vs: unknown[]) => vs.find((v): v is string => typeof v === "string") ?? "";
          out.push({ key: `${page.id}:src:${typeof a.id === "string" ? a.id : k}`, pageId: page.id, pageNo: i + 1, kind, author: str(a.titleObj?.str, a.title), text: str(a.contentsObj?.str, a.contents), rect });
        });
      } catch {
        /* 読めないページは飛ばす */
      }
    }
    for (const o of page.objects) {
      const kind = ownKind(o);
      if (!kind) continue;
      const w = "w" in o ? o.w : 20;
      const h = "h" in o ? o.h : 20;
      const text = o.type === "note" ? o.contents : o.type === "markup" ? o.contents : o.type === "stamp" ? o.text : "";
      out.push({ key: `${page.id}:${o.id}`, pageId: page.id, pageNo: i + 1, kind, author: o.type === "note" ? o.author : "", text, rect: { x: o.x, y: o.y, w, h }, objId: o.id });
    }
  }
  return out;
}

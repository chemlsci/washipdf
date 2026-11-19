// 元の PDF のリンク（URL・文書の中のページへの移動）を読み、編集できる部品（LinkObj）にする
import { normalizeLinkUrl } from "./annots";
import { apply, uid } from "./geometry";
import type { LinkObj, PageItem, SourceDoc } from "./types";

type RawAnnot = { id?: string; subtype?: string; rect?: number[]; url?: string; unsafeUrl?: string; dest?: unknown; action?: string; newWindow?: boolean; attachment?: unknown };

/**
 * 読み込めるリンク（Web・メールの URL と、文書の中のページへの移動）を部品にする。refs は読み込んだリンクの元の参照で、
 * 保存のときはそれだけを外す（ほかのファイルを開く・ページ送りの命令・JavaScript などのリンクは、触らずに元のまま残す）
 */
export async function readPageLinks(src: SourceDoc, page: PageItem, pages: PageItem[]): Promise<{ links: LinkObj[]; refs: string[] }> {
  const pdfPage = await src.pdf.getPage(page.srcIndex + 1);
  const annots = (await pdfPage.getAnnotations()) as RawAnnot[];
  const out: LinkObj[] = [];
  const refs: string[] = [];
  for (const a of annots) {
    if (a.subtype !== "Link" || !a.rect || a.rect.length < 4) continue;
    const [x0, y0, x1, y1] = a.rect;
    const pts = [apply(page.viewTransform, x0, y0), apply(page.viewTransform, x1, y0), apply(page.viewTransform, x0, y1), apply(page.viewTransform, x1, y1)];
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    if (!a.id || a.action) continue;
    const raw = a.url ?? a.unsafeUrl;
    if (raw) {
      // 書ける URL だけ（ほかのファイルを開くリンク・tel: などは、部品にせず元のまま残す）
      const url = normalizeLinkUrl(raw);
      if (!url || a.newWindow !== undefined) continue;
      out.push({ id: uid(), type: "link", ...box, target: { kind: "url", url: raw.trim() } });
      refs.push(a.id);
      continue;
    }
    // ページへの移動：行き先（名前つきなら引いて）のページを、この文書のページに対応させる
    let dest = a.dest;
    if (typeof dest === "string") dest = await src.pdf.getDestination(dest).catch(() => null);
    if (!Array.isArray(dest) || !dest.length) continue;
    let index: number | null = null;
    const head = dest[0];
    if (typeof head === "number") index = head;
    else if (head && typeof head === "object") index = await src.pdf.getPageIndex(head as { num: number; gen: number }).catch(() => null);
    if (index == null) continue;
    const target = pages.find((p) => p.srcId === src.id && p.srcIndex === index);
    if (target) {
      out.push({ id: uid(), type: "link", ...box, target: { kind: "page", pageId: target.id } });
      refs.push(a.id);
    }
  }
  return { links: out, refs };
}

/** PDF → テキスト／Markdown。既存文字の行解析（textRuns）をそのまま使う */
import { getPageText, type TextRun } from "./textRuns";
import type { PageItem, SourceDoc } from "./types";

export type TextFormat = "txt" | "md";

/** 行をブロック（段落）にまとめて文字列にする */
function pageToText(runs: TextRun[], md: boolean): string {
  const lines: string[] = [];
  let prevBlock: string | null | undefined;
  let prevBottom = -Infinity;
  for (const r of runs) {
    const newParagraph = r.blockId === null || r.blockId !== prevBlock || r.top - prevBottom > r.fontSize * 1.5;
    if (newParagraph && lines.length) lines.push("");
    // 大きな文字は見出しとみなす（Markdown のみ）
    const text = md && r.fontSize >= 16 && r.blockId === null ? `## ${r.text}` : r.text;
    lines.push(text);
    prevBlock = r.blockId;
    prevBottom = r.top + r.h;
  }
  return lines.join("\n");
}

export async function exportText(pages: PageItem[], sources: Map<string, SourceDoc>, format: TextFormat, onProgress?: (done: number, total: number) => void): Promise<string> {
  const parts: string[] = [];
  let i = 0;
  for (const p of pages) {
    i++;
    onProgress?.(i, pages.length);
    const src = p.srcId ? sources.get(p.srcId) : undefined;
    let body = "";
    if (src) {
      const { runs } = await getPageText(src, p);
      body = pageToText(runs, format === "md");
    }
    // 追加した文字オブジェクトも含める
    const added = p.objects.filter((o) => o.type === "text" || o.type === "textedit").map((o) => (o.type === "text" ? o.text : o.text));
    if (added.length) body += (body ? "\n\n" : "") + added.join("\n");
    parts.push(format === "md" ? `<!-- page ${i} -->\n\n${body}` : body);
  }
  return parts.join(format === "md" ? "\n\n---\n\n" : "\n\n\f\n\n");
}

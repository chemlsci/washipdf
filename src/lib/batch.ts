// まとめて処理：複数の PDF に、同じ処理（圧縮・ページ番号・透かし・個人情報の墨消し・文書情報の削除・パスワード保護）をかける。
// 1 つずつ開いて、ふだんの保存と同じ処理で組み立てる（画面の文書には触らない）
import { defaultSettings } from "./docOps";
import { type BuildOptions, buildPdf } from "./exportPdf";
import { findMatchesInRun, type Match, matchBoxes, PII_PATTERNS, type PiiKind, runBox } from "./findText";
import { uid } from "./geometry";
import { tr } from "./i18n";
import { loadPdfFile } from "./loader";
import { getPageText } from "./textRuns";
import type { RedactObj } from "./types";
import { closePdf } from "./pdfjs";

export interface BatchOptions {
  compress: boolean;
  numbering: boolean;
  /** 透かしの文字（空なら入れない） */
  watermark: string;
  /** 墨消しする個人情報のひな形 */
  pii: PiiKind[];
  /** 文書情報（作成者・作成ソフトなど）を消す */
  sanitize: boolean;
  /** 開くときのパスワード（空なら付けない） */
  password: string;
}

export interface BatchResult {
  name: string;
  ok: boolean;
  /** 失敗の理由（ok が false のとき） */
  error?: string;
  bytes?: Uint8Array;
  /** 墨消しした箇所の数 */
  redactions: number;
  /** 保存のときの知らせ（消しきれなかった所、墨消しした語がほかに残っている、など） */
  warnings?: string[];
  /** 墨消しを自動では確かめられなかったページ（1 始まり） */
  unverified?: number[];
}

export async function runBatch(files: File[], o: BatchOptions, embedFont: BuildOptions["embedFont"], onProgress: (done: number, total: number, name: string) => void): Promise<BatchResult[]> {
  const results: BatchResult[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    onProgress(i, files.length, file.name);
    try {
      // パスワードで開く PDF は、ここではパスワードを聞けないので処理しない
      const { doc, pages } = await loadPdfFile(file);
      try {
        let redactions = 0;
        if (o.pii.length) {
          for (const page of pages) {
            const { runs } = await getPageText(doc, page);
            const add: RedactObj[] = [];
            for (const run of runs) {
              const ms: Match[] = o.pii.flatMap((k) => findMatchesInRun(run.text, PII_PATTERNS[k]));
              if (!ms.length) continue;
              const boxes = await matchBoxes(doc, page, run, ms).catch(() => null);
              ms.forEach((_, k) => {
                // 字の位置が分からないときは、行全体を消す（残すより安全）
                const b = boxes?.[k] ?? runBox(run);
                add.push({ id: uid(), type: "redact", x: b.x, y: b.y, w: b.w, h: b.h, fill: "#000000" });
              });
            }
            redactions += add.length;
            page.objects = [...page.objects, ...add];
          }
        }
        const settings = defaultSettings();
        settings.compress = { ...settings.compress, enabled: o.compress };
        settings.decor.numbering = { ...settings.decor.numbering, enabled: o.numbering };
        if (o.watermark.trim()) settings.decor.watermark = { ...settings.decor.watermark, enabled: true, kind: "text", text: o.watermark.trim() };
        settings.meta = { ...settings.meta, sanitize: o.sanitize };
        if (o.password) settings.security = { ...settings.security, enabled: true, userPassword: o.password, ownerPassword: o.password };
        const base = file.name.replace(/\.pdf$/i, "");
        // 画面で 1 つずつ保存するときと同じように、知らせと、保存後の確かめの結果を受け取る
        const warnings: string[] = [];
        let unverified: number[] = [];
        const bytes = await buildPdf(pages, new Map([[doc.id, doc]]), new Map(), {
          settings,
          embedFont,
          fileName: base,
          batch: true,
          onWarning: (w) => warnings.push(w),
          onRedactCheck: (c) => (unverified = c.unverified),
        });
        results.push({ name: file.name, ok: true, bytes, redactions, warnings, unverified });
      } finally {
        void closePdf(doc.pdf);
      }
    } catch (e) {
      results.push({ name: file.name, ok: false, error: e instanceof Error ? e.message : String(e ?? tr("batch.failed")), redactions: 0 });
    }
  }
  onProgress(files.length, files.length, "");
  return results;
}

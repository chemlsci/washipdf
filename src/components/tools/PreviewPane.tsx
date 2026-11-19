/**
 * ダイアログ用のページプレビュー。設定を変えるたびに（少し待ってから）1 ページだけ保存と同じ処理で組み立て、
 * pdf.js で描いて見せる。保存結果とプレビューが食い違わない。
 */
import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { closePdf, documentOptions, getPdfJs } from "@/lib/pdfjs";

/** pageIndex のページを（いまの設定で）組み立てた 1 ページの PDF を返す */
export type BuildPreview = (pageIndex: number) => Promise<Uint8Array>;

export function PreviewPane({
  build,
  pageCount,
  deps,
  initialPage = 0,
  width = 300,
  zoomable = false,
  overlay,
}: {
  build: BuildPreview;
  pageCount: number;
  deps: unknown[];
  initialPage?: number;
  width?: number;
  /** 拡大して細部（文字のつぶれ・画質）を確かめられるようにする */
  zoomable?: boolean;
  /** 見本の上に重ねる「残る範囲」（ページの幅・高さに対する割合）。外側を暗くし、枠を描く */
  overlay?: (pageIndex: number) => { x: number; y: number; w: number; h: number } | null;
}) {
  const t = useT();
  const [page, setPage] = useState(Math.min(initialPage, Math.max(0, pageCount - 1)));
  const [zoomed, setZoomed] = useState(false);
  const zoom = zoomable && zoomed ? 3 : 1;
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    const tm = setTimeout(async () => {
      try {
        const bytes = await build(page);
        if (cancelled) return;
        const pdfjs = await getPdfJs();
        const pdf = await pdfjs.getDocument({ ...documentOptions(), data: bytes }).promise;
        try {
          const pg = await pdf.getPage(1);
          const vp1 = pg.getViewport({ scale: 1 });
          const scale = ((width * zoom) / vp1.width) * Math.min(window.devicePixelRatio || 1, 2);
          const vp = pg.getViewport({ scale });
          const el = canvas.current;
          if (!el || cancelled) return;
          const off = document.createElement("canvas");
          off.width = Math.ceil(vp.width);
          off.height = Math.ceil(vp.height);
          const ctx = off.getContext("2d")!;
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, off.width, off.height);
          await pg.render({ canvas: off, canvasContext: ctx, viewport: vp }).promise;
          if (cancelled) return;
          el.width = off.width;
          el.height = off.height;
          el.style.width = `${width * zoom}px`;
          el.style.height = `${(off.height / off.width) * width * zoom}px`;
          const out = el.getContext("2d")!;
          out.drawImage(off, 0, 0);
          const r = overlay?.(page);
          if (r) {
            const W = el.width;
            const H = el.height;
            const [x, y, w, h] = [r.x * W, r.y * H, r.w * W, r.h * H];
            out.fillStyle = "rgba(20, 20, 30, 0.5)";
            out.beginPath();
            out.rect(0, 0, W, H);
            out.rect(x, y, w, h);
            out.fill("evenodd");
            const k = W / (width * zoom);
            out.strokeStyle = "#2b59d9";
            out.lineWidth = 2 * k;
            out.setLineDash([6 * k, 4 * k]);
            out.strokeRect(x, y, w, h);
          }
          setError(null);
        } finally {
          void closePdf(pdf);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 280);
    return () => {
      cancelled = true;
      clearTimeout(tm);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, width, zoom, ...deps]);

  return (
    <div className="preview-pane" style={{ width }}>
      <div className="preview-head">
        <span>{t("preview.title")}</span>
        <span className="spacer" />
        {zoomable && (
          <button type="button" className={`btn small preview-zoom ${zoomed ? "on" : ""}`} aria-pressed={zoomed} onClick={() => setZoomed((z) => !z)}>
            {t("preview.zoom")}
          </button>
        )}
        <button type="button" className="icon-btn small" disabled={page <= 0} onClick={() => setPage((p) => p - 1)} title={t("page.prev")}>
          ‹
        </button>
        <span className="preview-page">
          {page + 1} / {pageCount}
        </span>
        <button type="button" className="icon-btn small" disabled={page >= pageCount - 1} onClick={() => setPage((p) => p + 1)} title={t("page.next")}>
          ›
        </button>
      </div>
      <div className={`preview-canvas ${busy ? "busy" : ""} ${zoom > 1 ? "zoomed" : ""}`}>
        <canvas ref={canvas} />
        {error && <p className="note error">{error}</p>}
      </div>
    </div>
  );
}

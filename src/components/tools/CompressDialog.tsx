/** 圧縮（画像の再圧縮）の設定。保存時に適用される */
import { useEffect, useRef, useState } from "react";
import type { CompressSettings, CompressStats } from "@/lib/compress";
import { useT } from "@/lib/i18n";
import { Dialog } from "../Dialog";
import { PreviewPane } from "./PreviewPane";

export const formatBytes = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function CompressDialog({
  compress,
  sourceBytes,
  estimate,
  previewPage,
  pageCount = 0,
  onApply,
  onClose,
}: {
  compress: CompressSettings;
  sourceBytes: number;
  estimate?: (c: CompressSettings) => Promise<{ after: number; stats: CompressStats }>;
  /** 設定 c で pageIndex のページだけを組み立てる（適用前に見た目を確かめる） */
  previewPage?: (c: CompressSettings, pageIndex: number) => Promise<Uint8Array>;
  pageCount?: number;
  onApply: (c: CompressSettings) => void;
  onClose: () => void;
}) {
  const t = useT();
  // この画面を開くのは圧縮したいとき：開いたら「保存時に圧縮する」をオンにしておく（オフのまま［適用］を押しても何も起きないため）
  const [v, setV] = useState<CompressSettings>({ ...compress, enabled: true });
  const [est, setEst] = useState<{ after: number; stats: CompressStats } | null>(null);
  const [estBusy, setEstBusy] = useState(false);
  const run = useRef(0);
  useEffect(() => {
    if (!estimate || !v.enabled) {
      setEst(null);
      setEstBusy(false);
      return;
    }
    const id = ++run.current;
    setEstBusy(true);
    const tm = setTimeout(async () => {
      try {
        const r = await estimate(v);
        if (run.current === id) {
          setEst(r);
          setEstBusy(false);
        }
      } catch {
        if (run.current === id) setEstBusy(false);
      }
    }, 400);
    return () => clearTimeout(tm);
  }, [estimate, v.enabled, v.dpi, v.quality, v.grayscale, v.keepImages, v.bilevel]);
  // 画像を変える設定のときだけ、適用前の見た目を出す
  const showPreview = !!previewPage && pageCount > 0 && v.enabled && !v.keepImages;
  return (
    <Dialog
      title={t("tool.compress")}
      onClose={onClose}
      wide={showPreview}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            className="btn primary"
            onClick={() => {
              onApply(v);
              onClose();
            }}
          >
            {t("stamp.apply")}
          </button>
        </>
      }
    >
      <div className={showPreview ? "with-preview" : undefined}>
        <div className="with-preview-form">
          <p className="note">{t("compress.sourceSize", { size: formatBytes(sourceBytes) })}</p>
          <label className="checkbox">
            <input type="checkbox" checked={v.enabled} onChange={(e) => setV({ ...v, enabled: e.target.checked })} /> {t("compress.enable")}
          </label>
          <fieldset className="group" disabled={!v.enabled}>
            <label className="checkbox">
              <input type="checkbox" checked={!!v.keepImages} onChange={(e) => setV({ ...v, keepImages: e.target.checked })} /> {t("compress.keepImages")}
            </label>
          </fieldset>
          <fieldset className="group" disabled={!v.enabled || !!v.keepImages}>
            <label className="checkbox">
              <input type="checkbox" checked={!!v.bilevel} onChange={(e) => setV({ ...v, bilevel: e.target.checked })} /> {t("compress.bilevel")}
            </label>
          </fieldset>
          <fieldset className="group" disabled={!v.enabled || !!v.keepImages || !!v.bilevel}>
            <label className="field">
              <span>{t("compress.dpi")}</span>
              <select value={v.dpi} onChange={(e) => setV({ ...v, dpi: parseInt(e.target.value, 10) })}>
                {[72, 96, 150, 200, 300].map((d) => (
                  <option key={d} value={d}>
                    {d} dpi{d === 150 ? ` (${t("compress.recommended")})` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>
                {t("compress.quality")} {Math.round(v.quality * 100)}
              </span>
              <input type="range" min={30} max={95} step={5} value={Math.round(v.quality * 100)} onChange={(e) => setV({ ...v, quality: parseInt(e.target.value, 10) / 100 })} />
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={v.grayscale} onChange={(e) => setV({ ...v, grayscale: e.target.checked })} /> {t("compress.grayscale")}
            </label>
          </fieldset>
          {v.enabled && estimate && (
            <p className={`note ${est && est.after < sourceBytes ? "ok" : ""}`}>
              {estBusy
                ? t("compress.estimating")
                : est
                  ? t(est.stats.images ? "compress.after" : "compress.afterNoImages", { after: formatBytes(est.after), percent: Math.max(0, Math.round((1 - est.after / sourceBytes) * 100)), n: est.stats.recompressed, total: est.stats.images }) +
                    (est.stats.fonts ? ` ${t("compress.resultFonts", { fonts: est.stats.fonts, size: formatBytes(est.stats.fontSaved ?? 0) })}` : "")
                  : ""}
            </p>
          )}
          <p className="note">{t("compress.note")}</p>
        </div>
        {showPreview && <PreviewPane build={(n) => previewPage(v, n)} pageCount={pageCount} deps={[v.dpi, v.quality, v.grayscale, !!v.bilevel]} zoomable />}
      </div>
    </Dialog>
  );
}

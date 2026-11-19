/** PDF → 画像、PDF → テキスト／Markdown、メタデータ のダイアログ */
import { useEffect, useMemo, useRef, useState } from "react";
import type { DocMeta } from "@/lib/docOps";
import { useT } from "@/lib/i18n";
import { getLibDoc } from "@/lib/libDoc";
import { pageSet } from "@/lib/pageRanges";
import { exportText } from "@/lib/textExport";
import type { PageItem, SourceDoc } from "@/lib/types";
import { Dialog, NumberField } from "../Dialog";

export interface ImageExportOptions {
  format: "png" | "jpeg";
  dpi: number;
  quality: number;
  pageIds: Set<string>;
}

export function ExportImagesDialog({ pages, selected, onRun, onClose }: { pages: PageItem[]; selected: Set<string>; onRun: (o: ImageExportOptions) => void; onClose: () => void }) {
  const t = useT();
  const [format, setFormat] = useState<"png" | "jpeg">("png");
  const [dpi, setDpi] = useState(150);
  const [quality, setQuality] = useState(0.9);
  const [mode, setMode] = useState<"all" | "selected" | "range">(selected.size ? "selected" : "all");
  const [range, setRange] = useState("");
  const ids = () => {
    if (mode === "selected") return new Set(pages.filter((p) => selected.has(p.id)).map((p) => p.id));
    if (mode === "range") {
      const set = pageSet(range, pages.length);
      return new Set(pages.filter((_, i) => set.has(i)).map((p) => p.id));
    }
    return new Set(pages.map((p) => p.id));
  };
  return (
    <Dialog
      title={t("tool.toImages")}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" onClick={() => onRun({ format, dpi, quality, pageIds: ids() })}>
            {t("export.run")}
          </button>
        </>
      }
    >
      <div className="seg">
        <button className={format === "png" ? "on" : ""} aria-pressed={format === "png"} onClick={() => setFormat("png")}>
          PNG
        </button>
        <button className={format === "jpeg" ? "on" : ""} aria-pressed={format === "jpeg"} onClick={() => setFormat("jpeg")}>
          JPEG
        </button>
      </div>
      <div className="field-row">
        <label className="field">
          <span>{t("images.dpi")}</span>
          <select value={dpi} onChange={(e) => setDpi(parseInt(e.target.value, 10))}>
            {[72, 96, 150, 200, 300].map((d) => (
              <option key={d} value={d}>
                {d} dpi
              </option>
            ))}
          </select>
        </label>
        {format === "jpeg" && (
          <label className="field">
            <span>{t("images.quality", { n: Math.round(quality * 100) })}</span>
            <input type="range" min={0.3} max={1} step={0.05} value={quality} onChange={(e) => setQuality(parseFloat(e.target.value))} />
          </label>
        )}
      </div>
      <div className="field">
        <span>{t("target.label")}</span>
        <div className="seg">
          <button className={mode === "all" ? "on" : ""} aria-pressed={mode === "all"} onClick={() => setMode("all")}>
            {t("target.all")}
          </button>
          <button className={mode === "selected" ? "on" : ""} aria-pressed={mode === "selected"} onClick={() => setMode("selected")} disabled={!selected.size}>
            {t("target.selected")}
          </button>
          <button className={mode === "range" ? "on" : ""} aria-pressed={mode === "range"} onClick={() => setMode("range")}>
            {t("target.range")}
          </button>
        </div>
        {mode === "range" && <input dir="ltr" value={range} placeholder={`1-${pages.length}`} onChange={(e) => setRange(e.target.value)} />}
      </div>
      <p className="note">{t("images.help")}</p>
    </Dialog>
  );
}

export function ExportTextDialog({
  pages,
  sources,
  selected,
  onRun,
  onClose,
}: {
  pages: PageItem[];
  sources: Map<string, SourceDoc>;
  selected: Set<string>;
  onRun: (format: "txt" | "md", pageIds: Set<string>) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [format, setFormat] = useState<"txt" | "md">("txt");
  const [mode, setMode] = useState<"all" | "selected" | "range">(selected.size ? "selected" : "all");
  const [range, setRange] = useState("");
  const targetIds = useMemo(() => {
    if (mode === "selected") return new Set(pages.filter((p) => selected.has(p.id)).map((p) => p.id));
    if (mode === "range") {
      const set = pageSet(range, pages.length);
      return new Set(pages.filter((_, i) => set.has(i)).map((p) => p.id));
    }
    return new Set(pages.map((p) => p.id));
  }, [mode, range, pages, selected]);
  const targetPages = pages.filter((p) => targetIds.has(p.id));

  const [preview, setPreview] = useState("");
  const run = useRef(0);
  useEffect(() => {
    const id = ++run.current;
    setPreview(t("text.previewing"));
    const tm = setTimeout(async () => {
      try {
        const subset = targetPages.slice(0, 2);
        const text = subset.length ? await exportText(subset, sources, format) : "";
        if (run.current === id) setPreview(text.slice(0, 2000) || t("text.empty"));
      } catch {
        if (run.current === id) setPreview("");
      }
    }, 300);
    return () => clearTimeout(tm);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [format, mode, range, targetPages.length, sources]);

  return (
    <Dialog
      title={t("tool.toText")}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="muted">{t("text.targetCount", { n: targetPages.length })}</span>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" disabled={!targetPages.length} onClick={() => onRun(format, targetIds)}>
            {t("export.run")}
          </button>
        </>
      }
    >
      <div className="with-preview">
        <div className="with-preview-form">
          <div className="field">
            <span>{t("text.format")}</span>
            <div className="seg">
              <button className={format === "txt" ? "on" : ""} aria-pressed={format === "txt"} onClick={() => setFormat("txt")}>
                {t("text.plain")}
              </button>
              <button className={format === "md" ? "on" : ""} aria-pressed={format === "md"} onClick={() => setFormat("md")}>
                Markdown
              </button>
            </div>
          </div>
          <div className="field">
            <span>{t("target.label")}</span>
            <div className="seg">
              <button className={mode === "all" ? "on" : ""} aria-pressed={mode === "all"} onClick={() => setMode("all")}>
                {t("target.all")}
              </button>
              <button className={mode === "selected" ? "on" : ""} aria-pressed={mode === "selected"} onClick={() => setMode("selected")} disabled={!selected.size}>
                {t("target.selected")}
              </button>
              <button className={mode === "range" ? "on" : ""} aria-pressed={mode === "range"} onClick={() => setMode("range")}>
                {t("target.range")}
              </button>
            </div>
            {mode === "range" && <input dir="ltr" value={range} placeholder={`1-${pages.length}`} onChange={(e) => setRange(e.target.value)} />}
          </div>
          <p className="note">{t("text.help")}</p>
        </div>
        <div className="text-preview">
          <div className="preview-head">{t("text.preview")}</div>
          <pre>{preview}</pre>
        </div>
      </div>
    </Dialog>
  );
}

export function MetadataDialog({ meta, source, onApply, onClose }: { meta: DocMeta; source?: SourceDoc; onApply: (m: DocMeta) => void; onClose: () => void }) {
  const t = useT();
  const [v, setV] = useState({ ...meta });
  // 元の文書の値（空欄のときは、これが保存される。欄の中に薄く出す）
  const [orig, setOrig] = useState({ title: "", author: "", subject: "", keywords: "" });
  useEffect(() => {
    if (!source) return;
    let live = true;
    void getLibDoc(source)
      .then((d) => {
        if (live && !d.isEncrypted) setOrig({ title: d.getTitle() ?? "", author: d.getAuthor() ?? "", subject: d.getSubject() ?? "", keywords: d.getKeywords() ?? "" });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [source]);
  return (
    <Dialog
      title={t("tool.metadata")}
      onClose={onClose}
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
      <label className="checkbox">
        <input type="checkbox" checked={v.sanitize} onChange={(e) => setV({ ...v, sanitize: e.target.checked })} /> {t("meta.sanitize")}
      </label>
      <p className="note">{t("meta.sanitizeHelp")}</p>
      <fieldset className="group" disabled={v.sanitize}>
        <label className="field">
          <span>{t("meta.title")}</span>
          <input value={v.title} placeholder={orig.title} onChange={(e) => setV({ ...v, title: e.target.value })} />
        </label>
        <label className="field">
          <span>{t("meta.author")}</span>
          <input value={v.author} placeholder={orig.author} onChange={(e) => setV({ ...v, author: e.target.value })} />
        </label>
        <label className="field">
          <span>{t("meta.subject")}</span>
          <input value={v.subject} placeholder={orig.subject} onChange={(e) => setV({ ...v, subject: e.target.value })} />
        </label>
        <label className="field">
          <span>{t("meta.keywords")}</span>
          <input value={v.keywords} placeholder={orig.keywords} onChange={(e) => setV({ ...v, keywords: e.target.value })} />
        </label>
      </fieldset>
      <p className="note">{t("meta.help")}</p>
    </Dialog>
  );
}

/** 画像 → PDF の用紙設定 */
export interface ImageToPdfOptions {
  paper: string | null;
  marginMm: number;
}

export function ImageToPdfDialog({ count, onRun, onClose }: { count: number; onRun: (o: ImageToPdfOptions) => void; onClose: () => void }) {
  const t = useT();
  const [paper, setPaper] = useState<string | null>("A4");
  const [margin, setMargin] = useState(0);
  return (
    <Dialog
      title={t("tool.fromImages")}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" onClick={() => onRun({ paper, marginMm: margin })}>
            {t("fromImages.run", { n: count })}
          </button>
        </>
      }
    >
      <label className="field">
        <span>{t("resize.paperSize")}</span>
        <select value={paper ?? "fit"} onChange={(e) => setPaper(e.target.value === "fit" ? null : e.target.value)}>
          <option value="fit">{t("fromImages.imageSize")}</option>
          {["A4", "A3", "A5", "B5", "Letter", "Legal"].map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      {paper && <NumberField label={t("stamp.margin")} value={margin} min={0} max={50} suffix="mm" onChange={setMargin} />}
      <p className="note">{t("fromImages.help")}</p>
    </Dialog>
  );
}

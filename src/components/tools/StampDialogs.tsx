import type React from "react";
/** ページ番号・ヘッダー／フッター・透かし の設定ダイアログ（文書全体の設定 settings.decor を編集する） */
import { useState } from "react";
import { type Anchor, type DocDecor, type StampStyle } from "@/lib/docOps";
import { coverage, fontList } from "@/lib/fonts";
import { type Key, useT } from "@/lib/i18n";
import { loadImageFile } from "@/lib/loader";
import type { StoredImage } from "@/lib/types";
import { Dialog, NumberField } from "../Dialog";
import { PreviewPane } from "./PreviewPane";
import { Icon } from "../Icon";

const ANCHORS: Anchor[] = ["tl", "tc", "tr", "ml", "mc", "mr", "bl", "bc", "br"];

export function AnchorPicker({ value, onChange, rows }: { value: Anchor; onChange: (a: Anchor) => void; rows?: ("t" | "m" | "b")[] }) {
  const t = useT();
  const list = rows ? ANCHORS.filter((a) => rows.includes(a[0] as "t" | "m" | "b")) : ANCHORS;
  // マスの名前（「上・左」など）。読み上げと、重ねたときの説明に使う
  const name = (a: Anchor) => {
    const v = a[0] === "t" ? t("crop.top") : a[0] === "b" ? t("crop.bottom") : null;
    const h = a[1] === "l" ? t("hf.left") : a[1] === "r" ? t("hf.right") : null;
    return [v, h].filter(Boolean).join(" · ") + (h ? "" : `${v ? " · " : ""}${t("hf.center")}`);
  };
  return (
    <div className="field">
      <span>{t("stamp.position")}</span>
      {/* マスの並びはページの上での位置そのもの（左のマスはページの左）なので、右から左へ書く言語でも裏返さない */}
      <div className={`anchor-grid rows-${rows ? rows.length : 3}`} role="radiogroup" aria-label={t("stamp.position")} dir="ltr">
        {list.map((a) => (
          <button key={a} type="button" role="radio" aria-checked={value === a} className={value === a ? "on" : ""} onClick={() => onChange(a)} title={name(a)} aria-label={name(a)} data-anchor={a}>
            <i />
          </button>
        ))}
      </div>
    </div>
  );
}

export function StyleFields({ style, onChange, sizeMax = 200 }: { style: StampStyle; onChange: (s: StampStyle) => void; sizeMax?: number }) {
  const t = useT();
  return (
    <>
      <div className="field-row">
        <label className="field">
          <span>{t("prop.font")}</span>
          <select value={style.font} onChange={(e) => onChange({ ...style, font: e.target.value })}>
            {fontList().map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <NumberField label={t("prop.size")} value={style.fontSize} min={4} max={sizeMax} step={0.5} onChange={(v) => onChange({ ...style, fontSize: v })} />
      </div>
      <div className="field-row">
        <label className="field">
          <span>{t("prop.color")}</span>
          <input type="color" value={style.color} onChange={(e) => onChange({ ...style, color: e.target.value })} />
        </label>
        <label className="field">
          <span>{t("prop.opacity", { n: Math.round(style.opacity * 100) })}</span>
          <input type="range" min={0.05} max={1} step={0.05} value={style.opacity} onChange={(e) => onChange({ ...style, opacity: parseFloat(e.target.value) })} />
        </label>
      </div>
    </>
  );
}

export function PagesField({ value, onChange, total }: { value: string; onChange: (v: string) => void; total: number }) {
  const t = useT();
  return (
    <label className="field">
      <span>{t("stamp.pages", { total })}</span>
      <input value={value} placeholder={t("stamp.pagesAll")} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

interface DecorDialogProps {
  decor: DocDecor;
  onApply: (d: DocDecor) => void;
  onClose: () => void;
  pageCount: number;
  /** 設定 d で pageIndex のページを組み立てる（プレビュー用） */
  preview?: (d: DocDecor, pageIndex: number) => Promise<Uint8Array>;
}

/** 左にフォーム、右にプレビュー */
function WithPreview({ children, preview, decor, pageCount }: { children: React.ReactNode; preview?: DecorDialogProps["preview"]; decor: DocDecor; pageCount: number }) {
  if (!preview) return <>{children}</>;
  return (
    <div className="with-preview">
      <div className="with-preview-form">{children}</div>
      <PreviewPane build={(i) => preview(decor, i)} pageCount={pageCount} deps={[JSON.stringify(decor)]} />
    </div>
  );
}

const TEMPLATES: { label: Key; value: string }[] = [
  { label: "numbering.tplSimple", value: "{n}" },
  { label: "numbering.tplOfTotal", value: "{n} / {N}" },
  { label: "numbering.tplDash", value: "- {n} -" },
  { label: "numbering.tplPage", value: "Page {n}" },
  { label: "numbering.tplBates", value: "{file}-{n:6}" },
];

export function PageNumbersDialog({ decor, onApply, onClose, pageCount, preview }: DecorDialogProps) {
  const t = useT();
  const [v, setV] = useState({ ...decor.numbering, enabled: true });
  const apply = () => {
    onApply({ ...decor, numbering: v });
    onClose();
  };
  const remove = () => {
    onApply({ ...decor, numbering: { ...v, enabled: false } });
    onClose();
  };
  return (
    <Dialog
      title={t("tool.numbering")}
      onClose={onClose}
      wide={!!preview}
      footer={
        <>
          {decor.numbering.enabled && (
            <button className="btn danger" onClick={remove}>
              {t("stamp.remove")}
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" onClick={apply}>
            {t("stamp.apply")}
          </button>
        </>
      }
    >
      <WithPreview preview={preview} decor={{ ...decor, numbering: v }} pageCount={pageCount}>
      <label className="field">
        <span>{t("numbering.template")}</span>
        <input dir="ltr" value={v.template} onChange={(e) => setV({ ...v, template: e.target.value })} />
      </label>
      <div className="chips">
        {TEMPLATES.map((tp) => {
          // 「ページ 1」の書式は、画面の言語の言い方で入れる（例：Seite 1、第 1 页）。選んでいるフォントで書けない文字なら英語の Page 1 にする。
          // ボタンには、実際に入る文字をそのまま出す
          const local = t("numbering.tplPage").replace("1", "{n}");
          const value = tp.label !== "numbering.tplPage" ? tp.value : local.includes("{n}") && coverage(v.style.font, local.replace("{n}", "1")) === 1 ? local : tp.value;
          return (
            <button key={tp.value} type="button" className={`chip ${v.template === value ? "on" : ""}`} aria-pressed={v.template === value} onClick={() => setV({ ...v, template: value })}>
              {tp.label === "numbering.tplPage" ? value.replace("{n}", "1") : t(tp.label)}
            </button>
          );
        })}
      </div>
      <p className="note">{t("numbering.templateHelp")}</p>
      <div className="field-row">
        <NumberField label={t("numbering.start")} value={v.start} min={0} onChange={(n) => setV({ ...v, start: Math.round(n) })} />
        <NumberField label={t("stamp.margin")} value={v.margin} min={0} max={200} suffix="pt" onChange={(n) => setV({ ...v, margin: n })} />
      </div>
      <AnchorPicker value={v.anchor} onChange={(a) => setV({ ...v, anchor: a })} rows={["t", "b"]} />
      <StyleFields style={v.style} onChange={(s) => setV({ ...v, style: s })} sizeMax={72} />
      <PagesField value={v.pages} onChange={(p) => setV({ ...v, pages: p })} total={pageCount} />
      </WithPreview>
    </Dialog>
  );
}

export function HeaderFooterDialog({ decor, onApply, onClose, pageCount, preview }: DecorDialogProps) {
  const t = useT();
  const [h, setH] = useState({ ...decor.header });
  const [f, setF] = useState({ ...decor.footer });
  const apply = () => {
    onApply({
      ...decor,
      header: { ...h, enabled: !!(h.left || h.center || h.right) },
      footer: { ...f, enabled: !!(f.left || f.center || f.right) },
    });
    onClose();
  };
  const row = (label: string, v: typeof h, set: (x: typeof h) => void) => (
    <fieldset className="group">
      <legend>{label}</legend>
      <div className="field-row three">
        <label className="field">
          <span>{t("hf.left")}</span>
          <input value={v.left} onChange={(e) => set({ ...v, left: e.target.value })} />
        </label>
        <label className="field">
          <span>{t("hf.center")}</span>
          <input value={v.center} onChange={(e) => set({ ...v, center: e.target.value })} />
        </label>
        <label className="field">
          <span>{t("hf.right")}</span>
          <input value={v.right} onChange={(e) => set({ ...v, right: e.target.value })} />
        </label>
      </div>
      <div className="field-row">
        <NumberField label={t("stamp.margin")} value={v.margin} min={0} max={200} suffix="pt" onChange={(n) => set({ ...v, margin: n })} />
        <PagesField value={v.pages} onChange={(p) => set({ ...v, pages: p })} total={pageCount} />
      </div>
      <StyleFields style={v.style} onChange={(s) => set({ ...v, style: s })} sizeMax={48} />
    </fieldset>
  );
  return (
    <Dialog
      title={t("tool.headerFooter")}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" onClick={apply}>
            {t("stamp.apply")}
          </button>
        </>
      }
    >
      <WithPreview
        preview={preview}
        decor={{ ...decor, header: { ...h, enabled: !!(h.left || h.center || h.right) }, footer: { ...f, enabled: !!(f.left || f.center || f.right) } }}
        pageCount={pageCount}
      >
        <p className="note">{t("hf.help")}</p>
        {row(t("hf.header"), h, setH)}
        {row(t("hf.footer"), f, setF)}
      </WithPreview>
    </Dialog>
  );
}

export function WatermarkDialog({ decor, onApply, onClose, pageCount, images, preview }: DecorDialogProps & { images: Map<string, StoredImage> }) {
  const t = useT();
  const [v, setV] = useState({ ...decor.watermark, enabled: true });
  const [err, setErr] = useState<string | null>(null);
  const apply = () => {
    onApply({ ...decor, watermark: v });
    onClose();
  };
  const remove = () => {
    onApply({ ...decor, watermark: { ...v, enabled: false } });
    onClose();
  };
  const pickImage = async (file: File) => {
    try {
      const img = await loadImageFile(file);
      images.set(img.id, img);
      setV({ ...v, kind: "image", imageId: img.id });
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const img = v.imageId ? images.get(v.imageId) : undefined;
  return (
    <Dialog
      title={t("tool.watermark")}
      onClose={onClose}
      wide={!!preview}
      footer={
        <>
          {decor.watermark.enabled && (
            <button className="btn danger" onClick={remove}>
              {t("stamp.remove")}
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" onClick={apply} disabled={v.kind === "image" ? !v.imageId : !v.text.trim()}>
            {t("stamp.apply")}
          </button>
        </>
      }
    >
      <WithPreview preview={preview} decor={{ ...decor, watermark: v }} pageCount={pageCount}>
      <div className="seg">
        <button className={v.kind === "text" ? "on" : ""} aria-pressed={v.kind === "text"} onClick={() => setV({ ...v, kind: "text" })}>
          {t("wm.text")}
        </button>
        <button className={v.kind === "image" ? "on" : ""} aria-pressed={v.kind === "image"} onClick={() => setV({ ...v, kind: "image" })}>
          {t("wm.image")}
        </button>
      </div>
      {v.kind === "text" ? (
        <>
          <label className="field">
            <span>{t("wm.textLabel")}</span>
            <input value={v.text} onChange={(e) => setV({ ...v, text: e.target.value })} />
          </label>
          <StyleFields style={v.style} onChange={(s) => setV({ ...v, style: s })} sizeMax={300} />
        </>
      ) : (
        <>
          <label className="field">
            <span>{t("wm.imageLabel")}</span>
            <input type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && pickImage(e.target.files[0])} />
          </label>
          {img && <img className="wm-preview" src={img.url} alt="" />}
          {err && <p className="err">{err}</p>}
          <div className="field-row">
            <label className="field">
              <span>{t("wm.scale", { n: Math.round(v.scale * 100) })}</span>
              <input type="range" min={0.1} max={1} step={0.05} value={v.scale} onChange={(e) => setV({ ...v, scale: parseFloat(e.target.value) })} />
            </label>
            <label className="field">
              <span>{t("prop.opacity", { n: Math.round(v.style.opacity * 100) })}</span>
              <input type="range" min={0.05} max={1} step={0.05} value={v.style.opacity} onChange={(e) => setV({ ...v, style: { ...v.style, opacity: parseFloat(e.target.value) } })} />
            </label>
          </div>
        </>
      )}
      <div className="field-row">
        <NumberField label={t("wm.rotation")} value={v.rotation} min={-180} max={180} suffix="°" onChange={(n) => setV({ ...v, rotation: n })} />
        <PagesField value={v.pages} onChange={(p) => setV({ ...v, pages: p })} total={pageCount} />
      </div>
      <AnchorPicker value={v.anchor} onChange={(a) => setV({ ...v, anchor: a })} />
      <p className="note">
        <Icon name="info" size={14} /> {t("wm.help")}
      </p>
      </WithPreview>
    </Dialog>
  );
}

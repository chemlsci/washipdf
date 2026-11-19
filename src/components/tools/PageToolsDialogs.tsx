/** トリミング・サイズ変更・交互結合 のダイアログ */
import { useMemo, useState } from "react";
import { useT } from "@/lib/i18n";
import { interleave, interleaveHalves, PAPER_SIZES, resizeTarget } from "@/lib/pageOps";
import { pageSet } from "@/lib/pageRanges";
import type { PageItem, SourceDoc } from "@/lib/types";
import { Dialog, NumberField } from "../Dialog";
import { PreviewPane } from "./PreviewPane";

const MM = 72 / 25.4;

interface PagesProps {
  pages: PageItem[];
  selected: Set<string>;
  onApply: (next: PageItem[]) => void;
  onClose: () => void;
}

function TargetField({ mode, setMode, range, setRange, hasSelection, total }: { mode: "all" | "selected" | "range"; setMode: (m: "all" | "selected" | "range") => void; range: string; setRange: (s: string) => void; hasSelection: boolean; total: number }) {
  const t = useT();
  return (
    <div className="field">
      <span>{t("target.label")}</span>
      <div className="seg">
        <button className={mode === "all" ? "on" : ""} aria-pressed={mode === "all"} onClick={() => setMode("all")}>
          {t("target.all")}
        </button>
        <button className={mode === "selected" ? "on" : ""} aria-pressed={mode === "selected"} onClick={() => setMode("selected")} disabled={!hasSelection}>
          {t("target.selected")}
        </button>
        <button className={mode === "range" ? "on" : ""} aria-pressed={mode === "range"} onClick={() => setMode("range")}>
          {t("target.range")}
        </button>
      </div>
      {mode === "range" && <input dir="ltr" value={range} placeholder={`1-${total}`} onChange={(e) => setRange(e.target.value)} />}
    </div>
  );
}

function useTarget(pages: PageItem[], selected: Set<string>) {
  const [mode, setMode] = useState<"all" | "selected" | "range">(selected.size ? "selected" : "all");
  const [range, setRange] = useState("");
  const ids = useMemo(() => {
    if (mode === "selected") return new Set(pages.filter((p) => selected.has(p.id)).map((p) => p.id));
    if (mode === "range") {
      const set = pageSet(range, pages.length);
      return new Set(pages.filter((_, i) => set.has(i)).map((p) => p.id));
    }
    return new Set(pages.map((p) => p.id));
  }, [mode, range, pages, selected]);
  return { mode, setMode, range, setRange, ids };
}

export function CropDialog({ pages, selected, onApply, onClose, previewPage }: PagesProps & { previewPage?: (p: PageItem) => Promise<Uint8Array> }) {
  const t = useT();
  const target = useTarget(pages, selected);
  const [m, setM] = useState({ top: 10, right: 10, bottom: 10, left: 10 });
  const [clear, setClear] = useState(false);
  const cropOne = (p: PageItem): PageItem => {
    if (clear) {
      const { crop: _c, ...rest } = p;
      return rest;
    }
    const base = p.crop ?? { x: 0, y: 0, w: p.width, h: p.height };
    // 入力の上・下・左・右は、いま見えている向きでの辺。ページを回してあるときは、元の向きのどの辺に当たるかに直す
    // （直さないと、「上」に入れた幅が、見た目では横の辺から切られる）
    const side = { 0: m, 90: { left: m.top, top: m.right, right: m.bottom, bottom: m.left }, 180: { top: m.bottom, bottom: m.top, left: m.right, right: m.left }, 270: { left: m.bottom, bottom: m.right, right: m.top, top: m.left } }[((p.extraRotation % 360) + 360) % 360] ?? m;
    const x = base.x + side.left * MM;
    const y = base.y + side.top * MM;
    const w = Math.max(10, base.w - (side.left + side.right) * MM);
    const h = Math.max(10, base.h - (side.top + side.bottom) * MM);
    return { ...p, crop: { x, y, w, h } };
  };
  /** 残る範囲（いまの表示範囲に対する割合。ページに足した回転を反映） */
  const keptArea = (p: PageItem) => {
    const base = p.crop ?? { x: 0, y: 0, w: p.width, h: p.height };
    const c = cropOne(p).crop!;
    const x = (c.x - base.x) / base.w;
    const y = (c.y - base.y) / base.h;
    const w = c.w / base.w;
    const h = c.h / base.h;
    switch (((p.extraRotation % 360) + 360) % 360) {
      case 90:
        return { x: 1 - y - h, y: x, w: h, h: w };
      case 180:
        return { x: 1 - x - w, y: 1 - y - h, w, h };
      case 270:
        return { x: y, y: 1 - x - w, w: h, h: w };
      default:
        return { x, y, w, h };
    }
  };
  const apply = () => {
    onApply(pages.map((p) => (target.ids.has(p.id) ? cropOne(p) : p)));
    onClose();
  };
  const targetPages = pages.filter((p) => target.ids.has(p.id));
  return (
    <Dialog
      title={t("tool.crop")}
      onClose={onClose}
      wide={!!previewPage}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" onClick={apply} disabled={!target.ids.size}>
            {t("stamp.apply")}
          </button>
        </>
      }
    >
      <div className={previewPage ? "with-preview" : ""}>
      <div className={previewPage ? "with-preview-form" : ""}>
      <p className="note">{t("crop.help")}</p>
      <TargetField {...target} hasSelection={selected.size > 0} total={pages.length} />
      <div className="field-row">
        <NumberField label={t("crop.top")} value={m.top} min={0} suffix="mm" onChange={(v) => setM({ ...m, top: v })} />
        <NumberField label={t("crop.bottom")} value={m.bottom} min={0} suffix="mm" onChange={(v) => setM({ ...m, bottom: v })} />
      </div>
      <div className="field-row">
        <NumberField label={t("crop.left")} value={m.left} min={0} suffix="mm" onChange={(v) => setM({ ...m, left: v })} />
        <NumberField label={t("crop.right")} value={m.right} min={0} suffix="mm" onChange={(v) => setM({ ...m, right: v })} />
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={clear} onChange={(e) => setClear(e.target.checked)} /> {t("crop.clear")}
      </label>
      </div>
      {previewPage && targetPages.length > 0 && (
        <PreviewPane
          // 切り詰める前のページを見せ、残る範囲を枠で、切り詰める部分を暗くして示す（解除するときは、解除したあとのページ）
          build={(i) => previewPage(clear ? cropOne(targetPages[i]) : targetPages[i])}
          overlay={(i) => (clear ? null : keptArea(targetPages[i]))}
          pageCount={targetPages.length}
          deps={[JSON.stringify(m), clear, targetPages.map((p) => p.id).join(",")]}
        />
      )}
      </div>
    </Dialog>
  );
}

export function ResizeDialog({ pages, selected, onApply, onClose }: PagesProps) {
  const t = useT();
  const target = useTarget(pages, selected);
  const [mode, setMode] = useState<"paper" | "percent" | "reset">("paper");
  const [paper, setPaper] = useState("A4");
  const [percent, setPercent] = useState(100);
  const apply = () => {
    const ps = PAPER_SIZES.find((p) => p.id === paper)!;
    onApply(
      pages.map((p) => {
        if (!target.ids.has(p.id)) return p;
        if (mode === "reset") {
          const { scaleTo: _s, ...rest } = p;
          return rest;
        }
        return { ...p, scaleTo: resizeTarget(p, mode === "percent" ? { percent } : { paper: ps }) };
      }),
    );
    onClose();
  };
  return (
    <Dialog
      title={t("tool.resize")}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" onClick={apply} disabled={!target.ids.size}>
            {t("stamp.apply")}
          </button>
        </>
      }
    >
      <p className="note">{t("resize.help")}</p>
      <TargetField {...target} hasSelection={selected.size > 0} total={pages.length} />
      <div className="seg">
        <button className={mode === "paper" ? "on" : ""} aria-pressed={mode === "paper"} onClick={() => setMode("paper")}>
          {t("resize.paper")}
        </button>
        <button className={mode === "percent" ? "on" : ""} aria-pressed={mode === "percent"} onClick={() => setMode("percent")}>
          {t("resize.percent")}
        </button>
        <button className={mode === "reset" ? "on" : ""} aria-pressed={mode === "reset"} onClick={() => setMode("reset")}>
          {t("resize.reset")}
        </button>
      </div>
      {mode === "paper" && (
        <label className="field">
          <span>{t("resize.paperSize")}</span>
          <select value={paper} onChange={(e) => setPaper(e.target.value)}>
            {PAPER_SIZES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id}（{Math.round(p.w / MM)} × {Math.round(p.h / MM)} mm）
              </option>
            ))}
          </select>
        </label>
      )}
      {mode === "percent" && <NumberField label={t("resize.percentLabel")} value={percent} min={10} max={400} suffix="%" onChange={setPercent} />}
    </Dialog>
  );
}

export function InterleaveDialog({ pages, sources, onApply, onClose }: { pages: PageItem[]; sources: Map<string, SourceDoc>; onApply: (next: PageItem[]) => void; onClose: () => void }) {
  const t = useT();
  const srcIds = [...new Set(pages.map((p) => p.srcId).filter((x): x is string => !!x))];
  const [mode, setMode] = useState<"two" | "halves">(srcIds.length >= 2 ? "two" : "halves");
  const [a, setA] = useState(srcIds[0] ?? "");
  const [b, setB] = useState(srcIds[1] ?? "");
  const [rev, setRev] = useState(true);
  const apply = () => {
    onApply(mode === "two" ? interleave(pages, a, b, rev) : interleaveHalves(pages, rev));
    onClose();
  };
  const name = (id: string) => sources.get(id)?.name ?? id;
  return (
    <Dialog
      title={t("tool.interleave")}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" onClick={apply} disabled={mode === "two" && (!a || !b || a === b)}>
            {t("stamp.apply")}
          </button>
        </>
      }
    >
      <p className="note">{t("interleave.help")}</p>
      <div className="seg">
        <button className={mode === "two" ? "on" : ""} aria-pressed={mode === "two"} onClick={() => setMode("two")} disabled={srcIds.length < 2}>
          {t("interleave.two")}
        </button>
        <button className={mode === "halves" ? "on" : ""} aria-pressed={mode === "halves"} onClick={() => setMode("halves")}>
          {t("interleave.halves")}
        </button>
      </div>
      {mode === "two" && (
        <div className="field-row">
          <label className="field">
            <span>{t("interleave.front")}</span>
            <select value={a} onChange={(e) => setA(e.target.value)}>
              {srcIds.map((id) => (
                <option key={id} value={id}>
                  {name(id)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t("interleave.back")}</span>
            <select value={b} onChange={(e) => setB(e.target.value)}>
              {srcIds.map((id) => (
                <option key={id} value={id}>
                  {name(id)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <label className="checkbox">
        <input type="checkbox" checked={rev} onChange={(e) => setRev(e.target.checked)} /> {t("interleave.reverseBack")}
      </label>
    </Dialog>
  );
}

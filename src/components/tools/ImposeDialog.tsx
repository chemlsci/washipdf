/** 面付け（N-up・小冊子）の設定。「作成」で組み立て → 面付け → ダウンロード */
import { useState } from "react";
import { useT } from "@/lib/i18n";
import { defaultImpose, gridFor, type ImposeOptions, type PerSheet } from "@/lib/impose";
import { clamp } from "@/lib/limits";
import { PAPER_SIZES } from "@/lib/pageOps";
import { Dialog, NumInput } from "../Dialog";

const MM = 72 / 25.4;

export function ImposeDialog({ pageCount, onRun, onClose }: { pageCount: number; onRun: (o: ImposeOptions) => void; onClose: () => void }) {
  const t = useT();
  const [v, setV] = useState<ImposeOptions>(defaultImpose());
  const per: PerSheet = v.booklet ? 2 : v.perSheet;
  const { cols, rows } = gridFor(per);
  const sheets = v.booklet ? Math.ceil(pageCount / 4) * 2 : Math.ceil(pageCount / per);
  return (
    <Dialog
      title={t("tool.nup")}
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
              onRun(v);
              onClose();
            }}
          >
            {t("nup.create")}
          </button>
        </>
      }
    >
      <label className="checkbox">
        <input type="checkbox" checked={v.booklet} onChange={(e) => setV({ ...v, booklet: e.target.checked })} /> {t("nup.booklet")}
      </label>
      <p className="note">{t("nup.bookletHelp")}</p>
      <div className="field-row">
        <label className="field">
          <span>{t("nup.perSheet")}</span>
          <select value={per} disabled={v.booklet} onChange={(e) => setV({ ...v, perSheet: parseInt(e.target.value, 10) as PerSheet })}>
            {[2, 4, 6, 8, 9, 16].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("nup.paper")}</span>
          <select value={v.paper} onChange={(e) => setV({ ...v, paper: e.target.value })}>
            <option value="same">{t("nup.paperSame")}</option>
            {PAPER_SIZES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("nup.orientation")}</span>
          <select value={v.orientation} onChange={(e) => setV({ ...v, orientation: e.target.value as ImposeOptions["orientation"] })}>
            <option value="auto">{t("nup.auto")}</option>
            <option value="portrait">{t("nup.portrait")}</option>
            <option value="landscape">{t("nup.landscape")}</option>
          </select>
        </label>
      </div>
      <div className="field-row">
        <label className="field">
          <span>{t("nup.margin")}</span>
          <NumInput min={0} max={50} step={1} value={Math.round(v.margin / MM)} onValue={(raw) => setV({ ...v, margin: clamp(raw, 0, 50, 0) * MM })} />
        </label>
        <label className="field">
          <span>{t("nup.gap")}</span>
          <NumInput min={0} max={50} step={1} value={Math.round(v.gap / MM)} onValue={(raw) => setV({ ...v, gap: clamp(raw, 0, 50, 0) * MM })} />
        </label>
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={v.rightToLeft} onChange={(e) => setV({ ...v, rightToLeft: e.target.checked })} /> {t("nup.rtl")}
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={v.border} onChange={(e) => setV({ ...v, border: e.target.checked })} /> {t("nup.border")}
      </label>
      <div className="nup-preview" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {Array.from({ length: cols * rows }, (_, i) => (
          <span key={i}>{v.rightToLeft ? cols - (i % cols) + Math.floor(i / cols) * cols : i + 1}</span>
        ))}
      </div>
      <p className="note">{t("nup.summary", { pages: pageCount, sheets })}</p>
      <p className="note">{t("nup.flattenNote")}</p>
    </Dialog>
  );
}

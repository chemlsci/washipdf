// まとめて処理：PDF を選び、処理を選んで実行すると、処理した PDF を ZIP にまとめて保存する。ファイルごとの結果も出す
import { useState } from "react";
import { type BatchOptions, type BatchResult, runBatch } from "@/lib/batch";
import type { BuildOptions } from "@/lib/exportPdf";
import { PII_PATTERNS, type PiiKind } from "@/lib/findText";
import { useT } from "@/lib/i18n";
import { createZip, downloadBlob } from "@/lib/zip";
import { Dialog } from "../Dialog";
import { displayName } from "@/lib/fileName";

export function BatchDialog({ embedFont, onClose }: { embedFont?: BuildOptions["embedFont"]; onClose: () => void }) {
  const t = useT();
  const [files, setFiles] = useState<File[]>([]);
  const [o, setO] = useState<BatchOptions>({ compress: false, numbering: false, watermark: "", pii: [], sanitize: false, password: "" });
  const [useWatermark, setUseWatermark] = useState(false);
  const [usePassword, setUsePassword] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [results, setResults] = useState<BatchResult[] | null>(null);
  const [zipError, setZipError] = useState<string | null>(null);
  const chosen = o.compress || o.numbering || (useWatermark && !!o.watermark.trim()) || o.pii.length > 0 || o.sanitize || (usePassword && !!o.password);
  const running = progress !== null;
  const okCount = results?.filter((r) => r.ok).length ?? 0;

  const run = async () => {
    setResults(null);
    setZipError(null);
    const opts: BatchOptions = { ...o, watermark: useWatermark ? o.watermark : "", password: usePassword ? o.password : "" };
    const res = await runBatch(files, opts, embedFont, (done, total, name) => setProgress(name ? t("batch.progress", { done: done + 1, total, name }) : ""));
    setProgress(null);
    setResults(res);
    // 処理できたものを ZIP にまとめて保存する（同じ名前は番号を足す）
    const used = new Set<string>();
    const out = res.filter((r) => r.ok && r.bytes).map((r) => {
      let name = r.name.replace(/\.pdf$/i, "") + ".pdf";
      for (let k = 2; used.has(name); k++) name = `${r.name.replace(/\.pdf$/i, "")}_${k}.pdf`;
      used.add(name);
      return { name, data: r.bytes! };
    });
    // ZIP の上限（個数・大きさ）を超えると作れない。結果の一覧は出したまま、理由を知らせる
    try {
      if (out.length) downloadBlob(createZip(out), "washi-batch.zip");
    } catch (e) {
      setZipError(e instanceof Error ? e.message : String(e));
    }
  };

  const toggle = (k: PiiKind) => setO({ ...o, pii: o.pii.includes(k) ? o.pii.filter((x) => x !== k) : [...o.pii, k] });
  return (
    <Dialog
      title={t("batch.title")}
      onClose={() => !running && onClose()}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" disabled={running} onClick={onClose}>
            {t("common.close")}
          </button>
          <button className="btn primary" disabled={running || !files.length || !chosen} onClick={() => void run()}>
            {t("batch.run", { n: files.length })}
          </button>
        </>
      }
    >
      <p className="note">{t("batch.lead")}</p>
      <label className="btn file-btn">
        {t("batch.choose")}
        <input
          type="file"
          accept="application/pdf,.pdf"
          multiple
          hidden
          disabled={running}
          onChange={(e) => {
            setFiles([...(e.target.files ?? [])]);
            setResults(null);
          }}
        />
      </label>
      {files.length > 0 && <p className="note">{t("batch.chosen", { n: files.length, names: files.slice(0, 3).map((f) => f.name).join(t("common.sep")) + (files.length > 3 ? "…" : "") })}</p>}

      <fieldset className="group" disabled={running}>
        <label className="checkbox">
          <input type="checkbox" checked={o.compress} onChange={(e) => setO({ ...o, compress: e.target.checked })} /> {t("batch.compress")}
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={o.numbering} onChange={(e) => setO({ ...o, numbering: e.target.checked })} /> {t("batch.numbering")}
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={useWatermark} onChange={(e) => setUseWatermark(e.target.checked)} /> {t("batch.watermark")}
        </label>
        {useWatermark && <input value={o.watermark} placeholder={t("batch.watermarkPlaceholder")} onChange={(e) => setO({ ...o, watermark: e.target.value })} />}
        <div className="field">
          <span>{t("batch.pii")}</span>
          <div className="chips">
            {(Object.keys(PII_PATTERNS) as PiiKind[]).map((k) => (
              <button key={k} type="button" className={`chip ${o.pii.includes(k) ? "on" : ""}`} aria-pressed={o.pii.includes(k)} onClick={() => toggle(k)}>
                {t(`find.pii.${k}`)}
              </button>
            ))}
          </div>
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={o.sanitize} onChange={(e) => setO({ ...o, sanitize: e.target.checked })} /> {t("batch.sanitize")}
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={usePassword} onChange={(e) => setUsePassword(e.target.checked)} /> {t("batch.password")}
        </label>
        {usePassword && <input type="password" autoComplete="new-password" value={o.password} placeholder={t("batch.passwordPlaceholder")} onChange={(e) => setO({ ...o, password: e.target.value })} />}
      </fieldset>

      {running && (
        <div className="ocr-progress" role="status">
          <progress />
          <span>{progress}</span>
        </div>
      )}
      {results && (
        <>
          {/* ZIP を実際に保存できたときだけ「保存しました」と言う */}
          <p className="note status">{t(!zipError && okCount > 0 ? "batch.done" : "batch.processed", { ok: okCount, total: results.length })}</p>
          {zipError && <p className="note error">{zipError}</p>}
          <ul className="wareki-list batch-results">
            {results.map((r, i) => (
              <li key={i} className={r.ok && !r.unverified?.length && !r.warnings?.length ? "" : "warn"}>
                <label>
                  <span className="annot-text">{displayName(r.name)}</span>
                  <span className="wareki-flag plain">{r.ok ? (o.pii.length ? t("batch.redacted", { n: r.redactions }) : t("batch.ok")) : r.error}</span>
                </label>
                {/* 墨消しを確かめられなかったページと、保存のときの知らせ（先頭の 3 件） */}
                {r.ok && !!r.unverified?.length && <p className="note error">{t("redact.unverified", { pages: r.unverified.join(t("common.sep")) })}</p>}
                {r.ok && r.warnings?.slice(0, 3).map((w, k) => (
                  <p key={k} className="note">
                    {w}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="note">{t("batch.note")}</p>
    </Dialog>
  );
}

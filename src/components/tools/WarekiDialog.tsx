/**
 * 和暦 ⇄ 西暦の一括変換。全ページの既存文字から日付を見つけて一覧に出し、
 * 選んだものだけを実編集（元の文字を書き換え）として適用する。
 */
import { useCallback, useEffect, useState } from "react";
import { createTextEdit } from "@/lib/editModel";
import { useT } from "@/lib/i18n";
import { getPageText, type TextRun } from "@/lib/textRuns";
import type { PageItem, SourceDoc, TextEditObj } from "@/lib/types";
import { applyMatches, type DateMatch, findDates, type WarekiDirection } from "@/lib/wareki";
import { Dialog } from "../Dialog";
import { Icon } from "../Icon";

interface Hit {
  pageId: string;
  pageNo: number;
  run: TextRun;
  matches: DateMatch[];
}

/** 既存のテキスト編集が、この run を既に書き換えているか（二重編集を避ける） */
function alreadyEdited(page: PageItem, run: TextRun): boolean {
  const idx = new Set(run.removals.map((r) => `${(r.path ?? []).join("/")}:${r.index}`));
  return page.objects.some((o) => o.type === "textedit" && o.removals.some((r) => idx.has(`${(r.path ?? []).join("/")}:${r.index}`)));
}

export function WarekiDialog({
  pages,
  sources,
  onApply,
  onClose,
}: {
  pages: PageItem[];
  sources: Map<string, SourceDoc>;
  onApply: (edits: { pageId: string; obj: TextEditObj }[]) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [dir, setDir] = useState<WarekiDirection>("toWestern");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState("");

  const key = (h: Hit, m: DateMatch) => `${h.pageId}:${h.run.id}:${m.start}`;

  const scan = useCallback(async () => {
    setHits(null);
    const found: Hit[] = [];
    const sel = new Set<string>();
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      setProgress(t("wareki.scanning", { done: i + 1, total: pages.length }));
      const src = page.srcId ? sources.get(page.srcId) : undefined;
      if (!src) continue;
      try {
        const { runs } = await getPageText(src, page);
        for (const run of runs) {
          if (!run.editable || alreadyEdited(page, run)) continue;
          const matches = findDates(run.text, dir);
          if (matches.length) {
            const hit: Hit = { pageId: page.id, pageNo: i + 1, run, matches };
            found.push(hit);
            for (const m of matches) sel.add(key(hit, m));
          }
        }
      } catch {
        /* 読めないページは飛ばす */
      }
    }
    setHits(found);
    setChecked(sel);
    setProgress("");
  }, [pages, sources, dir, t]);

  useEffect(() => {
    void scan();
  }, [scan]);

  const total = hits?.reduce((n, h) => n + h.matches.length, 0) ?? 0;
  const selectedCount = checked.size;

  const toggle = (h: Hit, m: DateMatch) => {
    const k = key(h, m);
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };
  const setAll = (on: boolean) => {
    if (!hits) return;
    const next = new Set<string>();
    if (on) for (const h of hits) for (const m of h.matches) next.add(key(h, m));
    setChecked(next);
  };

  const apply = () => {
    if (!hits) return;
    const edits: { pageId: string; obj: TextEditObj }[] = [];
    for (const h of hits) {
      const sel = h.matches.filter((m) => checked.has(key(h, m)));
      if (!sel.length) continue;
      const obj = createTextEdit([h.run], { cover: "#ffffff", fallbackColor: h.run.color ?? "#000000" });
      obj.text = applyMatches(h.run.text, sel);
      edits.push({ pageId: h.pageId, obj });
    }
    onApply(edits);
    onClose();
  };

  return (
    <Dialog
      title={t("tool.wareki")}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="muted">{hits ? t("wareki.selected", { n: selectedCount, total }) : progress}</span>
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" disabled={!selectedCount} onClick={apply}>
            {t("wareki.apply", { n: selectedCount })}
          </button>
        </>
      }
    >
      <div className="field">
        <span>{t("wareki.direction")}</span>
        <div className="seg">
          <button className={dir === "toWestern" ? "on" : ""} aria-pressed={dir === "toWestern"} onClick={() => setDir("toWestern")}>
            {t("wareki.toWestern")}
          </button>
          <button className={dir === "toWareki" ? "on" : ""} aria-pressed={dir === "toWareki"} onClick={() => setDir("toWareki")}>
            {t("wareki.toWareki")}
          </button>
        </div>
      </div>

      {!hits ? (
        <p className="note">{progress || t("wareki.scanning", { done: 0, total: pages.length })}</p>
      ) : total === 0 ? (
        <p className="note">{t("wareki.none")}</p>
      ) : (
        <>
          <div className="wareki-head">
            <button className="btn small ghost" onClick={() => setAll(true)}>
              {t("wareki.selectAll")}
            </button>
            <button className="btn small ghost" onClick={() => setAll(false)}>
              {t("wareki.clear")}
            </button>
          </div>
          <ul className="wareki-list">
            {hits.map((h) =>
              h.matches.map((m) => {
                const k = key(h, m);
                return (
                  <li key={k} className={m.warning ? "warn" : ""}>
                    <label>
                      <input type="checkbox" checked={checked.has(k)} onChange={() => toggle(h, m)} />
                      <span className="wareki-page">{t("wareki.pageNo", { n: h.pageNo })}</span>
                      <span className="wareki-from">{m.original}</span>
                      <Icon name="chevron" size={14} />
                      <span className="wareki-to">{m.converted}</span>
                      {m.warning && <span className="wareki-flag" title={t("wareki.ambiguousTip")}>{t("wareki.ambiguous")}</span>}
                    </label>
                  </li>
                );
              }),
            )}
          </ul>
          <p className="note">{t("wareki.note")}</p>
        </>
      )}
    </Dialog>
  );
}

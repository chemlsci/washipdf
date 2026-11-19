/**
 * 検索と置換・墨消し。全ページの文字から探して一覧に出し、選んだものだけを
 * 実編集（置換）または墨消しとして適用する。適用後も「元に戻す」で取り消せる。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createTextEdit } from "@/lib/editModel";
import { type Box, findMatches, findMatchesInRun, findSpanning, lineBoxes, type Match, matchBoxes, PII_PATTERNS, type PiiKind, type Query, runBox, SHAPED_SCRIPT } from "@/lib/findText";
import { uid } from "@/lib/geometry";
import { useT } from "@/lib/i18n";
import { renderToCanvas } from "@/lib/render";
import { getPageText, sampleColors, type TextRun } from "@/lib/textRuns";
import type { EditObj, PageItem, RedactObj, SourceDoc } from "@/lib/types";
import { Dialog } from "../Dialog";

export interface FindResult {
  mode: "replace" | "redact";
  /** 件数（一覧で選んだ数） */
  count: number;
  /** ページに追加する編集（実編集・墨消し） */
  add: { pageId: string; obj: EditObj }[];
  /** 既に追加してある文字の書き換え */
  patch: { pageId: string; objId: string; text: string }[];
}

interface Hit {
  key: string;
  pageId: string;
  pageNo: number;
  /** 元 PDF の行。null なら、このアプリで追加・編集した文字（objId） */
  run: TextRun | null;
  objId: string | null;
  text: string;
  match: Match;
  /** 墨消しの範囲。行全体を対象にするときは wholeLine（そのときの範囲は lines） */
  box: Box | null;
  /** 行全体を墨消しするときの範囲（行を描いている命令ごと） */
  lines?: Box[];
  wholeLine: boolean;
  /** 置換できない理由（実編集できない行） */
  reason: string | null;
  /** 行をまたぐ一致の、次の行の側（text は次の行の文字列） */
  second?: { run: TextRun; text: string; match: Match; box: Box | null };
}

/** 折り返した次の行：すぐ下にあり、横の範囲が重なり、文字の大きさがほぼ同じ行のうち、いちばん近いもの */
function nextLineOf(run: TextRun, runs: TextRun[]): TextRun | null {
  if (run.vertical) return null;
  let best: TextRun | null = null;
  for (const r of runs) {
    if (r === run || r.vertical) continue;
    const dy = r.baseline - run.baseline;
    if (dy < run.fontSize * 0.6 || dy > run.fontSize * 2.4) continue;
    if (Math.abs(r.fontSize - run.fontSize) > run.fontSize * 0.2) continue;
    if (Math.min(r.x + r.w, run.x + run.w) - Math.max(r.x, run.x) <= 0) continue;
    if (!best || r.baseline < best.baseline) best = r;
  }
  return best;
}

/** 一致ごとに置き換える文字を指定して、書き換え後の文字列を作る */
function replaceEach(text: string, parts: { match: Match; rep: string }[]): string {
  let out = "";
  let at = 0;
  for (const p of [...parts].sort((a, b) => a.match.start - b.match.start)) {
    if (p.match.start < at) continue;
    out += text.slice(at, p.match.start) + p.rep;
    at = p.match.end;
  }
  return out + text.slice(at);
}

/** 既存のテキスト編集が、この行を既に書き換えているか（その場合は編集後の文字のほうを探す） */
function alreadyEdited(page: PageItem, run: TextRun): boolean {
  const idx = new Set(run.removals.map((r) => `${(r.path ?? []).join("/")}:${r.index}`));
  return page.objects.some((o) => o.type === "textedit" && o.removals.some((r) => idx.has(`${(r.path ?? []).join("/")}:${r.index}`)));
}

const CONTEXT = 14;

export function FindDialog({ pages, sources, onApply, onClose }: { pages: PageItem[]; sources: Map<string, SourceDoc>; onApply: (r: FindResult) => void; onClose: () => void }) {
  const t = useT();
  const [query, setQuery] = useState("");
  // 個人情報のひな形（墨消しのとき）。選ぶと、入力した語の代わりに、その形の文字列を探す
  const [pii, setPii] = useState<PiiKind | null>(null);
  const [replacement, setReplacement] = useState("");
  const [mode, setMode] = useState<"replace" | "redact">("replace");
  const q: Query = pii && mode === "redact" ? PII_PATTERNS[pii] : query;
  const [exact, setExact] = useState(false);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [progress, setProgress] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const scanId = useRef(0);

  // 入力が落ち着いてから全ページを探す（途中で入力が変わったら古い検索は捨てる）
  useEffect(() => {
    const id = ++scanId.current;
    if (!q) {
      setHits(null);
      setProgress("");
      return;
    }
    const tm = setTimeout(async () => {
      const found: Hit[] = [];
      for (let i = 0; i < pages.length; i++) {
        if (scanId.current !== id) return;
        const page = pages[i];
        setProgress(t("find.scanning", { done: i + 1, total: pages.length }));
        // このアプリで追加・編集した文字
        for (const o of page.objects) {
          if (o.type !== "text" && o.type !== "textedit") continue;
          for (const m of findMatches(o.text, q, exact)) found.push({ key: `${page.id}:${o.id}:${m.start}`, pageId: page.id, pageNo: i + 1, run: null, objId: o.id, text: o.text, match: m, box: null, wholeLine: false, reason: null });
        }
        const src = page.srcId ? sources.get(page.srcId) : undefined;
        if (!src) continue;
        try {
          const { runs } = await getPageText(src, page);
          const usable = runs.filter((r) => !alreadyEdited(page, r));
          const inLine = new Map<string, Match[]>();
          for (const run of usable) {
            const ms = findMatchesInRun(run.text, q, exact);
            inLine.set(run.id, ms);
            if (!ms.length) continue;
            const boxes = await matchBoxes(src, page, run, ms);
            const lines = boxes?.every((b) => b) ? undefined : await lineBoxes(src, page, run);
            ms.forEach((m, k) => {
              const box = boxes?.[k] ?? null;
              found.push({ key: `${page.id}:${run.id}:${m.start}`, pageId: page.id, pageNo: i + 1, run, objId: null, text: run.text, match: m, box: box ?? runBox(run), lines, wholeLine: !box, reason: run.editable ? null : (run.reason ?? t("find.cannotEdit")) });
            });
          }
          // 行の終わりから次の行の頭へまたがる一致
          for (const run of usable) {
            const next = nextLineOf(run, usable);
            if (!next) continue;
            for (const sp of findSpanning(run.text, next.text, q, exact)) {
              // 1 行の中の一致と重なるものは採らない（同じ文字を二重に扱わない）
              if (inLine.get(run.id)?.some((m) => m.end > sp.a.start) || inLine.get(next.id)?.some((m) => m.start < sp.b.end)) continue;
              const ba = (await matchBoxes(src, page, run, [sp.a]))?.[0] ?? null;
              const bb = (await matchBoxes(src, page, next, [sp.b]))?.[0] ?? null;
              const reason = run.editable && next.editable ? null : (run.reason ?? next.reason ?? t("find.cannotEdit"));
              const whole = !ba || !bb;
              const lines = whole ? [...(await lineBoxes(src, page, run)), ...(await lineBoxes(src, page, next))] : undefined;
              found.push({ key: `${page.id}:${run.id}:${sp.a.start}+`, pageId: page.id, pageNo: i + 1, run, objId: null, text: run.text, match: sp.a, box: ba ?? runBox(run), lines, wholeLine: whole, reason, second: { run: next, text: next.text, match: sp.b, box: bb ?? runBox(next) } });
            }
          }
          found.sort((x, y) => x.pageNo - y.pageNo || (x.run && y.run ? x.run.baseline - y.run.baseline || x.match.start - y.match.start : 0));
        } catch {
          /* 読めないページは飛ばす */
        }
      }
      if (scanId.current !== id) return;
      setHits(found);
      setProgress("");
    }, 250);
    return () => clearTimeout(tm);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, pii, mode === "redact", exact, pages, sources, t]);

  /** いまのモードで一覧に出すもの：墨消しは元 PDF の行だけ（行全体が対象のものは 1 行につき 1 件） */
  const shown = useMemo(() => {
    if (!hits) return [];
    if (mode === "replace") return hits;
    const seen = new Set<string>();
    return hits.filter((h) => {
      if (!h.run) return false;
      if (!h.wholeLine) return true;
      const k = `${h.pageId}:${h.run.id}:${h.second?.run.id ?? ""}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [hits, mode]);
  /** 語の位置を字形から決められない文字の行（クメール・ラオス・ミャンマー・チベット文字）：語を探しての墨消しはできない（範囲指定を案内する） */
  const blocked = (h: Hit) => mode === "redact" && !!h.run && SHAPED_SCRIPT.test(h.run.text);
  const selectable = (h: Hit) => (mode === "replace" ? !h.reason : !blocked(h));

  // 既定の選択：置換は書き換えられるものすべて。墨消しは位置を特定できたものだけ（行全体になるものは自分で選ぶ）
  useEffect(() => {
    setChecked(new Set(shown.filter((h) => selectable(h) && !(mode === "redact" && h.wholeLine)).map((h) => h.key)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  const picked = shown.filter((h) => checked.has(h.key) && selectable(h));
  const toggle = (h: Hit) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(h.key)) next.delete(h.key);
      else next.add(h.key);
      return next;
    });

  const [applying, setApplying] = useState(false);
  /** 墨消しの色を、それぞれの範囲の周りの色（背景）に合わせる。ページを小さく描いて色を読む。読めなければ黒のまま */
  const matchBackgrounds = async (adds: FindResult["add"]) => {
    const byPage = new Map<string, RedactObj[]>();
    for (const a of adds) if (a.obj.type === "redact") byPage.set(a.pageId, [...(byPage.get(a.pageId) ?? []), a.obj]);
    for (const [pageId, list] of byPage) {
      const page = pages.find((p) => p.id === pageId);
      const src = page?.srcId ? sources.get(page.srcId) : undefined;
      if (!page || !src) continue;
      try {
        const canvas = document.createElement("canvas");
        await renderToCanvas(canvas, src, page.srcIndex, 0.75, page.baseRotation);
        if (canvas.width <= 1) continue;
        for (const r of list) r.fill = sampleColors(canvas, canvas.width / page.width, { x: r.x, y: r.y, w: r.w, h: r.h }).bg;
      } catch {
        /* 描けないページは黒のまま */
      }
    }
  };

  const apply = async () => {
    const res: FindResult = { mode, count: picked.length, add: [], patch: [] };
    if (mode === "redact") {
      const push = (pageId: string, b: Box) => {
        const r: RedactObj = { id: uid(), type: "redact", x: b.x, y: b.y, w: b.w, h: b.h, fill: "#000000" };
        res.add.push({ pageId, obj: r });
      };
      for (const h of picked) {
        if (h.wholeLine) {
          for (const b of h.lines ?? (h.run ? [runBox(h.run)] : [])) push(h.pageId, b);
          continue;
        }
        push(h.pageId, h.box!);
        if (h.second) push(h.pageId, h.second.box!);
      }
    } else {
      // 同じ行・同じ文字オブジェクトの一致はまとめて 1 回で書き換える。行をまたぐ一致は、上の行の部分を置換後の文字にし、次の行の部分は取り除く
      const groups = new Map<string, { h: Hit; run: TextRun | null; text: string; parts: { match: Match; rep: string }[] }>();
      const add = (h: Hit, run: TextRun | null, text: string, match: Match, rep: string) => {
        const k = `${h.pageId}:${run ? run.id : h.objId}`;
        const g = groups.get(k) ?? { h, run, text, parts: [] };
        g.parts.push({ match, rep });
        groups.set(k, g);
      };
      for (const h of picked) {
        add(h, h.run, h.text, h.match, replacement);
        if (h.second) add(h, h.second.run, h.second.text, h.second.match, "");
      }
      for (const g of groups.values()) {
        const text = replaceEach(g.text, g.parts);
        if (g.run) {
          const obj = createTextEdit([g.run], { cover: "#ffffff", fallbackColor: g.run.color ?? "#000000" });
          obj.text = text;
          res.add.push({ pageId: g.h.pageId, obj });
        } else if (g.h.objId) res.patch.push({ pageId: g.h.pageId, objId: g.h.objId, text });
      }
    }
    if (mode === "redact") {
      setApplying(true);
      await matchBackgrounds(res.add);
    }
    onApply(res);
    onClose();
  };

  return (
    <Dialog
      title={t("tool.find")}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="muted">{hits ? t("wareki.selected", { n: picked.length, total: shown.length }) : progress}</span>
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className={`btn primary ${mode === "redact" ? "danger-fill" : ""}`} disabled={!picked.length || applying} onClick={() => void apply()}>
            {t(mode === "redact" ? "find.applyRedact" : "find.applyReplace", { n: picked.length })}
          </button>
        </>
      }
    >
      <div className="seg">
        <button className={mode === "replace" ? "on" : ""} aria-pressed={mode === "replace"} onClick={() => setMode("replace")}>
          {t("find.modeReplace")}
        </button>
        <button className={mode === "redact" ? "on" : ""} aria-pressed={mode === "redact"} onClick={() => setMode("redact")}>
          {t("find.modeRedact")}
        </button>
      </div>
      <div className={mode === "replace" ? "field-row" : ""}>
        <label className="field">
          <span>{t("find.query")}</span>
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPii(null);
            }}
            autoFocus
            spellCheck={false}
          />
        </label>
        {mode === "replace" && (
          <label className="field">
            <span>{t("find.replaceWith")}</span>
            <input value={replacement} onChange={(e) => setReplacement(e.target.value)} spellCheck={false} />
          </label>
        )}
      </div>
      {mode === "redact" && (
        <div className="field">
          <span>{t("find.pii")}</span>
          <div className="chips">
            {(Object.keys(PII_PATTERNS) as PiiKind[]).map((k) => (
              <button
                key={k}
                type="button"
                className={`chip ${pii === k ? "on" : ""}`}
                aria-pressed={pii === k}
                onClick={() => {
                  setPii(pii === k ? null : k);
                  setQuery("");
                }}
              >
                {t(`find.pii.${k}`)}
              </button>
            ))}
          </div>
          {pii && <p className="note">{t("find.piiNote")}</p>}
        </div>
      )}
      {!pii && (
        <label className="checkbox">
          <input type="checkbox" checked={exact} onChange={(e) => setExact(e.target.checked)} /> {t("find.exact")}
        </label>
      )}

      {!q ? (
        <p className="note">{t("find.enter")}</p>
      ) : !hits ? (
        <p className="note">{progress || t("find.scanning", { done: 0, total: pages.length })}</p>
      ) : !shown.length ? (
        <p className="note">{t("find.none")}</p>
      ) : (
        <>
          <div className="wareki-head">
            <button className="btn small ghost" onClick={() => setChecked(new Set(shown.filter(selectable).map((h) => h.key)))}>
              {t("wareki.selectAll")}
            </button>
            <button className="btn small ghost" onClick={() => setChecked(new Set())}>
              {t("wareki.clear")}
            </button>
          </div>
          <ul className="wareki-list find-list">
            {shown.map((h) => {
              const ok = selectable(h);
              const whole = mode === "redact" && h.wholeLine;
              const before = h.text.slice(Math.max(0, h.match.start - CONTEXT), h.match.start);
              const after = h.text.slice(h.match.end, h.match.end + CONTEXT);
              return (
                <li key={h.key} className={!ok || whole ? "warn" : ""}>
                  <label title={ok ? undefined : (h.reason ?? undefined)}>
                    <input type="checkbox" checked={ok && checked.has(h.key)} disabled={!ok} onChange={() => toggle(h)} />
                    <span className="wareki-page">{t("wareki.pageNo", { n: h.pageNo })}</span>
                    <span className="find-text" dir="auto">
                      {whole ? (
                        <mark className="redact">
                          {h.text}
                          {h.second ? ` ${h.second.text}` : ""}
                        </mark>
                      ) : (
                        <>
                          {h.match.start > CONTEXT && "…"}
                          {before}
                          <mark className={mode === "redact" ? "redact" : ""}>{h.text.slice(h.match.start, h.match.end)}</mark>
                          {mode === "replace" && ok && <ins>{replacement}</ins>}
                          {h.second ? (
                            <>
                              <span className="find-break" aria-hidden>
                                ↵
                              </span>
                              <mark className={mode === "redact" ? "redact" : "gone"}>{h.second.text.slice(0, h.second.match.end)}</mark>
                              {h.second.text.slice(h.second.match.end, h.second.match.end + CONTEXT)}
                              {h.second.match.end + CONTEXT < h.second.text.length && "…"}
                            </>
                          ) : (
                            <>
                              {after}
                              {h.match.end + CONTEXT < h.text.length && "…"}
                            </>
                          )}
                        </>
                      )}
                    </span>
                    {whole && (
                      <span className="wareki-flag" title={t("find.wholeLineTip")}>
                        {t("find.wholeLine")}
                      </span>
                    )}
                    {!ok && <span className="wareki-flag">{blocked(h) ? t("find.complexScript") : t("find.cannotEdit")}</span>}
                    {!h.run && <span className="wareki-flag plain">{t("find.added")}</span>}
                  </label>
                </li>
              );
            })}
          </ul>
          <p className="note">{t(mode === "redact" ? "find.noteRedact" : "find.noteReplace")}</p>
        </>
      )}
    </Dialog>
  );
}

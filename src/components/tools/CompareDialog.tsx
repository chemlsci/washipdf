/**
 * 文書比較：いまの文書（保存したときの内容）と、選んだ PDF を比べる。
 * ページを対応づけて（追加・削除・移動を見分けて）から、組ごとに文字（違う語・文字にページの上で色）と、
 * 図・画像などの見た目（赤い枠）を比べる。拡大して見られ、注釈付き PDF・報告のページ・Markdown に書き出せる。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Hunk, Segment } from "@/lib/compare";
import { applyText, type CompareResult, type CompareSide, compareDocs, entryChanged, FULL_VISUAL_LIMIT, itemsToText, type PageEntry, QUICK_VISUAL_LIMIT, type Rect, rotRect, visualDiff } from "@/lib/compareDocs";
import { annotatedPdf, compareMarkdown, type EntryState, type Names, reportPdf, type Snapshot, STATE_KEY, stateOf } from "@/lib/compareExport";
import { displayName } from "@/lib/fileName";
import { type Key, useT } from "@/lib/i18n";
import { type AskPassword, loadPdfFile } from "@/lib/loader";
import { closePdf } from "@/lib/pdfjs";
import { fitScale, renderToCanvas } from "@/lib/render";
import type { PageItem, SourceDoc } from "@/lib/types";
import { downloadBlob } from "@/lib/zip";
import { Dialog } from "../Dialog";
import { Icon } from "../Icon";

interface Loaded {
  doc: SourceDoc;
  pages: PageItem[];
}

/** 表示する違いの件数の上限（ページあたり） */
const MAX_HUNKS = 200;
const ZOOMS = [1, 1.5, 2, 3, 4];

function sideOf(l: Loaded): CompareSide {
  return {
    pageCount: l.pages.length,
    size: (i) => ({ w: l.pages[i].width, h: l.pages[i].height }),
    text: async (i) => {
      const pg = await l.doc.pdf.getPage(i + 1);
      const vp = pg.getViewport({ scale: 1, rotation: l.pages[i].baseRotation });
      const c = await pg.getTextContent();
      return itemsToText(c.items as never, (x, y) => vp.convertToViewportPoint(x, y) as [number, number]);
    },
    render: async (i, scale, extra) => {
      const c = document.createElement("canvas");
      await renderToCanvas(c, l.doc, i, scale, (l.pages[i].baseRotation + extra) % 360);
      return c.getContext("2d")!.getImageData(0, 0, c.width, c.height);
    },
  };
}

/** 色付けと枠を描く。px は 1 pt あたりの画素、boxK は差分の枠（倍率 e.scale の画素）を描く倍率 */
function paint(ctx: CanvasRenderingContext2D, e: PageEntry, side: "a" | "b", l: Loaded, px: number, boxK: number, sel: Rect | null) {
  const page = side === "a" ? e.a : e.b;
  if (page == null) return;
  const rot = side === "b" ? e.rotate : 0;
  const sz = { w: l.pages[page].width, h: l.pages[page].height };
  const conv = (r: Rect) => rotRect(r, sz.w, sz.h, rot);
  ctx.save();
  ctx.fillStyle = side === "a" ? "rgba(220, 30, 50, 0.32)" : "rgba(30, 160, 80, 0.34)";
  for (const m of side === "a" ? e.marksA : e.marksB) {
    const r = conv(m);
    ctx.fillRect(r.x * px - 1, r.y * px - 1, r.w * px + 2, r.h * px + 2);
  }
  ctx.strokeStyle = "rgba(220, 30, 50, 0.9)";
  ctx.fillStyle = "rgba(220, 30, 50, 0.08)";
  ctx.lineWidth = Math.max(1.5, px);
  for (const bx of (side === "a" ? e.boxesA : e.boxesB) ?? []) {
    ctx.fillRect(bx.x * boxK, bx.y * boxK, bx.w * boxK, bx.h * boxK);
    ctx.strokeRect(bx.x * boxK, bx.y * boxK, bx.w * boxK, bx.h * boxK);
  }
  if (sel) {
    const r = conv(sel);
    ctx.strokeStyle = "rgba(40, 90, 220, 0.95)";
    ctx.lineWidth = Math.max(2, px * 1.5);
    ctx.strokeRect(r.x * px - 4, r.y * px - 4, r.w * px + 8, r.h * px + 8);
  }
  ctx.restore();
}

function Segs({ segs }: { segs: Segment[] }) {
  return (
    <>
      {segs.map((s, i) =>
        s.mark ? (
          <mark key={i} className="cmp-mark">
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

function HunkView({ h, t, on, onPick }: { h: Hunk; t: ReturnType<typeof useT>; on: boolean; onPick: () => void }) {
  const cls = on ? " on" : "";
  if (h.kind === "reflow")
    return (
      <li className={`reflow${cls}`} onClick={onPick} title={t("compare.jump")}>
        <span className="sign">↵</span> {t("compare.reflow")} <span className="cmp-quote">{h.a.map((s) => s.text).join("")}</span>
      </li>
    );
  return (
    <>
      {h.a.length > 0 && (
        <li className={`del${cls}`} onClick={onPick} title={t("compare.jump")}>
          <span className="sign">−</span> <Segs segs={h.a} />
        </li>
      )}
      {h.b.length > 0 && (
        <li className={`add${cls}`} onClick={onPick} title={t("compare.jump")}>
          <span className="sign">+</span> <Segs segs={h.b} />
        </li>
      )}
    </>
  );
}

export function CompareDialog({ currentName, buildCurrent, askPassword, onInsert, onClose }: { currentName?: string; buildCurrent: () => Promise<Uint8Array>; askPassword: AskPassword; onInsert: (file: File) => void; onClose: () => void }) {
  const t = useT();
  const [a, setA] = useState<Loaded | null>(null);
  const [b, setB] = useState<Loaded | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [, setTick] = useState(0);
  const [index, setIndex] = useState(0);
  const [loose, setLoose] = useState(true);
  const [vis, setVis] = useState<{ done: number; total: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [sel, setSel] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canvasA = useRef<HTMLCanvasElement>(null);
  const canvasB = useRef<HTMLCanvasElement>(null);
  const scrollA = useRef<HTMLDivElement>(null);
  const scrollB = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);
  const pendingScroll = useRef<number | null>(null);
  const alive = useRef(true);
  const moved = useRef(false);
  const docs = useRef<Loaded[]>([]);
  useEffect(
    () => () => {
      alive.current = false;
      for (const l of docs.current) void closePdf(l.doc.pdf);
    },
    [],
  );
  const refresh = () => setTick((n) => n + 1);

  const pick = useCallback(
    async (file: File) => {
      setError(null);
      setStatus(t("compare.preparing"));
      try {
        const bytes = await buildCurrent();
        const cur = await loadPdfFile(new File([bytes as BlobPart], "current.pdf", { type: "application/pdf" }));
        docs.current.push(cur);
        const other = await loadPdfFile(file, askPassword);
        docs.current.push(other);
        if (!alive.current) return;
        setA(cur);
        setB(other);
        const firstChange = (r: CompareResult) => {
          if (moved.current) return;
          const k = r.entries.findIndex(entryChanged);
          if (k >= 0) {
            moved.current = true;
            setIndex(k);
          }
        };
        let last = 0;
        const r = await compareDocs(sideOf(cur), sideOf(other), {
          loose,
          alive: () => alive.current,
          progress: (phase, done, total) => {
            const now = performance.now();
            if (now - last < 200 && done < total) return;
            last = now;
            if (phase === "visual") setVis({ done, total });
            const key: Key = phase === "text" ? "compare.comparing" : phase === "match" ? "compare.matching" : "compare.visual";
            setStatus(t(key, { done, total }));
          },
          partial: (r) => {
            setResult(r);
            firstChange(r);
            refresh();
          },
        });
        if (!r || !alive.current) return;
        setResult(r);
        firstChange(r);
        setStatus(null);
        refresh();
      } catch (e) {
        setStatus(null);
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    // 空白の扱いは、比べ始めたときの設定で始め、あとの切り替えは applyText でやり直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [buildCurrent, askPassword, t],
  );

  const entries = result?.entries ?? [];
  const e = entries[index] as PageEntry | undefined;
  const selRect = (side: "a" | "b") => (e && sel != null ? (e.hunkRects[sel]?.[side] ?? null) : null);

  // 表示中のページを描く（拡大に合わせた解像度で）
  useEffect(() => {
    if (!a || !b || !e) return;
    let cancelled = false;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const draw = async (l: Loaded, side: "a" | "b", el: HTMLCanvasElement | null) => {
      if (!el) return;
      const page = side === "a" ? e.a : e.b;
      if (page == null) {
        el.width = 300;
        el.height = 100;
        el.style.width = "";
        const ctx = el.getContext("2d")!;
        ctx.fillStyle = "#f3f0ea";
        ctx.fillRect(0, 0, 300, 100);
        ctx.fillStyle = "#666";
        ctx.font = "14px sans-serif";
        ctx.fillText(t("compare.noPage"), 16, 56);
        return;
      }
      const extra = side === "b" ? e.rotate : 0;
      const p = l.pages[page];
      const rotated = extra % 180 ? { w: p.height, h: p.width } : { w: p.width, h: p.height };
      const want = e.scale * zoom * dpr;
      const used = fitScale(rotated.w, rotated.h, want);
      const off = document.createElement("canvas");
      await renderToCanvas(off, l.doc, page, used, (p.baseRotation + extra) % 360);
      if (cancelled) return;
      el.width = off.width;
      el.height = off.height;
      const ctx = el.getContext("2d")!;
      ctx.drawImage(off, 0, 0);
      paint(ctx, e, side, l, used, used / e.scale, selRect(side));
      el.style.width = `${zoom * 100}%`;
    };
    void Promise.all([draw(a, "a", canvasA.current), draw(b, "b", canvasB.current)]).then(() => {
      // 一覧から選んだ違いの場所へ移る
      const k = pendingScroll.current;
      if (cancelled || k == null) return;
      pendingScroll.current = null;
      for (const [side, box, cv] of [
        ["a", scrollA.current, canvasA.current],
        ["b", scrollB.current, canvasB.current],
      ] as const) {
        const page = side === "a" ? e.a : e.b;
        const r = e.hunkRects[k]?.[side];
        if (!box || !cv || !r || page == null) continue;
        const l = side === "a" ? a : b;
        const sz = { w: l.pages[page].width, h: l.pages[page].height };
        const rr = rotRect(r, sz.w, sz.h, side === "b" ? e.rotate : 0);
        const k2 = cv.clientWidth / (side === "b" && e.rotate % 180 ? sz.h : sz.w);
        syncing.current = true;
        box.scrollTo({ left: Math.max(0, (rr.x + rr.w / 2) * k2 - box.clientWidth / 2), top: Math.max(0, (rr.y + rr.h / 2) * k2 - box.clientHeight / 2) });
      }
      requestAnimationFrame(() => (syncing.current = false));
    });
    // 大きな文書：表示した組の描画の差分をここで計算する
    if (!e.boxesA && e.a != null && e.b != null && result) {
      void visualDiff(sideOf(a), sideOf(b), e, result).then((d) => {
        if (cancelled || !alive.current) return;
        e.boxesA = d.boxesA;
        e.boxesB = d.boxesB;
        e.visual = e.visual === true || d.boxesA.length + d.boxesB.length > 0;
        refresh();
      });
    }
    return () => {
      cancelled = true;
    };
    // e は result の中の同じ物を書き換えるので、描き直す合図に e の中身も見る
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a, b, e, e?.boxesA, e?.marksA, e?.rotate, index, zoom, sel, t]);

  // 左右の表示を一緒に動かす
  const onScroll = (from: HTMLDivElement | null, to: HTMLDivElement | null) => {
    if (!from || !to || syncing.current) return;
    syncing.current = true;
    const fx = from.scrollWidth - from.clientWidth;
    const fy = from.scrollHeight - from.clientHeight;
    to.scrollLeft = fx > 0 ? (from.scrollLeft / fx) * (to.scrollWidth - to.clientWidth) : 0;
    to.scrollTop = fy > 0 ? (from.scrollTop / fy) * (to.scrollHeight - to.clientHeight) : 0;
    requestAnimationFrame(() => (syncing.current = false));
  };
  const zoomBy = (dir: 1 | -1) =>
    setZoom((z) => {
      const i = ZOOMS.findIndex((x) => x >= z - 1e-6);
      return ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? ZOOMS.length - 1 : i) + dir))];
    });
  // Ctrl（⌘）＋ホイールで拡大・縮小
  useEffect(() => {
    const els = [scrollA.current, scrollB.current].filter((x): x is HTMLDivElement => !!x);
    const onWheel = (ev: WheelEvent) => {
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault();
      zoomBy(ev.deltaY < 0 ? 1 : -1);
    };
    for (const el of els) el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      for (const el of els) el.removeEventListener("wheel", onWheel);
    };
  }, [result]);

  const toggleLoose = (v: boolean) => {
    setLoose(v);
    setSel(null);
    if (result) {
      applyText(result, v);
      refresh();
    }
  };

  const changed = entries.filter(entryChanged).length;
  const count = (k: EntryState) => entries.filter((x) => stateOf(x) === k).length;
  const go = (i: number) => {
    moved.current = true;
    setSel(null);
    setIndex(Math.max(0, Math.min(entries.length - 1, i)));
  };
  const nextDiff = (dir: 1 | -1) => {
    for (let i = index + dir; i >= 0 && i < entries.length; i += dir) {
      if (entryChanged(entries[i])) return go(i);
    }
  };
  const pickHunk = (k: number) => {
    setSel(k);
    pendingScroll.current = k;
    if (zoom < 2) setZoom(2);
  };
  const pageNo = (n: number | null) => (n == null ? "—" : String(n + 1));
  const total = Math.max(a?.pages.length ?? 0, b?.pages.length ?? 0);

  // 書き出し
  // いまの文書の名前（名前が無いときだけ「いまの文書」）
  const names = (): Names => ({ a: currentName && currentName !== "document" ? `${currentName.replace(/\.pdf$/i, "")}.pdf` : t("compare.current"), b: displayName(b!.doc.name), aPages: a!.pages.length, bPages: b!.pages.length, loose });
  const stem = () => displayName(b!.doc.name).replace(/\.pdf$/i, "");
  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    setMessage(null);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  const snapshot = async (en: PageEntry, side: "a" | "b"): Promise<Snapshot | null> => {
    const l = side === "a" ? a! : b!;
    const page = side === "a" ? en.a : en.b;
    if (page == null) return null;
    const extra = side === "b" ? en.rotate : 0;
    const p = l.pages[page];
    const w = extra % 180 ? p.height : p.width;
    // 報告に載せる画像：印刷しても読める細かさ（幅 1000 画素ほど）
    const px = 1000 / Math.max(1, w);
    const c = document.createElement("canvas");
    const used = await renderToCanvas(c, l.doc, page, px, (p.baseRotation + extra) % 360);
    if (en.a != null && en.b != null && !en.boxesA && result) {
      const d = await visualDiff(sideOf(a!), sideOf(b!), en, result);
      en.boxesA = d.boxesA;
      en.boxesB = d.boxesB;
    }
    paint(c.getContext("2d")!, en, side, l, used, used / en.scale, null);
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/jpeg", 0.85));
    if (!blob) return null;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), width: c.width, height: c.height };
  };
  const exportAnnot = () =>
    run(t("compare.exporting"), async () => {
      const bytes = await annotatedPdf(b!, result!, t);
      downloadBlob(new Blob([bytes as BlobPart], { type: "application/pdf" }), `${stem()}_diff.pdf`);
    });
  const exportMd = () =>
    run(t("compare.exporting"), async () => {
      downloadBlob(new Blob([compareMarkdown(result!, names(), t)], { type: "text/markdown;charset=utf-8" }), `${stem()}_diff.md`);
    });
  const exportInsert = () =>
    run(t("compare.exporting"), async () => {
      const bytes = await reportPdf(result!, names(), t, snapshot);
      onInsert(new File([bytes as BlobPart], `${t("compare.r.title")}.pdf`, { type: "application/pdf" }));
      setMessage(t("compare.inserted"));
    });

  return (
    <Dialog title={t("tool.compare")} onClose={onClose} wide>
      {!result && (
        <div className="compare-pick">
          <p className="note">{t("compare.pickHelp")}</p>
          <label className="btn primary file-btn">
            <Icon name="upload" /> {t("compare.pick")}
            <input
              type="file"
              accept="application/pdf,.pdf"
              hidden
              disabled={status != null}
              onChange={(ev) => {
                const f = ev.target.files?.[0];
                if (f) void pick(f);
                ev.target.value = "";
              }}
            />
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={loose} onChange={(ev) => setLoose(ev.target.checked)} /> {t("compare.loose")}
          </label>
          {status && <p className="note">{status}</p>}
          {error && <p className="note error">{error}</p>}
        </div>
      )}
      {a && b && result && entries.length > 0 && e && (
        <div className="compare">
          <div className="compare-head">
            <b>{status ? t("compare.partial", { changed, done: vis?.done ?? 0, total: vis?.total ?? entries.length }) : changed ? t("compare.summary", { changed, total: entries.length }) : entries.some((x) => x.a != null && x.b != null && (!x.textA || !x.textB)) ? t("compare.identicalScan") : t("compare.identical")}</b>
            <span className="spacer" />
            <button className="btn small" onClick={() => nextDiff(-1)} disabled={!entries.slice(0, index).some(entryChanged)}>
              {t("compare.prevDiff")}
            </button>
            <button className="btn small" onClick={() => go(index - 1)} disabled={index === 0} aria-label={t("page.prev")} title={t("page.prev")}>
              ‹
            </button>
            <span className="compare-page">
              {index + 1} / {entries.length}
            </span>
            <button className="btn small" onClick={() => go(index + 1)} disabled={index >= entries.length - 1} aria-label={t("page.next")} title={t("page.next")}>
              ›
            </button>
            <button className="btn small" onClick={() => nextDiff(1)} disabled={!entries.slice(index + 1).some(entryChanged)}>
              {t("compare.nextDiff")}
            </button>
          </div>
          <div className="compare-sub">
            <span className="compare-counts">{t("compare.counts", { changed: count("changed"), added: count("add"), deleted: count("del"), moved: count("move") })}</span>
            <label className="checkbox">
              <input type="checkbox" checked={loose} onChange={(ev) => toggleLoose(ev.target.checked)} /> {t("compare.loose")}
            </label>
          </div>
          <div className="compare-sub compare-export">
            <span>{t("compare.export")}</span>
            <button className="btn small" disabled={!!status || !!busy} onClick={() => void exportAnnot()} title={t("compare.exportAnnotHelp")}>
              {t("compare.exportAnnot")}
            </button>
            <button className="btn small" disabled={!!status || !!busy} onClick={() => void exportInsert()} title={t("compare.exportInsertHelp")}>
              {t("compare.exportInsert")}
            </button>
            <button className="btn small" disabled={!!status || !!busy} onClick={() => void exportMd()}>
              {t("compare.exportMd")}
            </button>
            {busy && <span className="note">{busy}</span>}
          </div>
          {message && <p className="note">{message}</p>}
          {error && <p className="note error">{error}</p>}
          <div className="compare-map" role="group" aria-label={t("compare.map")}>
            {entries.map((x, k) => {
              const st = stateOf(x);
              const label = `${k + 1}: ${t(STATE_KEY[st])}`;
              return <button key={k} className={`cmp-cell ${st}${k === index ? " on" : ""}`} title={label} aria-label={label} aria-current={k === index ? "true" : undefined} onClick={() => go(k)} />;
            })}
          </div>
          {status && <p className="note">{status}</p>}
          <div className="compare-viewbar">
            <span className="compare-pair">{t("compare.pairInfo", { a: pageNo(e.a), b: pageNo(e.b) })}</span>
            <span className="spacer" />
            <button className="btn small" onClick={() => zoomBy(-1)} disabled={zoom <= ZOOMS[0]} aria-label={t("compare.zoomOut")} title={t("compare.zoomOut")}>
              −
            </button>
            <span className="compare-zoom">{Math.round(zoom * 100)}%</span>
            <button className="btn small" onClick={() => zoomBy(1)} disabled={zoom >= ZOOMS[ZOOMS.length - 1]} aria-label={t("compare.zoomIn")} title={t("compare.zoomIn")}>
              ＋
            </button>
            <button className="btn small" onClick={() => setZoom(1)} disabled={zoom === 1}>
              {t("compare.zoomFit")}
            </button>
          </div>
          <div className="compare-canvases">
            <figure>
              <figcaption>{t("compare.current")}</figcaption>
              <div className="cmp-scroll" ref={scrollA} onScroll={() => onScroll(scrollA.current, scrollB.current)}>
                <canvas ref={canvasA} />
              </div>
            </figure>
            <figure>
              <figcaption>{displayName(b.doc.name)}</figcaption>
              <div className="cmp-scroll" ref={scrollB} onScroll={() => onScroll(scrollB.current, scrollA.current)}>
                <canvas ref={canvasB} />
              </div>
            </figure>
          </div>
          <div className="compare-notes">
            {e.kind === "del" && <p className="note">{t("compare.onlyA")}</p>}
            {e.kind === "add" && <p className="note">{t("compare.onlyB")}</p>}
            {e.kind === "move" && <p className="note">{t("compare.moved")}</p>}
            {e.rotate !== 0 && <p className="note">{t("compare.rotated")}</p>}
            {e.a != null && e.b != null && e.textA !== e.textB && <p className="note">{t("compare.noTextOne")}</p>}
            {e.a != null && e.b != null && !e.textA && !e.textB && <p className="note">{t("compare.noTextBoth")}</p>}
            {e.a != null && e.b != null && e.textA && e.textB && e.hunks.length === 0 && e.visual === true && <p className="note">{t("compare.visualOnly")}</p>}
            {e.truncated && <p className="note">{t("compare.truncated", { n: 2000 })}</p>}
            {!entryChanged(e) && <p className="note">{e.boxesA || e.visual === false ? t("compare.pageSame") : t("compare.checking")}</p>}
          </div>
          {e.hunks.length > 0 && (
            <div className="compare-text">
              <b>{t("compare.textDiff")}</b>
              <ul>
                {e.hunks.slice(0, MAX_HUNKS).map((h, i) => (
                  <HunkView key={i} h={h} t={t} on={sel === i} onPick={() => pickHunk(i)} />
                ))}
              </ul>
              {e.hunks.length > MAX_HUNKS && <p className="note">{t("compare.more", { n: e.hunks.length - MAX_HUNKS })}</p>}
            </div>
          )}
          {total > QUICK_VISUAL_LIMIT ? <p className="note">{t("compare.largeNote")}</p> : total > FULL_VISUAL_LIMIT ? <p className="note">{t("compare.quickNote")}</p> : null}
        </div>
      )}
    </Dialog>
  );
}

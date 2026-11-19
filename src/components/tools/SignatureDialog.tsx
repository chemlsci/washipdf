import { approvalTitles } from "@/lib/approval";
import { DEFAULTS } from "../PageEditor";
import { useEffect, useRef, useState } from "react";
import { cssFontStack, defaultFont, ensureFontFace } from "@/lib/fonts";
import { useT } from "@/lib/i18n";
import { drawSeal, drawStroke, drawStrokes, imageToSignaturePng, keepSignature, keptSignatures, sealToPng, type Stroke, strokesToPng } from "@/lib/signature";
import { Dialog } from "../Dialog";

type Tab = "draw" | "seal" | "image" | "approval";
const COLORS = ["#111111", "#1d3fbf", "#c8102e"];
const WIDTHS = [1.6, 2.6, 4];

/**
 * 署名を作ってページに置く。手書き・印鑑風・画像の 3 通り。
 * できた署名は透明な背景の画像としてページに置かれ、保存するとページの内容に焼き込まれる（注釈ではない）。
 */
export function SignatureDialog({ onPlace, onPlaceApproval, onClose }: { onPlace: (file: File, widthPt: number) => void; onPlaceApproval: (headings: string) => void; onClose: () => void }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>("draw");
  const [busy, setBusy] = useState(false);

  // 手書き
  const pad = useRef<HTMLCanvasElement>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const current = useRef<Stroke | null>(null);
  const [color, setColor] = useState(COLORS[0]);
  const [width, setWidth] = useState(WIDTHS[1]);
  const redraw = (list: Stroke[]) => {
    const c = pad.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const r = c.getBoundingClientRect();
    if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) {
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
    }
    ctx.clearRect(0, 0, c.width, c.height);
    drawStrokes(ctx, list, dpr);
  };
  useEffect(() => {
    if (tab === "draw") redraw(strokes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, strokes]);
  // 欄の大きさが変わったとき（端末を回した、ウィンドウの幅を変えた）：すぐに描き直す。
  // 描き直さないと、前の大きさの絵が引き伸ばされて、書いた線がつぶれて見える。
  // 欄が小さくなって線がはみ出すときは、全体を縮めて欄に収める（続きを書く位置と、見えている線がずれないように）
  const strokesRef = useRef(strokes);
  strokesRef.current = strokes;
  useEffect(() => {
    const c = pad.current;
    if (tab !== "draw" || !c || typeof ResizeObserver === "undefined") return;
    let raf = 0;
    const fit = () => {
      const r = c.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const list = strokesRef.current;
      let maxX = 0;
      let maxY = 0;
      for (const s of list)
        for (const p of s.points) {
          maxX = Math.max(maxX, p.x);
          maxY = Math.max(maxY, p.y);
        }
      const k = Math.min(1, maxX > 0 ? (r.width - 6) / maxX : 1, maxY > 0 ? (r.height - 6) / maxY : 1);
      if (k < 1 && k > 0) setStrokes(list.map((s) => ({ ...s, width: s.width * k, points: s.points.map((p) => ({ ...p, x: p.x * k, y: p.y * k })) })));
      else redraw(list);
    };
    // 書き直しで表示が変わるので、大きさの知らせの中ではなく、次の描画の前に行う
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(fit);
    });
    ro.observe(c);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
  /** 書いている指・ペン（ほかの指や手のひらの接触は無視する） */
  const active = useRef<{ id: number; type: string } | null>(null);
  /** ペンを使ったことがあるか（あれば、指の接触は手のひらとみなして無視する） */
  const penUsed = useRef(false);
  const at = (e: { clientX: number; clientY: number; pressure: number }, pen: boolean) => {
    const r = pad.current!.getBoundingClientRect();
    return pen ? { x: e.clientX - r.left, y: e.clientY - r.top, p: e.pressure || 0.5 } : { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const pen = e.pointerType === "pen";
    if (pen) penUsed.current = true;
    // 2 本目の指・手のひら：書いている線は切り替えない。ペンを使っているときの指の接触も無視する
    if (!e.isPrimary || (active.current && active.current.id !== e.pointerId) || (!pen && e.pointerType === "touch" && penUsed.current)) {
      // ペンで書き始めたとき、指（手のひら）で書きかけの線は捨てる
      if (pen && active.current?.type === "touch") {
        current.current = null;
        active.current = null;
        redraw(strokes);
      } else return;
    }
    try {
      pad.current?.setPointerCapture(e.pointerId);
    } catch {
      /* 取り込めなくても、欄の中で書く分には困らない */
    }
    active.current = { id: e.pointerId, type: e.pointerType };
    current.current = { points: [at(e, pen)], color, width };
    const c = pad.current;
    const ctx = c?.getContext("2d");
    if (c && ctx) drawStroke(ctx, current.current, window.devicePixelRatio || 1);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!current.current || active.current?.id !== e.pointerId) return;
    const pen = e.pointerType === "pen";
    // 速く書いたときに間引かれた点も拾う（角ばらないように）
    const list = (e.nativeEvent as PointerEvent).getCoalescedEvents?.() ?? [];
    const from = current.current.points.length;
    for (const ev of list.length ? list : [e]) current.current.points.push(at(ev, pen));
    // 足した部分だけを描く（全部を描き直すと、長い署名で遅くなる）
    const c = pad.current;
    const ctx = c?.getContext("2d");
    if (c && ctx) drawStroke(ctx, current.current, window.devicePixelRatio || 1, 0, 0, Math.max(1, from - 1), true);
  };
  const onUp = (e: React.PointerEvent) => {
    if (!current.current || active.current?.id !== e.pointerId) return;
    // （続けて速く書いたとき、前の線を取りこぼさないよう、いまの一覧に足す）
    const done = current.current;
    setStrokes((list) => [...list, done]);
    current.current = null;
    active.current = null;
  };

  // 印鑑風
  const [name, setName] = useState("");
  const [shape, setShape] = useState<"round" | "square">("round");
  const sealRef = useRef<HTMLCanvasElement>(null);
  const sealFont = defaultFont("serif");
  const [fontReady, setFontReady] = useState(false);
  useEffect(() => {
    let alive = true;
    void ensureFontFace(sealFont).then(() => alive && setFontReady(true));
    return () => {
      alive = false;
    };
  }, [sealFont]);
  useEffect(() => {
    const c = sealRef.current;
    if (tab !== "seal" || !c) return;
    drawSeal(c.getContext("2d")!, c.width, { text: name, shape, color: COLORS[2], fontFamily: cssFontStack(sealFont) });
  }, [tab, name, shape, fontReady, sealFont]);

  // 画像
  const [picked, setPicked] = useState<File | null>(null);
  const [transparent, setTransparent] = useState(true);
  const [preview, setPreview] = useState<{ blob: Blob; url: string; width: number; height: number } | null>(null);
  useEffect(() => {
    if (!picked) {
      setPreview(null);
      return;
    }
    let alive = true;
    let made: string | null = null;
    imageToSignaturePng(picked, transparent)
      .then((r) => {
        if (!alive) return;
        made = URL.createObjectURL(r.blob);
        setPreview({ ...r, url: made });
      })
      .catch(() => alive && setPreview(null));
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [picked, transparent]);

  // 承認欄：役職の見出し（「,」区切り）
  const [headings, setHeadings] = useState(() => DEFAULTS.stamp.grid || t("approval.preset1"));
  const ready = tab === "draw" ? strokes.length > 0 : tab === "seal" ? name.trim().length > 0 : tab === "approval" ? headings.trim().length > 0 : !!preview;
  const place = async () => {
    if (tab === "approval") {
      DEFAULTS.stamp.grid = headings;
      onPlaceApproval(headings);
      return;
    }
    setBusy(true);
    try {
      // ページに置くときの幅：手書きは描いた大きさの 6 割ほど（最大 200pt）、印鑑は 18 mm、画像は 160pt まで
      let blob: Blob | null = null;
      let widthPt = 160;
      if (tab === "draw") {
        const r = await strokesToPng(strokes);
        if (r) {
          blob = r.blob;
          widthPt = Math.min(200, Math.max(40, r.width * 0.6));
        }
      } else if (tab === "seal") {
        blob = (await sealToPng({ text: name, shape, color: COLORS[2], fontFamily: cssFontStack(sealFont) })).blob;
        widthPt = 51;
      } else if (preview) {
        blob = preview.blob;
        widthPt = Math.min(160, Math.max(40, preview.width * 0.75));
      }
      if (!blob) return;
      keepSignature(blob, widthPt);
      onPlace(new File([blob], "signature.png", { type: "image/png" }), widthPt);
    } finally {
      setBusy(false);
    }
  };
  const recent = keptSignatures();

  return (
    <Dialog
      title={t("sign.title")}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" disabled={!ready || busy} onClick={() => void place()}>
            {t("sign.place")}
          </button>
        </>
      }
    >
      <div className="seg" role="tablist">
        {(["draw", "seal", "image", "approval"] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
            {t(k === "draw" ? "sign.draw" : k === "seal" ? "sign.seal" : k === "image" ? "sign.image" : "sign.approval")}
          </button>
        ))}
      </div>

      {tab === "draw" && (
        <>
          <canvas ref={pad} className="sign-pad" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} aria-label={t("sign.draw")} />
          <div className="sign-row">
            {COLORS.map((c) => (
              <button key={c} type="button" className={`sign-color ${color === c ? "on" : ""}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} aria-pressed={color === c} />
            ))}
            <span className="divider" />
            {WIDTHS.map((w) => (
              <button key={w} type="button" className={`sign-width ${width === w ? "on" : ""}`} onClick={() => setWidth(w)} title={t("sign.thickness")} aria-label={`${t("sign.thickness")} ${w}`} aria-pressed={width === w}>
                <span style={{ height: w * 1.4 }} />
              </button>
            ))}
            <span className="spacer" />
            <button type="button" className="btn small" disabled={!strokes.length} onClick={() => setStrokes(strokes.slice(0, -1))}>
              {t("sign.undo")}
            </button>
            <button type="button" className="btn small" disabled={!strokes.length} onClick={() => setStrokes([])}>
              {t("sign.clear")}
            </button>
          </div>
        </>
      )}

      {tab === "seal" && (
        <div className="sign-seal">
          <canvas ref={sealRef} width={240} height={240} className="sign-seal-preview" />
          <div className="sign-seal-form">
            <label className="field">
              <span>{t("sign.name")}</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={24} autoFocus spellCheck={false} />
            </label>
            <div className="seg small" role="group">
              <button className={shape === "round" ? "on" : ""} aria-pressed={shape === "round"} onClick={() => setShape("round")}>
                {t("sign.round")}
              </button>
              <button className={shape === "square" ? "on" : ""} aria-pressed={shape === "square"} onClick={() => setShape("square")}>
                {t("sign.square")}
              </button>
            </div>
          </div>
        </div>
      )}

      {tab === "image" && (
        <>
          <label className="field">
            <span>{t("sign.chooseImage")}</span>
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => setPicked(e.target.files?.[0] ?? null)} />
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.target.checked)} /> {t("sign.transparent")}
          </label>
          {preview && (
            <div className="sign-image-preview">
              <img src={preview.url} alt="" />
            </div>
          )}
        </>
      )}

      {tab === "approval" && (
        <>
          <p className="note">{t("sign.approvalLead")}</p>
          <label className="field">
            <span>{t("approval.titles")}</span>
            <input value={headings} onChange={(e) => setHeadings(e.target.value)} />
          </label>
          <div className="chips">
            {(["approval.preset1", "approval.preset2", "approval.preset3"] as const).map((k) => (
              <button key={k} type="button" className={`chip ${headings === t(k) ? "on" : ""}`} aria-pressed={headings === t(k)} onClick={() => setHeadings(t(k))}>
                {t(k).replace(/,/g, " · ")}
              </button>
            ))}
          </div>
          <div className="approval-sample" aria-hidden>
            {approvalTitles(headings).map((h, i) => (
              <div key={i}>
                <span>{h}</span>
                <span />
              </div>
            ))}
          </div>
        </>
      )}

      {tab !== "approval" && recent.length > 0 && (
        <div className="sign-recent">
          <span className="note">{t("sign.recent")}</span>
          <div className="sign-recent-list">
            {recent.map((s) => (
              <button key={s.id} type="button" className="sign-recent-item" onClick={() => onPlace(new File([s.blob], "signature.png", { type: "image/png" }), s.widthPt)}>
                <img src={s.url} alt="" />
              </button>
            ))}
          </div>
        </div>
      )}
      {tab !== "approval" && <p className="note">{t("sign.note")}</p>}
    </Dialog>
  );
}

import type { Record as HistRecord } from "@/lib/useHistory";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { colorPick } from "@/lib/colorPick";
import { cssSpaceEm, type PreviewFont, previewFontFor, toPreviewText } from "@/lib/previewFont";
import { createPortal } from "react-dom";
import { createTextEdit, joinLines } from "@/lib/editModel";
import { previewLayout, type PreviewLayout } from "@/lib/editPreview";
import { type ExactBand, exactEditBand } from "@/lib/exactPreview";
import { fallbackKey } from "@/lib/exportPdf";
import { baselineOffset, coverage, cssFontStack, defaultFont, ensureFontFace, fontDef, fontRuns, LINE_HEIGHT, measureBundled, pickFont } from "@/lib/fonts";
import { useT, AppError } from "@/lib/i18n";
import { apply, normAngle, uid, unrotatePoint } from "@/lib/geometry";
import { fitScale, renderToCanvas } from "@/lib/render";
import { getPageImages, type PageImage } from "@/lib/pageImages";
import { getPageText, sampleColors, type TextRun } from "@/lib/textRuns";
import { NOTE_SIZE } from "@/lib/annots";
import { approvalLayout, cellFromRules, fitIntoCell, fitToRect, insideApproval, isApproval } from "@/lib/approval";
import { analyzePage } from "@/lib/libDoc";
import { labelAnchor, measureLabel, withPoints } from "@/lib/measure";
import { verticalUnits } from "@/lib/verticalText";
import { pathKey, samePath } from "@/lib/textOps";
import type { EditObj, FieldObj, FontKey, ImageEditObj, InkObj, LineObj, LinkObj, MarkupObj, MeasureObj, NoteObj, PageItem, RedactObj, ShapeObj, SourceDoc, StampObj, StoredImage, TextEditObj, TextObj, Tool } from "@/lib/types";

export type UpdateObjects = (fn: (objs: EditObj[]) => EditObj[], record?: HistRecord) => void;

/** 承認欄の見出しの文字の大きさ（欄に入らなければ縮める。保存と同じ決め方） */
function titleSize(o: StampObj, title: string, col: number): number {
  let w = 0;
  try {
    w = title ? measureBundled(o.font, title, o.fontSize) : 0;
  } catch {
    /* フォントをまだ読んでいなければ縮めない */
  }
  return w > 0 ? Math.min(o.fontSize, (o.fontSize * col * 0.88) / w) : o.fontSize;
}

export const DEFAULTS = {
  text: { fontSize: 14, color: "#111111" },
  shape: { stroke: "#e11d48", strokeWidth: 2, fill: null as string | null, opacity: 1 },
  whiteout: { fill: "#ffffff" },
  markup: { highlight: "#ffe234", underline: "#e11d48", strikeout: "#e11d48" },
  note: { color: "#ffd43b" },
  ink: { stroke: "#e11d48", strokeWidth: 2.5, opacity: 1 },
  stamp: { color: "#d6334a", fontSize: 18, text: "" /* 空なら画面の言語の「承認」 */, frame: "rect" as const, double: false, grid: "" },
  // 計測：最後に使った種類・縮尺・単位を、次の計測にも使う
  measure: { kind: "distance" as "distance" | "path" | "area", scale: 1, unit: "mm" as "mm" | "cm" | "m", color: "#d6334a" },
};

const MARKUP_TOOLS = new Set<Tool>(["highlight", "underline", "strikeout"]);
/** 指でなぞるとスクロールになる道具（ほかの道具は、1 本指でなぞると描く） */
const PAN_TOOLS = new Set<Tool>(["select", "edit-text", "image-edit", "text", "note", "stamp"]);
/** いまの道具で、指 1 本でなぞると描くか（スクロールにならないか）。既存文字の「範囲」は、なぞって行を囲む */
export const touchDraws = (tool: Tool, unit: "line" | "block" | "range") => !PAN_TOOLS.has(tool) || (tool === "edit-text" && unit === "range");
/** 指で押す端末か（つまみの当たりを大きくする） */
const COARSE = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;

// ---- タッチ：ページを押した直後の「同じタップのクリック」が、ページの外の部品に届かないようにする ----
// ページをタップすると選択が変わり、画面下のパネルが指の下に開く。ブラウザは、指を離したあとで
// 「そのとき指の下にあるもの」にクリックを届けるので、同じタップのクリックがパネルの部品（つまみ・チェック・色など）に
// 届いて、押したつもりのない操作になる。
// ページを押してから指を離して少し経つまで、ページの外に届くクリック（と、それに先立つマウスの知らせ）を捨てる
let disarmGhost: (() => void) | null = null;
function guardGhostClick(pageEl: HTMLElement) {
  disarmGhost?.();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const swallow = (e: Event) => {
    if (e.target instanceof Node && pageEl.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
  };
  const off = () => {
    clearTimeout(timer);
    for (const type of ["click", "mousedown", "mouseup"]) window.removeEventListener(type, swallow, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onUp, true);
    window.removeEventListener("pointerdown", off, true);
    if (disarmGhost === off) disarmGhost = null;
  };
  const onUp = () => {
    clearTimeout(timer);
    timer = setTimeout(off, 700);
  };
  for (const type of ["click", "mousedown", "mouseup"]) window.addEventListener(type, swallow, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onUp, true);
  // 次に押したとき（別のタップ）からは捨てない
  window.addEventListener("pointerdown", off, true);
  disarmGhost = off;
}

// ---- 連続表示：見るだけのページを押したときの操作を、そのページを編集するページにした直後に引き継ぐ ----
// （引き継がないと、最初の 1 回は「ページを切り替えるだけ」になり、描いたつもりの線や置いたつもりの文字が出ない）
interface PointerInfo {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
  shiftKey: boolean;
  /** ページの枠（回転を含めた外接矩形）の左上からの位置。引き継ぐときは、画面上の位置ではなくこれで指し直す
   * （ページを切り替えると、選択が解けて下のパネルが閉じ、並びやスクロールが動くので、画面上の同じ点は別の場所になる） */
  dx: number;
  dy: number;
  /** 押した時刻 */
  time: number;
}
interface Handoff {
  pageId: string;
  down: PointerInfo;
  up: PointerInfo | null;
  time: number;
  stop: () => void;
}
let handoff: Handoff | null = null;
const pointerInfo = (e: { pointerId: number; pointerType: string; clientX: number; clientY: number; shiftKey: boolean }, pageEl: Element): PointerInfo => {
  const r = pageEl.getBoundingClientRect();
  return { pointerId: e.pointerId, pointerType: e.pointerType, clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey, dx: e.clientX - r.left, dy: e.clientY - r.top, time: performance.now() };
};
function beginHandoff(pageId: string, down: PointerInfo, up: PointerInfo | null) {
  handoff?.stop();
  const h: Handoff = { pageId, down, up, time: performance.now(), stop: () => {} };
  if (!up) {
    // 引き継ぐ前に離したら、離した位置を覚えておく。操作が取り消されたら（スクロールになったなど）引き継がない
    const onEnd = (e: PointerEvent) => {
      if (e.pointerId !== down.pointerId) return;
      if (e.type === "pointercancel") {
        if (handoff === h) handoff = null;
      } else h.up = { ...pointerInfo(e, document.body), dx: down.dx + e.clientX - down.clientX, dy: down.dy + e.clientY - down.clientY };
      h.stop();
    };
    window.addEventListener("pointerup", onEnd, true);
    window.addEventListener("pointercancel", onEnd, true);
    h.stop = () => {
      window.removeEventListener("pointerup", onEnd, true);
      window.removeEventListener("pointercancel", onEnd, true);
    };
  }
  handoff = h;
}
const DRAG_TOOLS = new Set<Tool>(["rect", "ellipse", "line", "whiteout", "highlight", "underline", "strikeout", "redact", "link", "field"]);

interface Props {
  page: PageItem;
  source?: SourceDoc;
  images: Map<string, StoredImage>;
  zoom: number;
  tool: Tool;
  setTool: (t: Tool) => void;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  updateObjects: UpdateObjects;
  checkpoint: () => void;
  /** 既存文字ツールの単位：行／段落（ブロック）／範囲（ドラッグで囲んだ行） */
  unit: "line" | "block" | "range";
  /** ページ上でその場編集する（false ならスマホ向けに、選択だけしてプロパティ側の入力欄で編集） */
  inlineEditing: boolean;
  /** ピンチ操作による拡大縮小 */
  onPinchZoom: (factor: number) => void;
  /** 点を順に押して作る計測（折れ線・面積）の途中かどうかを知らせる */
  onDrafting?: (open: boolean) => void;
}

type Drag =
  | { kind: "move"; id: string; start: [number, number]; orig: EditObj; moved: boolean; wasSelected: boolean; riders: EditObj[] }
  | { kind: "resize"; id: string; handle: string; start: [number, number]; orig: EditObj; moved: boolean; textH?: number }
  | { kind: "rotate"; id: string; start: [number, number]; startAngle: number; orig: TextObj; moved: boolean }
  | { kind: "create"; tool: Tool; start: [number, number]; id: string | null }
  | { kind: "ink"; id: string; points: [number, number][] }
  | { kind: "measure"; id: string; start: [number, number] }
  | { kind: "pan"; lastX: number; lastY: number }
  | { kind: "marquee"; start: [number, number]; runId: string | null; moved: boolean };

const HANDLES = ["nw", "ne", "sw", "se"] as const;

export function PageEditor(props: Props) {
  const { page, source, images, zoom, tool, selectedId, editingId } = props;
  const t = useT();
  // 指で始めた 1 回の操作（押してから離すまで）。2 本目の指が触れたら、この操作でしたことを取りやめる
  const gesture = useRef<{ objects: EditObj[]; selected: string | null; editing: string | null; tool: Tool; draft: string | null; touched: boolean; recorded: boolean; time: number } | null>(null);
  const updateObjects: UpdateObjects = (fn, record = true) => {
    const g = gesture.current;
    if (g) {
      g.touched = true;
      if (record === true) g.recorded = true;
    }
    props.updateObjects(fn, record);
  };
  const checkpoint = () => {
    const g = gesture.current;
    if (g) g.touched = g.recorded = true;
    props.checkpoint();
  };
  const W = page.width;
  const H = page.height;
  const rot = page.extraRotation;
  const swap = rot % 180 !== 0;
  const outerW = (swap ? H : W) * zoom;
  const outerH = (swap ? W : H) * zoom;

  const pageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<Drag | null>(null);
  const fresh = useRef(new Set<string>());
  const [runs, setRuns] = useState<TextRun[]>([]);
  const [pageError, setPageError] = useState<string | null>(null);
  const [runsLoading, setRunsLoading] = useState(false);
  const [rendering, setRendering] = useState(true);

  // ページ描画（ズーム変更時は少し待ってから高解像度で描き直す）
  usePageCanvas(canvasRef, source, page, zoom, true, setRendering);

  useEffect(() => setRendering(true), [page.id]);

  // スマホ：書き換える行を選んだら、パネルとキーボードに隠れない位置（表示領域の中央）まで送る
  useEffect(() => {
    if (props.inlineEditing || !selectedId) return;
    const o = page.objects.find((x) => x.id === selectedId);
    if (!o || (o.type !== "textedit" && o.type !== "text")) return;
    // 行が表示の幅より長いときは、行の頭（書き始め）が見えるようにする
    const center = () => {
      const el = pageRef.current?.querySelector<HTMLElement>(`[data-obj="${selectedId}"]`);
      if (!el) return;
      const scroller = el.closest(".stage");
      const wide = !!scroller && el.getBoundingClientRect().width > scroller.clientWidth - 16;
      el.scrollIntoView({ block: "center", inline: wide ? "start" : "center" });
    };
    center();
    const tm = setTimeout(center, 450);
    // キーボードが出る・入力中の表示に切り替わるなどで、見える範囲が変わったら、もう一度送る（指で動かしたときは送らない）
    let pending: ReturnType<typeof setTimeout> | undefined;
    const later = () => {
      clearTimeout(pending);
      pending = setTimeout(center, 120);
    };
    window.visualViewport?.addEventListener("resize", later);
    const stage = pageRef.current?.closest(".stage");
    const ro = typeof ResizeObserver !== "undefined" && stage ? new ResizeObserver(later) : null;
    if (ro && stage) ro.observe(stage);
    return () => {
      clearTimeout(tm);
      clearTimeout(pending);
      window.visualViewport?.removeEventListener("resize", later);
      ro?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, props.inlineEditing]);

  // 既存画像の位置（「既存画像」ツールのとき）
  const [pageImages, setPageImages] = useState<PageImage[] | null>(null);
  useEffect(() => {
    if (tool !== "image-edit" || !source) {
      setPageImages(null);
      return;
    }
    let alive = true;
    getPageImages(source, page).then(
      (list) => alive && setPageImages(list),
      () => alive && setPageImages([]),
    );
    return () => {
      alive = false;
    };
  }, [tool, source, page]);

  // 既存テキストの抽出（pdf.js の行と、コンテンツストリームの命令の対応付け）
  useEffect(() => {
    if (tool !== "edit-text" || !source) {
      setRuns([]);
      setPageError(null);
      return;
    }
    let alive = true;
    setRunsLoading(true);
    getPageText(source, page).then(
      (r) => {
        if (!alive) return;
        setRuns(r.runs);
        setPageError(r.pageError);
        setRunsLoading(false);
      },
      (e) => {
        if (!alive) return;
        setRuns([]);
        // 内部の（英語の）例外は、訳した文で包む
        setPageError(e instanceof AppError ? e.message : t("text.analysisFailed", { detail: e instanceof Error ? e.message : String(e) }));
        setRunsLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [tool, source, page]);

  const toPage = useCallback(
    (e: { clientX: number; clientY: number }): [number, number] => {
      const r = pageRef.current!.getBoundingClientRect();
      const [lx, ly] = unrotatePoint(e.clientX, e.clientY, r, W * zoom, H * zoom, rot);
      return [lx / zoom, ly / zoom];
    },
    [W, H, zoom, rot],
  );

  const setObj = (id: string, patch: (o: EditObj) => EditObj, record = false) =>
    updateObjects((objs) => objs.map((o) => (o.id === id ? patch(o) : o)), record);

  const startEditing = (id: string) => {
    props.setSelectedId(id);
    if (props.inlineEditing) props.setEditingId(id);
  };

  // ピンチズーム：ページ上の 2 本指の距離の変化を倍率に反映する
  const pointers = useRef(new Map<number, [number, number]>());
  const pinch = useRef<{ dist: number } | null>(null);
  // 2 本目の指が触れたら 1 本目で始まった操作を取り消す（倍率の変更はステージ側の touch イベントで行う）。
  // 1 本目が置いた文字・付箋・スタンプ、引き始めた線や計測、動かし始めた部品は、履歴にも残さず元に戻す
  const cancelGesture = () => {
    const g = gesture.current;
    const dragging = !!drag.current;
    gesture.current = null;
    drag.current = null;
    tapStart.current = null;
    setMarquee(null);
    // 元に戻すのは、いま続いている操作だけ：なぞっている途中（指を離す知らせが必ず届く）か、押してから間もないとき。
    // 指を離した知らせが届かずに残った古い記録で、そのあとの編集まで巻き戻さないようにする
    if (!g || (!dragging && performance.now() - g.time > 1500)) return;
    if (areaDraft.current !== g.draft) setDraft(g.draft);
    if (g.touched) props.updateObjects(() => g.objects, g.recorded ? "cancel" : false);
    props.setSelectedId(g.selected);
    props.setEditingId(g.editing);
    props.setTool(g.tool);
  };
  const cancelGestureRef = useRef(cancelGesture);
  cancelGestureRef.current = cancelGesture;
  // 2 本目の指がページの外（余白）に触れたときも同じ
  useEffect(() => {
    const onTouch = (e: TouchEvent) => {
      if (e.touches.length >= 2) cancelGestureRef.current();
    };
    window.addEventListener("touchstart", onTouch, { passive: true, capture: true });
    return () => window.removeEventListener("touchstart", onTouch, true);
  }, []);
  const capture = (e: React.PointerEvent) => {
    try {
      pageRef.current?.setPointerCapture(e.pointerId);
    } catch {
      /* 引き継いだ操作で、もう指（ボタン）が離れている */
    }
  };
  const trackPointer = (e: React.PointerEvent) => {
    if (e.pointerType !== "touch") return false;
    // 最初の指（isPrimary）が触れた時点では、ほかの指は触れていない。前のタップの記録が残っていたら捨てる
    // （タップした行の枠が消えるなどして、指を離した知らせがここに届かないことがある。残っていると、次のタップが 2 本目の指と見なされて何も起きない）
    if (e.isPrimary) {
      pointers.current.clear();
      pinch.current = null;
    }
    pointers.current.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.current.size === 2) {
      if (!pinch.current) {
        pinch.current = { dist: 0 };
        cancelGesture();
      }
      return true;
    }
    return false;
  };
  const releasePointer = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };

  /** 入力した文字がいまのフォントに無ければ、書けるフォント（同じ系統を優先）に切り替える */
  const withFittingFont = (o: TextObj, text: string): TextObj => {
    if (o.type !== "text" || !text.trim() || !fontDef(o.font) || coverage(o.font, text) === 1) return { ...o, text };
    const font = pickFont(fontDef(o.font)?.family ?? "sans", text, o.font);
    // 全部の字を書けるフォントが無い（複数の文字が混ざっている）ときは、いまのフォントのままにする：
    // 無い字は、字ごとに書けるフォントで書かれる（fontRuns）
    if (font !== o.font && coverage(font, text) < 1 && coverage(o.font, text) > 0) return { ...o, text };
    if (font !== o.font) void ensureFontFace(font);
    return { ...o, text, font };
  };

  const addText = (x: number, y: number) => {
    const o: TextObj = { id: uid(), type: "text", x, y, text: "", font: defaultFont("sans"), ...DEFAULTS.text };
    fresh.current.add(o.id);
    updateObjects((objs) => [...objs, o]);
    startEditing(o.id);
    props.setTool("select");
  };

  const replaceRun = (run: TextRun) => {
    const canvas = canvasRef.current;
    let colors = { bg: "#ffffff", fg: "#000000" };
    if (canvas && canvas.width > 1) colors = sampleColors(canvas, canvas.width / W, { x: run.x, y: run.top, w: run.w, h: run.h });
    const fg = /^#[0-3][0-9a-f][0-3][0-9a-f][0-3][0-9a-f]$/i.test(colors.fg) ? "#000000" : colors.fg;
    // （和文・欧文の行は広げない：行間の詰まった文書で、上下の行に掛かってしまう）
    const pad = /[\u0590-\u08ff\u0900-\u0dff\u0e00-\u0eff\ufb1d-\ufdff\ufe70-\ufeff\u0000-\u001f\ue000-\uf8ff\ufffd]/.test(run.text) ? run.fontSize * 0.12 : 0;
    const cover: ShapeObj = {
      id: uid(),
      type: "whiteout",
      x: run.x - 1,
      // 上下に付く記号（アラビア文字の母音記号など）や深く下がる字も隠れるよう、上下を少し広げる
      y: run.top - 1 - pad,
      w: run.w + 2,
      h: run.h + 2 + pad * 2,
      stroke: null,
      fill: colors.bg,
      strokeWidth: 0,
      opacity: 1,
    };
    const fs = Math.round(run.fontSize * 10) / 10;
    // 読めなかった字（文字の対応を持たないフォントの字：制御文字・私用領域・「不明」の印）は、入力欄に入れない。
    // 読めない字が多い行は、空から打ち直してもらう（文字化けした中身をそのまま重ねない）
    const visible = [...run.text].filter((ch) => !/\s/.test(ch));
    const readable = run.text.replace(/[\u0000-\u001f\u007f-\u009f\ue000-\uf8ff\ufffd\ufff0-\uffff]/g, "");
    const kept = [...readable].filter((ch) => !/\s/.test(ch)).length;
    const text = kept >= visible.length * 0.8 ? readable : "";
    // フォントは、その行の字（読めないときは、同じページの読める行の字）に合うものにする
    const sample = text || runs.find((r) => r.editable && r.complex)?.text || runs.find((r) => r.editable)?.text || "";
    const t: TextObj = {
      id: uid(),
      type: "text",
      x: run.x,
      y: run.baseline - baselineOffset(fs),
      text,
      fontSize: fs,
      font: sample ? pickFont(run.family, sample) : run.font,
      color: fg,
    };
    fresh.current.add(t.id);
    updateObjects((objs) => [...objs, cover, t]);
    startEditing(t.id);
  };

  /** 既存文字の実編集：元の命令を消して書き直すオブジェクトを作る（行・段落・範囲で囲んだ行） */
  const editRuns = (group: TextRun[]) => {
    if (!group.length) return;
    const canvas = canvasRef.current;
    const x = Math.min(...group.map((r) => r.x));
    const top = Math.min(...group.map((r) => r.top));
    const right = Math.max(...group.map((r) => r.x + r.w));
    const bottom = Math.max(...group.map((r) => r.top + r.h));
    let colors = { bg: "#ffffff", fg: "#000000" };
    if (canvas && canvas.width > 1) colors = sampleColors(canvas, canvas.width / W, { x, y: top, w: right - x, h: bottom - top });
    const fg = /^#[0-3][0-9a-f][0-3][0-9a-f][0-3][0-9a-f]$/i.test(colors.fg) ? "#000000" : colors.fg;
    const e = createTextEdit(group, { cover: colors.bg, fallbackColor: fg });
    // すでに書き換えた行を含むとき（行を書き換えたあと、同じ段落を「段落」で書き換える）：前の書き換えを取り込む。
    // 取り込まないと、前の書き換えと新しい書き換えが同じ場所に重なって書かれる。
    // 元の文字は元のまま持ち、いまの文字に前の書き換えの文字を入れる（前の書き換えは、同じ 1 手の中で外す）
    const key = (x: { index: number; path?: number[] }) => pathKey(x.path ?? [], x.index);
    const keys = new Set(group.flatMap((r) => r.removals.map(key)));
    const absorbed = page.objects.filter((o): o is TextEditObj => o.type === "textedit" && o.removals.some((x) => keys.has(key(x))));
    if (absorbed.length) {
      const sorted = [...group].sort((a, b) => a.lineIndex - b.lineIndex || a.baseline - b.baseline);
      const used = new Set<string>();
      const lines: string[] = [];
      for (const r of sorted) {
        const old = absorbed.find((o) => o.removals.some((x) => r.removals.some((y) => key(x) === key(y))));
        if (!old) lines.push(r.text);
        else if (!used.has(old.id)) {
          used.add(old.id);
          lines.push(old.text);
        }
      }
      e.text = joinLines(lines);
    } else fresh.current.add(e.id);
    const gone = new Set(absorbed.map((o) => o.id));
    updateObjects((objs) => [...objs.filter((o) => !gone.has(o.id)), e]);
    startEditing(e.id);
  };
  /** 段落で書き換えるときの行：白塗り・墨消しの下の行と、段落の外にまたがる書き換えに入っている行は除く（範囲で選ぶときと同じ） */
  const blockRuns = (run: TextRun) => {
    const inBlock = runs.filter((r) => r.blockId === run.blockId);
    const keys = new Set(inBlock.flatMap((r) => r.removals.map((x) => pathKey(x.path ?? [], x.index))));
    const outside = new Set<string>();
    for (const o of page.objects) if (o.type === "textedit" && o.removals.some((x) => !keys.has(pathKey(x.path ?? [], x.index)))) for (const x of o.removals) outside.add(pathKey(x.path ?? [], x.index));
    return inBlock.filter((r) => r === run || (r.editable && !hiddenRun(r) && !r.removals.some((x) => outside.has(pathKey(x.path ?? [], x.index)))));
  };
  const editRun = (run: TextRun, block: boolean) => editRuns(block && run.blockId ? blockRuns(run) : [run]);

  /**
   * 範囲で囲んだ行の候補：
   * 1. 矩形に掛かる（面積の 3 割以上か中心が入る）編集できる行。縦横が混ざれば多い方
   * 2. 段組み：横の重なりで段に分け、矩形がどの段も覆い切っていなければ、矩形の中心に近い段だけにする
   * 3. 同じ段落（ブロック）の行は、選ばれた最初の行から最後の行まで間を埋める
   */
  const runsInRect = (r: { x: number; y: number; w: number; h: number }): TextRun[] => {
    const hit = runs.filter((run) => {
      if (!run.editable || coveredRun(run)) return false;
      const ox = Math.min(run.x + run.w, r.x + r.w) - Math.max(run.x, r.x);
      const oy = Math.min(run.top + run.h, r.y + r.h) - Math.max(run.top, r.y);
      if (ox <= 0 || oy <= 0) return false;
      const cx = run.x + run.w / 2;
      const cy = run.top + run.h / 2;
      return (ox * oy) / (run.w * run.h) >= 0.3 || (cx > r.x && cx < r.x + r.w && cy > r.y && cy < r.y + r.h);
    });
    const verticalCount = hit.filter((x) => x.vertical).length;
    const wanted = verticalCount > hit.length / 2;
    let picked = hit.filter((x) => !!x.vertical === wanted);
    // 段組み（横書きのみ）：横方向の重なりが小さい行どうしは別の段
    if (!wanted && picked.length > 1) {
      const cols: TextRun[][] = [];
      for (const run of picked) {
        const col = cols.find((c) => c.some((o) => Math.min(o.x + o.w, run.x + run.w) - Math.max(o.x, run.x) > 0.5 * Math.min(o.w, run.w)));
        if (col) col.push(run);
        else cols.push([run]);
      }
      if (cols.length > 1) {
        const span = (c: TextRun[]) => ({ x0: Math.min(...c.map((o) => o.x)), x1: Math.max(...c.map((o) => o.x + o.w)) });
        const coversAll = cols.every((c) => {
          const s = span(c);
          return Math.min(s.x1, r.x + r.w) - Math.max(s.x0, r.x) >= 0.8 * (s.x1 - s.x0);
        });
        if (!coversAll) {
          const rcx = r.x + r.w / 2;
          const nearest = cols.reduce((best, c) => {
            const s = span(c);
            const d = Math.abs((s.x0 + s.x1) / 2 - rcx);
            return d < best.d ? { d, c } : best;
          }, { d: Infinity, c: cols[0] });
          picked = nearest.c;
        }
      }
    }
    // 同じ段落の行は間を埋める
    const ids = new Set(picked.map((x) => x.id));
    for (const b of new Set(picked.map((x) => x.blockId).filter((x): x is string => !!x))) {
      const inBlock = picked.filter((x) => x.blockId === b);
      const lo = Math.min(...inBlock.map((x) => x.lineIndex));
      const hi = Math.max(...inBlock.map((x) => x.lineIndex));
      for (const run of runs) if (run.blockId === b && run.lineIndex > lo && run.lineIndex < hi && run.editable && !coveredRun(run)) ids.add(run.id);
    }
    return runs.filter((x) => ids.has(x.id)).sort((a, b) => (wanted ? b.x - a.x : a.top - b.top));
  };
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  /** 囲んだ後の候補（行をタップで足し引きして確定する） */
  const [pending, setPending] = useState<{ picked: Set<string>; vertical: boolean } | null>(null);
  useEffect(() => setPending(null), [tool, page.id, props.unit]);
  const togglePending = (run: TextRun) => {
    if (!pending || !run.editable || !!run.vertical !== pending.vertical) return;
    const next = new Set(pending.picked);
    if (next.has(run.id)) next.delete(run.id);
    else next.add(run.id);
    setPending({ ...pending, picked: next });
  };
  const confirmPending = () => {
    if (!pending) return;
    const group = runs.filter((r) => pending.picked.has(r.id)).sort((a, b) => (pending.vertical ? b.x - a.x : a.top - b.top));
    setPending(null);
    editRuns(group);
  };

  // 面積の計測で、頂点を足している途中の部品
  const areaDraft = useRef<string | null>(null);
  const setDraft = (id: string | null) => {
    areaDraft.current = id;
    props.onDrafting?.(!!id);
  };
  /** 面積の計測を閉じる：続けて押した同じ所の点（ダブルクリックの分）を除き、3 点に満たなければ消す */
  /** 点を順に押して作る計測（折れ線・面積）が、点が足りない（閉じると消える）。面積は 3 点、折れ線は 2 点から */
  const need = (o: MeasureObj) => (o.kind === "area" ? 3 : 2);
  const tooFew = (id: string) => {
    const o = page.objects.find((x) => x.id === id) as MeasureObj | undefined;
    return !o || o.pts.filter((p, i, all) => i === 0 || Math.hypot(p[0] - all[i - 1][0], p[1] - all[i - 1][1]) > 1).length < need(o);
  };
  const finishArea = () => {
    const id = areaDraft.current;
    if (!id) return;
    setDraft(null);
    updateObjects((objs) => {
      const o = objs.find((x) => x.id === id) as MeasureObj | undefined;
      if (!o) return objs;
      const abs = o.pts.map(([a, b]) => [o.x + a, o.y + b] as [number, number]).filter((p, i, all) => i === 0 || Math.hypot(p[0] - all[i - 1][0], p[1] - all[i - 1][1]) > 1);
      if (abs.length < need(o)) return objs.filter((x) => x.id !== id);
      return objs.map((x) => (x.id === id ? withPoints(o, abs) : x));
    }, tooFew(id) ? "cancel" : false);
    props.setSelectedId(id);
  };
  // 道具を変えたら、途中の面積の計測を閉じる
  useEffect(() => {
    if (tool !== "measure" && areaDraft.current) finishArea();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);
  // ほかのページへ移る・編集画面を離れるとき：途中の計測（点を足している途中、押したまま）を閉じる。
  // 長さや面積にならないもの（点が足りない、押しただけ）は、作った手ごと取りやめる。1 点だけのペンの線も同じ
  const leave = useRef(() => {});
  leave.current = () => {
    const d = drag.current;
    drag.current = null;
    const draftId = areaDraft.current;
    if (draftId) setDraft(null);
    const distinct = (o: MeasureObj) => o.pts.filter((p, i, all) => i === 0 || Math.hypot(p[0] - all[i - 1][0], p[1] - all[i - 1][1]) > 1);
    const drop = new Set<string>();
    for (const o of page.objects) {
      if (o.type === "measure" && (distinct(o).length < need(o) || (d?.kind === "measure" && d.id === o.id && Math.hypot(o.w, o.h) * zoom < 4))) drop.add(o.id);
      if (o.type === "ink" && d?.kind === "ink" && d.id === o.id && d.points.length < 2) drop.add(o.id);
    }
    const draft = draftId && !drop.has(draftId) ? (page.objects.find((o) => o.id === draftId) as MeasureObj | undefined) : undefined;
    const tidy = !!draft && distinct(draft).length !== draft.pts.length;
    if (!drop.size && !tidy) return;
    const started = (draftId && drop.has(draftId)) || (d && (d.kind === "measure" || d.kind === "ink") && drop.has(d.id));
    props.updateObjects(
      (objs) =>
        objs
          .filter((o) => !drop.has(o.id))
          .map((o) => (draft && o.id === draft.id && o.type === "measure" ? withPoints(o, distinct(o).map(([a, b]) => [o.x + a, o.y + b] as [number, number])) : o)),
      started ? "cancel" : false,
    );
  };
  useEffect(() => () => leave.current(), []);

  /** 新しい入力欄の名前（このページで使っていない「入力欄1」「入力欄2」…） */
  const nextFieldName = () => {
    const used = new Set(page.objects.filter((o): o is FieldObj => o.type === "field").map((o) => o.name));
    let n = used.size + 1;
    while (used.has(t("field.defaultName", { n }))) n++;
    return t("field.defaultName", { n });
  };
  const makeShape = (kind: Tool, x: number, y: number, w: number, h: number): EditObj => {
    if (kind === "highlight" || kind === "underline" || kind === "strikeout") {
      const m: MarkupObj = { id: uid(), type: "markup", kind, x, y, w, h, color: DEFAULTS.markup[kind], opacity: kind === "highlight" ? 0.5 : 1, contents: "" };
      return m;
    }
    if (kind === "line") {
      return { id: uid(), type: "line", x, y, dx: w, dy: h, stroke: DEFAULTS.shape.stroke, strokeWidth: DEFAULTS.shape.strokeWidth, opacity: 1 };
    }
    if (kind === "whiteout") {
      return { id: uid(), type: "whiteout", x, y, w, h, stroke: null, fill: DEFAULTS.whiteout.fill, strokeWidth: 0, opacity: 1 };
    }
    if (kind === "redact") {
      const r: RedactObj = { id: uid(), type: "redact", x, y, w, h, fill: "#000000" };
      return r;
    }
    if (kind === "field") {
      const f: FieldObj = { id: uid(), type: "field", kind: "text", name: nextFieldName(), x, y, w, h, options: [] };
      return f;
    }
    if (kind === "link") {
      const l: LinkObj = { id: uid(), type: "link", x, y, w, h, target: { kind: "url", url: "" } };
      return l;
    }
    return { id: uid(), type: kind === "ellipse" ? "ellipse" : "rect", x, y, w, h, ...DEFAULTS.shape };
  };

  // 指のタップで働く道具（文字・付箋・スタンプ・既存文字の行・既存画像）は、押したときではなく、指を離したときに働かせる。
  // 押した時点で置くと、ページを送ろうとしてなぞっただけ・2 本指で拡大しようとしただけでも、文字や付箋が置かれてしまう。
  // 動かさずに離したとき（タップ）だけ働かせ、スクロールになった・2 本目の指が触れたときは何もしない
  const tapStart = useRef<{ id: number; x: number; y: number; target: Element; shiftKey: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent, deferred = false) => {
    if (e.button !== 0) return;
    const target = e.target as Element;
    if (target.closest("[contenteditable]")) return;
    if (!deferred && trackPointer(e)) return;
    const pt = toPage(e);
    // スポイト：色を拾うのを待っているときは、タップした場所のページの色を返すだけ（ほかの操作はしない）
    if (colorPick.active()) {
      e.preventDefault();
      const canvas = canvasRef.current;
      const ctx = canvas && canvas.width > 1 ? canvas.getContext("2d", { willReadFrequently: true }) : null;
      if (canvas && ctx) {
        const k = canvas.width / W;
        const x = Math.min(canvas.width - 1, Math.max(0, Math.round(pt[0] * k)));
        const y = Math.min(canvas.height - 1, Math.max(0, Math.round(pt[1] * k)));
        // 1 画素だと文字の縁のにじみを拾いやすいので、周り 3×3 の中でいちばん多い色にする
        const d = ctx.getImageData(Math.max(0, x - 1), Math.max(0, y - 1), 3, 3).data;
        const count = new Map<string, number>();
        for (let i = 0; i < d.length; i += 4) {
          const hex = `#${[d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
          count.set(hex, (count.get(hex) ?? 0) + 1);
        }
        colorPick.deliver([...count].sort((a, b) => b[1] - a[1])[0][0]);
      } else colorPick.cancel();
      return;
    }
    const handle = target.closest("[data-handle]")?.getAttribute("data-handle") ?? null;
    const objId = target.closest("[data-obj]")?.getAttribute("data-obj") ?? null;
    const runId = target.closest("[data-run]")?.getAttribute("data-run") ?? null;
    const obj = objId ? page.objects.find((o) => o.id === objId) : undefined;
    const vertex = !!handle?.startsWith("v") && obj?.type === "measure" && !areaDraft.current;
    const tapOnly = tool === "text" || tool === "note" || tool === "stamp" || tool === "image-edit" || (tool === "edit-text" && !objId && !handle && props.unit !== "range");
    if (e.pointerType === "touch" && tapOnly && !vertex && !deferred) {
      e.preventDefault();
      (document.activeElement as HTMLElement | null)?.blur?.();
      tapStart.current = { id: e.pointerId, x: e.clientX, y: e.clientY, target, shiftKey: e.shiftKey };
      return;
    }
    // 指：この操作でしたことを、2 本目の指が触れたら取りやめられるように、始める前の状態を覚えておく
    gesture.current = e.pointerType === "touch" && !deferred ? { objects: page.objects, selected: selectedId, editing: editingId, tool, draft: areaDraft.current, touched: false, recorded: false, time: performance.now() } : null;
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur?.();

    if (handle?.startsWith("v") && obj?.type === "measure" && !areaDraft.current) {
      drag.current = { kind: "resize", id: obj.id, handle, start: pt, orig: obj, moved: false };
      capture(e);
      return;
    }
    if (tool === "text") {
      if (obj?.type === "text") startEditing(obj.id);
      else addText(pt[0], pt[1] - (DEFAULTS.text.fontSize * LINE_HEIGHT) / 2);
      return;
    }
    if (tool === "edit-text" && !objId && !handle) {
      const run = runId ? runs.find((r) => r.id === runId) : undefined;
      // マウス、または「範囲」モード：ドラッグで囲んだ行をまとめる（動かさずに離せば従来のクリック）
      if (props.unit === "range" || e.pointerType === "mouse") {
        drag.current = { kind: "marquee", start: pt, runId: run?.id ?? null, moved: false };
        capture(e);
        return;
      }
      if (run) {
        if (pending) togglePending(run);
        else if (run.editable) editRun(run, props.unit === "block" || e.shiftKey);
        else replaceRun(run); // 実編集できない行は従来どおり上書き
      }
      return;
    }
    if (tool === "image-edit") {
      const imgId = target.closest("[data-img]")?.getAttribute("data-img") ?? null;
      const im = imgId ? pageImages?.find((x) => x.id === imgId) : undefined;
      if (im) {
        const o: ImageEditObj = { id: uid(), type: "imageedit", opIndex: im.opIndex, path: im.path, name: im.name, x: im.x, y: im.top, w: im.w, h: im.h };
        updateObjects((objs) => [...objs, o]);
        props.setSelectedId(o.id);
      } else if (obj) props.setSelectedId(obj.id);
      else props.setSelectedId(null);
      return;
    }
    if (tool === "note") {
      const n: NoteObj = { id: uid(), type: "note", x: pt[0] - NOTE_SIZE / 2, y: pt[1] - NOTE_SIZE / 2, color: DEFAULTS.note.color, contents: "", author: "" };
      updateObjects((objs) => [...objs, n]);
      props.setSelectedId(n.id);
      props.setTool("select");
      return;
    }
    if (tool === "measure") {
      const base: MeasureObj = { id: uid(), type: "measure", kind: DEFAULTS.measure.kind === "area" ? "area" : "distance", pts: [], x: 0, y: 0, w: 0, h: 0, scale: DEFAULTS.measure.scale, unit: DEFAULTS.measure.unit, color: DEFAULTS.measure.color };
      if (DEFAULTS.measure.kind === "area" || DEFAULTS.measure.kind === "path") {
        // 面積・折れ線：押すたびに点を足す。面積は最初の点を押すと閉じる。折れ線は最後の点をもう一度押すと終わる。
        // どちらもダブルクリック・Enter でも終わる
        const draft = areaDraft.current ? (page.objects.find((o) => o.id === areaDraft.current) as MeasureObj | undefined) : undefined;
        if (draft) {
          const abs = draft.pts.map(([a, b]) => [draft.x + a, draft.y + b] as [number, number]);
          // 閉じる・終える点の当たり：指では広めに取る（14px では、狙って押してもよく外れる）
          const reach = e.pointerType === "touch" ? 22 : 14;
          const near = (q: [number, number]) => Math.hypot(pt[0] - q[0], pt[1] - q[1]) * zoom < reach;
          if ((draft.kind === "area" && abs.length >= 3 && near(abs[0])) || (draft.kind === "distance" && abs.length >= 2 && near(abs[abs.length - 1]))) {
            finishArea();
            return;
          }
          setObj(draft.id, (o) => withPoints(o as MeasureObj, [...abs, pt]));
        } else {
          const m = withPoints(base, [pt]);
          updateObjects((objs) => [...objs, m]);
          setDraft(m.id);
          props.setSelectedId(m.id);
        }
        return;
      }
      // 距離：ドラッグした 2 点の間
      const m = withPoints(base, [pt, pt]);
      updateObjects((objs) => [...objs, m]);
      drag.current = { kind: "measure", id: m.id, start: pt };
      capture(e);
      return;
    }
    if (tool === "stamp") {
      const w = DEFAULTS.stamp.fontSize * 4;
      const h = DEFAULTS.stamp.fontSize * 1.8;
      const s: StampObj = { id: uid(), type: "stamp", x: pt[0] - w / 2, y: pt[1] - h / 2, w, h, text: DEFAULTS.stamp.text || t("stamp.p.approved"), color: DEFAULTS.stamp.color, font: defaultFont("sans"), fontSize: DEFAULTS.stamp.fontSize, rotation: -8, opacity: 0.9, frame: DEFAULTS.stamp.frame, double: DEFAULTS.stamp.double };
      updateObjects((objs) => [...objs, s]);
      props.setSelectedId(s.id);
      props.setTool("select");
      return;
    }
    if (tool === "ink") {
      const ink: InkObj = { id: uid(), type: "ink", x: pt[0], y: pt[1], w: 0, h: 0, paths: [[[0, 0]]], ...DEFAULTS.ink };
      updateObjects((objs) => [...objs, ink]);
      drag.current = { kind: "ink", id: ink.id, points: [pt] };
      capture(e);
      return;
    }
    if (DRAG_TOOLS.has(tool)) {
      drag.current = { kind: "create", tool, start: pt, id: null };
      capture(e);
      return;
    }
    // select（および edit-text で既存オブジェクトを触った場合）
    if (handle === "rot" && obj?.type === "text") {
      drag.current = { kind: "rotate", id: obj.id, start: pt, startAngle: Math.atan2(pt[1] - obj.y, pt[0] - obj.x), orig: obj, moved: false };
      capture(e);
      return;
    }
    if (handle && objId) {
      const o = page.objects.find((x) => x.id === objId)!;
      const el = target.closest("[data-obj]") as HTMLElement | null;
      drag.current = {
        kind: "resize",
        id: objId,
        handle,
        start: pt,
        orig: o,
        moved: false,
        textH: el ? el.offsetHeight : undefined,
      };
      capture(e);
      return;
    }
    if (obj?.type === "textedit") {
      // 実編集は位置が元の文字に固定なので動かさない。クリックで選択、もう一度クリックで編集
      if (selectedId === obj.id) startEditing(obj.id);
      else props.setSelectedId(obj.id);
      return;
    }
    if (obj?.type === "imageedit") {
      // 元画像の位置に固定。クリックで選択のみ
      props.setSelectedId(obj.id);
      return;
    }
    if (obj) {
      const wasSelected = selectedId === obj.id;
      props.setSelectedId(obj.id);
      // 承認欄を動かすときは、欄の中に入れたサインや印鑑も一緒に動かす
      const riders = isApproval(obj) ? insideApproval(obj, page.objects) : [];
      drag.current = { kind: "move", id: obj.id, start: pt, orig: obj, moved: false, wasSelected, riders };
      capture(e);
      return;
    }
    props.setSelectedId(null);
    props.setEditingId(null);
    // タッチで何もない所をなぞったときのスクロールは、ブラウザに任せる（.page の touch-action）
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (e.pointerType === "touch" && pointers.current.has(e.pointerId)) {
      pointers.current.set(e.pointerId, [e.clientX, e.clientY]);
      if (pointers.current.size >= 2) return;
    }
    const d = drag.current;
    if (!d) return;
    if (d.kind === "measure") {
      let pt = toPage(e);
      // Shift で 45 度ごとにそろえる
      if (e.shiftKey) {
        const [sx, sy] = snap45(pt[0] - d.start[0], pt[1] - d.start[1]);
        pt = [d.start[0] + sx, d.start[1] + sy];
      }
      setObj(d.id, (o) => withPoints(o as MeasureObj, [d.start, pt]));
      return;
    }
    if (d.kind === "ink") {
      const pt = toPage(e);
      const last = d.points[d.points.length - 1];
      if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) * zoom < 1.5) return;
      d.points.push(pt);
      const xs = d.points.map((p) => p[0]);
      const ys = d.points.map((p) => p[1]);
      const x0 = Math.min(...xs);
      const y0 = Math.min(...ys);
      const pts = d.points;
      setObj(d.id, (o) => ({ ...(o as InkObj), x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0, paths: [pts.map(([px, py]) => [px - x0, py - y0] as [number, number])] }));
      return;
    }
    if (d.kind === "pan") {
      const stage = pageRef.current?.closest(".stage");
      if (stage) {
        stage.scrollLeft -= e.clientX - d.lastX;
        stage.scrollTop -= e.clientY - d.lastY;
      }
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      return;
    }
    const pt = toPage(e);
    const dx = pt[0] - d.start[0];
    const dy = pt[1] - d.start[1];
    const far = Math.hypot(dx, dy) * zoom > 3;

    if (d.kind === "marquee") {
      if (!d.moved && !far) return;
      d.moved = true;
      setMarquee({ x: Math.min(d.start[0], pt[0]), y: Math.min(d.start[1], pt[1]), w: Math.abs(dx), h: Math.abs(dy) });
      return;
    }
    if (d.kind === "move") {
      if (!d.moved) {
        if (!far) return;
        d.moved = true;
        checkpoint();
      }
      if (d.riders.length) {
        const moved = new Map<string, EditObj>([[d.id, { ...d.orig, x: d.orig.x + dx, y: d.orig.y + dy } as EditObj]]);
        for (const r of d.riders) moved.set(r.id, { ...r, x: r.x + dx, y: r.y + dy } as EditObj);
        updateObjects((objs) => objs.map((o) => moved.get(o.id) ?? o), false);
      } else setObj(d.id, () => ({ ...d.orig, x: d.orig.x + dx, y: d.orig.y + dy }));
      return;
    }
    if (d.kind === "create") {
      if (!d.id) {
        if (!far) return;
        const o = makeShape(d.tool, d.start[0], d.start[1], 1, 1);
        d.id = o.id;
        updateObjects((objs) => [...objs, o]);
        // 選ぶのは、離したとき（引いている途中で選ぶと、スマホでは設定のパネルが開いて表示領域が縮み、引いている形がずれる）
      }
      const id = d.id;
      if (d.tool === "line") {
        const [ex, ey] = e.shiftKey ? snap45(dx, dy) : [dx, dy];
        setObj(id, (o) => ({ ...(o as LineObj), dx: ex, dy: ey }));
      } else {
        let w = dx;
        let h = dy;
        if (e.shiftKey) {
          const s = Math.max(Math.abs(w), Math.abs(h));
          w = Math.sign(w || 1) * s;
          h = Math.sign(h || 1) * s;
        }
        setObj(id, (o) => ({
          ...(o as ShapeObj),
          x: Math.min(d.start[0], d.start[0] + w),
          y: Math.min(d.start[1], d.start[1] + h),
          w: Math.abs(w),
          h: Math.abs(h),
        }));
      }
      return;
    }
    if (d.kind === "rotate") {
      if (!d.moved) {
        d.moved = true;
        checkpoint();
      }
      const a = Math.atan2(pt[1] - d.orig.y, pt[0] - d.orig.x);
      let deg = (d.orig.rotation ?? 0) + ((a - d.startAngle) * 180) / Math.PI;
      // Shift で 15° 単位、それ以外も 0/90/180/270° の近くでは吸着
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      else {
        const near = Math.round(deg / 90) * 90;
        if (Math.abs(deg - near) < 3) deg = near;
        else deg = Math.round(deg);
      }
      setObj(d.id, () => ({ ...d.orig, rotation: normAngle(deg) }));
      return;
    }
    // resize
    if (!d.moved) {
      if (!far) return;
      d.moved = true;
      checkpoint();
    }
    const o = d.orig;
    if (o.type === "measure" && d.handle.startsWith("v")) {
      // 計測の点を動かす（Shift で、隣の点から 45 度ごとにそろえる）
      const i = Number(d.handle.slice(1));
      const abs = o.pts.map(([a, b]) => [o.x + a, o.y + b] as [number, number]);
      let q: [number, number] = pt;
      const prev = abs[i - 1] ?? abs[i + 1];
      if (e.shiftKey && prev) {
        const [sx, sy] = snap45(pt[0] - prev[0], pt[1] - prev[1]);
        q = [prev[0] + sx, prev[1] + sy];
      }
      abs[i] = q;
      setObj(d.id, () => withPoints(o, abs));
      return;
    }
    if (o.type === "line") {
      if (d.handle === "p1") {
        const endX = o.x + o.dx;
        const endY = o.y + o.dy;
        setObj(d.id, () => ({ ...o, x: pt[0], y: pt[1], dx: endX - pt[0], dy: endY - pt[1] }));
      } else {
        const [ex, ey] = e.shiftKey ? snap45(pt[0] - o.x, pt[1] - o.y) : [pt[0] - o.x, pt[1] - o.y];
        setObj(d.id, () => ({ ...o, dx: ex, dy: ey }));
      }
      return;
    }
    if (o.type === "text") {
      const h0 = (d.textH ?? o.fontSize * LINE_HEIGHT * zoom) / zoom;
      // 回転している場合は文字の縦方向に沿った移動量で拡大縮小する
      const t = ((o.rotation ?? 0) * Math.PI) / 180;
      const ly = -dx * Math.sin(t) + dy * Math.cos(t);
      const k = Math.max(0.1, (h0 + ly) / h0);
      setObj(d.id, () => ({ ...o, fontSize: Math.max(4, Math.round(o.fontSize * k * 10) / 10) }));
      return;
    }
    if (o.type === "note" || o.type === "ink" || o.type === "measure" || o.type === "textedit" || o.type === "imageedit") return;
    let x1 = o.x;
    let y1 = o.y;
    let x2 = o.x + o.w;
    let y2 = o.y + o.h;
    if (d.handle.includes("w")) x1 = pt[0];
    if (d.handle.includes("e")) x2 = pt[0];
    if (d.handle.includes("n")) y1 = pt[1];
    if (d.handle.includes("s")) y2 = pt[1];
    if (o.type === "image" || e.shiftKey) {
      const s = Math.max(Math.abs(x2 - x1) / o.w, Math.abs(y2 - y1) / o.h);
      const nw = o.w * s;
      const nh = o.h * s;
      if (d.handle.includes("w")) x1 = x2 - nw;
      else x2 = x1 + nw;
      if (d.handle.includes("n")) y1 = y2 - nh;
      else y2 = y1 + nh;
    }
    setObj(d.id, () => ({
      ...o,
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      w: Math.max(2, Math.abs(x2 - x1)),
      h: Math.max(2, Math.abs(y2 - y1)),
    }));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    releasePointer(e);
    gesture.current = null;
    // 指のタップ：動かさずに離したときに、押した場所で道具を働かせる
    const tap = tapStart.current;
    tapStart.current = null;
    if (tap && tap.id === e.pointerId && e.type !== "pointercancel" && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 12 && pageRef.current?.contains(tap.target)) {
      onPointerDown({ button: 0, isPrimary: true, pointerId: tap.id, pointerType: "touch", clientX: tap.x, clientY: tap.y, shiftKey: tap.shiftKey, target: tap.target, preventDefault() {} } as unknown as React.PointerEvent, true);
    }
    const d = drag.current;
    drag.current = null;
    if (!d || d.kind === "pan") return;
    try {
      pageRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    if (d.kind === "marquee") {
      const rect = marquee;
      setMarquee(null);
      if (d.moved && rect) {
        const hits = runsInRect(rect);
        if (hits.length) setPending({ picked: new Set(hits.map((r) => r.id)), vertical: !!hits[0].vertical });
        return;
      }
      const run = d.runId ? runs.find((r) => r.id === d.runId) : undefined;
      if (run) {
        if (pending) togglePending(run);
        else if (run.editable) editRun(run, props.unit === "block" || e.shiftKey);
        else replaceRun(run);
      }
      return;
    }
    if (d.kind === "measure") {
      // ほとんど動かさなかったら（押しただけ）作らない
      const m = page.objects.find((o) => o.id === d.id) as MeasureObj | undefined;
      if (!m || Math.hypot(m.w, m.h) * zoom < 4) updateObjects((objs) => objs.filter((o) => o.id !== d.id), "cancel");
      else props.setSelectedId(d.id);
      return;
    }
    if (d.kind === "ink") {
      if (d.points.length < 2) updateObjects((objs) => objs.filter((o) => o.id !== d.id), "cancel");
      else props.setSelectedId(d.id);
      // ペンは続けて描けるようにツールを維持する
      return;
    }
    if (d.kind === "create") {
      if (d.id) props.setSelectedId(d.id);
      if (!d.id) {
        // クリックだけなら既定サイズで配置
        const [x, y] = d.start;
        const o = d.tool === "line" ? makeShape("line", x, y, 120, 0) : d.tool === "field" ? makeShape("field", x, y, 160, 22) : makeShape(d.tool, x, y, d.tool === "whiteout" || MARKUP_TOOLS.has(d.tool) ? 100 : 120, d.tool === "whiteout" || MARKUP_TOOLS.has(d.tool) ? 16 : 80);
        updateObjects((objs) => [...objs, o]);
        props.setSelectedId(o.id);
      }
      props.setTool("select");
      return;
    }
    // サインや印鑑を承認欄の押印欄に置いたら、欄に合わせて大きさと位置を整える
    // （このアプリで置いた承認欄のほか、ページに罫線で描かれた枠＝保存して開き直した承認欄や、ほかのソフトで作った押印欄にも合わせる）
    if (d.kind === "move" && d.moved && (d.orig.type === "image" || (d.orig.type === "stamp" && !isApproval(d.orig)))) {
      const moved = page.objects.find((o) => o.id === d.id);
      const fitted = moved ? fitIntoCell(moved, page.objects) : null;
      if (fitted) setObj(d.id, () => fitted);
      else if (moved && source && page.srcId) {
        const cx = moved.x + (moved as { w: number }).w / 2;
        const cy = moved.y + (moved as { h: number }).h / 2;
        void analyzePage(source, page.srcIndex).then((a) => {
          const vt = page.viewTransform;
          const rules = a.rules.map(([x1, y1, x2, y2]) => [...apply(vt, x1, y1), ...apply(vt, x2, y2)] as [number, number, number, number]);
          const cell = cellFromRules(rules, cx, cy);
          if (!cell) return;
          // 調べている間に動かしていたら合わせない
          setObj(d.id, (o) => (Math.abs(o.x - moved.x) < 0.01 && Math.abs(o.y - moved.y) < 0.01 ? (fitToRect(o, cell) ?? o) : o));
        });
      }
    }
    if (d.kind === "move" && !d.moved && d.wasSelected && d.orig.type === "text") {
      startEditing(d.id);
    }
  };

  // テキスト編集の確定
  const finishEditing = (id: string, text: string) => {
    props.setEditingId(null);
    const obj = page.objects.find((o) => o.id === id);
    if (obj?.type === "textedit") {
      // ここでは捨てない（パネルのタブや欄へフォーカスが移っただけのことがある）。
      // 未変更の新規書き換えは、選択が外れたときに捨てる（下の effect）
      return;
    }
    // 置いたばかりで何も書かなかった文字は、置いた手ごと取りやめる（「元に戻す」に、何も変わらない 1 手を残さない）
    const unused = fresh.current.delete(id);
    if (!text.trim()) {
      updateObjects((objs) => objs.filter((o) => o.id !== id), unused ? "cancel" : false);
      props.setSelectedId(null);
    }
  };

  // 未変更のまま選択が外れた新規の書き換えは捨てる（元の文字と同じ内容で書き直すだけになるため）
  const prevSelected = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevSelected.current;
    prevSelected.current = selectedId;
    if (!prev || prev === selectedId || !fresh.current.has(prev)) return;
    const o = page.objects.find((x) => x.id === prev);
    if (o?.type !== "textedit") return;
    fresh.current.delete(prev);
    // 開いた手ごと取りやめる（「元に戻す」に、何も変わらない 1 手を残さない）
    if (o.text === o.original) updateObjects((objs) => objs.filter((x) => x.id !== prev), "cancel");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // キーボード操作
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      // ダイアログを開いている間は、後ろのページの部品を動かさない・消さない
      if (document.querySelector(".modal-back")) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const sel = selectedId ? page.objects.find((o) => o.id === selectedId) : undefined;
      if (sel && (e.key === "Delete" || e.key === "Backspace")) {
        e.preventDefault();
        updateObjects((objs) => objs.filter((o) => o.id !== sel.id));
        props.setSelectedId(null);
      } else if (sel && sel.type !== "textedit" && e.key.startsWith("Arrow")) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const [dx, dy] = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key] ?? [0, 0];
        setObj(sel.id, (o) => ({ ...o, x: o.x + dx, y: o.y + dy }), true);
      } else if (pending && e.key === "Enter") {
        e.preventDefault();
        confirmPending();
      } else if (pending && e.key === "Escape") {
        setPending(null);
      } else if ((sel?.type === "text" || sel?.type === "textedit") && e.key === "Enter") {
        e.preventDefault();
        startEditing(sel.id);
      } else if (areaDraft.current && (e.key === "Enter" || e.key === "Escape")) {
        e.preventDefault();
        finishArea();
      } else if (e.key === "Escape") {
        props.setSelectedId(null);
        props.setTool("select");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const editedOps = new Set<string>();
  for (const o of page.objects) if (o.type === "textedit") for (const r of o.removals) editedOps.add(pathKey(r.path ?? [], r.index));
  /** 白塗り・墨消しの下にある行 */
  const hiddenRun = (r: TextRun) =>
    page.objects.some(
      (o) =>
        (o.type === "whiteout" || o.type === "redact") &&
        r.x + r.w / 2 > o.x &&
        r.x + r.w / 2 < o.x + o.w &&
        r.top + r.h / 2 > o.y &&
        r.top + r.h / 2 < o.y + o.h,
    );
  const coveredRun = (r: TextRun) => r.removals.some((x) => editedOps.has(pathKey(x.path ?? [], x.index))) || hiddenRun(r);
  const hoverBlock = props.unit === "block";

  // 見るだけのページを押して、このページが編集するページになったとき：押した操作をここで引き継ぐ。
  // （親が選択を解く処理のあとに行うため、置いた直後ではなく次の描き直しで行う。既存文字は、行の解析が済むのを待つ）
  const [handoffTurn, setHandoffTurn] = useState(0);
  useEffect(() => {
    if (handoff?.pageId === page.id) setHandoffTurn(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const h = handoff;
    if (!handoffTurn || !h || h.pageId !== page.id) return;
    if (tool === "edit-text" && source && runsLoading) return;
    handoff = null;
    h.stop();
    const el = pageRef.current;
    // 時間が経ちすぎたときは引き継がない
    if (!el || performance.now() - h.time > 4000) return;
    // 押した位置を、ページの中の位置で指し直す（画面上の位置は、切り替えで動いている）
    const r = el.getBoundingClientRect();
    const at = (i: PointerInfo) => ({ ...i, clientX: r.left + i.dx, clientY: r.top + i.dy });
    const down = at(h.down);
    // 押した所にある部品（置いた文字や図形など）。パネルに隠れているなどでページの外に当たるときは、ページそのもの
    const under = document.elementFromPoint(down.clientX, down.clientY);
    const hit = under && el.contains(under) ? under : el;
    const fake = (i: PointerInfo) => ({ ...at(i), button: 0, isPrimary: true, target: hit, preventDefault() {} }) as unknown as React.PointerEvent;
    // 指でなぞり始めた操作を引き継ぐとき：このあと指を離したときのクリックが、開いたパネルに届かないようにする
    if (h.down.pointerType === "touch" && !h.up) guardGhostClick(el);
    onPointerDown(fake(h.down));
    if (h.up) onPointerUp(fake(h.up));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoffTurn, runsLoading]);

  const cursor = tool === "text" ? "text" : tool === "select" || tool === "edit-text" || tool === "image-edit" ? "default" : tool === "note" || tool === "stamp" ? "copy" : "crosshair";

  return (
    <div className="page-outer" style={{ width: outerW, height: outerH }}>
      <div
        ref={pageRef}
        className={`page tool-${tool} ${tool === "edit-text" && props.unit === "range" ? "unit-range" : ""}`}
        style={{
          width: W * zoom,
          height: H * zoom,
          transform: `translate(-50%, -50%) rotate(${rot}deg)`,
          cursor,
        }}
        onPointerDown={(e) => {
          if (e.pointerType === "touch" && e.isPrimary && pageRef.current) guardGhostClick(pageRef.current);
          onPointerDown(e);
        }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={(e) => {
          if (areaDraft.current) {
            finishArea();
            return;
          }
          const id = (e.target as Element).closest("[data-obj]")?.getAttribute("data-obj");
          const o = id ? page.objects.find((x) => x.id === id) : undefined;
          if (o?.type === "text" || o?.type === "textedit") startEditing(o.id);
        }}
      >
        <canvas ref={canvasRef} className="page-canvas" />
        {rendering && <div className="page-loading">{t("app.loading")}</div>}

        {page.objects.map((o) => (
          <ObjectView
            key={o.id}
            obj={o}
            zoom={zoom}
            images={images}
            source={source}
            srcIndex={page.srcIndex}
            page={page}
            selected={o.id === selectedId}
            editing={o.id === editingId}
            onEditStart={() => {
              if (!fresh.current.has(o.id)) checkpoint();
            }}
            onText={(text) => setObj(o.id, (x) => withFittingFont(x as TextObj, text))}
            onEditEnd={(text) => finishEditing(o.id, text)}
          />
        ))}

        {tool === "edit-text" &&
          runs
            .filter((r) => !coveredRun(r))
            .map((r) => (
              <div
                key={r.id}
                data-run={r.id}
                data-block={r.blockId ?? undefined}
                className={`run-box ${r.editable ? "" : "noedit"} ${hoverBlock && r.blockId ? "in-block" : ""} ${pending ? (pending.picked.has(r.id) ? "picked" : "dim") : ""}`}
                title={r.editable ? t("page.editHint", { text: r.text }) : t("page.overlayHint", { reason: r.reason ?? "", text: r.text })}
                style={{ left: r.x * zoom - 1, top: r.top * zoom - 1, width: r.w * zoom + 2, height: r.h * zoom + 2 }}
              />
            ))}
        {marquee && <div className="marquee" style={{ left: marquee.x * zoom, top: marquee.y * zoom, width: marquee.w * zoom, height: marquee.h * zoom }} />}
        {pending && tool === "edit-text" && (() => {
          const picked = runs.filter((r) => pending.picked.has(r.id));
          const top = picked.length ? Math.min(...picked.map((r) => r.top)) : 0;
          const left = picked.length ? Math.min(...picked.map((r) => r.x)) : 0;
          // 操作のバーは、ページの中ではなく表示領域の上の帯に出す（ページの中に置くと、小さいページや回したページでは端で切れて押せない）
          const slot = pageRef.current?.closest(".workspace")?.querySelector(".range-slot");
          if (!slot) return null;
          return createPortal(
            // （画面上はページの外でも、React の上ではページの子なので、押した知らせがページの操作に伝わらないよう止める）
            <div className="range-bar" role="group" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
              <span className="range-hint">{t("range.hint", { n: picked.length })}</span>
              <button className="btn primary small" disabled={!picked.length} onClick={confirmPending}>
                {t("range.confirm")}
              </button>
              <button className="btn ghost small" onClick={() => setPending(null)}>
                {t("range.cancel")}
              </button>
            </div>,
            slot,
          );
        })()}
        {tool === "edit-text" && (runsLoading || pageError) && (
          <div className="page-notice">{runsLoading ? t("page.analyzing") : pageError}</div>
        )}
        {tool === "image-edit" &&
          pageImages
            ?.filter((im) => !page.objects.some((o) => o.type === "imageedit" && o.opIndex === im.opIndex && samePath(o.path, im.path)))
            .map((im) => (
              <div
                key={im.id}
                data-img={im.id}
                className="img-box"
                title={t("page.imageHint", { w: im.pixelW, h: im.pixelH })}
                style={{ left: im.x * zoom - 1, top: im.top * zoom - 1, width: im.w * zoom + 2, height: im.h * zoom + 2 }}
              />
            ))}
        {tool === "image-edit" && source && pageImages && !pageImages.length && <div className="page-notice">{t("page.noImages")}</div>}
      </div>
    </div>
  );
}

/** ページの絵を canvas に描く（ズームを変えたときは少し待ってから高解像度で描き直す）。enabled が false のあいだは描かない */
function usePageCanvas(canvasRef: React.RefObject<HTMLCanvasElement | null>, source: SourceDoc | undefined, page: PageItem, zoom: number, enabled: boolean, setRendering: (v: boolean) => void) {
  const W = page.width;
  const H = page.height;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !enabled) return;
    const signal = { cancelled: false };
    const dpr = window.devicePixelRatio || 1;
    const t = setTimeout(async () => {
      if (!source) {
        // 白紙のページも、canvas の上限に収める
        const k = fitScale(W, H, zoom * dpr);
        canvas.width = Math.ceil(W * k);
        canvas.height = Math.ceil(H * k);
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        setRendering(false);
        return;
      }
      try {
        await renderToCanvas(canvas, source, page.srcIndex, Math.min(zoom * dpr, 6), page.baseRotation, signal);
      } finally {
        if (!signal.cancelled) setRendering(false);
      }
    }, 80);
    return () => {
      signal.cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, page.srcIndex, page.baseRotation, zoom, W, H, enabled]);
}

const noop = () => {};

/**
 * 連続表示で、いま編集していないページ（見るだけ）。画面の近くにあるときだけ絵と書き込んだものを描く。
 * 押すと、そのページが編集するページになる
 */
export function PageView({ page, source, images, zoom, near, draws, onActivate }: { page: PageItem; source?: SourceDoc; images: Map<string, StoredImage>; zoom: number; near: boolean; /** いまの道具は、指 1 本でなぞると描く（スクロールにならない） */ draws: boolean; onActivate: () => void }) {
  const W = page.width;
  const H = page.height;
  const rot = page.extraRotation;
  const swap = rot % 180 !== 0;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [, setRendering] = useState(true);
  usePageCanvas(canvasRef, source, page, zoom, near, setRendering);
  // 指で軽く押したとき（なぞればスクロールになる道具）：押した位置を覚えておき、タップと分かってから（click）切り替えて引き継ぐ
  const tapDown = useRef<PointerInfo | null>(null);
  return (
    <div className="page-outer" style={{ width: (swap ? H : W) * zoom, height: (swap ? W : H) * zoom }}>
      <div
        className={`page-view ${draws ? "draws" : ""}`}
        style={{ width: W * zoom, height: H * zoom, transform: `translate(-50%, -50%) rotate(${rot}deg)` }}
        onPointerDown={(e) => {
          if (e.button !== 0 || !e.isPrimary) return;
          if (e.pointerType === "touch" && !draws) {
            tapDown.current = pointerInfo(e, e.currentTarget);
            return;
          }
          // マウス・ペン、または指で描く道具：押した時点でこのページに切り替え、押した操作（ドラッグを含む）を引き継ぐ
          tapDown.current = null;
          beginHandoff(page.id, pointerInfo(e, e.currentTarget), null);
          onActivate();
        }}
        onClick={(e) => {
          const down = tapDown.current;
          tapDown.current = null;
          // 指で押してすぐ離したときだけ（古い記録を、あとのマウスのクリックで使わない）
          if (down && performance.now() - down.time < 1500)
            beginHandoff(page.id, down, { ...down, clientX: e.clientX, clientY: e.clientY, dx: down.dx + e.clientX - down.clientX, dy: down.dy + e.clientY - down.clientY });
          onActivate();
        }}
        data-page-view={page.id}
      >
        {near && <canvas ref={canvasRef} className="page-view-canvas" />}
        {near &&
          page.objects.map((o) => (
            <ObjectView key={o.id} obj={o} zoom={zoom} images={images} source={source} srcIndex={page.srcIndex} page={page} selected={false} editing={false} onEditStart={noop} onText={noop} onEditEnd={noop} />
          ))}
      </div>
    </div>
  );
}

function snap45(dx: number, dy: number): [number, number] {
  const len = Math.hypot(dx, dy);
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return [Math.cos(a) * len, Math.sin(a) * len];
}

function ObjectView({
  obj,
  zoom,
  images,
  source,
  srcIndex,
  page,
  selected,
  editing,
  onEditStart,
  onText,
  onEditEnd,
}: {
  obj: EditObj;
  zoom: number;
  images: Map<string, StoredImage>;
  source?: SourceDoc;
  srcIndex: number;
  page?: PageItem;
  selected: boolean;
  editing: boolean;
  onEditStart: () => void;
  onText: (t: string) => void;
  onEditEnd: (t: string) => void;
}) {
  const z = zoom;
  const t = useT();
  const cls = `obj obj-${obj.type} ${selected ? "selected" : ""}`;
  const font = obj.type === "text" ? obj.font : obj.type === "textedit" ? fallbackKey(obj) : null;
  useEffect(() => {
    if (font) ensureFontFace(font);
  }, [font]);
  // 主のフォントに無い字（アラビア語の中の日本語など）を書くフォントも、表示用に読み込む
  const extraFonts = obj.type === "text" ? [...new Set(fontRuns(obj.font, obj.text).map((r) => r.key))].filter((k) => k !== obj.font).join(",") : "";
  useEffect(() => {
    for (const k of extraFonts ? extraFonts.split(",") : []) void ensureFontFace(k as FontKey);
  }, [extraFonts]);

  const handles = selected && HANDLES.map((h) => <span key={h} className={`handle ${h}`} data-handle={h} />);

  if (obj.type === "textedit") {
    return <TextEditView obj={obj} zoom={z} source={source} srcIndex={srcIndex} page={page} selected={selected} editing={editing} onStart={onEditStart} onText={onText} onEnd={onEditEnd} />;
  }

  if (obj.type === "text") {
    const style: React.CSSProperties = {
      left: obj.x * z,
      top: obj.y * z,
      fontSize: obj.fontSize * z,
      lineHeight: LINE_HEIGHT,
      fontFamily: cssFontStack(obj.font),
      color: obj.color,
    };
    if (obj.vertical) {
      style.writingMode = "vertical-rl";
      style.textOrientation = "mixed";
      style.width = obj.fontSize * LINE_HEIGHT * z;
      style.overflow = "visible";
    }
    if (obj.rotation) {
      style.transform = `rotate(${obj.rotation}deg)`;
      style.transformOrigin = "0 0";
    }
    if (editing) return <EditableText obj={obj} style={style} onStart={onEditStart} onText={onText} onEnd={onEditEnd} />;
    return (
      <div className={cls} data-obj={obj.id} dir="auto" style={style}>
        {obj.vertical ? <VerticalText text={obj.text} /> : obj.text || "\u00a0"}
        {selected && (
          <>
            <span className="handle se" data-handle="fs" title={t("handle.fontSize")} />
            <span className="rot-stem" />
            <span className="handle rot" data-handle="rot" title={t("handle.rotate")} />
          </>
        )}
      </div>
    );
  }

  if (obj.type === "markup") {
    const mbox: React.CSSProperties = { left: obj.x * z, top: obj.y * z, width: obj.w * z, height: obj.h * z, opacity: obj.opacity };
    const lw = Math.max(1, obj.h * 0.06 * z);
    const bar: React.CSSProperties =
      obj.kind === "underline"
        ? { position: "absolute", left: 0, right: 0, bottom: 0, height: lw, background: obj.color }
        : obj.kind === "strikeout"
          ? { position: "absolute", left: 0, right: 0, top: `calc(50% - ${lw / 2}px)`, height: lw, background: obj.color }
          : { position: "absolute", inset: 0, background: obj.color, mixBlendMode: "multiply" };
    return (
      <div className={`${cls} obj-markup-${obj.kind}`} data-obj={obj.id} style={mbox} title={obj.contents}>
        <span style={bar} />
        {handles}
      </div>
    );
  }
  if (obj.type === "note") {
    return (
      <div className={cls} data-obj={obj.id} style={{ left: obj.x * z, top: obj.y * z, width: NOTE_SIZE * z, height: NOTE_SIZE * z }} title={obj.contents}>
        <svg width={NOTE_SIZE * z} height={NOTE_SIZE * z} viewBox="0 0 20 20">
          <path d="M1.5 1.5h17v12.5H7.5L5 18v-4H1.5z" fill={obj.color} stroke="#444" strokeWidth="0.9" strokeLinejoin="round" />
          <path d="M4.5 6h11M4.5 9.5h8" stroke="#444" strokeWidth="0.9" strokeLinecap="round" />
        </svg>
      </div>
    );
  }
  if (obj.type === "ink") {
    const pad = obj.strokeWidth * z + 4;
    const d = obj.paths.map((p) => p.map(([px, py], i) => `${i === 0 ? "M" : "L"}${px * z + pad} ${py * z + pad}`).join(" ")).join(" ");
    return (
      <div className={cls} style={{ left: obj.x * z - pad, top: obj.y * z - pad, width: obj.w * z + pad * 2, height: obj.h * z + pad * 2, pointerEvents: "none" }}>
        <svg width={obj.w * z + pad * 2} height={obj.h * z + pad * 2} style={{ overflow: "visible" }}>
          <path d={d} fill="none" stroke="transparent" strokeWidth={Math.max(12, obj.strokeWidth * z + 8)} data-obj={obj.id} style={{ pointerEvents: "stroke" }} />
          <path d={d} fill="none" stroke={obj.stroke} strokeWidth={obj.strokeWidth * z} strokeLinecap="round" strokeLinejoin="round" opacity={obj.opacity} data-obj={obj.id} style={{ pointerEvents: "stroke" }} />
        </svg>
      </div>
    );
  }
  if (obj.type === "stamp" && obj.frame === "grid") {
    // 承認欄：外枠・見出しの下の線・欄の区切りと、欄ごとの見出し
    const l = approvalLayout(obj);
    const lw = Math.max(1, l.line * z);
    return (
      <div className={`${cls} obj-stamp obj-approval`} data-obj={obj.id} style={{ left: obj.x * z, top: obj.y * z, width: obj.w * z, height: obj.h * z, color: obj.color, opacity: obj.opacity, fontFamily: fontDef(obj.font)?.css ?? "sans-serif", transform: obj.rotation ? `rotate(${obj.rotation}deg)` : undefined }}>
        <svg width={obj.w * z} height={obj.h * z} style={{ position: "absolute", inset: 0, overflow: "visible", pointerEvents: "none" }}>
          <rect x={0} y={0} width={obj.w * z} height={obj.h * z} fill="none" stroke={obj.color} strokeWidth={lw} />
          <line x1={0} y1={l.header * z} x2={obj.w * z} y2={l.header * z} stroke={obj.color} strokeWidth={lw} />
          {l.titles.slice(1).map((_, i) => (
            <line key={i} x1={(i + 1) * l.col * z} y1={0} x2={(i + 1) * l.col * z} y2={obj.h * z} stroke={obj.color} strokeWidth={lw} />
          ))}
        </svg>
        {l.titles.map((title, i) => (
          <span key={i} className="approval-title" style={{ left: i * l.col * z, width: l.col * z, height: l.header * z, fontSize: titleSize(obj, title, l.col) * z }}>
            {title}
          </span>
        ))}
        {handles}
      </div>
    );
  }
  if (obj.type === "stamp") {
    const frame = obj.frame ?? "rect";
    const bw = Math.max(1, obj.fontSize * 0.12 * z);
    const gap = Math.max(1.5, bw * 1.1);
    const sstyle: React.CSSProperties = {
      left: obj.x * z,
      top: obj.y * z,
      width: obj.w * z,
      height: obj.h * z,
      color: obj.color,
      borderColor: obj.color,
      fontSize: obj.fontSize * z,
      fontFamily: fontDef(obj.font)?.css ?? "sans-serif",
      opacity: obj.opacity,
      transform: obj.rotation ? `rotate(${obj.rotation}deg)` : undefined,
      borderStyle: frame === "none" ? "none" : "solid",
      borderWidth: frame === "none" ? 0 : bw,
      // 保存結果（角ばった枠）と同じにする
      borderRadius: frame === "ellipse" ? "50%" : 0,
    };
    return (
      <div className={`${cls} obj-stamp`} data-obj={obj.id} style={sstyle}>
        {obj.double && frame !== "none" && (
          <span className="stamp-inner" style={{ inset: gap + bw, borderStyle: "solid", borderWidth: bw, borderColor: obj.color, borderRadius: frame === "ellipse" ? "50%" : 0 }} />
        )}
        <span>{obj.text}</span>
        {handles}
      </div>
    );
  }
  if (obj.type === "line") {
    const pad = Math.max(8, obj.strokeWidth * z);
    const minX = Math.min(0, obj.dx) * z - pad;
    const minY = Math.min(0, obj.dy) * z - pad;
    const w = Math.abs(obj.dx) * z + pad * 2;
    const h = Math.abs(obj.dy) * z + pad * 2;
    const x1 = -minX;
    const y1 = -minY;
    const x2 = obj.dx * z - minX;
    const y2 = obj.dy * z - minY;
    return (
      <div className={cls} style={{ left: obj.x * z + minX, top: obj.y * z + minY, width: w, height: h, pointerEvents: "none" }}>
        <svg width={w} height={h} style={{ overflow: "visible" }}>
          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={Math.max(12, obj.strokeWidth * z)} data-obj={obj.id} style={{ pointerEvents: "stroke" }} />
          <line
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={obj.stroke}
            strokeWidth={obj.strokeWidth * z}
            strokeLinecap="round"
            opacity={obj.opacity}
            data-obj={obj.id}
            style={{ pointerEvents: "stroke" }}
          />
          {selected && (
            <>
              <line x1={x1} y1={y1} x2={x2} y2={y2} className="line-sel" />
              {/* 指でも押しやすいよう、端のつまみに見えない大きめの当たりを付ける */}
              {COARSE && <circle cx={x1} cy={y1} r={18} fill="transparent" data-obj={obj.id} data-handle="p1" style={{ pointerEvents: "all" }} />}
              {COARSE && <circle cx={x2} cy={y2} r={18} fill="transparent" data-obj={obj.id} data-handle="p2" style={{ pointerEvents: "all" }} />}
              <circle cx={x1} cy={y1} r={5} className="handle-dot" data-obj={obj.id} data-handle="p1" style={{ pointerEvents: "all" }} />
              <circle cx={x2} cy={y2} r={5} className="handle-dot" data-obj={obj.id} data-handle="p2" style={{ pointerEvents: "all" }} />
            </>
          )}
        </svg>
      </div>
    );
  }

  const box: React.CSSProperties = { left: obj.x * z, top: obj.y * z, width: obj.w * z, height: obj.h * z };

  if (obj.type === "imageedit") {
    return (
      <div className={cls} data-obj={obj.id} style={box}>
        <span className="obj-label">{t("obj.imageDeleted")}</span>
      </div>
    );
  }
  if (obj.type === "redact") {
    return (
      <div className={cls} data-obj={obj.id} style={{ ...box, background: obj.fill }}>
        {handles}
      </div>
    );
  }
  if (obj.type === "image") {
    const img = images.get(obj.imageId);
    return (
      <div className={cls} data-obj={obj.id} style={box}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {img && <img src={img.url} alt="" draggable={false} style={{ opacity: obj.opacity }} />}
        {handles}
      </div>
    );
  }

  if (obj.type === "measure") {
    // 計測：線（面積は閉じた多角形と薄い塗り）と、実寸の数値
    const pad = 8;
    const ptsD = obj.pts.map(([px, py]) => `${px * z + pad},${py * z + pad}`).join(" ");
    const [lx, ly] = labelAnchor(obj);
    return (
      <div className={`${cls} obj-measure`} style={{ left: obj.x * z - pad, top: obj.y * z - pad, width: obj.w * z + pad * 2, height: obj.h * z + pad * 2, pointerEvents: "none" }}>
        <svg width={obj.w * z + pad * 2} height={obj.h * z + pad * 2} style={{ overflow: "visible" }}>
          {obj.kind === "area" ? (
            <polygon points={ptsD} fill={obj.color} fillOpacity={0.12} stroke={obj.color} strokeWidth={1.5} data-obj={obj.id} style={{ pointerEvents: "visiblePainted" }} />
          ) : (
            <>
              <polyline points={ptsD} fill="none" stroke="transparent" strokeWidth={12} data-obj={obj.id} style={{ pointerEvents: "stroke" }} />
              <polyline points={ptsD} fill="none" stroke={obj.color} strokeWidth={1.5} data-obj={obj.id} style={{ pointerEvents: "stroke" }} />
            </>
          )}
          {obj.pts.map(([px, py], i) => (
            <circle key={i} cx={px * z + pad} cy={py * z + pad} r={2.5} fill={obj.color} />
          ))}
          {/* 選んでいるときは、点をつまんで動かせる（指でも押しやすいよう、見えない大きめの当たりを付ける）。
              面積の最初の点は輪で示す（そこを押すと閉じる） */}
          {selected &&
            obj.pts.map(([px, py], i) => (
              <g key={`h${i}`} data-obj={obj.id} data-handle={`v${i}`} style={{ pointerEvents: "all", cursor: "move" }}>
                <circle cx={px * z + pad} cy={py * z + pad} r={COARSE ? 18 : 12} fill="transparent" />
                <circle cx={px * z + pad} cy={py * z + pad} r={i === 0 && obj.kind === "area" ? 6.5 : 5} className="handle-dot measure-dot" style={{ stroke: obj.color }} />
              </g>
            ))}
        </svg>
        <span className="measure-label" data-obj={obj.id} style={{ left: lx * z + pad, top: ly * z + pad, color: obj.color }}>
          {measureLabel(obj)}
        </span>
      </div>
    );
  }
  if (obj.type === "field") {
    // 入力欄：薄い水色の枠と名前（保存した PDF では入力できる欄になる）
    return (
      <div className={`${cls} obj-field obj-field-${obj.kind}`} data-obj={obj.id} style={box} title={obj.kind === "radio" ? `${obj.name}: ${obj.value ?? ""}` : obj.name}>
        {obj.kind === "checkbox" ? (
          <span className="field-check" />
        ) : obj.kind === "radio" ? (
          <span className="field-radio" />
        ) : (
          <span className="field-name">{obj.kind === "signature" ? `✍ ${obj.name}` : obj.name}</span>
        )}
        {obj.kind === "dropdown" && <span className="field-caret">▾</span>}
        {obj.kind === "date" && <span className="field-caret">📅</span>}
        {handles}
      </div>
    );
  }
  if (obj.type === "link") {
    // リンク：点線の枠と、行き先の短い表示（保存した PDF では枠は見えず、押すと移る範囲になる）
    const label = obj.target.kind === "url" ? obj.target.url.replace(/^(https?:\/\/|mailto:)/, "") || t("link.noUrl") : t("link.toPage");
    return (
      <div className={`${cls} obj-link`} data-obj={obj.id} style={box} title={label}>
        <span className="link-label">{label}</span>
        {handles}
      </div>
    );
  }

  const w = obj.w * z;
  const h = obj.h * z;
  const sw = obj.stroke ? obj.strokeWidth * z : 0;
  const common = {
    fill: obj.fill ?? "none",
    stroke: obj.stroke ?? "none",
    strokeWidth: sw,
    opacity: obj.opacity,
  };
  return (
    <div className={cls} data-obj={obj.id} style={box}>
      <svg width={w} height={h} style={{ overflow: "visible", display: "block" }}>
        {obj.type === "ellipse" ? (
          <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} {...common} />
        ) : (
          <rect x={0} y={0} width={w} height={h} {...common} />
        )}
      </svg>
      {handles}
    </div>
  );
}

/** 既存文字の実編集の表示：元の文字を背景色で隠し（プレビューのみ）、保存時と同じ折り返しで新しい文字を置く */
function TextEditView({
  obj,
  zoom,
  source,
  srcIndex,
  page,
  selected,
  editing,
  onStart,
  onText,
  onEnd,
}: {
  obj: TextEditObj;
  zoom: number;
  source?: SourceDoc;
  srcIndex: number;
  page?: PageItem;
  selected: boolean;
  editing: boolean;
  onStart: () => void;
  onText: (t: string) => void;
  onEnd: (t: string) => void;
}) {
  const z = zoom;
  const t = useT();
  const [layout, setLayout] = useState<PreviewLayout | null>(null);
  useEffect(() => {
    let alive = true;
    previewLayout(obj, source, srcIndex).then(
      (l) => alive && setLayout(l),
      () => alive && setLayout(null),
    );
    return () => {
      alive = false;
    };
  }, [obj, source, srcIndex]);

  // 字形の並びのままの行（インド系の文字など）：保存結果そのものを描いて見せる（画面の文字では再現できない）
  const [exact, setExact] = useState<ExactBand | null>(null);
  const wantExact = !!obj.complex && !!source && !!page && !editing && obj.text !== obj.original;
  useEffect(() => {
    if (!wantExact || !source || !page) {
      setExact(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      exactEditBand(page, source, obj, Math.min(3, Math.max(1, z * (window.devicePixelRatio || 1))))
        .then((v) => alive && setExact(v))
        .catch(() => alive && setExact(null));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // 文字・位置・大きさが変わったときだけ描き直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantExact, source, page?.id, obj.text, obj.x, obj.baseline, obj.fontSize, obj.color, z]);

  const fallbackFamily = fontDef(fallbackKey(obj))?.css ?? "sans-serif";
  // 元のフォントで保存される行は、画面でも PDF の中のフォントで表示する（保存結果と同じ書体・字幅になる）
  const [pf, setPf] = useState<PreviewFont | null>(null);
  const wantPf = obj.font === "original" && !obj.vertical && !!obj.previewFont && !!source && layout?.usesOriginal !== false;
  useEffect(() => {
    let alive = true;
    if (!wantPf || !source || !obj.previewFont) {
      setPf(null);
      return;
    }
    previewFontFor(source, srcIndex, obj.previewFont).then((v) => alive && setPf(v));
    return () => {
      alive = false;
    };
  }, [wantPf, source, srcIndex, obj.previewFont]);
  const family = fallbackFamily;
  const shownFamily = pf && wantPf ? `"${pf.family}", ${fallbackFamily}` : fallbackFamily;
  // 空白は同梱フォントの幅で出てしまうので、PDF のフォントの空白の幅との差を、単語の間隔で埋める
  const spaceFix = pf && wantPf && pf.spaceEm != null ? pf.spaceEm - cssSpaceEm(fallbackFamily) : 0;
  const pad = 1;
  const cover: React.CSSProperties = {
    left: (obj.x - pad) * z,
    top: (obj.y - pad) * z,
    width: (obj.w + pad * 2) * z,
    height: (obj.h + pad * 2) * z,
    background: obj.cover,
  };
  const fs = layout?.fontSize ?? obj.fontSize;
  const lines = layout?.lines ?? obj.text.split("\n");
  const cls = `obj obj-textedit ${selected ? "selected" : ""} ${layout?.overflow ? "overflow" : ""}`;
  if (obj.vertical) {
    // 縦書き：保存時と同じ列分割（layout.lines、右端が最初の列）を、列ごとに CSS の縦組みで置く。列の間隔は lineHeight
    const pitch = obj.lineHeight;
    const rightEdge = obj.x + obj.w; // 右端の列の右辺
    if (editing) {
      // 入力中は 1 つの縦組みの箱。右辺を固定し、列が増えると左へ伸びる
      const vstyle: React.CSSProperties = {
        position: "absolute",
        right: 0,
        top: 0,
        height: obj.h * z,
        minWidth: pitch * z,
        fontSize: obj.fontSize * z,
        lineHeight: pitch / obj.fontSize,
        fontFamily: family,
        color: obj.color,
        whiteSpace: "pre-wrap",
        writingMode: "vertical-rl",
        textOrientation: "mixed",
        overflow: "visible",
      };
      return (
        <>
          <div className="obj obj-cover" style={cover} />
          <div className="obj-anchor" style={{ position: "absolute", left: rightEdge * z, top: obj.y * z, width: 0, height: obj.h * z }}>
            <EditableText obj={obj} style={vstyle} onStart={onStart} onText={onText} onEnd={onEnd} />
          </div>
        </>
      );
    }
    return (
      <>
        <div className="obj obj-cover" style={cover} />
        <div className={`${cls} vertical`} data-obj={obj.id} style={{ left: (rightEdge - lines.length * pitch) * z, top: obj.y * z, width: lines.length * pitch * z, height: obj.h * z }}>
          {lines.map((col, i) => (
            <div
              key={i}
              className="textedit-col"
              style={{
                left: (lines.length - 1 - i) * pitch * z,
                width: pitch * z,
                fontSize: fs * z,
                lineHeight: pitch / fs,
                fontFamily: family,
                color: obj.color,
              }}
            >
              <VerticalText text={col} />
            </div>
          ))}
          {selected && (
            <span className="textedit-badge">
              {[
                t("badge.vertical"),
                layout?.usesOriginal ? t("badge.originalFont") : (fontDef(fallbackKey(obj))?.name ?? ""),
                layout?.shrunk ? t("badge.shrunk", { percent: Math.round((fs / obj.fontSize) * 100) }) : "",
                layout?.overflow ? t("badge.overflow") : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          )}
        </div>
      </>
    );
  }
  if (obj.complex && !editing) {
    // 変えていなければ元のページがそのまま見える。変えたら、保存結果の帯を重ねる（描けるまでは元のまま）
    return (
      <>
        {exact && wantExact && <img className="obj obj-exact" alt="" draggable={false} src={exact.url} style={{ left: exact.x * z, top: exact.y * z, width: exact.w * z, height: exact.h * z }} />}
        <div className={cls} data-obj={obj.id} style={{ left: obj.x * z, top: obj.y * z, width: obj.w * z, height: obj.h * z }}>
          {selected && <span className="textedit-badge">{exact && wantExact && !exact.applied ? t("badge.notApplied") : t("badge.wordOnly")}</span>}
        </div>
      </>
    );
  }
  if (editing) {
    const style: React.CSSProperties = {
      left: obj.x * z,
      top: (obj.baseline - baselineOffset(obj.fontSize)) * z,
      width: obj.w * z,
      minHeight: obj.h * z,
      fontSize: obj.fontSize * z,
      lineHeight: LINE_HEIGHT,
      fontFamily: family,
      color: obj.color,
      whiteSpace: "pre-wrap",
      textAlign: obj.align,
    };
    return (
      <>
        <div className="obj obj-cover" style={cover} />
        <EditableText obj={obj} style={style} onStart={onStart} onText={onText} onEnd={onEnd} />
      </>
    );
  }
  return (
    <>
      <div className="obj obj-cover" style={cover} />
      <div className={cls} data-obj={obj.id} style={{ left: obj.x * z, top: obj.y * z, width: obj.w * z, height: Math.max(obj.h, (lines.length - 1) * obj.lineHeight + obj.h) * z }}>
        {lines.map((line, i) => (
          <div
            key={i}
            className="textedit-line"
            style={{
              top: (obj.baseline + i * obj.lineHeight - obj.y - baselineOffset(fs)) * z,
              fontSize: fs * z,
              lineHeight: LINE_HEIGHT,
              fontFamily: shownFamily,
              wordSpacing: spaceFix ? spaceFix * fs * z : undefined,
              color: obj.color,
              textAlign: obj.align,
              letterSpacing: obj.charSpacing ? obj.charSpacing * z : undefined,
            }}
            data-text={line}
            data-space={spaceFix ? "fit" : undefined}
          >
            {(pf && wantPf ? toPreviewText(pf, line) : line) || "\u00a0"}
          </div>
        ))}
        {selected && (
          <span className="textedit-badge">
            {[
              layout?.usesOriginal ? t("badge.originalFont") : (fontDef(fallbackKey(obj))?.name ?? ""),
              layout?.shrunk ? t("badge.shrunk", { percent: Math.round((fs / obj.fontSize) * 100) }) : "",
              layout?.overflow ? t("badge.overflow") : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        )}
      </div>
    </>
  );
}

/** 縦書きの 1 列（または改行区切りの複数列）。2〜3 桁の数字などは縦中横にする */
function VerticalText({ text }: { text: string }) {
  if (!text) return <>{"\u00a0"}</>;
  return (
    <>
      {text.split("\n").map((col, i) => (
        <React.Fragment key={i}>
          {i > 0 && "\n"}
          {verticalUnits(col).map((u, k) => (u.kind === "tcy" ? <span key={k} className="tcy">{u.text}</span> : u.text))}
        </React.Fragment>
      ))}
    </>
  );
}

function EditableText({
  obj,
  style,
  onStart,
  onText,
  onEnd,
}: {
  obj: TextObj | TextEditObj;
  style: React.CSSProperties;
  onStart: () => void;
  onText: (t: string) => void;
  onEnd: (t: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const read = () => (ref.current?.innerText ?? "").replace(/\r/g, "").replace(/\n$/, "");

  useEffect(() => {
    const el = ref.current!;
    el.innerText = obj.text;
    onStart();
    el.focus();
    // 全選択（新規は空なのでキャレットのみ）
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={ref}
      className="obj obj-text editing"
      data-obj={obj.id}
      style={style}
      dir="auto"
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck={false}
      onInput={() => onText(read())}
      onBlur={() => onEnd(read())}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") (e.target as HTMLElement).blur();
      }}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}


import type { Record as HistRecord } from "@/lib/useHistory";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { newApproval } from "@/lib/approval";
import { colorPick } from "@/lib/colorPick";
import { readPageLinks } from "@/lib/pageLinks";
import { detectFieldCells, detectUnderlineFields, type FieldCandidate } from "@/lib/formDetect";
import { findMatches, matchBoxes } from "@/lib/findText";
import { analyzePage } from "@/lib/libDoc";
import { getPageText } from "@/lib/textRuns";
import { apply as applyPt } from "@/lib/geometry";
import { defaultFont } from "@/lib/fonts";
import { uid } from "@/lib/geometry";
import { type Key, useT } from "@/lib/i18n";
import { loadImageFile } from "@/lib/loader";
import type { EditObj, FieldObj, ImageEditObj, ImageObj, PageItem, SourceDoc, StoredImage, Tool } from "@/lib/types";
import { Icon } from "./Icon";
import { DEFAULTS, PageEditor, PageView, touchDraws } from "./PageEditor";
import { PropertiesPanel } from "./PropertiesPanel";
import { Thumb } from "./Thumb";
import { SignatureDialog } from "./tools/SignatureDialog";

interface Props {
  pages: PageItem[];
  sources: Map<string, SourceDoc>;
  images: Map<string, StoredImage>;
  currentId: string;
  setCurrentId: (id: string) => void;
  update: (fn: (p: PageItem[]) => PageItem[], record?: HistRecord) => void;
  checkpoint: () => void;
  onError: (e: unknown) => void;
  /** ページ整理に戻る（スマホの戻るボタン） */
  onBack: () => void;
  /** 知らせを出す */
  onInfo?: (message: string) => void;
  /** 注釈の一覧などから：そのページへ移り、その場所を示す（部品なら選ぶ） */
  focus?: FocusRequest | null;
}

export interface FocusRequest {
  pageId: string;
  rect: { x: number; y: number; w: number; h: number };
  objId?: string;
  /** 同じ場所をもう一度頼んだときも動くように */
  n: number;
}

export const TOOLS: { id: Tool; icon: string; label: Key; key: string; tip: Key; group: number }[] = [
  { id: "select", icon: "cursor", label: "tool.select", key: "v", tip: "tool.select.tip", group: 0 },
  { id: "edit-text", icon: "text-edit", label: "tool.editText", key: "e", tip: "tool.editText.tip", group: 0 },
  { id: "image-edit", icon: "image-edit", label: "tool.imageEdit", key: "g", tip: "tool.imageEdit.tip", group: 0 },
  { id: "text", icon: "type", label: "tool.text", key: "t", tip: "tool.text.tip", group: 1 },
  { id: "rect", icon: "square", label: "tool.rect", key: "r", tip: "tool.rect.tip", group: 1 },
  { id: "ellipse", icon: "circle", label: "tool.ellipse", key: "o", tip: "tool.ellipse.tip", group: 1 },
  { id: "line", icon: "line", label: "tool.line", key: "l", tip: "tool.line.tip", group: 1 },
  { id: "whiteout", icon: "eraser", label: "tool.whiteout", key: "w", tip: "tool.whiteout.tip", group: 1 },
  { id: "redact", icon: "redact", label: "tool.redact", key: "x", tip: "tool.redact.tip", group: 1 },
  { id: "highlight", icon: "highlight", label: "tool.highlight", key: "h", tip: "tool.highlight.tip", group: 2 },
  { id: "underline", icon: "underline", label: "tool.underline", key: "u", tip: "tool.underline.tip", group: 2 },
  { id: "strikeout", icon: "strikeout", label: "tool.strikeout", key: "s", tip: "tool.strikeout.tip", group: 2 },
  { id: "note", icon: "note", label: "tool.note", key: "n", tip: "tool.note.tip", group: 2 },
  { id: "ink", icon: "pen-ink", label: "tool.ink", key: "p", tip: "tool.ink.tip", group: 2 },
  { id: "stamp", icon: "stamp", label: "tool.stamp", key: "k", tip: "tool.stamp.tip", group: 2 },
  { id: "link", icon: "link", label: "tool.link", key: "j", tip: "tool.link.tip", group: 2 },
  { id: "field", icon: "form", label: "tool.field", key: "f", tip: "tool.field.tip", group: 2 },
  { id: "measure", icon: "ruler", label: "tool.measure", key: "m", tip: "tool.measure.tip", group: 2 },
];

/** スマホの道具の並びに、いつも出しておくもの（残りは「その他」から選ぶ） */
const FREQUENT: Tool[] = ["select", "edit-text", "text", "redact", "highlight", "ink"];

const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 3, 4];

// 画面の切り替えの条件（styles.css の @media と同じにしておく）
/** スマホの並び：幅が狭い（縦向き）か、高さが低い（横向き） */
const NARROW_QUERY = "(max-width: 640px), (max-height: 500px)";
/** 横向きのスマホ：設定のパネルは、下ではなく横に付く */
const SIDE_QUERY = "(min-width: 500px) and (max-height: 500px)";

/** 狭い画面（スマホ）か。文字の編集を画面下の入力欄で行う等の切り替えに使う */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

/** 文字の入力欄（ページ上でその場で書く欄を含む）にカーソルがあるか */
function typingNow(): boolean {
  const a = document.activeElement;
  if (!a) return false;
  if (a instanceof HTMLTextAreaElement || (a instanceof HTMLElement && a.isContentEditable)) return true;
  return a instanceof HTMLInputElement && ["text", "search", "number", ""].includes(a.type);
}

export function EditorView(p: Props) {
  const { pages, sources, images, currentId } = p;
  const index = Math.max(0, pages.findIndex((x) => x.id === currentId));
  const page = pages[index];
  const source = page.srcId ? sources.get(page.srcId) : undefined;

  const [tool, setTool] = useState<Tool>("select");
  /** 既存文字ツールの単位：行／段落／範囲（ドラッグした範囲の行をまとめる） */
  const [unit, setUnit] = useState<"line" | "block" | "range">("line");
  const narrow = useNarrow();
  const t = useT();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [zoomMode, setZoomMode] = useState<"fit" | number>("fit");
  // 合わせ方：ページの幅に合わせる（既定。字が読みやすい）／ページ全体を表示する。最後に選んだほうを覚えておく
  const [fitKind, setFitKind] = useState<"width" | "page">(() => {
    try {
      return localStorage.getItem("washi-pdf.fit") === "page" ? "page" : "width";
    } catch {
      return "width";
    }
  });
  const chooseFit = (k: "width" | "page") => {
    setFitKind(k);
    setZoomMode("fit");
    try {
      localStorage.setItem("washi-pdf.fit", k);
    } catch {
      /* 覚えられなくても動く */
    }
  };
  // 倍率の表示を押したとき：合わせた表示なら、もう一方の合わせ方に。拡大・縮小していれば、いまの合わせ方に戻す
  const onZoomValue = () => (zoomMode === "fit" ? chooseFit(fitKind === "width" ? "page" : "width") : setZoomMode("fit"));
  const fitKindRef = useRef(fitKind);
  fitKindRef.current = fitKind;
  const zoomValueTitle = t((zoomMode === "fit" ? fitKind === "width" : fitKind === "page") ? "zoom.fit" : "zoom.fitWidth");
  // スマホで、下のパネルをたたんでいるか。別のものを選んだら開き直す
  const [panelClosed, setPanelClosed] = useState(false);
  // 利用者がつまみでたたんだ：道具を変えるまでは、別のものを選んでも開き直さない（描くたびにパネルが開いて、ページが隠れるのを防ぐ）
  const userClosed = useRef(false);
  // 点を順に押して作る計測（折れ線・面積）の途中
  const [drafting, setDrafting] = useState(false);
  // スマホで文字を入力しているあいだ（パネルの入力欄にカーソルがある）：ページを広く見せるため、
  // 道具の並び・上下のバー・パネルの見出しやタブを隠し、入力欄だけを出す
  const propsRef = useRef<HTMLElement>(null);
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const el = propsRef.current;
    if (!el || !narrow) {
      setTyping(false);
      return;
    }
    const isField = (t: EventTarget | null) => t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && (t.type === "text" || t.type === "search"));
    // キーボードが出ているか：同じ幅で見た一番高い表示域より、いまの表示域がはっきり低い
    // （欄にカーソルを置いたまま、戻るボタンでキーボードだけ閉じたときは、バーを戻す）
    const tall = new Map<number, number>();
    const height = () => Math.min(window.innerHeight, window.visualViewport?.height ?? Infinity);
    const keyboard = () => {
      const w = window.innerWidth;
      const h = height();
      const max = Math.max(tall.get(w) ?? 0, h);
      tall.set(w, max);
      return h < max * 0.8;
    };
    const update = () => {
      const a = document.activeElement;
      setTyping(isField(a) && el.contains(a) && keyboard());
    };
    keyboard();
    const onOut = () => setTimeout(update, 0);
    const vv = window.visualViewport;
    el.addEventListener("focusin", update);
    el.addEventListener("focusout", onOut);
    window.addEventListener("resize", update);
    vv?.addEventListener("resize", update);
    return () => {
      el.removeEventListener("focusin", update);
      el.removeEventListener("focusout", onOut);
      window.removeEventListener("resize", update);
      vv?.removeEventListener("resize", update);
    };
  }, [narrow]);
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("typing", typing);
    // iPhone・iPad の Safari は、キーボードが出ても画面の枠（レイアウト）を縮めず、見えている範囲だけが縮む。
    // 入力中は、アプリ全体を見えている範囲に合わせる（下のパネルがキーボードの上に来る）。
    // Android の Chrome（画面の枠ごと縮む）では、見えている範囲＝画面の枠なので何も変わらない
    const vv = window.visualViewport;
    const fit = () => {
      if (!vv || vv.height >= window.innerHeight - 1) {
        root.style.removeProperty("--vvh");
        root.style.removeProperty("--vvtop");
        return;
      }
      root.style.setProperty("--vvh", `${vv.height}px`);
      root.style.setProperty("--vvtop", `${vv.pageTop}px`);
    };
    if (typing) {
      fit();
      vv?.addEventListener("resize", fit);
      vv?.addEventListener("scroll", fit);
    }
    return () => {
      root.classList.remove("typing");
      vv?.removeEventListener("resize", fit);
      vv?.removeEventListener("scroll", fit);
      root.style.removeProperty("--vvh");
      root.style.removeProperty("--vvtop");
    };
  }, [typing]);
  // 色を拾っている間（スポイト）は、ページが見えるようにパネルをたたみ、拾い終わったら開き直す
  const picking = useSyncExternalStore(colorPick.subscribe, colorPick.active, () => false);
  useEffect(() => {
    setPanelClosed(picking || userClosed.current);
  }, [picking]);
  // 画面を離れるときは、待っている状態を解く
  useEffect(() => () => colorPick.cancel(), []);
  const [fitZoom, setFitZoom] = useState(1);
  const [signing, setSigning] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);

  // ---- 連続表示：全ページを縦に並べ、画面の近くのページだけ描く。画面の中央にあるページが「編集するページ」 ----
  const [near, setNear] = useState<Set<string>>(() => new Set([currentId]));
  // ページ送り・サムネイルなどで編集するページを変えたら、そのページまで送る（スクロールで変わったときは送らない）
  const scrolledTo = useRef<string | null>(null);
  const goToPage = useCallback(
    (id: string, scroll = true) => {
      if (!scroll) scrolledTo.current = id;
      p.setCurrentId(id);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.setCurrentId],
  );
  // 送った直後は、スクロールで編集するページを変えない（倍率や並びが落ち着くまで）
  const holdUntil = useRef(0);
  useLayoutEffect(() => {
    if (scrolledTo.current === currentId) return;
    scrolledTo.current = currentId;
    holdUntil.current = performance.now() + 400;
    const stage = stageRef.current;
    const slot = stage?.querySelector<HTMLElement>(`.page-slot[data-page-id="${currentId}"]`);
    if (!stage || !slot) return;
    // ページの上端を、表示の上端（少し余白を残して）にそろえる
    stage.scrollTop += slot.getBoundingClientRect().top - stage.getBoundingClientRect().top - 12;
  }, [currentId]);
  // 画面の近く（上下に 1 画面分）にあるページを調べる
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof IntersectionObserver === "undefined") {
      setNear(new Set(pages.map((x) => x.id)));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        setNear((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const id = (e.target as HTMLElement).dataset.pageId;
            if (!id) continue;
            if (e.isIntersecting) next.add(id);
            else next.delete(id);
          }
          return next.size === prev.size && [...next].every((x) => prev.has(x)) ? prev : next;
        });
      },
      { root: stage, rootMargin: "100% 0px" },
    );
    stage.querySelectorAll(".page-slot").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [pages.length, pages.map((x) => x.id).join(",")]);
  // スクロールしたら、画面の中央にあるページを編集するページにする。何かを選んでいる・入力しているあいだは変えない（編集が途切れないように）。
  // ただし、選んだもののあるページが画面からすっかり出たら、選択を解いて切り替える
  // （見えないものを選んだままにすると、ページ番号が合わず、Delete などが見えない所に効いてしまう）
  const scrollFrame = useRef(0);
  // ページの上で押している間（線を引いている途中など）は切り替えない。離したあとに、押している間の分をまとめて調べる
  const held = useRef({ down: false, skipped: false });
  const onStageScroll = () => {
    if (scrollFrame.current) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = 0;
      const stage = stageRef.current;
      if (!stage || typingNow() || performance.now() < holdUntil.current) return;
      if (held.current.down) {
        held.current.skipped = true;
        return;
      }
      const r = stage.getBoundingClientRect();
      if (selectedIdRef.current) {
        const cur = stage.querySelector(".page-slot.current")?.getBoundingClientRect();
        if (cur && cur.bottom > r.top && cur.top < r.bottom) return;
      }
      const mid = r.top + r.height / 2;
      let best: string | null = null;
      let bestD = Infinity;
      stage.querySelectorAll<HTMLElement>(".page-slot").forEach((el) => {
        const b = el.getBoundingClientRect();
        const d = mid < b.top ? b.top - mid : mid > b.bottom ? mid - b.bottom : 0;
        if (d < bestD) {
          bestD = d;
          best = el.dataset.pageId ?? null;
        }
      });
      if (best && best !== currentId) goToPage(best, false);
    });
  };
  const onStageScrollRef = useRef(onStageScroll);
  onStageScrollRef.current = onStageScroll;
  useEffect(() => {
    const up = () => {
      const h = held.current;
      h.down = false;
      if (h.skipped) {
        h.skipped = false;
        onStageScrollRef.current();
      }
    };
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    return () => {
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
    };
  }, []);
  const imageInput = useRef<HTMLInputElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  const zoom = zoomMode === "fit" ? fitZoom : zoomMode;
  // 道具を変えたら、たたんだままにする指定を解く
  useEffect(() => {
    userClosed.current = false;
  }, [tool]);
  // スマホで、ペンで描いている・計測の点を足している間は、パネルを開かない
  // （開くと、描くたびにページが隠れ、押している指の下でページが動く）。色などを変えるときは、つまみで開く
  const drawingNow = narrow && (tool === "ink" || drafting);
  // 選ぶものが変わったら、パネルを開き、選んだものが（パネルに隠れず）見える位置に来るようにする
  useEffect(() => {
    if (drawingNow) {
      setPanelClosed(true);
      return;
    }
    // 文字は、スマホではパネルの入力欄で打つので、たたんだままにしない
    const o = selectedId ? page.objects.find((x) => x.id === selectedId) : undefined;
    if (!userClosed.current || o?.type === "text" || o?.type === "textedit") setPanelClosed(false);
    if (!selectedId) return;
    const id = selectedId;
    const adjust = () => {
      const el = document.querySelector(`[data-obj="${id}"]`);
      const stage = el?.closest(".stage");
      if (!el || !stage) return;
      const r = el.getBoundingClientRect();
      const s = stage.getBoundingClientRect();
      // 縦：はみ出しているときだけ動かす（見えているのに動くと煩わしい）。横：行の先頭が画面の左に隠れていたら見せる
      const top = r.top < s.top + 8 || r.bottom > s.bottom - 8 ? r.top - s.top - Math.max(16, (s.height - r.height) / 3) : 0;
      const left = r.left < s.left ? r.left - s.left - 12 : 0;
      if (top || left) stage.scrollBy({ top, left });
    };
    // パネルが開いて表示領域の大きさが変わったあとに合わせる（開く途中でも一度合わせ、落ち着いてからもう一度）
    const timers = [setTimeout(adjust, 150), setTimeout(adjust, 600)];
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, drawingNow]);

  useEffect(() => {
    setSelectedId(null);
    setEditingId(null);
  }, [currentId]);

  // 表示倍率（ページ全体が収まる倍率）
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let done = false;
    const calc = () => {
      // 文字を入力しているあいだは計算し直さない（キーボードが出て表示が縮むたびに、全体表示の倍率が下がって文字が見えなくなる）。
      // 入力を終えたら計算し直す
      if (done && typingNow()) return;
      done = true;
      // 連続表示では、どのページも全体が収まる倍率にする（ページごとに倍率が変わると、送るたびに並びがずれる）
      let z = Infinity;
      for (const pg of pagesRef.current.length ? pagesRef.current : [page]) {
        const swap = pg.extraRotation % 180 !== 0;
        const w = swap ? pg.height : pg.width;
        const h = swap ? pg.width : pg.height;
        z = Math.min(z, (el.clientWidth - 48) / w, fitKindRef.current === "page" ? (el.clientHeight - 48) / h : Infinity);
      }
      // 幅に合わせるときは 150% まで（大きな画面で字が大きくなりすぎないように）
      if (fitKindRef.current === "width") z = Math.min(z, 1.5);
      setFitZoom(Math.max(0.1, Math.min(4, z)));
    };
    calc();
    // 大きさの知らせの中で表示を変えると、ブラウザーが「知らせを配りきれなかった」と報告する（Safari ではページのエラーになる）。
    // 次の描画の前に計算し直す
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(calc);
    });
    ro.observe(el);
    const onOut = () => setTimeout(calc, 0);
    document.addEventListener("focusout", onOut);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener("focusout", onOut);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages.map((pg) => `${pg.width}x${pg.height}r${pg.extraRotation}`).join(","), fitKind]);

  useEffect(() => {
    stripRef.current?.querySelector(".strip-item.on")?.scrollIntoView({ block: "nearest" });
  }, [currentId]);

  // 注釈の一覧から移ってきたとき：そのページへ送り、部品なら選び、元の PDF の注釈なら場所を一瞬示す。どちらも画面の中央へ送る
  const [flash, setFlash] = useState<FocusRequest | null>(null);
  useEffect(() => {
    const f = p.focus;
    if (!f) return;
    goToPage(f.pageId);
    const tm = setTimeout(() => {
      if (f.objId) setSelectedId(f.objId);
      else setFlash(f);
      setTimeout(() => {
        const stage = stageRef.current;
        const el = f.objId ? stage?.querySelector(`[data-obj="${f.objId}"]`) : stage?.querySelector(".annot-flash");
        el?.scrollIntoView({ block: "center", inline: "nearest" });
      }, 60);
    }, 80);
    const clear = setTimeout(() => setFlash((x) => (x === f ? null : x)), 2500);
    return () => {
      clearTimeout(tm);
      clearTimeout(clear);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.focus?.n]);

  // リンクの道具を選んだら、そのページの元のリンクを編集できる部品として読み込む（ページごとに 1 回）
  useEffect(() => {
    if (tool !== "link" || !page.srcId || page.linksImported) return;
    const src = sources.get(page.srcId);
    if (!src) return;
    let live = true;
    void readPageLinks(src, page, pages)
      .then(({ links, refs }) => {
        if (!live) return;
        p.update((prev) => prev.map((x) => (x.id === page.id ? { ...x, linksImported: refs, objects: [...x.objects, ...links] } : x)), false);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, page.id, page.linksImported]);

  // 入力欄の道具：表の罫線から、文字の入っていない枠を見つけて入力欄を置く（もう入力欄のある所には置かない）
  const [detecting, setDetecting] = useState(false);
  // 計測の種類（距離・面積）。次に置く計測に使う
  const [measureKind, setMeasureKind] = useState(DEFAULTS.measure.kind);
  const detectFields = async () => {
    const src = page.srcId ? sources.get(page.srcId) : undefined;
    if (!src || detecting) {
      p.onInfo?.(t("field.detectedNone"));
      return;
    }
    setDetecting(true);
    try {
      const [a, text] = await Promise.all([analyzePage(src, page.srcIndex), getPageText(src, page)]);
      const vt = page.viewTransform;
      const rules = a.rules.map(([x1, y1, x2, y2]) => [...applyPt(vt, x1, y1), ...applyPt(vt, x2, y2)] as [number, number, number, number]);
      const overlaps = (c: { x: number; y: number; w: number; h: number }) =>
        page.objects.some((o) => o.type === "field" && o.x < c.x + c.w && c.x < o.x + o.w && o.y < c.y + c.h && c.y < o.y + o.h);
      const boxes = detectFieldCells(rules, text.runs, page.width, page.height).filter((c) => !overlaps(c));
      // 下線だけの記入欄：線で引いたもの、と「＿＿＿」のように文字で書いたもの
      const lines = detectUnderlineFields(rules, text.runs, boxes).filter((c) => !overlaps(c));
      const typed: FieldCandidate[] = [];
      for (const run of text.runs) {
        const ms = findMatches(run.text, /[_＿]{3,}/u);
        if (!ms.length) continue;
        const found = await matchBoxes(src, page, run, ms).catch(() => null);
        ms.forEach((m, k) => {
          const b = found?.[k];
          if (!b) return;
          const height = Math.max(12, run.fontSize * 1.5);
          const cell = { x: b.x, y: b.y + b.h - height, w: b.w, h: height };
          if (overlaps(cell) || [...boxes, ...lines, ...typed].some((c) => c.x < cell.x + cell.w && cell.x < c.x + c.w && c.y < cell.y + cell.h && cell.y < c.y + c.h)) return;
          const label = run.text.slice(0, m.start).replace(/[_＿]+/gu, " ").trim().split(/\s+/).pop()?.replace(/[：:]+$/u, "") ?? "";
          typed.push({ ...cell, label });
        });
      }
      // ページの上から順（同じ高さなら左から）に並べる（名前の番号や、入力欄の順がページの並びと合うように）
      const cells = [...boxes, ...lines, ...typed].sort((a, b) => (Math.abs(a.y - b.y) > 4 ? a.y - b.y : a.x - b.x));
      let n = page.objects.filter((o) => o.type === "field").length;
      const made: FieldObj[] = cells.map((c) => {
        const inset = Math.min(2, c.h * 0.1);
        return { id: uid(), type: "field", kind: c.h > 30 ? "multiline" : "text", name: c.label || t("field.defaultName", { n: ++n }), x: c.x + inset, y: c.y + inset, w: c.w - inset * 2, h: c.h - inset * 2, options: [] };
      });
      if (made.length) updateObjects((objs) => [...objs, ...made]);
      p.onInfo?.(made.length ? t("field.detected", { n: made.length }) : t("field.detectedNone"));
    } catch (e) {
      p.onError(e);
    } finally {
      setDetecting(false);
    }
  };

  const updateObjects = useCallback(
    (fn: (objs: EditObj[]) => EditObj[], record: HistRecord = true) => {
      p.update((prev) => prev.map((x) => (x.id === page.id ? { ...x, objects: fn(x.objects) } : x)), record);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.update, page.id],
  );

  const insertImage = useCallback(
    async (file: File, wantWidth?: number) => {
      try {
        const img = await loadImageFile(file);
        images.set(img.id, img);
        const maxW = page.width * 0.5;
        const maxH = page.height * 0.5;
        let w = img.width * 0.75; // px → pt（96dpi 想定）
        let h = img.height * 0.75;
        // 幅の指定があれば（署名など）、その幅にする
        const k = wantWidth ? Math.min(wantWidth / w, maxW / w, maxH / h) : Math.min(1, maxW / w, maxH / h);
        w *= k;
        h *= k;
        const o: ImageObj = {
          id: uid(),
          type: "image",
          x: (page.width - w) / 2,
          y: (page.height - h) / 2,
          w,
          h,
          imageId: img.id,
          opacity: 1,
        };
        updateObjects((objs) => [...objs, o]);
        setSelectedId(o.id);
        setTool("select");
      } catch (e) {
        p.onError(e);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [images, page.width, page.height, updateObjects],
  );

  /** 既存画像の差し替え：削除した画像と同じ枠に、縦横比を保って新しい画像を入れる */
  const replaceImage = useCallback(
    async (o: ImageEditObj, file: File) => {
      try {
        const img = await loadImageFile(file);
        images.set(img.id, img);
        const k = Math.min(o.w / img.width, o.h / img.height);
        const w = img.width * k;
        const h = img.height * k;
        const n: ImageObj = { id: uid(), type: "image", x: o.x + (o.w - w) / 2, y: o.y + (o.h - h) / 2, w, h, imageId: img.id, opacity: 1 };
        updateObjects((objs) => [...objs, n]);
        setSelectedId(n.id);
        setTool("select");
      } catch (e) {
        p.onError(e);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [images, updateObjects],
  );

  // 倍率を変えるとき、基準の点（指の中点・カーソル・選んでいるもの・画面の中央）の下にあった所が、変えたあとも同じ位置に来るようにする
  const zoomAnchor = useRef<{ x: number; y: number; u: number; v: number } | null>(null);
  const setAnchor = (x?: number, y?: number) => {
    const stage = stageRef.current;
    const pg = stage?.querySelector<HTMLElement>(".page-slot.current .page");
    if (!stage || !pg) return;
    if (x == null || y == null) {
      const sel = selectedId ? pg.querySelector<HTMLElement>(`[data-obj="${selectedId}"]`) : null;
      const sr = stage.getBoundingClientRect();
      const r = sel?.getBoundingClientRect();
      const visible = r && r.bottom > sr.top && r.top < sr.bottom && r.right > sr.left && r.left < sr.right;
      x = visible ? r.left + r.width / 2 : sr.left + sr.width / 2;
      y = visible ? r.top + r.height / 2 : sr.top + sr.height / 2;
    }
    const pr = pg.getBoundingClientRect();
    if (!pr.width || !pr.height) return;
    // 基準の点の、ページの中での位置（ページの幅・高さに対する割合）
    zoomAnchor.current = { x, y, u: (x - pr.left) / pr.width, v: (y - pr.top) / pr.height };
  };
  useLayoutEffect(() => {
    const a = zoomAnchor.current;
    zoomAnchor.current = null;
    const stage = stageRef.current;
    const pg = stage?.querySelector<HTMLElement>(".page-slot.current .page");
    if (!a || !stage || !pg) return;
    const pr = pg.getBoundingClientRect();
    stage.scrollLeft += pr.left + a.u * pr.width - a.x;
    stage.scrollTop += pr.top + a.v * pr.height - a.y;
  }, [zoom]);

  const stepZoom = (dir: 1 | -1) => {
    const cur = zoom;
    const next = dir > 0 ? ZOOMS.find((z) => z > cur + 0.001) : [...ZOOMS].reverse().find((z) => z < cur - 0.001);
    if (next) {
      setAnchor();
      setZoomMode(next);
    }
  };
  const stepZoomRef = useRef(stepZoom);
  stepZoomRef.current = stepZoom;

  // ページ送り（PageDown / PageUp）：押した回数を数えておき、画面の 1 回の描き直しごとにまとめて送る。
  // 押すたびに送ると、すばやく続けて押したときに更新が重なって止まる（React の更新の深さの上限）うえ、押した回数より少なく進む
  const pageStep = useRef({ delta: 0, frame: 0 });
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  // 送った先のページ（画面がまだ追いついていなくても、次の送りはここから数える）
  const currentRef = useRef(p.currentId);
  const lastSeen = useRef(p.currentId);
  if (lastSeen.current !== p.currentId) {
    lastSeen.current = p.currentId;
    currentRef.current = p.currentId;
  }
  const stepPage = useCallback(
    (d: number) => {
      const st = pageStep.current;
      st.delta += d;
      if (st.frame) return;
      st.frame = requestAnimationFrame(() => {
        const list = pagesRef.current;
        const from = list.findIndex((x) => x.id === currentRef.current);
        const to = Math.max(0, Math.min(list.length - 1, from + st.delta));
        st.delta = 0;
        st.frame = 0;
        if (to !== from && list[to]) {
          currentRef.current = list[to].id;
          p.setCurrentId(list[to].id);
        }
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ショートカット・貼り付け
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      // ダイアログを開いている間は、後ろの編集画面の道具を切り替えない
      if (document.querySelector(".modal-back")) return;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && ["+", "=", ";", "-", "0"].includes(e.key)) {
        // ブラウザ全体の拡大ではなく、ページの表示倍率を変える
        e.preventDefault();
        if (e.key === "0") setZoomMode("fit");
        else stepZoomRef.current(e.key === "-" ? -1 : 1);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tl = TOOLS.find((x) => x.key === e.key.toLowerCase());
      if (tl) {
        setTool(tl.id);
        return;
      }
      if (e.key === "PageDown" || e.key === "PageUp") {
        e.preventDefault();
        stepPage(e.key === "PageDown" ? 1 : -1);
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName))) return;
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
      if (file) {
        e.preventDefault();
        insertImage(file);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("paste", onPaste);
    };
  }, [index, pages, insertImage, p]);

  /** ピンチ操作：現在の倍率に係数を掛ける（0.1〜6 に制限） */
  const pinchZoom = useCallback(
    (factor: number, x?: number, y?: number) => {
      setAnchor(x, y);
      setZoomMode((m) => {
        const cur = m === "fit" ? fitZoom : m;
        return Math.max(0.1, Math.min(6, cur * factor));
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fitZoom, selectedId],
  );

  // Ctrl（⌘）＋ホイール・トラックパッドのピンチ：ページの表示倍率を変える（ブラウザ全体は拡大しない）
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      pinchZoom(Math.exp(-Math.max(-60, Math.min(60, e.deltaY)) * 0.004), e.clientX, e.clientY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [pinchZoom]);

  // スマホ：文字を選んだら、画面上の文字が読みやすい大きさ（14px）になるまで拡大する。ただし行の幅が画面の幅を超えない倍率までにする
  // （超えると、行の一部しか見えなくなる）。それでも 8px 未満なら、行の幅にかかわらず 11px まで拡大する。
  // すでに十分大きければ倍率は変えない（続けて別の行を選ぶたびに倍率が変わらないように）
  useEffect(() => {
    if (!narrow || !selectedId) return;
    const o = page.objects.find((x) => x.id === selectedId);
    if (!o || (o.type !== "textedit" && o.type !== "text")) return;
    const stage = stageRef.current;
    const el = stage?.querySelector<HTMLElement>(`[data-obj="${selectedId}"]`);
    const cur = zoomMode === "fit" ? fitZoom : zoomMode;
    const lineW = el ? el.getBoundingClientRect().width / cur : 0;
    const fitLine = stage && lineW > 0 ? (stage.clientWidth - 24) / lineW : Infinity;
    let next = Math.max(cur, Math.min(14 / o.fontSize, fitLine));
    if (cur * o.fontSize < 8) next = Math.max(next, 11 / o.fontSize);
    next = Math.min(4, next);
    if (next > cur * 1.05) {
      setAnchor();
      setZoomMode(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, narrow]);

  // 2 本指のピンチ：touch イベントで距離の変化を倍率にする（1 本指はブラウザのスクロールに任せる）
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let d0 = 0;
    let mid: [number, number] | null = null;
    const dist = (e: TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    const center = (e: TouchEvent): [number, number] => [(e.touches[0].clientX + e.touches[1].clientX) / 2, (e.touches[0].clientY + e.touches[1].clientY) / 2];
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        d0 = dist(e);
        mid = center(e);
        e.preventDefault();
      }
    };
    const onMove = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      // 2 本指で動かす：指の中点が動いた分だけ送る（ここでブラウザのスクロールを止めているので、自分で送る。
      // 描く道具では 1 本指は描くのに使うため、ページを動かす手段はこれだけになる）。
      // ブラウザがもうスクロールを始めているとき（止められないとき）は、二重に動かさない
      const c = center(e);
      if (mid && e.cancelable) {
        el.scrollLeft -= c[0] - mid[0];
        el.scrollTop -= c[1] - mid[1];
      }
      mid = c;
      e.preventDefault();
      const d = dist(e);
      if (d0 > 0 && d > 0 && Math.abs(d / d0 - 1) > 0.02) {
        pinchZoom(d / d0, (e.touches[0].clientX + e.touches[1].clientX) / 2, (e.touches[0].clientY + e.touches[1].clientY) / 2);
        d0 = d;
      }
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        d0 = 0;
        mid = null;
      }
    };
    el.addEventListener("touchstart", onStart, { passive: false });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [pinchZoom]);


  const selected = selectedId ? page.objects.find((o) => o.id === selectedId) : undefined;
  const activeTool = TOOLS.find((t) => t.id === tool)!;
  // スマホ：道具は横に送らず、よく使うもの（と、いま選んでいる道具）だけを並べ、残りは「その他」の一覧から選ぶ
  const [moreTools, setMoreTools] = useState(false);
  const shownTools = narrow ? TOOLS.filter((tl) => FREQUENT.includes(tl.id) || tl.id === tool) : TOOLS;
  // 広い画面：道具は 1 段に並べ、入りきらない分は（横に送って隠すのではなく）「その他」の一覧から選ぶ。
  // 並びは折り返しにして 1 段分の高さで切り、2 段目に落ちた道具（＝入りきらなかった道具）を調べる。
  // 言語によって名前の幅が大きく違うので、幅は決め打ちにせず、置いた結果を見る
  const groupRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState<string[]>([]);
  useLayoutEffect(() => {
    const el = groupRef.current;
    if (!el || narrow) {
      el?.style.removeProperty("height");
      setOverflow((prev) => (prev.length ? [] : prev));
      return;
    }
    const measure = () => {
      const items = [...el.querySelectorAll<HTMLElement>("[data-fit]")];
      if (!items.length) return;
      const top = Math.min(...items.map((x) => x.offsetTop));
      const row = Math.max(...items.filter((x) => x.offsetTop < top + 4).map((x) => x.offsetHeight));
      el.style.height = `${row}px`;
      const next = items.filter((x) => x.offsetTop > top + 4).map((x) => x.dataset.fit ?? "");
      setOverflow((prev) => (prev.length === next.length && prev.every((x, i) => x === next[i]) ? prev : next));
    };
    measure();
    // 測ったあとに並びの高さを変えるので、大きさの知らせの中ではなく、次の描画の前に測り直す
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [narrow, t, tool]);
  const hiddenTool = !narrow && overflow.includes(tool) ? activeTool : null;
  // 一覧の外を押したら閉じる。Esc でも閉じる（そのときは一覧を閉じるだけにして、後ろのページの選択や道具は変えない。
  // 開いている間だけ、ほかのキーの処理より先に受け取る）
  useEffect(() => {
    if (!moreTools) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.(".tool-sheet, .tool[aria-expanded]")) setMoreTools(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setMoreTools(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [moreTools]);
  useEffect(() => {
    if (!narrow && !overflow.length) setMoreTools(false);
  }, [narrow, overflow.length]);
  // つまみをなぞってパネルを開閉する（下に付くときは上下、横に付くときは左右）
  const gripDrag = useRef<{ x: number; y: number; swiped: boolean } | null>(null);
  const closePanel = (closed: boolean) => {
    userClosed.current = closed;
    setPanelClosed(closed);
  };

  return (
    <div className={`editor ${typing ? "typing" : ""}`}>
      <aside className="strip" ref={stripRef}>
        {pages.map((pg, i) => (
          <button key={pg.id} className={`strip-item ${pg.id === currentId ? "on" : ""}`} onClick={() => goToPage(pg.id)}>
            <Thumb page={pg} source={pg.srcId ? sources.get(pg.srcId) : undefined} size={96} />
            <span>
              {i + 1}
              {pg.objects.length > 0 && <i className="dot" title={t("org.editedBadge")} />}
            </span>
          </button>
        ))}
      </aside>

      <section className="workspace">
        <div className={`toolbar ${narrow ? "" : "fit"}`}>
          <div className="tool-group" ref={groupRef}>
            {shownTools.map((tl, i) => {
              // 入りきらずに隠れている道具は、Tab でも止まらないようにする（「その他」から選ぶ）
              const off = overflow.includes(tl.id);
              return (
                <span key={tl.id} className={`tool-wrap ${off ? "off" : ""}`} data-fit={tl.id} aria-hidden={off || undefined}>
                  {!narrow && i > 0 && TOOLS[i - 1].group !== tl.group && <span className="divider" />}
                  <button className={`tool ${tool === tl.id ? "on" : ""}`} data-tool={tl.id} onClick={() => setTool(tl.id)} title={`${t(tl.tip)} (${tl.key.toUpperCase()})`} aria-pressed={tool === tl.id} tabIndex={off ? -1 : undefined}>
                    <Icon name={tl.icon} />
                    <span>{t(tl.label)}</span>
                  </button>
                </span>
              );
            })}
            {!narrow && (
              <>
                <button className={`tool ${overflow.includes("image") ? "off" : ""}`} data-fit="image" data-tool="image" onClick={() => imageInput.current?.click()} title={t("tool.image.tip")} tabIndex={overflow.includes("image") ? -1 : undefined} aria-hidden={overflow.includes("image") || undefined}>
                  <Icon name="image" />
                  <span>{t("tool.image")}</span>
                </button>
                <button className={`tool ${overflow.includes("sign") ? "off" : ""}`} data-fit="sign" data-tool="sign" onClick={() => setSigning(true)} title={t("tool.sign.tip")} tabIndex={overflow.includes("sign") ? -1 : undefined} aria-hidden={overflow.includes("sign") || undefined}>
                  <Icon name="sign" />
                  <span>{t("tool.sign")}</span>
                </button>
              </>
            )}
            {narrow && (
              <button className={`tool ${moreTools ? "on" : ""}`} aria-pressed={moreTools} onClick={() => setMoreTools((v) => !v)} aria-expanded={moreTools} title={t("tool.more")}>
                <Icon name="grid" />
                <span>{t("tool.more")}</span>
              </button>
            )}
          </div>
          {!narrow && overflow.length > 0 && (
            // 入りきらない道具があるときだけ出す。隠れている道具を使っている間は、その道具の絵と名前を出す（いまの道具が分かるように）
            <button className={`tool more ${moreTools || hiddenTool ? "on" : ""}`} data-more onClick={() => setMoreTools((v) => !v)} aria-expanded={moreTools} title={t("tool.more")} aria-label={hiddenTool ? `${t("tool.more")} (${t(hiddenTool.label)})` : undefined}>
              <Icon name={hiddenTool ? hiddenTool.icon : "grid"} />
              <span>{hiddenTool ? t(hiddenTool.label) : t("tool.more")}</span>
            </button>
          )}
          {moreTools && (
            <>
              <div className="tool-sheet-back" onClick={() => setMoreTools(false)} />
              <div className="tool-sheet" role="dialog" aria-label={t("tool.more")}>
                {TOOLS.map((tl) => (
                  <button
                    key={tl.id}
                    className={`tool ${tool === tl.id ? "on" : ""}`}
                    data-tool={tl.id}
                    onClick={() => {
                      setTool(tl.id);
                      setMoreTools(false);
                    }}
                    aria-pressed={tool === tl.id}
                  >
                    <Icon name={tl.icon} />
                    <span>{t(tl.label)}</span>
                  </button>
                ))}
                <button
                  className="tool"
                  onClick={() => {
                    setMoreTools(false);
                    imageInput.current?.click();
                  }}
                >
                  <Icon name="image" />
                  <span>{t("tool.image")}</span>
                </button>
                <button
                  className="tool"
                  data-tool="sign"
                  onClick={() => {
                    setMoreTools(false);
                    setSigning(true);
                  }}
                >
                  <Icon name="sign" />
                  <span>{t("tool.sign")}</span>
                </button>
              </div>
            </>
          )}
          {narrow && tool === "measure" && (
            <div className="seg small" role="group">
              {(["distance", "path", "area"] as const).map((k) => (
                <button
                  key={k}
                  className={measureKind === k ? "on" : ""}
                  aria-pressed={measureKind === k}
                  onClick={() => {
                    DEFAULTS.measure.kind = k;
                    setMeasureKind(k);
                  }}
                >
                  {t(k === "area" ? "measure.area" : k === "path" ? "measure.path" : "measure.distance")}
                </button>
              ))}
            </div>
          )}
          {narrow && tool === "field" && (
            <div className="tool-band">
              <button className="btn small" disabled={detecting || !page.srcId} onClick={() => void detectFields()}>
                {t("field.detect")}
              </button>
            </div>
          )}
          {narrow && tool === "edit-text" && (
            <div className="seg small" role="group">
              <button className={unit === "line" ? "on" : ""} aria-pressed={unit === "line"} onClick={() => setUnit("line")} title={t("tool.unitLine.tip")}>
                {t("tool.unitLine")}
              </button>
              <button className={unit === "block" ? "on" : ""} aria-pressed={unit === "block"} onClick={() => setUnit("block")} title={t("tool.unitBlock.tip")}>
                {t("tool.unitBlock")}
              </button>
              <button className={unit === "range" ? "on" : ""} aria-pressed={unit === "range"} onClick={() => setUnit("range")} title={t("tool.unitRange.tip")}>
                {t("tool.unitRange")}
              </button>
            </div>
          )}
        </div>
        {!narrow && (
          <div className="toolbar-sub">
            {tool === "edit-text" && (
              <div className="seg small" role="group">
                <button className={unit === "line" ? "on" : ""} aria-pressed={unit === "line"} onClick={() => setUnit("line")} title={t("tool.unitLine.tip")}>
                  {t("tool.unitLine")}
                </button>
                <button className={unit === "block" ? "on" : ""} aria-pressed={unit === "block"} onClick={() => setUnit("block")} title={t("tool.unitBlock.tip")}>
                  {t("tool.unitBlock")}
                </button>
                <button className={unit === "range" ? "on" : ""} aria-pressed={unit === "range"} onClick={() => setUnit("range")} title={t("tool.unitRange.tip")}>
                  {t("tool.unitRange")}
                </button>
              </div>
            )}
            {tool === "measure" && (
              <div className="seg small" role="group">
                {(["distance", "path", "area"] as const).map((k) => (
                  <button
                    key={k}
                    className={measureKind === k ? "on" : ""}
                    aria-pressed={measureKind === k}
                    onClick={() => {
                      DEFAULTS.measure.kind = k;
                      setMeasureKind(k);
                    }}
                  >
                    {t(k === "area" ? "measure.area" : k === "path" ? "measure.path" : "measure.distance")}
                  </button>
                ))}
              </div>
            )}
            {tool === "field" && (
              <button className="btn small" disabled={detecting || !page.srcId} onClick={() => void detectFields()}>
                {t("field.detect")}
              </button>
            )}
            <div className="tool-tip">{t(activeTool.tip)}</div>
            <div className="zoom">
              <button className="icon-btn" onClick={() => stepZoom(-1)} title={t("zoom.out")}>
                <Icon name="zoom-out" />
              </button>
              <button className="zoom-val" onClick={onZoomValue} title={zoomValueTitle}>
                {Math.round(zoom * 100)}%
              </button>
              <button className="icon-btn" onClick={() => stepZoom(1)} title={t("zoom.in")}>
                <Icon name="zoom-in" />
              </button>
            </div>
            <div className="pager">
              <button className="icon-btn" disabled={index === 0} onClick={() => goToPage(pages[index - 1].id)} title={t("page.prev")}>
                <span style={{ transform: "scaleX(-1)", display: "inline-flex" }}>
                  <Icon name="chevron" />
                </span>
              </button>
              <span dir="ltr">
                {index + 1} / {pages.length}
              </span>
              <button className="icon-btn" disabled={index === pages.length - 1} onClick={() => goToPage(pages[index + 1].id)} title={t("page.next")}>
                <Icon name="chevron" />
              </button>
            </div>
          </div>
        )}
        {narrow && (
          <div className="toolbar-row2">
            <button className="btn ghost back" onClick={p.onBack} title={t("top.organize")} aria-label={t("top.organize")}>
              <span className="flip"><Icon name="chevron" /></span> <span className="back-label">{t("top.organize")}</span>
            </button>
            <div className="pager">
              <button className="icon-btn" disabled={index === 0} onClick={() => goToPage(pages[index - 1].id)} title={t("page.prev")}>
                <span style={{ transform: "scaleX(-1)", display: "inline-flex" }}>
                  <Icon name="chevron" />
                </span>
              </button>
              <span dir="ltr">
                {index + 1} / {pages.length}
              </span>
              <button className="icon-btn" disabled={index === pages.length - 1} onClick={() => goToPage(pages[index + 1].id)} title={t("page.next")}>
                <Icon name="chevron" />
              </button>
            </div>
            <div className="spacer" />
            <div className="zoom">
              <button className="icon-btn" onClick={() => stepZoom(-1)} title={t("zoom.out")}>
                <Icon name="zoom-out" />
              </button>
              <button className="zoom-val" onClick={onZoomValue} title={zoomValueTitle}>
                {Math.round(zoom * 100)}%
              </button>
              <button className="icon-btn" onClick={() => stepZoom(1)} title={t("zoom.in")}>
                <Icon name="zoom-in" />
              </button>
            </div>
          </div>
        )}

        {picking && (
          // スポイト：ページのどこを見ていても読めるよう、表示領域の上に重ねて出す
          <div className="pick-hint" role="status">
            <Icon name="pipette" /> {t("color.pickHint")}
            <button className="btn small ghost" onClick={() => colorPick.cancel()}>
              {t("common.close")}
            </button>
          </div>
        )}
        {/* 範囲で選んだ行の操作バーを出す場所（ページの中に置くと端で切れるので、表示領域の上の帯に出す） */}
        <div className="range-slot" />
        {touchDraws(tool, unit) && (
          // 指で操作する端末：描く道具では 1 本指はスクロールにならないので、動かし方を短く知らせる（少し経つと消える）
          <div className="stage-hints">
            <div key={tool} className="touch-hint" role="status">
              {t("touch.drawHint")}
            </div>
          </div>
        )}
        <div
          className="stage continuous"
          ref={stageRef}
          // キーボードでもスクロールできるように（矢印・PageUp/PageDown）
          tabIndex={0}
          role="region"
          aria-label={t("top.edit")}
          onScroll={onStageScroll}
          onPointerDownCapture={(e) => {
            if ((e.target as Element).closest?.(".page")) held.current.down = true;
          }}
        >
          {pages.map((pg) => {
            const swap = pg.extraRotation % 180 !== 0;
            const current = pg.id === page.id;
            return (
              <div key={pg.id} className={`page-slot ${current ? "current" : ""}`} data-page-id={pg.id} style={{ width: (swap ? pg.height : pg.width) * zoom, height: (swap ? pg.width : pg.height) * zoom }}>
                {current ? (
                  <PageEditor
                    key={pg.id}
                    page={page}
                    source={source}
                    images={images}
                    zoom={zoom}
                    tool={tool}
                    setTool={setTool}
                    selectedId={selectedId}
                    setSelectedId={setSelectedId}
                    editingId={editingId}
                    setEditingId={setEditingId}
                    updateObjects={updateObjects}
                    checkpoint={p.checkpoint}
                    unit={unit}
                    inlineEditing={!narrow}
                    onPinchZoom={pinchZoom}
                    onDrafting={setDrafting}
                  />
                ) : (
                  <PageView page={pg} source={pg.srcId ? sources.get(pg.srcId) : undefined} images={images} zoom={zoom} near={near.has(pg.id)} draws={touchDraws(tool, unit)} onActivate={() => goToPage(pg.id, false)} />
                )}
                {flash && flash.pageId === pg.id && <div className="annot-flash" style={{ left: flash.rect.x * zoom - 4, top: flash.rect.y * zoom - 4, width: flash.rect.w * zoom + 8, height: flash.rect.h * zoom + 8 }} />}
              </div>
            );
          })}
        </div>
      </section>

      <aside ref={propsRef} tabIndex={0} aria-label={t("props.label")} className={`props ${selected ? "" : "idle"} ${narrow && panelClosed ? "collapsed" : ""}`}>
        {typing && (
          // 入力中だけ出す短い帯：書式などを開く（入力を終えてパネルを全部出す）／完了（入力を終えてパネルをたたむ）
          <div className="typing-bar">
            <button type="button" className="btn small ghost" onMouseDown={(e) => e.preventDefault()} onClick={() => (document.activeElement as HTMLElement | null)?.blur()}>
              {t("typing.more")}
            </button>
            <span className="spacer" />
            <button
              type="button"
              className="btn small primary"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                (document.activeElement as HTMLElement | null)?.blur();
                setPanelClosed(true);
              }}
            >
              {t("typing.done")}
            </button>
          </div>
        )}
        {narrow && selected && (
          // スマホ：パネルをたたんで、文書を広く見られるようにする（つまみをタップで開閉）
          <button
            className="props-grip"
            aria-expanded={!panelClosed}
            aria-label={panelClosed ? t("pw.open") : t("common.close")}
            onPointerDown={(e) => {
              gripDrag.current = { x: e.clientX, y: e.clientY, swiped: false };
              try {
                e.currentTarget.setPointerCapture(e.pointerId);
              } catch {
                /* つかめなくても、押せば開閉できる */
              }
            }}
            onPointerUp={(e) => {
              const g = gripDrag.current;
              if (!g) return;
              const side = window.matchMedia(SIDE_QUERY).matches;
              const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
              // たたむ向き：下に付くときは下へ、横に付くときは外側（左から右の言語では右）へ
              const along = side ? (e.clientX - g.x) * (rtl ? -1 : 1) : e.clientY - g.y;
              if (Math.abs(along) < 14) return;
              g.swiped = true;
              closePanel(along > 0);
            }}
            onPointerCancel={() => {
              gripDrag.current = null;
            }}
            onClick={() => {
              const g = gripDrag.current;
              gripDrag.current = null;
              // なぞって開閉した直後のクリックでは、もう一度切り替えない
              if (!g?.swiped) closePanel(!panelClosed);
            }}
          >
            <span className="grip-bar" />
            <span className={`grip-chevron ${panelClosed ? "up" : ""}`}>
              <Icon name="chevron" />
            </span>
          </button>
        )}
        {selected ? (
          <PropertiesPanel
            key={selected.id}
            obj={selected}
            images={images}
            source={source}
            page={page}
            updateObjects={updateObjects}
            onDeselect={() => setSelectedId(null)}
            onReplaceImage={replaceImage}
            focusText={narrow}
            pages={pages}
          />
        ) : (
          <div className="props-body help">
            <h3>{t("help.title")}</h3>
            <ul>
              <li>{t("help.text")}</li>
              <li>{t("help.editText")}</li>
              <li>{t("help.orange")}</li>
              <li>{t("help.shapes")}</li>
              <li>{t("help.image")}</li>
              <li>{t("help.annots")}</li>
              <li>{t("help.redact")}</li>
              <li>{t("help.sign")}</li>
              <li>{t("help.more")}</li>
              <li>{t("help.find")}</li>
              <li>{t("help.view")}</li>
              <li>{t("help.keys")}</li>
            </ul>
            <p className="note">{t("help.note")}</p>
          </div>
        )}
      </aside>

      <input
        ref={imageInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) insertImage(f);
        }}
      />
      {signing && (
        <SignatureDialog
          onClose={() => setSigning(false)}
          onPlace={(file, widthPt) => {
            setSigning(false);
            void insertImage(file, widthPt);
          }}
          onPlaceApproval={(headings) => {
            setSigning(false);
            // ページの中央より少し下（署名欄は文書の下のほうに置くことが多い）。動かして位置を合わせる
            const box = newApproval({ id: uid(), type: "stamp", color: "#222222", font: defaultFont("sans"), fontSize: 10, opacity: 1 }, page.width / 2, page.height * 0.62, headings);
            updateObjects((objs) => [...objs, box]);
            setSelectedId(box.id);
            setTool("select");
          }}
        />
      )}
    </div>
  );
}

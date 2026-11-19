import { askConfirm } from "@/lib/confirm";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { normRot, uid } from "@/lib/geometry";
import { useT } from "@/lib/i18n";
import type { PageItem, SourceDoc } from "@/lib/types";
import { Icon } from "./Icon";
import { Thumb } from "./Thumb";

interface Props {
  pages: PageItem[];
  sources: Map<string, SourceDoc>;
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  update: (fn: (p: PageItem[]) => PageItem[], record?: boolean) => void;
  onAddFiles: (files: File[], insertAt?: number) => void;
  onPickFiles: (insertAt?: number) => void;
  onAddBlank: (at: number) => void;
  onOpenEditor: (id: string) => void;
  onExtract: (pages: PageItem[]) => void;
  onSplit: () => void;
  editedCount: number;
  /** 編集画面で開いているページ（戻ってきたときに分かるように印を付ける） */
  currentId: string | null;
}

const PAGE_MIME = "application/x-washipdf-page";

export function OrganizeView(p: Props) {
  const { pages, sources, selected, setSelected, update } = p;
  const t = useT();
  const anchor = useRef<string | null>(null);
  const dragIds = useRef<string[]>([]);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  /** 最後にタップしたカード（タッチ端末ではこのカードにだけ操作ボタンを出す） */
  const [lastTapped, setLastTapped] = useState<string | null>(null);
  /** タッチ端末か（長押しで並べ替える。マウスでは HTML5 のドラッグ） */
  const coarse = typeof window !== "undefined" && window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  /** 長押しドラッグ中のカード */
  const [dragging, setDragging] = useState<string | null>(null);
  const press = useRef<{ id: string; x: number; y: number; timer: number; pointerId: number; el: HTMLElement } | null>(null);
  const touchDrag = useRef<{ ids: string[]; dropIndex: number | null } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // 長押しドラッグ中は 1 本指のスクロールを止める
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const onMove = (e: TouchEvent) => {
      if (touchDrag.current) e.preventDefault();
    };
    el.addEventListener("touchmove", onMove, { passive: false });
    return () => el.removeEventListener("touchmove", onMove);
  }, []);

  const dropIndexAt = (x: number, y: number): number => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>(".card[data-index]");
    if (!el) {
      // カードの外：下端より下なら末尾、上なら先頭
      const g = gridRef.current?.getBoundingClientRect();
      return g && y > g.bottom - 40 ? pages.length : 0;
    }
    const i = Number(el.dataset.index);
    const r = el.getBoundingClientRect();
    return x < r.left + r.width / 2 ? i : i + 1;
  };
  const endTouchDrag = (commit: boolean) => {
    const d = touchDrag.current;
    touchDrag.current = null;
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
    setDragging(null);
    setDropIndex(null);
    if (commit && d && d.dropIndex != null) moveTo(d.ids, d.dropIndex);
  };
  const onCardPointerDown = (e: React.PointerEvent, id: string) => {
    if (!coarse || e.pointerType !== "touch") return;
    if ((e.target as Element).closest(".card-actions")) return;
    const el = e.currentTarget as HTMLElement;
    const timer = window.setTimeout(() => {
      // 長押し成立：選択中のカードならまとめて動かす
      const ids = selected.has(id) ? pages.filter((x) => selected.has(x.id)).map((x) => x.id) : [id];
      touchDrag.current = { ids, dropIndex: null };
      setDragging(id);
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
      (navigator as { vibrate?: (ms: number) => void }).vibrate?.(15);
    }, 420);
    press.current = { id, x: e.clientX, y: e.clientY, timer, pointerId: e.pointerId, el };
  };
  const onCardPointerMove = (e: React.PointerEvent) => {
    const p = press.current;
    if (!p) return;
    if (!touchDrag.current) {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) {
        window.clearTimeout(p.timer);
        press.current = null;
      }
      return;
    }
    const idx = dropIndexAt(e.clientX, e.clientY);
    touchDrag.current.dropIndex = idx;
    setDropIndex(idx);
    // 端に近づいたら自動でスクロール
    const sc = gridRef.current;
    if (sc) {
      const r = sc.getBoundingClientRect();
      if (e.clientY < r.top + 70) sc.scrollTop -= 10;
      else if (e.clientY > r.bottom - 70) sc.scrollTop += 10;
    }
  };
  const onCardPointerUp = (e: React.PointerEvent) => {
    if (!press.current && !touchDrag.current) return;
    const wasDrag = !!touchDrag.current;
    endTouchDrag(true);
    if (wasDrag) e.preventDefault();
  };
  const multiSource = new Set(pages.map((x) => x.srcId)).size > 1;

  // 編集画面から戻ってきたら、開いていたページが見える位置まで送る
  useEffect(() => {
    const el = document.querySelector<HTMLElement>(".card.current");
    el?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selIds = pages.filter((x) => selected.has(x.id)).map((x) => x.id);
  const hasSel = selIds.length > 0;
  const lastSelIndex = hasSel ? Math.max(...selIds.map((id) => pages.findIndex((x) => x.id === id))) : pages.length - 1;

  // キーボード：Ctrl+A ですべて選択、Esc で選択解除、Delete で選択ページを削除
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e) => {
    const el = e.target as HTMLElement | null;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
    if (document.querySelector(".modal-back")) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSelected(new Set(pages.map((x) => x.id)));
    } else if (e.key === "Escape" && hasSel) {
      setSelected(new Set());
    } else if ((e.key === "Delete" || e.key === "Backspace") && hasSel) {
      e.preventDefault();
      remove(selIds);
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onCardClick = (e: React.MouseEvent, id: string) => {
    const idx = pages.findIndex((x) => x.id === id);
    if (e.shiftKey && anchor.current) {
      const a = pages.findIndex((x) => x.id === anchor.current);
      const [s, t] = a < idx ? [a, idx] : [idx, a];
      const n = new Set(e.ctrlKey || e.metaKey ? selected : []);
      pages.slice(s, t + 1).forEach((x) => n.add(x.id));
      setSelected(n);
      return;
    }
    const n = new Set(selected);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    anchor.current = id;
    setLastTapped(id);
    setSelected(n);
  };

  const rotate = (ids: string[], delta: number) =>
    update((prev) => prev.map((x) => (ids.includes(x.id) ? { ...x, extraRotation: normRot(x.extraRotation + delta) } : x)));

  const remove = async (ids: string[]) => {
    if (!(await askConfirm(ids.length >= pages.length ? t("org.deleteAllConfirm") : t("org.deleteConfirm", { n: ids.length }), t("common.delete")))) return;
    update((prev) => prev.filter((x) => !ids.includes(x.id)));
  };

  const duplicate = (ids: string[]) =>
    update((prev) => {
      const out: PageItem[] = [];
      for (const x of prev) {
        out.push(x);
        if (ids.includes(x.id)) out.push({ ...x, id: uid("pg"), objects: x.objects.map((o) => ({ ...o, id: uid() })) });
      }
      return out;
    });

  /** 選択ページをまとめて前後に 1 つ動かす（タッチ端末ではドラッグの代わり） */
  const moveBy = (ids: string[], dir: -1 | 1) => {
    const idx = pages.map((x, i) => (ids.includes(x.id) ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) return;
    const first = Math.min(...idx);
    const last = Math.max(...idx);
    const target = dir < 0 ? first - 1 : last + 2;
    if (target < 0 || target > pages.length) return;
    moveTo(ids, target);
  };

  const moveTo = (ids: string[], index: number) =>
    update((prev) => {
      const moving = prev.filter((x) => ids.includes(x.id));
      if (!moving.length) return prev;
      const before = prev.slice(0, index).filter((x) => ids.includes(x.id)).length;
      const rest = prev.filter((x) => !ids.includes(x.id));
      const at = index - before;
      const next = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
      return next.every((x, i) => x === prev[i]) ? prev : next;
    });

  const onDragOverCard = (e: React.DragEvent, index: number) => {
    const t = e.dataTransfer.types;
    if (!t.includes(PAGE_MIME) && !t.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDropIndex(e.clientX < r.left + r.width / 2 ? index : index + 1);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const at = dropIndex ?? pages.length;
    setDropIndex(null);
    if (e.dataTransfer.files.length) {
      p.onAddFiles([...e.dataTransfer.files], at);
    } else if (e.dataTransfer.types.includes(PAGE_MIME)) {
      moveTo(dragIds.current, at);
    }
    dragIds.current = [];
  };

  return (
    <div className="organize">
      <div className="subbar">
        <span className="muted">
          {t("common.pages", { n: pages.length })}
          {hasSel && <> · {t("org.selected", { n: selIds.length })}</>}
          {p.editedCount > 0 && <> · {t("org.edited", { n: p.editedCount })}</>}
        </span>
        <div className="spacer" />
        {hasSel ? (
          <>
            <button className="btn ghost" onClick={() => setSelected(new Set())}>
              {t("org.deselect")}
            </button>
            <button className="btn ghost" onClick={() => p.onOpenEditor(pages[lastSelIndex].id)} title={t("org.card.edit")}>
              <Icon name="pen" /> {t("org.card.edit")}
            </button>
            <button className="btn ghost compactable" onClick={() => rotate(selIds, -90)} title={t("org.rotateLeft")} aria-label={t("org.rotateLeft")}>
              <Icon name="rotate-ccw" /> <span className="label">{t("org.rotateLeft")}</span>
            </button>
            <button className="btn ghost compactable" onClick={() => rotate(selIds, 90)} title={t("org.rotateRight")} aria-label={t("org.rotateRight")}>
              <Icon name="rotate-cw" /> <span className="label">{t("org.rotateRight")}</span>
            </button>
            <button className="btn ghost compactable" onClick={() => moveBy(selIds, -1)} title={t("org.moveBackTip")} aria-label={t("org.moveBackTip")}>
              <span className="flip"><Icon name="chevron" /></span> <span className="label">{t("org.moveBack")}</span>
            </button>
            <button className="btn ghost compactable" onClick={() => moveBy(selIds, 1)} title={t("org.moveForwardTip")} aria-label={t("org.moveForwardTip")}>
              <Icon name="chevron" /> <span className="label">{t("org.moveForward")}</span>
            </button>
            <button className="btn ghost" onClick={() => duplicate(selIds)}>
              <Icon name="copy" /> {t("org.duplicate")}
            </button>
            <button className="btn ghost danger" onClick={() => remove(selIds)}>
              <Icon name="trash" /> {t("org.delete")}
            </button>
            <button className="btn ghost" onClick={() => p.onExtract(pages.filter((x) => selected.has(x.id)))}>
              <Icon name="download" /> {t("org.saveSelected")}
            </button>
          </>
        ) : (
          <button className="btn ghost" onClick={() => setSelected(new Set(pages.map((x) => x.id)))}>
            {t("org.selectAll")}
          </button>
        )}
        <span className="divider" />
        <button className="btn ghost" onClick={() => p.onAddBlank(lastSelIndex + 1)} title={t("org.insertBlankTip")}>
          <Icon name="file-plus" /> {t("org.insertBlank")}
        </button>
        <button className="btn ghost" onClick={() => p.onPickFiles(hasSel ? lastSelIndex + 1 : undefined)} title={t("org.insertPdfTip")}>
          <Icon name="plus" /> {t("org.insertPdf")}
        </button>
        <button className="btn ghost" onClick={p.onSplit} title={t("top.split")}>
          <Icon name="scissors" /> {t("top.split")}
        </button>
      </div>

      <p className="hint">
        <span className="hint-pointer">{t("org.hintPointer")}</span>
        <span className="hint-touch">{t("org.hintTouch")}</span>
      </p>

      <div
        className="grid"
        role="listbox"
        aria-multiselectable="true"
        aria-label={t("top.organize")}
        ref={gridRef}
        data-dropzone
        onDragOver={(e) => {
          const t = e.dataTransfer.types;
          if (!t.includes(PAGE_MIME) && !t.includes("Files")) return;
          e.preventDefault();
          if (e.target === e.currentTarget) setDropIndex(pages.length);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropIndex(null);
        }}
        onDrop={onDrop}
      >
        {pages.map((pg, i) => {
          const src = pg.srcId ? sources.get(pg.srcId) : undefined;
          const isSel = selected.has(pg.id);
          const cls = [
            "card",
            isSel ? "sel" : "",
            pg.id === lastTapped ? "last" : "",
            pg.id === p.currentId ? "current" : "",
            dragging && (pg.id === dragging || (selected.has(dragging) && isSel)) ? "dragging" : "",
            dropIndex === i ? "drop-before" : "",
            dropIndex === i + 1 && i === pages.length - 1 ? "drop-after" : "",
          ].join(" ");
          return (
            <div
              key={pg.id}
              className={cls}
              data-index={i}
              // キーボードでも選べるように：Tab で止まり、矢印で隣のページへ、Space / Enter で選ぶ・外す。
              // 止まっている間は操作ボタン（回す・前後へ動かす・編集・削除）が出て、続けて Tab で押せる
              tabIndex={0}
              role="option"
              aria-selected={isSel}
              aria-label={t("org.cardLabel", { n: i + 1 })}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return;
                if (e.key === " " || e.key === "Enter") {
                  e.preventDefault();
                  onCardClick(e as unknown as React.MouseEvent, pg.id);
                } else if (e.key.startsWith("Arrow")) {
                  const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
                  const back = e.key === "ArrowUp" || e.key === (rtl ? "ArrowRight" : "ArrowLeft");
                  const next = (back ? e.currentTarget.previousElementSibling : e.currentTarget.nextElementSibling) as HTMLElement | null;
                  if (next?.classList.contains("card")) {
                    e.preventDefault();
                    next.focus();
                  }
                }
              }}
              draggable={!coarse}
              onPointerDown={(e) => onCardPointerDown(e, pg.id)}
              onPointerMove={onCardPointerMove}
              onPointerUp={onCardPointerUp}
              onPointerCancel={() => endTouchDrag(false)}
              onContextMenu={(e) => {
                if (coarse) e.preventDefault();
              }}
              onDragStart={(e) => {
                dragIds.current = isSel ? selIds : [pg.id];
                e.dataTransfer.setData(PAGE_MIME, pg.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => setDropIndex(null)}
              onDragOver={(e) => onDragOverCard(e, i)}
              onDrop={onDrop}
              onClick={(e) => {
                if (dragging) return;
                onCardClick(e, pg.id);
              }}
              onDoubleClick={() => p.onOpenEditor(pg.id)}
            >
              <div className="card-thumb">
                <Thumb page={pg} source={src} />
                {pg.objects.length > 0 && <span className="badge">{t("org.editedBadge")}</span>}
                <span className={`check ${isSel ? "on" : ""}`} aria-hidden>
                  ✓
                </span>
                <div className="card-actions" onPointerDown={() => setLastTapped(pg.id)} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
                  <button title={t("org.rotateLeft")} className="pointer-only" onClick={() => rotate([pg.id], -90)}>
                    <Icon name="rotate-ccw" size={16} />
                  </button>
                  <button title={t("org.rotateRight")} onClick={() => rotate([pg.id], 90)}>
                    <Icon name="rotate-cw" size={16} />
                  </button>
                  <button title={t("org.moveBack")} className="touch-only" onClick={() => moveBy([pg.id], -1)} disabled={i === 0}>
                    <span className="flip"><Icon name="chevron" size={16} /></span>
                  </button>
                  <button title={t("org.moveForward")} className="touch-only" onClick={() => moveBy([pg.id], 1)} disabled={i === pages.length - 1}>
                    <Icon name="chevron" size={16} />
                  </button>
                  <button title={t("org.card.edit")} onClick={() => p.onOpenEditor(pg.id)}>
                    <Icon name="pen" size={16} />
                  </button>
                  <button title={t("org.delete")} className="danger" onClick={() => remove([pg.id])}>
                    <Icon name="trash" size={16} />
                  </button>
                </div>
              </div>
              <div className="card-label">
                <strong>{i + 1}</strong>
                {multiSource && <span className="src">{src ? `${src.name} p.${pg.srcIndex + 1}` : t("common.blank")}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** しおり（目次）の編集。平らな一覧＋階層の深さで持ち、ページは番号で指定する */
import { useState } from "react";
import { uid } from "@/lib/geometry";
import { useT } from "@/lib/i18n";
import type { OutlineItem } from "@/lib/outlines";
import type { PageItem } from "@/lib/types";
import { Dialog } from "../Dialog";
import { Icon } from "../Icon";

export function OutlineDialog({ outline, pages, onApply, onClose }: { outline: OutlineItem[]; pages: PageItem[]; onApply: (items: OutlineItem[]) => void; onClose: () => void }) {
  const t = useT();
  const [items, setItems] = useState<OutlineItem[]>(outline.map((o) => ({ ...o })));
  const [sel, setSel] = useState<string | null>(null);
  const pageNo = (id: string | null) => (id ? pages.findIndex((p) => p.id === id) + 1 : 0);
  const patch = (id: string, fn: (o: OutlineItem) => OutlineItem) => setItems((prev) => prev.map((o) => (o.id === id ? fn(o) : o)));
  const move = (id: string, dir: -1 | 1) =>
    setItems((prev) => {
      const i = prev.findIndex((o) => o.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const add = () => {
    const i = sel ? items.findIndex((o) => o.id === sel) : items.length - 1;
    const base = items[i];
    const n: OutlineItem = { id: uid("ol"), title: t("outline.newTitle"), pageId: base?.pageId ?? pages[0]?.id ?? null, level: base?.level ?? 0 };
    setItems((prev) => [...prev.slice(0, i + 1), n, ...prev.slice(i + 1)]);
    setSel(n.id);
  };
  return (
    <Dialog
      title={t("tool.outline")}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={add}>
            <Icon name="plus" /> {t("outline.add")}
          </button>
          <button className="btn" onClick={() => setItems([])} disabled={!items.length}>
            {t("outline.clear")}
          </button>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            className="btn primary"
            onClick={() => {
              onApply(items.filter((o) => o.title.trim()));
              onClose();
            }}
          >
            {t("stamp.apply")}
          </button>
        </>
      }
    >
      {!items.length && <p className="note">{t("outline.empty")}</p>}
      <div className="outline-list">
        {items.map((o) => (
          <div key={o.id} className={`outline-row ${sel === o.id ? "selected" : ""}`} style={{ paddingLeft: 8 + o.level * 20 }} onClick={() => setSel(o.id)}>
            <input className="outline-title" value={o.title} placeholder={t("outline.titlePlaceholder")} onChange={(e) => patch(o.id, (x) => ({ ...x, title: e.target.value }))} />
            <label className="outline-page">
              <span>{t("outline.page")}</span>
              <input
                type="number"
                min={1}
                max={pages.length}
                value={pageNo(o.pageId) || ""}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  // 行き先を変えたら、元のしおりが持っていたページ内の位置・Web のアドレスは使わない
                  patch(o.id, (x) => ({ id: x.id, title: x.title, level: x.level, pageId: n >= 1 && n <= pages.length ? pages[n - 1].id : null }));
                }}
              />
            </label>
            <span className="outline-btns">
              <button className="icon-btn" title={t("outline.outdent")} disabled={o.level === 0} onClick={() => patch(o.id, (x) => ({ ...x, level: Math.max(0, x.level - 1) }))}>
                ←
              </button>
              <button className="icon-btn" title={t("outline.indent")} disabled={o.level >= 8} onClick={() => patch(o.id, (x) => ({ ...x, level: x.level + 1 }))}>
                →
              </button>
              <button className="icon-btn" title={t("outline.up")} onClick={() => move(o.id, -1)}>
                ↑
              </button>
              <button className="icon-btn" title={t("outline.down")} onClick={() => move(o.id, 1)}>
                ↓
              </button>
              <button className="icon-btn danger" title={t("common.delete")} onClick={() => setItems((prev) => prev.filter((x) => x.id !== o.id))}>
                <Icon name="trash" size={14} />
              </button>
            </span>
          </div>
        ))}
      </div>
      <p className="note">{t("outline.help")}</p>
    </Dialog>
  );
}

// 注釈の一覧：押すと、編集画面のそのページへ移って、その注釈を示す
import { useEffect, useState } from "react";
import { type AnnotEntry, listAnnotations } from "@/lib/annotList";
import { useT } from "@/lib/i18n";
import type { PageItem, SourceDoc } from "@/lib/types";
import { Dialog } from "../Dialog";

export function AnnotListDialog({ pages, sources, includeSource, onJump, onClose }: { pages: PageItem[]; sources: Map<string, SourceDoc>; includeSource: boolean; onJump: (e: AnnotEntry) => void; onClose: () => void }) {
  const t = useT();
  const [list, setList] = useState<AnnotEntry[] | null>(null);
  useEffect(() => {
    let live = true;
    void listAnnotations(pages, sources, includeSource).then((l) => live && setList(l));
    return () => {
      live = false;
    };
  }, [pages, sources, includeSource]);
  return (
    <Dialog title={t("annotList.title")} onClose={onClose}>
      {!list ? (
        <p className="note">{t("app.loading")}</p>
      ) : !list.length ? (
        <p className="note">{t("annotList.none")}</p>
      ) : (
        <>
          <p className="note">{t("annotList.count", { n: list.length })}</p>
          <ul className="wareki-list annot-list">
            {list.map((e) => (
              <li key={e.key}>
                <button type="button" onClick={() => onJump(e)}>
                  <span className="wareki-page">{t("wareki.pageNo", { n: e.pageNo })}</span>
                  <span className="annot-kind">{t(e.kind)}</span>
                  <span className="annot-text" dir="auto">
                    {e.text.trim() ? e.text.trim().slice(0, 80) : ""}
                    {e.author && <span className="muted"> — {e.author}</span>}
                  </span>
                  {e.objId && <span className="wareki-flag plain">{t("annotList.own")}</span>}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  );
}

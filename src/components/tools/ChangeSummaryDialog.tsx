/** 変更内容の一覧（保存前の確認）。読み取り専用。 */
import { type ChangeItem, summarizeChanges } from "@/lib/changeSummary";
import type { DocSettings } from "@/lib/docOps";
import { useT } from "@/lib/i18n";
import type { PageItem } from "@/lib/types";
import { Dialog } from "../Dialog";
import { Icon } from "../Icon";

/** ページ番号の並びを「1, 2, 4-6」のように縮める */
function rangeText(nums: number[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < nums.length) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(i === j ? `${nums[i]}` : `${nums[i]}-${nums[j]}`);
    i = j + 1;
  }
  return out.join(", ");
}

export function ChangeSummaryDialog({ pages, settings, onClose }: { pages: PageItem[]; settings: DocSettings; onClose: () => void }) {
  const t = useT();
  const items: ChangeItem[] = summarizeChanges(pages, settings);
  return (
    <Dialog
      title={t("change.title")}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn primary" onClick={onClose}>
            {t("common.close")}
          </button>
        </>
      }
    >
      {items.length === 0 ? (
        <p className="note">{t("change.none")}</p>
      ) : (
        <ul className="change-list">
          {items.map((it, i) => (
            <li key={i}>
              <Icon name="check" size={15} />
              <span className="change-label">{t(it.label)}</span>
              {it.detail && <span className="change-detail">{it.detail}</span>}
              {it.pages && <span className="change-pages">{t("change.onPages", { pages: rangeText(it.pages) })}</span>}
            </li>
          ))}
        </ul>
      )}
      <p className="note">{t("change.hint")}</p>
    </Dialog>
  );
}

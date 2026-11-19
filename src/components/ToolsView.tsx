/** ツール一覧：文書全体にかける操作をカードで並べる。クリックでダイアログか即時実行 */
import { useState } from "react";
import type { Key } from "@/lib/i18n";
import { useT } from "@/lib/i18n";
import { Icon } from "./Icon";

export type ToolId =
  | "numbering"
  | "headerFooter"
  | "watermark"
  | "crop"
  | "resize"
  | "reverse"
  | "interleave"
  | "removeBlank"
  | "split"
  | "extract"
  | "toImages"
  | "fromImages"
  | "toText"
  | "metadata"
  | "stripAnnots"
  | "form"
  | "protect"
  | "compress"
  | "grayscale"
  | "nup"
  | "outline"
  | "attachments"
  | "compare"
  | "wareki"
  | "find"
  | "ocr"
  | "annotList"
  | "batch";

interface ToolDef {
  id: ToolId;
  icon: string;
  title: Key;
  desc: Key;
  /** 文書全体の設定として有効になっているか（バッジ表示） */
  active?: boolean;
}

interface Group {
  title: Key;
  tools: ToolDef[];
}

/** ocr：文字認識を使える版か（Web 版だけ。使えない版ではカードを出さない） */
export function ToolsView({ onRun, activeFlags, hasPages, hasSelection, ocr = false }: { onRun: (id: ToolId) => void; activeFlags: Partial<Record<ToolId, boolean>>; hasPages: boolean; hasSelection: boolean; ocr?: boolean }) {
  const t = useT();
  const groups: Group[] = [
    {
      title: "tools.groupPages",
      tools: [
        { id: "split", icon: "scissors", title: "tool.split", desc: "tool.split.desc" },
        { id: "extract", icon: "page-out", title: "tool.extract", desc: "tool.extract.desc" },
        { id: "reverse", icon: "reverse", title: "tool.reverse", desc: "tool.reverse.desc" },
        { id: "interleave", icon: "interleave", title: "tool.interleave", desc: "tool.interleave.desc" },
        { id: "removeBlank", icon: "page-x", title: "tool.removeBlank", desc: "tool.removeBlank.desc" },
        { id: "crop", icon: "crop", title: "tool.crop", desc: "tool.crop.desc" },
        { id: "resize", icon: "resize", title: "tool.resize", desc: "tool.resize.desc" },
        { id: "nup", icon: "booklet", title: "tool.nup", desc: "tool.nup.desc" },
      ],
    },
    {
      title: "tools.groupStamps",
      tools: [
        { id: "numbering", icon: "hash", title: "tool.numbering", desc: "tool.numbering.desc" },
        { id: "headerFooter", icon: "header", title: "tool.headerFooter", desc: "tool.headerFooter.desc" },
        { id: "watermark", icon: "droplet", title: "tool.watermark", desc: "tool.watermark.desc" },
      ],
    },
    {
      title: "tools.groupConvert",
      tools: [
        { id: "toImages", icon: "image", title: "tool.toImages", desc: "tool.toImages.desc" },
        { id: "fromImages", icon: "file-plus", title: "tool.fromImages", desc: "tool.fromImages.desc" },
        { id: "toText", icon: "page-text", title: "tool.toText", desc: "tool.toText.desc" },
        { id: "compress", icon: "compress", title: "tool.compress", desc: "tool.compress.desc" },
        { id: "grayscale", icon: "grayscale", title: "tool.grayscale", desc: "tool.grayscale.desc" },
        { id: "batch", icon: "layers", title: "tool.batch", desc: "tool.batch.desc" },
      ],
    },
    {
      title: "tools.groupDocument",
      tools: [
        { id: "find", icon: "search", title: "tool.find", desc: "tool.find.desc" },
        { id: "wareki", icon: "calendar", title: "tool.wareki", desc: "tool.wareki.desc" },
        ...(ocr ? [{ id: "ocr", icon: "scan", title: "tool.ocr", desc: "tool.ocr.desc" } as ToolDef] : []),
        { id: "metadata", icon: "info", title: "tool.metadata", desc: "tool.metadata.desc" },
        { id: "form", icon: "form", title: "tool.form", desc: "tool.form.desc" },
        { id: "annotList", icon: "list", title: "tool.annotList", desc: "tool.annotList.desc" },
        { id: "stripAnnots", icon: "note-off", title: "tool.stripAnnots", desc: "tool.stripAnnots.desc" },
        { id: "protect", icon: "lock", title: "tool.protect", desc: "tool.protect.desc" },
        { id: "outline", icon: "bookmark", title: "tool.outline", desc: "tool.outline.desc" },
        { id: "attachments", icon: "paperclip", title: "tool.attachments", desc: "tool.attachments.desc" },
        { id: "compare", icon: "compare", title: "tool.compare", desc: "tool.compare.desc" },
      ],
    },
  ];
  const needsPages: Set<ToolId> = new Set(["split", "extract", "reverse", "interleave", "removeBlank", "crop", "resize", "numbering", "headerFooter", "watermark", "toImages", "toText", "metadata", "stripAnnots", "form", "protect", "compress", "grayscale", "nup", "outline", "attachments", "compare", "wareki", "find", "ocr", "annotList"]);
  // 絞り込み：名前と説明のどちらかに、入力した語（空白区切り）がすべて含まれるものだけ出す
  const [query, setQuery] = useState("");
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const match = (tool: ToolDef) => {
    if (!words.length) return true;
    const hay = `${t(tool.title)} ${t(tool.desc)}`.toLocaleLowerCase();
    return words.every((w) => hay.includes(w));
  };
  const shown = groups.map((g) => ({ ...g, tools: g.tools.filter(match) })).filter((g) => g.tools.length);
  return (
    <div className="tools">
      <label className="tool-search">
        <Icon name="search" />
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("tools.search")} aria-label={t("tools.search")} />
      </label>
      {!shown.length && <p className="muted tool-none">{t("tools.noMatch")}</p>}
      {shown.map((g) => (
        <section key={g.title} className="tool-group-section">
          <h2>{t(g.title)}</h2>
          <div className="tool-cards">
            {g.tools.map((tool) => {
              const disabled = (needsPages.has(tool.id) && !hasPages) || (tool.id === "extract" && !hasSelection);
              return (
                <button key={tool.id} data-tool={tool.id} className={`tool-card ${activeFlags[tool.id] ? "active" : ""}`} onClick={() => onRun(tool.id)} disabled={disabled}>
                  <span className="tool-card-icon">
                    <Icon name={tool.icon} size={22} />
                  </span>
                  <span className="tool-card-body">
                    <b>{t(tool.title)}</b>
                    <small>{t(tool.desc)}</small>
                  </span>
                  {activeFlags[tool.id] && <span className="tool-card-badge">{t("tools.on")}</span>}
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

/** 左のレール（スマホでは下のナビ）：作業の種類を切り替える */
import { useT } from "@/lib/i18n";
import { Icon } from "./Icon";

export type Mode = "pages" | "edit" | "tools";

export function Rail({ mode, onChange, disabled }: { mode: Mode; onChange: (m: Mode) => void; disabled: boolean }) {
  const t = useT();
  const items: { id: Mode; icon: string; label: string }[] = [
    { id: "pages", icon: "grid", label: t("top.organize") },
    { id: "edit", icon: "pen", label: t("top.edit") },
    { id: "tools", icon: "tools", label: t("top.tools") },
  ];
  return (
    <nav className="rail" role="tablist" aria-orientation="vertical">
      {items.map((it) => (
        <button key={it.id} role="tab" aria-selected={mode === it.id} className={mode === it.id ? "on" : ""} onClick={() => onChange(it.id)} disabled={disabled}>
          <Icon name={it.icon} size={22} />
          <span>{it.label}</span>
        </button>
      ))}
    </nav>
  );
}

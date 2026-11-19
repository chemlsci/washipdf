// キーボードのショートカットの一覧（「?」で開く）
import { useT } from "@/lib/i18n";
import { Dialog } from "../Dialog";
import { TOOLS } from "../EditorView";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = isMac ? "⌘" : "Ctrl";

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  // 「元に戻す (Ctrl+Z)」などの文言から、括弧の中のキーの表示を除いた名前
  const bare = (s: string) => s.replace(/\s*[(（].*[)）]\s*$/, "");
  const general: [string, string][] = [
    [`${MOD}+Z`, bare(t("top.undo"))],
    [`${MOD}+Shift+Z / ${MOD}+Y`, bare(t("top.redo"))],
    [`${MOD}+S`, t("shortcuts.save")],
    [`${MOD}+P`, t("save.print")],
    [`${MOD}+F`, t("tool.find")],
    ["?", t("shortcuts.help")],
    ["Esc", t("shortcuts.close")],
  ];
  const edit: [string, string][] = [
    [`${MOD}+ +  /  ${MOD}+ −  /  ${MOD}+0`, t("shortcuts.zoom")],
    ["PageUp / PageDown", t("shortcuts.page")],
    ["Delete", t("shortcuts.delete")],
    ["← ↑ → ↓", t("shortcuts.nudge")],
    ...TOOLS.map((tl): [string, string] => [tl.key.toUpperCase(), t(tl.label)]),
  ];
  // ページ整理の画面（OrganizeView のキー操作）
  const organize: [string, string][] = [
    [`${MOD}+A`, t("org.selectAll")],
    ["Delete", t("shortcuts.delete")],
    ["Esc", t("org.deselect")],
  ];
  const table = (rows: [string, string][]) => (
    <table className="shortcut-table">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k + v}>
            <td>
              <kbd>{k}</kbd>
            </td>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <Dialog title={t("shortcuts.title")} onClose={onClose}>
      <h3 className="shortcut-head">{t("shortcuts.general")}</h3>
      {table(general)}
      <h3 className="shortcut-head">{t("shortcuts.edit")}</h3>
      {table(edit)}
      <h3 className="shortcut-head">{t("top.organize")}</h3>
      {table(organize)}
    </Dialog>
  );
}

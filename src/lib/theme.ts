// 画面の明るさ：自動（端末の設定に従う）・明るい・暗い。選んだものを覚え、<html data-theme> で切り替える（PDF のページは常に白）
export type Theme = "auto" | "light" | "dark";
const KEY = "washi-pdf.theme";

export function loadTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "auto";
  } catch {
    return "auto";
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

export function saveTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    if (theme === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    /* 覚えられなくても、いまの画面には効く */
  }
}

// 読み込んだ時点で、覚えている明るさを当てる（main.tsx が最初に読み込む。最初の描画より前、アプリ本体の準備より前に効かせるため）
if (typeof document !== "undefined") applyTheme(loadTheme());

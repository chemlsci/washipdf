/**
 * UI の文言（日本語・英語）。言語を足すときは Lang と DICT に追加する。
 * 文言の中の {name} は t(key, { name }) で差し替える。
 */
import { createContext, useCallback, useContext } from "react";
import { hasOwn } from "./safeObject";
import { ar } from "./locales/ar";
import { bn } from "./locales/bn";
import { de } from "./locales/de";
import { en } from "./locales/en";
import { es } from "./locales/es";
import { fa } from "./locales/fa";
import { fr } from "./locales/fr";
import { hi } from "./locales/hi";
import { id } from "./locales/id";
import { it } from "./locales/it";
import { ja, type Key } from "./locales/ja";
import { ko } from "./locales/ko";
import { pt } from "./locales/pt";
import { ru } from "./locales/ru";
import { th } from "./locales/th";
import { tr as trTurkish } from "./locales/tr";
import { ur } from "./locales/ur";
import { vi } from "./locales/vi";
import { zhCN } from "./locales/zh-CN";
import { zhTW } from "./locales/zh-TW";

export type { Key };

export type Lang = "ja" | "en" | "zh-CN" | "zh-TW" | "ko" | "es" | "pt" | "fr" | "de" | "ru" | "ar" | "hi" | "bn" | "id" | "vi" | "th" | "tr" | "it" | "ur" | "fa";

/** 言語の一覧（表示名はその言語での呼び名） */
export const LANGS: { id: Lang; label: string; rtl?: boolean }[] = [
  { id: "ja", label: "日本語" },
  { id: "en", label: "English" },
  { id: "zh-CN", label: "简体中文" },
  { id: "zh-TW", label: "繁體中文" },
  { id: "ko", label: "한국어" },
  { id: "es", label: "Español" },
  { id: "pt", label: "Português" },
  { id: "fr", label: "Français" },
  { id: "de", label: "Deutsch" },
  { id: "it", label: "Italiano" },
  { id: "ru", label: "Русский" },
  { id: "tr", label: "Türkçe" },
  { id: "id", label: "Bahasa Indonesia" },
  { id: "vi", label: "Tiếng Việt" },
  { id: "th", label: "ไทย" },
  { id: "hi", label: "हिन्दी" },
  { id: "bn", label: "বাংলা" },
  { id: "ar", label: "العربية", rtl: true },
  { id: "ur", label: "اردو", rtl: true },
  { id: "fa", label: "فارسی", rtl: true },
];

export const isRtl = (lang: Lang) => !!LANGS.find((l) => l.id === lang)?.rtl;

const STORAGE_KEY = "washi-pdf.lang";

const isLang = (s: string | null): s is Lang => !!s && LANGS.some((l) => l.id === s);

/** ブラウザの言語設定から最も近い言語を選ぶ */
export function matchLang(tags: readonly string[]): Lang {
  for (const tag of tags) {
    const t = tag.toLowerCase();
    if (t.startsWith("zh")) return /tw|hk|mo|hant/.test(t) ? "zh-TW" : "zh-CN";
    const base = t.split("-")[0];
    const hit = LANGS.find((l) => l.id.toLowerCase() === base);
    if (hit) return hit.id;
  }
  return "en";
}

export function detectLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLang(saved)) return saved;
  } catch {
    /* プライベートモードなど */
  }
  if (typeof navigator === "undefined") return "ja";
  return matchLang(navigator.languages?.length ? navigator.languages : [navigator.language]);
}

export function saveLang(lang: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* noop */
  }
}


/** 言語ごとの辞書。ja と en 以外は Partial で、足りない文言は en → ja の順に使う */
const DICT: Record<Lang, Partial<Record<Key, string>>> = { ja, en, "zh-CN": zhCN, "zh-TW": zhTW, ko, es, pt, fr, de, ru, ar, hi, bn, id, vi, th, tr: trTurkish, it, ur, fa };

export type Vars = Record<string, string | number>;

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** 辞書から文言を引く。辞書が自分で持っている文字列だけを返す（キーが "constructor" などでも、関数を拾わない） */
const lookup = (d: Partial<Record<string, string>> | undefined, key: string): string | undefined => {
  if (!d || !hasOwn(d, key)) return undefined;
  const v = d[key];
  return typeof v === "string" ? v : undefined;
};

export function translate(lang: Lang, key: Key, vars?: Vars): string {
  // キーは型の上では決まった文字列だが、文書や保存データから来た値がそのまま渡ることがある。どんな値でも文字列を返す
  const k = typeof key === "string" ? key : String(key);
  let s: string = lookup(DICT[lang], k) ?? lookup(en, k) ?? lookup(ja, k) ?? k;
  // 単数・複数：{n|page|pages}（n が 1 のときは前、それ以外は後ろ）
  s = s.replace(/\{(\w+)\|([^|{}]*)\|([^|{}]*)\}/g, (_, k: string, one: string, other: string) => (Number(vars?.[k]) === 1 ? one : other));
  // Mac では Ctrl を ⌘ と書く
  if (IS_MAC) s = s.replace(/\b(?:Ctrl|Strg)\+/g, "⌘");
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

export type T = (key: Key, vars?: Vars) => string;

export const LangContext = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({ lang: "ja", setLang: () => {} });

/** 翻訳関数を返すフック */
export function useT(): T {
  const { lang } = useContext(LangContext);
  return useCallback((key: Key, vars?: Vars) => translate(lang, key, vars), [lang]);
}

export function useLang() {
  return useContext(LangContext);
}

/** React の外（ライブラリ側のエラーメッセージなど）で使う現在の言語 */
let currentLang: Lang = "ja";
export const setCurrentLang = (l: Lang) => {
  currentLang = l;
};
export const getCurrentLang = (): Lang => currentLang;
export const tr = (key: Key, vars?: Vars) => translate(currentLang, key, vars);

/** 利用者に見せるために訳した文の例外（そのまま知らせてよい）。それ以外の例外は、内部の英語の文なので包んで知らせる */
export class AppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppError";
  }
}

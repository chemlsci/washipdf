/**
 * 同梱フォントの一覧（HTML に埋め込んだ manifest から作る）と、字幅・字形の有無・画面表示用の登録。
 * どのフォントを同梱するかはビルドのフラグ（--fonts=ja,latin）で決まり、ここでは一覧を実行時に読むだけ。
 */
import { getAsset, getFontManifest } from "./assets";
import { getCurrentLang } from "./i18n";
import { NEEDS_SHAPING, type Script, scriptOf, scriptsIn } from "./scripts";
import { isShapingFont, setShapingLookup, shapedWidth } from "./shape";
import { advanceWidth, glyphIdForCodePoint, parseTtf, type TtfInfo, unitsPerEm, capHeightEm } from "./ttfSubset";
import type { FontKey } from "./types";

export type FontFamily = "sans" | "serif";

export interface FontDef {
  id: FontKey;
  /** 表示名（フォントの名前。翻訳しない） */
  name: string;
  family: FontFamily;
  /** manifest に書かれた対応用字系 */
  scripts: Script[];
  /** 字形の結合（シェーピング）が必要な用字系のフォント */
  shaping: boolean;
  /** 画面表示用の CSS フォント名 */
  cssFamily: string;
  css: string;
}

export interface FontManifestEntry {
  id: string;
  name: string;
  family: FontFamily;
  scripts: string[];
  shaping?: boolean;
}

let registry: FontDef[] | null = null;

/** テスト（Node.js）用：manifest を直接与える */
export function setFontRegistry(entries: FontManifestEntry[]): void {
  registry = entries.map(toDef);
}

function toDef(e: FontManifestEntry): FontDef {
  const cssFamily = `Washi-${e.id}`;
  return {
    id: e.id,
    name: e.name,
    family: e.family,
    scripts: e.scripts as Script[],
    shaping: !!e.shaping,
    cssFamily,
    css: `'${cssFamily}', ${e.family === "serif" ? "serif" : "sans-serif"}`,
  };
}

setShapingLookup((key) => !!fontDef(key)?.shaping);

/** 同梱フォントの一覧（manifest の順） */
export function fontList(): FontDef[] {
  if (!registry) {
    const m = getFontManifest();
    registry = (m ?? []).map(toDef);
  }
  return registry;
}

export function fontDef(id: FontKey): FontDef | undefined {
  return fontList().find((f) => f.id === id);
}

/**
 * UI 言語ごとに優先する同梱フォント。漢字は日本語・中国語（簡体／繁体）・韓国語で字形が違うため、
 * 同じ「han」を含む複数のフォントが同梱されているとき（all ビルド）は UI 言語に合うものを先に選ぶ。
 */
const LANG_PREFERENCE: Record<string, FontKey[]> = {
  ja: ["gothic", "mincho"],
  "zh-CN": ["notosanssc", "notoserifsc"],
  "zh-TW": ["notosanstc", "notoseriftc"],
  ko: ["notosanskr", "notoserifkr"],
};

/** 言語の優先順位を先に、残りは manifest の順で並べる */
function byPreference(list: FontDef[]): FontDef[] {
  const pref = LANG_PREFERENCE[getCurrentLang()] ?? [];
  const rank = (f: FontDef) => {
    const i = pref.indexOf(f.id);
    return i < 0 ? pref.length : i;
  };
  return [...list].sort((a, b) => rank(a) - rank(b));
}

/** 既定のフォント（family に合い、UI 言語に合うもの。無ければ先頭） */
export function defaultFont(family: FontFamily = "sans"): FontKey {
  const list = byPreference(fontList());
  return (list.find((f) => f.family === family) ?? list[0])?.id ?? "gothic";
}

/**
 * 両フォントとも ascent 1802 / descent 246 / unitsPerEm 2048。
 * エディタ（CSS）と書き出し（pdf-lib）でベースライン位置を一致させるための値。
 * 他のフォントでも、行の高さはこの比率で扱う（実際のベースラインは hhea から引く）。
 */
export const ASCENT = 1802 / 2048;
export const LINE_HEIGHT = 1.25;

/** テキストボックス上端から n 行目のベースラインまでの距離 */
export function baselineOffset(fontSize: number, line = 0): number {
  const lh = fontSize * LINE_HEIGHT;
  return line * lh + (lh - fontSize) / 2 + ASCENT * fontSize;
}

export async function loadFontBytes(key: FontKey): Promise<Uint8Array> {
  return getAsset(`font-${key}`);
}

const faces = new Map<FontKey, Promise<void>>();

/** 画面表示用にフォントを登録する（初めて使う時だけ展開する） */
export function ensureFontFace(key: FontKey): Promise<void> {
  let p = faces.get(key);
  if (!p) {
    p = (async () => {
      const def = fontDef(key);
      if (!def) return;
      const bytes = await loadFontBytes(key);
      const face = new FontFace(def.cssFamily, bytes as BufferSource);
      await face.load();
      document.fonts.add(face);
    })();
    p.catch((e) => {
      faces.delete(key);
      console.warn("font load failed", e);
    });
    faces.set(key, p);
  }
  return p;
}

/** 入力欄で、端末に無い文字を同梱フォントで表示するための書体名（その文字の範囲にだけ効く） */
export const FALLBACK_FAMILY = "Washi-fallback";
/** 文字の種類ごとの範囲（CSS の unicode-range）。端末のフォントが無いことの多い文字だけ */
const FALLBACK_RANGES: Record<string, { range: string; test: RegExp }> = {
  thai: { range: "U+0E00-0E7F", test: /[\u0e00-\u0e7f]/ },
  devanagari: { range: "U+0900-097F, U+A8E0-A8FF, U+1CD0-1CFF", test: /[\u0900-\u097f]/ },
  bengali: { range: "U+0980-09FF", test: /[\u0980-\u09ff]/ },
  arabic: { range: "U+0600-06FF, U+0750-077F, U+08A0-08FF, U+FB50-FDFF, U+FE70-FEFF", test: /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/ },
  hebrew: { range: "U+0590-05FF, U+FB1D-FB4F", test: /[\u0590-\u05ff\ufb1d-\ufb4f]/ },
};
const fallbackFaces = new Map<FontKey, Promise<void>>();
/**
 * 入力欄（書き換える文字の入力など）で、端末にフォントが無い文字が豆腐にならないよう、その文字を含むときだけ同梱フォントを
 * 入力欄用の書体として登録する。文字の範囲を限って登録するので、ほかの文字の見た目は変わらない
 */
export function ensureInputFallback(text: string): void {
  if (typeof document === "undefined" || typeof FontFace === "undefined") return;
  for (const f of fontList()) {
    const script = f.scripts.find((sc) => FALLBACK_RANGES[sc]);
    if (!script || fallbackFaces.has(f.id) || !FALLBACK_RANGES[script].test.test(text)) continue;
    const p = (async () => {
      const face = new FontFace(FALLBACK_FAMILY, (await loadFontBytes(f.id)) as BufferSource, { unicodeRange: FALLBACK_RANGES[script].range });
      await face.load();
      document.fonts.add(face);
    })();
    p.catch(() => fallbackFaces.delete(f.id));
    fallbackFaces.set(f.id, p);
  }
}

/**
 * 最初の操作で固まらないよう、暇なときに同梱フォントを展開しておく（base64 の展開・TrueType の解析・CSS フォントの登録）。
 * スマホでは 1 フォントあたり数百 ms かかることがあるので、PDF を読み込んだ直後に呼ぶ
 */
export function warmFonts(keys: FontKey[]): void {
  if (typeof window === "undefined") return;
  const idle = (fn: () => void) => ((window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 800)))(fn, { timeout: 4000 });
  for (const key of [...new Set(keys)]) {
    if (!fontDef(key) || parsed.has(key)) continue;
    idle(() => {
      try {
        ttf(key);
        void ensureFontFace(key);
      } catch (e) {
        console.warn("font warm-up failed", e);
      }
    });
  }
}

/* ---------- 字幅・字形（埋め込む TrueType と同じ hmtx / cmap を参照する） ---------- */

const parsed = new Map<FontKey, TtfInfo>();

/** 同梱フォントの大文字の高さ（em に対する比）。分からなければ null */
export function bundledCapHeight(key: FontKey): number | null {
  return capHeightEm(ttf(key));
}

function ttf(key: FontKey): TtfInfo {
  let t = parsed.get(key);
  if (!t) {
    t = parseTtf(getAsset(`font-${key}`));
    parsed.set(key, t);
  }
  return t;
}

/** 文字列の幅（pt）。文字間隔は含めない */
export function measureBundled(key: FontKey, text: string, fontSize: number): number {
  if (isShapingFont(key)) return shapedWidth(key, text, fontSize);
  const f = ttf(key);
  const upm = unitsPerEm(f);
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const gid = glyphIdForCodePoint(f, cp);
    w += advanceWidth(f, gid || 0);
  }
  return (w / upm) * fontSize;
}

/** 同梱フォントにその文字のグリフがあるか */
export function bundledHasGlyph(key: FontKey, cp: number): boolean {
  if (/\s/.test(String.fromCodePoint(cp))) return true;
  return glyphIdForCodePoint(ttf(key), cp) !== 0;
}

/**
 * 1 行の文字列を、書けるフォントごとの区間に分ける。主のフォント（key）に無い字は、その字を持つ同梱フォント
 * （同じ系統を優先）で書く。空白と、前の字に付く記号（結合文字など）は、前の字と同じ区間に入れる。
 * どのフォントにも無い字は、主のフォントの区間に入れる（その字は豆腐になる）。
 */
export function fontRuns(key: FontKey, text: string): { key: FontKey; text: string }[] {
  const primary = fontDef(key);
  if (!primary || !text) return [{ key, text }];
  const others = [...byPreference(fontList().filter((f) => f.family === primary.family)), ...byPreference(fontList().filter((f) => f.family !== primary.family))].filter((f) => f.id !== key);
  const out: { key: FontKey; text: string }[] = [];
  let cur: FontKey = key;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    let next = cur;
    if (!/[\s\p{M}\u200c\u200d\ufe00-\ufe0f]/u.test(ch)) {
      // 整形の要る文字（タイ・インド系・アラビア文字）は、字形を持っているだけのフォントでは正しく書けない
      // （欧文用の Noto Sans はデーヴァナーガリーの字形も持つが、整形はしない）。その文字のためのフォントで書く
      const sc = scriptOf(cp);
      const fits = (f: FontDef) => bundledHasGlyph(f.id, cp) && (!sc || !NEEDS_SHAPING.has(sc) || f.scripts.includes(sc));
      const curDef = fontDef(cur);
      if (fits(primary)) next = key;
      else if (!curDef || !fits(curDef)) next = (others.find(fits) ?? others.find((f) => bundledHasGlyph(f.id, cp)))?.id ?? key;
    }
    if (out.length && next === cur) out[out.length - 1].text += ch;
    else out.push({ key: next, text: ch });
    cur = next;
  }
  return out;
}

/** 画面で文字を表示するときの書体の指定：主のフォントに無い字は、ほかの同梱フォントで表示されるようにする */
export function cssFontStack(key: FontKey): string {
  const def = fontDef(key);
  if (!def) return "sans-serif";
  const rest = fontList().filter((f) => f.id !== key).map((f) => `'${f.cssFamily}'`);
  return [`'${def.cssFamily}'`, ...rest, def.family === "serif" ? "serif" : "sans-serif"].join(", ");
}

/** テキストのうち、そのフォントで描ける文字の割合（空白は除く） */
export function coverage(key: FontKey, text: string): number {
  let n = 0;
  let ok = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    n++;
    if (bundledHasGlyph(key, ch.codePointAt(0)!)) ok++;
  }
  return n ? ok / n : 1;
}

/**
 * テキストに合うフォントを選ぶ。
 * 1. family が合い、manifest の用字系がテキストの用字系をすべて含むもの
 * 2. family が合い、実際のグリフで全文字を描けるもの
 * 3. family を問わず、描ける文字の割合が最も高いもの
 */
export function pickFont(family: FontFamily, text: string, preferred?: FontKey | null): FontKey {
  const list = fontList();
  if (!list.length) return "gothic";
  const scripts = scriptsIn(text);
  const covers = (f: FontDef) => [...scripts].every((s) => s === "other" || f.scripts.includes(s));
  if (preferred) {
    const p = fontDef(preferred);
    if (p && (scripts.size === 0 || covers(p) || coverage(preferred, text) === 1)) return preferred;
  }
  const fam = byPreference(list.filter((f) => f.family === family));
  // 用字系が合うものの中で、実際に全文字のグリフがあるものを優先する（日本語フォントに無い簡体字など）
  const candidates = [...fam.filter(covers), ...byPreference(list.filter((f) => f.family !== family)).filter(covers)];
  const byScript = candidates.find((f) => coverage(f.id, text) === 1) ?? candidates[0];
  if (byScript) return byScript.id;
  if (scripts.size === 0) return (fam[0] ?? list[0]).id;
  let best = fam[0] ?? list[0];
  let bestCov = -1;
  for (const f of [...fam, ...byPreference(list.filter((x) => x.family !== family))]) {
    const c = coverage(f.id, text);
    if (c > bestCov) {
      bestCov = c;
      best = f;
    }
    if (c === 1) break;
  }
  return best.id;
}

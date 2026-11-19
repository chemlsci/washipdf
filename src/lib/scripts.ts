/** 文字の範囲（用字系）の分類。フォントの自動選択と、シェーピングが必要かの判定に使う */
export type Script = "latin" | "greek" | "cyrillic" | "vietnamese" | "kana" | "han" | "hangul" | "thai" | "arabic" | "hebrew" | "devanagari" | "bengali" | "other";

export function scriptOf(cp: number): Script | null {
  if (cp <= 0x20 || (cp >= 0x2000 && cp <= 0x206f) || cp === 0x3000 || cp === 0xa0) return null; // 空白・一般的な記号は数えない
  if (cp < 0x250) return cp >= 0xc0 && /[Ạ-ỹ]/.test(String.fromCodePoint(cp)) ? "vietnamese" : "latin";
  if (cp >= 0x1ea0 && cp <= 0x1ef9) return "vietnamese";
  if (cp >= 0x370 && cp <= 0x3ff) return "greek";
  if (cp >= 0x400 && cp <= 0x52f) return "cyrillic";
  if (cp >= 0x590 && cp <= 0x5ff) return "hebrew";
  if (cp >= 0xfb1d && cp <= 0xfb4f) return "hebrew";
  if (cp >= 0x600 && cp <= 0x6ff) return "arabic";
  if (cp >= 0x750 && cp <= 0x77f) return "arabic";
  if (cp >= 0xfb50 && cp <= 0xfdff) return "arabic";
  if (cp >= 0xfe70 && cp <= 0xfeff) return "arabic";
  if (cp >= 0x900 && cp <= 0x97f) return "devanagari";
  if (cp >= 0x980 && cp <= 0x9ff) return "bengali";
  if (cp >= 0xe00 && cp <= 0xe7f) return "thai";
  if (cp >= 0x3040 && cp <= 0x30ff) return "kana";
  if (cp >= 0x31f0 && cp <= 0x31ff) return "kana";
  if (cp >= 0xff66 && cp <= 0xff9f) return "kana";
  if (cp >= 0x3400 && cp <= 0x9fff) return "han";
  if (cp >= 0xf900 && cp <= 0xfaff) return "han";
  if (cp >= 0x20000 && cp <= 0x3134f) return "han";
  if (cp >= 0x3000 && cp <= 0x303f) return "han"; // 句読点・括弧
  if (cp >= 0xff01 && cp <= 0xff65) return "han"; // 全角英数
  if (cp >= 0xac00 && cp <= 0xd7af) return "hangul";
  if (cp >= 0x1100 && cp <= 0x11ff) return "hangul";
  if (cp >= 0x3130 && cp <= 0x318f) return "hangul";
  return "other";
}

/** テキストに含まれる用字系（空白と一般的な記号は除く） */
export function scriptsIn(text: string): Set<Script> {
  const s = new Set<Script>();
  for (const ch of text) {
    const sc = scriptOf(ch.codePointAt(0)!);
    if (sc) s.add(sc);
  }
  return s;
}

/** 字形の結合（シェーピング）が無いと正しく組めない用字系 */
export const NEEDS_SHAPING: ReadonlySet<Script> = new Set<Script>(["arabic", "hebrew", "devanagari", "bengali", "thai"]);

export const needsShaping = (text: string) => [...scriptsIn(text)].some((s) => NEEDS_SHAPING.has(s));

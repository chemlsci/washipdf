/**
 * 箱内リフロー：元のテキストブロックの幅の中だけで折り返す。
 * 日本語の禁則処理（行頭禁則・行末禁則・分離禁止）と、欧文の単語単位の折り返しを行う。
 * 収まらなければ文字サイズを段階的に縮小し、それでも無理なら警告を返す。
 */

/** 行頭に来てはいけない文字（JIS X 4051 の行頭禁則をベースに実用的な範囲） */
const NO_LINE_START = new Set(
  "、。，．・：；？！ゝゞヽヾーァィゥェォッャュョヮヵヶぁぃぅぇぉっゃゅょゎゕゖㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿ々〻" +
    "」』】〕）］｝〉》〙〗〟’”｠»〕〙" +
    ")]}>,.!?:;%‰′″℃°¢" +
    "‐–—〜～…‥",
);
/** 行末に来てはいけない文字 */
const NO_LINE_END = new Set("「『【〔（［｛〈《〘〖〝‘“｟«([{<$£¥€#＃＄￥");
/** 分離禁止（連続する同じ文字の間で改行しない） */
const INSEPARABLE = new Set("…‥—―");

const isCJK = (cp: number) =>
  (cp >= 0x3000 && cp <= 0x30ff) || // 記号・ひらがな・カタカナ
  (cp >= 0x3400 && cp <= 0x9fff) || // 漢字
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xff00 && cp <= 0xffef) || // 全角英数・半角カナ
  (cp >= 0x20000 && cp <= 0x3134f) ||
  (cp >= 0xac00 && cp <= 0xd7af) || // ハングル
  (cp >= 0x1100 && cp <= 0x11ff);

const isSpace = (ch: string) => /\s/.test(ch);
const isWordChar = (ch: string) => /[\p{L}\p{N}'’.\-]/u.test(ch) && !isCJK(ch.codePointAt(0)!);

/** 文字 i の直前で改行してよいか */
function canBreakBefore(chars: string[], i: number): boolean {
  if (i <= 0 || i >= chars.length) return false;
  const prev = chars[i - 1];
  const cur = chars[i];
  if (isSpace(prev)) return true; // 空白の後ろは常に可
  if (isSpace(cur)) return false; // 空白の前では折らず、空白の後ろで折る
  if (NO_LINE_START.has(cur)) return false;
  if (NO_LINE_END.has(prev)) return false;
  if (INSEPARABLE.has(prev) && prev === cur) return false;
  // 欧文の単語内では折らない
  if (isWordChar(prev) && isWordChar(cur)) return false;
  return true;
}

export interface Measurer {
  /** 文字列の幅（pt）。文字間隔 Tc を含める */
  width(text: string, fontSize: number): number;
}

export interface LayoutResult {
  lines: string[];
  fontSize: number;
  /** 元のサイズから縮小したか */
  shrunk: boolean;
  /** 行数超過で収まらなかった（最小サイズでも入らない） */
  overflow: boolean;
  /** 1行でも幅を超えた（長い英単語など） */
  wideLine: boolean;
}

/** 1つの段落を幅 maxWidth に収まるように行分割する（最後の行は空白を落とす） */
export function breakParagraph(text: string, fontSize: number, maxWidth: number, m: Measurer): { lines: string[]; wideLine: boolean } {
  const chars = [...text];
  const lines: string[] = [];
  let wideLine = false;
  let start = 0;
  while (start < chars.length) {
    // 行頭の空白は捨てる（和文の全角空白は意図的な字下げの可能性があるので残す）
    while (start < chars.length && chars[start] === " ") start++;
    if (start >= chars.length) break;
    let end = start;
    let lastBreak = -1;
    let width = 0;
    while (end < chars.length) {
      const w = m.width(chars.slice(start, end + 1).join("").replace(/\s+$/, ""), fontSize);
      if (w > maxWidth + 0.01 && end > start) break;
      width = w;
      end++;
      if (end < chars.length && canBreakBefore(chars, end)) lastBreak = end;
    }
    if (end >= chars.length) {
      lines.push(chars.slice(start).join("").replace(/\s+$/, ""));
      break;
    }
    let cut: number;
    // ぶら下げ組：入りきらない最初の文字が句読点なら、前の文字を次行に送るより行末にぶら下げる（JIS X 4051）
    if (/[、。，．]/.test(chars[end]) && (end + 1 >= chars.length || canBreakBefore(chars, end + 1))) cut = end + 1;
    else if (lastBreak > start) cut = lastBreak;
    else {
      // 折れる所が無い（長い英単語など）：文字単位で強制的に折る。禁則で1文字も置けないときは1文字進める
      cut = Math.max(start + 1, end);
      if (cut === start + 1 && width > maxWidth) wideLine = true;
    }
    lines.push(chars.slice(start, cut).join("").replace(/\s+$/, ""));
    start = cut;
  }
  if (lines.length === 0) lines.push("");
  return { lines, wideLine };
}

/**
 * テキスト全体（改行区切りの段落）を、幅 maxWidth・最大行数 maxLines に収める。
 * 収まらなければ fontSize を step ずつ下げ、minSize まで試す。
 */
export function fitText(
  text: string,
  fontSize: number,
  maxWidth: number,
  maxLines: number,
  m: Measurer,
  opts: { minScale?: number; step?: number } = {},
): LayoutResult {
  const minScale = opts.minScale ?? 0.6;
  const step = opts.step ?? 0.05;
  const paragraphs = text.replace(/\r/g, "").split("\n");
  let scale = 1;
  let last: LayoutResult | null = null;
  for (;;) {
    const fs = Math.round(fontSize * scale * 100) / 100;
    const lines: string[] = [];
    let wideLine = false;
    for (const p of paragraphs) {
      const r = breakParagraph(p, fs, maxWidth, m);
      lines.push(...r.lines);
      wideLine ||= r.wideLine;
    }
    const fits = lines.length <= maxLines && !wideLine;
    last = { lines, fontSize: fs, shrunk: scale < 1, overflow: !fits, wideLine };
    if (fits) return last;
    if (scale - step < minScale - 1e-9) return last;
    scale = Math.round((scale - step) * 100) / 100;
  }
}

/** 全角・半角スペースを含む Tw 用に、空白の数を数える */
export const countSpaces = (s: string) => (s.match(/ /g) ?? []).length;

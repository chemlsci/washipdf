/**
 * 段落（複数行）の書き換えを、行ごとの書き換えに分ける。
 *
 * 段落を丸ごと組み直すと、変えていない行まで字間や折り返しが変わってしまう。実際の編集は「1 語を直す」ことが多いので、
 * 元の文字列と新しい文字列を比べ、変わった部分が掛かる行だけを書き直す対象にする：
 *  - 変わっていない行 … 何もしない（元の命令のまま残る）
 *  - 変わった部分が 1 行の中に収まる … その行だけの書き換え（1 行の書き換えと同じ扱い＝変えた字だけが動く）
 *  - 複数行にまたがる … その範囲の行だけを組み直す
 * 段落の位置・大きさ・色・フォントを変えているときは分けられないので null（従来どおり段落全体を組み直す）。
 */
import { joinLines } from "./editModel";
import { uid } from "./geometry";
import { pathKey } from "./textOps";
import type { TextEditObj } from "./types";

export function splitBlockEdit(o: TextEditObj, all = false): TextEditObj[] | null {
  const parts = o.parts;
  if (!parts || parts.length < 2 || o.vertical || o.font !== "original" || !o.origin || o.fillColorOps === null) return null;
  if (Math.abs(o.x - o.origin.x) > 1e-6 || Math.abs(o.y - o.origin.y) > 1e-6 || Math.abs(o.fontSize - o.origin.fontSize) > 1e-6) return null;
  // 同じ命令が 2 つの行に属している（1 つの命令が行をまたいでいる）なら、行ごとには分けられない
  const seen = new Set<string>();
  for (const p of parts)
    for (const r of p.removals) {
      const k = pathKey(r.path ?? [], r.index);
      if (seen.has(k)) return null;
      seen.add(k);
    }
  // 各行が、つないだ文字列のどこからどこまでか
  const start: number[] = [];
  const end: number[] = [];
  let acc = "";
  for (const p of parts) {
    acc = joinLines([acc, p.text].filter((x, i) => i > 0 || x));
    start.push(acc.length - p.text.length);
    end.push(acc.length);
  }
  const A = o.original;
  const B = o.text;
  if (acc !== A) return null;

  const single = (i: number, text: string): TextEditObj => {
    const p = parts[i];
    return {
      ...o,
      id: uid(),
      x: p.x,
      y: p.top,
      w: p.w,
      h: p.h,
      baseline: p.baseline,
      lines: 1,
      lineHeight: p.fontSize * 1.2,
      removals: p.removals,
      original: p.text,
      text,
      fontSize: p.fontSize,
      fontResName: p.fontResName,
      fillColorOps: p.fillColorOps,
      strokeColorOps: p.strokeColorOps,
      renderMode: p.renderMode,
      charSpacing: p.charSpacing,
      wordSpacing: p.wordSpacing,
      hscale: p.hscale,
      align: "left",
      // 字を足したときは、段落の右端まで広げてよい
      source: { x: p.x, baseline: p.baseline, fontSize: p.fontSize, room: Math.max(p.x + p.w, o.x + o.w) - p.x },
      previewFont: p.previewFont,
      parts: undefined,
      origin: undefined,
    };
  };

  if (A === B) return all ? parts.map((p, i) => single(i, p.text)) : [];
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  // 変わった範囲（元の文字列で [pre, A.length - suf)）が掛かる最初の行と最後の行
  const lineOf = (pos: number) => {
    for (let i = 0; i < parts.length; i++) if (pos <= end[i]) return i;
    return parts.length - 1;
  };
  const changedEnd = A.length - suf;
  let i0 = lineOf(pre);
  // 行の間（つなぎ目の空白）から始まる変更は、次の行のものとして扱う
  if (pre > end[i0] && i0 + 1 < parts.length) i0++;
  let i1 = changedEnd > pre ? lineOf(changedEnd) : i0;
  if (i1 < i0) i1 = i0;
  if (changedEnd > pre && changedEnd <= start[i1] && i1 > i0) i1--;
  // その行の範囲に当たる新しい文字列
  const text = B.slice(start[i0], B.length - (A.length - end[i1]));
  const rest = all ? parts.map((p, i) => (i < i0 || i > i1 ? single(i, p.text) : null)).filter((x): x is TextEditObj => !!x) : [];
  if (i0 === i1 && !text.includes("\n")) return [...rest, single(i0, text)];
  const sub = parts.slice(i0, i1 + 1);
  const top = Math.min(...sub.map((p) => p.top));
  const bottom = Math.max(...sub.map((p) => p.top + p.h));
  return [
    ...rest,
    {
      ...o,
      id: uid(),
      y: top,
      h: bottom - top,
      baseline: sub[0].baseline,
      lines: sub.length,
      removals: sub.flatMap((p) => p.removals),
      original: joinLines(sub.map((p) => p.text)),
      text,
      parts: undefined,
      origin: undefined,
    },
  ];
}

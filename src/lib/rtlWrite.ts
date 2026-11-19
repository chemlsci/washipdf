// 右から左へ書く文字（アラビア系・ヘブライ）を含む行で、1 つの語を同梱フォントで書くための区間分け。
//
// 語の中でも、向き（アラビア語の中の数字は左から右）と、フォント（ヘブライ文字のフォントには数字も句読点も無い）が
// 混ざる。語を「同じ向き・同じフォントで書ける区間」に分け、表示上の左から右の順に並べて返す。

import { bundledHasGlyph, type FontFamily, fontList, fontRuns, pickFont } from "./fonts";
import { hasRtl } from "./rtl";
import { scriptOf } from "./scripts";
import { bidiRuns } from "./shape";
import type { FontKey } from "./types";

export interface WordPiece {
  key: FontKey;
  /** 読む順の文字列 */
  text: string;
  /** この区間の向き */
  dir: "L" | "R";
}

/** 欧文・数字・記号を書くフォント：欧文用のフォントがあればそれ（和文フォントの欧文は字幅が広い） */
function latinFont(family: FontFamily): FontKey | null {
  const latin = fontList().filter((f) => f.scripts.includes("latin") && !f.scripts.includes("han") && !f.scripts.includes("hangul"));
  return (latin.find((f) => f.family === family) ?? latin[0])?.id ?? null;
}

/** その文字のためのフォント（アラビア文字・ヘブライ文字）。同じ系統を優先する */
function scriptFont(family: FontFamily, cp: number): FontKey | null {
  const sc = scriptOf(cp);
  const list = fontList().filter((f) => (sc && sc !== "other" ? f.scripts.includes(sc) : f.shaping && bundledHasGlyph(f.id, cp)));
  return (list.find((f) => f.family === family) ?? list[0])?.id ?? null;
}

const covers = (key: FontKey, text: string) => [...text].every((ch) => /[\s‌‍]/.test(ch) || bundledHasGlyph(key, ch.codePointAt(0)!));

/**
 * 語を、表示順（左から右）の区間に分ける。base は行の向き。
 * 同梱フォントのどれにも無い字があれば null（書けない）
 */
export function wordPieces(family: FontFamily, word: string, base: "L" | "R"): WordPiece[] | null {
  const latin = latinFont(family);
  const out: WordPiece[] = [];
  for (const run of bidiRuns(word, base)) {
    const letter = [...run.text].find((ch) => hasRtl(ch));
    const primary = letter ? scriptFont(family, letter.codePointAt(0)!) : latin && covers(latin, run.text) ? latin : pickFont(family, run.text);
    if (!primary) return null;
    const dir = run.dir === "rtl" ? "R" : "L";
    const pieces: WordPiece[] = [];
    for (const p of fontRuns(primary, run.text)) {
      // 主のフォントに無い字（ヘブライ文字の語に付いた句読点など）は、欧文用のフォントにあればそれで書く
      const key = p.key !== primary && latin && covers(latin, p.text) ? latin : p.key;
      const last = pieces[pieces.length - 1];
      if (last && last.key === key) last.text += p.text;
      else pieces.push({ key, text: p.text, dir });
    }
    if (pieces.some((p) => !covers(p.key, p.text))) return null;
    out.push(...(dir === "R" ? pieces.reverse() : pieces));
  }
  return out;
}

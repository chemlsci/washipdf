// インド系の文字：PDF の中の並び（字形の順＝見た目の順）と、入力するときの順の違いを扱う。
// 子音の左に置かれる母音記号（デーヴァナーガリーの ि など）は、PDF の中では子音より前にあるが、文字としては
// 子音（結合した子音のまとまり）の後ろに書く。

const PREBASE = "िিেৈਿિେୈெ-ைെ-ൈ";
const VIRAMA = "्্੍્୍்്";
const NUKTA = "़়਼઼଼";
const source = `([${PREBASE}])(\\p{Lo}[${NUKTA}]?(?:[${VIRAMA}]\\p{Lo}[${NUKTA}]?)*)`;

/** 見た目の順の文字列を、入力するときの順に直す：子音の左に置かれる母音記号を、続く子音のまとまりの後ろへ移す */
export function visualToLogical(text: string): string {
  return text.replace(new RegExp(source, "gu"), "$2$1");
}

/**
 * visualToLogical と同じ並べ替えをして、直した文字列の各位置（UTF-16 単位）が、元の文字列の何番目から来たかも返す。
 * 並べ替えるものが無ければ null
 */
export function logicalWithMap(text: string): { text: string; from: number[] } | null {
  const re = new RegExp(source, "gu");
  let out = "";
  const from: number[] = [];
  let at = 0;
  let any = false;
  const push = (start: number, end: number) => {
    for (let i = start; i < end; i++) from.push(i);
    out += text.slice(start, end);
  };
  for (const m of text.matchAll(re)) {
    any = true;
    push(at, m.index);
    const sign = m[1].length;
    push(m.index + sign, m.index + m[0].length); // 子音のまとまり
    push(m.index, m.index + sign); // 記号
    at = m.index + m[0].length;
  }
  if (!any) return null;
  push(at, text.length);
  return { text: out, from };
}

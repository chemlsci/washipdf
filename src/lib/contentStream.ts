/**
 * PDF コンテンツストリームの小さなトークナイザ。
 *
 * pdf-lib はコンテンツストリームを解釈する API を公開していないため、Tj / TJ などの命令を
 * 「どのバイト範囲にあるか」まで含めて取り出すための最小限の実装。
 * 命令ごとに [start, end) のバイト範囲を持つので、該当部分を別の文字列に置き換えられる。
 */

export type Operand =
  | { kind: "num"; value: number }
  | { kind: "name"; value: string }
  | { kind: "string"; bytes: Uint8Array }
  | { kind: "array"; items: Operand[] }
  | { kind: "dict"; raw: string }
  | { kind: "bool"; value: boolean }
  | { kind: "null" };

export interface ContentOp {
  /** 命令名（"Tj", "TJ", "Td" など） */
  op: string;
  operands: Operand[];
  /** 命令（オペランドを含む）の先頭バイト位置 */
  start: number;
  /** 命令の終端（次のトークンの手前） */
  end: number;
  /** インライン画像（BI）の画素数（/W・/H）。分からなければ無し */
  inlineSize?: [number, number];
}

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]); // ( ) < > [ ] { } / %

const isWs = (c: number) => WS.has(c);
const isDelim = (c: number) => DELIM.has(c);
const isRegular = (c: number) => !isWs(c) && !isDelim(c);

export function tokenizeContent(bytes: Uint8Array): ContentOp[] {
  const ops: ContentOp[] = [];
  const n = bytes.length;
  let i = 0;
  let operands: Operand[] = [];
  let opStart = -1;

  const skipWs = () => {
    for (;;) {
      while (i < n && isWs(bytes[i])) i++;
      if (i < n && bytes[i] === 0x25) {
        // コメント
        while (i < n && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++;
        continue;
      }
      break;
    }
  };

  const readLiteralString = (): Uint8Array => {
    // 先頭の "(" は読み済み
    const out: number[] = [];
    let depth = 1;
    while (i < n) {
      let c = bytes[i++];
      if (c === 0x5c) {
        // backslash
        if (i >= n) break;
        c = bytes[i++];
        switch (c) {
          case 0x6e: out.push(10); break; // n
          case 0x72: out.push(13); break; // r
          case 0x74: out.push(9); break; // t
          case 0x62: out.push(8); break; // b
          case 0x66: out.push(12); break; // f
          case 0x0d: if (bytes[i] === 0x0a) i++; break; // 行継続
          case 0x0a: break;
          default:
            if (c >= 0x30 && c <= 0x37) {
              let v = c - 0x30;
              for (let k = 0; k < 2 && i < n && bytes[i] >= 0x30 && bytes[i] <= 0x37; k++) v = v * 8 + (bytes[i++] - 0x30);
              out.push(v & 0xff);
            } else out.push(c);
        }
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        depth--;
        if (depth === 0) break;
        out.push(c);
      } else out.push(c);
    }
    return Uint8Array.from(out);
  };

  const readHexString = (): Uint8Array => {
    // 先頭の "<" は読み済み
    const out: number[] = [];
    let hi = -1;
    while (i < n) {
      const c = bytes[i++];
      if (c === 0x3e) break;
      let v = -1;
      if (c >= 0x30 && c <= 0x39) v = c - 0x30;
      else if (c >= 0x41 && c <= 0x46) v = c - 0x37;
      else if (c >= 0x61 && c <= 0x66) v = c - 0x57;
      else continue;
      if (hi < 0) hi = v;
      else {
        out.push(hi * 16 + v);
        hi = -1;
      }
    }
    if (hi >= 0) out.push(hi * 16);
    return Uint8Array.from(out);
  };

  const readRegular = (): string => {
    const s = i;
    while (i < n && isRegular(bytes[i])) i++;
    return latin1(bytes, s, i);
  };

  const readDictRaw = (): string => {
    // 先頭の "<<" は読み済み。入れ子と文字列を考慮して対応する ">>" まで読む
    const s = i - 2;
    let depth = 1;
    while (i < n && depth > 0) {
      const c = bytes[i];
      if (c === 0x3c && bytes[i + 1] === 0x3c) {
        depth++;
        i += 2;
      } else if (c === 0x3e && bytes[i + 1] === 0x3e) {
        depth--;
        i += 2;
      } else if (c === 0x28) {
        i++;
        readLiteralString();
      } else if (c === 0x3c) {
        i++;
        readHexString();
      } else i++;
    }
    return latin1(bytes, s, i);
  };

  let arrayDepth = 0;
  // 1トークンを読む。オペランドなら返し、命令なら null を返して name に命令名を入れる
  const readOperand = (): Operand | string => {
    const c = bytes[i];
    if (c === 0x2f) {
      i++;
      return { kind: "name", value: readRegular() };
    }
    if (c === 0x28) {
      i++;
      return { kind: "string", bytes: readLiteralString() };
    }
    if (c === 0x3c) {
      if (bytes[i + 1] === 0x3c) {
        i += 2;
        return { kind: "dict", raw: readDictRaw() };
      }
      i++;
      return { kind: "string", bytes: readHexString() };
    }
    if (c === 0x5b) {
      i++;
      // 入れ子が深すぎる配列（壊れたデータや細工）は、中身を読まずに空の配列として扱う（深い再帰で止まらないように）
      if (arrayDepth >= 64) return { kind: "array", items: [] };
      arrayDepth++;
      const items: Operand[] = [];
      for (;;) {
        skipWs();
        if (i >= n) break;
        if (bytes[i] === 0x5d) {
          i++;
          break;
        }
        const t = readOperand();
        if (typeof t === "string") {
          // 配列内に命令は来ないはずだが、壊れたデータでも止まらないようにする
          if (t === "") i++;
          continue;
        }
        items.push(t);
      }
      arrayDepth--;
      return { kind: "array", items };
    }
    if (c === 0x5d || c === 0x29 || c === 0x3e || c === 0x7b || c === 0x7d) {
      i++;
      return "";
    }
    const word = readRegular();
    if (word === "") {
      i++;
      return "";
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { kind: "num", value: parseFloat(word) };
    if (word === "true") return { kind: "bool", value: true };
    if (word === "false") return { kind: "bool", value: false };
    if (word === "null") return { kind: "null" };
    return word; // 命令
  };

  for (;;) {
    skipWs();
    if (i >= n) break;
    if (opStart < 0) opStart = i;
    const t = readOperand();
    if (typeof t !== "string") {
      operands.push(t);
      continue;
    }
    if (t === "") continue;
    if (t === "BI") {
      // インライン画像：ID の後のバイナリを EI まで読み飛ばす
      let j = i;
      const words: string[] = [];
      for (;;) {
        skipWs();
        if (i >= n) break;
        const w = readRegular();
        if (w === "ID") break;
        if (w === "") {
          // 名前（/W など）は区切り文字の「/」から始まるので、続く語とつなげて覚える
          if (bytes[i] === 0x2f) {
            i++;
            words.push("/" + readRegular());
            continue;
          }
          i++;
        } else words.push(w);
      }
      const dim = (keys: string[]) => {
        const k = words.findIndex((w) => keys.includes(w));
        const v = k >= 0 ? Number(words[k + 1]) : NaN;
        return Number.isFinite(v) && v > 0 ? v : 0;
      };
      const iw = dim(["/W", "/Width"]);
      const ih = dim(["/H", "/Height"]);
      i++; // ID の後の1バイト空白
      j = i;
      while (j < n) {
        if (bytes[j] === 0x45 && bytes[j + 1] === 0x49 && (j + 2 >= n || isWs(bytes[j + 2])) && isWs(bytes[j - 1])) break;
        j++;
      }
      i = Math.min(n, j + 2);
      ops.push({ op: "BI", operands: [], start: opStart, end: i, ...(iw && ih ? { inlineSize: [iw, ih] as [number, number] } : {}) });
      operands = [];
      opStart = -1;
      continue;
    }
    ops.push({ op: t, operands, start: opStart, end: i });
    operands = [];
    opStart = -1;
  }
  return ops;
}

export function latin1(bytes: Uint8Array, start: number, end: number): string {
  let s = "";
  for (let k = start; k < end; k++) s += String.fromCharCode(bytes[k]);
  return s;
}

export const num = (o: Operand | undefined, d = 0): number => (o && o.kind === "num" ? o.value : d);
export const name = (o: Operand | undefined): string | null => (o && o.kind === "name" ? o.value : null);

/** 数値を PDF 用の短い表記にする */
export function fmt(v: number): string {
  if (!Number.isFinite(v)) return "0";
  const s = v.toFixed(4).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}

/** バイト列を PDF の16進文字列にする */
export function hex(bytes: Uint8Array): string {
  let s = "<";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s + ">";
}

/** 指定したバイト範囲を別の文字列に置き換えた新しいストリームを作る（範囲は重ならないこと） */
export function spliceContent(bytes: Uint8Array, edits: { start: number; end: number; text: string }[]): Uint8Array {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  const parts: Uint8Array[] = [];
  let pos = 0;
  const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
  // 区切りの要らない字（空白と区切り文字 ( ) < > [ ] { } / %）以外どうしが隣り合うと、1 つの語としてつながってしまう。
  // 元の内容は「Tf<0102>Tj」のように空白なしで書かれていることがあるので、差し替えの前後では必ず確かめて空白を入れる
  // （入れないと「Tf」と差し替えの先頭「ET」がつながって「TfET」という無効な命令になり、フォントの指定が失われる）
  const regular = (b: number | undefined) => b !== undefined && !(b === 0 || b === 9 || b === 10 || b === 12 || b === 13 || b === 32 || "()<>[]{}/%".includes(String.fromCharCode(b)));
  let last: number | undefined;
  const push = (part: Uint8Array) => {
    if (!part.length) return;
    parts.push(part);
    last = part[part.length - 1];
  };
  for (const e of sorted) {
    if (e.start < pos) throw new Error("content edits overlap");
    push(bytes.subarray(pos, e.start));
    const text = enc(e.text);
    const next = text.length ? text[0] : bytes[e.end];
    if (regular(last) && regular(next)) push(Uint8Array.of(10));
    push(text);
    if (text.length && regular(last) && regular(bytes[e.end])) push(Uint8Array.of(10));
    pos = e.end;
  }
  parts.push(bytes.subarray(pos));
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

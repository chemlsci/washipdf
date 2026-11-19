/**
 * 文字の書き換えを「元の描画命令の文字列だけを差し替える」形で行う計画を立てる。
 *
 * 命令の位置・フォント・字送り・重なりの順序・切り抜きは一切触らず、変えた字の文字コードだけを入れ替えるので、
 * 変えていない字は元のまま残る。字送りは表示側が元のフォントの情報で行うため、縦書きでも使える
 * （縦書きは字送りの情報を自前で持っていないので、行を組み直すと字間が変わってしまう）。
 *
 * 使える条件：行の文字列と字形が命令の順に 1 対 1 で対応し、変えた部分が 1 つの命令の中に収まり、
 * 新しい字をその命令のフォントで書けること。合わなければ null（呼び出し側が従来の方法で書く）。
 */
import type { ContentOp, Operand } from "./contentStream";
import { fmt, hex } from "./contentStream";
import type { PageAnalysis } from "./libDoc";
import { pathKey, samePath, type ShowOp } from "./textOps";
import type { TextEditObj } from "./types";

const squash = (s: string) => s.normalize("NFKC").replace(/[\s\u0000-\u001f\u007f]+/g, "");

function showItems(op: ContentOp): Operand[] {
  const a = op.operands;
  if (op.op === '"') return a[2] ? [a[2]] : [];
  if (op.op === "TJ") return a[0]?.kind === "array" ? a[0].items : [];
  return a[0] ? [a[0]] : [];
}

interface G {
  show: ShowOp;
  sq: string;
  bytes: Uint8Array;
  /** 字の幅（1000 分率） */
  width: number;
}

export interface InPlacePlan {
  /** 差し替える命令（差し替えない命令は入らない＝元のまま残る） */
  removals: TextEditObj["removals"];
}

export function planInPlace(o: TextEditObj, a: PageAnalysis, why?: (reason: string) => void): InPlacePlan | null {
  const no = (reason: string): null => {
    why?.(reason);
    return null;
  };
  if (!o.removals.length || o.lines !== 1 || o.text.includes("\n") || o.original.includes("\n")) return no("multi");
  const wanted = new Set(o.removals.map((r) => pathKey(r.path ?? [], r.index)));
  const shows = a.shows.filter((s) => wanted.has(pathKey(s.path, s.index)));
  if (shows.length !== wanted.size) return no("ops");
  if (shows.some((s) => !samePath(s.path, shows[0].path))) return no("ops");
  const opsOf = (s: ShowOp) => (s.path.length ? a.forms.find((f) => samePath(f.path, s.path))?.ops : a.ops);

  // 命令の順（＝読む順）に字形を並べる
  const glyphs: G[] = [];
  for (const s of shows) {
    const op = opsOf(s)?.[s.index];
    if (!op || !s.font) return no("ops");
    for (const it of showItems(op)) {
      if (it.kind !== "string") continue;
      let off = 0;
      for (const c of s.font.decode(it.bytes)) {
        const n = Math.max(1, c.nbytes);
        const bytes = it.bytes.subarray(off, off + n);
        off += n;
        const u = s.font.toUnicode(c);
        if (u == null || u.includes("�")) {
          if (!c.isSpace) return no("mismatch");
          continue;
        }
        const sq = squash(u);
        if (sq) glyphs.push({ show: s, sq, bytes, width: s.font.width(c) });
      }
    }
  }
  const A = o.original;
  const B = o.text;
  const posAt: number[] = [];
  let rText = "";
  for (const ch of A) {
    for (let i = 0; i < ch.length; i++) posAt.push(rText.length);
    rText += squash(ch);
  }
  posAt.push(rText.length);
  const starts = new Map<number, number>();
  let gText = "";
  glyphs.forEach((g, i) => {
    starts.set(gText.length, i);
    gText += g.sq;
  });
  starts.set(gText.length, glyphs.length);
  if (gText !== rText) return no("mismatch");

  // 共通する先頭と末尾（字形の切れ目に合わせる）
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let q = 0;
  while (q < A.length - p && q < B.length - p && A[A.length - 1 - q] === B[B.length - 1 - q]) q++;
  const low = (c: number) => c >= 0xdc00 && c <= 0xdfff;
  const cut = (i: number) => starts.has(posAt[i]) && !low(A.charCodeAt(i));
  while (p > 0 && !cut(p)) p--;
  while (q > 0 && !cut(A.length - q)) q--;
  const nPre = starts.get(posAt[p])!;
  const nSuf = starts.get(posAt[A.length - q])!;
  const middle = B.slice(p, B.length - q);
  const oldText = A.slice(p, A.length - q);
  if (middle === oldText) return { removals: [] }; // 変えていない
  // 空白の増減は、字形ではなく位置で表していることが多いので扱わない
  if (/\s/.test(middle) || /\s/.test(oldText)) return no("space");

  // 字が増えると列からはみ出す。その場合は、縮めて収める従来の処理に任せる
  if ([...middle].length > nSuf - nPre) return no("longer");

  // 差し替える命令：消す字があればその命令、足すだけなら直前（無ければ直後）の字の命令
  const target = (glyphs[nPre < nSuf ? nPre : nPre - 1] ?? glyphs[nSuf])?.show;
  if (!target?.font) return no("empty");
  for (let i = nPre; i < nSuf; i++) if (glyphs[i].show !== target) return no("span");
  const font = target.font;
  const add: number[] = [];
  let newWidth = 0;
  for (const ch of middle) {
    newWidth += font.widthOfCodePoint(ch.codePointAt(0)!) ?? 0;
    const b = font.encode(ch.codePointAt(0)!);
    if (!b) return no("glyph");
    // 書いた字が、あとで同じ字として取り出せること（元の文書で使っていなかった字形は、対応表に無いことがある）
    const back = font.toUnicode(font.decode(b)[0]);
    if (back == null || squash(back) !== squash(ch)) return no("glyph");
    add.push(...b);
  }

  // 横書きで、変えた所より後ろの字が別の命令にあるとき：その命令は自分の位置を持っていて、幅が変わっても動かない。
  // 幅がほとんど変わらないときだけ、ここで扱う（変わるときは、後ろをずらせる別の方法に任せる）
  if (!font.vertical && glyphs.slice(nSuf).some((g) => g.show !== target)) {
    const oldWidth = glyphs.slice(nPre, nSuf).reduce((n, g) => n + g.width, 0);
    if (Math.abs(newWidth - oldWidth) > 20) return no("shift");
  }

  // 新しい命令を組み立てる：残す字の文字コードと、その間の位置の調整（数値）はそのまま。消す字の所に新しい字を入れる
  const op = opsOf(target)![target.index];
  const drop = new Set(glyphs.slice(nPre, nSuf));
  const insertBefore = nPre < nSuf ? glyphs[nPre] : null; // 消す最初の字の位置に入れる
  const insertAfter = nPre < nSuf ? null : glyphs[nPre - 1]?.show === target ? glyphs[nPre - 1] : null; // 足すだけ：直前の字の後ろ
  const insertFirst = !insertBefore && !insertAfter; // 直後の字の前（命令の先頭側）
  const byBytes = new Map<Uint8Array, G>();
  for (const g of glyphs) if (g.show === target) byBytes.set(g.bytes, g);
  const items: string[] = [];
  let cur: number[] = [];
  let inserted = false;
  let lastDropped = false;
  const flush = () => {
    if (cur.length) items.push(hex(Uint8Array.from(cur)));
    cur = [];
  };
  const put = () => {
    if (inserted) return;
    inserted = true;
    cur.push(...add);
  };
  for (const it of showItems(op)) {
    if (it.kind === "num") {
      if (lastDropped && !cur.length) continue;
      flush();
      items.push(fmt(it.value));
      continue;
    }
    if (it.kind !== "string") continue;
    let off = 0;
    for (const c of font.decode(it.bytes)) {
      const n = Math.max(1, c.nbytes);
      const bytes = it.bytes.subarray(off, off + n);
      off += n;
      const g = byBytes.get(bytes) ?? [...byBytes.values()].find((x) => x.bytes.byteOffset === bytes.byteOffset && x.bytes.buffer === bytes.buffer);
      if (g && insertFirst && g === glyphs[nSuf]) put();
      if (g && g === insertBefore) put();
      if (g && drop.has(g)) {
        lastDropped = true;
        continue;
      }
      lastDropped = false;
      for (const x of bytes) cur.push(x);
      if (g && g === insertAfter) put();
    }
  }
  if (!inserted) put();
  flush();
  const body = items.length === 1 && items[0].startsWith("<") ? `${items[0]} Tj` : `[${items.join(" ")}] TJ`;
  const a0 = op.operands;
  const num = (x: Operand | undefined) => (x?.kind === "num" ? fmt(x.value) : "0");
  const head = op.op === '"' ? `${num(a0[0])} Tw ${num(a0[1])} Tc T* ` : op.op === "'" ? "T* " : "";
  const r = o.removals.find((x) => x.index === target.index && samePath(x.path ?? [], target.path))!;
  return { removals: [{ index: target.index, op: r.op, replacement: head + body, path: r.path }] };
}

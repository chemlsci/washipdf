/**
 * 字形整形（シェーピング）：アラビア語・タイ語・インド系文字のように、文字の並びで字形が変わったり
 * 結合記号の位置を調整したりする文字を、同梱フォントで正しく書くための処理。
 *
 * - 整形そのものは fontkit（pdf-lib が使う OpenType 実装。GSUB/GPOS のシェーパーを持つ）に任せる。
 * - 書き出しでは整形後のグリフ番号を直接書く（埋め込むサブセットには GSUB/GPOS を入れないので、
 *   フォント側で再整形されることはない）。位置の調整は TJ の数値と Ts（上下）で表す。
 * - 双方向（アラビア語と数字・欧文の混在）は、文字の方向で区切った「走り」を右から左に並べる簡易版。
 */
import "regenerator-runtime/runtime.js";
import fontkit from "@pdf-lib/fontkit";
import type { PDFFont, PDFPage } from "pdf-lib";
import { getAsset } from "./assets";
import { fmt } from "./contentStream";
import { glyphIdForCodePoint, parseTtf, type TtfInfo } from "./ttfSubset";
import type { FontKey } from "./types";

interface FkGlyph {
  id: number;
  codePoints: number[];
  advanceWidth: number;
}
interface FkPosition {
  xAdvance: number;
  yAdvance: number;
  xOffset: number;
  yOffset: number;
}
interface FkRun {
  glyphs: FkGlyph[];
  positions: FkPosition[];
}
interface FkFont {
  unitsPerEm: number;
  characterSet: number[];
  layout(text: string, features?: unknown, script?: unknown, language?: unknown, direction?: string): FkRun;
  glyphForCodePoint(cp: number): FkGlyph;
}

const cache = new Map<FontKey, FkFont>();
const ttfCache = new Map<FontKey, TtfInfo>();

/**
 * 注意：fontkit はグリフ番号ごとに Glyph オブジェクトを使い回し、最初に作ったときの codePoints を保持する。
 * glyphForCodePoint を互換用コードポイント（アラビア語の表示形など）で呼ぶと、整形結果の codePoints が
 * その値に汚染されるため、文字 → グリフ番号の直引きは自前の cmap 解析（ttfSubset）で行う。
 */
function ttf(key: FontKey): TtfInfo {
  let t = ttfCache.get(key);
  if (!t) {
    t = parseTtf(getAsset(`font-${key}`));
    ttfCache.set(key, t);
  }
  return t;
}

function fk(key: FontKey): FkFont {
  let f = cache.get(key);
  if (!f) {
    f = (fontkit as unknown as { create(b: Uint8Array): FkFont }).create(getAsset(`font-${key}`));
    // fontkit は同じグリフ番号の Glyph を使い回し、codePoints は最初に作ったときのまま（点の部品を共有する
    // ب／ت／ن／ي などで文字が入れ替わる）。呼び出しごとの codePoints を持つ派生オブジェクトを返すようにする
    const inner = f as unknown as { getGlyph(id: number, chars?: number[]): FkGlyph };
    const orig = inner.getGlyph.bind(inner);
    inner.getGlyph = (id: number, chars: number[] = []) => Object.create(orig(id, chars), { codePoints: { value: chars, enumerable: true } }) as FkGlyph;
    cache.set(key, f);
  }
  return f;
}

/** manifest で shaping 指定のあるフォントか（判定は fonts.ts が登録する。循環 import を避けるため） */
let shapingLookup: (key: FontKey) => boolean = () => false;
export function setShapingLookup(fn: (key: FontKey) => boolean): void {
  shapingLookup = fn;
}
export function isShapingFont(key: FontKey): boolean {
  return shapingLookup(key);
}

/* ---------- 双方向（簡易） ---------- */

type Dir = "L" | "R" | "N";

function strongDir(cp: number): Dir {
  const ch = String.fromCodePoint(cp);
  // 数字は左から右に読む（アラビア文字の数字 ١٢٣ も、桁の並びは左から右）
  if (/\p{Nd}/u.test(ch)) return "L";
  // アラビア文字の数字の区切り（٪ ٫ ٬）は、前後の数字に従う
  if (cp >= 0x066a && cp <= 0x066c) return "N";
  if ((cp >= 0x0590 && cp <= 0x08ff) || (cp >= 0xfb1d && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff)) return "R";
  if (/\p{L}/u.test(ch)) return "L";
  return "N";
}

export interface BidiRun {
  text: string;
  dir: "ltr" | "rtl";
}

/** 文字列を方向ごとの走りに分け、表示順（左から右）に並べる */
export function bidiRuns(text: string, base?: "L" | "R"): BidiRun[] {
  const chars = [...text];
  if (!chars.length) return [];
  const types = chars.map((c) => strongDir(c.codePointAt(0)!));
  // 段落の向き：指定が無ければ、最初の向きのある字で決める。行の一部だけを整形するとき（1 行を複数のフォントで書く場合）は、
  // 行全体の向きを base で受け取る（数字で始まる区間でも、右から左の行の中では右から左に並べる）
  // 数字は段落の向きを決めない（数字で始まるアラビア語の行は、右から左）
  const para: Dir = base ?? types.find((t, i) => t !== "N" && !/\p{Nd}/u.test(chars[i])) ?? types.find((t) => t !== "N") ?? "L";
  // 中立文字は両隣が同じ方向ならそれに、違えば段落の方向に従う
  const resolved: ("L" | "R")[] = [];
  for (let i = 0; i < types.length; i++) {
    const t = types[i];
    if (t !== "N") {
      resolved.push(t);
      continue;
    }
    let prev: Dir = "N";
    for (let j = i - 1; j >= 0; j--) {
      if (types[j] !== "N") {
        prev = types[j];
        break;
      }
    }
    let next: Dir = "N";
    for (let j = i + 1; j < types.length; j++) {
      if (types[j] !== "N") {
        next = types[j];
        break;
      }
    }
    resolved.push(prev !== "N" && prev === next ? prev : para === "R" ? "R" : "L");
  }
  const runs: BidiRun[] = [];
  let start = 0;
  for (let i = 1; i <= chars.length; i++) {
    if (i === chars.length || resolved[i] !== resolved[start]) {
      runs.push({ text: chars.slice(start, i).join(""), dir: resolved[start] === "R" ? "rtl" : "ltr" });
      start = i;
    }
  }
  return para === "R" ? runs.reverse() : runs;
}

/* ---------- 整形 ---------- */

/** 左右で対になる記号。右から左の区間では、左右が逆の形で表示される（「(」は「)」の形になる） */
const MIRROR = new Map<number, number>();
for (const [o, c] of ["()", "[]", "{}", "<>", "\u00ab\u00bb", "\u2039\u203a"]) {
  MIRROR.set(o.codePointAt(0)!, c.codePointAt(0)!);
  MIRROR.set(c.codePointAt(0)!, o.codePointAt(0)!);
}
export const mirrored = (text: string) => [...text].map((ch) => String.fromCodePoint(MIRROR.get(ch.codePointAt(0)!) ?? ch.codePointAt(0)!)).join("");

export interface ShapedGlyph {
  gid: number;
  /** 行頭からの描画位置（フォント単位） */
  x: number;
  y: number;
  /** hmtx の送り幅（フォント単位。PDF がこの分だけペンを進める） */
  adv: number;
  /** 対応する文字（合字は複数、記号だけの字形は空） */
  cps: number[];
}

export interface Shaped {
  glyphs: ShapedGlyph[];
  /** 行の幅（フォント単位） */
  width: number;
  upm: number;
}

const shapeCache = new Map<string, Shaped>();

/**
 * 字形の並びと位置を求める。フォントの位置合わせの表（GPOS）に、付け位置の無い項目があると、fontkit は例外で止まる
 * （アラビア文字の記号の付け位置で起きる）。そのときは、付け位置が無い項目を「ずらさない」として読むようにして、やり直す。
 * それでも止まるなら、整形なしで 1 字ずつ並べる（保存そのものが失敗するよりよい）。
 */
function safeLayout(font: ReturnType<typeof fk>, text: string, dir: "ltr" | "rtl") {
  type Pos = { xAdvance: number; xOffset: number; yOffset: number };
  type Run = { glyphs: { id: number; advanceWidth: number; codePoints?: number[] }[]; positions: Pos[] };
  const run = () => font.layout(text, undefined, undefined, undefined, dir) as unknown as Run;
  try {
    return run();
  } catch {
    try {
      const engine = (font as unknown as { _layoutEngine?: { engine?: { GPOSProcessor?: object } } })._layoutEngine?.engine;
      const proto = engine?.GPOSProcessor ? (Object.getPrototypeOf(engine.GPOSProcessor) as { getAnchor?: (a: unknown) => unknown; __washiPatched?: boolean }) : null;
      if (proto?.getAnchor && !proto.__washiPatched) {
        const orig = proto.getAnchor;
        proto.getAnchor = function (this: unknown, anchor: unknown) {
          return anchor ? orig.call(this, anchor) : { x: 0, y: 0 };
        };
        proto.__washiPatched = true;
      }
      return run();
    } catch {
      const cps = [...text].map((ch) => ch.codePointAt(0)!);
      if (dir === "rtl") cps.reverse();
      const glyphs = cps.map((cp) => {
        const g = font.glyphForCodePoint(cp) as unknown as { id: number; advanceWidth: number };
        return { id: g.id, advanceWidth: g.advanceWidth, codePoints: [cp] };
      });
      return { glyphs, positions: glyphs.map((g) => ({ xAdvance: g.advanceWidth, xOffset: 0, yOffset: 0 })) };
    }
  }
}

export function shapeText(key: FontKey, text: string, base?: "L" | "R"): Shaped {
  const ck = `${key}\u0000${base ?? ""}\u0000${text}`;
  const hit = shapeCache.get(ck);
  if (hit) return hit;
  const font = fk(key);
  const glyphs: ShapedGlyph[] = [];
  let pen = 0;
  for (const run of bidiRuns(text, base)) {
    // 右から左の区間では、かっこなどを左右逆の形で書く（整形の処理は字形の順を逆にするだけで、形は入れ替えない）。
    // 字形が表す文字は、読む順での文字のままにする（取り出したときに、開きと閉じが入れ替わらないように）
    const rtl = run.dir === "rtl";
    const r = safeLayout(font, rtl ? mirrored(run.text) : run.text, run.dir);
    r.glyphs.forEach((g, i) => {
      const p = r.positions[i];
      const cps = g.codePoints ?? [];
      glyphs.push({ gid: g.id, x: pen + p.xOffset, y: p.yOffset, adv: g.advanceWidth, cps: rtl && cps.length === 1 && MIRROR.has(cps[0]) ? [MIRROR.get(cps[0])!] : cps });
      pen += p.xAdvance;
    });
  }
  const out = { glyphs, width: pen, upm: font.unitsPerEm };
  if (shapeCache.size > 2000) shapeCache.clear();
  shapeCache.set(ck, out);
  return out;
}

export function shapedWidth(key: FontKey, text: string, size: number): number {
  const s = shapeText(key, text);
  return (s.width / s.upm) * size;
}

const hex4 = (n: number) => n.toString(16).padStart(4, "0");

/**
 * 1 つの字形が複数の文字を表す場合（点の部品を共有する ب／ت／ن／ي など）、
 * 文字ごとに別のグリフ番号（複製）を割り当てて ToUnicode を正確にする。
 * prepareShapedEmbedding で表を作り、描画時（shapedShowOps）に引く。
 */
interface AliasTable {
  nextGid: number;
  /** 元のグリフ番号 → 代表する文字 */
  canonical: Map<number, string>;
  /** "gid:文字" → 複製のグリフ番号 */
  byKey: Map<string, number>;
  /** 複製のグリフ番号 → 元のグリフ番号 */
  clones: Map<number, number>;
}
const aliases = new Map<FontKey, AliasTable>();

function aliasGid(key: FontKey, gid: number, cps: number[]): number {
  const t = aliases.get(key);
  if (!t || !cps.length) return gid;
  const s = String.fromCodePoint(...cps);
  if (t.canonical.get(gid) === s) return gid;
  return t.byKey.get(`${gid}:${s}`) ?? gid;
}

/**
 * 1 行分の文字描画命令（"[...] TJ"、必要なら Ts 付き）。グリフ番号を直接書く。
 * wordSpacing は Type0 フォントでは Tw が効かないため、空白の後ろの位置をずらして表す。
 */
export function shapedShowOps(key: FontKey, text: string, size: number, wordSpacing = 0, base?: "L" | "R"): string {
  const s = shapeText(key, text, base);
  if (!s.glyphs.length) return "";
  const k = 1000 / s.upm; // フォント単位 → 1/1000 テキスト空間
  const out: string[] = [];
  let items: string[] = [];
  let run = "";
  let pen = 0;
  let shift = 0;
  let rise = 0;
  const flushRun = () => {
    if (run) items.push(`<${run}>`);
    run = "";
  };
  const closeArray = () => {
    flushRun();
    if (items.length) out.push(`[${items.join(" ")}] TJ`);
    items = [];
  };
  for (const g of s.glyphs) {
    if (g.y !== rise) {
      closeArray();
      rise = g.y;
      out.push(`${fmt((rise / s.upm) * size)} Ts`);
    }
    const target = g.x + shift;
    const delta = target - pen;
    if (Math.abs(delta) * k >= 0.5) {
      flushRun();
      items.push(fmt(-delta * k));
      pen = target;
    }
    run += hex4(aliasGid(key, g.gid, g.cps));
    pen += g.adv;
    if (wordSpacing && g.cps.includes(0x20)) shift += (wordSpacing / size) * s.upm;
  }
  closeArray();
  if (rise !== 0) out.push("0 Ts");
  // 論理順の文字列を ActualText で添える（Acrobat などはこれを抽出に使う。pdf.js は ToUnicode を使う）
  let actual = "feff";
  for (let i = 0; i < text.length; i++) actual += hex4(text.charCodeAt(i));
  return `/Span << /ActualText <${actual}> >> BDC ${out.join(" ")} EMC`;
}

/**
 * 埋め込みに必要なグリフ（整形後のもの）、ToUnicode 用の対応表、字形の複製を作る。
 * 書き出し 1 回につきフォントごとに 1 回呼ぶ（描画時はここで作った表を使う）。
 */
export function prepareShapedEmbedding(key: FontKey, text: string): { extraGids: Set<number>; gidToUnicode: Map<number, string>; clones: Map<number, number> } {
  const f = ttf(key);
  const extraGids = new Set<number>();
  const gidToUnicode = new Map<number, string>();
  const table: AliasTable = { nextGid: f.numGlyphs, canonical: new Map(), byKey: new Map(), clones: new Map() };
  aliases.set(key, table);
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const gid = glyphIdForCodePoint(f, cp);
    if (gid) {
      extraGids.add(gid);
      if (!gidToUnicode.has(gid)) gidToUnicode.set(gid, ch);
    }
  }
  for (const [gid, ch] of gidToUnicode) table.canonical.set(gid, ch);
  /** 分解できる文字（ำ → ํ ＋ า）の、部品の字形 → その文字 */
  const partOf = new Map<number, string>();
  for (const ch of new Set(text)) {
    const parts = [...ch.normalize("NFKD")];
    if (parts.length < 2) continue;
    for (const p of parts) {
      const gid = glyphIdForCodePoint(f, p.codePointAt(0)!);
      if (gid && !partOf.has(gid)) partOf.set(gid, p);
    }
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    // 行の向きを指定して整形する場合（1 行を複数のフォントで書くとき、語ごとに書くとき）の字形も含める
    const seen = new Set<string>();
    const variants = [shapeText(key, line), shapeText(key, line, "L"), shapeText(key, line, "R")].flatMap((v) =>
      v.glyphs.map((g, i) => {
        if (!g.cps.length) return { g, s: null as string | null };
        let s = String.fromCodePoint(...g.cps);
        // 1 つの文字が複数の字形に分かれるとき（タイ文字の ำ ＝ 丸＋ า など）は、それぞれの字形を分解後の文字に対応付ける。
        // どちらの字形にも元の文字を割り当てると、取り出したときに文字が重複する（「ำา」のようになる）
        if (g.cps.length === 1) {
          const parts = [...s.normalize("NFKD")];
          if (parts.length > 1) {
            const own = parts.find((ch) => glyphIdForCodePoint(f, ch.codePointAt(0)!) === g.gid);
            if (own) s = own;
            else if (!/\p{M}/u.test(parts[0]) && parts.slice(1).every((ch) => /\p{M}/u.test(ch))) {
              // 字と記号に分けて描かれる文字（アラビア文字の أ ＝ ا ＋ ハムザ など）で、字のほうが前後の字に合わせた別の字形に
              // なっている場合：すぐ隣に記号の字形があれば、この字形は字だけを表す（そうしないと「أ」＋ハムザ と二重に取り出される）
              const marks = new Set(parts.slice(1).map((ch) => glyphIdForCodePoint(f, ch.codePointAt(0)!)).filter(Boolean));
              const near = [v.glyphs[i - 2], v.glyphs[i - 1], v.glyphs[i + 1], v.glyphs[i + 2]];
              if (near.some((n) => n && marks.has(n.gid))) s = parts[0];
            }
          }
        }
        return { g, s };
      }),
    ).filter(({ g, s }) => {
      const id = `${g.gid}:${s ?? ""}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    for (const { g, s: mapped } of variants) {
      extraGids.add(g.gid);
      if (mapped === null) {
        // 文字に対応しない字形（点などの部品）は、抽出で化けないよう幅ゼロ空白（U+200B）にする
        // （空文字列への対応は pdf.js が無視してグリフ番号をそのまま文字にしてしまうため）
        // ただし、1 つの文字を分けて描いた片方（タイ文字の ำ の「า」など）なら、分解後のその文字にする
        if (!gidToUnicode.has(g.gid)) gidToUnicode.set(g.gid, partOf.get(g.gid) ?? "\u200b");
        continue;
      }
      const s = mapped;
      const canon = table.canonical.get(g.gid);
      if (canon === undefined) {
        table.canonical.set(g.gid, s);
        gidToUnicode.set(g.gid, s);
      } else if (canon !== s) {
        const k = `${g.gid}:${s}`;
        if (!table.byKey.has(k)) {
          const n = table.nextGid++;
          table.byKey.set(k, n);
          table.clones.set(n, g.gid);
          gidToUnicode.set(n, s);
        }
      }
    }
  }
  return { extraGids, gidToUnicode, clones: table.clones };
}

/** ToUnicode CMap（Identity-H、2 バイトのグリフ番号 → UTF-16BE） */
export function toUnicodeCMap(map: Map<number, string>): string {
  const entries = [...map].sort((a, b) => a[0] - b[0]);
  const utf16 = (s: string) => {
    let h = "";
    for (let i = 0; i < s.length; i++) h += hex4(s.charCodeAt(i));
    return h;
  };
  const blocks: string[] = [];
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    blocks.push(`${chunk.length} beginbfchar\n${chunk.map(([gid, s]) => `<${hex4(gid)}> <${utf16(s)}>`).join("\n")}\nendbfchar`);
  }
  return `%% Washi PDF shaped ToUnicode
/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <ffff>
endcodespacerange
${blocks.join("\n")}
endcmap
CMapName currentdict /CMap defineresource pop
end
end
`;
}

/* ---------- 直接描画（pdf-lib の drawText の代わり） ---------- */

function colorOps(hexColor: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hexColor.trim());
  if (!m) return "0 g";
  const n = parseInt(m[1], 16);
  return `${fmt(((n >> 16) & 255) / 255)} ${fmt(((n >> 8) & 255) / 255)} ${fmt((n & 255) / 255)} rg`;
}

export interface ShapedDrawOptions {
  /** 行全体の向き（行の一部だけを書くとき）。無ければ、渡した文字列から決める */
  base?: "L" | "R";
  /** PDF 座標（ベースラインの左端） */
  x: number;
  y: number;
  size: number;
  color: string;
  opacity?: number;
  /** 反時計回りの角度（度） */
  rotateDeg?: number;
  wordSpacing?: number;
}

/**
 * 整形が必要なフォントなら、整形したグリフを直接ページに書いて true を返す。
 * そうでなければ何もせず false（呼び出し側が drawText を使う）。
 */
export function drawTextMaybeShaped(page: PDFPage, key: FontKey, font: PDFFont, text: string, o: ShapedDrawOptions): boolean {
  if (!isShapingFont(key) || !text) return false;
  const ctx = page.doc.context;
  const res = page.node.newFontDictionary(font.name, font.ref).decodeText();
  let gs = "";
  if (o.opacity != null && o.opacity < 1) {
    const ref = ctx.register(ctx.obj({ Type: "ExtGState", ca: o.opacity, CA: o.opacity }));
    gs = `/${page.node.newExtGState("WashiGS", ref).decodeText()} gs\n`;
  }
  const t = ((o.rotateDeg ?? 0) * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const content = `q\n${gs}BT\n${colorOps(o.color)}\n/${res} ${fmt(o.size)} Tf\n${fmt(cos)} ${fmt(sin)} ${fmt(-sin)} ${fmt(cos)} ${fmt(o.x)} ${fmt(o.y)} Tm\n${shapedShowOps(key, text, o.size, o.wordSpacing, o.base)}\nET\nQ\n`;
  page.node.addContentStream(ctx.register(ctx.flateStream(content)));
  return true;
}

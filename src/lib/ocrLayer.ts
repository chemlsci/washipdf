// 文字認識（OCR）の結果を、見えない文字の層としてページに書き足す。
//
// 画像だけのページ（スキャン）に、認識した語をその位置に「描画しない文字」（文字の描画モード 3）で書く。
// 見た目は変わらず、検索・選択・コピーができるようになる（語を探して墨消しもできる）。
// フォントは、字形を持たない小さなフォント 1 つ（どの文字にも同じ空の字形を当てる）。文字は UTF-16 の値をそのまま文字コードにして書き、
// 文字コード → 文字の対応表（ToUnicode）で元の文字に戻す。どの言語の文字でも、フォントを足さずに書ける。

import { PDFDocument, PDFString } from "pdf-lib";
import { fmt } from "./contentStream";
import { invert, multiply } from "./geometry";
import type { Matrix } from "./types";

/** 認識した語（表示座標 pt、左上原点） */
export interface OcrWord {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 認識した 1 行（縦書きなら 1 列） */
export interface OcrLine {
  words: OcrWord[];
  x: number;
  y: number;
  w: number;
  h: number;
  /** 縦書きの列か */
  vertical: boolean;
}

export interface OcrPageResult {
  /** 元 PDF でのページ番号（0 始まり） */
  index: number;
  /** PDF の座標 → 表示座標の変換（PageItem.viewTransform） */
  viewTransform: Matrix;
  lines: OcrLine[];
}

const FONT_NAME = "WashiOCR";
/** フォントの上端・下端（1000 分率）。選択したときの帯の高さになる */
const ASCENT = 880;
const DESCENT = -120;

function checksum(data: Uint8Array): number {
  let sum = 0;
  const n = (data.length + 3) & ~3;
  for (let i = 0; i < n; i += 4) sum = (sum + (((data[i] ?? 0) << 24) | ((data[i + 1] ?? 0) << 16) | ((data[i + 2] ?? 0) << 8) | (data[i + 3] ?? 0))) >>> 0;
  return sum;
}

/** フォントの名前の表（Windows・Unicode。書体名・スタイル・正式名・PostScript 名） */
function nameTable(family: string): Uint8Array {
  const items: [number, string][] = [
    [1, family],
    [2, "Regular"],
    [4, family],
    [6, family],
  ];
  const strings = items.map(([, t]) => {
    const b = new Uint8Array(t.length * 2);
    for (let i = 0; i < t.length; i++) {
      b[i * 2] = t.charCodeAt(i) >> 8;
      b[i * 2 + 1] = t.charCodeAt(i) & 0xff;
    }
    return b;
  });
  const head = 6 + items.length * 12;
  const out = new Uint8Array(head + strings.reduce((n, b) => n + b.length, 0));
  const v = new DataView(out.buffer);
  v.setUint16(2, items.length);
  v.setUint16(4, head);
  let off = 0;
  items.forEach(([id], i) => {
    const p = 6 + i * 12;
    v.setUint16(p, 3); // Windows
    v.setUint16(p + 2, 1); // Unicode BMP
    v.setUint16(p + 4, 0x409); // 英語（米国）
    v.setUint16(p + 6, id);
    v.setUint16(p + 8, strings[i].length);
    v.setUint16(p + 10, off);
    out.set(strings[i], head + off);
    off += strings[i].length;
  });
  return out;
}

/** 字形を持たない TrueType フォント（空の字形 2 つ。幅は 1 em） */
export function glyphlessFont(): Uint8Array {
  const table = (size: number, fill: (v: DataView) => void) => {
    const b = new Uint8Array(size);
    fill(new DataView(b.buffer));
    return b;
  };
  const tables = new Map<string, Uint8Array>([
    [
      "head",
      table(54, (v) => {
        v.setUint32(0, 0x00010000);
        v.setUint32(4, 0x00010000);
        v.setUint32(12, 0x5f0f3cf5);
        v.setUint16(16, 0x000b);
        v.setUint16(18, 1000); // unitsPerEm
        v.setInt16(36, 0);
        v.setInt16(38, DESCENT);
        v.setInt16(40, 1000);
        v.setInt16(42, ASCENT);
        v.setUint16(46, 8); // lowestRecPPEM
        v.setInt16(48, 2);
        v.setInt16(50, 1); // loca は long 形式
      }),
    ],
    [
      "hhea",
      table(36, (v) => {
        v.setUint32(0, 0x00010000);
        v.setInt16(4, ASCENT);
        v.setInt16(6, DESCENT);
        v.setUint16(10, 1000); // advanceWidthMax
        v.setInt16(16, 1000); // xMaxExtent
        v.setInt16(18, 1); // caretSlopeRise
        v.setUint16(34, 2); // numberOfHMetrics
      }),
    ],
    [
      "maxp",
      table(32, (v) => {
        v.setUint32(0, 0x00010000);
        v.setUint16(4, 2); // numGlyphs
        v.setUint16(14, 1); // maxZones
      }),
    ],
    [
      "hmtx",
      table(8, (v) => {
        v.setUint16(0, 1000);
        v.setUint16(4, 1000);
      }),
    ],
    [
      // 文字 → 字形の表（空白 → 1 番の字形）。表が無いフォントは、ソフトによっては「壊れている」と扱われる
      "cmap",
      table(44, (v) => {
        v.setUint16(2, 1); // 表の数
        v.setUint16(4, 3); // Windows
        v.setUint16(6, 1); // Unicode BMP
        v.setUint32(8, 12);
        v.setUint16(12, 4); // 形式 4
        v.setUint16(14, 32); // 長さ
        v.setUint16(18, 4); // 区間の数 × 2
        v.setUint16(20, 4);
        v.setUint16(22, 1);
        v.setUint16(26, 0x20); // 終わりの文字コード
        v.setUint16(28, 0xffff);
        v.setUint16(32, 0x20); // 始まりの文字コード
        v.setUint16(34, 0xffff);
        v.setUint16(36, (1 - 0x20) & 0xffff); // 文字コード → 字形番号の差
        v.setUint16(38, 1);
      }),
    ],
    ["loca", new Uint8Array(12)],
    // どの字形も中身が無い（loca の位置がすべて 0）ので、glyf は空にする（余分な詰め物があると、ソフトによっては警告する）
    ["glyf", new Uint8Array(0)],
    [
      // 字の大きさ・太さなどの情報（無いと「フォントが壊れている」とみなすソフトがある）
      "OS/2",
      table(96, (v) => {
        v.setUint16(0, 4); // 版
        v.setInt16(2, 1000); // 平均の字幅
        v.setUint16(4, 400); // 太さ（標準）
        v.setUint16(6, 5); // 幅（標準）
        v.setInt16(26, 50); // 取り消し線の太さ
        v.setInt16(28, 250); // 取り消し線の位置
        for (let k = 0; k < 4; k++) v.setUint8(58 + k, "NONE".charCodeAt(k)); // 作成元の印
        v.setUint16(62, 0x40); // 標準の書体
        v.setUint16(64, 0x20); // 最初の文字
        v.setUint16(66, 0xffff); // 最後の文字
        v.setInt16(68, ASCENT);
        v.setInt16(70, DESCENT);
        v.setUint16(74, ASCENT);
        v.setUint16(76, -DESCENT);
        v.setInt16(88, 700); // 大文字の高さ
        v.setUint16(92, 0x20); // 区切りの文字
      }),
    ],
    ["name", nameTable(FONT_NAME)],
    [
      "post",
      table(32, (v) => {
        v.setUint32(0, 0x00030000);
      }),
    ],
  ]);
  const tags = [...tables.keys()].sort();
  let entrySelector = 0;
  while (1 << (entrySelector + 1) <= tags.length) entrySelector++;
  const searchRange = (1 << entrySelector) * 16;
  let size = 12 + tags.length * 16;
  for (const t of tags) size += (tables.get(t)!.length + 3) & ~3;
  const out = new Uint8Array(size);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, 0x00010000);
  ov.setUint16(4, tags.length);
  ov.setUint16(6, searchRange);
  ov.setUint16(8, entrySelector);
  ov.setUint16(10, tags.length * 16 - searchRange);
  let offset = 12 + tags.length * 16;
  let headOffset = 0;
  tags.forEach((tag, i) => {
    const data = tables.get(tag)!;
    const p = 12 + i * 16;
    for (let k = 0; k < 4; k++) out[p + k] = tag.charCodeAt(k);
    ov.setUint32(p + 4, checksum(data));
    ov.setUint32(p + 8, offset);
    ov.setUint32(p + 12, data.length);
    out.set(data, offset);
    if (tag === "head") headOffset = offset;
    offset += (data.length + 3) & ~3;
  });
  ov.setUint32(headOffset + 8, (0xb1b0afba - checksum(out)) >>> 0);
  return out;
}

/** 文字列 → UTF-16BE の 16 進表記（文字コード＝UTF-16 の値） */
function hexUtf16(text: string): string {
  let s = "";
  for (let i = 0; i < text.length; i++) s += text.charCodeAt(i).toString(16).padStart(4, "0");
  return s;
}

/** 文字として書けるもの（制御文字と、対になっていないサロゲートを除く） */
const clean = (text: string) =>
  text
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f￾￿]/g, "")
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "");

/** 漢字・かな・ハングルなど、語の間に空白を入れない文字 */
const CJK = /[\u2e80-\u303f\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;
/**
 * 隣り合う語の間に空白が要るか。和文・中国語の字のそばには入れない（認識の結果は 1〜2 字ずつに分かれている。
 * 「2026」「年」のように数字・欧文と和文が隣り合うときも、空白を入れると「2026年」で探せなくなる）
 */
const needsSpace = (a: string, b: string) => !(CJK.test([...a].pop() ?? "") || CJK.test([...b][0] ?? ""));

/**
 * 1 ページ分の、見えない文字の描画命令を作る。
 * 語ごとに、行の高さを文字の大きさとし、語の幅に字数を合わせて横に伸縮する。語と語の間には空白を 1 つ入れる（取り出したときに語が分かれるように）。
 * 縦書きの列は、1 字ずつ上から下へ置く
 */
export function ocrLayerContent(page: OcrPageResult, fontRes: string): string {
  const inv = invert(page.viewTransform);
  const ops: string[] = [];
  // 表示座標での「左上 (x, y)、幅 w、高さ h の箱」に、n 字（1 字の幅 1 em）を収める文字の変換
  const put = (text: string, x: number, y: number, w: number, h: number, trailingSpace: boolean) => {
    const t = clean(text);
    const n = [...t].length;
    if (!n || !(w > 0) || !(h > 0)) return;
    const sx = w / n;
    const base = y + (h * ASCENT) / (ASCENT - DESCENT);
    const m = multiply(inv, [sx, 0, 0, -h, x, base]);
    ops.push(`${m.map((v) => fmt(v)).join(" ")} Tm <${hexUtf16(trailingSpace ? `${t} ` : t)}> Tj`);
  };
  for (const line of page.lines) {
    const words = line.words.filter((w) => clean(w.text)).map((w) => ({ ...w }));
    // 和文は 1〜2 字ずつの語に分かれて認識される。語と語の間の小さな隙間は、前の語の幅（縦書きなら高さ）に含めて埋める
    // （隙間があると、表示ソフトが語の間に空白を入れてしまい、「見積書」のような語を検索できなくなる）
    for (const [wi, w] of words.entries()) {
      const next = words[wi + 1];
      if (!next || needsSpace(w.text, next.text)) continue;
      if (line.vertical) {
        const gap = next.y - (w.y + w.h);
        if (gap > 0 && gap < line.w * 0.8) w.h += gap;
      } else {
        const gap = next.x - (w.x + w.w);
        if (gap > 0 && gap < line.h * 0.8) w.w += gap;
      }
    }
    if (line.vertical) {
      for (const [wi, w] of words.entries()) {
        const chars = [...clean(w.text)];
        const slot = w.h / chars.length;
        chars.forEach((ch, i) => put(ch, line.x, w.y + i * slot, line.w, slot, i === chars.length - 1 && wi < words.length - 1 && needsSpace(w.text, words[wi + 1].text)));
      }
      continue;
    }
    words.forEach((w, wi) => put(w.text, w.x, line.y, w.w, line.h, wi < words.length - 1 && needsSpace(w.text, words[wi + 1].text)));
  }
  if (!ops.length) return "";
  return `BT\n3 Tr\n/${fontRes} 1 Tf\n${ops.join("\n")}\nET`;
}

/** 文字コード（UTF-16 の値）→ 文字 の対応表。上位バイトごとに 1 つの範囲 */
function identityToUnicode(): string {
  const ranges: string[] = [];
  for (let hi = 0; hi < 256; hi++) {
    const h = hi.toString(16).padStart(2, "0");
    ranges.push(`<${h}00> <${h}ff> <${h}00>`);
  }
  let body = "";
  for (let i = 0; i < ranges.length; i += 100) body += `${Math.min(100, ranges.length - i)} beginbfrange\n${ranges.slice(i, i + 100).join("\n")}\nendbfrange\n`;
  return `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <ffff>\nendcodespacerange\n${body}endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
}

/**
 * 認識結果を、元 PDF の各ページに見えない文字の層として書き足す。元の内容には触れない
 * （元の内容の描画状態が残っていても影響を受けないよう、元の内容を保存・復元の命令で囲んでから足す）
 */
export async function addOcrLayer(bytes: Uint8Array, pages: OcrPageResult[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const ctx = doc.context;
  let fontRef: ReturnType<typeof ctx.register> | null = null;
  const font = () => {
    if (fontRef) return fontRef;
    const ttf = glyphlessFont();
    const file = ctx.register(ctx.flateStream(ttf, { Length1: ttf.length }));
    const descriptor = ctx.register(
      ctx.obj({ Type: "FontDescriptor", FontName: FONT_NAME, Flags: 4, FontBBox: [0, DESCENT, 1000, ASCENT], ItalicAngle: 0, Ascent: ASCENT, Descent: DESCENT, CapHeight: 700, StemV: 80, FontFile2: file }),
    );
    // どの文字コードにも、空の字形（1 番）を当てる
    const map = new Uint8Array(65536 * 2);
    for (let i = 1; i < map.length; i += 2) map[i] = 1;
    const cid = ctx.register(
      ctx.obj({
        Type: "Font",
        Subtype: "CIDFontType2",
        BaseFont: FONT_NAME,
        CIDSystemInfo: { Registry: PDFString.of("Adobe"), Ordering: PDFString.of("Identity"), Supplement: 0 },
        FontDescriptor: descriptor,
        DW: 1000,
        // 字の幅の表（すべて 1 em）。既定の幅（DW）と同じだが、表が無いと確かめずに警告するソフトがある
        W: [0, 65535, 1000],
        CIDToGIDMap: ctx.register(ctx.flateStream(map)),
      }),
    );
    fontRef = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type0", BaseFont: FONT_NAME, Encoding: "Identity-H", DescendantFonts: [cid], ToUnicode: ctx.register(ctx.flateStream(identityToUnicode())) }));
    return fontRef;
  };
  const all = doc.getPages();
  for (const p of pages) {
    const page = all[p.index];
    if (!page || !p.lines.length) continue;
    const res = page.node.newFontDictionary(FONT_NAME, font()).decodeText();
    const content = ocrLayerContent(p, res);
    if (!content) continue;
    page.node.normalize();
    page.node.wrapContentStreams(ctx.register(ctx.flateStream("q\n")), ctx.register(ctx.flateStream("\nQ\n")));
    page.node.addContentStream(ctx.register(ctx.flateStream(`q\n${content}\nQ\n`)));
  }
  return doc.save({ useObjectStreams: true });
}

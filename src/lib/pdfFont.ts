import { PDFArray, type PDFDocument, type PDFFont, PDFDict, PDFName, PDFNumber, PDFStream } from "pdf-lib";
import { toUnicodeCMap } from "./shape";
import { advanceWidth, parseTtf, postScriptName, subsetTtf, unitsPerEm } from "./ttfSubset";

/** 整形フォント：整形後のグリフ番号 → 文字（ToUnicode を自前で書く） */
const shapedMaps = new WeakMap<PDFFont, Map<number, string>>();

export interface ShapedEmbedding {
  extraGids: Set<number>;
  gidToUnicode: Map<number, string>;
  clones?: Map<number, number>;
}

/** 自前でサブセット化したフォント → 埋め込んだ TrueType のバイト数 */
const subsetLength = new WeakMap<PDFFont, number>();
/** 整形フォント：埋め込んだ TrueType そのもの（字形の幅の表を書き直すのに使う） */
const subsetBytes = new WeakMap<PDFFont, Uint8Array>();

/** サブセットであることを示す名前の頭（"ABCDEF+"）。同じ文字の組なら同じ値になる */
function subsetTag(text: string): string {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0;
  let tag = "";
  for (let i = 0; i < 6; i++) {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    tag += String.fromCharCode(65 + ((h >>> 16) % 26));
  }
  return tag;
}

/** 使う文字だけを残した日本語フォントを埋め込む。保存前に必ず finishSubsetFonts を呼ぶこと */
export async function embedSubsetFont(doc: PDFDocument, fontBytes: Uint8Array, text: string, shaped?: ShapedEmbedding): Promise<PDFFont> {
  // （fontkit 側のサブセット機能は同梱フォントで文字の形が欠けるため使わない）
  const bytes = subsetTtf(fontBytes, text, shaped?.extraGids, shaped?.clones);
  const ps = postScriptName(parseTtf(fontBytes)) ?? "JapaneseFont";
  const font = await doc.embedFont(bytes, { subset: false, customName: `${subsetTag(text)}+${ps}` });
  subsetLength.set(font, bytes.length);
  if (shaped) {
    shapedMaps.set(font, shaped.gidToUnicode);
    subsetBytes.set(font, bytes);
  }
  return font;
}

/**
 * フォントを PDF に書き込み、PDF 仕様で必須の /Length1（フォントの元の長さ）を付ける。
 * pdf-lib は付けないため、Acrobat がフォントを読めず警告・文字化け・検索不可の原因になる。
 */
export async function finishSubsetFonts(doc: PDFDocument, fonts: Iterable<PDFFont>): Promise<void> {
  await doc.flush();
  for (const font of fonts) {
    const len = subsetLength.get(font);
    if (len === undefined) continue;
    const type0 = doc.context.lookup(font.ref, PDFDict);
    const cid = type0.lookup(PDFName.of("DescendantFonts"), PDFArray).lookup(0, PDFDict);
    const file = cid.lookup(PDFName.of("FontDescriptor"), PDFDict).lookup(PDFName.of("FontFile2"));
    if (file instanceof PDFStream) file.dict.set(PDFName.of("Length1"), PDFNumber.of(len));
    // 整形後のグリフにも文字を対応付ける（pdf-lib の ToUnicode は cmap にある字形しか知らない）
    const map = shapedMaps.get(font);
    if (map?.size) type0.set(PDFName.of("ToUnicode"), doc.context.register(doc.context.flateStream(toUnicodeCMap(map))));
    // 字形の幅の表（W）を、使う字形すべてについて書く。pdf-lib が書くのは「文字から直接引ける字形」の分だけなので、
    // 整形で使う字形（前後の字で変わる形、重なる記号用の形、複製した字形）は表から漏れ、既定の幅（1000）で送られてしまう
    // （記号の後ろに 1 字分の隙間が空く）
    const raw = subsetBytes.get(font);
    if (map?.size && raw) {
      const ttf = parseTtf(raw);
      const upm = unitsPerEm(ttf) || 1000;
      const gids = [...map.keys()].filter((g) => g > 0 && g < ttf.numGlyphs).sort((a, b) => a - b);
      const w = doc.context.obj([]) as PDFArray;
      // 既にある表は残し、その後ろに足す（同じ字形が両方にあっても値は同じ）
      const old = cid.lookup(PDFName.of("W"));
      if (old instanceof PDFArray) for (let i = 0; i < old.size(); i++) w.push(old.get(i));
      for (const g of gids) {
        w.push(PDFNumber.of(g));
        w.push(doc.context.obj([Math.round((advanceWidth(ttf, g) * 1000) / upm)]));
      }
      cid.set(PDFName.of("W"), w);
    }
  }
}

// 墨消しの後始末：墨消ししたページのフォントから、文書のどこでも使われなくなった字の手がかりを取り除く。
//
// 部分埋め込みのフォントには「その文書で使った字」だけが入っている。墨消しで字を消しても、フォントの側には
//   - 文字コード → 文字の対応表（/ToUnicode。文字コードは初めて使った順に振られることが多い）
//   - 字ごとの幅（/Widths・/W）
//   - 字の形（輪郭）
// が残るので、「見えている文字には無いのに、フォントには入っている字」から、消した語を推し量れてしまう。
// そこで、保存する文書の内容をすべて調べ、どこからも使われていない文字コードについて、対応表と幅から外し、
// 字の形を空にする（TrueType のとき。字形の番号は変えないので、残る字の見た目は変わらない）。
//
// 扱うのは確実に分かるものだけ：1 バイトの文字コードで書くフォント（Type1・TrueType）と、文字コード＝CID の
// Type0（Identity-H / Identity-V）。入力欄やフリーテキストが使うフォントは、あとから別の字が要るので触らない。
// 内容を調べきれなかったときは、何もしない（字が欠けるより、手がかりが残るほうがまし。README に制約として書いてある）。
// CFF（Type1C・OpenType/CFF）の字の形は空にできない（対応表と幅だけ外す）。

import { decodePDFRawStream, PDFArray, PDFDict, type PDFDocument, PDFName, PDFNumber, type PDFObject, type PDFPage, PDFRawStream, PDFRef, PDFStream } from "pdf-lib";
import { collectFontUsage, type FontKey } from "./fontShrink";
import { getFontInfo } from "./pdfFontInfo";
import { glyphIdForCode, parseTtf, subsetTtf } from "./ttfSubset";

const N = (s: string) => PDFName.of(s);
const nameOf = (o: unknown) => (o instanceof PDFName ? o.decodeText() : null);

/** 文字コード → 文字の対応表（ToUnicode CMap）を作る。nbytes は文字コードのバイト数 */
function toUnicodeStream(map: Map<number, string>, nbytes: 1 | 2): string {
  const hex = (n: number, w: number) => n.toString(16).toUpperCase().padStart(w, "0");
  const lines = [...map]
    .sort((a, b) => a[0] - b[0])
    .map(([code, text]) => {
      let u = "";
      for (let i = 0; i < text.length; i++) u += hex(text.charCodeAt(i), 4);
      return `<${hex(code, nbytes * 2)}> <${u}>`;
    });
  let body = "";
  for (let i = 0; i < lines.length; i += 100) body += `${Math.min(100, lines.length - i)} beginbfchar\n${lines.slice(i, i + 100).join("\n")}\nendbfchar\n`;
  const space = nbytes === 2 ? "<0000> <FFFF>" : "<00> <FF>";
  return `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n${space}\nendcodespacerange\n${body}endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`;
}

/** Type3 フォントの、使っていない文字コードの字の形と名前を取り除く（字形の名前は、使っている字のものだけ残す） */
function forgetType3Glyphs(doc: PDFDocument, font: PDFDict, codes: Set<number>): void {
  const ctx = doc.context;
  const enc = font.lookup(N("Encoding"));
  const diffs = enc instanceof PDFDict ? enc.lookup(N("Differences")) : undefined;
  const procs = font.lookup(N("CharProcs"));
  if (!(diffs instanceof PDFArray) || !(procs instanceof PDFDict)) return;
  // 文字コード → 字の名前
  const names = new Map<number, string>();
  let code = 0;
  const items = diffs.asArray();
  for (const it of items) {
    const v = it instanceof PDFRef ? ctx.lookup(it) : it;
    if (v instanceof PDFNumber) code = v.asNumber();
    else if (v instanceof PDFName) names.set(code++, v.decodeText());
  }
  const used = new Set<string>();
  for (const c of codes) {
    const n = names.get(c);
    if (n) used.add(n);
  }
  // 字の形：使っている名前の命令だけを残す（字の名前も字を表すことがあるので、使っていない名前は表から消し、.notdef にする）。
  // フォントの辞書と /Encoding は、ほかのフォントと共用していることがあるので、作り直して差し替える
  const empty = ctx.register(ctx.flateStream("0 0 d0"));
  const keep = new Map<string, PDFObject>();
  for (const [k, v] of procs.entries()) if (used.has(k.decodeText())) keep.set(k.decodeText(), v);
  const fresh = ctx.obj({}) as PDFDict;
  for (const [n, v] of keep) fresh.set(N(n), v);
  font.set(N("CharProcs"), fresh);
  const out: PDFObject[] = [];
  for (const [c, n] of [...names].sort((a, b) => a[0] - b[0])) {
    out.push(PDFNumber.of(c), used.has(n) ? N(n) : N(".notdef"));
  }
  // .notdef は何も描かない
  fresh.set(N(".notdef"), empty);
  const newEnc = ctx.obj({}) as PDFDict;
  if (enc instanceof PDFDict) for (const [k, v] of enc.entries()) newEnc.set(k, v);
  newEnc.set(N("Differences"), ctx.obj(out));
  font.set(N("Encoding"), newEnc);
}

/** 墨消ししたページ（pages）が使うフォントについて、文書のどこでも使われていない字の手がかりを取り除く */
export function forgetUnusedGlyphs(doc: PDFDocument, pages: PDFPage[]): void {
  const ctx = doc.context;
  const lookup = (o: unknown) => (o instanceof PDFRef ? ctx.lookup(o) : o);
  const keyOf = (o: unknown): FontKey | null => (o instanceof PDFRef ? o.toString() : o instanceof PDFDict ? o : null);

  // 1. 墨消ししたページ（と、そこから呼ばれる部品）のリソースにあるフォント
  const targets = new Map<FontKey, PDFDict>();
  const seenRes = new Set<PDFDict>();
  const collect = (res: PDFDict | undefined, depth: number) => {
    if (!res || seenRes.has(res) || depth > 12) return;
    seenRes.add(res);
    const fonts = res.lookup(N("Font"));
    if (fonts instanceof PDFDict)
      for (const [, v] of fonts.entries()) {
        const d = lookup(v);
        const k = keyOf(v);
        if (k && d instanceof PDFDict) targets.set(k, d);
      }
    const xo = res.lookup(N("XObject"));
    if (xo instanceof PDFDict)
      for (const [, v] of xo.entries()) {
        const x = lookup(v);
        const own = x instanceof PDFStream ? x.dict.lookup(N("Resources")) : undefined;
        if (own instanceof PDFDict) collect(own, depth + 1);
      }
  };
  for (const p of pages) collect(p.node.Resources(), 0);
  if (!targets.size) return;

  // 2. 文書のすべてのフォントについて、文字コードのバイト数を決める（同じ埋め込みファイルをほかのフォントが使っていることがある）
  const kinds = new Map<FontKey, { dict: PDFDict; nbytes: 1 | 2 }>();
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || nameOf(obj.get(N("Type"))) !== "Font") continue;
    const sub = nameOf(obj.get(N("Subtype")));
    if (sub === "Type0") {
      const enc = nameOf(obj.get(N("Encoding")));
      if (enc === "Identity-H" || enc === "Identity-V") kinds.set(ref.toString(), { dict: obj, nbytes: 2 });
    } else if (sub === "Type1" || sub === "TrueType" || sub === "MMType1" || sub === "Type3") kinds.set(ref.toString(), { dict: obj, nbytes: 1 });
  }
  for (const [k, d] of targets) {
    if (typeof k !== "string" && !kinds.has(k)) {
      const sub = nameOf(d.get(N("Subtype")));
      if (sub === "Type1" || sub === "TrueType" || sub === "MMType1" || sub === "Type3") kinds.set(k, { dict: d, nbytes: 1 });
    }
  }
  const editable = new Set<FontKey>();
  const used = collectFontUsage(
    doc,
    (k) => kinds.get(k)?.nbytes ?? 0,
    (k) => editable.add(k),
  );
  if (!used) return;
  // 入力欄の既定のフォント（/AcroForm /DR）も、あとから入力される字のために残す
  const acro = doc.catalog.lookup(N("AcroForm"));
  const dr = acro instanceof PDFDict ? acro.lookup(N("DR")) : undefined;
  const drFonts = dr instanceof PDFDict ? dr.lookup(N("Font")) : undefined;
  if (drFonts instanceof PDFDict)
    for (const [, v] of drFonts.entries()) {
      const k = keyOf(v);
      if (k) editable.add(k);
    }

  // 3. フォントごとに、使われていない文字コードを対応表と幅から外す
  /** 埋め込みファイル（FontFile2）→ それを使うフォントと、使っている字形番号。null は「触らない」 */
  const files = new Map<string, { ref: PDFRef; gids: Set<number> | null; touched: boolean; simple: boolean }>();
  const fileOf = (font: PDFDict): PDFRef | null => {
    const fd = lookup(font.get(N("FontDescriptor")));
    const f = fd instanceof PDFDict ? fd.get(N("FontFile2")) : null;
    return f instanceof PDFRef ? f : null;
  };
  for (const [key, { dict, nbytes }] of kinds) {
    const codes = used.get(key) ?? new Set<number>();
    const isTarget = targets.has(key) && !editable.has(key);
    let cid: PDFDict | null = null;
    if (nbytes === 2) {
      const list = lookup(dict.get(N("DescendantFonts")));
      const c = list instanceof PDFArray ? lookup(list.get(0)) : null;
      cid = c instanceof PDFDict ? c : null;
    }
    // 字の形：同じ埋め込みファイルを使うフォント全部の「使っている字形」を合わせる
    const file = fileOf(cid ?? dict);
    if (file) {
      let e = files.get(file.toString());
      if (!e) files.set(file.toString(), (e = { ref: file, gids: new Set(), touched: false, simple: false }));
      if (nbytes === 1) e.simple = true;
      if (isTarget) e.touched = true;
      if (editable.has(key)) e.gids = null;
      else if (e.gids) {
        try {
          if (nbytes === 2) {
            const g2g = cid?.get(N("CIDToGIDMap"));
            const mapObj = lookup(g2g);
            let map: Uint8Array | null = null;
            if (mapObj instanceof PDFRawStream) map = decodePDFRawStream(mapObj).decode();
            else if (g2g !== undefined && nameOf(mapObj) !== "Identity") throw new Error("CIDToGIDMap");
            if (nameOf(cid?.get(N("Subtype"))) !== "CIDFontType2") throw new Error("not TrueType");
            for (const c of codes) {
              const gid = map ? (map[c * 2] << 8) | (map[c * 2 + 1] ?? 0) : c;
              if (gid > 0) e.gids.add(gid);
            }
          } else {
            const stream = ctx.lookup(file);
            if (!(stream instanceof PDFRawStream)) throw new Error("font file");
            const ttf = parseTtf(decodePDFRawStream(stream).decode(), true);
            for (const c of codes) {
              const gid = glyphIdForCode(ttf, c);
              // 字形を引けない文字コードがあるフォントは、どの字形を使っているか決められない
              if (gid <= 0) throw new Error("unmapped code");
              e.gids.add(gid);
            }
          }
        } catch {
          e.gids = null;
        }
      }
    }
    if (!isTarget) continue;
    try {
      const info = getFontInfo(doc, dict);
      if (!info) continue;
      // 対応表：使っている文字コードだけで作り直す（いまの対応表に無い文字コードは足さない）
      if (dict.has(N("ToUnicode"))) {
        const map = new Map<number, string>();
        for (const c of codes) {
          const u = info.toUnicode({ code: c, cid: c, nbytes, isSpace: nbytes === 1 && c === 0x20 });
          if (u) map.set(c, u);
        }
        dict.set(N("ToUnicode"), ctx.register(ctx.flateStream(toUnicodeStream(map, nbytes))));
      }
      // 幅：使っていない文字コードの幅を外す
      if (nbytes === 1) {
        const widths = dict.lookup(N("Widths"));
        const first = dict.lookup(N("FirstChar"));
        if (widths instanceof PDFArray && first instanceof PDFNumber) {
          const f0 = first.asNumber();
          dict.set(N("Widths"), ctx.obj(widths.asArray().map((w: PDFObject, i: number) => (codes.has(f0 + i) ? w : PDFNumber.of(0)))));
        }
        // Type3：字の形はフォントの中の命令（/CharProcs）。使っていない字の形を空にし、/Differences の字の名前も外す
        // （名前が「uni05D4」のように字そのものを表すことがある）
        if (nameOf(dict.get(N("Subtype"))) === "Type3") forgetType3Glyphs(doc, dict, codes);
      } else if (cid?.has(N("W"))) {
        const w: (number | number[])[] = [];
        for (const c of [...codes].sort((a, b) => a - b)) w.push(c, [info.width({ code: c, cid: c, nbytes: 2, isSpace: false })]);
        cid.set(N("W"), ctx.obj(w));
      }
    } catch {
      /* 読めないフォントは、そのまま残す */
    }
  }

  // 4. 字の形：使っていない字形を空にする（字形の番号は変えない）
  for (const { ref, gids, touched, simple } of files.values()) {
    if (!touched || !gids) continue;
    try {
      const stream = ctx.lookup(ref);
      if (!(stream instanceof PDFRawStream)) continue;
      const font = decodePDFRawStream(stream).decode();
      // 1 バイトの文字コードで書くフォントは、文字コード → 字形の表（cmap）で字形を引くので、表は元のまま残す
      const small = subsetTtf(font, "", gids, undefined, undefined, simple, true);
      ctx.assign(ref, ctx.flateStream(small, { Length1: small.length }));
    } catch {
      /* 読めないフォントは、そのまま残す */
    }
  }
}

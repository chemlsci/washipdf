// 圧縮：丸ごと埋め込まれているフォントから、文書で使っていない字の形を取り除く。
//
// 「Microsoft Print to PDF」などは、フォントを 1 字も削らずに埋め込む（和文フォントは 1 つで数 MB）。
// 文書で実際に使っている字はその一部なので、使っていない字の形（輪郭）だけを空にすれば、見た目を変えずに大きく減らせる。
// 字形の番号は変えない（輪郭を空にするだけ）ので、文字コードと字形の対応・字の幅は元のまま。
//
// 対象は、確実に扱えるものだけ：
//   - 文字コード＝字形番号で書く TrueType（Type0・Identity-H / Identity-V・CIDFontType2。対応表があればそれを引く）
//   - 文書の中の「文字を描く内容」をすべて調べられたとき（ページ・部品・模様・注釈の見た目・Type3 フォントの字形）
// 入力欄（フォーム）が使うフォントは、あとから入力される字が分からないので触らない。
// どれかが調べきれなければ、何もしない（字が消えるより、大きいままのほうがよい）。

import { decodePDFRawStream, PDFArray, PDFDict, type PDFDocument, PDFName, PDFRawStream, PDFRef, PDFStream } from "pdf-lib";
import { latin1, tokenizeContent } from "./contentStream";
import { pageContentBytes } from "./libDoc";
import { parseTtf, subsetTtf } from "./ttfSubset";

export interface FontShrinkStats {
  /** 小さくしたフォントの数 */
  fonts: number;
  /** 減った大きさ（バイト） */
  saved: number;
}

const N = (s: string) => PDFName.of(s);
const nameOf = (o: unknown) => (o instanceof PDFName ? o.decodeText() : null);

/** フォントを区別する鍵：参照があれば参照（の文字列）、無ければ辞書そのもの */
export type FontKey = string | PDFDict;

interface Candidate {
  file: PDFRef;
  /** 文字コード → 字形番号の対応表（無ければ、文字コード＝字形番号） */
  map: Uint8Array | null;
}

/** 入力欄が使うフォント（/AcroForm /DR の中）。あとから入力される字のために、丸ごと残す */
function formFonts(doc: PDFDocument): Set<FontKey> {
  const out = new Set<FontKey>();
  const acro = doc.catalog.lookup(N("AcroForm"));
  const dr = acro instanceof PDFDict ? acro.lookup(N("DR")) : undefined;
  const fonts = dr instanceof PDFDict ? dr.lookup(N("Font")) : undefined;
  if (fonts instanceof PDFDict) for (const [, v] of fonts.entries()) out.add(v instanceof PDFRef ? v.toString() : (v as PDFDict));
  return out;
}

/**
 * 文書の中の「文字を描く内容」（ページ・部品・模様・注釈の見た目・Type3 フォントの字形）をすべて調べて、
 * フォントごとに、実際に使っている文字コードを集める。調べきれなければ null。
 * codeBytes：そのフォントの文字コードのバイト数（2＝2 バイトずつ、1＝1 バイトずつ、0＝集めない）
 * onEditableFont：入力欄・フリーテキストの見た目が使うフォント（表示ソフトが見た目を作り直すことがあるので、丸ごと残したいもの）
 */
export function collectFontUsage(doc: PDFDocument, codeBytes: (key: FontKey) => 0 | 1 | 2, onEditableFont: (key: FontKey) => void): Map<FontKey, Set<number>> | null {
  const ctx = doc.context;
  const lookup = (o: unknown) => (o instanceof PDFRef ? ctx.lookup(o) : o);
  const keyOf = (o: unknown): FontKey | null => (o instanceof PDFRef ? o.toString() : o instanceof PDFDict ? o : null);
  const used = new Map<FontKey, Set<number>>();
  let failed = false;
  const visited = new Set<string>();
  /** 自前のリソースを持たない部品のうち、呼び出し元から調べたもの */
  const visitedBare = new Set<PDFStream>();
  const decode = (s: PDFStream): Uint8Array | null => {
    try {
      return s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents();
    } catch {
      return null;
    }
  };
  const walk = (bytes: Uint8Array, res: PDFDict | undefined, depth: number): void => {
    if (failed) return;
    if (depth > 24) {
      failed = true;
      return;
    }
    const fonts = res?.lookup(N("Font"));
    const xobjs = res?.lookup(N("XObject"));
    let cur: FontKey | null = null;
    let known = true;
    let ops;
    try {
      ops = tokenizeContent(bytes);
    } catch {
      failed = true;
      return;
    }
    const add = (data: Uint8Array) => {
      // フォントを決められないまま文字が描かれている：リソースに無い名前、または、この内容の中でフォントを指定していない
      // （部品は、呼び出し元のフォントを引き継いで文字を描くことができる。どのフォントになるかは呼び出しごとに違いうる）
      if (!known || cur === null) {
        failed = true;
        return;
      }
      const nb = codeBytes(cur);
      if (!nb) return;
      let set = used.get(cur);
      if (!set) used.set(cur, (set = new Set()));
      if (nb === 2) for (let i = 0; i + 1 < data.length; i += 2) set.add((data[i] << 8) | data[i + 1]);
      else for (let i = 0; i < data.length; i++) set.add(data[i]);
    };
    // フォントの指定は描画状態の一部で、q で保存され Q で元に戻る（Q の後の文字は、q の前のフォントで描かれる）
    const saved: { cur: FontKey | null; known: boolean }[] = [];
    for (const op of ops) {
      if (op.op === "q") saved.push({ cur, known });
      else if (op.op === "Q") {
        const s0 = saved.pop();
        if (s0) ({ cur, known } = s0);
      } else if (op.op === "gs") {
        // 描画状態の辞書（ExtGState）でフォントを指定していることがある
        const n = op.operands[0];
        const gsd = res?.lookup(N("ExtGState"));
        const g = n?.kind === "name" && gsd instanceof PDFDict ? gsd.lookup(N(n.value)) : undefined;
        const f = g instanceof PDFDict ? g.lookup(N("Font")) : undefined;
        if (f instanceof PDFArray) {
          cur = keyOf(f.get(0));
          known = cur !== null;
        }
      } else if (op.op === "Tf") {
        const n = op.operands[0];
        const v = n?.kind === "name" && fonts instanceof PDFDict ? fonts.get(N(n.value)) : undefined;
        cur = keyOf(v);
        // どのフォントか分からない（リソースに無い）まま文字が描かれたら、調べきれない
        known = cur !== null;
      } else if (op.op === "Tj" || op.op === "'" || op.op === '"') {
        const s = op.operands[op.op === '"' ? 2 : 0];
        if (s?.kind === "string") add(s.bytes);
      } else if (op.op === "TJ") {
        const a = op.operands[0];
        if (a?.kind === "array") for (const it of a.items) if (it.kind === "string") add(it.bytes);
      } else if (op.op === "Do") {
        const n = op.operands[0];
        const ref = n?.kind === "name" && xobjs instanceof PDFDict ? xobjs.get(N(n.value)) : undefined;
        const x = lookup(ref);
        if (x instanceof PDFStream && nameOf(x.dict.get(N("Subtype"))) === "Form") walkStream(x, ref instanceof PDFRef ? ref.toString() : null, res, depth + 1);
      }
    }
  };
  const walkStream = (s: PDFStream, id: string | null, parentRes: PDFDict | undefined, depth: number): void => {
    const own = s.dict.lookup(N("Resources"));
    const res = own instanceof PDFDict ? own : parentRes;
    if (own instanceof PDFDict) {
      // 自前のリソースを持つ部品は、どこから呼ばれても同じ結果になるので、1 回だけ調べる
      if (id) {
        if (visited.has(id)) return;
        visited.add(id);
      }
    } else visitedBare.add(s);
    const bytes = decode(s);
    if (!bytes) {
      failed = true;
      return;
    }
    walk(bytes, res, depth);
    if (res && own instanceof PDFDict) walkResources(res, depth);
  };
  /** リソースの中の、内容を持つもの（模様・Type3 フォントの字形・透明マスクの部品）も調べる */
  const walkResources = (res: PDFDict, depth: number): void => {
    const pats = res.lookup(N("Pattern"));
    if (pats instanceof PDFDict)
      for (const [, v] of pats.entries()) {
        const p = lookup(v);
        if (p instanceof PDFStream) walkStream(p, v instanceof PDFRef ? v.toString() : null, res, depth + 1);
      }
    const fonts = res.lookup(N("Font"));
    if (fonts instanceof PDFDict)
      for (const [, v] of fonts.entries()) {
        const f = lookup(v);
        if (!(f instanceof PDFDict) || nameOf(f.get(N("Subtype"))) !== "Type3") continue;
        const procs = f.lookup(N("CharProcs"));
        const fres = f.lookup(N("Resources"));
        if (procs instanceof PDFDict)
          for (const [, pv] of procs.entries()) {
            const p = lookup(pv);
            if (!(p instanceof PDFStream)) continue;
            const id = pv instanceof PDFRef ? `t3:${pv.toString()}` : null;
            if (id && visited.has(id)) continue;
            if (id) visited.add(id);
            const bytes = decode(p);
            if (!bytes) failed = true;
            else walk(bytes, fres instanceof PDFDict ? fres : res, depth + 1);
          }
      }
    const gs = res.lookup(N("ExtGState"));
    if (gs instanceof PDFDict)
      for (const [, v] of gs.entries()) {
        const g = lookup(v);
        const sm = g instanceof PDFDict ? lookup(g.get(N("SMask"))) : null;
        const form = sm instanceof PDFDict ? sm.get(N("G")) : null;
        const x = lookup(form);
        if (x instanceof PDFStream) walkStream(x, form instanceof PDFRef ? form.toString() : null, res, depth + 1);
      }
  };
  for (const page of doc.getPages()) {
    let res: PDFDict | undefined;
    let bytes: Uint8Array;
    try {
      res = page.node.Resources();
      bytes = pageContentBytes(doc, page);
    } catch {
      return null;
    }
    walk(bytes, res, 0);
    if (res) walkResources(res, 0);
    // 注釈の見た目
    const annots = page.node.lookup(N("Annots"));
    if (annots instanceof PDFArray)
      for (const a of annots.asArray()) {
        const annot = lookup(a);
        const ap = annot instanceof PDFDict ? lookup(annot.get(N("AP"))) : null;
        if (!(ap instanceof PDFDict)) continue;
        // 入力欄と、文字を書き込める注釈（フリーテキスト）は、表示ソフトが見た目を作り直すことがある。
        // そのとき別の字が要るので、これらの見た目が使うフォントは丸ごと残す
        const kind = nameOf((annot as PDFDict).get(N("Subtype")));
        const keepFonts = (x: PDFStream) => {
          if (kind !== "Widget" && kind !== "FreeText") return;
          const r = x.dict.lookup(N("Resources"));
          const fs = r instanceof PDFDict ? r.lookup(N("Font")) : undefined;
          if (fs instanceof PDFDict)
            for (const [, fv] of fs.entries()) {
              const k = keyOf(fv);
              if (k) onEditableFont(k);
            }
        };
        for (const [, v] of ap.entries()) {
          const x = lookup(v);
          if (x instanceof PDFStream) {
            keepFonts(x);
            walkStream(x, v instanceof PDFRef ? v.toString() : null, undefined, 1);
          } else if (x instanceof PDFDict)
            for (const [, sv] of x.entries()) {
              const sx = lookup(sv);
              if (!(sx instanceof PDFStream)) continue;
              keepFonts(sx);
              walkStream(sx, sv instanceof PDFRef ? sv.toString() : null, undefined, 1);
            }
        }
      }
    if (failed) return null;
  }
  // 上の経路でたどらなかった部品・模様も、自前のリソースを持っていれば調べる（どこかから使われているかもしれない）。
  // 自前のリソースを持たず、たどれてもいない部品に文字があれば、どのフォントか決められないので、何もしない
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFStream)) continue;
    const sub = nameOf(obj.dict.get(N("Subtype")));
    const isPattern = obj.dict.has(N("PatternType"));
    if (sub !== "Form" && !isPattern) continue;
    if (visited.has(ref.toString()) || visitedBare.has(obj)) continue;
    if (obj.dict.lookup(N("Resources")) instanceof PDFDict) walkStream(obj, ref.toString(), undefined, 1);
    else {
      const bytes = decode(obj);
      if (!bytes) failed = true;
      else if (/\bTf\b/.test(latin1(bytes, 0, bytes.length))) failed = true;
    }
    if (failed) return null;
  }
  if (failed) return null;
  return failed ? null : used;
}

export function shrinkFonts(doc: PDFDocument): FontShrinkStats {
  const stats: FontShrinkStats = { fonts: 0, saved: 0 };
  const ctx = doc.context;
  const lookup = (o: unknown) => (o instanceof PDFRef ? ctx.lookup(o) : o);
  const keyOf = (o: unknown): FontKey | null => (o instanceof PDFRef ? o.toString() : o instanceof PDFDict ? o : null);

  // --- 1. 対象のフォント（Type0 の辞書 → 埋め込みファイル）と、そのファイルを使うほかのフォント ---
  const candidates = new Map<FontKey, Candidate>();
  /** 埋め込みファイル → それを使う「対象でない」フォントがあるか */
  const blocked = new Set<string>();
  const fileOfDescriptor = (font: PDFDict): PDFRef | null => {
    const fd = lookup(font.get(N("FontDescriptor")));
    const f = fd instanceof PDFDict ? fd.get(N("FontFile2")) : null;
    return f instanceof PDFRef ? f : null;
  };
  const descendantsOfType0 = new Set<PDFDict>();
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || nameOf(obj.get(N("Subtype"))) !== "Type0") continue;
    const enc = nameOf(obj.get(N("Encoding")));
    const list = lookup(obj.get(N("DescendantFonts")));
    const cid = list instanceof PDFArray ? lookup(list.get(0)) : null;
    if (!(cid instanceof PDFDict)) continue;
    descendantsOfType0.add(cid);
    const file = fileOfDescriptor(cid);
    if (!file) continue;
    const g2g = cid.get(N("CIDToGIDMap"));
    const mapObj = lookup(g2g);
    let map: Uint8Array | null = null;
    let ok = (enc === "Identity-H" || enc === "Identity-V") && nameOf(cid.get(N("Subtype"))) === "CIDFontType2";
    if (ok && mapObj instanceof PDFRawStream) {
      try {
        map = decodePDFRawStream(mapObj).decode();
      } catch {
        ok = false;
      }
    } else if (ok && g2g !== undefined && nameOf(mapObj) !== "Identity") ok = false;
    if (ok) candidates.set(ref.toString(), { file, map });
    else blocked.add(file.toString());
  }
  if (!candidates.size) return stats;
  // 同じファイルを、Type0 以外のフォント（1 バイトの文字コードで書くフォント）が使っていれば、そのファイルは触らない
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || descendantsOfType0.has(obj) || !obj.has(N("FontDescriptor"))) continue;
    const file = fileOfDescriptor(obj);
    if (file) blocked.add(file.toString());
  }
  for (const k of formFonts(doc)) {
    const c = candidates.get(k);
    if (c) blocked.add(c.file.toString());
  }

  // --- 2. 文書の中の「文字を描く内容」をすべて調べて、フォントごとに使っている文字コードを集める ---
  const used = collectFontUsage(
    doc,
    (k) => (candidates.has(k) ? 2 : 0),
    (k) => {
      const c = candidates.get(k);
      if (c) blocked.add(c.file.toString());
    },
  );
  if (!used) return stats;

  // --- 3. 埋め込みファイルごとに、使っている字形を集めて、使っていない字の形を空にする ---
  const byFile = new Map<string, { file: PDFRef; gids: Set<number> }>();
  for (const [key, c] of candidates) {
    const f = c.file.toString();
    let e = byFile.get(f);
    if (!e) byFile.set(f, (e = { file: c.file, gids: new Set() }));
    for (const code of used.get(key) ?? []) {
      const gid = c.map ? (c.map[code * 2] << 8) | (c.map[code * 2 + 1] ?? 0) : code;
      if (gid > 0) e.gids.add(gid);
    }
  }
  for (const [id, { file, gids }] of byFile) {
    if (blocked.has(id)) continue;
    const stream = ctx.lookup(file);
    if (!(stream instanceof PDFRawStream) || stream.contents.length < 40 * 1024) continue;
    try {
      const font = decodePDFRawStream(stream).decode();
      const info = parseTtf(font, false);
      // ほとんどの字を使っているなら、減らしても得が小さい
      if (gids.size > info.numGlyphs * 0.7) continue;
      // 埋め込みビットマップ（小さい字のための点の字形。和文フォントに多い）は、PDF の表示には使われないので外す
      const small = subsetTtf(font, "", gids, undefined, ["EBDT", "EBLC", "EBSC"]);
      const packed = ctx.flateStream(small, { Length1: small.length });
      const after = packed.getContentsSize();
      if (after > stream.contents.length * 0.9) continue;
      ctx.assign(file, packed);
      stats.fonts++;
      stats.saved += stream.contents.length - after;
    } catch {
      /* 読めないフォントは、そのまま残す */
    }
  }
  return stats;
}

/**
 * 元 PDF を pdf-lib で開き、ページのコンテンツストリームを解析した結果をキャッシュする。
 * 「既存文字」ツールを使ったときに初めて読み込む（pdf-lib の読み込みは大きい PDF だと数秒かかるため）。
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, type PDFPage } from "pdf-lib";
import { type ContentOp, tokenizeContent } from "./contentStream";
import { tr, AppError } from "./i18n";
import { decodeStreamBytes, type FontInfo } from "./pdfFontInfo";
import { getPdfJs } from "./pdfjs";
import { type FormInvocation, type ImageDraw, type Rule, type ShowOp, walkTextOps } from "./textOps";
import type { SourceDoc } from "./types";

const libDocs = new WeakMap<SourceDoc, Promise<PDFDocument>>();

/** ファイルの末尾にある相互参照の /Size（オブジェクトの数）が、ファイルの大きさから見てありえないほど大きいか */
function absurdSize(bytes: Uint8Array): boolean {
  const tail = new TextDecoder("latin1").decode(bytes.subarray(Math.max(0, bytes.length - 65536)));
  for (const m of tail.matchAll(/\/Size\s+(\d{7,})/g)) if (Number(m[1]) > Math.max(1_000_000, bytes.length)) return true;
  return false;
}

/**
 * 元 PDF を pdf-lib で開く。表示（pdf.js）では開けるのに pdf-lib が読めない・ページ数が合わない壊れた PDF は、
 * pdf.js にページを書き出させて作り直したものを開く（そのままでは保存できず、編集した内容を持ち出せないため）
 */
export async function loadLibPdf(doc: SourceDoc, rebuild = false): Promise<PDFDocument> {
  const opts = { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false };
  // オブジェクトの数がありえない値だと、pdf-lib がメモリを使い切るので、そのままは開かない
  if (!rebuild && !absurdSize(doc.bytes)) {
    try {
      const lib = await PDFDocument.load(doc.bytes, opts);
      if (lib.getPageCount() === doc.pdf.numPages) return lib;
    } catch {
      /* 作り直して開く */
    }
  }
  let rebuilt: Uint8Array;
  try {
    rebuilt = await doc.pdf.extractPages([{ document: null }]);
  } catch {
    throw new AppError(tr("export.unreadable", { name: doc.name }));
  }
  const lib = await PDFDocument.load(rebuilt, opts).catch(() => null);
  if (!lib || lib.getPageCount() !== doc.pdf.numPages) throw new AppError(tr("export.unreadable", { name: doc.name }));
  return lib;
}

export function getLibDoc(doc: SourceDoc): Promise<PDFDocument> {
  let p = libDocs.get(doc);
  if (!p) {
    p = loadLibPdf(doc);
    p.catch(() => libDocs.delete(doc));
    libDocs.set(doc, p);
  }
  return p;
}

export interface PageAnalysis {
  /** 連結したコンテンツストリーム（デコード済み） */
  bytes: Uint8Array;
  ops: ContentOp[];
  shows: ShowOp[];
  resources: PDFDict | undefined;
  usesForms: boolean;
  /** 画像の描画命令 */
  images: ImageDraw[];
  /** 中まで追った Form XObject の呼び出し */
  forms: FormInvocation[];
  /** 水平・垂直の線（表の罫線など。ページの座標） */
  rules: Rule[];
  /** 解析できなかった理由（暗号化など）。あれば編集不可 */
  error: string | null;
}

/** ページのコンテンツストリームを1本に連結して返す（複数ストリームは改行で区切る） */
export function pageContentBytes(doc: PDFDocument, page: PDFPage): Uint8Array {
  const contents = page.node.Contents();
  const parts: Uint8Array[] = [];
  const pushStream = (ref: unknown) => {
    const b = decodeStreamBytes(doc, ref as never);
    if (b) parts.push(b);
  };
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) pushStream(contents.get(i));
  } else if (contents) pushStream(contents);
  let len = 0;
  for (const p of parts) len += p.length + 1;
  const out = new Uint8Array(Math.max(0, len));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
    out[o++] = 0x0a;
  }
  return out;
}

/**
 * このページで使われている「ToUnicode の無い Type0 フォント」に、pdf.js が求めた文字コード → 文字の対応表を渡す。
 * 対応付けはフォント名（一部埋め込みの接頭辞つき）で行う。同じ名前のフォントが複数あれば表をまとめ、食い違う文字コードは捨てる。
 * 1 つでも渡せたら true。
 */
/** フォントの、表示側が使っているかもしれない別の名前（CMap 名を除いた名前、子孫フォントの名前、フォントの説明の名前） */
function otherNames(f: FontInfo): string[] {
  const out: string[] = [];
  const text = (o: unknown) => (o instanceof PDFName ? o.decodeText() : "");
  const enc = text(f.dict.get(PDFName.of("Encoding")));
  if (enc && f.baseFont.endsWith(`-${enc}`)) out.push(f.baseFont.slice(0, -enc.length - 1));
  const list = f.dict.lookup(PDFName.of("DescendantFonts"));
  const cid = list instanceof PDFArray ? list.lookup(0) : undefined;
  if (cid instanceof PDFDict) {
    const b = text(cid.get(PDFName.of("BaseFont")));
    if (b) out.push(b);
    const fd = cid.lookup(PDFName.of("FontDescriptor"));
    const n = fd instanceof PDFDict ? text(fd.get(PDFName.of("FontName"))) : "";
    if (n) out.push(n);
  }
  return out;
}

async function attachExternalUnicode(doc: SourceDoc, srcIndex: number, shows: ShowOp[]): Promise<boolean> {
  const need = new Map<string, FontInfo[]>();
  for (const s of shows) {
    const f = s.font;
    if (!f?.needsExternalUnicode || !f.setExternalUnicode || !f.baseFont) continue;
    const list = need.get(f.baseFont) ?? [];
    if (!list.includes(f)) list.push(f);
    need.set(f.baseFont, list);
  }
  if (!need.size) return false;
  try {
    const pdfjs = await getPdfJs();
    const page = await doc.pdf.getPage(srcIndex + 1);
    const list = await page.getOperatorList();
    const names = new Set<string>();
    // 表示側が文字ごとに付けた「元の文字コード → 文字」（fontExtraProperties を渡すと、字形ごとに元の文字コードが付く）。
    // pdf.js 6 からは、フォントの対応表そのもの（toUnicode）が表示側に渡されなくなったので、こちらから集める
    const shown = new Map<string, Map<number, string | null>>();
    let current = "";
    list.fnArray.forEach((fn, i) => {
      const a = list.argsArray[i] as unknown[] | null;
      if (fn === pdfjs.OPS.setFont && a && typeof a[0] === "string") {
        names.add(a[0]);
        current = a[0];
      } else if (fn === pdfjs.OPS.showText && a && Array.isArray(a[0]) && current) {
        const m = shown.get(current) ?? new Map<number, string | null>();
        for (const g of a[0] as unknown[]) {
          const gl = g as { originalCharCode?: unknown; unicode?: unknown } | null;
          if (!gl || typeof gl !== "object" || typeof gl.originalCharCode !== "number" || typeof gl.unicode !== "string" || !gl.unicode) continue;
          const code = gl.originalCharCode;
          m.set(code, m.has(code) && m.get(code) !== gl.unicode ? null : gl.unicode);
        }
        shown.set(current, m);
      }
    });
    const maps = new Map<string, Map<number, string | null>>();
    type FontObj = { name?: string; toUnicode?: { _map?: Record<string, string> | string[] } };
    const bare = (n: string) => n.replace(/^[A-Z]{6}\+/, "");
    const loose = new Map<string, FontObj | null>();
    for (const nm of names) {
      let obj: FontObj | undefined;
      try {
        obj = page.commonObjs.get(nm) as FontObj | undefined;
      } catch {
        obj = undefined;
      }
      // pdf.js 5 までは対応表そのものが届く。6 からは、上で集めた「表示した字」の対応で代える
      const glyphs = shown.get(nm);
      const raw: Record<string, string> | string[] | undefined =
        obj?.toUnicode?._map ?? (glyphs ? Object.fromEntries([...glyphs].filter((e): e is [number, string] => !!e[1])) : undefined);
      if (!obj?.name || !raw) continue;
      if (!need.has(obj.name)) {
        // 中身が同じフォントを、表示側が別のページのフォント（一部埋め込みの接頭辞だけが違う名前）としてまとめていることがある。
        // このページに同じ名前のフォントが無いときに限り、接頭辞を除いた名前で引き当てる
        loose.set(bare(obj.name), loose.has(bare(obj.name)) ? null : { ...obj, toUnicode: { _map: raw } });
        continue;
      }
      const m = maps.get(obj.name) ?? new Map<number, string | null>();
      for (const k in raw) {
        const code = Number(k);
        const v = (raw as Record<string, string>)[k];
        if (!Number.isFinite(code) || typeof v !== "string" || !v) continue;
        // 同じ名前の別フォントと食い違う文字コードは信用しない
        m.set(code, m.has(code) && m.get(code) !== v ? null : v);
      }
      maps.set(obj.name, m);
    }
    for (const name of need.keys()) {
      if (maps.has(name)) continue;
      // 表示側のフォント名と食い違うことがある：一部埋め込みの接頭辞、フォント名の後ろに付けた CMap 名
      // （「HeiseiMin-W3-UniJIS-UTF16-H」のような書き方）、子孫フォントやフォントの説明に書かれた別の名前
      const candidates = [bare(name), ...(need.get(name) ?? []).flatMap(otherNames).map(bare)].filter((n, i, all) => n !== name && all.indexOf(n) === i);
      const raw = candidates.map((n) => loose.get(n)?.toUnicode?._map).find(Boolean);
      if (!raw) continue;
      const m = new Map<number, string | null>();
      for (const k in raw) {
        const code = Number(k);
        const v = (raw as Record<string, string>)[k];
        if (Number.isFinite(code) && typeof v === "string" && v) m.set(code, v);
      }
      maps.set(name, m);
    }
    let attached = false;
    for (const [name, m] of maps) {
      const clean = new Map<number, string>();
      for (const [k, v] of m) if (v) clean.set(k, v);
      if (!clean.size) continue;
      for (const f of need.get(name) ?? []) {
        f.setExternalUnicode!(clean);
        attached = true;
      }
    }
    return attached;
  } catch {
    return false;
  }
}

const analyses = new WeakMap<SourceDoc, Map<number, Promise<PageAnalysis>>>();

export function analyzePage(doc: SourceDoc, srcIndex: number): Promise<PageAnalysis> {
  let m = analyses.get(doc);
  if (!m) {
    m = new Map();
    analyses.set(doc, m);
  }
  let p = m.get(srcIndex);
  if (!p) {
    p = (async (): Promise<PageAnalysis> => {
      const empty = (error: string): PageAnalysis => ({ bytes: new Uint8Array(), ops: [], shows: [], resources: undefined, usesForms: false, images: [], forms: [], rules: [], error });
      let lib: PDFDocument;
      try {
        lib = await getLibDoc(doc);
      } catch (e) {
        return empty(tr("reason.parse", { message: e instanceof Error ? e.message : String(e) }));
      }
      if (lib.isEncrypted) return empty(tr("reason.encrypted"));
      try {
        const page = lib.getPage(srcIndex);
        const bytes = pageContentBytes(lib, page);
        const ops = tokenizeContent(bytes);
        const resources = page.node.Resources();
        let walked = walkTextOps(lib, bytes, ops, resources);
        // ToUnicode の無いフォントがあれば、pdf.js が求めた対応表を受け取ってから解析し直す（文字列が取れるようになる）
        if (await attachExternalUnicode(doc, srcIndex, walked.shows)) walked = walkTextOps(lib, bytes, ops, resources);
        const { shows, usesForms, images, forms, rules } = walked;
        return { bytes, ops, shows, resources, usesForms, images, forms, rules, error: null };
      } catch (e) {
        return empty(tr("reason.pageParse", { message: e instanceof Error ? e.message : String(e) }));
      }
    })();
    m.set(srcIndex, p);
  }
  return p;
}

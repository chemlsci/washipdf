/**
 * 圧縮（画像以外）：文書の中のデータを、見た目も中身も変えずに小さくする。
 *  1. 圧縮されていない・弱い圧縮のデータを、圧縮し直す（小さくなるものだけ）
 *  2. 中身がまったく同じデータ（同じ画像やフォントがページごとに重複して入っている文書がある）を 1 つにまとめる
 * どちらも元に戻せる変換で、文字・画像・フォントの内容は変わらない。
 */
import { decodePDFRawStream, PDFArray, PDFDict, type PDFDocument, PDFName, PDFNumber, type PDFObject, PDFRawStream, PDFRef, PDFStream } from "pdf-lib";

export interface OptimizeStats {
  /** 圧縮し直したデータの数と、まとめた重複の数 */
  recompressed: number;
  merged: number;
  /** 減った大きさ（バイト。データ本体の分） */
  saved: number;
}

/** 可逆な圧縮だけで入っているか（圧縮し直してよいか）。そうなら true */
function reencodable(dict: PDFDict): boolean {
  // 予測器つき（DecodeParms）は、そのままのほうが小さいことが多いので触らない
  if (dict.has(PDFName.of("DecodeParms")) || dict.has(PDFName.of("DP"))) return false;
  const f = dict.lookup(PDFName.of("Filter"));
  const names = f === undefined ? [] : f instanceof PDFName ? [f] : f instanceof PDFArray ? f.asArray().map((x) => (x instanceof PDFRef ? dict.context.lookup(x) : x)) : null;
  if (!names) return false;
  return names.every((n) => n instanceof PDFName && ["FlateDecode", "Fl", "LZWDecode", "LZW", "ASCII85Decode", "A85", "ASCIIHexDecode", "AHx", "RunLengthDecode", "RL"].includes(n.decodeText()));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function optimizeStreams(doc: PDFDocument): OptimizeStats {
  const ctx = doc.context;
  const stats: OptimizeStats = { recompressed: 0, merged: 0, saved: 0 };

  // 1. 圧縮し直す
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || !reencodable(obj.dict)) continue;
    const before = obj.contents.length;
    if (before < 64) continue;
    try {
      const plain = decodePDFRawStream(obj).decode();
      const dict = obj.dict.clone(ctx);
      dict.delete(PDFName.of("Filter"));
      dict.delete(PDFName.of("Length"));
      const packed = ctx.flateStream(plain).contents;
      const after = packed.length;
      if (after + 16 < before) {
        dict.set(PDFName.of("Filter"), PDFName.of("FlateDecode"));
        dict.set(PDFName.of("Length"), PDFNumber.of(after));
        ctx.assign(ref, PDFRawStream.of(dict, packed));
        stats.recompressed++;
        stats.saved += before - after;
      }
    } catch {
      /* 読めないデータは、そのまま残す */
    }
  }

  // 2. 同じ中身のデータをまとめる
  const bytesOf = (s: PDFStream): Uint8Array | null => (s instanceof PDFRawStream ? s.contents : null);
  const groups = new Map<string, { ref: PDFRef; bytes: Uint8Array }[]>();
  const replace = new Map<string, PDFRef>();
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFStream)) continue;
    const bytes = bytesOf(obj);
    if (!bytes || bytes.length < 128) continue;
    // 手がかり：大きさ・辞書の内容（Length を除く）・先頭と末尾の一部。一致したら全体を比べる
    const d = obj.dict.clone(ctx);
    d.delete(PDFName.of("Length"));
    let h = 2166136261;
    const step = Math.max(1, Math.floor(bytes.length / 2048));
    for (let i = 0; i < bytes.length; i += step) h = Math.imul(h ^ bytes[i], 16777619);
    const key = `${bytes.length}:${h >>> 0}:${d.toString()}`;
    const list = groups.get(key) ?? [];
    const same = list.find((x) => sameBytes(x.bytes, bytes));
    if (same) {
      replace.set(ref.toString(), same.ref);
      stats.merged++;
      stats.saved += bytes.length;
    } else {
      list.push({ ref, bytes });
      groups.set(key, list);
    }
  }
  if (replace.size) {
    const swap = (v: PDFObject): PDFObject => (v instanceof PDFRef ? (replace.get(v.toString()) ?? v) : v);
    const visit = (o: PDFObject | undefined, depth: number) => {
      if (!o || depth > 40) return;
      if (o instanceof PDFDict) {
        for (const [k, v] of o.entries()) {
          const n = swap(v);
          if (n !== v) o.set(k, n);
          else if (v instanceof PDFDict || v instanceof PDFArray) visit(v, depth + 1);
        }
      } else if (o instanceof PDFArray) {
        for (let i = 0; i < o.size(); i++) {
          const v = o.get(i);
          const n = swap(v);
          if (n !== v) o.set(i, n);
          else if (v instanceof PDFDict || v instanceof PDFArray) visit(v, depth + 1);
        }
      } else if (o instanceof PDFStream) visit(o.dict, depth + 1);
    };
    for (const [, obj] of ctx.enumerateIndirectObjects()) visit(obj, 0);
    visit(ctx.trailerInfo.Root ? ctx.lookup(ctx.trailerInfo.Root) : undefined, 0);
    for (const [ref] of ctx.enumerateIndirectObjects()) if (replace.has(ref.toString())) ctx.delete(ref);
  }
  return stats;
}

/**
 * 表示に使われない付随データを外す（外したデータそのものは、あとの「参照されていないものを取り除く」処理で消える）：
 *   - 画像・フォント・ページなどに個別に付いている XMP メタデータ（文書全体のものは残す）
 *   - ほかのソフトが自分用に入れた編集データ（/PieceInfo。Illustrator の編集用データなど）
 *   - ページの縮小画像（/Thumb。表示ソフトは自分で作る）
 * 外した項目の数を返す
 */
export function stripAuxiliary(doc: PDFDocument): number {
  const ctx = doc.context;
  const catalog = doc.catalog;
  let n = 0;
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : null;
    if (!dict) continue;
    for (const key of dict === catalog ? ["PieceInfo"] : ["Metadata", "PieceInfo", "Thumb"]) {
      if (!dict.has(PDFName.of(key))) continue;
      dict.delete(PDFName.of(key));
      n++;
    }
  }
  return n;
}

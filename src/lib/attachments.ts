/** 添付ファイル（EmbeddedFiles 名前ツリー）の読み取りと書き込み */
import { decodePDFRawStream, PDFArray, PDFDict, type PDFDocument, PDFHexString, PDFName, type PDFObject, PDFRawStream, PDFString } from "pdf-lib";

export interface AttachmentItem {
  id: string;
  name: string;
  bytes: Uint8Array;
  mime: string;
  description: string;
  /** 元 PDF から引き継いだものなら、その SourceDoc の id */
  srcId: string | null;
}

const text = (o: PDFObject | undefined): string => (o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : "");

/** PDF に入っている添付ファイルを列挙する */
export function readAttachments(doc: PDFDocument): Omit<AttachmentItem, "id" | "srcId">[] {
  const out: Omit<AttachmentItem, "id" | "srcId">[] = [];
  const names = doc.catalog.lookup(PDFName.of("Names"));
  if (!(names instanceof PDFDict)) return out;
  const root = names.lookup(PDFName.of("EmbeddedFiles"));
  if (!(root instanceof PDFDict)) return out;
  const seen = new Set<PDFDict>();
  const walk = (node: PDFDict, depth: number) => {
    if (seen.has(node) || depth > 32) return;
    seen.add(node);
    const kids = node.lookup(PDFName.of("Kids"));
    if (kids instanceof PDFArray) {
      for (const k of kids.asArray()) {
        const kd = doc.context.lookup(k);
        if (kd instanceof PDFDict) walk(kd, depth + 1);
      }
    }
    const arr = node.lookup(PDFName.of("Names"));
    if (!(arr instanceof PDFArray)) return;
    for (let i = 0; i + 1 < arr.size(); i += 2) {
      const spec = doc.context.lookup(arr.get(i + 1));
      if (!(spec instanceof PDFDict)) continue;
      const ef = spec.lookup(PDFName.of("EF"));
      if (!(ef instanceof PDFDict)) continue;
      const stream = ef.lookup(PDFName.of("UF")) ?? ef.lookup(PDFName.of("F"));
      if (!(stream instanceof PDFRawStream)) continue;
      let bytes: Uint8Array;
      try {
        bytes = stream.dict.has(PDFName.of("Filter")) ? decodePDFRawStream(stream).decode() : stream.contents;
      } catch {
        continue;
      }
      const subtype = stream.dict.lookup(PDFName.of("Subtype"));
      const name = text(spec.lookup(PDFName.of("UF"))) || text(spec.lookup(PDFName.of("F"))) || text(doc.context.lookup(arr.get(i))) || `file${out.length + 1}`;
      out.push({ name, bytes, mime: subtype instanceof PDFName ? subtype.decodeText() : "application/octet-stream", description: text(spec.lookup(PDFName.of("Desc"))) });
    }
  };
  walk(root, 0);
  return out;
}

/** 表示できる ASCII だけの名前か */
const isPlainAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** 1 文字 1 バイトの文字列を、16 進の文字列オブジェクトにする */
const hexOfAscii = (s: string) => PDFHexString.of([...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(""));

/** MIME の種類として書いてよい形か（PDF の名前オブジェクトになるので、決まった文字だけを通す） */
const safeMime = (m: string) => (/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/.test(m) ? m : "application/octet-stream");

/**
 * 添付ファイルを書き込む（元の EmbeddedFiles は消し、items だけにする）。
 *
 * ファイル名と説明は、必ず 16 進の文字列（<...>）で書く。pdf-lib の attach() は /F を括弧の文字列 (...) のまま書くので、
 * 名前に「(」「)」「\」があると、保存した PDF が読めなくなったり、名前の続きが別の項目として解釈されたりする
 * （添付は元の PDF から引き継いで保存のたびに書き直すので、他人の作った名前もここを通る）。
 */
export async function writeAttachments(doc: PDFDocument, items: AttachmentItem[]): Promise<void> {
  const ctx = doc.context;
  const names = doc.catalog.lookup(PDFName.of("Names"));
  if (names instanceof PDFDict) names.delete(PDFName.of("EmbeddedFiles"));
  if (!items.length) return;
  const now = PDFString.fromDate(new Date());
  // 名前ツリーの見出し（キー）は、重複なし・昇順でなければならない。同じ名前の添付があれば、見出しにだけ連番を付ける
  const used = new Set<string>();
  const entries = items.map((it) => {
    let key = it.name;
    for (let k = 2; used.has(key); k++) key = `${it.name} (${k})`;
    used.add(key);
    const stream = ctx.register(
      ctx.flateStream(it.bytes, { Type: "EmbeddedFile", Subtype: safeMime(it.mime || ""), Params: { Size: it.bytes.length, CreationDate: now, ModDate: now } }),
    );
    const spec = ctx.register(
      ctx.obj({
        Type: "Filespec",
        // /F は古いソフト向けの名前。半角英数字だけならそのまま 1 文字 1 バイトで、それ以外は /UF と同じ書き方にする
        F: isPlainAscii(it.name) ? hexOfAscii(it.name) : PDFHexString.fromText(it.name),
        UF: PDFHexString.fromText(it.name),
        EF: { F: stream, UF: stream },
        Desc: it.description ? PDFHexString.fromText(it.description) : undefined,
      }),
    );
    return { key, spec };
  });
  // 見出しは UTF-16 で書くので、その並び（符号単位の順）にそろえる
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const tree = ctx.obj({ Names: entries.flatMap((e) => [PDFHexString.fromText(e.key), e.spec]) });
  let root = doc.catalog.lookup(PDFName.of("Names"));
  if (!(root instanceof PDFDict)) {
    root = ctx.obj({});
    doc.catalog.set(PDFName.of("Names"), root);
  }
  (root as PDFDict).set(PDFName.of("EmbeddedFiles"), tree);
}

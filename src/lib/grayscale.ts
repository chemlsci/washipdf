/**
 * グレースケール化：ページ内容の色命令（rg/RG/k/K/sc/scn/SC/SCN）を灰色に書き換え、
 * Form XObject の中身にも再帰し、注釈の色と画像（compress の灰色化）も変える。
 * パターン・シェーディング・特色（Separation）はそのまま。
 */
import { PDFArray, PDFDict, type PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream } from "pdf-lib";
import { compressImages } from "./compress";
import { fmt, type Operand, spliceContent, tokenizeContent } from "./contentStream";
import { pageContentBytes } from "./libDoc";
import { colorFromOperands, colorSpaceKind } from "./textOps";

const luminance = (rgb: [number, number, number]) => Math.max(0, Math.min(1, (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255));

/** 1 本のコンテンツストリームの色命令を灰色に書き換える */
export function grayscaleContent(doc: PDFDocument, bytes: Uint8Array, resources: PDFDict | undefined): Uint8Array {
  const ops = tokenizeContent(bytes);
  const splices: { start: number; end: number; text: string }[] = [];
  let fillCs = "DeviceGray";
  let strokeCs = "DeviceGray";
  const stack: [string, string][] = [];
  const gray = (cs: string, a: Operand[], stroke: boolean): string | null => {
    if (cs === "Pattern") return null;
    const kind = colorSpaceKind(doc, resources, cs);
    if (kind === "DeviceGray" || kind === "CalGray" || (kind === "ICC" && a.length === 1)) return null;
    if (kind === "Separation" || kind === "DeviceN" || kind === "Indexed") return null;
    const rgb = colorFromOperands(kind, a);
    if (!rgb) return null;
    return `${fmt(luminance(rgb))} ${stroke ? "G" : "g"}`;
  };
  for (const op of ops) {
    const a = op.operands;
    let rep: string | null = null;
    switch (op.op) {
      case "q":
        stack.push([fillCs, strokeCs]);
        break;
      case "Q":
        [fillCs, strokeCs] = stack.pop() ?? ["DeviceGray", "DeviceGray"];
        break;
      case "cs":
        fillCs = a[0]?.kind === "name" ? a[0].value : "DeviceGray";
        break;
      case "CS":
        strokeCs = a[0]?.kind === "name" ? a[0].value : "DeviceGray";
        break;
      case "rg":
        fillCs = "DeviceRGB";
        rep = gray("DeviceRGB", a, false);
        break;
      case "RG":
        strokeCs = "DeviceRGB";
        rep = gray("DeviceRGB", a, true);
        break;
      case "k":
        fillCs = "DeviceCMYK";
        rep = gray("DeviceCMYK", a, false);
        break;
      case "K":
        strokeCs = "DeviceCMYK";
        rep = gray("DeviceCMYK", a, true);
        break;
      case "sc":
      case "scn":
        rep = gray(fillCs, a, false);
        break;
      case "SC":
      case "SCN":
        rep = gray(strokeCs, a, true);
        break;
    }
    if (rep !== null) splices.push({ start: op.start, end: op.end, text: rep });
  }
  return splices.length ? spliceContent(bytes, splices) : bytes;
}

function grayscaleXObjects(doc: PDFDocument, resources: PDFDict | undefined, seen: Set<string>, depth: number): void {
  if (!resources || depth > 8) return;
  const xobj = resources.lookup(PDFName.of("XObject"));
  if (!(xobj instanceof PDFDict)) return;
  for (const [, v] of xobj.entries()) {
    const key = v instanceof PDFRef ? v.toString() : null;
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const s = doc.context.lookup(v);
    if (!(s instanceof PDFRawStream) || s.dict.lookup(PDFName.of("Subtype")) !== PDFName.of("Form")) continue;
    let bytes: Uint8Array;
    try {
      bytes = decodePDFRawStream(s).decode();
    } catch {
      continue;
    }
    const res = s.dict.lookup(PDFName.of("Resources"));
    const next = grayscaleContent(doc, bytes, res instanceof PDFDict ? res : undefined);
    if (next !== bytes) {
      const dict = s.dict.clone(doc.context);
      dict.delete(PDFName.of("Filter"));
      dict.delete(PDFName.of("DecodeParms"));
      dict.delete(PDFName.of("Length"));
      const replaced = doc.context.flateStream(next, {});
      for (const [k, val] of dict.entries()) if (!replaced.dict.has(k)) replaced.dict.set(k, val);
      if (v instanceof PDFRef) doc.context.assign(v, replaced);
    }
    grayscaleXObjects(doc, res instanceof PDFDict ? res : undefined, seen, depth + 1);
  }
}

/** 外観ストリーム（Form XObject）の中身を灰色にする */
function grayscaleAppearance(doc: PDFDocument, ref: unknown, seen: Set<string>): void {
  const key = ref instanceof PDFRef ? ref.toString() : null;
  if (key && seen.has(key)) return;
  if (key) seen.add(key);
  const s = doc.context.lookup(ref as PDFRef);
  if (s instanceof PDFDict && !(s instanceof PDFStream)) {
    for (const [, v] of s.entries()) grayscaleAppearance(doc, v, seen);
    return;
  }
  if (!(s instanceof PDFStream)) return;
  let bytes: Uint8Array | null;
  try {
    bytes = s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : ((s as { getUnencodedContents?: () => Uint8Array }).getUnencodedContents?.call(s) ?? null);
  } catch {
    return;
  }
  if (!bytes) return;
  const res = s.dict.lookup(PDFName.of("Resources"));
  const next = grayscaleContent(doc, bytes, res instanceof PDFDict ? res : undefined);
  if (next !== bytes && ref instanceof PDFRef) {
    const replaced = doc.context.flateStream(next, {});
    for (const [k, val] of s.dict.entries()) if (!replaced.dict.has(k) && k !== PDFName.of("Filter") && k !== PDFName.of("DecodeParms") && k !== PDFName.of("Length")) replaced.dict.set(k, val);
    doc.context.assign(ref, replaced);
  }
  grayscaleXObjects(doc, res instanceof PDFDict ? res : undefined, seen, 1);
}

/** 注釈の色（/C /IC）と外観を灰色にする */
function grayscaleAnnots(doc: PDFDocument, page: import("pdf-lib").PDFPage, seen: Set<string>): void {
  const annots = page.node.Annots();
  if (!(annots instanceof PDFArray)) return;
  for (const r of annots.asArray()) {
    const d = doc.context.lookup(r);
    if (!(d instanceof PDFDict)) continue;
    const ap = d.lookup(PDFName.of("AP"));
    if (ap instanceof PDFDict) for (const [, v] of ap.entries()) grayscaleAppearance(doc, v, seen);
    for (const key of ["C", "IC"]) {
      const arr = d.lookup(PDFName.of(key));
      if (!(arr instanceof PDFArray)) continue;
      const nums = arr.asArray().map((x) => (x instanceof PDFNumber ? x.asNumber() : 0));
      let l: number | null = null;
      if (nums.length === 3) l = luminance([nums[0] * 255, nums[1] * 255, nums[2] * 255]);
      else if (nums.length === 4) l = luminance([(1 - nums[0]) * (1 - nums[3]) * 255, (1 - nums[1]) * (1 - nums[3]) * 255, (1 - nums[2]) * (1 - nums[3]) * 255]);
      if (l !== null) d.set(PDFName.of(key), doc.context.obj([l]));
    }
  }
}

/** 文書全体を灰色にする（保存時に呼ぶ） */
export async function grayscaleDocument(doc: PDFDocument): Promise<void> {
  const seen = new Set<string>();
  for (const page of doc.getPages()) {
    let resources: PDFDict | undefined;
    try {
      resources = page.node.Resources();
    } catch {
      resources = undefined;
    }
    let bytes: Uint8Array;
    try {
      bytes = pageContentBytes(doc, page);
    } catch {
      continue;
    }
    const next = grayscaleContent(doc, bytes, resources);
    if (next !== bytes) page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.flateStream(next)));
    grayscaleXObjects(doc, resources, seen, 0);
    grayscaleAnnots(doc, page, seen);
  }
  // 画像：縮小せずに灰色の JPEG へ（対応外の形式はそのまま）
  await compressImages(doc, { enabled: true, dpi: 100000, quality: 0.92, grayscale: true, force: true });
}

export { PDFStream };

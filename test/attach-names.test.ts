import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName } from "pdf-lib";
import { type AttachmentItem, readAttachments, writeAttachments } from "@/lib/attachments";
import { defaultSettings } from "@/lib/docOps";
import { buildPdf } from "@/lib/exportPdf";
import { checkOutput } from "@/lib/outputCheck";
import { fixtures, loadSource, openPdf } from "./helpers";

const body = (s: string) => new TextEncoder().encode(s);
const item = (name: string, i: number, description = ""): AttachmentItem => ({ id: `a${i}`, srcId: null, name, bytes: body(`body of ${i}`), mime: "text/plain", description });

/** 保存した PDF を読み直せなくしていた名前と、そのほかの扱いにくい名前 */
const NAMES = [
  "scan (1.pdf", // 閉じない括弧
  "report).txt", // 開いていない括弧
  "C:\\temp\\", // 末尾が \
  "a.txt)/Injected(yes", // 別の項目を紛れ込ませる
  "balanced (ok).txt",
  "line\nbreak\r.txt",
  "請求書（控え）(2).pdf",
  "😀 emoji ✓.txt",
  "long-" + "x".repeat(5000) + ".txt",
  "<angle>&[brackets]%#.txt",
];

async function attachmentNames(bytes: Uint8Array, password?: string): Promise<string[]> {
  const pdf = await openPdf(bytes, password);
  const att = (await pdf.getAttachments()) as unknown;
  const list = att instanceof Map ? [...att.values()] : Object.values((att as object | null) ?? {});
  return (list as { filename: string; rawFilename?: string }[]).map((a) => a.rawFilename ?? a.filename);
}

function filespecs(doc: PDFDocument): PDFDict[] {
  const names = doc.catalog.lookup(PDFName.of("Names"), PDFDict).lookup(PDFName.of("EmbeddedFiles"), PDFDict).lookup(PDFName.of("Names"), PDFArray);
  const out: PDFDict[] = [];
  for (let i = 1; i < names.size(); i += 2) out.push(doc.context.lookup(names.get(i), PDFDict));
  return out;
}

test("添付ファイル：括弧・\\・改行・日本語・長い名前でも、保存した PDF が読めて、名前がそのまま戻る", async () => {
  const out = await PDFDocument.create();
  out.addPage([200, 200]);
  await writeAttachments(out, NAMES.map((n, i) => item(n, i, i === 0 ? "説明 (括弧) \\ も" : "")));
  for (const useObjectStreams of [true, false]) {
    const bytes = await out.save({ useObjectStreams });
    // pdf-lib で読み直す
    const again = await PDFDocument.load(bytes);
    const read = readAttachments(again);
    assert.deepEqual(read.map((a) => a.name).sort(), [...NAMES].sort());
    assert.equal(read.find((a) => a.name === NAMES[0])!.description, "説明 (括弧) \\ も");
    for (const a of read) assert.match(new TextDecoder().decode(a.bytes), /^body of \d+$/);
    // 名前の続きが、別の項目として解釈されていない。名前はどれも 16 進の文字列
    for (const spec of filespecs(again)) {
      assert.deepEqual(spec.keys().map((k) => k.decodeText()).sort(), spec.has(PDFName.of("Desc")) ? ["Desc", "EF", "F", "Type", "UF"] : ["EF", "F", "Type", "UF"]);
      assert.ok(spec.get(PDFName.of("F")) instanceof PDFHexString);
      assert.ok(spec.get(PDFName.of("UF")) instanceof PDFHexString);
    }
    // pdf.js でも同じ名前で見える
    const viaPdfjs = await attachmentNames(bytes);
    // （pdf.js は、名前の中の \ を / に読み替えて返す。それ以外はそのまま）
    const same = JSON.stringify([...viaPdfjs].sort()) === JSON.stringify(NAMES.map((n) => n.replaceAll("\\", "/")).sort());
    assert.ok(same, `pdf.js で読んだ名前が違う: ${viaPdfjs.map((n) => n.slice(0, 40)).join(" | ")}`);
    // 保存前の自己点検も通る
    assert.deepEqual(await checkOutput(bytes, 1), { ok: true });
  }
});

test("添付ファイル：同じ名前が 2 つあっても両方残り、名前ツリーの見出しは重複なし・昇順", async () => {
  const out = await PDFDocument.create();
  out.addPage([200, 200]);
  await writeAttachments(out, [item("b.txt", 0), item("a (1.txt", 1), item("b.txt", 2), item("あ.txt", 3)]);
  const again = await PDFDocument.load(await out.save());
  assert.deepEqual(readAttachments(again).map((a) => a.name).sort(), ["a (1.txt", "b.txt", "b.txt", "あ.txt"]);
  const arr = again.catalog.lookup(PDFName.of("Names"), PDFDict).lookup(PDFName.of("EmbeddedFiles"), PDFDict).lookup(PDFName.of("Names"), PDFArray);
  const keys: string[] = [];
  for (let i = 0; i < arr.size(); i += 2) keys.push((arr.get(i) as PDFHexString).decodeText());
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(keys, [...keys].sort());
});

test("添付ファイル：種類（MIME）に変な文字があっても、PDF を壊さない", async () => {
  const out = await PDFDocument.create();
  out.addPage([200, 200]);
  await writeAttachments(out, [{ ...item("x.bin", 0), mime: "text/html) /Evil (1" }, { ...item("y.bin", 1), mime: "" }, { ...item("z.csv", 2), mime: "text/csv" }]);
  const read = readAttachments(await PDFDocument.load(await out.save()));
  assert.deepEqual(read.map((a) => `${a.name}:${a.mime}`).sort(), ["x.bin:application/octet-stream", "y.bin:application/octet-stream", "z.csv:text/csv"]);
});

test("添付ファイル：文書を保存して（保護あり・なし）読み直しても、扱いにくい名前がそのまま残る", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "ja-subset-identity.pdf"));
  const sources = new Map([[doc.id, doc]]);
  for (const protect of [false, true]) {
    const settings = defaultSettings();
    settings.attachments = NAMES.slice(0, 5).map((n, i) => item(n, i));
    if (protect) settings.security = { ...settings.security, enabled: true, userPassword: "pw-1" };
    const bytes = await buildPdf(pages, sources, new Map(), { settings });
    assert.deepEqual(await checkOutput(bytes, pages.length, settings.security), { ok: true });
    const names = await attachmentNames(bytes, protect ? "pw-1" : undefined);
    assert.equal(names.length, 5);
  }
});

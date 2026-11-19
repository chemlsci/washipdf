// 同梱フォントで日本語を PDF に埋め込み、次の点を確認する。
//   1. pdf.js で読み戻した文字が一致する（コピー・検索できる）
//   2. PDF に埋め込まれたグリフ（文字の形）が元フォントと完全に一致する（表示で欠けない）
//   3. Acrobat が要求する形になっている（/Length1、"ABCDEF+" 付きの名前、(3,1) の cmap）
//   node scripts/check-font.mjs
import fontkit from "@pdf-lib/fontkit";
import * as esbuild from "esbuild";
import { decodePDFRawStream, PDFDict, PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// アプリと同じサブセット処理（TypeScript）をその場でビルドして使う
const built = await esbuild.build({
  entryPoints: [join(root, "src", "lib", "ttfSubset.ts")],
  bundle: true,
  format: "esm",
  write: false,
  platform: "neutral",
});
const { parseTtf, glyphIdForCodePoint, glyphData } = await import(
  "data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64")
);
// 埋め込み処理（pdfFont.ts）は pdf-lib を共有する必要があるので、node_modules の中に書き出して読み込む
const cacheDir = join(root, "node_modules", ".cache", "washi-pdf");
mkdirSync(cacheDir, { recursive: true });
const libFile = join(cacheDir, "pdfFont.mjs");
writeFileSync(
  libFile,
  (await esbuild.build({ entryPoints: [join(root, "src", "lib", "pdfFont.ts")], bundle: true, format: "esm", write: false, platform: "node", external: ["pdf-lib"] }))
    .outputFiles[0].text,
);
const { embedSubsetFont, finishSubsetFonts } = await import(pathToFileURL(libFile).href);

/** cmap の (platform, encoding) と、(3,1) format 4 で引いたグリフ番号 */
function cmapInfo(f) {
  const t = f.tables.get("cmap");
  const v = f.view;
  const subs = [];
  let fmt4 = -1;
  for (let i = 0; i < v.getUint16(t.offset + 2); i++) {
    const p = t.offset + 4 + i * 8;
    const pid = v.getUint16(p);
    const eid = v.getUint16(p + 2);
    const off = t.offset + v.getUint32(p + 4);
    subs.push(`(${pid},${eid}) format ${v.getUint16(off)}`);
    if (pid === 3 && eid === 1 && v.getUint16(off) === 4) fmt4 = off;
  }
  const lookup4 = (cp) => {
    if (fmt4 < 0 || cp > 0xffff) return 0;
    const n2 = v.getUint16(fmt4 + 6);
    for (let i = 0; i < n2; i += 2) {
      if (cp > v.getUint16(fmt4 + 14 + i)) continue;
      const start = v.getUint16(fmt4 + 16 + n2 + i);
      if (cp < start || v.getUint16(fmt4 + 16 + n2 * 3 + i)) return 0;
      return (cp + v.getUint16(fmt4 + 16 + n2 * 2 + i)) & 0xffff;
    }
    return 0;
  };
  return { subs, lookup4 };
}

const SAMPLE = "見積書 合計金額 ¥120,000（税込）Invoice No.12345 髙﨑様 ①② ご確認ください。";
const fonts = {
  gothic: "assets/fonts/BIZUDPGothic-Regular.ttf",
  mincho: "assets/fonts/BIZUDPMincho-Regular.ttf",
};

// GitHub Actions ではメッセージを注釈として表示する
const ci = !!process.env.GITHUB_ACTIONS;
const report = (level, msg) => console.log(ci ? `::${level}::${msg.replace(/\n/g, "%0A")}` : msg);
process.on("uncaughtException", (e) => {
  report("error", `check-font: ${e?.stack ?? e}`);
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  report("error", `check-font: ${e?.stack ?? e}`);
  process.exit(1);
});

// 埋め込み側は 4 バイト境界まで 0 で詰めているので、その分は許容する
const same = (emb, orig) =>
  emb.length >= orig.length && emb.length - orig.length < 4 && orig.every((x, i) => x === emb[i]) && emb.subarray(orig.length).every((x) => x === 0);
let failed = false;

/** PDF を作って、埋め込まれたグリフが元フォントと一致しない文字を返す */
async function brokenGlyphs(full, makeFont) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await makeFont(doc);
  doc.addPage([595, 842]).drawText(SAMPLE, { x: 40, y: 780, size: 14, font });
  const loaded = await PDFDocument.load(await doc.save());
  let fontFile = null;
  for (const [, obj] of loaded.context.enumerateIndirectObjects()) {
    const ref = obj instanceof PDFDict ? obj.get(PDFName.of("FontFile2")) : undefined;
    const stream = ref ? loaded.context.lookup(ref) : undefined;
    if (stream instanceof PDFRawStream) fontFile = decodePDFRawStream(stream).decode();
  }
  if (!fontFile) return null;
  const orig = parseTtf(full);
  const emb = parseTtf(fontFile);
  return [...new Set(SAMPLE)].filter((ch) => {
    if (!ch.trim()) return false;
    const gid = glyphIdForCodePoint(orig, ch.codePointAt(0));
    // fontkit のサブセットはグリフ番号を振り直すので、埋め込み側の cmap で引く
    const egid = glyphIdForCodePoint(emb, ch.codePointAt(0)) || gid;
    return gid && !same(glyphData(emb, egid), glyphData(orig, gid));
  });
}

for (const [name, path] of Object.entries(fonts)) {
  const full = new Uint8Array(readFileSync(join(root, path)));
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await embedSubsetFont(doc, full, SAMPLE);
  doc.addPage([595, 842]).drawText(SAMPLE, { x: 40, y: 780, size: 14, font });
  await finishSubsetFonts(doc, [font]);
  const bytes = await doc.save();

  // 1. 文字の読み戻し
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false }).promise;
  const content = await (await pdf.getPage(1)).getTextContent();
  const text = content.items.map((i) => ("str" in i ? i.str : "")).join("");
  await pdf.loadingTask.destroy();
  const norm = (s) => s.replace(/\s+/g, "");
  const textOk = norm(text) === norm(SAMPLE);

  // 2. 埋め込まれたグリフの比較
  const loaded = await PDFDocument.load(bytes);
  let fontFile = null;
  let length1 = null;
  let fontName = "";
  for (const [, obj] of loaded.context.enumerateIndirectObjects()) {
    const ref = obj instanceof PDFDict ? obj.get(PDFName.of("FontFile2")) : undefined;
    const stream = ref ? loaded.context.lookup(ref) : undefined;
    if (stream instanceof PDFRawStream) {
      fontFile = decodePDFRawStream(stream).decode();
      length1 = stream.dict.get(PDFName.of("Length1"))?.asNumber?.() ?? null;
      fontName = obj.get(PDFName.of("FontName"))?.decodeText?.() ?? "";
    }
  }
  const orig = parseTtf(full);
  const emb = fontFile ? parseTtf(fontFile) : null;
  const broken = [];
  for (const ch of new Set(SAMPLE)) {
    if (!ch.trim()) continue;
    const gid = glyphIdForCodePoint(orig, ch.codePointAt(0));
    if (!gid) continue;
    if (!emb || !same(glyphData(emb, gid), glyphData(orig, gid))) broken.push(ch);
  }
  const glyphOk = !!emb && broken.length === 0;

  // 3. Acrobat 向けの形式
  const acrobat = [];
  if (!fontFile || length1 !== fontFile.length) acrobat.push(`/Length1 が ${length1}（正しくは ${fontFile?.length}）`);
  if (!/^[A-Z]{6}\+/.test(fontName)) acrobat.push(`フォント名に "ABCDEF+" がない（${fontName}）`);
  if (emb) {
    const { subs, lookup4 } = cmapInfo(emb);
    const miss = [...new Set(SAMPLE)].filter((ch) => {
      const cp = ch.codePointAt(0);
      return cp <= 0xffff && lookup4(cp) !== glyphIdForCodePoint(orig, cp);
    });
    if (miss.length) acrobat.push(`(3,1) cmap で引けない文字 ${miss.join("")}（cmap: ${subs.join(", ")}）`);
  }
  const acrobatOk = acrobat.length === 0;

  const ok = textOk && glyphOk && acrobatOk;
  report(
    ok ? "notice" : "error",
    `${ok ? "OK" : "NG"}  ${name}: PDF ${(bytes.length / 1024).toFixed(0)} KB / ` +
      `文字 ${textOk ? "一致" : `不一致 "${text}"`} / グリフ ${glyphOk ? "一致" : `欠け ${emb ? broken.join("") : "(フォント未検出)"}`} / ` +
      `Acrobat 形式 ${acrobatOk ? "OK" : acrobat.join("、")}`,
  );
  if (!ok) failed = true;

  // 参考：fontkit 標準のサブセット機能では欠けることの確認（この仕組みで検出できることの証明）
  const control = await brokenGlyphs(full, (d) => d.embedFont(full, { subset: true })).catch(() => null);
  report("notice", `参考 ${name}: fontkit のサブセット機能を使った場合の欠け ${control ? `${control.length}文字 ${control.join("")}` : "フォントが壊れていて読み込めない"}`);
}

if (failed) {
  console.error("日本語フォントの埋め込み結果に問題があります");
  process.exit(1);
}

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { decodePDFRawStream, PDFArray, PDFDocument, PDFName, PDFRawStream, PDFString, StandardFonts } from "pdf-lib";
import { wordHunks } from "@/lib/anchoredEdit";
import { createTextEdit } from "@/lib/editModel";
import { buildPdf } from "@/lib/exportPdf";
import { getPageText, type TextRun } from "@/lib/textRuns";
import { advanceWidth, glyphIdForCodePoint, parseTtf, subsetTtf, unitsPerEm } from "@/lib/ttfSubset";
import type { PageItem, SourceDoc, TextEditObj } from "@/lib/types";
import { diffOutside, fixtures, loadSource, openPdf, pageText, renderPage, root, savePng } from "./helpers";

const outDir = join(root, "dist", ".test-out");
mkdirSync(outDir, { recursive: true });

interface Edited {
  bytes: Uint8Array;
  edits: TextEditObj[];
  before: string;
  after: string;
  warnings: string[];
}

async function editAndBuild(
  file: string,
  picks: { match: string; text: string; font?: TextEditObj["font"]; block?: boolean }[],
  tag: string,
  opts: { allowOverflow?: boolean } = {},
): Promise<Edited & { doc: SourceDoc; page: PageItem; runs: TextRun[] }> {
  const { doc, pages } = await loadSource(join(fixtures, file));
  const page = pages[0];
  const { runs } = await getPageText(doc, page);
  const edits: TextEditObj[] = [];
  for (const p of picks) {
    const run = runs.find((r) => r.text.includes(p.match));
    assert.ok(run, `行が見つかりません: ${p.match}`);
    assert.ok(run.editable, `編集不可: ${p.match} (${run.reason})`);
    const group = p.block && run.blockId ? runs.filter((r) => r.blockId === run.blockId) : [run];
    const e = createTextEdit(group, { cover: "#ffffff", fallbackColor: "#000000", font: p.font });
    e.text = p.text;
    edits.push(e);
  }
  const item: PageItem = { ...page, objects: edits };
  const warnings: string[] = [];
  const bytes = await buildPdf([item], new Map([[doc.id, doc]]), new Map(), { onWarning: (m) => warnings.push(m) });
  writeFileSync(join(outDir, `${tag}.pdf`), bytes);
  const beforePdf = await openPdf(doc.bytes);
  const afterPdf = await openPdf(bytes);
  const before = await pageText(beforePdf, 1);
  const after = await pageText(afterPdf, 1);
  // 画像差分：編集した範囲の外は変化しない
  const scale = 2;
  const a = await renderPage(beforePdf, 1, scale);
  const b = await renderPage(afterPdf, 1, scale);
  const { changed, total } = diffOutside(a, b, edits.map((e) => ({ x: e.x, y: e.y, w: e.w, h: e.h })), scale);
  if (process.env.SAVE_PNG) {
    await savePng(a, join(outDir, `${tag}-before.png`));
    await savePng(b, join(outDir, `${tag}-after.png`));
  }
  // はみ出しを許す場合（警告のテスト）は、箱の外に文字が描かれるので比較しない
  if (!opts.allowOverflow) assert.ok(changed / total < 0.0005, `編集範囲の外が変化しています: ${changed}/${total} px`);
  // 再読み込みできる
  const re = await PDFDocument.load(bytes);
  assert.equal(re.getPageCount(), 1);
  return { bytes, edits, before, after, warnings, doc, page, runs };
}

test("日本語（Identity-H サブセット）：1行置換で旧テキストが消え、新テキストが検索できる", async () => {
  const r = await editAndBuild("ja-subset-identity.pdf", [{ match: "株式会社サンプル商事", text: "有限会社テスト工業 御中" }], "ja-line");
  assert.ok(r.before.includes("株式会社サンプル商事"));
  assert.ok(!r.after.includes("株式会社サンプル商事"), "旧テキストが残っている");
  assert.ok(r.after.includes("有限会社テスト工業 御中"), `新テキストが抽出できない: ${r.after}`);
  // 他の行はそのまま
  for (const t of ["お見積書（2026年11月8日）", "合計金額：１２３，４５６円（税込）", "この行は編集しない。"]) assert.ok(r.after.includes(t), `消えてはいけない行: ${t}`);
  assert.equal(r.warnings.length, 0);
});

test("連続 Tj の途中を消しても後続の位置がずれない（進み量の保持）", async () => {
  // 「お見積書」「（2026年」「11月8日）」の 3 命令からなる行を丸ごと置換
  const r = await editAndBuild("ja-subset-identity.pdf", [{ match: "お見積書", text: "ご請求書（2026年12月1日）" }], "ja-multi-tj");
  assert.ok(!r.after.includes("お見積書"));
  assert.ok(r.after.includes("ご請求書（2026年12月1日）"));
});

test("TJ（カーニング）と文字間隔の行を元フォントで置換", async () => {
  const r = await editAndBuild(
    "ja-subset-identity.pdf",
    [
      { match: "下記のとおり", text: "下記の通り見積もります。" },
      { match: "合計金額", text: "合計金額：９８，７６５円（税込）" },
    ],
    "ja-tj-tc",
  );
  assert.ok(!r.after.includes("お見積り申し上げます"));
  assert.ok(r.after.includes("下記の通り見積もります。"));
  assert.ok(!r.after.includes("１２３，４５６"));
  assert.ok(r.after.includes("９８，７６５円"));
});

test("元フォントに無い文字は同梱フォントに切り替わる", async () => {
  // サブセットに無い「鷗」を含める → 元フォントでは書けないので同梱フォントで書かれる
  const r = await editAndBuild("ja-subset-identity.pdf", [{ match: "この行は編集しない", text: "鷗外と漱石。" }], "ja-fallback-font");
  assert.ok(r.after.includes("鷗外と漱石。"), r.after);
  const lib = await PDFDocument.load(r.bytes);
  const fonts = lib.getPage(0).node.Resources()?.lookup(lib.context.obj("Font") as never);
  assert.ok(String(fonts).includes("BIZUDPGothic"), "同梱フォントが埋め込まれていない");
});

test("英語（標準14フォント・非埋め込み）：単語間隔付きの行と連続 Tj の行", async () => {
  const r = await editAndBuild(
    "en-standard14.pdf",
    [
      { match: "Revenue grew", text: "Revenue fell by 3 percent compared to last year." },
      { match: "Part one", text: "Replaced middle line." },
    ],
    "en-lines",
  );
  assert.ok(!r.after.includes("Revenue grew"));
  assert.ok(r.after.includes("Revenue fell by 3 percent"));
  assert.ok(!r.after.includes("part two"));
  assert.ok(r.after.includes("Replaced middle line."));
  assert.ok(r.after.includes("Kerned text with TJ adjustments."));
  assert.ok(r.after.includes("Unchanged footer line."));
});

test("回転ページ（/Rotate 90）でも位置が合う", async () => {
  const r = await editAndBuild("ja-rotated90.pdf", [{ match: "二行目", text: "差し替えた二行目。" }], "ja-rotated");
  assert.ok(!r.after.includes("二行目のテキスト"));
  assert.ok(r.after.includes("差し替えた二行目。"));
  assert.ok(r.after.includes("回転ページの見出し"));
});

test("LibreOffice 出力：表のセルと段落", async () => {
  const r = await editAndBuild(
    "ja-libreoffice-writer.pdf",
    [
      { match: "順序を保持", text: "順序は任意" },
      { match: "社内規程", text: "社外規程（差し替え）" },
    ],
    "ja-lo",
  );
  assert.ok(!r.after.includes("順序を保持"));
  assert.ok(r.after.includes("順序は任意"));
  assert.ok(r.after.includes("社外規程（差し替え）"));
  assert.ok(r.after.replace(/\s/g, "").includes("ZIP出力"));
});

test("段落ブロック：箱内リフロー（3行に収める）", async () => {
  const r = await editAndBuild(
    "ja-subset-identity.pdf",
    [{ match: "自動テスト用", text: "差し替えた段落です。この文章は元の三行分の箱の中で、日本語の禁則処理を守りながら折り返されます。句読点、が行頭に来ないこと、「括弧」が行末に残らないことを確認します。", block: true }],
    "ja-block",
  );
  assert.ok(!r.after.includes("最後の行は短い"));
  assert.ok(r.after.includes("差し替えた段落です。"));
  assert.ok(r.after.includes("確認します。"));
  assert.equal(r.warnings.length, 0, r.warnings.join("\n"));
});

test("収まりきらない長文は縮小され、それでも無理なら警告が出る", async () => {
  const long = "とても長い文章を1行の箱に入れようとすると、まず文字サイズが段階的に小さくなり、それでも入らない場合には警告が出ます。".repeat(3);
  const r = await editAndBuild("ja-subset-identity.pdf", [{ match: "この行は編集しない", text: long }], "ja-overflow", { allowOverflow: true });
  assert.equal(r.warnings.length, 1, r.warnings.join("\n"));
  assert.match(r.warnings[0], /収まりませんでした/);
});

test("latin パックのフォント（Noto Sans）で書き込める", async () => {
  const r = await editAndBuild("en-standard14.pdf", [{ match: "Unchanged footer", text: "Tiếng Việt: Xin chào thế giới", font: "notosans" }], "en-noto");
  assert.ok(r.after.includes("Xin chào thế giới"), r.after);
  const lib = await PDFDocument.load(r.bytes);
  const fonts = lib.getPage(0).node.Resources()?.lookup(lib.context.obj("Font") as never);
  assert.ok(String(fonts).includes("NotoSans"), "Noto Sans が埋め込まれていない");
});

test("1 行の書き換え：文字を変えなければ見た目は変わらず、変えた所より前の字は動かない", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "en-standard14.pdf"));
  const { runs } = await getPageText(doc, pages[0]);
  const src = new Map([[doc.id, doc]]);
  const before = await renderPage(await openPdf(doc.bytes), 1, 2);
  const diff = (a: typeof before, b: typeof before, x0 = 0, x1 = Infinity) => {
    let d = 0;
    for (let y = 0; y < a.height; y++)
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(a.width, x1); x++) {
        const i = (y * a.width + x) * 4;
        if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 60) d++;
      }
    return d;
  };
  // 編集できる行をすべて、文字を変えずに書き直す
  const same = runs.filter((r) => r.editable && !r.vertical && r.originalFontUsable).map((r) => createTextEdit([r], { cover: "#ffffff", fallbackColor: "#000000" }));
  assert.ok(same.length >= 3);
  const out1 = await openPdf(await buildPdf([{ ...pages[0], objects: same }], src, new Map(), { rewriteUnchanged: true }));
  assert.equal(diff(before, await renderPage(out1, 1, 2)), 0, "文字を変えていないのに見た目が変わった");
  assert.equal((await pageText(out1, 1)).replace(/\s+/g, " "), (await pageText(await openPdf(doc.bytes), 1)).replace(/\s+/g, " "), "取り出せる文字が変わった");
  // 行の途中の語を変える：その語より左は 1 画素も変わらない。文字は読む順に取り出せる
  const run = runs.find((r) => r.text.includes("Revenue grew"))!;
  const e = createTextEdit([run], { cover: "#ffffff", fallbackColor: "#000000" });
  const at = run.text.indexOf("grew");
  e.text = run.text.replace("grew", "fell");
  const out2 = await openPdf(await buildPdf([{ ...pages[0], objects: [e] }], src, new Map(), {}));
  const after = await renderPage(out2, 1, 2);
  const leftPart = (run.x + (run.w * (at - 1)) / run.text.length) * 2;
  assert.equal(diff(before, after, 0, leftPart), 0, "変えた語より前が動いた");
  assert.ok(diff(before, after) > 0);
  assert.ok((await pageText(out2, 1)).replace(/\s+/g, " ").includes(e.text.replace(/\s+/g, " ")), "読む順に取り出せない");
});

test("同じ文字での書き直し：試験用 PDF のどれでも、見た目がほとんど変わらない", async () => {
  const { readdirSync } = await import("node:fs");
  for (const f of readdirSync(fixtures).filter((x) => x.endsWith(".pdf") && !x.startsWith("enc-")).sort()) {
    const { doc, pages } = await loadSource(join(fixtures, f));
    const page = pages[0];
    const { runs, pageError } = await getPageText(doc, page);
    if (pageError) continue;
    const objs = runs.filter((r) => r.editable && !r.vertical && r.originalFontUsable).map((r) => createTextEdit([r], { cover: "#ffffff", fallbackColor: "#000000" }));
    if (!objs.length) continue;
    const how: string[] = [];
    const out = await openPdf(await buildPdf([{ ...page, objects: objs }], new Map([[doc.id, doc]]), new Map(), { rewriteUnchanged: true, onEditPath: (h) => how.push(h) }));
    const a = await renderPage(await openPdf(doc.bytes), 1, 1);
    const b = await renderPage(out, 1, 1);
    let d = 0;
    for (let i = 0; i < a.data.length; i += 4) if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 90) d++;
    const ratio = d / (a.width * a.height);
    assert.ok(ratio < 0.002, `${f}: 見た目の差 ${(ratio * 100).toFixed(2)}%（${[...new Set(how)].join(",")}）`);
  }
});

test("縦書きの 1 列：文字を変えなければ見た目は変わらず、同じ字数の書き換えは元の命令の中で行われる", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "ja-vertical.pdf"));
  const { runs } = await getPageText(doc, pages[0]);
  const src = new Map([[doc.id, doc]]);
  const cols = runs.filter((r) => r.vertical && r.editable && r.originalFontUsable);
  assert.ok(cols.length > 0, "縦書きの列が無い");
  const a = await renderPage(await openPdf(doc.bytes), 1, 2);
  const diff = (x: typeof a, y: typeof a) => {
    let d = 0;
    for (let i = 0; i < x.data.length; i += 4) if (Math.abs(x.data[i] - y.data[i]) + Math.abs(x.data[i + 1] - y.data[i + 1]) + Math.abs(x.data[i + 2] - y.data[i + 2]) > 60) d++;
    return d;
  };
  const how: string[] = [];
  const same = cols.map((r) => createTextEdit([r], { cover: "#ffffff", fallbackColor: "#000000" }));
  const out1 = await openPdf(await buildPdf([{ ...pages[0], objects: same }], src, new Map(), { rewriteUnchanged: true, onEditPath: (h) => how.push(h) }));
  assert.deepEqual([...new Set(how)], ["in-place"]);
  assert.equal(diff(a, await renderPage(out1, 1, 2)), 0);
  // 列の中の 2 字を入れ替える（どちらも元のフォントにある字）
  const col = cols.find((r) => [...r.text].length >= 3)!;
  const chars = [...col.text];
  const e = createTextEdit([col], { cover: "#ffffff", fallbackColor: "#000000" });
  e.text = [chars[1], chars[0], ...chars.slice(2)].join("");
  if (e.text !== col.text) {
    const how2: string[] = [];
    const out2 = await openPdf(await buildPdf([{ ...pages[0], objects: [e] }], src, new Map(), { onEditPath: (h) => how2.push(h) }));
    assert.deepEqual(how2, ["in-place"]);
    assert.ok((await pageText(out2, 1)).replace(/\s+/g, "").includes(e.text.replace(/\s+/g, "")), "書き換えた文字が取り出せない");
  }
});

test("段落の書き換え：1 語だけ変えたとき、その行だけが書き直され、ほかの行は元のまま", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "ja-libreoffice-writer.pdf"));
  const { runs } = await getPageText(doc, pages[0]);
  const src = new Map([[doc.id, doc]]);
  // 3 行以上の段落を選ぶ
  const byBlock = new Map<string, TextRun[]>();
  for (const r of runs) if (r.blockId && r.editable && !r.vertical && r.originalFontUsable) byBlock.set(r.blockId, [...(byBlock.get(r.blockId) ?? []), r]);
  const group = [...byBlock.values()].find((g) => g.length >= 3);
  assert.ok(group, "3 行以上の段落が無い");
  const e = createTextEdit(group, { cover: "#ffffff", fallbackColor: "#000000" });
  assert.ok(e.parts && e.parts.length === group.length);
  // 2 行目の中の 2 字を入れ替える（どちらも元のフォントにある字）
  const line = group[1];
  const at = e.original.indexOf(line.text);
  const chars = [...line.text];
  const k = Math.floor(chars.length / 2);
  const swapped = [...chars.slice(0, k), chars[k + 1], chars[k], ...chars.slice(k + 2)].join("");
  assert.notEqual(swapped, line.text);
  e.text = e.original.slice(0, at) + swapped + e.original.slice(at + line.text.length);
  const how: string[] = [];
  const out = await openPdf(await buildPdf([{ ...pages[0], objects: [e] }], src, new Map(), { onEditPath: (h) => how.push(h) }));
  // 段落全体の組み直し（multi）ではなく、1 行ぶんの書き換えになっている
  assert.equal(how.length, 1, how.join());
  assert.notEqual(how[0], "multi");
  const a = await renderPage(await openPdf(doc.bytes), 1, 2);
  const b = await renderPage(out, 1, 2);
  const d = diffOutside(a, b, [{ x: 0, y: line.top - 1, w: pages[0].width, h: line.h + 2 }], 2);
  assert.equal(d.changed, 0, "変えた行の外が変わった");
  assert.ok((await pageText(out, 1)).replace(/\s+/g, "").includes(swapped.replace(/\s+/g, "")), "書き換えた文字が取り出せない");
  // 何も変えなければ、何も書き直さない
  const same = createTextEdit(group, { cover: "#ffffff", fallbackColor: "#000000" });
  const how2: string[] = [];
  const out2 = await openPdf(await buildPdf([{ ...pages[0], objects: [same] }], src, new Map(), { onEditPath: (h) => how2.push(h) }));
  assert.equal(how2.length, 0);
  const c = await renderPage(out2, 1, 2);
  assert.equal(diffOutside(a, c, [], 2).changed, 0);
});

test("見えない写し（切り抜きの外に置いた同じ文）と 1 行にまとまっていても、見えている分だけを行として扱う", async () => {
  // 同じ文を 13pt ずらして 2 回描き、2 回目は切り抜きで見えなくしてある文書
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = pdf.embedStandardFont(StandardFonts.Helvetica);
  page.node.set(PDFName.of("Resources"), pdf.context.obj({ Font: { F1: font.ref } }));
  const content = ["BT /F1 20 Tf 1 0 0 1 60 700 Tm (Hello World) Tj ET", "q 0 0 40 40 re W n BT /F1 20 Tf 1 0 0 1 73 700 Tm (Hello World) Tj ET Q"].join("\n");
  page.node.set(PDFName.of("Contents"), pdf.context.register(pdf.context.flateStream(content)));
  const file = join(outDir, "hidden-copy.pdf");
  writeFileSync(file, await pdf.save({ useObjectStreams: false }));
  const { doc, pages } = await loadSource(file);
  const { runs } = await getPageText(doc, pages[0]);
  assert.deepEqual(
    runs.filter((r) => r.editable).map((r) => r.text),
    ["Hello World"],
  );
  const run = runs.find((r) => r.editable)!;
  assert.equal(run.removals.length, 1);
  // 書き直しても、見えなかった写しは見えるようにならない
  const e = createTextEdit([run], { cover: "#ffffff", fallbackColor: "#000000" });
  e.text = "Hello Word";
  const bytes = await buildPdf([{ ...pages[0], objects: [e] }], new Map([[doc.id, doc]]), new Map(), {});
  const after = await pageText(await openPdf(bytes), 1);
  const a = await renderPage(await openPdf(doc.bytes), 1, 2);
  const b = await renderPage(await openPdf(bytes), 1, 2);
  const ink = (img: { data: Uint8ClampedArray }) => {
    let n = 0;
    for (let i = 0; i < img.data.length; i += 4) if (img.data[i] < 128) n++;
    return n;
  };
  assert.ok(after.includes("Hello Word"), after);
  assert.ok(ink(b) < ink(a) * 1.05, `文字が二重に見えている: ${ink(a)} → ${ink(b)}`);
});

test("一部だけ埋め込んだフォントに無い字（É・ç など）は、対応表に載っていても元のフォントでは書かない", async () => {
  // PHP 系の PDF 作成ソフト（FPDF・TCPDF・mPDF・dompdf など）の形式：文字コード＝Unicode、CIDToGIDMap で字形番号に直す。
  // 文字の対応表（ToUnicode）は全部の文字コードをそのまま返す決まり文句なので、「対応表にある＝字形がある」とは言えない
  const full = new Uint8Array(readFileSync(join(root, "assets/fonts/NotoSans.ttf")));
  const text = "Resume du projet francais.";
  const sub = subsetTtf(full, text);
  const ttf = parseTtf(full);
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const ctx = pdf.context;
  const c2g = new Uint8Array(65536 * 2);
  const W: (number | number[])[] = [];
  for (const ch of new Set(text)) {
    const cp = ch.codePointAt(0)!;
    const gid = glyphIdForCodePoint(ttf, cp);
    c2g[cp * 2] = gid >> 8;
    c2g[cp * 2 + 1] = gid & 255;
    W.push(cp, [Math.round((advanceWidth(ttf, gid) * 1000) / unitsPerEm(ttf))]);
  }
  const cmap = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n1 beginbfrange\n<0000> <FFFF> <0000>\nendbfrange\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend";
  const desc = ctx.register(ctx.obj({ Type: "FontDescriptor", FontName: "NotoSans", Flags: 32, FontBBox: [-500, -500, 1500, 1500], ItalicAngle: 0, Ascent: 1000, Descent: -300, CapHeight: 700, StemV: 80, FontFile2: ctx.register(ctx.flateStream(sub, { Length1: sub.length })) }));
  const cid = ctx.register(ctx.obj({ Type: "Font", Subtype: "CIDFontType2", BaseFont: "NotoSans", CIDSystemInfo: { Registry: PDFString.of("Adobe"), Ordering: PDFString.of("UCS"), Supplement: 0 }, FontDescriptor: desc, DW: 600, W, CIDToGIDMap: ctx.register(ctx.flateStream(c2g)) }));
  const font = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type0", BaseFont: "NotoSans", Encoding: "Identity-H", DescendantFonts: [cid], ToUnicode: ctx.register(ctx.flateStream(cmap)) }));
  page.node.set(PDFName.of("Resources"), ctx.obj({ Font: { F1: font } }));
  const hex = [...text].map((ch) => ch.codePointAt(0)!.toString(16).padStart(4, "0")).join("");
  // 文字列の直前に空白を置かない書き方（Tf<…>Tj）にしておく：差し替えた命令が前の命令とつながらないことも確かめる
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(`BT 60 700 Td /F1 16 Tf<${hex}>Tj\nET`)));
  const file = join(outDir, "php-style-font.pdf");
  writeFileSync(file, await pdf.save({ useObjectStreams: false }));

  const { doc, pages } = await loadSource(file);
  const { runs } = await getPageText(doc, pages[0]);
  const run = runs.find((r) => r.text.includes("Resume"));
  assert.ok(run?.editable, runs.map((r) => `${r.text}:${r.reason}`).join(" / "));
  const e = createTextEdit([run], { cover: "#ffffff", fallbackColor: "#000000" });
  e.text = "Résumé du projet français.";
  const how: string[] = [];
  const bytes = await buildPdf([{ ...pages[0], objects: [e] }], new Map([[doc.id, doc]]), new Map(), { onEditPath: (h) => how.push(h) });
  writeFileSync(join(outDir, "php-style-font-edited.pdf"), bytes);
  // フォントに無い字を含む語は同梱フォントで書く（元のフォントで書くと、その字だけ空白になる）
  assert.deepEqual(how, ["anchored-mixed"]);
  const out = await openPdf(bytes);
  assert.ok((await pageText(out, 1)).includes("Résumé du projet français."));
  // 書き換えた内容に、前の命令とつながった無効な命令（TfET など）が無い
  const lib = await PDFDocument.load(bytes);
  const contents = lib.getPage(0).node.Contents();
  const stream = lib.context.lookup(contents instanceof PDFArray ? contents.get(0) : contents) as PDFRawStream;
  const content = Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1");
  assert.ok(!/Tf(ET|q|BT)/.test(content), content.slice(0, 200));
  // 同梱フォントで書く語が空白を挟んで続くとき、その空白も同梱フォントの字形で書かれ、文字として取り出せる
  // （空白の字形が埋め込まれていないと、豆腐（.notdef）になり、後ろの字と重なる）
  const e3 = createTextEdit([run], { cover: "#ffffff", fallbackColor: "#000000" });
  e3.text = "R\u00e9sum\u00e9 \u00e9lev\u00e9 du projet francais.";
  const bytes3 = await buildPdf([{ ...pages[0], objects: [e3] }], new Map([[doc.id, doc]]), new Map(), {});
  const text3 = await pageText(await openPdf(bytes3), 1);
  assert.ok(text3.includes("R\u00e9sum\u00e9 \u00e9lev\u00e9 du projet francais."), JSON.stringify(text3));
  // 元のフォントにある字だけの書き換えは、元のフォントのまま
  const e2 = createTextEdit([run], { cover: "#ffffff", fallbackColor: "#000000" });
  e2.text = "Resume du projet.";
  const how2: string[] = [];
  await buildPdf([{ ...pages[0], objects: [e2] }], new Map([[doc.id, doc]]), new Map(), { onEditPath: (h) => how2.push(h) });
  assert.ok(how2[0] === "anchored" || how2[0] === "in-place", how2.join());
});

test("1 行の中の離れた 2 か所を変えたとき、変えた語だけが書き直され、間の語は元の字形のまま", async () => {
  assert.deepEqual(wordHunks("Resume du projet francais.", "Résumé du projet français."), [
    { p: 0, e: 6, bp: 0, be: 6 },
    { p: 17, e: 25, bp: 17, be: 25 },
  ]);
  // 1 か所だけの変更・空白だけを挟んで隣り合う変更は、まとめて 1 か所（null）
  assert.equal(wordHunks("one two three", "one 2 three"), null);
  assert.equal(wordHunks("one two three", "1 2 three"), null);
  // 和文は 1 字単位で比べる
  assert.deepEqual(wordHunks("令和元年度の予算案", "令和二年度の決算案"), [
    { p: 2, e: 3, bp: 2, be: 3 },
    { p: 6, e: 7, bp: 6, be: 7 },
  ]);

  const { doc, pages } = await loadSource(join(fixtures, "en-standard14.pdf"));
  const { runs } = await getPageText(doc, pages[0]);
  const run = runs.find((r) => r.text.includes("Revenue grew"))!;
  const e = createTextEdit([run], { cover: "#ffffff", fallbackColor: "#000000" });
  e.text = run.text.replace("Revenue", "Income").replace("last", "this");
  const how: string[] = [];
  const bytes = await buildPdf([{ ...pages[0], objects: [e] }], new Map([[doc.id, doc]]), new Map(), { onEditPath: (h) => how.push(h) });
  assert.deepEqual(how, ["anchored"]);
  const out = await openPdf(bytes);
  assert.ok((await pageText(out, 1)).includes(e.text), await pageText(out, 1));
  // 間の語（grew by 12 percent compared to）は、命令の中の字の並びが元のまま残っている（1 字ずつ組み直していない）
  const lib = await PDFDocument.load(bytes);
  const contents = lib.getPage(0).node.Contents();
  const all = (contents instanceof PDFArray ? contents.asArray() : [contents])
    .map((r) => lib.context.lookup(r))
    .filter((s): s is PDFRawStream => s instanceof PDFRawStream)
    .map((s) => Buffer.from(decodePDFRawStream(s).decode()).toString("latin1"))
    .join("\n");
  const hexOf = (t: string) => Buffer.from(t, "latin1").toString("hex");
  assert.ok(all.includes(hexOf("grew by 12 percent compared to")) || all.includes("grew by 12 percent compared to"), "間の語が組み直されている");
});

test("ja-nonembedded-wide-space.pdf：字幅の分からないフォントの半角スペースは、行の文字列でも半角スペースのまま（全角にしない）", async () => {
  // 埋め込みの無い和文フォント（字幅の指定なし＝どの字も 1 字分）で「文書 ページ」。半角スペースも 1 字分の幅で置かれる
  const { doc, pages } = await loadSource(join(fixtures, "ja-nonembedded-wide-space.pdf"));
  const { runs } = await getPageText(doc, pages[0]);
  assert.deepEqual(
    runs.map((r) => r.text),
    ["文書 ページ"],
  );
});

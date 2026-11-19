// 墨消し：縦書きの列、幅の分からないフォント、保存後の確かめ（範囲に字が残っていれば「確認できた」と言わない）、
// インライン画像の画素数
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PDFHexString, PDFName, PDFString } from "pdf-lib";
import { tokenizeContent } from "@/lib/contentStream";
import { buildPdf } from "@/lib/exportPdf";
import { apply } from "@/lib/geometry";
import { textInRects } from "@/lib/redactCheck";
import type { PageItem, RedactObj } from "@/lib/types";
import { fixtures, loadSource, openPdf, pageText, renderPage } from "./helpers";

/** PDF 座標の矩形 [x0, y0, x1, y1] を、墨消しの部品（表示座標）にする */
const redactAt = (p: PageItem, [x0, y0, x1, y1]: number[]): RedactObj => {
  const [a, b] = [apply(p.viewTransform, x0, y1), apply(p.viewTransform, x1, y0)];
  return { id: "r", type: "redact", x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]), fill: "#000000" };
};
const flat = (s: string) => s.replace(/\s+/g, "");

test("縦書きの列を墨消しすると、その列の字だけが消え、隣の列は残る", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "ja-vertical.pdf"));
  let check: { verified: number; unverified: number[] } | null = null;
  const bytes = await buildPdf([{ ...pages[0], objects: [redactAt(pages[0], [474, 560, 496, 715])] }], new Map([[doc.id, doc]]), new Map(), {
    onRedactCheck: (r) => (check = r),
  });
  const after = flat(await pageText(await openPdf(bytes), 1));
  assert.ok(!after.includes("十二回") && !after.includes("会議"), after);
  assert.ok(after.includes("縦書きの段落です。") && after.includes("二〇二六年に開く。"), after);
  assert.deepEqual(check, { pages: 1, verified: 1, unverified: [] });
});

test("幅の分からないフォントの字は、範囲が行の途中だけでも残さない", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "ja-nonembedded-rksj.pdf"));
  const before = flat(await pageText(await openPdf(doc.bytes), 1));
  assert.ok(before.includes("タスト"));
  const bytes = await buildPdf([{ ...pages[0], objects: [redactAt(pages[0], [113, 755, 160, 775])] }], new Map([[doc.id, doc]]), new Map());
  assert.ok(!flat(await pageText(await openPdf(bytes), 1)).includes("タスト"));
});

test("保存後の確かめ：範囲の中に字が残っていれば見つける（縁にかかるだけの隣の字は数えない）", async () => {
  const pdf = await openPdf(new Uint8Array(readFileSync(join(fixtures, "ja-vertical.pdf"))));
  const c = await (await pdf.getPage(1)).getTextContent();
  const runs = c.items.flatMap((it) => ("str" in it ? [{ str: it.str, transform: it.transform as number[], width: it.width, height: it.height, dir: it.dir }] : []));
  // 真ん中の列の上に掛けた範囲：その列の字が見つかる
  assert.ok(textInRects(runs, [{ x0: 474, y0: 560, x1: 496, y1: 715 }]).join("").includes("十二"));
  // 列と列のあいだの細い範囲：どの字も中に入らない
  assert.deepEqual(textInRects(runs, [{ x0: 492.5, y0: 560, x1: 499.5, y1: 715 }]), []);
});

test("インライン画像の画素数を読む", () => {
  const s = "q 10 0 0 10 0 0 cm BI /W 16 /H 8 /BPC 8 /CS /G ID \x01\x02\x03 EI Q BI /Width 3 /Height 2 /ImageMask true ID \x00\x00 EI";
  const ops = tokenizeContent(new Uint8Array([...s].map((ch) => ch.charCodeAt(0))));
  assert.deepEqual(
    ops.filter((o) => o.op === "BI").map((o) => o.inlineSize),
    [
      [16, 8],
      [3, 2],
    ],
  );
});

test("墨消しの後始末（使われなくなった字をフォントから除く）で、残りの文字の見た目は変わらない", async () => {
  // どの試験用 PDF でも：ページの隅（何も無い所）を墨消しして保存し、元のページと見比べる。
  // フォントの対応表・幅・字の形を触るので、使っている字まで欠けていないかをここで確かめる
  const { readdirSync } = await import("node:fs");
  const skip = /^(aes|rc4|encrypted|signed)/;
  let checked = 0;
  for (const f of readdirSync(fixtures).filter((n) => n.endsWith(".pdf") && !skip.test(n))) {
    let loaded;
    try {
      loaded = await loadSource(join(fixtures, f));
    } catch {
      continue; // パスワード付きなど、そのままでは開けないもの
    }
    const { doc, pages } = loaded;
    const p = pages[0];
    const r: RedactObj = { id: "r", type: "redact", x: 0, y: 0, w: 2, h: 2, fill: "#ffffff" };
    const bytes = await buildPdf([{ ...p, objects: [r] }], new Map([[doc.id, doc]]), new Map());
    const a = await renderPage(await openPdf(doc.bytes), p.srcIndex + 1, 1.5);
    const b = await renderPage(await openPdf(bytes), 1, 1.5);
    assert.equal(a.width, b.width, f);
    let diff = 0;
    for (let i = 0; i < a.data.length; i += 4) if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 60) diff++;
    assert.ok(diff <= 30, `${f}: 見た目が変わった（${diff} 画素）`);
    // 文字も同じだけ取り出せる
    assert.equal(flat(await pageText(await openPdf(bytes), 1)), flat(await pageText(await openPdf(doc.bytes), p.srcIndex + 1)), f);
    checked++;
  }
  assert.ok(checked >= 20, `調べた数が少ない（${checked}）`);
});

/** 試験用：Helvetica の文字を、内容ストリームを直接書いて置いた 1 ページの PDF を作って読み込む */
async function handBuilt(build: (d: import("pdf-lib").PDFDocument, page: import("pdf-lib").PDFPage, font: import("pdf-lib").PDFRef) => string | void) {
  const { PDFDocument, PDFName, StandardFonts } = await import("pdf-lib");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const d = await PDFDocument.create();
  const page = d.addPage([300, 300]);
  const font = d.embedStandardFont(StandardFonts.Helvetica);
  page.node.set(PDFName.of("Resources"), d.context.obj({ Font: { F1: font.ref } }));
  const content = build(d, page, font.ref) ?? "BT /F1 12 Tf 20 250 Td (KEEP this line) Tj ET\nBT /F1 12 Tf 20 200 Td (SECRETXQ) Tj ET";
  page.node.set(PDFName.of("Contents"), d.context.register(d.context.stream(content)));
  const file = join(mkdtempSync(join(tmpdir(), "washi-redact-")), "t.pdf");
  writeFileSync(file, await d.save({ useObjectStreams: false }));
  return loadSource(file);
}
/** 保存した PDF の中の、すべての文字列とストリームの中身をつないだもの（消した語が残っていないかを見る） */
async function everything(bytes: Uint8Array): Promise<string> {
  const { PDFDocument, PDFDict, PDFString, PDFHexString, PDFStream } = await import("pdf-lib");
  const { decodeStreamBytes } = await import("@/lib/pdfFontInfo");
  const d = await PDFDocument.load(bytes);
  let out = "";
  const visit = (o: unknown) => {
    if (o instanceof PDFString || o instanceof PDFHexString) out += `${o.decodeText()}\n`;
    else if (o instanceof PDFDict) for (const [, v] of o.entries()) visit(v);
    else if (o && typeof o === "object" && "asArray" in o) for (const v of (o as { asArray(): unknown[] }).asArray()) visit(v);
  };
  for (const [, o] of d.context.enumerateIndirectObjects()) {
    if (o instanceof PDFStream) {
      visit(o.dict);
      try {
        const b = decodeStreamBytes(d, o);
        if (b) out += `${Buffer.from(b).toString("latin1")}\n`;
      } catch {
        /* 画像など */
      }
    } else visit(o);
  }
  return out;
}
// 「SECRETXQ」の行（y=200）を囲む範囲
const SECRET_BOX = [15, 195, 120, 215];

test("消した字を囲む読み・説明（/ActualText）も、ファイルから消える", async () => {
  for (const variant of ["inline", "named"] as const) {
    const { doc, pages } = await handBuilt((d, page, font) => {
      if (variant === "named") page.node.set(PDFName.of("Resources"), d.context.obj({ Font: { F1: font }, Properties: { MC0: { ActualText: PDFHexString.fromText("Taro Yamada"), Alt: PDFHexString.fromText("Taro Yamada") } } }));
      const span = variant === "named" ? "/Span /MC0 BDC" : "/Span <</ActualText (Taro Yamada)>> BDC";
      return `BT /F1 12 Tf 20 250 Td (KEEP this line) Tj ET\n${span}\nBT /F1 12 Tf 20 200 Td (SECRETXQ) Tj ET\nEMC`;
    });
    const bytes = await buildPdf([{ ...pages[0], objects: [redactAt(pages[0], SECRET_BOX)] }], new Map([[doc.id, doc]]), new Map());
    const all = await everything(bytes);
    assert.ok(!all.includes("Taro Yamada") && !all.includes("SECRETXQ"), `${variant}: 読みが残っている`);
    assert.ok(all.includes("KEEP this line"));
  }
});

test("墨消ししたページの縮小画像・編集用データは外し、消した字だけに使っていたフォントは残さない", async () => {
  const { doc, pages } = await handBuilt((d, page, font) => {
    const secretFont = d.context.register(d.context.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Courier", Encoding: { Type: "Encoding", Differences: [65, "SECRETGLYPHNAME"] } }));
    page.node.set(PDFName.of("Resources"), d.context.obj({ Font: { F1: font, "F two": secretFont, "F#3": font } }));
    page.node.set(PDFName.of("Thumb"), d.context.register(d.context.stream("THUMBDATA", { Type: "XObject", Subtype: "Image", Width: 1, Height: 1, ColorSpace: "DeviceGray", BitsPerComponent: 8 })));
    page.node.set(PDFName.of("PieceInfo"), d.context.obj({ App: { Private: PDFHexString.fromText("PIECEINFO-SECRET") } }));
    // 名前に空白や「#」を含むフォント（内容の中では #20・#23 と書く）
    return "BT /F1 12 Tf 20 250 Td (KEEP this line) Tj ET\nBT /F#20two 12 Tf 20 200 Td (SECRETXQ) Tj ET\nBT /F#233 12 Tf 150 250 Td (ALSO kept) Tj ET";
  });
  const bytes = await buildPdf([{ ...pages[0], objects: [redactAt(pages[0], SECRET_BOX)] }], new Map([[doc.id, doc]]), new Map());
  const all = await everything(bytes);
  for (const w of ["SECRETXQ", "THUMBDATA", "PIECEINFO-SECRET", "SECRETGLYPHNAME"]) assert.ok(!all.includes(w), `${w} が残っている`);
  const text = flat(await pageText(await openPdf(bytes), 1));
  assert.ok(text.includes("KEEPthisline") && text.includes("ALSOkept"), text);
});

test("墨消しの範囲に掛かる、足した部品：リンクは外し、すっかり入る文字は書かず、一部だけ掛かる文字は保存を止める", async () => {
  const { doc, pages } = await handBuilt(() => undefined);
  const p = pages[0];
  const red = redactAt(p, SECRET_BOX);
  const link = { id: "l", type: "link" as const, x: red.x + 5, y: red.y + 2, w: 40, h: 10, target: { kind: "url" as const, url: "https://secret.example/token" } };
  const inner = { id: "t", type: "text" as const, x: red.x + 5, y: red.y + 2, w: 60, h: 14, text: "INNERTEXT", font: "gothic" as const, fontSize: 10, color: "#000000", rotation: 0 };
  const bytes = await buildPdf([{ ...p, objects: [link, inner as never, red] }], new Map([[doc.id, doc]]), new Map());
  const all = await everything(bytes);
  assert.ok(!all.includes("secret.example"), "リンクの行き先が残っている");
  assert.ok(!flat(await pageText(await openPdf(bytes), 1)).includes("INNERTEXT"), "範囲に入る文字が書かれている");
  // 一部だけ掛かる文字（墨消しより下）：保存を止める
  const partial = { ...inner, x: red.x + red.w - 20, w: 80, text: "HALFCOVERED" };
  await assert.rejects(buildPdf([{ ...p, objects: [partial as never, red] }], new Map([[doc.id, doc]]), new Map()), /HALFCOVERED/);
  // 墨消しより上に置いた文字（あとから足した説明など）は、そのまま書く
  const above = await buildPdf([{ ...p, objects: [red, partial as never] }], new Map([[doc.id, doc]]), new Map());
  assert.ok(flat(await pageText(await openPdf(above), 1)).includes("HALFCOVERED"));
});

test("元の PDF の JavaScript と外部プログラムの起動は、保存で外す", async () => {
  const { doc, pages } = await handBuilt((d, page) => {
    const js = (code: string) => d.context.obj({ S: "JavaScript", JS: PDFString.of(code) });
    page.node.set(PDFName.of("AA"), d.context.obj({ O: js("app.alert(1)") }));
    const link = d.context.register(d.context.obj({ Type: "Annot", Subtype: "Link", Rect: [10, 10, 50, 30], A: js("app.alert(2)") }));
    const launch = d.context.register(d.context.obj({ Type: "Annot", Subtype: "Link", Rect: [60, 10, 90, 30], A: { S: "Launch", F: PDFString.of("calc.exe") } }));
    const ok = d.context.register(d.context.obj({ Type: "Annot", Subtype: "Link", Rect: [100, 10, 140, 30], A: { S: "URI", URI: PDFString.of("https://ok.example/") } }));
    page.node.set(PDFName.of("Annots"), d.context.obj([link, launch, ok]));
  });
  const all = await everything(await buildPdf([{ ...pages[0], objects: [] }], new Map([[doc.id, doc]]), new Map()));
  assert.ok(!all.includes("app.alert") && !all.includes("calc.exe"), "動作が残っている");
  assert.ok(all.includes("https://ok.example/"), "ふつうのリンクまで消えた");
});

test("グラフィック状態（gs）でフォントを指定した文字も、そのフォントの幅で位置を決めて消す", async () => {
  // Tf で幅の広いフォント（Courier）を選んだあと、gs で Helvetica に切り替えてから文字を書く PDF。
  // gs のフォント指定を見落とすと、Courier の幅で位置を数えて、別の字を消してしまう
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const { loadPdfFile } = await import("@/lib/loader");
  const d = await PDFDocument.create();
  const page = d.addPage([400, 200]);
  const helv = await d.embedFont(StandardFonts.Helvetica);
  const cour = await d.embedFont(StandardFonts.Courier);
  const ctx = d.context;
  page.node.set(PDFName.of("Resources"), ctx.obj({ Font: { F1: cour.ref }, ExtGState: { G1: { Type: "ExtGState", Font: [helv.ref, 12] } } }));
  // 幅の狭い字（i・l）を前後に置く：Courier の幅で数えると、位置が大きくずれる
  const text = "iiii SECRET llll";
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(`BT /F1 12 Tf /G1 gs 50 100 Td (${text}) Tj ET`)));
  const bytes0 = await d.save();
  const fake = { name: "gs.pdf", type: "application/pdf", arrayBuffer: async () => bytes0.buffer.slice(bytes0.byteOffset, bytes0.byteOffset + bytes0.byteLength) } as unknown as File;
  const { doc, pages } = await loadPdfFile(fake);
  const x0 = 50 + helv.widthOfTextAtSize("iiii ", 12);
  const x1 = x0 + helv.widthOfTextAtSize("SECRET", 12);
  const out = await buildPdf([{ ...pages[0], objects: [redactAt(pages[0], [x0 + 0.5, 96, x1 - 0.5, 112])] }], new Map([[doc.id, doc]]), new Map());
  const after = await pageText(await openPdf(out), 1);
  assert.ok(!/[SECRT]/.test(after), after);
  assert.ok(after.includes("iiii") && after.includes("llll"), after);
});

/** pdf-lib で作った PDF を、アプリと同じ読み込みの経路で開く */
async function loadBytes(bytes0: Uint8Array, name = "t.pdf") {
  const { loadPdfFile } = await import("@/lib/loader");
  const fake = { name, type: "application/pdf", arrayBuffer: async () => bytes0.buffer.slice(bytes0.byteOffset, bytes0.byteOffset + bytes0.byteLength) } as unknown as File;
  return loadPdfFile(fake);
}

test("単位の大きいページ（UserUnit 2）でも、墨消しの塗りは範囲の大きさで描かれ、範囲の外は変わらない", async () => {
  const { PDFDocument, StandardFonts, PDFNumber } = await import("pdf-lib");
  const d = await PDFDocument.create();
  const page = d.addPage([300, 200]);
  page.node.set(PDFName.of("UserUnit"), PDFNumber.of(2));
  const helv = await d.embedFont(StandardFonts.Helvetica);
  page.drawText("ALPHA BRAVO CHARLIE", { x: 20, y: 100, size: 12, font: helv });
  const b0 = await d.save();
  const { doc, pages } = await loadBytes(b0);
  const x0 = 20 + helv.widthOfTextAtSize("ALPHA ", 12);
  const x1 = x0 + helv.widthOfTextAtSize("BRAVO", 12);
  const r = redactAt(pages[0], [x0, 97, x1, 112]);
  const out = await buildPdf([{ ...pages[0], objects: [r] }], new Map([[doc.id, doc]]), new Map());
  const text = flat(await pageText(await openPdf(out), 1));
  assert.ok(!text.includes("BRAVO") && text.includes("ALPHA") && text.includes("CHARLIE"), text);
  const a = await renderPage(await openPdf(b0), 1, 1);
  const b = await renderPage(await openPdf(out), 1, 1);
  const { diffOutside } = await import("./helpers");
  // 表示座標（UserUnit 込み）で、範囲の外は変わらない
  const { changed } = diffOutside(a, b, [{ x: r.x, y: r.y, w: r.w, h: r.h }], 1);
  assert.ok(changed < 20, `範囲の外で ${changed} 画素が変わった`);
});

test("配列に直接書いた注釈も、範囲の下にあれば外す。縁が触れるだけの注釈は残す", async () => {
  const { PDFDocument, StandardFonts, PDFString, PDFArray } = await import("pdf-lib");
  const d = await PDFDocument.create();
  const page = d.addPage([400, 300]);
  const helv = await d.embedFont(StandardFonts.Helvetica);
  page.drawText("KEEP SECRETXQ KEEP", { x: 100, y: 200, size: 12, font: helv });
  const ctx = d.context;
  const x0 = 100 + helv.widthOfTextAtSize("KEEP ", 12);
  const x1 = x0 + helv.widthOfTextAtSize("SECRETXQ", 12);
  page.node.set(
    PDFName.of("Annots"),
    ctx.obj([
      { Type: "Annot", Subtype: "Text", Rect: [x0 + 2, 200, x0 + 20, 212], Contents: PDFString.of("NOTESECRET inline") },
      { Type: "Annot", Subtype: "Text", Rect: [x0 + 2, 180, x0 + 20, 197.6], Contents: PDFString.of("touching note stays") },
    ]),
  );
  const { doc, pages } = await loadBytes(await d.save());
  const out = await buildPdf([{ ...pages[0], objects: [redactAt(pages[0], [x0, 197, x1, 213])] }], new Map([[doc.id, doc]]), new Map());
  const { PDFDocument: D2 } = await import("pdf-lib");
  const saved = await D2.load(out);
  const annots = saved.getPage(0).node.Annots();
  const texts = (annots instanceof PDFArray ? annots.asArray() : []).map((a) => String((saved.context.lookup(a) as unknown as { get(n: unknown): unknown }).get(PDFName.of("Contents"))));
  assert.ok(!texts.some((t) => t.includes("NOTESECRET")), texts.join(" / "));
  assert.ok(texts.some((t) => t.includes("touching")), texts.join(" / "));
});

test("Type3 フォントの行を消すと、使われなくなった字の形・名前・対応表もフォントから外れる", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "rtl-libreoffice-type3-he.pdf"));
  const pdf = await openPdf(doc.bytes);
  const c = await (await pdf.getPage(1)).getTextContent();
  const item = c.items.find((it) => "str" in it && it.str.includes("רשמית")) as { transform: number[]; width: number; height: number } | undefined;
  assert.ok(item, "見出しの行が見つからない");
  const [, , , , x, y] = item.transform;
  const { PDFDocument, PDFDict, PDFRawStream, decodePDFRawStream } = await import("pdf-lib");
  const procsCount = async (bytes: Uint8Array) => {
    const dd = await PDFDocument.load(bytes);
    let n = 0;
    let uni = "";
    for (const [, o] of dd.context.enumerateIndirectObjects()) {
      if (!(o instanceof PDFDict) || String(o.get(PDFName.of("Subtype"))) !== "/Type3") continue;
      const p = o.lookup(PDFName.of("CharProcs"));
      if (p instanceof PDFDict) n += p.entries().length;
      const tu = o.lookup(PDFName.of("ToUnicode"));
      if (tu instanceof PDFRawStream) uni += new TextDecoder("latin1").decode(decodePDFRawStream(tu).decode());
    }
    return { n, uni };
  };
  const before = await procsCount(doc.bytes);
  const out = await buildPdf([{ ...pages[0], objects: [redactAt(pages[0], [x - 2, y - 4, x + item.width + 2, y + item.height + 2])] }], new Map([[doc.id, doc]]), new Map());
  const after = await procsCount(out);
  assert.ok(after.n < before.n, `字の形の数 ${before.n} → ${after.n}`);
  assert.ok(after.uni.length < before.uni.length, "対応表が小さくなっていない");
  // 消した行の文字だけでなく、残りの文字は読める
  assert.ok(flat(await pageText(await openPdf(out), 1)).includes("התערוכה"));
});

test("墨消しした語が、ページ番号のラベルやレイヤーの名前にあれば取り除く", async () => {
  const { PDFDocument, StandardFonts, PDFHexString } = await import("pdf-lib");
  const d = await PDFDocument.create();
  const page = d.addPage([400, 300]);
  const helv = await d.embedFont(StandardFonts.Helvetica);
  page.drawText("KEEP SECRETXQ KEEP", { x: 100, y: 200, size: 12, font: helv });
  const ctx = d.context;
  const ocg = ctx.register(ctx.obj({ Type: "OCG", Name: PDFHexString.fromText("Layer about SECRETXQ") }));
  d.catalog.set(PDFName.of("OCProperties"), ctx.obj({ OCGs: [ocg], D: { Order: [PDFHexString.fromText("Group SECRETXQ"), ocg] } }));
  d.catalog.set(PDFName.of("PageLabels"), ctx.obj({ Nums: [0, { S: "D", P: PDFHexString.fromText("SECRETXQ-") }] }));
  const { doc, pages } = await loadBytes(await d.save());
  const x0 = 100 + helv.widthOfTextAtSize("KEEP ", 12);
  const x1 = x0 + helv.widthOfTextAtSize("SECRETXQ", 12);
  const warnings: string[] = [];
  const out = await buildPdf([{ ...pages[0], objects: [redactAt(pages[0], [x0, 197, x1, 213])] }], new Map([[doc.id, doc]]), new Map(), { onWarning: (w) => warnings.push(w) });
  const raw = new TextDecoder("latin1").decode(out);
  const saved = await PDFDocument.load(out);
  const strings: string[] = [];
  const walk = (o: unknown, depth: number) => {
    if (depth > 8) return;
    const v = o && typeof o === "object" && "objectNumber" in (o as object) ? saved.context.lookup(o as never) : o;
    if (v instanceof PDFHexString) strings.push(v.decodeText());
    else if (v && typeof v === "object" && "asArray" in (v as object)) for (const x of (v as { asArray(): unknown[] }).asArray()) walk(x, depth + 1);
    else if (v && typeof v === "object" && "entries" in (v as object)) for (const [, x] of (v as { entries(): [unknown, unknown][] }).entries()) walk(x, depth + 1);
  };
  walk(saved.catalog.get(PDFName.of("OCProperties")), 0);
  walk(saved.catalog.get(PDFName.of("PageLabels")), 0);
  assert.ok(!strings.some((s) => s.includes("SECRETXQ")) && !raw.includes("SECRETXQ"), strings.join(" / "));
  assert.deepEqual(warnings, []);
});

test("別々の行を墨消ししても、語をつなげずに調べる（文書情報に残った語を見逃さない）", async () => {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const d = await PDFDocument.create();
  const page = d.addPage([400, 300]);
  const helv = await d.embedFont(StandardFonts.Helvetica);
  page.drawText("ALPHA", { x: 50, y: 200, size: 12, font: helv });
  page.drawText("BRAVO", { x: 50, y: 180, size: 12, font: helv });
  d.setTitle("BRAVO report");
  const { doc, pages } = await loadBytes(await d.save());
  const warnings: string[] = [];
  const leftovers: string[] = [];
  await buildPdf([{ ...pages[0], objects: [redactAt(pages[0], [45, 175, 120, 215])] }], new Map([[doc.id, doc]]), new Map(), {
    onWarning: (w) => warnings.push(w),
    onLeftover: (m) => leftovers.push(m),
  });
  assert.ok(warnings.some((w) => w.includes("BRAVO")), warnings.join(" / "));
  assert.ok(leftovers.some((w) => w.includes("BRAVO")), "保存の前に確かめるための知らせが無い");
});

test("元のリンクの javascript:・file: のアドレスと、ほかのファイルを開く動作は、保存のときに外す", async () => {
  const { PDFDocument, PDFString, PDFArray, PDFDict } = await import("pdf-lib");
  const d = await PDFDocument.create();
  const page = d.addPage([400, 300]);
  const ctx = d.context;
  const link = (a: Record<string, unknown>, y: number) => ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [50, y, 150, y + 20], A: a } as never));
  page.node.set(
    PDFName.of("Annots"),
    ctx.obj([
      link({ S: "URI", URI: PDFString.of("javascript:alert(1)") }, 200),
      link({ S: "URI", URI: PDFString.of("file:///etc/passwd") }, 170),
      link({ S: "GoToR", F: PDFString.of("http://127.0.0.1/x.pdf"), D: [0, "/Fit"] }, 140),
      link({ S: "URI", URI: PDFString.of("https://example.com/") }, 110),
    ]),
  );
  const { doc, pages } = await loadBytes(await d.save());
  const out = await buildPdf(pages, new Map([[doc.id, doc]]), new Map());
  const saved = await PDFDocument.load(out);
  const annots = saved.getPage(0).node.Annots();
  const actions = (annots instanceof PDFArray ? annots.asArray() : []).map((r) => {
    const a = (saved.context.lookup(r) as unknown as { lookup(n: unknown): unknown }).lookup(PDFName.of("A"));
    return a instanceof PDFDict ? `${a.get(PDFName.of("S"))} ${a.lookup(PDFName.of("URI")) ?? ""}` : "none";
  });
  assert.deepEqual(actions.filter((a) => a !== "none"), ["/URI (https://example.com/)"]);
});

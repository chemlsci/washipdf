import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { PDFDocument, PDFName, PDFString, rgb } from "pdf-lib";
import { listAnnotations, sourceKind } from "@/lib/annotList";
import { defaultSettings, renderTemplate, visibleRect } from "@/lib/docOps";
import { EXPIRE_MS, isExpired } from "@/lib/draft";
import { buildPdf } from "@/lib/exportPdf";
import { safeFileName, uniqueFileName } from "@/lib/fileName";
import { fillForm, readFormFields } from "@/lib/forms";
import { type Key, translate } from "@/lib/i18n";
import { defaultImpose, flattenAnnotations, imposePdf } from "@/lib/impose";
import { clamp, clampInt } from "@/lib/limits";
import { checkOutput } from "@/lib/outputCheck";
import { fitImageToPaper, PAPER_SIZES, resizeTarget } from "@/lib/pageOps";
import { pdfFileName } from "@/lib/saveTargets";
import { defaultSecurity } from "@/lib/security";
import type { MarkupObj, PageItem, SourceDoc } from "@/lib/types";
import { createZip } from "@/lib/zip";
import { fixtures, loadSource, openPdf, renderPage, setupFonts } from "./helpers";

/* ---------- 文書から来た文字列で、普通のオブジェクトを引かない ---------- */

test("注釈の種類：constructor・toString・__proto__ などの名前でも、関数を拾わない", async () => {
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", ""]) assert.equal(sourceKind(name), undefined, name);
  assert.equal(sourceKind("Highlight"), "tool.highlight");
  assert.equal(sourceKind(undefined), undefined);
  assert.equal(sourceKind({ toString: () => "Highlight" }), undefined);
  // 注釈の一覧：種類・矩形・本文が変な値でも、例外にならず、文言のキーは必ず文字列
  const annots = [
    { subtype: "constructor", rect: [0, 0, 10, 10] },
    { subtype: "toString", rect: [0, 0, 10, 10] },
    { subtype: "__proto__", rect: [0, 0, 10, 10] },
    { subtype: "Highlight", rect: [10, 10, 50, 20], contentsObj: { str: "ok" }, titleObj: { str: "author" }, id: "1R" },
    { subtype: "Text", rect: "not an array", contents: 5 },
    { subtype: "Ink", rect: [1, 2, "x", 4] },
    { subtype: "Square", rect: [0, 0, 5, 5], contentsObj: { str: { evil: true } }, titleObj: null },
  ];
  const src = { id: "s", name: "x.pdf", pageCount: 1, bytes: new Uint8Array(), pdf: { getPage: async () => ({ getAnnotations: async () => annots }) } } as unknown as SourceDoc;
  const page = { id: "p", srcId: "s", srcIndex: 0, width: 100, height: 100, viewTransform: [1, 0, 0, -1, 0, 100], objects: [], baseRotation: 0, extraRotation: 0 } as PageItem;
  const list = await listAnnotations([page], new Map([["s", src]]), true);
  assert.deepEqual(list.map((e) => e.kind), ["tool.highlight", "tool.rect"]);
  for (const e of list) {
    assert.equal(typeof e.kind, "string");
    assert.equal(typeof e.text, "string");
    assert.equal(typeof e.author, "string");
  }
  assert.equal(list[0].text, "ok");
});

test("文言：辞書に無いキーや、文字列でないものを渡されても、文字列を返す", () => {
  for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty", "no.such.key"]) {
    const s = translate("ja", key as Key, { n: 1 });
    assert.equal(typeof s, "string", key);
    assert.equal(s, key);
  }
  assert.equal(typeof translate("en", (() => 1) as unknown as Key), "string");
  assert.equal(typeof translate("en", undefined as unknown as Key), "string");
  assert.equal(translate("ja", "common.cancel"), "キャンセル");
});

test("フォーム入力：constructor という名前の欄に、関数の文字列が書き込まれない", async () => {
  setupFonts();
  const src = await PDFDocument.create();
  const page = src.addPage([300, 200]);
  const form = src.getForm();
  form.createTextField("constructor").addToPage(page, { x: 20, y: 120, width: 200, height: 20 });
  form.createTextField("toString").addToPage(page, { x: 20, y: 80, width: 200, height: 20 });
  form.createTextField("normal").addToPage(page, { x: 20, y: 40, width: 200, height: 20 });
  const out = await fillForm(await src.save(), { normal: "hello" }, false);
  const fields = await readFormFields(out);
  assert.deepEqual(Object.fromEntries(fields.map((f) => [f.name, f.value])), { constructor: "", toString: "", normal: "hello" });
});

/* ---------- 数値の上限・下限 ---------- */

test("数値を範囲に収める：数でない値・無限大・負の値", () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(clamp(1e99, 0, 10), 10);
  assert.equal(clamp(Number.NaN, 0, 10, 3), 3);
  assert.equal(clamp(Number.POSITIVE_INFINITY, 0, 10, 3), 3);
  assert.equal(clamp("7", 0, 10), 7);
  assert.equal(clamp("", 0, 10, 2), 2);
  assert.equal(clamp(null, 0, 10, 2), 2);
  assert.equal(clampInt(3.6, 0, 10), 4);
});

test("テンプレート：途方もない桁数のゼロ埋めでも、すぐに終わり、長さは上限まで", () => {
  const v = { n: 7, N: 12, p: 9, P: 20, file: "f", date: "2026-11-15" };
  const t0 = Date.now();
  const s = renderTemplate("{n:999999999}{p:99999999999999999999}", v);
  assert.ok(Date.now() - t0 < 200);
  assert.equal(s.length, 40);
  assert.equal(renderTemplate("{n:6}", v), "000007");
});

test("画像から PDF：大きすぎる余白・画像でも、ページと画像の大きさが正の有限の値になる", () => {
  const a4 = PAPER_SIZES.find((p) => p.id === "A4")!;
  for (const margin of [0, 28, 1e9, -50, Number.NaN]) {
    const f = fitImageToPaper(800, 600, a4, margin);
    assert.ok(f.imgW > 0 && f.imgH > 0 && f.imgW <= f.w && f.imgH <= f.h, `${margin}: ${JSON.stringify(f)}`);
  }
  const big = fitImageToPaper(60000, 30000, null);
  assert.ok(big.w <= 14400 && big.h <= 14400 && Math.abs(big.w / big.h - 2) < 1e-6, JSON.stringify(big));
});

/* ---------- トリミングと、ページ番号・サイズ変更・面付け ---------- */

test("見えている範囲：トリミングと回転の組み合わせ", () => {
  const base = { width: 200, height: 300, crop: { x: 20, y: 30, w: 100, h: 150 } } as PageItem;
  assert.deepEqual(visibleRect({ ...base, extraRotation: 0 }), { x: 20, y: 30, w: 100, h: 150 });
  assert.deepEqual(visibleRect({ ...base, extraRotation: 90 }), { x: 300 - 30 - 150, y: 20, w: 150, h: 100 });
  assert.deepEqual(visibleRect({ ...base, extraRotation: 180 }), { x: 200 - 20 - 100, y: 300 - 30 - 150, w: 100, h: 150 });
  assert.deepEqual(visibleRect({ ...base, extraRotation: 270 }), { x: 30, y: 200 - 20 - 100, w: 150, h: 100 });
  assert.deepEqual(visibleRect({ ...base, crop: undefined, extraRotation: 90 }), { x: 0, y: 0, w: 300, h: 200 });
});

/** 保存した PDF の 1 ページ目で、指定の文字の位置（PDF の座標）を返す */
async function textAt(bytes: Uint8Array, needle: string): Promise<{ x: number; y: number }> {
  const pdf = await openPdf(bytes);
  const page = await pdf.getPage(1);
  const c = await page.getTextContent();
  const it = c.items.find((i) => "str" in i && i.str.includes(needle));
  assert.ok(it && "transform" in it, `「${needle}」が見つからない`);
  return { x: it.transform[4], y: it.transform[5] };
}

test("ページ番号・ヘッダー・フッター：トリミングしたページでは、見えている範囲の中に置かれる", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "ja-subset-identity.pdf"));
  const sources = new Map([[doc.id, doc]]);
  const p = pages[0];
  for (const extraRotation of [0, 90, 180, 270]) {
    const item: PageItem = { ...p, extraRotation, crop: { x: 120, y: 150, w: p.width - 300, h: p.height - 400 } };
    const settings = defaultSettings();
    settings.decor.numbering = { ...settings.decor.numbering, enabled: true, template: "NUM{n}", anchor: "bc" };
    settings.decor.header = { ...settings.decor.header, enabled: true, left: "HEADL", center: "", right: "HEADR" };
    settings.decor.footer = { ...settings.decor.footer, enabled: true, left: "FOOTL", center: "", right: "" };
    const bytes = await buildPdf([item], sources, new Map(), { settings });
    const crop = (await PDFDocument.load(bytes)).getPage(0).getCropBox();
    for (const word of ["NUM1", "HEADL", "HEADR", "FOOTL"]) {
      const at = await textAt(bytes, word);
      assert.ok(at.x >= crop.x - 1 && at.x <= crop.x + crop.width + 1 && at.y >= crop.y - 1 && at.y <= crop.y + crop.height + 1, `回転 ${extraRotation}：${word} が見えている範囲の外 ${JSON.stringify(at)} / ${JSON.stringify(crop)}`);
    }
  }
  // トリミングの無いページは、これまでどおりページ全体が基準
  const settings = defaultSettings();
  settings.decor.numbering = { ...settings.decor.numbering, enabled: true, template: "NUM{n}", anchor: "bc" };
  const at = await textAt(await buildPdf([p], sources, new Map(), { settings }), "NUM1");
  assert.ok(Math.abs(at.x - p.width / 2) < 30 && at.y < 60, JSON.stringify(at));
});

test("サイズ変更：トリミングしたページは、見えている範囲が用紙に収まる大きさになる", async () => {
  const a4 = PAPER_SIZES.find((x) => x.id === "A4")!;
  const p = { width: 600, height: 800, crop: { x: 100, y: 100, w: 300, h: 400 } } as PageItem;
  const to = resizeTarget(p, { paper: a4 });
  const k = to.width / p.width;
  assert.ok(Math.abs(to.height / p.height - k) < 1e-9, "縦横比が変わらない");
  const vw = p.crop!.w * k;
  const vh = p.crop!.h * k;
  assert.ok(vw <= a4.w + 0.01 && vh <= a4.h + 0.01, `用紙からはみ出す ${vw}×${vh}`);
  assert.ok(Math.abs(vw - a4.w) < 0.01 || Math.abs(vh - a4.h) < 0.01, `用紙いっぱいになっていない ${vw}×${vh}`);
  // トリミングが無ければ、ページ全体が基準
  const full = resizeTarget({ width: 600, height: 800 } as PageItem, { paper: a4 });
  assert.ok(Math.abs(full.width - a4.w) < 0.01 || Math.abs(full.height - a4.h) < 0.01);
  // 倍率の指定は範囲に収める
  assert.equal(resizeTarget({ width: 100, height: 100 } as PageItem, { percent: 1e9 }).width, 400);
  assert.equal(resizeTarget({ width: 100, height: 100 } as PageItem, { percent: Number.NaN }).width, 100);
  // 保存した PDF でも、見えている範囲（CropBox）が用紙に収まる
  const { doc, pages } = await loadSource(join(fixtures, "ja-subset-identity.pdf"));
  const src = { ...pages[0], crop: { x: 60, y: 80, w: pages[0].width / 2, h: pages[0].height / 2 } };
  const bytes = await buildPdf([{ ...src, scaleTo: resizeTarget(src, { paper: a4 }) }], new Map([[doc.id, doc]]), new Map());
  const cb = (await PDFDocument.load(bytes)).getPage(0).getCropBox();
  assert.ok(Math.abs(cb.width - a4.w) < 0.5 || Math.abs(cb.height - a4.h) < 0.5, JSON.stringify(cb));
});

const count = (img: { data: Uint8ClampedArray }, test: (r: number, g: number, b: number) => boolean) => {
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) if (test(img.data[i], img.data[i + 1], img.data[i + 2])) n++;
  return n;
};
const isRed = (r: number, g: number, b: number) => r > 200 && g < 70 && b < 70;
const isBlue = (r: number, g: number, b: number) => b > 200 && r < 70 && g < 70;
const isGreen = (r: number, g: number, b: number) => g > 150 && r < 90 && b < 90;

/** 赤（トリミングで切り落とす場所）・青（残る場所）の四角と、緑の注釈（外観つき）を持つ 2 ページの PDF */
async function croppedWithAnnotation(): Promise<Uint8Array> {
  const src = await PDFDocument.create();
  for (let i = 0; i < 2; i++) {
    const page = src.addPage([400, 400]);
    page.drawRectangle({ x: 0, y: 0, width: 100, height: 100, color: rgb(1, 0, 0) });
    page.drawRectangle({ x: 200, y: 200, width: 60, height: 60, color: rgb(0, 0, 1) });
    page.setCropBox(150, 150, 250, 250);
    const ap = src.context.register(src.context.stream("0 0.7 0 rg 0 0 50 50 re f", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 50, 50] }));
    const annot = src.context.register(src.context.obj({ Type: "Annot", Subtype: "Square", Rect: [300, 300, 350, 350], F: 4, Contents: PDFString.of("note"), AP: { N: ap } }));
    // 隠してある注釈・見た目の無い注釈は描き込まない
    const hidden = src.context.register(src.context.obj({ Type: "Annot", Subtype: "Square", Rect: [160, 160, 190, 190], F: 2, AP: { N: src.context.register(src.context.stream("1 0 0 rg 0 0 30 30 re f", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 30, 30] })) } }));
    const link = src.context.register(src.context.obj({ Type: "Annot", Subtype: "Link", Rect: [160, 300, 190, 330] }));
    page.node.set(PDFName.of("Annots"), src.context.obj([annot, hidden, link]));
  }
  return src.save();
}

test("面付け：トリミングした範囲だけを並べ、注釈は見た目のまま描き込む", async () => {
  const bytes = await croppedWithAnnotation();
  // 元の PDF：注釈は内容ではないので、描き込む前は数に入らない
  const probe = await PDFDocument.load(bytes);
  assert.equal(flattenAnnotations(probe), 2, "外観のある見えている注釈だけ（各ページ 1 つ）");
  const out = await imposePdf(bytes, { ...defaultImpose(), perSheet: 2, paper: "same", margin: 0, gap: 0 });
  const lib = await PDFDocument.load(out);
  assert.equal(lib.getPageCount(), 1);
  const size = lib.getPage(0).getSize();
  assert.ok(Math.abs(size.width - 250) < 0.5 && Math.abs(size.height - 250) < 0.5, `用紙「元と同じ」は見えている範囲の大きさ: ${JSON.stringify(size)}`);
  const img = await renderPage(await openPdf(out), 1, 2);
  assert.equal(count(img, isRed), 0, "切り落とした部分（赤）と、隠した注釈（赤）が出ていない");
  assert.ok(count(img, isBlue) > 500, "残した部分（青）がある");
  assert.ok(count(img, isGreen) > 300, "注釈（緑）が描き込まれている");
});

test("面付け：アプリで付けたハイライトが、面付けした PDF にも見える", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "ja-subset-identity.pdf"));
  const hl = { id: "h", type: "markup", kind: "highlight", x: 60, y: 60, w: 300, h: 60, color: "#00c000", opacity: 1, contents: "" } satisfies MarkupObj;
  const plain = await buildPdf([{ ...pages[0], objects: [] }], new Map([[doc.id, doc]]), new Map());
  const marked = await buildPdf([{ ...pages[0], objects: [hl] }], new Map([[doc.id, doc]]), new Map());
  const o = { ...defaultImpose(), perSheet: 2 as const };
  const before = count(await renderPage(await openPdf(await imposePdf(plain, o)), 1, 1), isGreen);
  const after = count(await renderPage(await openPdf(await imposePdf(marked, o)), 1, 1), isGreen);
  assert.ok(after > before + 200, `ハイライトが見えない（${before} → ${after}）`);
});

test("面付け：極端な余白・間隔・枚数でも、正しい PDF になる。保護を付けられる", async () => {
  const bytes = await croppedWithAnnotation();
  for (const o of [
    { margin: 1e9, gap: 1e9 },
    { margin: -100, gap: Number.NaN },
    { perSheet: 7 as unknown as 2 },
    { perSheet: 16 as const, margin: 400, gap: 400 },
  ]) {
    const out = await imposePdf(bytes, { ...defaultImpose(), ...o });
    assert.deepEqual(await checkOutput(out, 1), { ok: true }, JSON.stringify(o));
    await renderPage(await openPdf(out), 1, 0.5);
  }
  const security = { ...defaultSecurity(), enabled: true, userPassword: "ｐａｓｓ１２３" };
  const out = await imposePdf(bytes, defaultImpose(), security);
  await assert.rejects(openPdf(out), /password/i);
  assert.equal((await openPdf(out, "pass123")).numPages, 1);
  assert.deepEqual(await checkOutput(out, 1, security), { ok: true });
});

/* ---------- 保存する前の自己点検 ---------- */

test("保存前の点検：開き直せる PDF は通し、壊れた PDF・ページ数の違う PDF は通さない", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "ja-subset-identity.pdf"));
  const sources = new Map([[doc.id, doc]]);
  const bytes = await buildPdf(pages, sources, new Map());
  assert.deepEqual(await checkOutput(bytes, pages.length), { ok: true });
  assert.equal((await checkOutput(bytes, pages.length + 1)).ok, false, "ページ数が違う");
  assert.equal((await checkOutput(bytes.subarray(0, 200), pages.length)).ok, false, "途中で切れている");
  assert.equal((await checkOutput(new TextEncoder().encode("not a pdf at all"), 1)).ok, false, "PDF ではない");
  assert.equal((await checkOutput(new Uint8Array(0), 1)).ok, false, "空");
  // 点検しても、渡したバイト列はそのまま使える（書き込みに使うので）
  assert.equal(bytes.length > 1000 && bytes[0], 0x25);
  // パスワード保護つき（AES-256・RC4。全角のパスワードは NFKC にそろえて開く）
  for (const [method, userPassword] of [["aes256", "secret1"], ["aes256", "ｐａｓｓｗｏｒｄ＃１"], ["aes256", "パスワード"], ["rc4", "secret1"], ["aes256", ""]] as const) {
    const settings = defaultSettings();
    settings.security = { ...settings.security, enabled: true, method, userPassword, ownerPassword: userPassword ? "" : "owner-only" };
    const enc = await buildPdf(pages, sources, new Map(), { settings });
    assert.deepEqual(await checkOutput(enc, pages.length, settings.security), { ok: true }, `${method} ${userPassword}`);
    if (userPassword) assert.equal((await checkOutput(enc, pages.length, { ...settings.security, userPassword: "wrong" })).ok, false);
  }
});

/* ---------- ファイル名・ZIP ---------- */

test("ファイル名の無害化：区切り・制御文字・向きを変える文字・先頭の点・予約名・長さ", () => {
  assert.equal(safeFileName("../../etc/passwd"), "_.._etc_passwd");
  assert.equal(safeFileName("..\\..\\boot.ini"), "_.._boot.ini");
  assert.equal(safeFileName(".htaccess"), "htaccess");
  assert.equal(safeFileName("...."), "file");
  assert.equal(safeFileName("a\u0000b\nc\td.txt"), "a b c d.txt");
  assert.equal(safeFileName("invoice‮fdp.exe"), "invoicefdp.exe");
  assert.equal(safeFileName("x⁦y⁩z‏.pdf"), "xyz.pdf");
  assert.equal(safeFileName('a:b*c?d"e<f>g|h.txt'), "a_b_c_d_e_f_g_h.txt");
  assert.equal(safeFileName("CON"), "_CON");
  assert.equal(safeFileName("nul.txt"), "_nul.txt");
  assert.equal(safeFileName("com1.pdf"), "_com1.pdf");
  assert.equal(safeFileName("console.txt"), "console.txt");
  assert.equal(safeFileName("name. . "), "name");
  assert.equal(safeFileName("請求書（控え）.pdf"), "請求書（控え）.pdf");
  assert.equal(safeFileName(""), "file");
  assert.equal(safeFileName(undefined), "file");
  assert.equal(safeFileName({} as unknown), "file");
  const long = safeFileName("あ".repeat(500) + ".pdf");
  assert.equal([...long].length, 120);
  assert.ok(long.endsWith(".pdf"));
  assert.equal(safeFileName("a\ud83d.txt"), "a.txt", "壊れた文字（相手のいないサロゲート）は取り除く");
  assert.equal(safeFileName("😀.txt"), "😀.txt");
  // PDF の名前
  assert.equal(pdfFileName("report.pdf", "x"), "report.pdf");
  assert.equal(pdfFileName("  ", "fallback"), "fallback.pdf");
  assert.equal(pdfFileName("a/b‮.PDF", "x"), "a_b.pdf");
  // 重複
  const used = new Set<string>();
  assert.deepEqual(["a.pdf", "A.pdf", "a.pdf", "b"].map((n) => uniqueFileName(n, used)), ["a.pdf", "A (2).pdf", "a (3).pdf", "b"]);
});

/** ZIP の中のファイル名を読む（中央ディレクトリから） */
async function zipNames(blob: Blob): Promise<string[]> {
  const b = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(b.buffer);
  const names: string[] = [];
  for (let i = 0; i + 46 <= b.length; i++) {
    if (dv.getUint32(i, true) !== 0x02014b50) continue;
    const n = dv.getUint16(i + 28, true);
    names.push(new TextDecoder().decode(b.subarray(i + 46, i + 46 + n)));
    i += 45 + n;
  }
  return names;
}

test("ZIP：中のファイル名を無害化し、重複に連番を付け、上限を超えたら分かるエラーにする", async () => {
  const d = new Uint8Array([1, 2, 3]);
  const names = await zipNames(createZip([{ name: "../evil.pdf", data: d }, { name: "a.pdf", data: d }, { name: "a.pdf", data: d }, { name: "A.PDF", data: d }, { name: "", data: d }, { name: "x‮gpj.exe", data: d }]));
  assert.deepEqual(names, ["_evil.pdf", "a.pdf", "a (2).pdf", "A (3).PDF", "file5", "xgpj.exe"]);
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length);
  // 65,535 個を超える
  const many = Array.from({ length: 65536 }, (_, i) => ({ name: `f${i}`, data: new Uint8Array(0) }));
  assert.throws(() => createZip(many), /65,535/);
  // 4 GiB を超える（実際のデータは作らず、長さだけを大きく見せる）
  const huge = { length: 0x7fffffff } as unknown as Uint8Array;
  assert.throws(() => createZip([{ name: "a", data: huge }, { name: "b", data: huge }, { name: "c", data: huge }]), /4 GB/);
});

/* ---------- 下書きの期限 ---------- */

test("下書き：最後の自動保存から 7 日を過ぎたら古いものとして扱う", () => {
  const now = Date.UTC(2026, 10, 15);
  assert.equal(EXPIRE_MS, 7 * 24 * 3600 * 1000);
  assert.equal(isExpired(now - 1000, now), false);
  assert.equal(isExpired(now - EXPIRE_MS + 1000, now), false);
  assert.equal(isExpired(now - EXPIRE_MS - 1000, now), true);
  assert.equal(isExpired(Number.NaN, now), true);
  assert.equal(isExpired(now + EXPIRE_MS * 2, now), true, "時計が大きくずれた日時");
});

// 右から左へ書く文字（アラビア語・ヘブライ語）：行の組み立て、語の単位での書き換え、かっこの向き
//
// フィクスチャ rtl-chromium.pdf / rtl-libreoffice.pdf は、同じ HTML（ヘブライ語 3 行・アラビア語 3 行・英語の中にヘブライ語と
// アラビア語を混ぜた 1 行。フォントは DejaVu Sans、14pt）を、Chromium の印刷と LibreOffice の PDF 出力で作ったもの。
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { defaultSettings } from "@/lib/docOps";
import { createTextEdit } from "@/lib/editModel";
import { buildPdf } from "@/lib/exportPdf";
import { analyzePage } from "@/lib/libDoc";
import { isBoldFont } from "@/lib/pdfFontInfo";
import { ltrGroups, rtlLine, visualOrder, wordDiff, wordDirs } from "@/lib/rtl";
import { wordPieces } from "@/lib/rtlWrite";
import { shapeText } from "@/lib/shape";
import { actualTextOf } from "@/lib/textOps";
import { clearPageTextCache, getPageText } from "@/lib/textRuns";
import type { TextObj } from "@/lib/types";
import { diffOutside, fixtures, loadSource, openPdf, pageText, renderPage, root, setupFonts } from "./helpers";

setupFonts();
const outDir = join(root, "dist", ".test-out");
mkdirSync(outDir, { recursive: true });

const LINES = [
  "שלום עולם, זהו מסמך בדיקה מספר 2026.",
  "הטופס נשלח אל משרד הפנים בתאריך 12/03/2026 (יום חמישי).",
  "שם פרטי: דוד כהן — טלפון 050-1234567",
  "مرحبا بالعالم، هذه وثيقة اختبار رقم 2026.",
  "تم إرسال النموذج إلى وزارة الداخلية بتاريخ 12/03/2026 (الخميس).",
  "الاسم: محمد علي — البريد test@example.com",
  "English line with עברית and العربية inside.",
];

/** 字形の並び（表示順の文字列。空白は幅のある空白の字形）を、1 字 10pt 幅で左から並べる */
function glyphsOf(visual: string) {
  return [...visual].map((ch, i) => ({ text: ch, x0: i * 10, x1: i * 10 + 10 }));
}

test("行の組み立て：字形（表示順）から、読む順の文字列と語を作る", () => {
  // ヘブライ語 2 語：表示は「םלוע םולש」（左から右に並べた字形）
  const he = rtlLine(glyphsOf("םלוע םולש"), 10)!;
  assert.equal(he.text, "שלום עולם");
  assert.equal(he.base, "R");
  assert.deepEqual(he.words.map((w) => w.rtl), [true, true]);
  // 文末の数字：見た目は「.2026」で、読む順では「2026.」
  assert.equal(rtlLine(glyphsOf(".2026 םולש"), 10)!.text, "שלום 2026.");
  // 欧文の語句をかっこで囲んだもの：かっこは語句の両端に付いたまま（1 語ずつ反対側へ回さない）
  assert.equal(rtlLine(glyphsOf("(Low Income Clinic) םולש"), 10, undefined, { prior: "R" })!.text, "שלום (Low Income Clinic)");
  // 右から左の語をかっこで囲んだもの：表示されている形に関係なく、語の前が開く形・後ろが閉じる形
  assert.equal(rtlLine(glyphsOf("(םולש)"), 10)!.text, "(שלום)");
  assert.equal(rtlLine(glyphsOf(")םולש("), 10)!.text, "(שלום)");
  // 記号だけの語（—）は、行の向きに従う（前後の数字・欧文とひとまとまりにしない）
  assert.equal(rtlLine(glyphsOf("12 — םולש"), 10)!.text, "שלום — 12");
  // 左から右の行の中の、右から左の語の続き
  const en = rtlLine(glyphsOf("abc שדח תירבע def xyz"), 10)!;
  assert.equal(en.base, "L");
  assert.equal(en.text, "abc עברית חדש def xyz");
  // ページ全体が右から左なら、欧文の長い語句を含む行も右から左（片方の端が右から左の語）
  assert.equal(rtlLine(glyphsOf("(U.S. Court of Federal Claims) וא"), 10, undefined, { prior: "R" })!.text, "או (U.S. Court of Federal Claims)");
  // 何の字か分からない字形があれば、組み立てない
  assert.equal(rtlLine([...glyphsOf("םולש"), { text: "", x0: 50, x1: 60 }], 10), null);
});

test("行の組み立て：上下に付く記号と、字の部品だけの字形は、近い字に付ける", () => {
  // 幅ゼロの記号（ハムザ）が、付く字（右の ا）の左端から少しはみ出した位置にある
  const g = [
    { text: "و", x0: 0, x1: 4 },
    { text: "ٔ", x0: 3.9, x1: 3.9 },
    { text: "ا", x0: 4, x1: 6 },
  ];
  assert.equal(rtlLine(g, 10)!.text.normalize("NFC"), "أو");
  // 字の部品（幅ゼロの空白が割り当てられている）は、文字列に入れないが、語の字形には含める
  const parts = rtlLine([{ text: "ب", x0: 0, x1: 5 }, { text: "​", x0: 2, x1: 2 }, { text: "ا", x0: 5, x1: 7 }], 10)!;
  assert.equal(parts.text, "اب");
  assert.equal(parts.words[0].glyphs.length, 3);
});

test("語の向きと並び：記号だけの語、逆向きの語の続き", () => {
  assert.deepEqual(wordDirs(["שלום", "—", "12", "abc"], "R"), [true, true, false, false]);
  assert.deepEqual(wordDirs(["12", "—", "34"], "R"), [false, false, false]);
  // 右から左の行：読む順 [A, 12, 34, B] は、表示では B 12 34 A（数字の続きは左から右のまま）
  assert.deepEqual(visualOrder([false, true, true, false], "R"), [3, 1, 2, 0]);
  assert.deepEqual(visualOrder([false, true, true, false], "L"), [0, 2, 1, 3]);
  assert.deepEqual(wordDiff(["a", "b", "c"], ["a", "x", "c", "d"]), [
    { a0: 1, a1: 2, b0: 1, b1: 2 },
    { a0: 3, a1: 3, b0: 3, b1: 4 },
  ]);
});

test("整形：右から左の区間では、かっこを左右逆の形で書く。文字の対応は読む順のまま", () => {
  const open = shapeText("arabic", "(").glyphs[0].gid;
  const close = shapeText("arabic", ")").glyphs[0].gid;
  const s = shapeText("arabic", "(مرحبا)", "R");
  // 表示の左端は「(」の形（読む順では閉じかっこ）、右端は「)」の形（読む順では開きかっこ）
  assert.equal(s.glyphs[0].gid, open);
  assert.deepEqual(s.glyphs[0].cps, [0x29]);
  assert.equal(s.glyphs[s.glyphs.length - 1].gid, close);
  assert.deepEqual(s.glyphs[s.glyphs.length - 1].cps, [0x28]);
  // 数字を囲むかっこも同じ
  const n = shapeText("arabic", "(2026)", "R");
  assert.equal(n.glyphs[0].gid, open);
  assert.equal(n.glyphs[n.glyphs.length - 1].gid, close);
});

test("語の区間分け：ヘブライ文字の語に付いた句読点・かっこは欧文のフォント、並びは表示順", () => {
  const p = wordPieces("sans", "(שלום).", "R")!;
  assert.deepEqual(p.map((x) => x.text), [").", "שלום", "("]);
  assert.equal(p[1].key, "hebrew");
  assert.ok(p[0].key !== "hebrew" && p[0].key === p[2].key);
  assert.ok(p.every((x) => x.dir === "R"));
  // アラビア文字のフォントは数字・句読点も持つので、向きごとの区間だけに分かれる
  assert.deepEqual(wordPieces("sans", "(مرحبا)", "R")!.map((x) => [x.key, x.text]), [["arabic", "(مرحبا)"]]);
});

test("書き出し：ハムザ付きの字（أ）は、字と記号に分けて描いても 1 字として取り出せる", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "en-standard14.pdf"));
  const obj = { id: "a", type: "text", x: 40, y: 300, w: 400, h: 30, text: "أو إذا آخر", font: "arabic", fontSize: 18, color: "#000000", rotation: 0, align: "left" } as unknown as TextObj;
  const bytes = await buildPdf([{ ...pages[0], objects: [obj] }], new Map([[doc.id, doc]]), new Map(), { settings: defaultSettings() });
  const text = (await pageText(await openPdf(bytes), 1)).normalize("NFC");
  const rev = (s: string) => [...s].reverse().join("");
  for (const w of ["أو", "إذا", "آخر"]) assert.ok(text.includes(w) || text.includes(rev(w)), `${w} が取り出せない: ${[...text].map((c) => c.codePointAt(0)!.toString(16)).join(" ")}`);
  assert.ok(!/[أإآ][ٓ-ٕ]/.test(text), "記号が二重になっている");
});

for (const file of ["rtl-chromium.pdf", "rtl-libreoffice.pdf"]) {
  test(`${file}：行が読む順の文字列になり、語の単位で書き換えられる`, async () => {
    const { doc, pages } = await loadSource(join(fixtures, file));
    const pt = await getPageText(doc, pages[0]);
    const texts = pt.runs.map((r) => r.text);
    for (const l of LINES) assert.ok(texts.includes(l), `行が無い: ${l}\n${texts.join("\n")}`);
    for (const r of pt.runs.filter((x) => LINES.includes(x.text))) {
      assert.ok(r.editable && r.complex, `書き換えられない: ${r.text} (${r.reason})`);
      assert.equal(r.rtl, r.text.startsWith("English") ? "L" : "R", r.text);
    }
    // 置き換え・足す・消す・数字を変える・欧文の行の中の語を変える
    const cases: [string, string][] = [
      [LINES[0], "שלום חדש, זהו מסמך בדיקה מספר 2027."],
      [LINES[1], "הטופס נשלח אל משרד הפנים בתאריך 15/04/2026 (יום ראשון)."],
      [LINES[2], "שם פרטי: דוד כהן — טלפון נייד 050-1234567"],
      [LINES[3], "مرحبا بالعالم، هذه وثيقة جديدة رقم 2026."],
      [LINES[4], "تم إرسال النموذج إلى الوزارة بتاريخ 12/03/2026 (الخميس)."],
      [LINES[5], "الاسم: محمد علي — البريد info@example.org"],
      [LINES[6], "English text with עברית חדשה and العربية inside."],
    ];
    const edits = cases.map(([from, to]) => {
      const e = createTextEdit([pt.runs.find((r) => r.text === from)!], { cover: "#ffffff", fallbackColor: "#000000" } as never);
      e.text = to;
      return e;
    });
    const paths: string[] = [];
    const warnings: string[] = [];
    const bytes = await buildPdf([{ ...pages[0], objects: edits }], new Map([[doc.id, doc]]), new Map(), { settings: defaultSettings(), onEditPath: (how) => paths.push(how), onWarning: (w) => warnings.push(w) });
    assert.deepEqual(warnings, []);
    assert.ok(paths.every((p) => p === "anchored" || p === "anchored-mixed"), paths.join(","));
    // 保存したものを読み直すと、書き換えた文字列になっている
    clearPageTextCache();
    writeFileSync(join(outDir, `edited-${file}`), bytes);
    const again = await loadSource(join(outDir, `edited-${file}`));
    const after = (await getPageText(again.doc, again.pages[0])).runs.map((r) => r.text);
    for (const [, to] of cases) assert.ok(after.includes(to), `書き換え後の行が無い: ${to}\n${after.join("\n")}`);
    // 取り出した文字列に、足した語が入っている
    const text = await pageText(await openPdf(bytes), 1);
    const rev = (s: string) => [...s].reverse().join("");
    for (const w of ["חדש", "נייד", "جديدة", "info@example.org", "2027"]) assert.ok(text.includes(w) || text.includes(rev(w)), `${w} が取り出せない`);
    // 書き換えた行の外は変わらない
    const a = await renderPage(await openPdf(doc.bytes), 1, 2);
    const b = await renderPage(await openPdf(bytes), 1, 2);
    const boxes = edits.map((e) => ({ x: 0, y: e.y - 4, w: pages[0].width, h: e.h + 8 }));
    const d = diffOutside(a, b, boxes, 2);
    assert.equal(d.changed, 0, `行の外が変わった: ${d.changed}`);
    // 変えていない行（何も変えずに保存し直した行）は、見た目が変わらない
    const same = await buildPdf([{ ...pages[0], objects: pt.runs.filter((r) => LINES.includes(r.text)).map((r) => createTextEdit([r], { cover: "#ffffff", fallbackColor: "#000000" } as never)) }], new Map([[doc.id, doc]]), new Map(), { settings: defaultSettings(), rewriteUnchanged: true });
    const c = await renderPage(await openPdf(same), 1, 2);
    assert.equal(diffOutside(a, c, [], 2).changed, 0, "何も変えていないのに見た目が変わった");
  });
}

test("数字の並び：アラビア文字の数字は左から右、空白で区切った数字は 1 つずつ行の向きに並ぶ", () => {
  // 見た目「٢٠٢٦/٠٣/١٢」は、そのまま左から右に読む（字ごとに逆にしない）
  const d = rtlLine(glyphsOf("١٢/٠٣/٢٠٢٦ خيرات"), 10, undefined, {
    prior: "R",
  })!;
  assert.equal(d.text, "تاريخ ١٢/٠٣/٢٠٢٦");
  // 電話番号：見た目は「4567 123 50 966+」、読む順は「+966 50 123 4567」
  const p = rtlLine(glyphsOf("4567 123 50 966+ فتاه"), 10, undefined, {
    prior: "R",
  })!;
  assert.equal(p.text, "هاتف +966 50 123 4567");
  // 欧文の語から始まる続きは、数字も含めてひと続き
  const f = rtlLine(glyphsOf("Form 1040 جذومن"), 10, undefined, {
    prior: "R",
  })!;
  assert.equal(f.text, "نموذج Form 1040");
  assert.deepEqual(ltrGroups(["966", "50", "Form", "1040", "A"]), [[0], [1], [2, 3, 4]]);
  // 読む順 → 見た目の順（書き出す側）も同じ規則
  assert.deepEqual(visualOrder([false, true, true, true], "R", ["هاتف", "+966", "50", "123"]), [3, 2, 1, 0]);
  assert.deepEqual(visualOrder([false, true, true], "R", ["نموذج", "Form", "1040"]), [1, 2, 0]);
});

test("代わりの文字（ActualText）の読み取り", () => {
  assert.equal(actualTextOf("<</ActualText<FEFF064A>>>"), "ي");
  assert.equal(actualTextOf("<< /MCID 3 /ActualText <feff0644 0627> >>"), "لا");
  assert.equal(actualTextOf("<</ActualText(a\\)b)>>"), "a)b");
  assert.equal(actualTextOf("<</MCID 0>>"), null);
});

test("rtl-libreoffice-noto.pdf：本体と点に分けて描かれた字（代わりの文字つき）を読み、書き換えたあとも読める", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "rtl-libreoffice-noto.pdf"));
  const pt = await getPageText(doc, pages[0]);
  const want = [
    "تقرير اختبار اللغة العربية",
    "لا إله إلا الله، والسلام عليكم ورحمة الله وبركاته. الأستاذ محمد علي الأحمد.",
    "اَلْعَرَبِيَّةُ لُغَةٌ جَمِيلَةٌ مَعَ التَّشْكِيلِ الكَامِلِ.",
    "تاريخ الإصدار: ١٢/٠٣/٢٠٢٦ (يوم الخميس) — المبلغ ١٬٢٥٠٫٥٠ ريال.",
  ];
  const texts = pt.runs.map((r) => r.text.normalize("NFC"));
  for (const l of want) assert.ok(texts.includes(l.normalize("NFC")), `行が無い: ${l}\n${texts.join("\n")}`);
  assert.ok(
    pt.runs.every((r) => r.editable),
    `書き換えられない行: ${pt.runs
      .filter((r) => !r.editable)
      .map((r) => r.text)
      .join(" / ")}`,
  );
  const cases: [string, string][] = [
    [want[0], "تقرير تجربة اللغة العربية"],
    [want[1], "لا إله إلا الله، والسلام عليكم ورحمة الله وبركاته. الأستاذ أحمد علي الأحمد."],
    [want[3], "تاريخ الإصدار: ١٥/٠٤/٢٠٢٦ (يوم الجمعة) — المبلغ ١٬٢٥٠٫٥٠ ريال."],
  ];
  const edits = cases.map(([from, to]) => {
    const e = createTextEdit([pt.runs.find((r) => r.text.normalize("NFC") === from.normalize("NFC"))!], { cover: "#ffffff", fallbackColor: "#000000" } as never);
    e.text = to;
    return e;
  });
  const paths: string[] = [];
  const bytes = await buildPdf([{ ...pages[0], objects: edits }], new Map([[doc.id, doc]]), new Map(), { settings: defaultSettings(), onEditPath: (how) => paths.push(how) });
  assert.ok(
    paths.every((p) => p === "anchored" || p === "anchored-mixed"),
    paths.join(","),
  );
  clearPageTextCache();
  writeFileSync(join(outDir, "edited-rtl-noto.pdf"), bytes);
  const again = await loadSource(join(outDir, "edited-rtl-noto.pdf"));
  const after = (await getPageText(again.doc, again.pages[0])).runs.map((r) => r.text.normalize("NFC"));
  // 変えた行は新しい文字列に、変えていない字（点を別の字形で描いた字）もそのまま読める
  for (const [, to] of cases) assert.ok(after.includes(to.normalize("NFC")), `書き換え後の行が無い: ${to}\n${after.join("\n")}`);
  // 書き換えた行の外は変わらない
  const a = await renderPage(await openPdf(doc.bytes), 1, 2);
  const b = await renderPage(await openPdf(bytes), 1, 2);
  const d = diffOutside(
    a,
    b,
    edits.map((e) => ({ x: 0, y: e.y - 4, w: pages[0].width, h: e.h + 8 })),
    2,
  );
  assert.equal(d.changed, 0, `行の外が変わった: ${d.changed}`);
});

for (const file of ["rtl-libreoffice-brackets.pdf", "rtl-chromium-brackets.pdf"]) {
  test(`${file}：かっこの隣の番号を変えても、かっこは元と同じ形・同じ文字で書かれる`, async () => {
    // LibreOffice は「左右逆の形の字形に、読む順の文字を対応させる」、Chrome は「見た目どおりの文字を対応させ、読む順の文字を
    // 代わりの文字として添える」。どちらでも、書き直したかっこは元のかっこと同じ書き方になる
    const { doc, pages } = await loadSource(join(fixtures, file));
    const pt = await getPageText(doc, pages[0]);
    const lines = ["ראה (סעיף 1) להלן.", "הוראות כלליות (סעיף 1)", "(סעיף 1)"];
    const edits = lines.map((l) => {
      const run = pt.runs.find((r) => r.text === l);
      assert.ok(run?.editable, `${l}\n${pt.runs.map((r) => r.text).join("\n")}`);
      const e = createTextEdit([run!], { cover: "#ffffff", fallbackColor: "#000000" } as never);
      e.text = l.replace("1", "2");
      return e;
    });
    const bytes = await buildPdf([{ ...pages[0], objects: edits }], new Map([[doc.id, doc]]), new Map(), { settings: defaultSettings() });
    clearPageTextCache();
    writeFileSync(join(outDir, `edited-${file}`), bytes);
    const again = await loadSource(join(outDir, `edited-${file}`));
    const after = (await getPageText(again.doc, again.pages[0])).runs.map((r) => r.text);
    for (const l of lines) assert.ok(after.includes(l.replace("1", "2")), `${l.replace("1", "2")}\n${after.join("\n")}`);
    // 数字のすぐ左のかっこ：文字の対応（と代わりの文字）が、元の文書のかっこと同じ
    const leftOfDigit = async (d: typeof doc, digit: string) => {
      const a = await analyzePage(d, 0);
      const out: string[] = [];
      for (const s of a.shows) {
        if (s.text !== digit && !s.text.endsWith(digit) && !s.text.includes(` ${digit}`)) continue;
        const left = a.shows.filter((x) => Math.abs(x.start[1] - s.start[1]) < 1 && x.end && x.end[0] <= s.start[0] + 0.5).sort((p, q) => q.end![0] - p.end![0])[0];
        if (left) out.push(`${[...left.text].pop()}${left.actual ? `/${left.actual.text}` : ""}`);
      }
      return out;
    };
    const before = await leftOfDigit(doc, "1");
    const now = await leftOfDigit(again.doc, "2");
    assert.ok(before.length >= 1 && now.length >= 1, `${before} / ${now}`);
    assert.equal(now[0], before[0], `かっこの書き方が元と違う: 元 ${before} → ${now}`);
  });
}

// LibreOffice 25 の出力：可変フォントの太字を字形の絵（Type3）で埋め込み、アラビア文字は本体と点を別の字形で描く
// （点は文字としては取り出せず、上下にずれた高さにある）
for (const [file, lines, from, to] of [
  ["rtl-libreoffice-type3-ar.pdf", 11, "الإلكترونية", "الرقمية"],
  ["rtl-libreoffice-type3-he.pdf", 11, "מודפס", "חדש"],
] as const) {
  test(`${file}：点だけの小さな行ができず、書き換えた語の点が残らない。太字の Type3 は太字とみなす`, async () => {
    const { doc, pages } = await loadSource(join(fixtures, file));
    const pt = await getPageText(doc, pages[0]);
    const texts = pt.runs.map((r) => r.text).join("\n");
    assert.equal(pt.runs.length, lines, texts);
    assert.ok(pt.runs.every((r) => r.editable), texts);
    // 太字の語（Type3）は太字のフォントとみなす（書き直した語を太く描くため）
    const a = await analyzePage(doc, 0);
    const t3 = a.shows.find((s) => s.font?.kind === "type3" && s.text.trim() && s.text !== "�");
    assert.ok(t3?.font && isBoldFont(t3.font), "太字の Type3 が太字と判定されない");
    const plain = a.shows.find((s) => s.font?.subtype === "TrueType" && /Regular/.test(s.font.baseFont));
    assert.ok(plain?.font && !isBoldFont(plain.font));
    // 点のある語を書き換えて保存し、読み直す：行の数は同じで、点だけの行（上書きのみ）ができていない
    const run = pt.runs.find((r) => r.text.includes(from))!;
    assert.ok(run, texts);
    const e = createTextEdit([run], { cover: "#ffffff", fallbackColor: "#000000" } as never);
    e.text = run.text.replace(from, to);
    const bytes = await buildPdf([{ ...pages[0], objects: [e] }], new Map([[doc.id, doc]]), new Map(), { settings: defaultSettings() });
    clearPageTextCache();
    const out = join(outDir, `edited-${file}`);
    writeFileSync(out, bytes);
    const again = await loadSource(out);
    const after = (await getPageText(again.doc, again.pages[0])).runs;
    const afterText = after.map((r) => r.text).join("\n");
    assert.equal(after.length, lines, afterText);
    assert.ok(after.every((r) => r.editable), afterText);
    assert.ok(after.some((r) => r.text === run.text.replace(from, to)), afterText);
  });
}

test("アラビア文字の行の先頭が、本体と別の高さに描いた点でも、書き直した語は行の高さに書く", async () => {
  // 署名の行（LibreOffice の出力）は、行の先頭の字形が、字の下に置いた点になっている
  const { doc, pages } = await loadSource(join(fixtures, "rtl-libreoffice-type3-ar.pdf"));
  clearPageTextCache();
  const pt = await getPageText(doc, pages[0]);
  const run = pt.runs.find((r) => r.text.includes("قسم المعارض"))!;
  assert.ok(run, pt.runs.map((r) => r.text).join("\n"));
  const e = createTextEdit([run], { cover: "#ffffff", fallbackColor: "#000000" } as never);
  e.text = run.text.replace("قسم المعارض", "قسم الفعاليات");
  const bytes = await buildPdf([{ ...pages[0], objects: [e] }], new Map([[doc.id, doc]]), new Map(), { settings: defaultSettings() });
  const pdf = await openPdf(bytes);
  const items = (await (await pdf.getPage(1)).getTextContent()).items.filter((it) => "str" in it && it.str.trim()) as { str: string; transform: number[] }[];
  const fresh = items.find((it) => it.str.includes("الفعاليات"));
  // 同じ行の、書き換えていない語（إدارة の本体）
  const kept = fresh && items.filter((it) => it.str.includes("دار") && Math.abs(it.transform[5] - fresh.transform[5]) < 10).sort((p, q) => Math.abs(p.transform[5] - fresh.transform[5]) - Math.abs(q.transform[5] - fresh.transform[5]))[0];
  assert.ok(fresh && kept, items.map((it) => it.str).join("|"));
  assert.ok(Math.abs(fresh.transform[5] - kept.transform[5]) < 0.5, `書き直した語の高さ ${fresh.transform[5]} / 行の高さ ${kept.transform[5]}`);
});

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createTextEdit } from "@/lib/editModel";
import { buildPdf } from "@/lib/exportPdf";
import { findMatches, findMatchesInRun, findSpanning, matchBoxes, replaceMatches, runBox, PII_PATTERNS } from "@/lib/findText";
import { getPageText } from "@/lib/textRuns";
import type { RedactObj } from "@/lib/types";
import { fixtures, loadSource, openPdf, pageText } from "./helpers";

test("検索：全角・半角と大文字・小文字を区別しない（区別する指定もできる）", () => {
  assert.deepEqual(findMatches("ABC abc ａｂｃ", "abc"), [{ start: 0, end: 3 }, { start: 4, end: 7 }, { start: 8, end: 11 }]);
  assert.deepEqual(findMatches("ABC abc ａｂｃ", "abc", true), [{ start: 4, end: 7 }]);
  assert.deepEqual(findMatches("令和６年", "6年"), [{ start: 2, end: 4 }]);
  assert.deepEqual(findMatches("ｶﾞｲﾄﾞ", "ガイド"), [{ start: 0, end: 5 }]);
  assert.deepEqual(findMatches("aaaa", "aa"), [{ start: 0, end: 2 }, { start: 2, end: 4 }]);
  assert.deepEqual(findMatches("abc", ""), []);
  // 1 文字が複数文字に広がる互換文字の途中では一致させない
  assert.deepEqual(findMatches("㍻元年", "成元"), []);
  assert.deepEqual(findMatches("㍻元年", "平成"), [{ start: 0, end: 1 }]);
  // サロゲートペア
  assert.deepEqual(findMatches("𠮷野家と吉野", "野"), [{ start: 2, end: 3 }, { start: 6, end: 7 }]);
});

test("検索：置換は一致した部分だけを入れ替える", () => {
  const s = "会場：第1会議室（第1会議室は3階）";
  assert.equal(replaceMatches(s, findMatches(s, "第１会議室"), "大ホール"), "会場：大ホール（大ホールは3階）");
  assert.equal(replaceMatches("abc", [], "x"), "abc");
});

test("検索：行をまたぐ一致（欧文は空白 1 つ、和文は空白なしでつながる）", () => {
  assert.deepEqual(findSpanning("installs the PI SQL", "Client and the driver", "PI SQL Client"), [{ a: { start: 13, end: 19 }, b: { start: 0, end: 6 } }]);
  assert.deepEqual(findSpanning("契約者は株式会社サン", "プル商事とする。", "株式会社サンプル商事"), [{ a: { start: 4, end: 10 }, b: { start: 0, end: 4 } }]);
  // 1 行に収まる一致は対象外（行ごとの検索で見つかるため）
  assert.deepEqual(findSpanning("PI SQL Client is", "PI SQL Client too", "PI SQL Client"), []);
  // 単語の途中で折り返していない欧文は、空白を挟まないとつながらない
  assert.deepEqual(findSpanning("the PI", "SQL", "PISQL"), []);
  assert.deepEqual(findSpanning("", "abc", "abc"), []);
});

const CASES = ["ja-subset-identity.pdf", "ja-libreoffice-writer.pdf", "en-standard14.pdf", "ja-nonembedded-rksj.pdf"];

test("検索して墨消し：一致した字形だけが消え、同じ行の前後の文字は残る", async () => {
  let tested = 0;
  for (const fixture of CASES) {
    const { doc, pages } = await loadSource(join(fixtures, fixture));
    const { runs } = await getPageText(doc, pages[0]);
    const all = runs.map((r) => r.text).join("\n");
    // ページ内で 1 回しか出てこない 3 文字（行の途中）を探す
    let picked: { run: (typeof runs)[number]; q: string } | null = null;
    for (const len of [3, 2]) {
      for (const run of runs) {
        if (run.vertical || run.text.length < len + 3) continue;
        for (let i = 1; i + len <= run.text.length - 1 && !picked; i++) {
          const q = run.text.slice(i, i + len);
          if (/\s/.test(q) || /\s/.test(run.text[i - 1]) || /\s/.test(run.text[i + len])) continue;
          if (all.split(q).length === 2) picked = { run, q };
        }
        if (picked) break;
      }
      if (picked) break;
    }
    assert.ok(picked, `${fixture}: 試す文字が見つからない`);
    const { run, q } = picked;
    const matches = findMatches(run.text, q);
    assert.equal(matches.length, 1);
    const boxes = await matchBoxes(doc, pages[0], run, matches);
    const build = async (box: { x: number; y: number; w: number; h: number }) => {
      const r: RedactObj = { id: "r", type: "redact", ...box, fill: "#000000" };
      const bytes = await buildPdf([{ ...pages[0], objects: [r] }], new Map([[doc.id, doc]]), new Map());
      return (await pageText(await openPdf(bytes), 1)).replace(/\s+/g, "");
    };
    if (fixture === "ja-nonembedded-rksj.pdf") {
      // 文字幅も Unicode も引けないフォント：位置は特定できないので、行全体を対象にする（それで確実に消える）
      assert.equal(boxes, null, `${fixture}: 位置が取れないはず`);
      assert.ok(!(await build(runBox(run))).includes(q), `${fixture}: 行全体の墨消しで「${q}」が残っている`);
      tested++;
      continue;
    }
    assert.ok(boxes && boxes[0], `${fixture}: 「${q}」の位置を特定できない`);
    const b = boxes[0];
    // 行の箱の中に収まり、行全体よりは狭い
    assert.ok(b.x >= run.x - 2 && b.x + b.w <= run.x + run.w + 2 && b.w < run.w * 0.9, `${fixture}: 範囲が不自然 ${JSON.stringify(b)} / 行 ${run.x},${run.w}`);
    const text = await build(b);
    const before = run.text.slice(0, matches[0].start).replace(/\s+/g, "");
    const after = run.text.slice(matches[0].end).replace(/\s+/g, "");
    assert.ok(!text.includes(q), `${fixture}: 「${q}」が残っている`);
    assert.ok(text.includes(before.slice(-4)), `${fixture}: 直前の「${before.slice(-4)}」が消えている`);
    assert.ok(text.includes(after.slice(0, 4)), `${fixture}: 直後の「${after.slice(0, 4)}」が消えている`);
    tested++;
  }
  assert.equal(tested, CASES.length);
});

test("検索して置換：一致した行が実編集で書き換わり、元の文字は残らない", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "ja-subset-identity.pdf"));
  const { runs } = await getPageText(doc, pages[0]);
  const run = runs.find((r) => r.editable && r.text.length >= 6)!;
  const q = run.text.slice(1, 3);
  const matches = findMatches(run.text, q);
  const obj = createTextEdit([run], { cover: "#ffffff", fallbackColor: "#000000" });
  obj.text = replaceMatches(run.text, matches, "置換");
  const bytes = await buildPdf([{ ...pages[0], objects: [obj] }], new Map([[doc.id, doc]]), new Map());
  const text = (await pageText(await openPdf(bytes), 1)).replace(/\s+/g, "");
  assert.ok(text.includes(obj.text.replace(/\s+/g, "")), `書き換え後の行が無い: ${text.slice(0, 80)}`);
  assert.ok(!text.includes(run.text.replace(/\s+/g, "")), "元の行が残っている");
});

test("インド系の文字：入力するときのつづりで、PDF の中の並び（子音の左の母音記号が先）の語が見つかる", () => {
  // PDF の中の「हिंदी」は ि が先頭にある
  const line = "\u093f\u0939\u0902\u0926\u0940/ Hindi";
  assert.deepEqual(findMatchesInRun(line, "\u0939\u093f\u0902\u0926\u0940"), [{ start: 0, end: 5 }]);
  // PDF の中の並びのままでも見つかる。重なる一致は 1 つにまとめる
  assert.deepEqual(findMatchesInRun(line, "\u093f\u0939\u0902\u0926\u0940"), [{ start: 0, end: 5 }]);
  // 語の一部（हिं）を探すと、記号と子音の両方を含む範囲になる
  assert.deepEqual(findMatchesInRun(line, "\u0939\u093f\u0902"), [{ start: 0, end: 3 }]);
  // 並べ替えるものが無い行は、通常の検索と同じ
  assert.deepEqual(findMatchesInRun("Hindi \u0928\u093e\u092e", "\u0928\u093e\u092e"), [{ start: 6, end: 9 }]);
});

test("個人情報のひな形：電話番号・メール・郵便番号・マイナンバー・カード番号を、全角でも見つける。長い番号の一部や日付は電話番号と見なさない", () => {
  const hit = (re: RegExp, s: string) => findMatches(s, re).map((m) => s.slice(m.start, m.end));
  assert.deepEqual(hit(PII_PATTERNS.phone, "電話 03-1234-5678、携帯 090（1234）5678 FAX 0312345678"), ["03-1234-5678", "090（1234）5678", "0312345678"]);
  assert.deepEqual(hit(PII_PATTERNS.phone, "０６－１２３４－５６７８ と +81-3-1234-5678"), ["０６－１２３４－５６７８", "+81-3-1234-5678"]);
  assert.deepEqual(hit(PII_PATTERNS.phone, "2026-01-15 に、注文番号 1203456789 を確認"), []);
  assert.deepEqual(hit(PII_PATTERNS.email, "連絡先：Taro.Yamada@example.co.jp まで"), ["Taro.Yamada@example.co.jp"]);
  assert.deepEqual(hit(PII_PATTERNS.postal, "〒100-0001 東京都、郵便 ５３０－０００１"), ["〒100-0001", "５３０－０００１"]);
  assert.deepEqual(hit(PII_PATTERNS.mynumber, "個人番号 1234 5678 9012 と 123456789012、電話 03-1234-5678"), ["1234 5678 9012", "123456789012"]);
  assert.deepEqual(hit(PII_PATTERNS.card, "カード 4111-1111-1111-1111"), ["4111-1111-1111-1111"]);
});

test("個人情報のひな形：ハイフンでつないだ長い番号の一部を、郵便番号やマイナンバーとして拾わない", () => {
  const hit = (re: RegExp, s: string) => findMatches(s, re).map((m) => s.slice(m.start, m.end));
  assert.deepEqual(hit(PII_PATTERNS.postal, "携帯 090-1111-2222、〒100-0001"), ["〒100-0001"]);
  assert.deepEqual(hit(PII_PATTERNS.mynumber, "カード 4111-1111-1111-1111"), []);
});

test("個人情報のひな形：+81 の後の空白、かっこ付きの市外局番、点区切りの携帯番号、〒 付きの 7 桁、15 桁のカード番号も拾う。日付は拾わない", () => {
  const hit = (re: RegExp, s: string) => findMatches(s, re).map((m) => s.slice(m.start, m.end));
  assert.deepEqual(hit(PII_PATTERNS.phone, "国際 +81 90-1111-2222 / 代表 (03) 3333-4444 / 携帯 090.7777.8888"), ["+81 90-1111-2222", "(03) 3333-4444", "090.7777.8888"]);
  assert.deepEqual(hit(PII_PATTERNS.phone, "日付 03.11.2025 と 2025.03.11、版 0.75.1234"), []);
  assert.deepEqual(hit(PII_PATTERNS.postal, "〒1000001 と 1000001 と 〒 530-0001"), ["〒1000001", "〒 530-0001"]);
  assert.deepEqual(hit(PII_PATTERNS.card, "Amex 3782 822463 10005 と 378282246310005"), ["3782 822463 10005", "378282246310005"]);
  assert.deepEqual(hit(PII_PATTERNS.mynumber, "カード 3782 822463 10005"), []);
});

test("個人情報のひな形：メールアドレスは、区切りの無い長い文字列でも時間がかからない", () => {
  const long = `${"a".repeat(200000)} x@example.com`;
  const t0 = Date.now();
  const ms = findMatches(long, PII_PATTERNS.email);
  assert.equal(ms.length, 1);
  assert.ok(Date.now() - t0 < 2000, `遅い（${Date.now() - t0} ms）`);
});

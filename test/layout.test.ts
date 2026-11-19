import assert from "node:assert/strict";
import { test } from "node:test";
import { breakParagraph, fitText, type Measurer } from "@/lib/layout";

/** 全角 1em・半角 0.5em の簡易字幅 */
const m: Measurer = {
  width: (t, fs) => [...t].reduce((w, ch) => w + (/[^\u0000-ɏ]/.test(ch) ? fs : fs * 0.5), 0),
};

test("行頭禁則：句読点・閉じ括弧・長音が行頭に来ない", () => {
  const text = "これは、テストです。「括弧」も、ありますー。";
  for (const width of [4, 5, 6, 7, 8, 9]) {
    const { lines } = breakParagraph(text, 1, width, m);
    for (const l of lines.slice(1)) assert.doesNotMatch(l, /^[、。」ー]/, `幅${width}: 行頭禁則違反: ${JSON.stringify(lines)}`);
    assert.equal(lines.join(""), text.replace(/ /g, ""));
  }
});

test("行末禁則：開き括弧が行末に残らない", () => {
  const text = "見積書（２０２６年）の「備考」欄";
  for (const width of [3, 4, 5, 6, 7]) {
    const { lines } = breakParagraph(text, 1, width, m);
    for (const l of lines.slice(0, -1)) assert.doesNotMatch(l, /[（「]$/, `幅${width}: 行末禁則違反: ${JSON.stringify(lines)}`);
  }
});

test("ぶら下げ：句点1文字だけなら行末にぶら下げる", () => {
  const { lines } = breakParagraph("あいうえお。かきく", 1, 5, m);
  assert.deepEqual(lines, ["あいうえお。", "かきく"]);
});

test("欧文は単語の途中で折らず、空白で折る", () => {
  const { lines } = breakParagraph("Revenue grew by twelve percent", 1, 8, m);
  for (const l of lines) assert.ok(m.width(l, 1) <= 8.01, l);
  assert.deepEqual(lines, ["Revenue grew by", "twelve percent"]);
});

test("折れる所が無い長い単語は文字単位で強制的に折る", () => {
  const { lines, wideLine } = breakParagraph("Supercalifragilistic", 1, 4, m);
  assert.ok(lines.length >= 3);
  assert.equal(wideLine, false);
});

test("和欧混在：日本語と英単語の境界で折れる", () => {
  const { lines } = breakParagraph("本日はLibreOfficeを使います", 1, 6, m);
  assert.ok(lines.every((l) => m.width(l, 1) <= 6.01), JSON.stringify(lines));
  assert.ok(!lines.some((l) => /^[a-zA-Z]+$/.test(l) && l.length < "LibreOffice".length), "英単語の途中で折れている");
});

test("fitText：収まらなければ縮小し、最小サイズでも無理なら overflow", () => {
  const text = "あいうえおかきくけこさしすせそ"; // 15文字
  const ok = fitText(text, 10, 150, 1, m);
  assert.equal(ok.shrunk, false);
  assert.equal(ok.overflow, false);
  const shrink = fitText(text, 10, 120, 1, m);
  assert.equal(shrink.shrunk, true);
  assert.equal(shrink.overflow, false);
  assert.ok(shrink.fontSize <= 8 && shrink.fontSize >= 6, String(shrink.fontSize));
  const over = fitText(text, 10, 50, 1, m);
  assert.equal(over.overflow, true);
  assert.equal(over.fontSize, 6);
  // 複数行の箱
  const multi = fitText(text, 10, 60, 3, m);
  assert.equal(multi.overflow, false);
  assert.equal(multi.lines.length, 3);
});

test("改行は段落の区切りとして扱う", () => {
  const r = fitText("一行目\n二行目", 10, 100, 2, m);
  assert.deepEqual(r.lines, ["一行目", "二行目"]);
});

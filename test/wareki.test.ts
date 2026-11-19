import assert from "node:assert/strict";
import { test } from "node:test";
import { applyMatches, findDates, warekiToWestern, westernToWareki } from "@/lib/wareki";

test("和暦→西暦：元号と元年", () => {
  const f = (s: string) => findDates(s, "toWestern").map((m) => `${m.original}→${m.converted}`);
  assert.deepEqual(f("令和6年11月8日"), ["令和6年11月8日→2024年11月8日"]);
  assert.deepEqual(f("令和元年"), ["令和元年→2019年"]);
  assert.deepEqual(f("平成31年"), ["平成31年→2019年"]);
  assert.deepEqual(f("昭和64年1月7日"), ["昭和64年1月7日→1989年1月7日"]);
  assert.deepEqual(f("大正元年"), ["大正元年→1912年"]);
  assert.deepEqual(f("明治元年"), ["明治元年→1868年"]);
});

test("和暦→西暦：全角はそろえる、月だけも可、略記も拾う", () => {
  const f = (s: string) => findDates(s, "toWestern").map((m) => m.converted);
  assert.deepEqual(f("令和６年"), ["２０２４年"]);
  assert.deepEqual(f("平成30年4月"), ["2018年4月"]);
  assert.deepEqual(f("令3年"), ["2021年"]);
});

test("西暦→和暦：月があれば境界も正確、年だけは警告", () => {
  const all = (s: string) => findDates(s, "toWareki");
  assert.deepEqual(all("2024年11月8日").map((m) => m.converted), ["令和6年11月8日"]);
  assert.deepEqual(all("2019年3月").map((m) => m.converted), ["平成31年3月"]);
  assert.deepEqual(all("2019年6月").map((m) => m.converted), ["令和元年6月"]);
  // 月の無い境界年は変換するが警告を立てる
  const b = all("2019年")[0];
  assert.equal(b.converted, "令和元年");
  assert.equal(b.warning, true);
  // 境界でない年は警告なし
  assert.equal(all("2020年")[0].warning, false);
});

test("往復で一致する", () => {
  for (let y = 1870; y <= 2030; y += 7) {
    const w = westernToWareki(y, 7, 1)!;
    assert.equal(warekiToWestern(w.era, w.year), y, `${y}`);
  }
});

test("文中の複数日付を右から置き換える", () => {
  const text = "契約日 令和5年4月1日 から 令和6年3月31日 まで";
  const matches = findDates(text, "toWestern");
  assert.equal(matches.length, 2);
  assert.equal(applyMatches(text, matches), "契約日 2023年4月1日 から 2024年3月31日 まで");
  // 一部だけ選んだ場合
  assert.equal(applyMatches(text, [matches[1]]), "契約日 令和5年4月1日 から 2024年3月31日 まで");
});

test("日付でない 4 桁や範囲外は拾わない", () => {
  assert.deepEqual(findDates("合計 12345 円、西暦 1700年", "toWareki").map((m) => m.original), []);
  assert.deepEqual(findDates("第12回 令和の会議", "toWestern").map((m) => m.original), []);
});

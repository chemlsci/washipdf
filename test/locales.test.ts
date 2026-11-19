import assert from "node:assert/strict";
import { test } from "node:test";
import { ar } from "@/lib/locales/ar";
import { bn } from "@/lib/locales/bn";
import { de } from "@/lib/locales/de";
import { en } from "@/lib/locales/en";
import { es } from "@/lib/locales/es";
import { fa } from "@/lib/locales/fa";
import { fr } from "@/lib/locales/fr";
import { hi } from "@/lib/locales/hi";
import { id } from "@/lib/locales/id";
import { it } from "@/lib/locales/it";
import { ja } from "@/lib/locales/ja";
import { ko } from "@/lib/locales/ko";
import { pt } from "@/lib/locales/pt";
import { ru } from "@/lib/locales/ru";
import { th } from "@/lib/locales/th";
import { tr } from "@/lib/locales/tr";
import { ur } from "@/lib/locales/ur";
import { vi } from "@/lib/locales/vi";
import { zhCN } from "@/lib/locales/zh-CN";
import { zhTW } from "@/lib/locales/zh-TW";

const DICTS: Record<string, Record<string, string | undefined>> = { en, "zh-CN": zhCN, "zh-TW": zhTW, ko, es, pt, fr, de, it, ru, tr, id, vi, th, hi, bn, ar, ur, fa };
const base: Record<string, string> = ja;
const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

test("辞書：どの言語にも、日本語（基準）と同じキーがそろっている", () => {
  for (const [lang, d] of Object.entries(DICTS)) {
    const missing = Object.keys(base).filter((k) => d[k] === undefined);
    const extra = Object.keys(d).filter((k) => !(k in base));
    assert.deepEqual(missing, [], `${lang}: 訳が無いキー`);
    assert.deepEqual(extra, [], `${lang}: 基準に無いキー`);
  }
});

test("辞書：{変数} が日本語（基準）と一致し、空の訳が無い", () => {
  for (const [lang, d] of Object.entries(DICTS)) {
    for (const [k, v] of Object.entries(d)) {
      if (v === undefined || !(k in base)) continue;
      assert.ok(v.trim().length > 0, `${lang} ${k}: 空の訳`);
      assert.equal(vars(v), vars(base[k]), `${lang} ${k}: {変数} が基準と違う`);
    }
  }
});

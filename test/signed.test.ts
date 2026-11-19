import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { defaultSettings } from "@/lib/docOps";
import { buildPdf } from "@/lib/exportPdf";
import { looksSigned } from "@/lib/loader";
import { fixtures, loadSource } from "./helpers";

test("電子署名付きの PDF を検出し、読み込み時に signed、保存時に警告が出る", async () => {
  const { doc, pages, bytes } = await loadSource(join(fixtures, "signed.pdf"));
  assert.equal(looksSigned(bytes), true);
  assert.equal(doc.signed, true);
  const plain = await loadSource(join(fixtures, "en-standard14.pdf"));
  assert.equal(plain.doc.signed, false);
  const warnings: string[] = [];
  await buildPdf(pages, new Map([[doc.id, doc]]), new Map(), { settings: defaultSettings(), onWarning: (m) => warnings.push(m) });
  assert.equal(warnings.length, 1, warnings.join("\n"));
  assert.match(warnings[0], /signed\.pdf/);
});

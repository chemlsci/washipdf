// 編集画面で描いたものが、保存した PDF に描かれること（種類ごとに、置いた場所の画素が変わるか）
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { defaultSettings } from "@/lib/docOps";
import { buildPdf } from "@/lib/exportPdf";
import { defaultFont } from "@/lib/fonts";
import type { EditObj } from "@/lib/types";
import { fixtures, loadSource, openPdf, renderPage, setupFonts } from "./helpers";

setupFonts();

const AT = { x: 380, y: 620 };
const objects: EditObj[] = [
  { id: "r", type: "rect", ...AT, w: 120, h: 80, stroke: "#e11d48", fill: null, strokeWidth: 2, opacity: 1 },
  { id: "rf", type: "rect", ...AT, w: 120, h: 80, stroke: null, fill: "#2f55d4", strokeWidth: 0, opacity: 1 },
  { id: "e", type: "ellipse", ...AT, w: 120, h: 80, stroke: "#e11d48", fill: null, strokeWidth: 2, opacity: 1 },
  { id: "w", type: "whiteout", ...AT, w: 120, h: 80, stroke: "#111111", fill: "#ffffff", strokeWidth: 2, opacity: 1 },
  { id: "l", type: "line", ...AT, dx: 120, dy: 0, stroke: "#e11d48", strokeWidth: 2, opacity: 1 },
  { id: "i", type: "ink", ...AT, w: 100, h: 40, paths: [[[0, 0], [50, 40], [100, 0]]], stroke: "#e11d48", strokeWidth: 2.5, opacity: 1 },
  { id: "s", type: "stamp", ...AT, w: 72, h: 32, text: "承認", color: "#d6334a", font: defaultFont("sans"), fontSize: 18, rotation: 0, opacity: 1, frame: "rect" },
  { id: "g", type: "stamp", ...AT, w: 168, h: 70, text: "部長,課長,担当", color: "#222222", font: defaultFont("sans"), fontSize: 10, rotation: 0, opacity: 1, frame: "grid" },
  { id: "t", type: "text", ...AT, text: "テスト", font: defaultFont("sans"), fontSize: 14, color: "#111111" } as EditObj,
];

for (const o of objects) {
  test(`保存した PDF に描かれる：${o.type}${o.id.length > 1 ? `（${o.id}）` : ""}`, async () => {
    const { doc, pages } = await loadSource(join(fixtures, "ja-libreoffice-writer.pdf"));
    const bytes = await buildPdf([{ ...pages[0], objects: [o] }], new Map([[doc.id, doc]]), new Map(), { settings: defaultSettings() });
    const scale = 1;
    const img = await renderPage(await openPdf(bytes), 1, scale);
    // 置いた範囲（AT から 170×90）に、白くない画素があるか（元のページのこの範囲は白紙）
    let ink = 0;
    for (let y = AT.y - 2; y < AT.y + 90; y++)
      for (let x = AT.x - 2; x < AT.x + 170; x++) {
        const i = (y * img.width + x) * 4;
        if (img.data[i] < 230 || img.data[i + 1] < 230 || img.data[i + 2] < 230) ink++;
      }
    assert.ok(ink > 30, `${o.type}（${o.id}）が描かれていない: ${ink} 画素`);
  });
}

test("保存すると元の文書情報（タイトル・作成者など）が残る。入れた値で上書きでき、削除を選べば消える", async () => {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { root } = await import("./helpers");
  const d = await PDFDocument.create();
  d.addPage([595, 842]).drawText("meta", { x: 50, y: 700, size: 20, font: await d.embedFont(StandardFonts.Helvetica) });
  d.setTitle("テスト文書");
  d.setAuthor("山田太郎");
  d.setSubject("件名");
  d.setKeywords(["見積"]);
  mkdirSync(join(root, "dist", ".test-out"), { recursive: true });
  const file = join(root, "dist", ".test-out", "meta-source.pdf");
  writeFileSync(file, await d.save());
  const { doc, pages } = await loadSource(file);
  const build = async (meta: Partial<ReturnType<typeof defaultSettings>["meta"]>) => {
    const settings = defaultSettings();
    settings.meta = { ...settings.meta, ...meta };
    return PDFDocument.load(await buildPdf(pages, new Map([[doc.id, doc]]), new Map(), { settings }));
  };
  const kept = await build({});
  assert.equal(kept.getTitle(), "テスト文書");
  assert.equal(kept.getAuthor(), "山田太郎");
  assert.equal(kept.getSubject(), "件名");
  const over = await build({ title: "新しい題" });
  assert.equal(over.getTitle(), "新しい題");
  assert.equal(over.getAuthor(), "山田太郎");
  const gone = await build({ sanitize: true });
  assert.ok(!gone.getTitle() && !gone.getAuthor());
});

test("リンク：https / mailto の URL だけを書く（javascript: などは書かない）。行き先の無いリンクも書かない", async () => {
  const { PDFDocument, PDFName, PDFArray } = await import("pdf-lib");
  const { doc, pages } = await loadSource(join(fixtures, "ja-libreoffice-writer.pdf"));
  const links = (["https://example.com", "mailto:a@example.com", "javascript:alert(1)", "file:///etc/passwd", ""] as const).map((url, i) => ({ id: `l${i}`, type: "link" as const, x: 50, y: 50 + i * 30, w: 100, h: 20, target: { kind: "url" as const, url } }));
  const bytes = await buildPdf([{ ...pages[0], objects: [...links, { id: "p", type: "link", x: 50, y: 300, w: 100, h: 20, target: { kind: "page", pageId: "missing" } }] }], new Map([[doc.id, doc]]), new Map(), { settings: defaultSettings() });
  const out = await PDFDocument.load(bytes);
  const annots = out.getPage(0).node.lookup(PDFName.of("Annots"));
  const n = annots instanceof PDFArray ? annots.size() : 0;
  assert.equal(n, 2);
});

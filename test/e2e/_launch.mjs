// File Handling API の受け取り確認：OS から「Washi PDF で開く」された状態を launchQueue の模擬で再現する。
//   node scripts/build.mjs && node test/e2e/_launch.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { chromium } = createRequire(join(root, "package.json"))("playwright");
const pdf = [...readFileSync(join(root, "test", "fixtures", "ja-subset-identity.pdf"))];
const b = await chromium.launch();
const p = await (await b.newContext({ locale: "ja-JP" })).newPage();
// 試験は「ページ全体を表示」で行う（ページ上の位置を、ページ全体が見えている前提で指す）
await p.addInitScript(() => {
  try {
    localStorage.setItem("washi-pdf.fit", "page");
  } catch {}
});
const errs = [];
p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
await p.addInitScript((bytes) => {
  const file = new File([new Uint8Array(bytes)], "launched.pdf", { type: "application/pdf" });
  Object.defineProperty(window, "launchQueue", {
    configurable: true,
    value: { setConsumer: (fn) => setTimeout(() => fn({ files: [{ getFile: async () => file }] }), 50) },
  });
  try { indexedDB.deleteDatabase("washi-pdf"); } catch {}
}, pdf);
await p.goto("file://" + join(root, "dist", "washi-pdf.html"));
await p.waitForSelector(".card", { timeout: 20000 });
const label = await p.textContent("header").catch(() => "");
console.log("opened via launchQueue:", /launched/.test(label ?? ""), "| console errors:", errs.length);
await b.close();
if (!/launched/.test(label ?? "") || errs.length) { console.log("FAIL"); process.exit(1); }
console.log("PASS");

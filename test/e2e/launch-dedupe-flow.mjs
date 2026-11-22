// 「Washi PDF で開く」で同じ PDF が 2 つのウィンドウに渡されたとき：先のウィンドウは開き、あとのウィンドウは閉じる。
// 閉じられない場合（ブラウザーが許さない）でも、空の画面のまま残さず、ファイルを開く。違うファイルなら両方開く。
//   node scripts/build.mjs && node test/e2e/launch-dedupe-flow.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const { chromium } = createRequire(join(process.cwd(), "package.json"))("playwright");
const html = "file://" + join(process.cwd(), "dist", "washi-pdf.html");
const pdfA = [...readFileSync(join(process.cwd(), "test", "fixtures", "ja-subset-identity.pdf"))];
const pdfB = [...readFileSync(join(process.cwd(), "test", "fixtures", "en-standard14.pdf"))];
let failed = 0;
const fail = (m) => (failed++, console.log("FAIL:", m));
const ok = (m) => console.log("ok:", m);

const b = await chromium.launch();
const ctx = await b.newContext({ locale: "ja-JP" });
async function launch(bytes, name, lastModified) {
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e)));
  await p.addInitScript(
    ([bytes, name, lastModified]) => {
      const file = new File([new Uint8Array(bytes)], name, { type: "application/pdf", lastModified });
      Object.defineProperty(window, "launchQueue", {
        configurable: true,
        value: { setConsumer: (fn) => setTimeout(() => fn({ files: [{ getFile: async () => file }] }), 30) },
      });
      // 閉じようとしたかを記録する（このテストのページは、ブラウザーの決まりで自分では閉じられないことがある）
      const close = window.close.bind(window);
      window.close = () => {
        window.__closeTried = true;
        close();
      };
    },
    [bytes, name, lastModified],
  );
  await p.goto(html);
  return { p, errs };
}
const state = async ({ p }) => {
  if (p.isClosed()) return "closed";
  try {
    await p.waitForSelector(".card", { timeout: 8000 });
    return (await p.evaluate(() => !!window.__closeTried)) ? "tried-close-then-opened" : "opened";
  } catch {
    return p.isClosed() ? "closed" : "blank";
  }
};

// 1. 同じファイルを、ほぼ同時に 2 つのウィンドウへ
const w1 = await launch(pdfA, "same.pdf", 1700000000000);
const w2 = await launch(pdfA, "same.pdf", 1700000000000);
const s1 = await state(w1),
  s2 = await state(w2);
if (s1 !== "opened") fail(`先のウィンドウが開いていない：${s1}`);
if (!["closed", "tried-close-then-opened"].includes(s2)) fail(`あとのウィンドウが、閉じも開きもしていない：${s2}`);
else ok(`同じファイル：先のウィンドウは開き、あとのウィンドウは ${s2 === "closed" ? "閉じた" : "閉じようとして（閉じられないので）開いた"}`);

// 2. 違うファイルなら、どちらも普通に開く
const w3 = await launch(pdfA, "a.pdf", 1);
const w4 = await launch(pdfB, "b.pdf", 2);
const s3 = await state(w3),
  s4 = await state(w4);
if (s3 !== "opened" || s4 !== "opened") fail(`違うファイルで、普通に開かなかった：${s3} / ${s4}`);
else ok("違うファイルは、どちらも普通に開く");

const errs = [w1, w2, w3, w4].flatMap((w) => w.errs);
if (errs.length) fail("ページのエラー：" + errs.join(" / "));
await b.close();
if (failed) {
  console.log(`FAIL (${failed})`);
  process.exit(1);
}
console.log("PASS");

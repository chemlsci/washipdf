// すべてのテスト用 PDF を実際の HTML で開き、既存文字ツールで行が検出されること（同梱 CMap の動作を含む）を確認する
//   node test/e2e/smoke-fixtures.mjs
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = process.cwd();
const html = join(root, "dist", "washi-pdf.html");
const fixtures = join(root, "test", "fixtures");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, locale: "ja-JP" });
const network = [];
page.on("request", (r) => {
  const u = r.url();
  if (!u.startsWith("file://") && !u.startsWith("blob:") && !u.startsWith("data:")) network.push(u);
});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

let failed = false;
for (const f of readdirSync(fixtures).filter((x) => x.endsWith(".pdf")).sort()) {
  await page.goto("file://" + html);
  await page.waitForSelector(".dropzone", { timeout: 30000 });
  // 前のファイルの下書きが残っていたら破棄する（復元を尋ねるダイアログが操作を遮るため）
  if (await page.$('button:has-text("破棄する")')) await page.click('button:has-text("破棄する")');
  await page.setInputFiles('input[type="file"][accept*="pdf"]', join(fixtures, f));
  // 暗号化フィクスチャ（enc-*.pdf）は閲覧パスワード "user"。閲覧パスワード無しのものは問い合わせが出ない
  if (f.startsWith("enc-")) {
    const pw = page.locator('.modal[aria-label="パスワードが必要です"] input[type="password"]');
    const shown = await pw.waitFor({ timeout: 5000 }).then(() => true, () => false);
    if (shown) {
      await pw.fill("user");
      await pw.press("Enter");
    }
  }
  await page.waitForSelector(".card", { timeout: 30000 });
  await page.click('button[role="tab"]:has-text("編集")');
  await page.waitForFunction(() => !document.querySelector(".page-loading"), null, { timeout: 30000 });
  await page.click('button.tool:has-text("既存文字")');
  // 解析が終わるまで待つ（行が出るか、エラー表示になるか）
  await page.waitForSelector(".run-box, .page-notice:not(:has-text('解析しています'))", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(300);
  const boxes = await page.$$eval(".run-box", (els) => els.map((e) => ({ title: e.getAttribute("title") ?? "", noedit: e.classList.contains("noedit") })));
  if (f.startsWith("scan")) {
    // スキャン文書（画像だけ。文字の行は無い）：各ページの画像が表示されていること。
    // ファクス形式・JPEG 2000 は同梱の WASM で復号するので、ここで白紙なら WASM が動いていない（CSP など）
    const dark = [];
    const total = await page.locator(".strip-item").count();
    for (let n = 0; n < total; n++) {
      await page.waitForFunction(() => !document.querySelector(".page-loading"), null, { timeout: 30000 });
      await page.waitForTimeout(300);
      dark.push(
        await page.$eval(".page-canvas", (c) => {
          const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
          let n = 0;
          for (let i = 0; i < d.length; i += 4) if (d[i] < 80) n++;
          return n / (d.length / 4);
        }),
      );
      if (n + 1 < total) await page.keyboard.press("PageDown");
    }
    const ok = dark.length > 0 && dark.every((r) => r > 0.05);
    if (!ok) failed = true;
    console.log(`${ok ? "ok " : "NG "} ${f}: 画像だけの ${dark.length} ページ、黒い画素の割合 ${dark.map((r) => (r * 100).toFixed(0) + "%").join(" / ")}`);
    continue;
  }
  const ok = boxes.length > 0;
  if (!ok) failed = true;
  console.log(`${ok ? "ok " : "NG "} ${f}: 行 ${boxes.length}（上書きのみ ${boxes.filter((b) => b.noedit).length}） 例: ${boxes[0]?.title.slice(0, 40) ?? "-"}`);
}
await browser.close();
if (network.length) {
  console.error("外部への通信が発生しました:", network);
  failed = true;
}
if (errors.length) console.error("ブラウザのエラー:", errors);
process.exit(failed || errors.length ? 1 : 0);

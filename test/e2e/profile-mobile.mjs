// スマホ相当（CPU 4 倍遅延、390×844、DPR 3）で主な操作を行い、CPU プロファイルと長いタスクを集計する。
// 合否判定はせず、どこが重いかを報告するだけ。
//   node test/e2e/profile-mobile.mjs [--html dist/washi-pdf-dev.html] [--rate 4]
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = process.cwd();
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const html = join(root, arg("--html", "dist/washi-pdf-dev.html"));
const rate = Number(arg("--rate", "4"));
const fixtures = join(root, "test", "fixtures");

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: "ja-JP" });
const page = await context.newPage();
// 試験は「ページ全体を表示」で行う（ページ上の位置を、ページ全体が見えている前提で指す）
await page.addInitScript(() => {
  try {
    localStorage.setItem("washi-pdf.fit", "page");
  } catch {}
});
const cdp = await context.newCDPSession(page);
await cdp.send("Emulation.setCPUThrottlingRate", { rate });
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 500 });

const steps = [];
let profiles = [];
const step = async (name, fn) => {
  await cdp.send("Profiler.start");
  await page.evaluate(() => {
    window.__long = [];
    window.__po?.disconnect();
    window.__po = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__long.push(Math.round(e.duration));
    });
    window.__po.observe({ type: "longtask", buffered: false });
  });
  const t0 = Date.now();
  let err = "";
  try {
    await fn();
  } catch (e) {
    err = ` （失敗: ${String(e).split("\n")[0].slice(0, 80)}）`;
  }
  const ms = Date.now() - t0;
  await page.waitForTimeout(300);
  const { profile } = await cdp.send("Profiler.stop");
  const long = await page.evaluate(() => window.__long ?? []);
  steps.push({ name, ms, long });
  profiles.push({ name, profile });
  console.log(`${name}: ${ms} ms, long tasks: ${long.length ? long.join(", ") : "-"}${err}`);
};

/** プロファイルを関数ごとの self time（ms）に集計する */
function summarize(profile, top = 18) {
  const self = new Map();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const dt = profile.timeDeltas;
  const counts = new Map();
  for (let i = 0; i < profile.samples.length; i++) counts.set(profile.samples[i], (counts.get(profile.samples[i]) ?? 0) + (dt[i] ?? 0));
  for (const [id, us] of counts) {
    const n = byId.get(id);
    const f = n.callFrame;
    const key = `${f.functionName || "(anonymous)"} @${f.lineNumber}`;
    self.set(key, (self.get(key) ?? 0) + us / 1000);
  }
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  return { total: Math.round(total), top: [...self].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, v]) => `${Math.round(v)}ms ${k}`) };
}

await page.goto("file://" + html);
await page.waitForSelector(".dropzone", { timeout: 60000 });
if (await page.$('button:has-text("破棄する")')) await page.click('button:has-text("破棄する")');

await step("読み込み（3 ファイル・7 ページ）", async () => {
  await page.setInputFiles('input[type="file"][accept*="pdf"]', [join(fixtures, "ja-libreoffice-writer.pdf"), join(fixtures, "ja-subset-identity.pdf"), join(fixtures, "vector.pdf"), join(fixtures, "forms.pdf"), join(fixtures, "images.pdf"), join(fixtures, "en-standard14.pdf"), join(fixtures, "ja-vertical.pdf")]);
  await page.waitForSelector(".card", { timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll(".card img").length >= 4, null, { timeout: 60000 });
});
await step("カードを 3 回タップ（選択の切り替え）", async () => {
  for (let i = 0; i < 3; i++) {
    await page.locator(".card").nth(i).click();
    await page.waitForTimeout(150);
  }
});
await step("すべて選択 → 右回転", async () => {
  if (await page.$('button:has-text("選択解除")')) await page.click('button:has-text("選択解除")');
  await page.click('button:has-text("すべて選択")');
  await page.waitForTimeout(150);
  await page.click('button:has-text("右回転")');
  await page.waitForFunction(() => document.querySelectorAll(".card img").length >= 4, null, { timeout: 60000 });
});
await step("編集画面を開く", async () => {
  await page.click('button[role="tab"]:has-text("編集")');
  await page.waitForSelector(".page-canvas");
  await page.waitForFunction(() => !document.querySelector(".page-loading"), null, { timeout: 60000 });
});
await step("既存文字ツール（解析）", async () => {
  await page.click('button.tool:has-text("既存文字")');
  await page.waitForSelector(".run-box", { timeout: 60000 });
});
await step("行をタップして書き換え（入力欄）", async () => {
  await page.locator(".run-box").first().click();
  const ta = page.locator(".props textarea").first();
  await ta.waitFor();
  await ta.fill("書き換えテスト");
  await page.keyboard.press("Tab");
  await page.waitForSelector(".obj-textedit");
});
await step("文字ツールで追加", async () => {
  await page.click('button.tool[title^="オブジェクトを選択"]');
  await page.click('button.tool[title^="クリックした位置に文字を追加"]');
  const box = await (await page.$(".page")).boundingBox();
  await page.touchscreen.tap(box.x + box.width * 0.5, box.y + box.height * 0.6);
  await page.waitForSelector(".obj-text", { timeout: 10000 });
  const ta = page.locator(".props textarea").first();
  await ta.waitFor({ timeout: 10000 });
  await ta.fill("追加した文字");
  await page.keyboard.press("Tab");
});
await step("ズームイン → 縮小", async () => {
  await page.click('button[title="拡大"]');
  await page.waitForTimeout(400);
  await page.click('button[title="縮小"]');
  await page.waitForTimeout(400);
});
await step("前のページへ 2 回", async () => {
  for (let i = 0; i < 2; i++) {
    await page.click('button[title="前のページ"]');
    await page.waitForFunction(() => !document.querySelector(".page-loading"), null, { timeout: 60000 });
  }
});
await step("ページ整理に戻る", async () => {
  await page.click('button[role="tab"]:has-text("ページ整理")');
  await page.waitForSelector(".card");
  await page.waitForTimeout(300);
});

console.log("\n==== 関数別 self time（上位） ====");
for (const p of profiles) {
  const s = summarize(p.profile);
  console.log(`\n-- ${p.name}（計 ${s.total} ms）`);
  for (const l of s.top) console.log("   " + l);
}
await browser.close();

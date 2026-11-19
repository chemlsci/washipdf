// 抜け道への備えを確かめる：WebRTC が使えないこと（小窓の中も）、アプリの外のページへ移る前に尋ねること。
//   node test/e2e/guard-flow.mjs
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = process.cwd();
const html = join(root, "dist", "washi-pdf.html");
const browser = await chromium.launch();
const page = await (await browser.newContext({ locale: "ja-JP" })).newPage();
const network = [];
page.on("request", (r) => {
  const u = r.url();
  if (!u.startsWith("file://") && !u.startsWith("blob:") && !u.startsWith("data:")) network.push(u);
});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const dialogs = [];
page.on("dialog", (d) => {
  dialogs.push(d.message());
  void d.dismiss();
});
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

await page.goto("file://" + html);
await page.waitForSelector(".dropzone", { timeout: 30000 });

// 1. WebRTC：ページでも、あとから作った小窓の中でも使えない
const rtc = await page.evaluate(async () => {
  const f = document.createElement("iframe");
  document.body.appendChild(f);
  await new Promise((r) => setTimeout(r, 50));
  const r = { page: typeof window.RTCPeerConnection, frame: typeof f.contentWindow.RTCPeerConnection, dc: typeof window.RTCDataChannel };
  f.remove();
  return r;
});
console.log("webrtc:", JSON.stringify(rtc));
if (rtc.page !== "undefined" || rtc.frame !== "undefined" || rtc.dc !== "undefined") fail("WebRTC が使えてしまいます");

// 2. アプリの外のページへの移動：尋ねられ、キャンセルすると移らない
await page.evaluate(() => {
  location.href = "https://example.com/?leak=secret";
});
await page.waitForTimeout(800);
console.log("dialogs:", dialogs);
if (!dialogs.some((m) => m.includes("example.com"))) fail("ページの移動の前に尋ねていません");
if (!page.url().startsWith("file://")) fail(`ページが移ってしまいました: ${page.url()}`);

// 3. window.open で外のアドレスを開く：尋ねられ、キャンセルすると開かない
const n = dialogs.length;
const opened = await page.evaluate(() => window.open("https://example.org/?leak=secret") !== null);
if (opened || dialogs.length !== n + 1 || !dialogs[n].includes("example.org")) fail("window.open の前に尋ねていません");

// 3b. スクリプトが作ったリンクの click()（文書に入れたもの・入れていないもの）：尋ねられ、キャンセルすると開かない
const popups = [];
page.context().on("page", (p) => popups.push(p.url()));
for (const attach of [true, false]) {
  const before = dialogs.length;
  await page.evaluate((attach) => {
    const a = document.createElement("a");
    a.href = "https://example.net/?leak=" + (attach ? "in" : "out");
    a.target = "_blank";
    if (attach) document.body.appendChild(a);
    a.click();
    a.remove();
  }, attach);
  await page.waitForTimeout(500);
  if (dialogs.length !== before + 1 || !dialogs[before].includes("example.net")) fail(`リンクの click() の前に尋ねていません（文書に${attach ? "入れた" : "入れていない"}リンク）`);
}
if (popups.length) fail(`キャンセルしたのに開きました: ${popups}`);
// 4. アプリの中の移動（ページ内の印）は尋ねない
const m = dialogs.length;
await page.evaluate(() => {
  location.hash = "#x";
});
await page.waitForTimeout(300);
if (dialogs.length !== m) fail("アプリの中の移動で尋ねてしまいました");

// アプリは普通に動く
await page.setInputFiles('input[type="file"][accept*="pdf"]', [join(root, "test", "fixtures", "en-standard14.pdf")]);
await page.waitForSelector(".card", { timeout: 30000 });
await browser.close();
if (network.length) fail(`外部への通信が発生しました: ${network}`);
if (errors.length) fail(`ブラウザのエラー: ${errors}`);
console.log("OK: WebRTC は使えず、外のページへ移る前に尋ねる。通信ゼロ、エラーなし");

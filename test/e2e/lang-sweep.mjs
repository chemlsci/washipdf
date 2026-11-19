// 全言語 × パソコン／スマホ（幅 360px）／横向きのスマホ（844×390）／タブレットの縦向き（768×1024）で、
// 主な画面とすべてのダイアログを開き、はみ出し・切れ・重なり・不自然な折り返しを集める。
// 合否判定はせず、報告だけする（全言語・4 通りで 1 時間ほどかかる。--modes で画面の大きさを絞れる）。
//   node test/e2e/lang-sweep.mjs [--langs=de,ar] [--modes=d,m,l,t] [--shots]
// 結果は dist/.sweep/lang/report.json、--shots を付けると同じ場所に画面の画像も残す。
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = process.cwd();
const outDir = join(root, "dist", ".sweep", "lang");
const ALL = ["ja", "en", "zh-CN", "zh-TW", "ko", "es", "pt", "fr", "de", "it", "ru", "tr", "id", "vi", "th", "hi", "bn", "ar", "ur", "fa"];
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const langs = arg("langs")?.split(",") ?? ALL;
const shots = process.argv.includes("--shots");
// d：パソコン、m：スマホ（縦）、l：スマホ（横）、t：タブレット（縦）
const MODES = {
  d: { viewport: { width: 1280, height: 800 } },
  m: { viewport: { width: 360, height: 760 }, isMobile: true, hasTouch: true },
  l: { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true },
  t: { viewport: { width: 768, height: 1024 }, hasTouch: true },
};
const modes = (arg("modes")?.split(",") ?? Object.keys(MODES)).filter((m) => MODES[m]);
mkdirSync(outDir, { recursive: true });
const SKIP = new Set(["reverse", "removeBlank", "extract", "stripAnnots", "grayscale", "fromImages"]);

const inspect = () => {
  const out = [];
  const vw = innerWidth;
  const de = document.documentElement;
  if (de.scrollWidth > de.clientWidth + 1) out.push(["page-overflow", `${de.scrollWidth}>${de.clientWidth}`]);
  const scrollsX = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if ((o === "auto" || o === "scroll") && p.scrollWidth > p.clientWidth) return true;
    }
    return false;
  };
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || +s.opacity === 0) return null;
    return r;
  };
  const txt = (el) => (el.textContent || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 40);
  const modal = document.querySelector(".modal");
  const scope = modal ?? document.body;
  for (const el of scope.querySelectorAll("button, .btn, label, h1, h2, h3, small, .tool-card b, th, td, .field > span, .note, p, .lang-switch, .doc-title, li, .wareki-flag")) {
    const r = vis(el);
    if (!r) continue;
    const s = getComputedStyle(el);
    const inScroll = scrollsX(el);
    // 画面・ダイアログの外にはみ出している
    if (!inScroll && (r.right > vw + 1 || r.left < -1)) out.push(["off-screen", `${txt(el)} [${Math.round(r.left)}..${Math.round(r.right)}]`]);
    if (modal && !inScroll) {
      const m = modal.getBoundingClientRect();
      if (r.right > m.right + 1 || r.left < m.left - 1) out.push(["out-of-dialog", `${txt(el)} [${Math.round(r.left)}..${Math.round(r.right)}] dialog [${Math.round(m.left)}..${Math.round(m.right)}]`]);
    }
    // 中身が箱より広い（切れている／省略されている）
    if (el.scrollWidth > el.clientWidth + 1 && (s.overflowX === "hidden" || s.overflowX === "clip") && el.children.length <= 3) {
      out.push([s.textOverflow === "ellipsis" ? "ellipsis" : "clipped", `${txt(el)} (${el.scrollWidth}>${el.clientWidth})`]);
    }
    // 子が親ボタンからはみ出す
    if (el.matches("button, .btn") && s.overflowX === "visible") {
      for (const c of el.children) {
        const cr = c.getBoundingClientRect();
        if (cr.width > 1 && (cr.right > r.right + 1.5 || cr.left < r.left - 1.5)) {
          out.push(["overflow-button", `${txt(el)} child [${Math.round(cr.left)}..${Math.round(cr.right)}] btn [${Math.round(r.left)}..${Math.round(r.right)}]`]);
          break;
        }
      }
      // 文字だけのボタン：内容幅が箱を超える
      // （押せる範囲を広げる ::after は数えない）
      const after = getComputedStyle(el, "::after").content;
      if ((after === "none" || after === "normal") && el.scrollWidth > el.clientWidth + 1) out.push(["overflow-button", `${txt(el)} (${el.scrollWidth}>${el.clientWidth})`]);
    }
    // ボタンの中で 3 行以上に折り返している
    if (el.matches(".btn, .tool, .rail button, .seg button, .chip, .menu-pop button")) {
      // 文字が実際に何行に折り返されているか（文字の矩形の上端を数える）
      const tops = new Set();
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (!n.textContent.trim()) continue;
        const rg = document.createRange(); rg.selectNodeContents(n);
        for (const q of rg.getClientRects()) if (q.width > 1) tops.add(Math.round(q.top / 4));
      }
      const lines = tops.size;
      const limit = el.matches(".rail button, .tool") ? 3 : 2;
      if (lines > limit) out.push(["many-lines", `${txt(el)} (${lines} lines)`]);
    }
  }
  // 重なり：上部バーの要素どうし
  const bar = [...document.querySelectorAll(".topbar > *, .topbar .actions > *")].map((e) => [e, vis(e)]).filter((x) => x[1]);
  for (let i = 0; i < bar.length; i++) for (let j = i + 1; j < bar.length; j++) {
    const [a, ra] = bar[i], [b, rb] = bar[j];
    if (a.contains(b) || b.contains(a)) continue;
    if (Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left) > 2 && Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top) > 2) out.push(["overlap", `${txt(a)} × ${txt(b)}`]);
  }
  return out;
};

const browser = await chromium.launch();
const report = {};
for (const lang of langs) {
  for (const mode of modes) {
    const key = `${lang}/${mode}`;
    const ctx = await browser.newContext({ ...MODES[mode], locale: lang });
    const page = await ctx.newPage();
    // 試験は「ページ全体を表示」で行う（ページ上の位置を、ページ全体が見えている前提で指す）
    await page.addInitScript(() => {
      try {
        localStorage.setItem("washi-pdf.fit", "page");
      } catch {}
    });
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    page.on("dialog", (d) => void d.dismiss());
    await page.addInitScript((l) => { try { localStorage.setItem("washi-pdf.lang", l); indexedDB.deleteDatabase("washi-pdf"); } catch {} }, lang);
    const found = [];
    const check = async (name) => {
      await page.waitForTimeout(120);
      const r = await page.evaluate(inspect);
      for (const [kind, what] of r) found.push({ screen: name, kind, what });
      if (shots) await page.screenshot({ path: join(outDir, `${lang}-${mode}-${name}.png`) });
    };
    const closeModal = async () => {
      for (let i = 0; i < 3 && (await page.locator(".modal-back").count()); i++) { await page.keyboard.press("Escape"); await page.waitForTimeout(80); }
    };
    try {
      await page.goto("file://" + root + "/dist/washi-pdf.html");
      await page.waitForSelector(".dropzone");
      await check("start");
      await page.setInputFiles('input[type="file"][accept*="pdf"]', [root + "/test/fixtures/ja-subset-identity.pdf", root + "/test/fixtures/forms.pdf", root + "/test/fixtures/images.pdf"]);
      await page.waitForSelector(".card"); await page.waitForTimeout(500);
      await check("organize");
      await page.locator(".card").first().click();
      await check("organize-selected");
      await page.locator(".menu-caret").click(); await check("save-menu"); await page.keyboard.press("Escape");
      const tabs = page.locator('[role="tab"]');
      await tabs.nth(1).click(); await page.waitForSelector(".page-canvas"); await page.waitForTimeout(400);
      await check("editor");
      await page.locator("button.tool").nth(1).click(); await page.waitForTimeout(600);
      await check("editor-edit-text");
      // 1 行を選んでプロパティのパネルを出す
      const box = page.locator(".run-box:not(.noedit)").first();
      if (await box.count()) { await box.click(); await page.waitForTimeout(400); await check("editor-props"); await page.keyboard.press("Escape"); await page.keyboard.press("Escape"); }
      // 道具を選ぶ（並びに出ていなければ、「その他」の中から。スマホと、道具が 1 段に入りきらない幅・言語のとき）
      const pickTool = async (id) => {
        const direct = page.locator(`.toolbar .tool-group button.tool[data-tool="${id}"]`);
        if ((await direct.count()) && (await direct.first().isVisible())) return direct.first().click();
        await page.locator(".toolbar button.tool[aria-expanded]").click();
        await check("tool-sheet");
        await page.locator(`.tool-sheet button.tool[data-tool="${id}"]`).click();
      };
      // 道具の並びに隠れたままの道具が無いか（「その他」から選べること）
      const lost = await page.evaluate(() => {
        const bar = document.querySelector(".toolbar");
        const hidden = [...bar.querySelectorAll(".tool-group [data-tool]")].filter((b) => {
          const r = b.getBoundingClientRect();
          const g = b.closest(".tool-group").getBoundingClientRect();
          return getComputedStyle(b).visibility === "hidden" || r.right > g.right + 1 || r.bottom > g.bottom + 1;
        });
        return hidden.length && !bar.querySelector("button.tool[aria-expanded]") ? hidden.map((b) => b.dataset.tool).join(",") : "";
      });
      if (lost) found.push({ screen: "editor", kind: "hidden-tools", what: lost });
      for (const n of ["rect", "redact", "note", "stamp", "link", "field", "measure"]) {
        await pickTool(n);
        if (n === "field" || n === "measure") await check(`editor-${n}-picked`);
        const pg = page.locator(".page-canvas").first(); const bb = await pg.boundingBox();
        if (bb) {
          if (n === "note" || n === "stamp") await page.mouse.click(bb.x + bb.width * 0.6, bb.y + bb.height * 0.3);
          else { await page.mouse.move(bb.x + bb.width * 0.3, bb.y + bb.height * 0.2); await page.mouse.down(); await page.mouse.move(bb.x + bb.width * 0.5, bb.y + bb.height * 0.3, { steps: 4 }); await page.mouse.up(); }
          await page.waitForTimeout(300); await check(`editor-${n}`);
        }
        await page.keyboard.press("Escape");
      }
      // 署名の画面（承認欄も）
      await pickTool("sign"); await page.waitForSelector(".modal .seg"); await check("sign");
      const seg = page.locator(".modal .seg button");
      for (let k = 1; k < (await seg.count()); k++) { await seg.nth(k).click(); await page.waitForTimeout(150); await check(`sign-${k}`); }
      await closeModal();
      // キーボードのショートカットの一覧
      await page.locator("body").press("?"); await page.waitForSelector(".modal", { timeout: 3000 }).catch(() => {}); await check("shortcuts"); await closeModal();
      await tabs.nth(2).click(); await page.waitForTimeout(200);
      await check("tools");
      const ids = await page.$$eval(".tool-card", (els) => els.map((e) => e.dataset.tool));
      for (const id of ids) {
        if (SKIP.has(id)) continue;
        const card = page.locator(`.tool-card[data-tool="${id}"]`);
        if (await card.isDisabled()) continue;
        await card.click();
        await page.waitForSelector(".modal", { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(350);
        if (id === "find") { await page.fill('.modal input[type="search"]', "サンプル"); await page.waitForTimeout(900); await check("tool-find-replace"); await page.locator(".modal .seg button").nth(1).click(); await page.waitForTimeout(200); }
        if (id === "split") { for (let k = 1; k < 5; k++) { await page.locator(".modal .seg button").nth(k).click(); await page.waitForTimeout(100); await check(`tool-split-${k}`); } }
        if (id === "protect" || id === "compress" || id === "numbering" || id === "headerFooter" || id === "watermark") {
          // 無効→有効にすると出てくる欄も見る
          const cb = page.locator('.modal input[type="checkbox"]').first();
          if (await cb.count()) { await cb.check().catch(() => {}); await page.waitForTimeout(250); }
        }
        await check(`tool-${id}`);
        await closeModal();
      }
      await page.locator("header .icon-btn").last().click(); await page.waitForSelector(".modal"); await check("about"); await closeModal();
      // アプリ内の確認の画面（閉じる → 取り消す）。文書は閉じない
      await page.locator('header [data-action="close"]').click();
      await page.waitForSelector(".confirm-dialog", { timeout: 3000 });
      await check("confirm");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
      if (!(await page.locator(".card, .page-canvas, .tool-card").count())) found.push({ screen: "confirm", kind: "error", what: "取り消したのに文書が閉じた" });
    } catch (e) {
      found.push({ screen: "(sweep)", kind: "error", what: String(e).split("\n")[0].slice(0, 160) });
    }
    for (const e of errs) found.push({ screen: "(page)", kind: "pageerror", what: e.slice(0, 160) });
    report[key] = found;
    await ctx.close();
    const counts = {}; for (const f of found) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
    console.log(key, JSON.stringify(counts));
  }
}
await browser.close();
writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 1));

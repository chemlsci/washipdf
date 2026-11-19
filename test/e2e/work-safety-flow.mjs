// 作業を失わないための決まり（再発防止）。
//  1. 数の欄：負の数を打てる、空にしてから打ち直せる（途中の形を元の値に戻さない）
//  2. 下書きから復元した文書は、自動保存を切ったあとに閉じようとすると確かめる
//  3. 2 つのタブ：あとから開いたタブは、もう一方の下書きの復元を尋ねず、消しもしない。自分の編集は自動保存されないと知らせ、閉じる前に確かめる
//  4. 開いたあとでほかのアプリが書き換えたファイルに上書きするときは、そのことを知らせる（断れば、ファイルはそのまま）
//   node test/e2e/work-safety-flow.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = process.cwd();
const html = "file://" + (process.env.WASHI_HTML ? join(root, process.env.WASHI_HTML) : join(root, "dist", "washi-pdf.html"));
const fx = (n) => join(root, "test", "fixtures", n);
const fail = (m) => {
  console.error("FAIL:", m);
  process.exit(1);
};
const ok = (m) => console.log("ok ", m);

const idle = async (page) => {
  await page.waitForFunction(() => !document.querySelector(".busy"), null, { timeout: 120000 });
  await page.waitForTimeout(250);
};
const open = async (page, file) => {
  await page.setInputFiles('input[type="file"][accept*="pdf"]', fx(file));
  await page.waitForSelector(".card");
  await idle(page);
};
const tab = async (page, name) => {
  await page.click(`button[role="tab"]:has-text("${name}")`);
  await page.waitForTimeout(250);
};
const grayscale = async (page) => {
  await tab(page, "ツール");
  await page.click('.tool-card[data-tool="grayscale"]');
  await page.waitForTimeout(300);
};
const leaveBlocked = (page) =>
  page.evaluate(() => {
    const e = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });
const draftName = (page) =>
  page.evaluate(
    () =>
      new Promise((res) => {
        const r = indexedDB.open("washi-pdf");
        r.onsuccess = () => {
          try {
            const q = r.result.transaction("draft").objectStore("draft").get("state");
            q.onsuccess = () => res(q.result?.baseName ?? null);
            q.onerror = () => res(null);
          } catch {
            res(null);
          }
        };
        r.onerror = () => res(null);
      }),
  );
const AUTOSAVE = 2600;

const browser = await chromium.launch();
const start = async (context, init) => {
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  await page.addInitScript(() => {
    try {
      localStorage.setItem("washi-pdf.fit", "page");
      // この試験は自動保存を前提にする（ファイルで開いた版の既定は「切」）。試験の中で切り替えたあとは、その設定を残す
      if (localStorage.getItem("washi-pdf.autosave") == null) localStorage.setItem("washi-pdf.autosave", "on");
    } catch {}
  });
  if (init) await page.addInitScript(init);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(html);
  await page.waitForSelector(".dropzone");
  await page.waitForTimeout(1200);
  return { page, errors };
};
const newContext = () => browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "ja-JP" });

// 1. 数の欄
{
  const context = await newContext();
  const { page } = await start(context);
  await open(page, "en-standard14.pdf");
  await tab(page, "ツール");
  await page.click('.tool-card[data-tool="watermark"]');
  await page.waitForSelector(".modal");
  const rot = page.locator('.modal label.field:has-text("角度") input');
  await rot.click();
  await rot.press("Control+a");
  await rot.pressSequentially("-45", { delay: 30 });
  if ((await rot.inputValue()) !== "-45") fail(`角度に -45 を打てない：「${await rot.inputValue()}」`);
  await rot.press("Tab");
  if ((await rot.inputValue()) !== "-45") fail(`角度が欄を離れると変わる：「${await rot.inputValue()}」`);
  await page.keyboard.press("Escape");
  await page.click('.tool-card[data-tool="crop"]');
  await page.waitForSelector(".modal");
  const top = page.locator('.modal label.field:has(span:text-is("上 (mm)")) input');
  await top.click();
  await top.press("Control+a");
  await top.pressSequentially("10");
  await top.press("Control+a");
  await top.press("Backspace");
  if ((await top.inputValue()) !== "") fail(`欄を空にできない：「${await top.inputValue()}」`);
  await top.pressSequentially("5");
  if ((await top.inputValue()) !== "5") fail(`空にしてから 5 を打つと「${await top.inputValue()}」`);
  // 空のまま離れたら、元の値に戻る
  await top.press("Control+a");
  await top.press("Backspace");
  await top.press("Tab");
  if ((await top.inputValue()) !== "5") fail(`空のまま離れたあと「${await top.inputValue()}」`);
  ok("数の欄：負の数・空にしてから打ち直し・空のまま離れる");
  await context.close();
}

// 2. 復元した文書 → 自動保存を切る → 閉じる前に確かめる
{
  const context = await newContext();
  const { page } = await start(context);
  await open(page, "en-standard14.pdf");
  await grayscale(page);
  await page.waitForTimeout(AUTOSAVE);
  await page.reload();
  await page.waitForSelector('button:has-text("復元する")');
  await page.click('button:has-text("復元する")');
  await page.waitForSelector(".card");
  await idle(page);
  await page.waitForTimeout(AUTOSAVE);
  if (await leaveBlocked(page)) fail("復元して自動保存できているのに、閉じる前に確かめる");
  await page.click('header button[title="このソフトについて"]');
  const toggle = page.locator('.modal label.checkbox:has-text("自動保存する") input');
  await toggle.uncheck();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  if (!(await leaveBlocked(page))) fail("復元した文書で自動保存を切ったのに、閉じる前に確かめない（作業が消える）");
  ok("復元した文書：自動保存を切ったあとは、閉じる前に確かめる");
  await context.close();
}

// 3. 2 つのタブ
{
  const context = await newContext();
  const A = (await start(context)).page;
  await open(A, "en-standard14.pdf");
  await grayscale(A);
  await A.waitForTimeout(AUTOSAVE);
  if (await leaveBlocked(A)) fail("タブ A：自動保存できているのに、閉じる前に確かめる");
  const B = (await start(context)).page;
  if (await B.locator('button:has-text("復元する")').count()) fail("タブ B が、編集中のタブ A の下書きの復元を尋ねた");
  await open(B, "vector.pdf");
  await grayscale(B);
  // 知らせは、ほかの知らせ（グレースケールにした、など）が消えてから出る
  const told = await B.waitForFunction(() => [...document.querySelectorAll(".toast")].some((e) => e.textContent.includes("ほかのタブ")), null, { timeout: 15000 }).then(
    () => true,
    () => false,
  );
  if (!told) fail("タブ B に、自動保存されないことの知らせが無い");
  if (!(await leaveBlocked(B))) fail("タブ B：自動保存されていないのに、閉じる前に確かめない");
  if ((await draftName(A)) !== "en-standard14") fail(`下書きがタブ A のものでない：${await draftName(A)}`);
  if (await leaveBlocked(A)) fail("タブ A：下書きが残っているのに、閉じる前に確かめる");
  // A を閉じると、B が自動保存できるようになる
  await A.close();
  await grayscale(B);
  await B.waitForTimeout(AUTOSAVE + 500);
  if ((await draftName(B)) !== "vector") fail(`タブ A を閉じたあと、タブ B が自動保存しない：${await draftName(B)}`);
  ok("2 つのタブ：下書きは 1 つのタブだけが使い、もう一方は知らせて閉じる前に確かめる");
  await context.close();
}

// 4. 開いたあとでほかのアプリが書き換えたファイルへの上書き
{
  const init = () => {
    window.__fs = {};
    const mk = (name) => ({
      kind: "file",
      name,
      requestPermission: async () => "granted",
      queryPermission: async () => "granted",
      getFile: async () => new File([window.__fs[name].data], name, { lastModified: window.__fs[name].lm }),
      createWritable: async () => {
        let buf = new Uint8Array(0);
        return {
          write: async (b) => {
            buf = b instanceof Blob ? new Uint8Array(await b.arrayBuffer()) : new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
          },
          close: async () => {
            window.__fs[name] = { data: buf, lm: Date.now() };
          },
          abort: async () => {},
        };
      },
    });
    window.__put = (name, b64) => {
      const s = atob(b64);
      const u = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
      window.__fs[name] = { data: u, lm: 1000 };
    };
    window.showOpenFilePicker = async () => [mk(window.__openName)];
  };
  const context = await newContext();
  const { page } = await start(context, init);
  await page.evaluate(([n, b]) => {
    window.__put(n, b);
    window.__openName = n;
  }, ["shared.pdf", readFileSync(fx("en-standard14.pdf")).toString("base64")]);
  await page.click('.dropzone[role="button"]');
  await page.waitForSelector(".card");
  await idle(page);
  await grayscale(page);
  // ほかのアプリが書き換える
  await page.evaluate(() => {
    const f = window.__fs["shared.pdf"];
    const ext = new TextEncoder().encode("\n%EXTERNAL-EDIT\n");
    const d = new Uint8Array(f.data.length + ext.length);
    d.set(f.data);
    d.set(ext, f.data.length);
    window.__fs["shared.pdf"] = { data: d, lm: 999999 };
  });
  const overwrite = async () => {
    await page.click(".split-btn .menu-caret");
    await page.click('.menu-pop button:has-text("元のファイルに上書き保存")');
    await page.waitForSelector(".confirm-dialog");
    return page.locator(".confirm-dialog").innerText();
  };
  const text = await overwrite();
  if (!text.includes("変更されています")) fail(`ほかで書き換えられたことを知らせない：${text}`);
  await page.click(".confirm-dialog button:not(.primary)");
  await page.waitForTimeout(500);
  const kept = await page.evaluate(() => new TextDecoder().decode(window.__fs["shared.pdf"].data).includes("EXTERNAL-EDIT"));
  if (!kept) fail("断ったのに、ファイルが書き換えられた");
  // 上書きを選べば書く。書いたあとは、もう一度上書きしてもふつうの確認になる
  await overwrite();
  await page.click(".confirm-dialog button.primary");
  await idle(page);
  const after = await page.evaluate(() => new TextDecoder().decode(window.__fs["shared.pdf"].data));
  if (after.includes("EXTERNAL-EDIT") || !after.startsWith("%PDF")) fail("上書きを選んだのに書かれていない");
  const again = await overwrite();
  if (again.includes("変更されています")) fail("自分で書いたあとなのに、ほかで変更されたと言う");
  await page.keyboard.press("Escape");
  ok("上書き保存：ほかで書き換えられたファイルは知らせる。断ればそのまま");
  await context.close();
}

// 5. ファイルで開いた版の自動保存は、既定で切。編集を始めたら一度だけ知らせ、閉じる前に確かめる
{
  const context = await newContext();
  const page = await context.newPage();
  await page.goto(html);
  await page.waitForSelector(".dropzone");
  await page.waitForTimeout(800);
  await open(page, "en-standard14.pdf");
  await grayscale(page);
  const told = await page
    .waitForFunction(() => [...document.querySelectorAll(".toast")].some((e) => e.textContent.includes("自動保存は切ってあります")), null, { timeout: 15000 })
    .then(
      () => true,
      () => false,
    );
  if (!told) fail("ファイルで開いた版で、自動保存が切れていることを知らせない");
  if ((await draftName(page)) !== null) fail("ファイルで開いた版で、既定のまま自動保存した");
  if (!(await leaveBlocked(page))) fail("自動保存していないのに、閉じる前に確かめない");
  ok("ファイルで開いた版：自動保存は既定で切、知らせて閉じる前に確かめる");
  await context.close();
}

await browser.close();
console.log("work-safety-flow: OK");

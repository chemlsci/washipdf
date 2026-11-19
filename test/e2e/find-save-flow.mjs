// 検索と置換・墨消し、保存メニュー（名前を付けて保存・上書き・印刷）、分割（しおり・サイズ）を通しで確認する。
// 保存先の選択画面（File System Access API）と印刷は、ブラウザの機能を模擬に差し替えて、渡された中身を調べる。
//   node test/e2e/find-save-flow.mjs
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = process.cwd();
const html = process.env.WASHI_HTML ? join(root, process.env.WASHI_HTML) : join(root, "dist", "washi-pdf.html");
const outDir = join(root, "dist", ".e2e");
mkdirSync(outDir, { recursive: true });

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const pdfjsDir = join(require.resolve("pdfjs-dist/package.json"), "..");
const textOf = async (bytes) => {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, standardFontDataUrl: `${join(pdfjsDir, "standard_fonts")}/`, cMapUrl: `${join(pdfjsDir, "cmaps")}/` }).promise;
  let s = "";
  for (let i = 1; i <= pdf.numPages; i++) s += (await (await pdf.getPage(i)).getTextContent()).items.map((it) => it.str ?? "").join("");
  return { text: s.replace(/\s/g, ""), pages: pdf.numPages };
};

const browser = await chromium.launch();
const network = [];
const errors = [];
const fail = async (m) => {
  console.error("NG:", m);
  await browser.close();
  process.exit(1);
};

async function open(files, init) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "ja-JP" });
  const page = await context.newPage();
  // 試験は「ページ全体を表示」で行う（ページ上の位置を、ページ全体が見えている前提で指す）
  await page.addInitScript(() => {
    try {
      localStorage.setItem("washi-pdf.fit", "page");
    } catch {}
  });
  page.on("request", (r) => {
    const u = r.url();
    if (!u.startsWith("file://") && !u.startsWith("blob:") && !u.startsWith("data:")) network.push(u);
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  if (init) await page.addInitScript(init);
  await page.goto("file://" + html);
  await page.waitForSelector(".dropzone", { timeout: 30000 });
  if (await page.$('button:has-text("破棄する")')) await page.click('button:has-text("破棄する")');
  await page.setInputFiles('input[type="file"][accept*="pdf"]', files.map((f) => join(root, "test", "fixtures", f)));
  await page.waitForSelector(".card", { timeout: 30000 });
  return { context, page };
}
const openTool = async (page, name) => {
  await page.click('button[role="tab"]:has-text("ツール")');
  await page.fill(".tool-search input", name);
  // 説明文に同じ語を含むカードがあるので、名前ではなく識別子で選ぶ
  const ids = { しおり: "outline", 分割: "split", 墨消し: "find", "検索と置換": "find", 添付ファイル: "attachments", 文書情報: "metadata" };
  await page.click(ids[name] ? `.tool-card[data-tool="${ids[name]}"]` : `.tool-card:has-text("${name}")`);
  await page.waitForSelector(".modal");
};
const saveByButton = async (page, file) => {
  const [download] = await Promise.all([page.waitForEvent("download"), page.click('button.btn.primary:has-text("保存")')]);
  const p = join(outDir, file);
  await download.saveAs(p);
  return readFileSync(p);
};

/* ---------- 0. PDF を開かずに始める：白紙から／画像から ---------- */
{
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "ja-JP" });
  const page = await context.newPage();
  // 試験は「ページ全体を表示」で行う（ページ上の位置を、ページ全体が見えている前提で指す）
  await page.addInitScript(() => {
    try {
      localStorage.setItem("washi-pdf.fit", "page");
    } catch {}
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("file://" + html);
  await page.waitForSelector(".dropzone", { timeout: 30000 });
  if (await page.$('button:has-text("破棄する")')) await page.click('button:has-text("破棄する")');
  await page.screenshot({ path: join(outDir, "start.png") });
  await page.click('.empty-alt button:has-text("白紙から始める")');
  await page.waitForSelector(".card");
  const blank = await textOf(await saveByButton(page, "start-blank.pdf"));
  if (blank.pages !== 1) await fail("白紙から始めた文書が 1 ページになっていない");
  // 閉じて、画像から
  await page.click('button[title="文書を閉じる"]');
  await page.locator(".confirm-dialog .btn.primary").click();
  await page.waitForSelector(".dropzone");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==", "base64");
  await page.setInputFiles('input[type="file"][accept="image/*"][multiple]', [
    { name: "a.png", mimeType: "image/png", buffer: png },
    { name: "b.png", mimeType: "image/png", buffer: png },
  ]);
  await page.waitForSelector(".modal");
  await page.click(".modal-foot .btn.primary");
  await page.waitForFunction(() => document.querySelectorAll(".card").length === 2, null, { timeout: 30000 });
  const imgs = await textOf(await saveByButton(page, "start-images.pdf"));
  if (imgs.pages !== 2) await fail("画像から始めた文書が 2 ページになっていない");
  console.log("PDF を開かずに開始: 白紙 1 ページ、画像 2 枚 → 2 ページ");
  await context.close();
}

/* ---------- 1. 検索して置換 ---------- */
{
  const { context, page } = await open(["ja-subset-identity.pdf"]);
  await openTool(page, "検索と置換");
  await page.fill('.modal input[type="search"]', "ｻﾝﾌﾟﾙ"); // 半角カナでも見つかる
  await page.waitForFunction(() => document.querySelectorAll(".find-list li").length > 0, null, { timeout: 30000 });
  const n = await page.locator(".find-list li").count();
  await page.fill(".modal .field-row label:nth-child(2) input", "見本");
  await page.screenshot({ path: join(outDir, "find-replace.png") });
  await page.click(".modal-foot .btn.primary");
  await page.waitForSelector(".toast");
  const out = await textOf(await saveByButton(page, "find-replaced.pdf"));
  console.log(`置換: ${n} 件 / 保存後に「見本」あり=${out.text.includes("見本")}、「サンプル」あり=${out.text.includes("サンプル")}`);
  if (!n || !out.text.includes("見本") || out.text.includes("サンプル")) await fail("置換が保存結果に反映されていない");
  // もう一度探すと、書き換えた文字（追加・編集した文字）として見つかる
  await openTool(page, "検索と置換");
  await page.fill('.modal input[type="search"]', "見本");
  await page.waitForFunction(() => document.querySelectorAll(".find-list li").length > 0, null, { timeout: 30000 });
  if (!(await page.locator(".find-list .wareki-flag.plain").count())) await fail("書き換えた文字が検索に出てこない");
  // Ctrl+Z で置換をまとめて取り消せる
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+z");
  const undone = await textOf(await saveByButton(page, "find-undone.pdf"));
  if (!undone.text.includes("サンプル") || undone.text.includes("見本")) await fail("置換を元に戻せていない");
  await context.close();
}

/* ---------- 2. 検索して墨消し ---------- */
{
  const { context, page } = await open(["ja-subset-identity.pdf"]);
  const before = await textOf(readFileSync(join(root, "test", "fixtures", "ja-subset-identity.pdf")));
  await openTool(page, "検索と置換");
  await page.click('.modal .seg button:has-text("墨消し")');
  await page.fill('.modal input[type="search"]', "サンプル");
  await page.waitForFunction(() => document.querySelectorAll(".find-list li").length > 0, null, { timeout: 30000 });
  const n = await page.locator(".find-list li").count();
  const whole = await page.locator(".find-list li.warn").count();
  await page.screenshot({ path: join(outDir, "find-redact.png") });
  await page.click(".modal-foot .btn.primary");
  await page.waitForSelector(".toast");
  const out = await textOf(await saveByButton(page, "find-redacted.pdf"));
  console.log(`墨消し: ${n} 件（行全体 ${whole}） / 文字数 ${before.text.length} → ${out.text.length}、「サンプル」あり=${out.text.includes("サンプル")}`);
  if (!n || whole) await fail("位置を特定できるはずの文字が、行全体の扱いになっている");
  if (out.text.includes("サンプル")) await fail("墨消しした文字が保存結果に残っている");
  // 消えたのは一致した文字だけ（「サンプル」4 文字 × 件数）。前後の文字は残る
  if (before.text.length - out.text.length !== 4 * n) await fail(`消えた文字数が合わない: ${before.text.length - out.text.length} / 期待 ${4 * n}`);
  await context.close();
}

/* ---------- 2b. 保存後の検証の知らせと、行をまたぐ語 ---------- */
{
  const { context, page } = await open(["ja-libreoffice-writer.pdf"]);
  // この文書の本文は 2 行に折り返している。1 行目の終わりと 2 行目の頭をつないだ語を探す
  // 折り返しをまたぐ語を、行の文字から作る（編集画面の行の一覧を使う）
  await page.click('button[role="tab"]:has-text("編集")');
  await page.waitForSelector(".page-canvas");
  await page.click('button.tool:has-text("既存文字")');
  await page.waitForSelector(".run-box", { timeout: 30000 });
  const lines = await page.$$eval(".run-box", (els) => els.map((e) => ({ t: (e.getAttribute("title") ?? "").replace(/^[^:：]*[:：]\s*/, ""), y: e.getBoundingClientRect().top, x: e.getBoundingClientRect().left })));
  lines.sort((a, b) => a.y - b.y);
  let q = null;
  for (let i = 0; i + 1 < lines.length && !q; i++) {
    const a = lines[i], b = lines[i + 1];
    if (a.t.length > 30 && b.t.length > 6 && Math.abs(a.x - b.x) < 3 && b.y - a.y < 30 && !/[A-Za-z0-9]$/.test(a.t)) q = a.t.slice(-3) + b.t.slice(0, 3);
  }
  if (!q) await fail("折り返している段落が見つからない");
  await openTool(page, "検索と置換");
  await page.click('.modal .seg button:has-text("墨消し")');
  await page.fill('.modal input[type="search"]', q);
  await page.waitForFunction(() => document.querySelectorAll(".find-list li").length > 0, null, { timeout: 30000 });
  const spanning = await page.locator(".find-list .find-break").count();
  await page.screenshot({ path: join(outDir, "find-spanning.png") });
  await page.click(".modal-foot .btn.primary");
  await page.waitForSelector(".toast");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click('button.btn.primary:has-text("保存")')]);
  const p = join(outDir, "find-spanning.pdf");
  await download.saveAs(p);
  await page.waitForFunction(() => /墨消しを確認しました/.test(document.querySelector(".toast")?.textContent ?? ""), null, { timeout: 30000 }).catch(() => {});
  const toast = (await page.locator(".toast").textContent().catch(() => "")) ?? "";
  const out = await textOf(readFileSync(p));
  console.log(`行をまたぐ語「${q}」: またぐ一致 ${spanning} 件 / 保存後に残っている=${out.text.includes(q)} / 知らせ: ${toast.replace(/\s+/g, " ").slice(0, 60)}`);
  if (!spanning) await fail("行をまたぐ一致が見つからない");
  if (out.text.includes(q)) await fail("行をまたぐ語が保存結果に残っている");
  if (!/墨消しを確認しました/.test(toast)) await fail("保存後の検証の知らせが出ていない");
  await context.close();
}

/* ---------- 3. 名前を付けて保存 → 以後の保存は同じファイルへ／印刷 ---------- */
{
  const { context, page } = await open(["en-standard14.pdf"], () => {
    // 保存先の選択画面と印刷を模擬に差し替え、書き込まれた中身を window に残す
    window.__writes = [];
    window.showSaveFilePicker = async (o) => ({
      kind: "file",
      name: "chosen.pdf",
      suggested: (window.__suggested = o.suggestedName),
      requestPermission: async () => "granted",
      createWritable: async () => {
        const chunks = [];
        return { write: async (b) => void chunks.push(b), close: async () => void window.__writes.push([...new Uint8Array(await new Blob(chunks).arrayBuffer())]) };
      },
    });
    Object.defineProperty(navigator, "pdfViewerEnabled", { configurable: true, get: () => false });
    window.__opened = [];
    window.open = (u) => void window.__opened.push(u);
  });
  await page.click(".menu-caret");
  await page.screenshot({ path: join(outDir, "save-menu.png") });
  const items = await page.$$eval(".menu-pop button", (els) => els.map((e) => e.textContent.trim()));
  console.log("保存メニュー:", items.join(" / "));
  if (items.some((s) => s.includes("上書き"))) await fail("元のファイルへの参照が無いのに、上書き保存が出ている");
  await page.click('.menu-pop button[data-menu="as"]');
  await page.waitForFunction(() => window.__writes.length === 1, null, { timeout: 30000 });
  const suggested = await page.evaluate(() => window.__suggested);
  if (suggested !== "en-standard14_edited.pdf") await fail(`保存名の候補が違う: ${suggested}`);
  // 以後の保存ボタン・Ctrl+S は、ダウンロードではなく選んだファイルへ
  let downloaded = false;
  page.on("download", () => (downloaded = true));
  await page.keyboard.press("Control+s");
  await page.waitForFunction(() => window.__writes.length === 2, null, { timeout: 30000 });
  const w = await page.evaluate(() => window.__writes[1]);
  const out = await textOf(w);
  if (downloaded || out.pages < 1) await fail("選んだファイルへの保存になっていない");
  console.log(`名前を付けて保存: 候補=${suggested}、書き込み 2 回（${w.length} bytes、${out.pages} ページ）`);
  // 印刷：内蔵ビューアーが無い環境では「PDF を開く」の案内になり、押すと別タブで開く
  await page.click(".menu-caret");
  await page.click('.menu-pop button[data-menu="print"]');
  await page.click('.modal button:has-text("PDF を開く")');
  const opened = await page.evaluate(() => window.__opened);
  if (opened.length !== 1 || !opened[0].startsWith("blob:")) await fail("印刷用の PDF が開かれていない");
  console.log("印刷（直接印刷できない環境）: 別タブで開く案内 → blob を開いた");
  await context.close();
}

/* ---------- 4. 印刷：内蔵ビューアーがあれば、見えない枠に読み込んで印刷を呼ぶ ---------- */
{
  const { context, page } = await open(["en-standard14.pdf"], () => {
    Object.defineProperty(navigator, "pdfViewerEnabled", { configurable: true, get: () => true });
  });
  await page.click(".menu-caret");
  await page.click('.menu-pop button[data-menu="print"]');
  await page.waitForSelector('iframe[src^="blob:"]', { state: "attached", timeout: 30000 });
  console.log("印刷（内蔵ビューアーあり）: 印刷用の枠に PDF を読み込んだ");
  await context.close();
}

/* ---------- 5. 開いた元のファイルへ上書き保存（launchQueue で渡された参照） ---------- */
{
  const bytes = [...readFileSync(join(root, "test", "fixtures", "en-standard14.pdf"))];
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "ja-JP" });
  const page = await context.newPage();
  // 試験は「ページ全体を表示」で行う（ページ上の位置を、ページ全体が見えている前提で指す）
  await page.addInitScript(() => {
    try {
      localStorage.setItem("washi-pdf.fit", "page");
    } catch {}
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript((data) => {
    window.__writes = [];
    const file = new File([new Uint8Array(data)], "launched.pdf", { type: "application/pdf" });
    let current = file;
    const handle = {
      kind: "file",
      name: "launched.pdf",
      // 書き込んだあとは、書いた中身を返す（アプリは保存後に大きさを読み直して確かめる）
      getFile: async () => current,
      requestPermission: async () => "granted",
      createWritable: async () => {
        const chunks = [];
        return {
          write: async (b) => void chunks.push(b),
          close: async () => {
            current = new File(chunks, "launched.pdf", { type: "application/pdf" });
            window.__writes.push(current.size);
          },
        };
      },
    };
    Object.defineProperty(window, "launchQueue", { configurable: true, value: { setConsumer: (fn) => setTimeout(() => fn({ files: [handle] }), 50) } });
    try {
      indexedDB.deleteDatabase("washi-pdf");
    } catch {}
  }, bytes);
  await page.goto("file://" + html);
  await page.waitForSelector(".card", { timeout: 30000 });
  await page.click(".menu-caret");
  await page.click('.menu-pop button[data-menu="overwrite"]');
  // 上書きの前に、アプリの確認（ファイル名つき）が出る
  const confirmText = (await page.locator(".confirm-dialog .confirm-text").textContent({ timeout: 30000 })) ?? "";
  await page.locator(".confirm-dialog .btn.primary").click();
  await page.waitForFunction(() => window.__writes.length === 1, null, { timeout: 30000 });
  if (!confirmText.includes("launched.pdf")) await fail("上書きの前に、ファイル名つきの確認が出ていない");
  console.log("上書き保存: 確認のあと、元のファイルへ書き込んだ");
  await context.close();
}

/* ---------- 6. 分割：サイズごと ---------- */
{
  const { context, page } = await open(["ja-libreoffice-writer.pdf", "images.pdf", "forms.pdf", "ja-subset-identity.pdf"]);
  await page.click('.subbar button:has-text("分割")');
  await page.waitForSelector(".modal");
  await page.click('.modal .seg button:has-text("しおりごと")');
  if (!(await page.locator(".modal .err").count())) await fail("しおりの無い文書で、しおりごとの分割が選べてしまう");
  await page.click('.modal .seg button:has-text("サイズごと")');
  await page.fill('.modal input[type="number"]', "0.1");
  await page.screenshot({ path: join(outDir, "split-size.png") });
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 120000 }), page.click(".modal-foot .btn.primary")]);
  const name = download.suggestedFilename();
  const p = join(outDir, name);
  await download.saveAs(p);
  const zip = readFileSync(p);
  // ZIP（無圧縮）のローカルヘッダーから、各ファイルの名前と大きさを読む
  const files = [];
  for (let o = 0; o + 30 < zip.length && zip.readUInt32LE(o) === 0x04034b50; ) {
    const size = zip.readUInt32LE(o + 18);
    const nameLen = zip.readUInt16LE(o + 26);
    const extraLen = zip.readUInt16LE(o + 28);
    files.push({ name: zip.subarray(o + 30, o + 30 + nameLen).toString("utf8"), size });
    o += 30 + nameLen + extraLen + size;
  }
  console.log("サイズごとの分割:", name, files.map((f) => `${f.name} ${(f.size / 1024).toFixed(0)}KB`).join(" | "));
  if (!name.endsWith(".zip") || files.length < 2) await fail("サイズごとの分割で複数のファイルにならなかった");
  const limit = 0.1 * 1024 * 1024;
  // 上限を超えてよいのは、1 ページだけのファイル（1 ページで上限を超える場合）だけ
  if (files.some((f) => f.size > limit && /-\d+\.pdf$/.test(f.name))) await fail("複数ページのファイルが上限を超えている");
  await context.close();
}

/* ---------- 7. 分割：しおりごと（しおりを 2 つ作ってから分ける） ---------- */
{
  const { context, page } = await open(["ja-libreoffice-writer.pdf", "images.pdf", "forms.pdf", "ja-subset-identity.pdf"]);
  await openTool(page, "しおり");
  for (const [title, pageNo] of [["第1章 はじめに", "2"], ["付録/A:資料", "4"]]) {
    await page.click('.modal-foot button:has-text("項目を追加")');
    const row = page.locator(".outline-row").last();
    await row.locator(".outline-title").fill(title);
    await row.locator('input[type="number"]').fill(pageNo);
  }
  await page.click(".modal-foot .btn.primary");
  await page.click('button[role="tab"]:has-text("ページ整理")');
  await page.click('.subbar button:has-text("分割")');
  await page.click('.modal .seg button:has-text("しおりごと")');
  const names = await page.$$eval(".split-preview li", (els) => els.map((e) => e.textContent.trim().replace(/\s+/g, " ")));
  console.log("しおりごとの分割:", names.join(" | "));
  // 最初のしおりより前（1 ページ目）、第1章（2〜3 ページ）、付録（4 ページ目）。題名のファイル名に使えない文字は置き換える
  const want = [/_p1\.pdf （1 ページ）/, /_1_第1章 はじめに\.pdf （2 ページ）/, /_2_付録 A 資料\.pdf （1 ページ）/];
  if (names.length !== 3 || !want.every((re, i) => re.test(names[i]))) await fail("しおりごとの分け方・ファイル名が期待と違う");
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 120000 }), page.click(".modal-foot .btn.primary")]);
  if (!download.suggestedFilename().endsWith(".zip")) await fail("しおりごとの分割が ZIP になっていない");
  await context.close();
}

/* ---------- 8. スキャン文書：画像の一部だけを墨消し（白黒のファクス形式・JPEG 2000・JPEG） ---------- */
{
  const { PDFDocument, PDFName } = require("pdf-lib");
  const { context, page } = await open(["scan.pdf"]);
  await page.click('button[role="tab"]:has-text("編集")');
  await page.waitForSelector(".page-canvas");
  for (let n = 0; n < 3; n++) {
    await page.waitForFunction(() => !document.querySelector(".page-loading"));
    await page.click('button.tool:has-text("墨消し")');
    const bb = await page.locator(".page").first().boundingBox();
    // ページの中ほど左側を囲む
    await page.mouse.move(bb.x + bb.width * 0.12, bb.y + bb.height * 0.43);
    await page.mouse.down();
    await page.mouse.move(bb.x + bb.width * 0.52, bb.y + bb.height * 0.54, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    if (n < 2) {
      await page.keyboard.press("PageDown");
      // ページ送りは次の描き直しで行われる。編集するページが次のページになるのを待つ
      await page.waitForFunction((k) => document.querySelector(".pager")?.textContent?.trim().startsWith(`${k} /`), n + 2);
    }
  }
  await page.screenshot({ path: join(outDir, "scan-redact.png") });
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 120000 }), page.click('button.btn.primary:has-text("保存")')]);
  const p = join(outDir, "scan-redacted.pdf");
  await download.saveAs(p);
  await page.waitForTimeout(800);
  const toast = ((await page.locator(".toast").textContent().catch(() => "")) ?? "").replace(/\s+/g, " ");
  const lib = await PDFDocument.load(readFileSync(p), { updateMetadata: false });
  const kinds = lib.getPages().map((pg) => {
    const xo = pg.node.Resources().lookup(PDFName.of("XObject"));
    return [...xo.entries()].map(([k, v]) => `${k.decodeText().replace(/\d+$/, "")}:${String(lib.context.lookup(v).dict.get(PDFName.of("Filter")))}/${String(lib.context.lookup(v).dict.get(PDFName.of("BitsPerComponent")))}bit`).join(",");
  });
  let images = 0;
  for (const [, o] of lib.context.enumerateIndirectObjects()) if (o.dict && String(o.dict.get(PDFName.of("Subtype"))) === "/Image") images++;
  console.log(`スキャン文書の墨消し: ${kinds.join(" | ")} / ファイル内の画像 ${images} 枚 / 知らせ: ${toast.slice(0, 70) || "(なし)"}`);
  if (/全体を取り除きました/.test(toast)) await fail("画像の一部だけを消せず、全体を取り除いている");
  if (images !== 3 || !kinds.every((k) => k.startsWith("WashiRedacted:"))) await fail("塗りつぶした複製に入れ替わっていない、または元の画像が残っている");
  await context.close();
}

await browser.close();
if (network.length) {
  console.error("外部への通信が発生しました:", network);
  process.exit(1);
}
if (errors.length) {
  console.error("ブラウザのエラー:", errors);
  process.exit(1);
}
console.log("OK: 検索と置換・墨消し、保存メニュー、印刷、分割（通信ゼロ、エラーなし）");

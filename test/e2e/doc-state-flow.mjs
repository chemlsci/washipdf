// 文書の状態と保存の安全性（組み合わせ操作で起きた不具合の再発防止）。
//  1. すべてのページを消してから別の文書を開いても、前の文書の設定（パスワード保護・グレースケール）と保存先を引き継がない
//  2. すべてのページを消したあとに開き直しても、消した文書の復元を尋ねない
//  3. 復元を尋ねている間に開いたファイルは、答えが出るまで待たせる（復元で黙って置き換えない・下書きを黙って捨てない）
//  4. フォーム入力 → 元に戻す のあとも、ページが表示でき、保存でき、自動保存も続く
//  5. 元のファイルへの上書きに失敗しても、元のファイルを消さない
//  6. 自動保存されない文書（パスワード付きで開いた PDF）では、理由を知らせ、閉じる前に確かめる
//  7. 復元した文書に、前回はパスワード保護を設定していたことを知らせる。自動保存の入り切りと期限
//  8. 注釈の種類が constructor の PDF でも、注釈の一覧で画面が消えない。描画の例外は案内に置き換わる
//  9. 保存前の点検に通らない PDF は、選んだファイルに書き込まない
//   node test/e2e/doc-state-flow.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { PDFDocument, PDFName, StandardFonts } = require("pdf-lib");

const root = process.cwd();
const html = "file://" + (process.env.WASHI_HTML ? join(root, process.env.WASHI_HTML) : join(root, "dist", "washi-pdf.html"));
const outDir = join(root, "dist", ".e2e");
mkdirSync(outDir, { recursive: true });
const fx = (n) => join(root, "test", "fixtures", n);

const browser = await chromium.launch();
const fail = async (m) => {
  console.error("FAIL:", m);
  await browser.close();
  process.exit(1);
};

/** 新しいブラウザーの状態（保存領域も空）でアプリを開く */
async function start(init, arg) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "ja-JP", acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  // 試験は「ページ全体を表示」で行う（ページ上の位置を、ページ全体が見えている前提で指す）
  await page.addInitScript(() => {
    try {
      localStorage.setItem("washi-pdf.fit", "page");
      // この試験は自動保存を前提にする（ファイルで開いた版の既定は「切」）。試験の中で切り替えたあとは、その設定を残す
      if (localStorage.getItem("washi-pdf.autosave") == null) localStorage.setItem("washi-pdf.autosave", "on");
    } catch {}
  });
  if (init) await page.addInitScript(init, arg);
  const errors = [];
  const network = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("request", (r) => {
    const u = r.url();
    if (!u.startsWith("file://") && !u.startsWith("blob:") && !u.startsWith("data:")) network.push(u);
  });
  await page.goto(html);
  await page.waitForSelector(".dropzone");
  return { context, page, errors, network };
}
const idle = async (page) => {
  await page.waitForFunction(() => !document.querySelector(".busy"), null, { timeout: 120000 });
  await page.waitForTimeout(250);
};
const openFiles = async (page, files, cards) => {
  await page.setInputFiles('input[type="file"][accept*="pdf"]', files);
  await page.waitForFunction((n) => document.querySelectorAll(".card").length === n, cards);
  await idle(page);
};
const tab = async (page, name) => {
  await page.click(`button[role="tab"]:has-text("${name}")`);
  await page.waitForTimeout(250);
};
const confirmYes = async (page) => {
  await page.waitForSelector(".confirm-dialog");
  await page.click(".confirm-dialog button.primary");
  await page.waitForTimeout(250);
};
const deleteAll = async (page) => {
  await tab(page, "ページ整理");
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await confirmYes(page);
  await page.waitForSelector(".dropzone");
};
const toasts = (page) => page.evaluate(() => [...document.querySelectorAll(".toast")].map((e) => e.textContent).join(" | "));
const title = (page) => page.locator(".doc-title").innerText().catch(() => "");
const finish = async ({ context, errors, network }, label) => {
  if (errors.length) await fail(`${label}: ページのエラー: ${errors[0]}`);
  if (network.length) await fail(`${label}: 外部への通信: ${network[0]}`);
  await context.close();
};
/** 自動保存が書かれるのを待つ（変更が落ち着いてから 1.5 秒後に書く） */
const waitAutosave = (page) => page.waitForTimeout(2600);
const asksRestore = async (page) => {
  await page.waitForSelector(".dropzone");
  await page.waitForTimeout(1200);
  return (await page.locator('button:has-text("復元する")').count()) > 0;
};
const leaveBlocked = (page) =>
  page.evaluate(() => {
    const e = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });

/* ---------- 1. 全ページ削除 → 別の文書：設定と保存先を引き継がない ---------- */
{
  const s = await start(() => {
    window.__writes = [];
    window.showSaveFilePicker = async () => {
      let data = new Uint8Array(0);
      return {
        kind: "file",
        name: "A-saved.pdf",
        requestPermission: async () => "granted",
        queryPermission: async () => "granted",
        createWritable: async () => ({
          write: async (b) => {
            data = b instanceof Blob ? new Uint8Array(await b.arrayBuffer()) : new Uint8Array(b);
          },
          close: async () => void window.__writes.push(data.length),
          abort: async () => {},
        }),
        getFile: async () => new File([data], "A-saved.pdf", { lastModified: 1 + window.__writes.length }),
      };
    };
  });
  const { page } = s;
  await openFiles(page, fx("en-standard14.pdf"), 1);
  await tab(page, "ツール");
  await page.click('.tool-card[data-tool="grayscale"]');
  await page.click('.tool-card[data-tool="protect"]');
  await page.locator('.modal input[type="checkbox"]').first().check();
  await page.locator('.modal input[type="password"]').first().fill("secret1");
  await page.click(".modal .modal-foot button.primary");
  await page.waitForSelector('.tool-card.active[data-tool="protect"]');
  await page.click(".split-btn .menu-caret");
  await page.click('[data-menu="as"]');
  await page.waitForFunction(() => window.__writes.length === 1);
  await idle(page);
  if (!(await page.locator(".split-btn > button.primary").getAttribute("title")).includes("A-saved.pdf")) await fail("1: 保存先が設定されていない（試験の前提）");
  await deleteAll(page);
  await openFiles(page, fx("ja-vertical.pdf"), 1);
  await tab(page, "ツール");
  const active = await page.$$eval(".tool-card.active", (els) => els.map((e) => e.dataset.tool));
  if (active.length) await fail(`1: 前の文書の設定が残っている: ${active}`);
  const saveTitle = await page.locator(".split-btn > button.primary").getAttribute("title");
  if (saveTitle.includes("A-saved")) await fail(`1: 前の文書の保存先が残っている: ${saveTitle}`);
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.click('button.btn.primary:has-text("保存")')]);
  await idle(page);
  const file = join(outDir, "doc-state-1.pdf");
  await dl.saveAs(file);
  if ((await page.evaluate(() => window.__writes.length)) !== 1) await fail("1: 新しい文書が、前の文書の保存先に書き込まれた");
  if (!dl.suggestedFilename().startsWith("ja-vertical")) await fail(`1: 保存の名前が新しい文書のものでない: ${dl.suggestedFilename()}`);
  if (readFileSync(file).includes("/Encrypt")) await fail("1: 前の文書のパスワード保護が、新しい文書に掛かった");
  // 「元に戻す」で、前の文書へ戻れない
  for (let i = 0; i < 8; i++) await page.keyboard.press("Control+z");
  await page.waitForTimeout(300);
  await tab(page, "ページ整理");
  if (!(await title(page)).includes("ja-vertical") || (await page.locator(".card").count()) !== 1) await fail(`1: 元に戻すで、前の文書の状態に戻った（${await title(page)}、${await page.locator(".card").count()} ページ）`);
  console.log("ok  1. 全ページ削除 → 別の文書：設定・保存先・履歴を引き継がない");
  await finish(s, "1");
}

/* ---------- 1b. 全ページ削除 → 白紙・画像から始める ---------- */
{
  const s = await start();
  const { page } = s;
  const png = join(outDir, "doc-state-dot.png");
  // 1×1 の PNG（赤）
  writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64"));
  const setGray = async () => {
    await tab(page, "ツール");
    await page.click('.tool-card[data-tool="grayscale"]');
    await page.waitForSelector('.tool-card.active[data-tool="grayscale"]');
  };
  const activeTools = async () => {
    await tab(page, "ツール");
    return page.$$eval(".tool-card.active", (els) => els.map((e) => e.dataset.tool));
  };
  await openFiles(page, fx("en-standard14.pdf"), 1);
  await setGray();
  await deleteAll(page);
  // 画像を選んだが、用紙の設定で取りやめた：前の文書は「元に戻す」でまだ戻せる
  await page.setInputFiles('input[type="file"][accept="image/*"][multiple]', png);
  await page.waitForSelector(".modal");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await page.keyboard.press("Control+z");
  await page.waitForSelector(".card");
  if (!(await title(page)).includes("en-standard14")) await fail("1b: 画像の取り込みを取りやめたのに、前の文書に戻せない");
  if (!(await activeTools()).includes("grayscale")) await fail("1b: 戻した文書の設定が消えている");
  // 画像から始める：前の文書の設定を引き継がない
  await deleteAll(page);
  await page.setInputFiles('input[type="file"][accept="image/*"][multiple]', png);
  await page.waitForSelector(".modal");
  await page.click(".modal .modal-foot button.primary");
  await page.waitForSelector(".card");
  await idle(page);
  if ((await activeTools()).length) await fail(`1b: 画像から始めた文書に、前の文書の設定が残っている: ${await activeTools()}`);
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(300);
  if ((await title(page)).includes("en-standard14")) await fail("1b: 元に戻すで、前の文書の状態に戻った");
  // 白紙から始める：同じく引き継がない
  await setGray();
  await deleteAll(page);
  await page.click('.empty-alt button:has-text("白紙から始める")');
  await page.waitForSelector(".card");
  if ((await activeTools()).length) await fail(`1b: 白紙から始めた文書に、前の文書の設定が残っている: ${await activeTools()}`);
  console.log("ok  1b. 全ページ削除 → 白紙・画像から始める：引き継がない（取りやめたときは、前の文書に戻せる）");
  await finish(s, "1b");
}

/* ---------- 2. 全ページ削除 → 開き直し：消した文書の復元を尋ねない ---------- */
{
  const s = await start();
  const { page } = s;
  await openFiles(page, fx("en-standard14.pdf"), 1);
  await waitAutosave(page);
  await deleteAll(page);
  // 「元に戻す」でページが戻る（同じ文書の続き）
  await page.keyboard.press("Control+z");
  await page.waitForSelector(".card");
  await waitAutosave(page);
  await page.reload();
  if (!(await asksRestore(page))) await fail("2: ページを戻したあとの文書が自動保存されていない");
  await page.click('button:has-text("復元する")');
  await page.waitForSelector(".card");
  await idle(page);
  await deleteAll(page);
  await page.waitForTimeout(800);
  await page.reload();
  if (await asksRestore(page)) await fail("2: すべてのページを消した文書の復元を尋ねた");
  console.log("ok  2. 全ページ削除 → 開き直し：復元を尋ねない（元に戻せば、また自動保存される）");
  await finish(s, "2");
}

/* ---------- 3. 復元を尋ねている間に開いたファイル ---------- */
{
  const s = await start();
  const { page } = s;
  await openFiles(page, fx("en-standard14.pdf"), 1);
  await waitAutosave(page);
  await page.reload();
  if (!(await asksRestore(page))) await fail("3: 復元を尋ねない（試験の前提）");
  await page.setInputFiles('input[type="file"][accept*="pdf"]', fx("ja-vertical.pdf"));
  await page.waitForTimeout(1500);
  if (await page.locator(".card").count()) await fail("3: 尋ねている後ろで、ファイルが開かれた");
  const note = await page.locator(".modal .note").innerText().catch(() => "");
  if (!note.includes("ja-vertical.pdf")) await fail(`3: 開こうとしているファイルの案内が出ていない: ${note}`);
  await page.screenshot({ path: join(outDir, "doc-state-3-pending.png") });
  await page.click('button:has-text("復元する")');
  await page.waitForSelector(".card");
  await idle(page);
  if (!(await title(page)).includes("en-standard14")) await fail(`3: 復元したのに、前回の文書になっていない: ${await title(page)}`);
  // もう一度：今度は破棄して、開こうとしていたファイルを開く
  await waitAutosave(page);
  await page.reload();
  if (!(await asksRestore(page))) await fail("3: 2 回目に復元を尋ねない");
  await page.setInputFiles('input[type="file"][accept*="pdf"]', fx("ja-vertical.pdf"));
  await page.waitForTimeout(800);
  await page.click('button:has-text("破棄する")');
  await page.waitForSelector(".card");
  await idle(page);
  if (!(await title(page)).includes("ja-vertical")) await fail(`3: 破棄したのに、開こうとしたファイルが開かれていない: ${await title(page)}`);
  console.log("ok  3. 復元を尋ねている間に開いたファイル：答えが出るまで待ち、選んだとおりになる");
  await finish(s, "3");
}

/* ---------- 4. フォーム入力 → 元に戻す ---------- */
{
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const form = d.getForm();
  for (let i = 0; i < 3; i++) {
    const p = d.addPage([400, 300]);
    p.drawText(`Form page ${i + 1}`, { x: 30, y: 260, size: 16, font });
    const t = form.createTextField(`name${i + 1}`);
    t.setText(`init${i + 1}`);
    t.addToPage(p, { x: 30, y: 200, width: 200, height: 24 });
  }
  const formPdf = join(outDir, "doc-state-form.pdf");
  writeFileSync(formPdf, await d.save());
  const fieldValue = async (file) => (await PDFDocument.load(readFileSync(file))).getForm().getTextField("name1").getText();

  const s = await start();
  const { page } = s;
  await openFiles(page, formPdf, 3);
  await tab(page, "ツール");
  await page.click('.tool-card[data-tool="form"]');
  await page.waitForSelector(".modal .form-list input, .modal input:not([type])");
  const first = page.locator(".modal input:not([type]), .modal input[type='text']").first();
  await first.fill("FILLED-A");
  await page.click(".modal .modal-foot button.primary");
  await idle(page);
  await page.waitForTimeout(600);
  const save = async (name) => {
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.click('button.btn.primary:has-text("保存")')]);
    await idle(page);
    const f = join(outDir, name);
    await dl.saveAs(f);
    return f;
  };
  if ((await fieldValue(await save("doc-state-4-filled.pdf"))) !== "FILLED-A") await fail("4: 入力した値が保存されていない（試験の前提）");
  // 元に戻す → ページが表示でき、保存できる
  await page.keyboard.press("Control+z");
  // 使われなくなった元 PDF の片付けが走っても、履歴から行ける先のものは残っている
  await page.waitForTimeout(4500);
  await tab(page, "編集");
  await page.waitForSelector(".page-slot.current .page-canvas");
  await page.waitForFunction(() => !document.querySelector(".page-slot.current .page-loading"));
  await page.waitForTimeout(500);
  const ink = await page.evaluate(() => {
    const c = document.querySelector(".page-slot.current .page-canvas");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) n++;
    return n;
  });
  if (ink < 50) await fail(`4: 元に戻したあと、ページが白紙になっている（${ink}）`);
  const undone = await save("doc-state-4-undone.pdf");
  const t4 = await toasts(page);
  if (/見つかりません/.test(t4)) await fail(`4: 元に戻したあと保存できない: ${t4}`);
  if ((await fieldValue(undone)) !== "init1") await fail(`4: 元に戻した状態で保存されていない: ${await fieldValue(undone)}`);
  // やり直す → 入力した値に戻る
  await page.keyboard.press("Control+Shift+z");
  await page.waitForTimeout(500);
  if ((await fieldValue(await save("doc-state-4-redone.pdf"))) !== "FILLED-A") await fail("4: やり直したあと、入力した値で保存されない");
  // 元に戻した状態でも自動保存が続く
  await page.keyboard.press("Control+z");
  await waitAutosave(page);
  await page.reload();
  if (!(await asksRestore(page))) await fail("4: 元に戻したあと、自動保存されていない");
  await page.click('button:has-text("復元する")');
  await page.waitForFunction(() => document.querySelectorAll(".card").length === 3);
  await idle(page);
  if ((await fieldValue(await save("doc-state-4-restored.pdf"))) !== "init1") await fail("4: 復元した文書が、元に戻した状態でない");
  console.log("ok  4. フォーム入力 → 元に戻す：ページが表示でき、保存でき、自動保存も続く");
  await finish(s, "4");
}

/* ---------- 5. 元のファイルへの上書き保存 ---------- */
for (const mode of ["書き込みが失敗する", "書ける"]) {
  const bytes = [...readFileSync(fx("ja-subset-identity.pdf"))];
  const s = await start(
    ({ bytes, failing }) => {
      window.__ev = [];
      let content = new Uint8Array(bytes);
      let modified = 1000;
      window.__size = () => content.length;
      window.showOpenFilePicker = async () => [
        {
          kind: "file",
          name: "contract.pdf",
          requestPermission: async () => "granted",
          queryPermission: async () => "granted",
          getFile: async () => new File([content], "contract.pdf", { type: "application/pdf", lastModified: modified }),
          createWritable: async () => {
            let pending = null;
            window.__ev.push("createWritable");
            return {
              write: async (b) => {
                if (failing) {
                  window.__ev.push("write-failed");
                  throw new DOMException("disk full", "QuotaExceededError");
                }
                pending = b instanceof Blob ? new Uint8Array(await b.arrayBuffer()) : new Uint8Array(b);
              },
              close: async () => {
                window.__ev.push("close");
                content = pending ?? new Uint8Array(0);
                modified++;
              },
              abort: async () => void window.__ev.push("abort"),
            };
          },
          remove: async () => {
            window.__ev.push("remove");
            content = new Uint8Array(0);
          },
        },
      ];
    },
    { bytes, failing: mode === "書き込みが失敗する" },
  );
  const { page } = s;
  await page.click(".dropzone");
  await page.waitForSelector(".card");
  await idle(page);
  await page.click(".split-btn .menu-caret");
  await page.click('[data-menu="overwrite"]');
  const dlP = page.waitForEvent("download", { timeout: 20000 }).catch(() => null);
  await confirmYes(page);
  await idle(page);
  await page.waitForSelector(".toast");
  const ev = await page.evaluate(() => window.__ev);
  const size = await page.evaluate(() => window.__size());
  const toast = await toasts(page);
  if (ev.includes("remove")) await fail(`5（${mode}）: 元のファイルを消した: ${ev}`);
  if (mode === "書き込みが失敗する") {
    const dl = await dlP;
    if (size !== bytes.length) await fail(`5: 元のファイルの中身が変わった（${size} B）`);
    if (ev.includes("close")) await fail(`5: 失敗した書き込みを確定した: ${ev}`);
    if (!dl) await fail("5: 編集後の PDF がダウンロードとして渡されていない");
    if (!toast.includes("元の内容はそのまま") || !toast.includes("ダウンロード")) await fail(`5: 知らせが正しくない: ${toast}`);
    // 元のファイルは無事なので、上書き保存はもう一度試せる
    await page.click(".split-btn .menu-caret");
    if (!(await page.locator('[data-menu="overwrite"]').count())) await fail("5: 失敗のあと、上書き保存を選べなくなった");
  } else {
    if (size === bytes.length || size < 1000) await fail(`5: 上書きされていない（${size} B）`);
    if (!toast.includes("保存しました")) await fail(`5: 保存の知らせが出ていない: ${toast}`);
  }
  console.log(`ok  5. 元のファイルに上書き保存（${mode}）：${ev.join(" → ")}`);
  await finish(s, "5");
}

/* ---------- 6. 自動保存されない文書：理由を知らせ、閉じる前に確かめる ---------- */
{
  const s = await start();
  const { page } = s;
  await page.setInputFiles('input[type="file"][accept*="pdf"]', fx("enc-aes-256.pdf"));
  const dlg = page.locator('.modal[aria-label="パスワードが必要です"]');
  await dlg.waitFor();
  await dlg.locator('input[type="password"]').fill("user");
  await dlg.locator('input[type="password"]').press("Enter");
  await page.waitForSelector(".card");
  await page.waitForSelector('.toast:has-text("自動保存されません")', { timeout: 20000 }).catch(() => fail("6: 自動保存されないことを知らせていない"));
  const text = await toasts(page);
  if (!text.includes("パスワード付き")) await fail(`6: 理由が書かれていない: ${text}`);
  if (await leaveBlocked(page)) await fail("6: 編集していないのに、閉じる前の確認が出る");
  await tab(page, "ツール");
  await page.click('.tool-card[data-tool="grayscale"]');
  await page.waitForTimeout(300);
  if (!(await leaveBlocked(page))) await fail("6: 自動保存されない文書を編集したのに、閉じる前の確認が出ない");
  // 保存すれば、確認は出ない
  await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.click('button.btn.primary:has-text("保存")')]);
  await idle(page);
  if (await leaveBlocked(page)) await fail("6: 保存したあとも、閉じる前の確認が出る");
  // 知らせは文書ごとに 1 回だけ
  await page.click('.tool-card[data-tool="grayscale"]');
  await page.waitForTimeout(4000);
  if ((await toasts(page)).includes("自動保存されません")) await fail("6: 同じ文書で、同じ知らせを繰り返した");
  console.log("ok  6. 自動保存されない文書：理由を 1 回知らせ、保存していない編集があれば閉じる前に確かめる");
  await finish(s, "6");
}

/* ---------- 7. 復元と保護、自動保存の入り切り、期限 ---------- */
{
  const s = await start();
  const { page } = s;
  await openFiles(page, fx("en-standard14.pdf"), 1);
  await tab(page, "ツール");
  await page.click('.tool-card[data-tool="protect"]');
  await page.locator('.modal input[type="checkbox"]').first().check();
  await page.locator('.modal input[type="password"]').first().fill("secret1");
  await page.click(".modal .modal-foot button.primary");
  await waitAutosave(page);
  // 自動保存されている文書では、閉じる前の確認は出ない
  if (await leaveBlocked(page)) await fail("7: 自動保存されているのに、閉じる前の確認が出る");
  // 下書きにパスワードは入っていない
  const stored = await page.evaluate(
    () =>
      new Promise((res) => {
        const r = indexedDB.open("washi-pdf");
        r.onsuccess = () => {
          const q = r.result.transaction("draft").objectStore("draft").get("state");
          q.onsuccess = () => res(JSON.stringify(q.result));
        };
      }),
  );
  if (stored.includes("secret1")) await fail("7: 下書きにパスワードが残っている");
  await page.reload();
  if (!(await asksRestore(page))) await fail("7: 復元を尋ねない");
  await page.click('button:has-text("復元する")');
  await page.waitForSelector(".card");
  await page.waitForSelector(".toast");
  const t7 = await toasts(page);
  if (!t7.includes("パスワード保護") || !t7.includes("設定し直")) await fail(`7: 保護を設定し直すよう知らせていない: ${t7}`);
  await tab(page, "ツール");
  if (await page.locator('.tool-card.active[data-tool="protect"]').count()) await fail("7: パスワードなしで保護が有効になっている");
  // 期限：最後の自動保存から 7 日を過ぎた下書きは、次に開いたときに消える
  await waitAutosave(page);
  await page.evaluate(
    () =>
      new Promise((res) => {
        const r = indexedDB.open("washi-pdf");
        r.onsuccess = () => {
          const tx = r.result.transaction("draft", "readwrite");
          const st = tx.objectStore("draft");
          const q = st.get("state");
          q.onsuccess = () => st.put({ ...q.result, savedAt: Date.now() - 8 * 24 * 3600 * 1000 }, "state");
          tx.oncomplete = () => res();
        };
      }),
  );
  await page.goto("about:blank");
  await page.goto(html);
  if (await asksRestore(page)) await fail("7: 期限を過ぎた下書きの復元を尋ねた");
  const keys = await page.evaluate(
    () =>
      new Promise((res) => {
        const r = indexedDB.open("washi-pdf");
        r.onsuccess = () => {
          const q = r.result.transaction("draft").objectStore("draft").getAllKeys();
          q.onsuccess = () => res(q.result.length);
        };
      }),
  );
  if (keys) await fail(`7: 期限を過ぎた下書きが消えていない（${keys} 件）`);
  // 自動保存を切る：残っている下書きも消え、以後は書かれない
  await openFiles(page, fx("en-standard14.pdf"), 1);
  await waitAutosave(page);
  await page.click('header button[title="このソフトについて"]');
  const toggle = page.locator('.modal label.checkbox:has-text("自動保存する") input');
  await toggle.waitFor();
  if (!(await toggle.isChecked())) await fail("7: 自動保存の既定が「入」でない");
  await page.screenshot({ path: join(outDir, "doc-state-7-about.png") });
  await toggle.uncheck();
  await page.keyboard.press("Escape");
  await tab(page, "ツール");
  await page.click('.tool-card[data-tool="grayscale"]');
  await waitAutosave(page);
  if (!(await leaveBlocked(page))) await fail("7: 自動保存を切った文書を編集したのに、閉じる前の確認が出ない");
  await page.goto("about:blank");
  await page.goto(html);
  if (await asksRestore(page)) await fail("7: 自動保存を切ったのに、下書きが残っている");
  console.log("ok  7. 復元で保護の設定し直しを知らせる／期限切れの下書きは消える／自動保存を切ると残さない");
  await finish(s, "7");
}

/* ---------- 8. 注釈の種類が constructor の PDF、描画の例外 ---------- */
{
  const d = await PDFDocument.create();
  const p = d.addPage([300, 300]);
  p.drawText("hostile subtype", { x: 20, y: 150, size: 14 });
  const mk = (sub) => d.context.register(d.context.obj({ Type: "Annot", Subtype: sub, Rect: [20, 20, 120, 60], F: 4 }));
  p.node.set(PDFName.of("Annots"), d.context.obj([mk("constructor"), mk("toString"), mk("__proto__"), mk("Square")]));
  const evil = join(outDir, "doc-state-subtype.pdf");
  writeFileSync(evil, await d.save());
  const s = await start();
  const { page } = s;
  await openFiles(page, evil, 1);
  await tab(page, "ツール");
  await page.click('.tool-card[data-tool="annotList"]');
  await page.waitForSelector(".modal");
  await page.waitForTimeout(1500);
  if (!(await page.locator("header.topbar").count()) || !(await page.locator(".modal").count())) await fail("8: 注釈の一覧を開いたら、画面が消えた");
  const rows = await page.locator(".modal .annot-row, .modal .annot-item, .modal li").count();
  await page.keyboard.press("Escape");
  // 描画の例外：ダイアログの中で例外が出ても、案内に置き換わり、閉じれば続けられる（文書は残る）
  await page.evaluate(() => {
    window.__real = Date.prototype.toLocaleString;
    Date.prototype.toLocaleString = () => {
      throw new Error("boom in render");
    };
  });
  await page.click('header button[title="このソフトについて"]');
  await page.waitForSelector(".crash", { timeout: 10000 }).catch(() => fail("8: 描画の例外が案内に置き換わらない"));
  const crash = (await page.locator(".modal h2").first().innerText()) + "\n" + (await page.locator(".crash").innerText());
  if (!crash.includes("問題が起きました") || !crash.includes("文書と編集内容は残っています") || !crash.includes("boom in render")) await fail(`8: 案内の内容が違う: ${crash}`);
  await page.screenshot({ path: join(outDir, "doc-state-8-crash.png") });
  await page.evaluate(() => (Date.prototype.toLocaleString = window.__real));
  await page.click('.crash button:has-text("続ける")');
  await page.waitForTimeout(300);
  if (await page.locator(".crash").count()) await fail("8: 「続ける」で案内が閉じない");
  await tab(page, "ページ整理");
  if ((await page.locator(".card").count()) !== 1) await fail("8: 例外のあと、文書が失われた");
  s.errors.length = 0; // わざと起こした例外（React が報告する）は数えない
  console.log(`ok  8. 注釈の種類が constructor の PDF でも一覧が開く（${rows} 件）／描画の例外は案内になり、続けられる`);
  await finish(s, "8");
}

/* ---------- 9. 保存前の点検に通らない PDF は、選んだファイルに書き込まない ---------- */
{
  const s = await start(() => {
    // pdf.js のワーカーを捕まえておく（あとで、開き直しの点検だけを失敗させるため）
    window.__workers = [];
    const W = window.Worker;
    window.Worker = class extends W {
      constructor(...a) {
        super(...a);
        window.__workers.push(this);
      }
    };
    window.__writes = 0;
    window.showSaveFilePicker = async () => ({
      kind: "file",
      name: "target.pdf",
      requestPermission: async () => "granted",
      queryPermission: async () => "granted",
      createWritable: async () => ({ write: async () => void window.__writes++, close: async () => {}, abort: async () => {} }),
      getFile: async () => new File([], "target.pdf"),
      remove: async () => void (window.__removed = (window.__removed ?? 0) + 1),
    });
  });
  const { page } = s;
  await openFiles(page, fx("en-standard14.pdf"), 1);
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    for (const w of window.__workers)
      w.postMessage = () => {
        throw new Error("worker gone");
      };
  });
  await page.click(".split-btn .menu-caret");
  await page.click('[data-menu="as"]');
  await page.waitForSelector(".confirm-dialog", { timeout: 60000 }).catch(() => fail("9: 点検に通らないのに、確認が出ない"));
  const text = await page.locator(".confirm-dialog").innerText();
  if (!text.includes("開き直して確かめた") || !text.includes("変更していません")) await fail(`9: 確認の文が違う: ${text}`);
  if (await page.evaluate(() => window.__writes)) await fail("9: 点検に通らない PDF を、選んだファイルに書き込んだ");
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }), page.click(".confirm-dialog button.primary")]);
  if (!dl) await fail("9: ダウンロードを選んでも渡されない");
  if (await page.evaluate(() => window.__writes)) await fail("9: ダウンロードを選んだのに、選んだファイルに書き込んだ");
  await page.waitForFunction(() => window.__removed === 1, null, { timeout: 5000 }).catch(() => fail("9: 保存先を選んだときにできた空のファイルが残っている"));
  if ((await page.locator(".split-btn > button.primary").getAttribute("title")).includes("target.pdf")) await fail("9: 書き込まなかったファイルが、保存先として残っている");
  s.errors.length = 0;
  console.log("ok  9. 保存前の点検に通らない PDF：選んだファイルには書かず、ダウンロードするかを尋ねる");
  await finish(s, "9");
}

await browser.close();
console.log("doc-state-flow: OK");

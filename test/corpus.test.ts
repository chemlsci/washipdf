/**
 * 実文書での一括確認。CORPUS に PDF を置いたフォルダを指定したときだけ動く（指定が無ければ何もしない）。
 *   CORPUS=/path/to/pdfs node scripts/test.mjs --filter corpus
 * 各文書について、読み込み・文字の解析・無編集の再保存（見た目が変わらないか）・一括置換・一括墨消し・
 * 保存後の検証までを行い、結果を 1 行ずつ出す（CORPUS_OUT を指定すると JSON でも保存する）。合否は付けず、報告だけする。
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { defaultSettings, type DocSettings } from "@/lib/docOps";
import { createTextEdit } from "@/lib/editModel";
import { fillForm, readFormFields } from "@/lib/forms";
import { getLibDoc } from "@/lib/libDoc";
import { readOutlines } from "@/lib/outlines";
import { buildPdf } from "@/lib/exportPdf";
import { findMatches, lineBoxes, matchBoxes, replaceMatches, SHAPED_SCRIPT } from "@/lib/findText";
import type { RedactCheck } from "@/lib/redactCheck";
import { getPageText, type TextRun } from "@/lib/textRuns";
import type { EditObj, PageItem, RedactObj } from "@/lib/types";
import { diffOutside, loadSource, openPdf, pageText, renderPage, savePng } from "./helpers";

/** n×n 画素の平均に縮める */
function shrink(img: { data: Uint8ClampedArray; width: number; height: number }, n: number) {
  const w = Math.floor(img.width / n);
  const h = Math.floor(img.height / n);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) sum += img.data[((y * n + j) * img.width + x * n + i) * 4 + c];
        data[(y * w + x) * 4 + c] = sum / (n * n);
      }
  return { data, width: w, height: h };
}

const DIR = process.env.CORPUS;
const MAX_PAGES = Number(process.env.CORPUS_PAGES ?? 12);
const count = (hay: string, q: string) => (q ? hay.split(q).length - 1 : 0);
const squash = (s: string) => s.replace(/\s+/g, "");

/** 編集できる行の中から、よく出てくる語（日本語は 2〜3 文字、英語は 4 文字以上の単語）を選ぶ */
function pickQuery(runs: TextRun[], any = false): string | null {
  const freq = new Map<string, number>();
  for (const r of runs) {
    if ((!r.editable && !any) || r.vertical) continue;
    for (const w of r.text.match(/[A-Za-z]{4,10}/g) ?? []) freq.set(w, (freq.get(w) ?? 0) + 1);
    for (const w of r.text.match(/[一-鿿]{2,3}|[ァ-ヶー]{3,5}/g) ?? []) freq.set(w, (freq.get(w) ?? 0) + 1);
    // そのほかの文字（キリル、ハングル、アラビア、インド系、クメール、声調記号つきのラテン など）：空白で区切られた語
    for (const w of r.text.match(/[\p{L}\p{M}]{3,12}/gu) ?? []) if (!/^[A-Za-z一-鿿ァ-ヶー]+$/.test(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  const best = [...freq].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : ([...freq].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null);
}

test("実文書での一括確認", { skip: !DIR || !existsSync(DIR), timeout: 3_600_000 }, async () => {
  const results: Record<string, unknown>[] = [];
  let previous: { doc: Awaited<ReturnType<typeof loadSource>>["doc"]; page: PageItem } | null = null;
  for (const f of readdirSync(DIR!).filter((x) => x.toLowerCase().endsWith(".pdf")).sort()) {
    const r: Record<string, unknown> = { file: f };
    const problems: string[] = [];
    const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
      const t0 = Date.now();
      try {
        const v = await fn();
        r[`${name}Ms`] = Date.now() - t0;
        return v;
      } catch (e) {
        problems.push(`${name}: ${(e instanceof Error ? e.message : String(e)).slice(0, 140)}`);
        return null;
      }
    };
    const loaded = await step("load", () => loadSource(join(DIR!, f)));
    if (!loaded) {
      r.problems = problems;
      results.push(r);
      console.log("C>", JSON.stringify(r));
      continue;
    }
    const { doc, pages, bytes } = loaded;
    const src = new Map([[doc.id, doc]]);
    r.pages = pages.length;
    r.kb = Math.round(bytes.length / 1024);
    r.encrypted = !!doc.security;
    const head = pages.slice(0, MAX_PAGES);

    // 文字の解析
    const texts = await step("analyze", async () => {
      const out = [];
      for (const p of head) out.push(await getPageText(doc, p));
      return out;
    });
    const all = texts?.flatMap((t) => t.runs) ?? [];
    const reasons = new Map<string, number>();
    for (const x of all) if (!x.editable) reasons.set(x.reason ?? "?", (reasons.get(x.reason ?? "?") ?? 0) + 1);
    r.runs = all.length;
    r.editable = all.filter((x) => x.editable).length;
    r.vertical = all.filter((x) => x.vertical).length;
    r.origFont = all.filter((x) => x.editable && x.originalFontUsable).length;
    r.pageErrors = texts?.filter((t) => t.pageError).map((t) => t.pageError!.slice(0, 60)) ?? [];
    r.reasons = [...reasons].map(([k, n]) => `${k.slice(0, 40)}×${n}`);

    // 無編集の再保存：ページ数と見た目
    const plain = await step("rebuild", () => buildPdf(head, src, new Map(), {}));
    if (plain) {
      r.rebuildKb = Math.round(plain.length / 1024);
      await step("renderDiff", async () => {
        const a = await openPdf(doc.bytes, doc.security ? "" : undefined);
        const b = await openPdf(plain);
        if (b.numPages !== head.length) problems.push(`rebuild: ページ数 ${b.numPages} ≠ ${head.length}`);
        const diffs: string[] = [];
        for (const n of [...new Set([1, Math.min(head.length, 3), head.length])]) {
          const x = await renderPage(a, n, 1);
          const y = await renderPage(b, n, 1);
          if (x.width !== y.width || x.height !== y.height) {
            diffs.push(`p${n}:size`);
            continue;
          }
          let d = 0;
          for (let i = 0; i < x.data.length; i += 4) if (Math.abs(x.data[i] - y.data[i]) + Math.abs(x.data[i + 1] - y.data[i + 1]) + Math.abs(x.data[i + 2] - y.data[i + 2]) > 60) d++;
          const ratio = d / (x.width * x.height);
          if (ratio > 0.001) diffs.push(`p${n}:${(ratio * 100).toFixed(2)}%`);
        }
        r.renderDiff = diffs;
        if (diffs.length) problems.push(`再保存で見た目が変わった: ${diffs.join(" ")}`);
        // リンクと入力欄の数が変わらないか
        const kinds = async (pdf: Awaited<ReturnType<typeof openPdf>>) => {
          const c = { Link: 0, Widget: 0, other: 0 };
          for (let n = 1; n <= head.length; n++) for (const an of await (await pdf.getPage(n)).getAnnotations()) c[an.subtype === "Link" ? "Link" : an.subtype === "Widget" ? "Widget" : "other"]++;
          return c;
        };
        const ka = await kinds(a);
        const kb = await kinds(b);
        r.annots = `リンク ${ka.Link}→${kb.Link} 入力欄 ${ka.Widget}→${kb.Widget} ほか ${ka.other}→${kb.other}`;
        if (ka.Link !== kb.Link || ka.Widget !== kb.Widget || ka.other !== kb.other) problems.push(`再保存で注釈の数が変わった: ${r.annots}`);
      });
    }

    // 同じ文字での書き換え：元のフォントで書き直せる行を、文字を変えずに書き直す。見た目も、取り出せる文字も変わらないはず
    if (texts) {
      await step("identity", async () => {
        const n = head.length;
        const sub = head;
        let lines = 0;
        const items = sub.map((p, i) => {
          const objs = texts[i].runs.filter((x) => x.editable && !x.vertical && x.originalFontUsable).map((run) => createTextEdit([run], { cover: "#ffffff", fallbackColor: run.color ?? "#000000" }));
          lines += objs.length;
          return { ...p, objects: objs } as PageItem;
        });
        if (!lines) return;
        const how = new Map<string, number>();
        const samples: string[] = [];
        const out = await openPdf(
          await buildPdf(items, src, new Map(), {
            rewriteUnchanged: true,
            onEditPath: (h, t) => {
              how.set(h, (how.get(h) ?? 0) + 1);
              if (h !== "anchored" && samples.length < 4) samples.push(`${h}:${t.slice(0, 16)}`);
            },
          }),
        );
        r.identityHow = [...how].map(([k, n]) => `${k}×${n}`).join(" ");
        r.identitySamples = samples;
        const a = await openPdf(doc.bytes, doc.security ? "" : undefined);
        const diffs: string[] = [];
        let lost = 0;
        for (let i = 0; i < n; i++) {
          const x = await renderPage(a, i + 1, 1);
          const y = await renderPage(out, i + 1, 1);
          let d = 0;
          for (let k = 0; k < x.data.length; k += 4) if (Math.abs(x.data[k] - y.data[k]) + Math.abs(x.data[k + 1] - y.data[k + 1]) + Math.abs(x.data[k + 2] - y.data[k + 2]) > 90) d++;
          diffs.push(`${((d / (x.width * x.height)) * 100).toFixed(2)}%`);
          if (process.env.CORPUS_PNG && d / (x.width * x.height) > 0.004) {
            await savePng(await renderPage(a, i + 1, 2), join(process.env.CORPUS_PNG, `${f}-p${i + 1}-a.png`));
            await savePng(await renderPage(out, i + 1, 2), join(process.env.CORPUS_PNG, `${f}-p${i + 1}-b.png`));
          }
          // 文字：元にあった字が、書き直した後に無くなっていないか（順番は問わず、字の数で比べる）
          const bag = (t: string) => {
            const m = new Map<string, number>();
            for (const ch of squash(t.normalize("NFKC"))) m.set(ch, (m.get(ch) ?? 0) + 1);
            return m;
          };
          const b0 = bag(await pageText(a, i + 1));
          const b1 = bag(await pageText(out, i + 1));
          for (const [ch, c] of b0) lost += Math.max(0, c - (b1.get(ch) ?? 0));
        }
        const worst = Math.max(...diffs.map((d) => parseFloat(d)));
        r.identity = `${lines} 行 / 見た目の差 最大 ${worst.toFixed(2)}%（${n} ページ） / 失われた字 ${lost}`;
        if (worst > 0.3) problems.push(`同じ文字での書き直しで見た目が変わった: ${diffs.map((d, i) => `p${i + 1}:${d}`).filter((d) => parseFloat(d.split(":")[1]) > 0.3).slice(0, 6).join(" ")}`);
        if (lost) problems.push(`同じ文字での書き直しで字が失われた: ${lost}`);
      });
    }

    // ページ操作：逆順に並べ、先頭を 90 度回す。ページ数・大きさ・中身が対応しているか
    await step("pageops", async () => {
      const sub = head.slice(0, Math.min(head.length, 4));
      if (sub.length < 2) return;
      const items = [...sub].reverse().map((p, i) => (i === 0 ? { ...p, extraRotation: 90 } : p));
      const out = await openPdf(await buildPdf(items, src, new Map(), {}));
      const a = await openPdf(doc.bytes, doc.security ? "" : undefined);
      const bad: string[] = [];
      if (out.numPages !== sub.length) bad.push(`ページ数 ${out.numPages}`);
      // 回した先頭ページ：縦横が入れ替わる
      const r0 = await renderPage(out, 1, 0.5);
      const s0 = await renderPage(a, sub.length, 0.5);
      if (Math.abs(r0.width - s0.height) > 1 || Math.abs(r0.height - s0.width) > 1) bad.push("回転後の大きさ");
      // 最後のページ＝元の 1 ページ目
      const x = await renderPage(a, 1, 1);
      const y = await renderPage(out, sub.length, 1);
      if (x.width !== y.width || x.height !== y.height) bad.push("大きさ");
      else {
        let d = 0;
        for (let k = 0; k < x.data.length; k += 4) if (Math.abs(x.data[k] - y.data[k]) + Math.abs(x.data[k + 1] - y.data[k + 1]) + Math.abs(x.data[k + 2] - y.data[k + 2]) > 90) d++;
        if (d / (x.width * x.height) > 0.001) bad.push(`中身 ${((d / (x.width * x.height)) * 100).toFixed(2)}%`);
      }
      r.pageops = bad.length ? bad.join(" ") : "ok";
      if (bad.length) problems.push(`並べ替え・回転: ${bad.join(" ")}`);
    });

    // 範囲指定の墨消し：ページ中央の長方形。その中は塗りつぶされ、外は変わらないはず（文字だけの文書でも、スキャンでも）
    await step("rect", async () => {
      const n = Math.min(head.length, 2);
      const rects = head.slice(0, n).map((p) => ({ x: p.width * 0.3, y: p.height * 0.42, w: p.width * 0.4, h: p.height * 0.1 }));
      const items = head.slice(0, n).map((p, i) => ({ ...p, objects: [{ id: `q${i}`, type: "redact", ...rects[i], fill: "#000000" } as RedactObj] }) as PageItem);
      const warns: string[] = [];
      const out = await openPdf(await buildPdf(items, src, new Map(), { onWarning: (m) => warns.push(m) }));
      const a = await openPdf(doc.bytes, doc.security ? "" : undefined);
      let worst = 0;
      let notBlack = 0;
      for (let i = 0; i < n; i++) {
        const x = await renderPage(a, i + 1, 1);
        const y = await renderPage(out, i + 1, 1);
        // 境目の字（一部が掛かる字は丸ごと消える）を除くため、範囲の周り 1 字分は比べない
        const pad = 14;
        // 描画の大きさがページの寸法と違う文書がある（UserUnit など）。範囲は描画の座標に合わせる
        const k = x.width / head[i].width;
        // 4×4 画素の平均どうしで比べる：差し替えた画像は、縮小表示のときのなめらかさが元と少し違う（中身は同じ）ため、
        // 画素単位で比べると細い線の縁がすべて「違う」と数えられてしまう
        const d = diffOutside(shrink(x, 4), shrink(y, 4), [{ x: rects[i].x - pad, y: rects[i].y - pad, w: rects[i].w + pad * 2, h: rects[i].h + pad * 2 }], k / 4);
        worst = Math.max(worst, d.changed / d.total);
        let bad = 0;
        let tot = 0;
        for (let py = Math.ceil((rects[i].y + 2) * k); py < (rects[i].y + rects[i].h - 2) * k; py++)
          for (let px = Math.ceil((rects[i].x + 2) * k); px < (rects[i].x + rects[i].w - 2) * k; px++) {
            const k = (py * y.width + px) * 4;
            tot++;
            if (y.data[k] + y.data[k + 1] + y.data[k + 2] > 60) bad++;
          }
        notBlack = Math.max(notBlack, bad / tot);
      }
      r.rect = `外の差 ${(worst * 100).toFixed(2)}% / 中の塗り残し ${(notBlack * 100).toFixed(2)}% / 警告 ${warns.length}`;
      if (worst > 0.003) problems.push(`範囲の墨消しで、範囲の外が変わった: ${(worst * 100).toFixed(2)}%（${warns.map((w) => w.slice(0, 30)).join(" / ")}）`);
      if (notBlack > 0.01) problems.push(`範囲の墨消しで、塗り残しがある: ${(notBlack * 100).toFixed(2)}%`);
    });

    // 文字の追加：余白に 1 行足す。足した所の外は変わらないはず
    await step("addtext", async () => {
      const p = head[0];
      const box = { x: 20, y: 6, w: 220, h: 16 };
      const obj = { id: "t0", type: "text", x: box.x, y: box.y, text: "確認 Check 123", fontSize: 10, font: "gothic", color: "#cc0000" } as unknown as EditObj;
      const out = await openPdf(await buildPdf([{ ...p, objects: [obj] } as PageItem], src, new Map(), {}));
      const a = await openPdf(doc.bytes, doc.security ? "" : undefined);
      const d = diffOutside(await renderPage(a, 1, 1), await renderPage(out, 1, 1), [box], 1);
      const got = squash(await pageText(out, 1)).includes("確認Check123");
      r.addtext = `外の差 ${((d.changed / d.total) * 100).toFixed(2)}% / 文字 ${got ? "ok" : "無し"}`;
      if (d.changed / d.total > 0.001) problems.push(`文字の追加で、ほかの場所が変わった: ${((d.changed / d.total) * 100).toFixed(2)}%`);
      if (!got) problems.push("追加した文字が取り出せない");
    });

    // 保存設定：ページ番号＋透かし／圧縮／白黒／パスワード。保存でき、開けて、ページ数が合うこと
    await step("settings", async () => {
      const sub = head.slice(0, Math.min(head.length, 2));
      const bad: string[] = [];
      const variants: [string, (s: DocSettings) => void, string?][] = [
        ["番号と透かし", (s) => ((s.decor.numbering.enabled = true), (s.decor.watermark.enabled = true))],
        ["圧縮", (s) => (s.compress.enabled = true)],
        ["白黒", (s) => (s.grayscale = true)],
        ["パスワード", (s) => ((s.security.enabled = true), (s.security.userPassword = "abc123"), (s.security.ownerPassword = "own456")), "abc123"],
      ];
      for (const [name, set, pw] of variants) {
        try {
          const st = defaultSettings();
          set(st);
          const bytes = await buildPdf(sub, src, new Map(), { settings: st });
          const out = await openPdf(bytes, pw);
          if (out.numPages !== sub.length) bad.push(`${name}: ページ数`);
          const y = await renderPage(out, 1, 0.5);
          let ink = 0;
          for (let k = 0; k < y.data.length; k += 4) if (y.data[k] + y.data[k + 1] + y.data[k + 2] < 600) ink++;
          const x = await renderPage(await openPdf(doc.bytes, doc.security ? "" : undefined), 1, 0.5);
          let ink0 = 0;
          for (let k = 0; k < x.data.length; k += 4) if (x.data[k] + x.data[k + 1] + x.data[k + 2] < 600) ink0++;
          // 中身が消えていないか（濃い画素の数が大きく減っていない）
          if (ink0 > 200 && ink < ink0 * 0.7) bad.push(`${name}: 中身が減った（${ink0}→${ink}）`);
        } catch (e) {
          bad.push(`${name}: ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`);
        }
      }
      r.settings = bad.length ? bad.join(" / ") : "ok";
      if (bad.length) problems.push(`保存設定: ${bad.join(" / ")}`);
    });

    // しおり：読み込んだしおりを保存に渡す（アプリと同じ流れ）。数と行き先のページが保たれるか
    await step("outline", async () => {
      const lib = await getLibDoc(doc);
      const items = readOutlines(lib, pages.map((p) => p.id));
      if (!items.length) return;
      const st = defaultSettings();
      st.outline = items;
      const sub = pages.slice(0, Math.min(pages.length, 30));
      const out = await openPdf(await buildPdf(sub, src, new Map(), { settings: st }));
      const flat = async (pdf: Awaited<ReturnType<typeof openPdf>>) => {
        const res: { title: string; page: number }[] = [];
        const walk = async (nodes: Awaited<ReturnType<typeof pdf.getOutline>>) => {
          for (const n of nodes ?? []) {
            let page = -1;
            try {
              const dest = typeof n.dest === "string" ? await pdf.getDestination(n.dest) : n.dest;
              if (dest?.[0] && typeof dest[0] === "object") page = await pdf.getPageIndex(dest[0] as never);
              else if (typeof dest?.[0] === "number") page = dest[0];
            } catch {
              /* 行き先を引けないしおり */
            }
            res.push({ title: n.title, page });
            await walk(n.items as never);
          }
        };
        await walk(await pdf.getOutline());
        return res;
      };
      const a0 = (await flat(await openPdf(doc.bytes, doc.security ? "" : undefined))).filter((x) => x.page >= 0 && x.page < sub.length);
      const b0 = (await flat(out)).filter((x) => x.page >= 0);
      const key = (x: { title: string; page: number }) => `${x.title.trim()}@${x.page}`;
      const want = new Set(a0.map(key));
      const got = new Set(b0.map(key));
      const missing = [...want].filter((k) => !got.has(k));
      r.outline = `元 ${a0.length}（先頭 ${sub.length} ページ分）→ 保存後 ${b0.length} / 欠け ${missing.length}`;
      if (missing.length) problems.push(`しおりが欠けた: ${missing.length} 件（例 ${missing.slice(0, 2).join(" / ").slice(0, 60)}）`);
    });

    // 入力欄：文字の欄に書き、チェックを入れて保存。値が入っているか。固定化（入力欄を絵にする）もできるか
    await step("form", async () => {
      if (doc.security) return;
      const fields = await readFormFields(bytes);
      const texts2 = fields.filter((f) => f.kind === "text").slice(0, 8);
      const checks = fields.filter((f) => f.kind === "checkbox").slice(0, 4);
      if (!texts2.length && !checks.length) return;
      const values: Record<string, string | boolean> = {};
      // 文字数の上限がある欄は、上限までが入るはず
      const cut = (f: (typeof fields)[number], v: string) => (f.maxLength !== undefined ? [...v].slice(0, f.maxLength).join("") : v);
      const raw: Record<string, string | boolean> = {};
      texts2.forEach((f, i) => {
        raw[f.name] = i % 2 ? "山田 太郎" : "Test 123";
        values[f.name] = cut(f, raw[f.name] as string);
      });
      checks.forEach((f) => (values[f.name] = raw[f.name] = true));
      const filled = await fillForm(bytes, raw, false);
      const back = new Map((await readFormFields(filled)).map((f) => [f.name, f.value]));
      const wrong = Object.entries(values).filter(([k, v]) => back.get(k) !== v);
      const flatBytes = await fillForm(bytes, raw, true);
      const flatPdf = await openPdf(flatBytes);
      const left = (await readFormFields(flatBytes)).length;
      r.form = `文字 ${texts2.length} チェック ${checks.length} / 値が違う ${wrong.length} / 固定化後の欄 ${left} / ページ ${flatPdf.numPages}`;
      if (wrong.length) problems.push(`入力欄：書いた値が入っていない ${wrong.length} 件（例 ${wrong[0][0].slice(0, 30)}）`);
      if (left) problems.push(`入力欄：固定化しても欄が残った ${left} 件`);
      if (flatPdf.numPages !== pages.length) problems.push("入力欄：固定化でページ数が変わった");
    });

    // 結合：前の文書の 1 ページ目のあとに、この文書の先頭 2 ページを並べる。それぞれ元と同じ見た目か
    await step("merge", async () => {
      const prev = previous;
      previous = { doc, page: pages[0] };
      if (!prev || doc.security || prev.doc.security) return;
      const sub = [prev.page, ...head.slice(0, Math.min(2, head.length))];
      const out = await openPdf(await buildPdf(sub, new Map([[doc.id, doc], [prev.doc.id, prev.doc]]), new Map(), {}));
      const bad: string[] = [];
      if (out.numPages !== sub.length) bad.push(`ページ数 ${out.numPages}`);
      const cmp = async (srcPdf: Awaited<ReturnType<typeof openPdf>>, srcNo: number, outNo: number, label: string) => {
        const x = await renderPage(srcPdf, srcNo, 1);
        const y = await renderPage(out, outNo, 1);
        if (x.width !== y.width || x.height !== y.height) return void bad.push(`${label}: 大きさ`);
        let d = 0;
        for (let k = 0; k < x.data.length; k += 4) if (Math.abs(x.data[k] - y.data[k]) + Math.abs(x.data[k + 1] - y.data[k + 1]) + Math.abs(x.data[k + 2] - y.data[k + 2]) > 90) d++;
        if (d / (x.width * x.height) > 0.001) bad.push(`${label}: ${((d / (x.width * x.height)) * 100).toFixed(2)}%`);
      };
      await cmp(await openPdf(prev.doc.bytes), prev.page.srcIndex + 1, 1, "前の文書");
      await cmp(await openPdf(doc.bytes), 1, 2, "この文書");
      r.merge = bad.length ? bad.join(" ") : "ok";
      if (bad.length) problems.push(`結合: ${bad.join(" ")}`);
    });

    // 段落ごとの書き換え：複数行の段落を、文字を変えずに書き直す。字が失われないか、どれくらい見た目が変わるか（行を組み直すので差は出る）
    if (texts) {
      await step("block", async () => {
        const n = Math.min(head.length, 2);
        const items: PageItem[] = [];
        let blocks = 0;
        for (let i = 0; i < n; i++) {
          const byBlock = new Map<string, TextRun[]>();
          for (const run of texts[i].runs) if (run.blockId && run.editable && !run.vertical && run.originalFontUsable) byBlock.set(run.blockId, [...(byBlock.get(run.blockId) ?? []), run]);
          const objs = [...byBlock.values()].filter((g) => g.length >= 2).slice(0, 12).map((g) => createTextEdit(g, { cover: "#ffffff", fallbackColor: g[0].color ?? "#000000" }));
          blocks += objs.length;
          items.push({ ...head[i], objects: objs } as PageItem);
        }
        if (!blocks) return;
        const warns: string[] = [];
        const how = new Map<string, number>();
        const out = await openPdf(await buildPdf(items, src, new Map(), { rewriteUnchanged: true, onWarning: (m) => warns.push(m), onEditPath: (h) => how.set(h, (how.get(h) ?? 0) + 1) }));
        const a = await openPdf(doc.bytes, doc.security ? "" : undefined);
        let lost = 0;
        let worst = 0;
        for (let i = 0; i < n; i++) {
          const bag = (t: string) => {
            const m = new Map<string, number>();
            for (const ch of squash(t.normalize("NFKC"))) m.set(ch, (m.get(ch) ?? 0) + 1);
            return m;
          };
          const b0 = bag(await pageText(a, i + 1));
          const b1 = bag(await pageText(out, i + 1));
          for (const [ch, c] of b0) lost += Math.max(0, c - (b1.get(ch) ?? 0));
          const x = shrink(await renderPage(a, i + 1, 1), 4);
          const y = shrink(await renderPage(out, i + 1, 1), 4);
          let d = 0;
          for (let k = 0; k < x.data.length; k += 4) if (Math.abs(x.data[k] - y.data[k]) + Math.abs(x.data[k + 1] - y.data[k + 1]) + Math.abs(x.data[k + 2] - y.data[k + 2]) > 60) d++;
          worst = Math.max(worst, d / (x.width * x.height));
        }
        r.block = `${blocks} 段落 / ${[...how].map(([k, c]) => `${k}×${c}`).join(" ")} / 見た目の差 ${(worst * 100).toFixed(2)}% / 失われた字 ${lost} / 警告 ${warns.length}`;
        if (lost) problems.push(`段落の書き直しで字が失われた: ${lost}`);
      });
    }

    const q = texts ? (pickQuery(all) ?? pickQuery(all, true)) : null;
    const qEdit = q ?? "";
    r.query = q;
    if (q && texts) {
      const srcPdf = await openPdf(doc.bytes);
      const before: string[] = [];
      for (let i = 0; i < head.length; i++) before.push(squash(await pageText(srcPdf, i + 1)));
      // 一括置換
      await step("replace", async () => {
        const NEW = /[A-Za-z]/.test(q) ? "Zqxj" : "鬱蒼";
        const edits = new Map<string, EditObj[]>();
        const want: number[] = [];
        head.forEach((p, i) => {
          let n = 0;
          for (const run of texts[i].runs) {
            if (!run.editable) continue;
            const ms = findMatches(run.text, q, true);
            if (!ms.length) continue;
            n += ms.length;
            const o = createTextEdit([run], { cover: "#ffffff", fallbackColor: run.color ?? "#000000" });
            o.text = replaceMatches(run.text, ms, NEW);
            edits.set(p.id, [...(edits.get(p.id) ?? []), o]);
          }
          want.push(n);
        });
        const warns: string[] = [];
        const out = await openPdf(await buildPdf(head.map((p) => ({ ...p, objects: edits.get(p.id) ?? [] }) as PageItem), src, new Map(), { onWarning: (m) => warns.push(m) }));
        let total = 0;
        let got = 0;
        const bad: number[] = [];
        for (let i = 0; i < head.length; i++) {
          const g = count(squash(await pageText(out, i + 1)), NEW);
          total += want[i];
          got += g;
          if (g !== want[i]) bad.push(i + 1);
        }
        r.replace = `${got}/${total}`;
        r.replaceOverflow = warns.length;
        if (bad.length) problems.push(`置換: 反映数が合わないページ ${bad.slice(0, 6).join(",")}（${got}/${total}）`);
      });
      // 置換（元のフォントのまま）：語を 2 回繰り返す（長くなる）／先頭 1 字だけにする（短くなる）。書き換えた行の帯の外は変わらないはず
      for (const [label, make] of [["長く", (w: string) => w + w], ["短く", (w: string) => [...w][0]]] as const) {
        await step(`replace-${label}`, async () => {
          const NEW = make(q);
          const n = Math.min(head.length, 3);
          const items: PageItem[] = [];
          const bands: { x: number; y: number; w: number; h: number }[][] = [];
          const how = new Map<string, number>();
          let lines = 0;
          for (let i = 0; i < n; i++) {
            const objs: EditObj[] = [];
            const bs: { x: number; y: number; w: number; h: number }[] = [];
            for (const run of texts[i].runs) {
              if (!run.editable || run.vertical || !run.originalFontUsable) continue;
              const ms = findMatches(run.text, q, true);
              if (!ms.length) continue;
              const o = createTextEdit([run], { cover: "#ffffff", fallbackColor: run.color ?? "#000000" });
              o.text = replaceMatches(run.text, ms, NEW);
              objs.push(o);
              bs.push({ x: 0, y: run.top - run.h * 0.3, w: head[i].width, h: run.h * 1.6 });
              lines++;
            }
            items.push({ ...head[i], objects: objs } as PageItem);
            bands.push(bs);
          }
          if (!lines) return;
          const warns: string[] = [];
          const out = await openPdf(await buildPdf(items, src, new Map(), { onWarning: (m) => warns.push(m), onEditPath: (h) => how.set(h, (how.get(h) ?? 0) + 1) }));
          const a = await openPdf(doc.bytes, doc.security ? "" : undefined);
          let worst = 0;
          for (let i = 0; i < n; i++) {
            const d = diffOutside(await renderPage(a, i + 1, 1), await renderPage(out, i + 1, 1), bands[i], 1);
            worst = Math.max(worst, d.changed / d.total);
          }
          r[`replace${label}`] = `${lines} 行 / ${[...how].map(([k, c]) => `${k}×${c}`).join(" ")} / 行の外の差 ${(worst * 100).toFixed(2)}% / 警告 ${warns.length}`;
          if (worst > 0.002) problems.push(`置換（${label}）で、書き換えた行の外が変わった: ${(worst * 100).toFixed(2)}%`);
        });
      }
      // 段落として選んで、その中の語を置き換える：語のある行（複数あれば最初〜最後の行）の帯の外は変わらないはず
      await step("block-replace", async () => {
        const n = Math.min(head.length, 2);
        const items: PageItem[] = [];
        const bands: { x: number; y: number; w: number; h: number }[][] = [];
        const how = new Map<string, number>();
        let blocks = 0;
        for (let i = 0; i < n; i++) {
          const byBlock = new Map<string, TextRun[]>();
          for (const run of texts[i].runs) if (run.blockId && run.editable && !run.vertical && run.originalFontUsable) byBlock.set(run.blockId, [...(byBlock.get(run.blockId) ?? []), run]);
          const objs: EditObj[] = [];
          const bs: { x: number; y: number; w: number; h: number }[] = [];
          for (const g of byBlock.values()) {
            if (g.length < 2 || objs.length >= 10) continue;
            const o = createTextEdit(g, { cover: "#ffffff", fallbackColor: g[0].color ?? "#000000" });
            const ms = findMatches(o.text, q, true);
            if (!ms.length) continue;
            o.text = replaceMatches(o.text, ms, q + q);
            objs.push(o);
            // 語が掛かる行：行の文字列に語の一部でも含まれうるので、語のある行と、行をまたぐ場合に備えて隣の行までを帯にする
            const hit = g.map((run, k) => (findMatches(run.text, q, true).length ? k : -1)).filter((k) => k >= 0);
            const lo = Math.max(0, (hit.length ? Math.min(...hit) : 0) - (hit.length ? 0 : 0));
            const hi = hit.length ? Math.max(...hit) : g.length - 1;
            const span = hit.length && ms.length === hit.reduce((c, k) => c + findMatches(g[k].text, q, true).length, 0) ? g.slice(lo, hi + 1) : g;
            const top = Math.min(...span.map((x) => x.top));
            const bottom = Math.max(...span.map((x) => x.top + x.h));
            bs.push({ x: 0, y: top - g[0].h * 0.3, w: head[i].width, h: bottom - top + g[0].h * 0.6 });
            blocks++;
          }
          items.push({ ...head[i], objects: objs } as PageItem);
          bands.push(bs);
        }
        if (!blocks) return;
        const out = await openPdf(await buildPdf(items, src, new Map(), { onEditPath: (h) => how.set(h, (how.get(h) ?? 0) + 1) }));
        const a = await openPdf(doc.bytes, doc.security ? "" : undefined);
        let worst = 0;
        let got = 0;
        for (let i = 0; i < n; i++) {
          const d = diffOutside(await renderPage(a, i + 1, 1), await renderPage(out, i + 1, 1), bands[i], 1);
          worst = Math.max(worst, d.changed / d.total);
          got += count(squash(await pageText(out, i + 1)), squash(q + q));
        }
        r.blockReplace = `${blocks} 段落 / ${[...how].map(([k, c]) => `${k}×${c}`).join(" ")} / 帯の外の差 ${(worst * 100).toFixed(2)}% / 置き換わった数 ${got}`;
        if (worst > 0.002) problems.push(`段落の中の置換で、書き換えた行の外が変わった: ${(worst * 100).toFixed(2)}%`);
        if (!got) problems.push("段落の中の置換が反映されていない");
      });
      // 一括墨消し＋保存後の検証
      await step("redact", async () => {
        // 書き換えできない行が大半の文書（複雑な文字）では、墨消しの語は全部の行から選ぶ
        const q = all.filter((x) => x.editable).length < all.length * 0.5 ? (pickQuery(all, true) ?? qEdit) : qEdit;
        r.redactQuery = q;
        const reds = new Map<string, RedactObj[]>();
        let hits = 0;
        let whole = 0;
        let skipped = 0;
        for (let i = 0; i < head.length; i++) {
          for (const run of texts[i].runs) {
            const ms = findMatches(run.text, q, true);
            if (!ms.length) continue;
            // 語の位置を決められない文字の行は、アプリでも選べない（範囲指定を案内する）
            if (SHAPED_SCRIPT.test(run.text)) {
              skipped += ms.length;
              continue;
            }
            hits += ms.length;
            const boxes = await matchBoxes(doc, head[i], run, ms);
            const list = reds.get(head[i].id) ?? [];
            if (!boxes || boxes.some((b) => !b)) {
              whole += ms.length;
              for (const b of await lineBoxes(doc, head[i], run)) list.push({ id: `w${list.length}`, type: "redact", ...b, fill: "#000000" });
            } else for (const b of boxes) list.push({ id: `r${list.length}`, type: "redact", ...b!, fill: "#000000" });
            reds.set(head[i].id, list);
          }
        }
        const warns: string[] = [];
        let check: RedactCheck | null = null;
        const out = await openPdf(await buildPdf(head.map((p) => ({ ...p, objects: reds.get(p.id) ?? [] }) as PageItem), src, new Map(), { onWarning: (m) => warns.push(m), onRedactCheck: (c) => (check = c) }));
        let left = 0;
        let was = 0;
        for (let i = 0; i < head.length; i++) {
          was += count(before[i], squash(q));
          left += count(squash(await pageText(out, i + 1)), squash(q));
        }
        const c = check as RedactCheck | null;
        r.redact = `hits ${hits} (行全体 ${whole}${skipped ? `、対象外 ${skipped}` : ""}) / 元 ${was} → 残り ${left}`;
        r.redactCheck = c ? `${c.verified}/${c.pages}` : "-";
        r.redactWarn = warns.map((w) => w.slice(0, 50));
        // 行をまたぐ語などで見つからなかった分は残る。見つけた分が消えていなければ問題
        if (left > Math.max(0, was - hits) && !skipped) problems.push(`墨消し: 見つけた ${hits} 件のうち消えていないものがある（元 ${was} → 残り ${left}）`);
      });
    }
    r.problems = problems;
    results.push(r);
    console.log("C>", JSON.stringify(r));
  }
  if (process.env.CORPUS_OUT) writeFileSync(process.env.CORPUS_OUT, JSON.stringify(results, null, 1));
});

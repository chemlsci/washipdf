/** 文字認識（OCR）。スキャンしたページの文字を読み取り、見えない文字の層としてページに足す（Web 版のみ） */
import { useEffect, useMemo, useRef, useState } from "react";
import { useLang, useT } from "@/lib/i18n";
import { type OcrConfig, type OcrLang, recognizePages, startOcrEngine } from "@/lib/ocr";
import type { OcrPageResult } from "@/lib/ocrLayer";
import { parsePageRanges, pageSet } from "@/lib/pageRanges";
import { getPageText } from "@/lib/textRuns";
import type { PageItem, SourceDoc } from "@/lib/types";
import { Dialog } from "../Dialog";

/** Tesseract の言語コード → 言語の名前を出すための言語タグ */
const TAG: Record<string, string> = {
  jpn: "ja",
  eng: "en",
  chi_sim: "zh-Hans",
  chi_tra: "zh-Hant",
  kor: "ko",
  deu: "de",
  fra: "fr",
  spa: "es",
  ita: "it",
  por: "pt",
  rus: "ru",
  tur: "tr",
  ind: "id",
  vie: "vi",
  tha: "th",
  hin: "hi",
  ben: "bn",
  ara: "ar",
  urd: "ur",
  fas: "fa",
  heb: "he",
};
/** 画面の言語 → 最初に選んでおく認識の言語 */
const DEFAULT: Record<string, string> = { ja: "jpn", en: "eng", "zh-CN": "chi_sim", "zh-TW": "chi_tra", ko: "kor", de: "deu", fr: "fra", es: "spa", it: "ita", pt: "por", ru: "rus", tr: "tur", id: "ind", vi: "vie", th: "tha", hi: "hin", bn: "ben", ar: "ara", ur: "urd", fa: "fas" };

export interface OcrOutcome {
  /** 元 PDF ごとの認識結果 */
  bySource: Map<string, OcrPageResult[]>;
  pages: number;
  words: number;
  /** すでに文字があるので飛ばしたページ数 */
  skipped: number;
  /** 元の文字・画像を編集しているので飛ばしたページ数 */
  edited: number;
}

export function OcrDialog({
  config,
  pages,
  selected,
  sources,
  onApply,
  onClose,
}: {
  config: OcrConfig;
  pages: PageItem[];
  /** ページ整理で選択しているページ（あれば、そのページだけを読み取る選択肢を出す） */
  selected?: ReadonlySet<string>;
  sources: Map<string, SourceDoc>;
  onApply: (r: OcrOutcome) => void;
  onClose: () => void;
}) {
  const t = useT();
  const { lang } = useLang();
  const names = useMemo(() => {
    let dn: Intl.DisplayNames | null = null;
    try {
      dn = new Intl.DisplayNames([lang], { type: "language" });
    } catch {
      dn = null;
    }
    return (code: string) => (TAG[code] && dn?.of(TAG[code])) || code;
  }, [lang]);
  const initial = useMemo(() => {
    const first = config.langs.find((l) => l.code === DEFAULT[lang]) ?? config.langs[0];
    const eng = config.langs.find((l) => l.code === "eng");
    return [...new Set([first.code, ...(eng && first.code !== "eng" && /^(jpn|chi_|kor)/.test(first.code) ? [eng.code] : [])])];
  }, [config, lang]);
  const [picked, setPicked] = useState<string[]>(initial);
  const [vertical, setVertical] = useState(false);
  const [skipText, setSkipText] = useState(true);
  const picks = pages.filter((p) => selected?.has(p.id));
  // 対象のページ：すべて・ページ整理で選んだページ・番号で指定した範囲（例：1-3, 5）
  const [scope, setScope] = useState<"all" | "selected" | "range">(picks.length > 0 ? "selected" : "all");
  const [range, setRange] = useState("");
  const rangeError = scope === "range" && (!range.trim() || (() => {
    const r = parsePageRanges(range, pages.length);
    return !!(r.badPart || r.outOfRange) || !r.groups.length;
  })());
  const targets = scope === "selected" && picks.length ? picks : scope === "range" ? pages.filter((_, i) => pageSet(range, pages.length).has(i)) : pages;
  const [progress, setProgress] = useState<{ done: number; total: number; loading: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const closeEngine = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      abort.current?.abort();
      closeEngine.current?.();
    },
    [],
  );
  const langs: OcrLang[] = config.langs.filter((l) => picked.includes(l.code));
  // 縦書きを選べるのは、選んだ言語のどれかに縦書き用のデータがあるとき
  const canVertical = langs.some((l) => l.vertical);

  const run = async () => {
    setError(null);
    const ac = new AbortController();
    abort.current = ac;
    setProgress({ done: 0, total: 0, loading: true });
    try {
      // 認識するページ：元 PDF のページごとに 1 回（同じページを複製していても 1 回）。文字のあるページは飛ばす
      const seen = new Set<string>();
      const jobs: { src: SourceDoc; page: PageItem }[] = [];
      let skipped = 0;
      // 元の文字や画像を編集しているページは読み取らない：編集は「元の内容の何番目の命令か」で覚えているので、
      // 元の内容に文字の層を足すと対応がずれてしまう（保存してから開き直せば読み取れる）
      const editedKeys = new Set(pages.filter((p) => p.objects.some((o) => o.type === "textedit" || o.type === "imageedit")).map((p) => `${p.srcId}:${p.srcIndex}`));
      let edited = 0;
      for (const p of targets) {
        const src = p.srcId ? sources.get(p.srcId) : undefined;
        if (!src) continue;
        const key = `${p.srcId}:${p.srcIndex}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (editedKeys.has(key)) {
          edited++;
          continue;
        }
        if (skipText && (await getPageText(src, p)).runs.some((r) => r.text.trim())) {
          skipped++;
          continue;
        }
        jobs.push({ src, page: p });
      }
      if (!jobs.length) {
        setProgress(null);
        setError(edited ? t("ocr.editedSkipped", { n: edited }) : t("ocr.nothing"));
        return;
      }
      const useVertical = vertical && canVertical;
      const engine = await startOcrEngine(config, langs, useVertical);
      closeEngine.current = engine.close;
      if (ac.signal.aborted) return;
      setProgress({ done: 0, total: jobs.length, loading: false });
      const bySource = new Map<string, OcrPageResult[]>();
      let words = 0;
      let done = 0;
      for (const job of jobs) {
        const pdfPage = await job.src.pdf.getPage(job.page.srcIndex + 1);
        const [r] = await recognizePages(engine, [{ index: job.page.srcIndex, page: pdfPage, rotation: (((job.page.baseRotation + job.page.extraRotation) % 360) + 360) % 360 }], langs, useVertical, undefined, ac.signal);
        if (r.lines.length) {
          bySource.set(job.src.id, [...(bySource.get(job.src.id) ?? []), r]);
          words += r.lines.reduce((n, l) => n + l.words.length, 0);
        }
        setProgress({ done: ++done, total: jobs.length, loading: false });
      }
      engine.close();
      closeEngine.current = null;
      if (!words) {
        setProgress(null);
        setError(t("ocr.none"));
        return;
      }
      onApply({ bySource, pages: [...bySource.values()].reduce((n, v) => n + v.length, 0), words, skipped, edited });
    } catch (e) {
      closeEngine.current?.();
      closeEngine.current = null;
      setProgress(null);
      if (!ac.signal.aborted) setError(t("ocr.failed", { reason: e instanceof Error ? e.message : String(e) }));
    }
  };
  const cancel = () => {
    abort.current?.abort();
    closeEngine.current?.();
    closeEngine.current = null;
    setProgress(null);
  };

  const running = progress !== null;
  return (
    <Dialog
      title={t("ocr.title")}
      onClose={() => {
        cancel();
        onClose();
      }}
      footer={
        <>
          <span className="spacer" />
          <button
            className="btn"
            onClick={() => {
              if (running) cancel();
              else onClose();
            }}
          >
            {t("common.cancel")}
          </button>
          <button className="btn primary" disabled={running || !langs.length || rangeError} onClick={() => void run()}>
            {t("ocr.run")}
          </button>
        </>
      }
    >
      <p className="note">{t("ocr.lead")}</p>
      <div className="field">
        <span>{t("ocr.langs")}</span>
        <div className="ocr-langs">
          {config.langs.map((l) => (
            <label key={l.code} className="checkbox">
              <input type="checkbox" disabled={running} checked={picked.includes(l.code)} onChange={(e) => setPicked(e.target.checked ? [...picked, l.code] : picked.filter((c) => c !== l.code))} /> {names(l.code)}
            </label>
          ))}
        </div>
      </div>
      {pages.length > 1 && (
        <div className="field">
          <span>{t("ocr.scope")}</span>
          <div className="seg small" role="group">
            <button className={scope === "all" ? "on" : ""} aria-pressed={scope === "all"} disabled={running} onClick={() => setScope("all")}>
              {t("ocr.scopeAll")}
            </button>
            {picks.length > 0 && (
              <button className={scope === "selected" ? "on" : ""} aria-pressed={scope === "selected"} disabled={running} onClick={() => setScope("selected")}>
                {t("ocr.scopeSelected", { n: picks.length })}
              </button>
            )}
            <button className={scope === "range" ? "on" : ""} aria-pressed={scope === "range"} disabled={running} onClick={() => setScope("range")}>
              {t("target.range")}
            </button>
          </div>
          {scope === "range" && <input dir="ltr" value={range} disabled={running} placeholder={`1-${pages.length}`} aria-invalid={rangeError && !!range.trim()} onChange={(e) => setRange(e.target.value)} />}
        </div>
      )}
      {canVertical && (
        <div className="field">
          <span>{t("ocr.direction")}</span>
          <div className="seg small" role="group">
            <button className={!vertical ? "on" : ""} aria-pressed={!vertical} disabled={running} onClick={() => setVertical(false)}>
              {t("ocr.horizontal")}
            </button>
            <button className={vertical ? "on" : ""} aria-pressed={vertical} disabled={running} onClick={() => setVertical(true)}>
              {t("ocr.vertical")}
            </button>
          </div>
        </div>
      )}
      <label className="checkbox">
        <input type="checkbox" disabled={running} checked={skipText} onChange={(e) => setSkipText(e.target.checked)} /> {t("ocr.skipText")}
      </label>
      {progress && (
        <div className="ocr-progress" role="status">
          <progress value={progress.loading ? undefined : progress.done} max={progress.loading ? undefined : Math.max(1, progress.total)} />
          <span>{progress.loading ? t("ocr.loading") : t("ocr.progress", { n: progress.done, total: progress.total })}</span>
        </div>
      )}
      {error && <p className="note error">{error}</p>}
      <p className="note">{t("ocr.note")}</p>
    </Dialog>
  );
}

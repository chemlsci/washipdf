import { useMemo, useState } from "react";
import { type T, useT } from "@/lib/i18n";
import { clamp, clampInt } from "@/lib/limits";
import type { OutlineItem } from "@/lib/outlines";
import type { PageItem } from "@/lib/types";
import { Dialog, NumInput } from "./Dialog";
import { Icon } from "./Icon";

type SplitMode = "every" | "ranges" | "selected" | "bookmarks" | "size";

/** サイズで分割するときの、1 ファイルの上限として受け付ける範囲（MB）。小さすぎる値は、ページごとに何度も組み立て直すことになる */
const MIN_SIZE_MB = 0.1;
const MAX_SIZE_MB = 4000;

/** ファイル名に使えない文字を除いた、しおりの題名（文字の並びの向きを変える制御文字も除く。名前の見え方を偽れるため） */
const safeTitle = (s: string) =>
  s
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);

interface Group {
  name: string;
  pages: PageItem[];
}

export function parseRanges(input: string, total: number, t: T): { groups: number[][]; error: string | null } {
  const groups: number[][] = [];
  const parts = input
    .replace(/[，、]/g, ",")
    .replace(/[〜～ー―−–]/g, "-")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return { groups, error: t("split.needRanges") };
  for (const part of parts) {
    const m = /^(\d+)\s*(?:-\s*(\d*))?$/.exec(part.normalize("NFKC"));
    if (!m) return { groups, error: t("split.badPart", { part }) };
    const a = parseInt(m[1], 10);
    const b = m[2] === undefined ? a : m[2] === "" ? total : parseInt(m[2], 10);
    if (a < 1 || b < 1 || a > total || b > total) return { groups, error: t("split.outOfRange", { part, total }) };
    const g: number[] = [];
    if (a <= b) for (let i = a; i <= b; i++) g.push(i);
    else for (let i = a; i >= b; i--) g.push(i);
    groups.push(g);
  }
  return { groups, error: null };
}

export function SplitDialog({
  pages,
  baseName,
  selected,
  outline,
  onClose,
  onRun,
  onRunBySize,
}: {
  pages: PageItem[];
  baseName: string;
  selected: Set<string>;
  onClose: () => void;
  /** しおり（一番上の階層ごとに分けるのに使う） */
  outline: OutlineItem[];
  onRun: (groups: Group[]) => void;
  /** サイズで分ける（上限のバイト数）。実際に組み立てて測るので、分け方は実行時に決まる */
  onRunBySize: (limitBytes: number) => void;
}) {
  const total = pages.length;
  const t = useT();
  const [mode, setMode] = useState<SplitMode>("every");
  const [every, setEvery] = useState(1);
  const [sizeMb, setSizeMb] = useState(10);
  const [ranges, setRanges] = useState(total > 1 ? `1-${Math.ceil(total / 2)}, ${Math.ceil(total / 2) + 1}-${total}` : "1");

  const { groups, error } = useMemo((): { groups: Group[]; error: string | null } => {
    const label = (nums: number[]) =>
      nums.length === 1 ? `${nums[0]}` : nums.every((n, i) => i === 0 || n === nums[i - 1] + 1) ? `${nums[0]}-${nums[nums.length - 1]}` : `${nums[0]}+`;
    const mk = (nums: number[]): Group => ({ name: `${baseName}_p${label(nums)}.pdf`, pages: nums.map((n) => pages[n - 1]) });
    if (mode === "every") {
      const n = clampInt(every, 1, Math.max(1, total), 1);
      const gs: Group[] = [];
      for (let i = 1; i <= total; i += n) gs.push(mk(Array.from({ length: Math.min(n, total - i + 1) }, (_, k) => i + k)));
      return { groups: gs, error: null };
    }
    if (mode === "size") return { groups: [], error: sizeMb >= MIN_SIZE_MB && Number.isFinite(sizeMb) ? null : t("split.needSize") };
    if (mode === "bookmarks") {
      // 一番上の階層のしおりが指すページを区切りにする（同じページを指すものは最初の 1 つ）
      const starts: { at: number; title: string }[] = [];
      for (const o of outline) {
        if (o.level !== 0 || !o.pageId) continue;
        const at = pages.findIndex((p) => p.id === o.pageId);
        if (at >= 0 && !starts.some((x) => x.at === at)) starts.push({ at, title: o.title });
      }
      starts.sort((a, b) => a.at - b.at);
      if (!starts.length) return { groups: [], error: t("split.noBookmarks") };
      const gs: Group[] = [];
      // 最初のしおりより前のページ
      if (starts[0].at > 0) gs.push(mk(Array.from({ length: starts[0].at }, (_, k) => k + 1)));
      const width = String(starts.length).length;
      starts.forEach((st, i) => {
        const end = i + 1 < starts.length ? starts[i + 1].at : total;
        const title = safeTitle(st.title);
        gs.push({ name: `${baseName}_${String(i + 1).padStart(width, "0")}${title ? `_${title}` : ""}.pdf`, pages: pages.slice(st.at, end) });
      });
      return { groups: gs, error: null };
    }
    if (mode === "selected") {
      const nums = pages.map((p, i) => (selected.has(p.id) ? i + 1 : 0)).filter(Boolean);
      if (!nums.length) return { groups: [], error: t("split.needSelection") };
      return { groups: [mk(nums)], error: null };
    }
    const r = parseRanges(ranges, total, t);
    // 同名ファイルを避ける
    const gs = r.groups.map(mk);
    const seen = new Map<string, number>();
    for (const g of gs) {
      const c = seen.get(g.name) ?? 0;
      seen.set(g.name, c + 1);
      if (c) g.name = g.name.replace(/\.pdf$/, `_${c + 1}.pdf`);
    }
    return { groups: gs, error: r.error };
  }, [mode, every, ranges, pages, total, baseName, selected, outline, sizeMb, t]);

  return (
    <Dialog
      title={t("split.title")}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" disabled={!!error || (mode !== "size" && !groups.length)} onClick={() => (mode === "size" ? onRunBySize(Math.round(clamp(sizeMb, MIN_SIZE_MB, MAX_SIZE_MB, 10) * 1024 * 1024)) : onRun(groups))}>
            <Icon name="download" /> {t("split.run")}
          </button>
        </>
      }
    >
        <div className="seg">
          <button className={mode === "every" ? "on" : ""} aria-pressed={mode === "every"} onClick={() => setMode("every")}>
            {t("split.every")}
          </button>
          <button className={mode === "ranges" ? "on" : ""} aria-pressed={mode === "ranges"} onClick={() => setMode("ranges")}>
            {t("split.ranges")}
          </button>
          <button className={mode === "selected" ? "on" : ""} aria-pressed={mode === "selected"} onClick={() => setMode("selected")}>
            {t("split.selected")}
          </button>
          <button className={mode === "bookmarks" ? "on" : ""} aria-pressed={mode === "bookmarks"} onClick={() => setMode("bookmarks")}>
            {t("split.bookmarks")}
          </button>
          <button className={mode === "size" ? "on" : ""} aria-pressed={mode === "size"} onClick={() => setMode("size")}>
            {t("split.bySize")}
          </button>
        </div>

        {mode === "every" && (
          <label className="field">
            <span>{t("split.everyLabel")}</span>
            <NumInput min={1} max={total} value={every} onValue={(raw) => setEvery(parseInt(raw, 10) || 1)} />
          </label>
        )}
        {mode === "ranges" && (
          <label className="field">
            <span>{t("split.rangesLabel")}</span>
            <input dir="ltr" value={ranges} onChange={(e) => setRanges(e.target.value)} placeholder="1-3, 4, 5-8" />
          </label>
        )}

        {mode === "size" && (
          <label className="field">
            <span>{t("split.sizeLabel")}</span>
            <NumInput min={MIN_SIZE_MB} max={MAX_SIZE_MB} step={0.5} value={sizeMb} onValue={(raw) => setSizeMb(parseFloat(raw) || 0)} />
          </label>
        )}

        <div className="split-preview">
          {mode === "size" && !error ? (
            <p className="note">{t("split.sizeHelp")}</p>
          ) : mode === "bookmarks" && !error && groups.length ? (
            <>
              <p className="muted">
                {t("split.bookmarksHelp")} {t("split.count", { n: groups.length })}
                {groups.length > 1 && t("split.zip")}
              </p>
              <ul>
                {groups.slice(0, 50).map((g, i) => (
                  <li key={i}>
                    <Icon name="file" size={15} /> {g.name} <span className="muted">{t("split.pages", { n: g.pages.length })}</span>
                  </li>
                ))}
                {groups.length > 50 && <li className="muted">{t("split.more", { n: groups.length - 50 })}</li>}
              </ul>
            </>
          ) : error ? (
            <p className="err">{error}</p>
          ) : (
            <>
              <p className="muted">
                {t("split.count", { n: groups.length })}
                {groups.length > 1 && t("split.zip")}
              </p>
              <ul>
                {groups.slice(0, 50).map((g, i) => (
                  <li key={i}>
                    <Icon name="file" size={15} /> {g.name} <span className="muted">{t("split.pages", { n: g.pages.length })}</span>
                  </li>
                ))}
                {groups.length > 50 && <li className="muted">{t("split.more", { n: groups.length - 50 })}</li>}
              </ul>
            </>
          )}
        </div>

    </Dialog>
  );
}

/**
 * 配信版（washipdf.com など。Service Worker が端末に保存した版から起動する）の更新。
 * 自動では更新しない：新しい版の有無を確かめるのも、取り込むのも、利用者がボタンを押したときだけ。
 * 画面（このファイル）は通信できないので、Service Worker に頼む。単一 HTML をそのまま開いたときは対象外。
 */

export interface VersionInfo {
  version: string;
  /** アプリ本体（HTML）の SHA-256 */
  hash: string;
}

export interface CheckResult {
  current: VersionInfo | null;
  latest: VersionInfo;
  available: boolean;
}

/** 端末に保存した版から起動しているか（更新の操作を出すかどうか） */
export const hasSavedApp = (): boolean => typeof navigator !== "undefined" && !!navigator.serviceWorker?.controller;

function ask<T>(type: "info" | "check" | "update", timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const sw = navigator.serviceWorker?.controller;
    if (!sw) return reject(new Error("no service worker"));
    const ch = new MessageChannel();
    const tm = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    ch.port1.onmessage = (e) => {
      clearTimeout(tm);
      const d = e.data as { ok: boolean; error?: string } & T;
      if (d?.ok) resolve(d);
      else reject(new Error(d?.error ?? "failed"));
    };
    sw.postMessage({ type }, [ch.port2]);
  });
}

/** いま端末に入っている版 */
export const savedVersion = () => ask<{ current: VersionInfo | null }>("info", 5000).then((r) => r.current);

/** 新しい版があるかを確かめる（ここで初めて通信する） */
export const checkForUpdate = () => ask<CheckResult>("check", 30_000);

/** 新しい版を取り込む（大きい版は時間がかかる）。終わったら再読み込みで切り替わる */
export const downloadUpdate = () => ask<{ current: VersionInfo }>("update", 15 * 60_000).then((r) => r.current);

/** 版の表示（例 "1.0.0 · 1a2b3c4"） */
export const versionLabel = (v: VersionInfo | null): string => (v ? `${v.version} · ${v.hash.slice(0, 7)}` : "—");

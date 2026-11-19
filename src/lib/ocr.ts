// 文字認識（OCR）。Web 版（washipdf.com に置いた版）だけの機能。
//
// 認識のエンジン（Tesseract を WebAssembly にしたもの）と言語データは大きいので、アプリ本体には入れない。
// Web 版では、同じサイトに置いたファイルを、使うときにだけ「プログラムとして」読み込む（<script> と同じ扱い）。
// アプリは通信を禁止したまま（connect-src 'none'）で、読み込めるのは自分のサイトのプログラムだけ。PDF や画像はどこにも送らない。
// ダウンロード版（単一の HTML）には設定が無く、この機能は表示しない。
//
// サイト側のファイルとの取り決め：
//   エンジン：読み込むと、グローバルに TesseractCore（Emscripten のモジュールを返す関数）ができる（tesseract.js-core の *.wasm.js）
//   言語データ：読み込むと、self.__washiOcrLang(言語コード, traineddata を base64 にした文字列) を呼ぶ

import type { PDFPageProxy } from "pdfjs-dist";
import type { OcrLine, OcrPageResult } from "./ocrLayer";
import type { Matrix } from "./types";

export interface OcrLang {
  /** Tesseract の言語コード（jpn、eng など） */
  code: string;
  /** 言語データのファイル */
  url: string;
  /** 縦書き用の言語データ（あれば） */
  vertical?: { code: string; url: string };
}

export interface OcrConfig {
  engine: string;
  /** SIMD（まとめて計算する命令）を使う版のエンジン。使えるブラウザではこちらを読み込む（速い） */
  engineSimd?: string;
  langs: OcrLang[];
}

/** 同じサイトの中のファイルだけを許す（設定が書き換えられても、ほかのサイトのプログラムは読み込まない） */
function sameOrigin(url: unknown): string | null {
  if (typeof url !== "string" || !url) return null;
  try {
    const u = new URL(url, location.href);
    return u.origin === location.origin && (u.protocol === "https:" || u.protocol === "http:") ? u.href : null;
  } catch {
    return null;
  }
}

/** 設定を読む（形の合わないものは捨てる）。base は、設定の中の URL の基準 */
export function parseOcrConfig(raw: unknown, resolve: (url: unknown) => string | null = sameOrigin): OcrConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { engine?: unknown; engineSimd?: unknown; langs?: unknown };
  const engine = resolve(r.engine);
  if (!engine || !Array.isArray(r.langs)) return null;
  const code = (c: unknown) => (typeof c === "string" && /^[a-z]{3}(_[a-z]+)*$/.test(c) ? c : null);
  const langs: OcrLang[] = [];
  for (const l of r.langs as { code?: unknown; url?: unknown; vertical?: { code?: unknown; url?: unknown } }[]) {
    const c = code(l?.code);
    const u = resolve(l?.url);
    if (!c || !u) continue;
    const vc = code(l.vertical?.code);
    const vu = resolve(l.vertical?.url);
    langs.push({ code: c, url: u, vertical: vc && vu ? { code: vc, url: vu } : undefined });
  }
  return langs.length ? { engine, engineSimd: resolve(r.engineSimd) ?? undefined, langs } : null;
}

let cached: OcrConfig | null | undefined;
/** この版で文字認識が使えるときの設定。使えない版（ダウンロード版）では null */
export function ocrConfig(): OcrConfig | null {
  if (cached !== undefined) return cached;
  cached = null;
  if (typeof document === "undefined") return null;
  const el = document.getElementById("ocr-config");
  if (!el?.textContent) return null;
  try {
    cached = parseOcrConfig(JSON.parse(el.textContent));
  } catch {
    cached = null;
  }
  return cached;
}

/* ---------- 認識結果（TSV）の読み取り ---------- */

/**
 * Tesseract の TSV（level, page, block, par, line, word, left, top, width, height, conf, text）を、行と語にする。
 * 位置は画像の画素なので、scale（画素 / pt）で割って表示座標の pt にする。
 * 確からしさの低い語（minConf 未満）と、字の無い語は捨てる
 */
export function parseTsv(tsv: string, scale: number, vertical = false, minConf = 25): OcrLine[] {
  const lines: OcrLine[] = [];
  let cur: OcrLine | null = null;
  for (const row of tsv.split("\n")) {
    const c = row.split("\t");
    if (c.length < 12) continue;
    const level = Number(c[0]);
    const [x, y, w, h] = [Number(c[6]) / scale, Number(c[7]) / scale, Number(c[8]) / scale, Number(c[9]) / scale];
    if (level === 4) {
      cur = { words: [], x, y, w, h, vertical: vertical && h > w };
      lines.push(cur);
    } else if (level === 5 && cur) {
      const text = c.slice(11).join("\t").trim();
      const conf = Number(c[10]);
      if (!text || !(conf >= minConf) || !(w > 0) || !(h > 0)) continue;
      // 記号だけの「語」で、確からしさが低いか、極端に細長いものは、表の罫線や汚れを字と見誤ったもの。捨てる
      if (!/[\p{L}\p{N}]/u.test(text) && (conf < 60 || w > h * 6 || h > w * 6)) continue;
      cur.words.push({ text, x, y, w, h });
    }
  }
  return lines.filter((l) => l.words.length > 0);
}

/* ---------- エンジン（ワーカーの中で動かす） ---------- */

// ワーカーのプログラム。アプリ本体に文字列として持ち、Blob から起動する（エンジンと言語データは importScripts で読み込む）
const WORKER_SOURCE = `
let M = null, api = null, ready = "";
const loaded = new Set();
self.__washiOcrLang = (code, b64) => {
  const bin = atob(b64);
  const data = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  M.FS.writeFile(code + ".traineddata", data);
  loaded.add(code);
};
self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "init") {
      // SIMD を使えるブラウザなら、その版のエンジンを読み込む
      const simd = WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
      importScripts(simd && m.engineSimd ? m.engineSimd : m.engine);
      M = await self.TesseractCore({ print() {}, printErr() {} });
      postMessage({ type: "ready" });
    } else if (m.type === "langs") {
      for (const l of m.langs) if (!loaded.has(l.code)) importScripts(l.url);
      for (const l of m.langs) if (!loaded.has(l.code)) throw new Error("lang " + l.code);
      postMessage({ type: "langs" });
    } else if (m.type === "page") {
      const key = m.langs + "|" + m.psm;
      if (!api || ready !== key) {
        if (api) { api.End(); api = null; }
        const a = new M.TessBaseAPI();
        if (a.Init(null, m.langs, M.OEM_LSTM_ONLY)) throw new Error("init " + m.langs);
        a.SetPageSegMode(m.psm);
        api = a;
        ready = key;
      }
      // グレースケールの画素を PGM（P5）にして渡す
      const head = "P5\\n" + m.width + " " + m.height + "\\n255\\n";
      const gray = new Uint8Array(m.gray);
      const size = head.length + gray.length;
      const ptr = M._malloc(size);
      for (let i = 0; i < head.length; i++) M.HEAPU8[ptr + i] = head.charCodeAt(i);
      M.HEAPU8.set(gray, ptr + head.length);
      const pix = M._pixReadMem(ptr, size);
      M._free(ptr);
      if (!pix) throw new Error("image");
      let tsv = "";
      try {
        api.SetImage(pix);
        api.SetSourceResolution(m.dpi);
        api.Recognize(null);
        tsv = api.GetTSVText(0);
      } finally {
        api.Clear();
        const pp = M._malloc(4);
        for (let i = 0; i < 4; i++) M.HEAPU8[pp + i] = (pix >>> (8 * i)) & 255;
        M._pixDestroy(pp);
        M._free(pp);
      }
      postMessage({ type: "result", id: m.id, tsv });
    }
  } catch (err) {
    postMessage({ type: "error", id: m && m.id, message: String((err && err.message) || err) });
  }
};
`;

export interface OcrEngine {
  /** 1 ページ分の画像（グレースケール）を認識して、TSV を返す */
  recognize(image: { gray: Uint8Array; width: number; height: number; dpi: number }, langs: string, vertical: boolean): Promise<string>;
  close(): void;
}

/** エンジンを起動し、言語データを読み込む。langs は設定の中の言語（縦書きを使うなら vertical のデータも読み込む） */
export function startOcrEngine(config: OcrConfig, langs: OcrLang[], vertical: boolean): Promise<OcrEngine> {
  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
  const worker = new Worker(url);
  let next = 1;
  const waiting = new Map<number | string, { resolve: (v: string) => void; reject: (e: Error) => void }>();
  worker.onmessage = (e: MessageEvent<{ type: string; id?: number; tsv?: string; message?: string }>) => {
    const m = e.data;
    const key = m.type === "result" || (m.type === "error" && m.id) ? m.id! : m.type === "error" ? [...waiting.keys()][0] : m.type;
    const w = waiting.get(key);
    if (!w) return;
    waiting.delete(key);
    if (m.type === "error") w.reject(new Error(m.message ?? "ocr"));
    else w.resolve(m.tsv ?? "");
  };
  worker.onerror = (e) => {
    for (const w of waiting.values()) w.reject(new Error(e.message || "ocr worker"));
    waiting.clear();
  };
  const ask = (key: number | string, message: unknown, transfer: Transferable[] = []) =>
    new Promise<string>((resolve, reject) => {
      waiting.set(key, { resolve, reject });
      worker.postMessage(message, transfer);
    });
  const close = () => {
    worker.terminate();
    URL.revokeObjectURL(url);
    for (const w of waiting.values()) w.reject(new Error("closed"));
    waiting.clear();
  };
  const files = langs.flatMap((l) => (vertical && l.vertical ? [{ code: l.vertical.code, url: l.vertical.url }] : [{ code: l.code, url: l.url }]));
  return (async () => {
    try {
      await ask("ready", { type: "init", engine: config.engine, engineSimd: config.engineSimd });
      await ask("langs", { type: "langs", langs: files });
    } catch (e) {
      close();
      throw e;
    }
    return {
      recognize: (image, codes, vert) => {
        const id = next++;
        const buf = image.gray.buffer.slice(image.gray.byteOffset, image.gray.byteOffset + image.gray.byteLength) as ArrayBuffer;
        // 縦書き：縦に並んだ 1 つのまとまりとして読む（5）。
        // 横書き：ページの中の文字を、並びの構成を決めつけずに拾う（11）。段落や段組みを自動で調べる方法（3）は、表や枠のある文書で
        // 構成の判定が外れると、その部分の文字をまるごと落とす（表と 2 段組みのある文書で、文字の 7〜9 割しか拾えなかった。11 では 9 割以上）。
        // 検索・選択・墨消しのための文字の層には、読む順の構成は要らない（行ごとに位置を決めて書く）
        return ask(id, { type: "page", id, gray: buf, width: image.width, height: image.height, dpi: image.dpi, langs: codes, psm: vert ? 5 : 11 }, [buf]);
      },
      close,
    };
  })();
}

/** 認識に使う言語コードの並び（"jpn+eng" の形）。縦書きなら縦書き用のデータ */
export const langCodes = (langs: OcrLang[], vertical: boolean) => langs.map((l) => (vertical && l.vertical ? l.vertical.code : l.code)).join("+");

/* ---------- ページの画像化と認識 ---------- */

/** 認識用の解像度（dpi）。大きいページは、長辺の画素数がこの上限に収まるように下げる */
const OCR_DPI = 250;
const MAX_SIDE = 3600;

/** ページを描画して、グレースケールの画素にする。rotation は表示の向き（度） */
export async function renderForOcr(page: PDFPageProxy, rotation: number): Promise<{ gray: Uint8Array; width: number; height: number; dpi: number; scale: number; viewTransform: Matrix }> {
  const base = page.getViewport({ scale: 1, rotation });
  const scale = Math.min(OCR_DPI / 72, MAX_SIDE / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale, rotation });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const gray = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0, j = 0; j < gray.length; i += 4, j++) gray[j] = (rgba[i] * 77 + rgba[i + 1] * 151 + rgba[i + 2] * 28) >> 8;
  canvas.width = 0;
  canvas.height = 0;
  return { gray, width: viewport.width | 0, height: viewport.height | 0, dpi: Math.round(scale * 72), scale, viewTransform: base.transform as Matrix };
}

export interface OcrJob {
  /** 元 PDF でのページ番号（0 始まり） */
  index: number;
  page: PDFPageProxy;
  rotation: number;
}

/**
 * ページを順に認識する。onProgress には、済んだページ数を渡す。signal で中止できる（途中までの結果は捨てる）
 */
export async function recognizePages(
  engine: OcrEngine,
  jobs: OcrJob[],
  langs: OcrLang[],
  vertical: boolean,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<OcrPageResult[]> {
  const out: OcrPageResult[] = [];
  const codes = langCodes(langs, vertical);
  for (const [i, job] of jobs.entries()) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    onProgress?.(i, jobs.length);
    const img = await renderForOcr(job.page, job.rotation);
    const tsv = await engine.recognize(img, codes, vertical);
    out.push({ index: job.index, viewTransform: img.viewTransform, lines: parseTsv(tsv, img.scale, vertical) });
  }
  onProgress?.(jobs.length, jobs.length);
  return out;
}

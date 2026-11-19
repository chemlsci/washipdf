/**
 * HTML 1ファイルに埋め込んだ大きなデータ（フォント・pdf.js ワーカー）を取り出す。
 * ビルド時に <script type="application/octet-stream" id="asset-..."> として base64 で埋め込んでいる
 * （data-enc="gzip" のものは gzip で縮めてある。使うときに戻す）。
 * JS 本体に文字列として持たせないのは、起動時の JS 解析を軽くし、使う時だけ展開するため。
 */

import { gunzipSync } from "fflate";

export type AssetId = `font-${string}` | "pdf-worker" | "pdf-data";

const cache = new Map<AssetId, Uint8Array>();

function base64ToBytes(b64: string): Uint8Array {
  const fromBase64 = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64;
  if (fromBase64) return fromBase64(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function getAsset(id: AssetId): Uint8Array {
  let bytes = cache.get(id);
  if (!bytes) {
    const el = document.getElementById(`asset-${id}`);
    if (!el?.textContent) throw new Error(`埋め込みデータ ${id} が見つかりません（ビルド済みの HTML から開いてください）`);
    bytes = base64ToBytes(el.textContent.replace(/\s+/g, ""));
    if (el.getAttribute("data-enc") === "gzip") bytes = gunzipSync(bytes);
    // 展開後は DOM 側の文字列を捨ててメモリを空ける
    el.textContent = "";
    cache.set(id, bytes);
  }
  return bytes;
}

/**
 * 縮めて埋め込んだデータを、ブラウザーの展開の機能（DecompressionStream）で前もって戻しておく（起動のあと、空いた時間に）。
 * JS で戻すより速く、PDF を初めて開いたときの待ち時間が減る。間に合わなければ getAsset がその場で戻す
 */
export function warmAssets(ids: AssetId[]): void {
  if (typeof DecompressionStream === "undefined" || typeof document === "undefined") return;
  for (const id of ids) {
    if (cache.has(id)) continue;
    const el = document.getElementById(`asset-${id}`);
    if (!el?.textContent || el.getAttribute("data-enc") !== "gzip") continue;
    const packed = base64ToBytes(el.textContent.replace(/\s+/g, ""));
    void new Response(new Blob([packed as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip")))
      .arrayBuffer()
      .then((buf) => {
        if (cache.has(id)) return;
        cache.set(id, new Uint8Array(buf));
        el.textContent = "";
      })
      .catch(() => {});
  }
}

let worker: Worker | null = null;

/**
 * pdf.js のワーカーを起動する。
 * file:// で開いた場合、モジュール形式のワーカーは動かないため、通常形式に変換済みのものを Blob URL から起動する。
 */
export function getPdfWorker(): Worker {
  if (!worker) {
    const url = URL.createObjectURL(new Blob([getAsset("pdf-worker") as BlobPart], { type: "text/javascript" }));
    worker = new Worker(url);
  }
  return worker;
}

let pdfDataIndex: Record<string, [number, number]> | null = null;
let pdfDataBytes: Uint8Array | null = null;

/**
 * pdf.js の定義済み CMap・WASM（ビルド時に1つにまとめて埋め込んだもの）から1ファイル分を取り出す。
 * 無ければ null（Node.js のテストなど）
 */
export function getPdfDataFile(name: string): Uint8Array | null {
  if (!pdfDataBytes) {
    let bytes: Uint8Array;
    try {
      bytes = getAsset("pdf-data");
    } catch {
      return null;
    }
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const len = v.getUint32(0);
    pdfDataIndex = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + len)));
    pdfDataBytes = bytes.subarray(4 + len);
  }
  const e = pdfDataIndex?.[name];
  return e ? pdfDataBytes.subarray(e[0], e[0] + e[1]) : null;
}

let manifest: import("./fonts").FontManifestEntry[] | null | undefined;

/** 同梱フォントの一覧（ビルド時に <script type="application/json" id="fonts-manifest"> として埋め込んだもの） */
export function getFontManifest(): import("./fonts").FontManifestEntry[] | null {
  if (manifest === undefined) {
    const el = typeof document !== "undefined" ? document.getElementById("fonts-manifest") : null;
    try {
      manifest = el?.textContent ? JSON.parse(el.textContent) : null;
    } catch {
      manifest = null;
    }
  }
  return manifest ?? null;
}

/** テスト（Node.js）用：DOM を使わずに埋め込みデータを登録する */
export function preloadAsset(id: AssetId, bytes: Uint8Array): void {
  cache.set(id, bytes);
}

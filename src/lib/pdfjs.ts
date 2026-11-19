// 最新ブラウザ専用の構文を含まない legacy ビルドを使う（Safari や少し古い Chrome でも動くように）
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { DocumentInitParameters } from "pdfjs-dist/types/src/display/api";
import { getPdfDataFile, getPdfWorker } from "./assets";

let ready = false;
let extra: Partial<DocumentInitParameters> = {};

/**
 * pdf.js が CMap / WASM を要求したとき、HTML に同梱したデータを返す（外部への通信をしない）。
 * cMapUrl / wasmUrl は「指定あり」と判定させるためのダミーで、実際の取得はこのクラスが行う。
 */
class EmbeddedBinaryDataFactory {
  constructor(_opts: unknown) {}
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const dir = kind === "cMapUrl" ? "cmaps" : kind === "wasmUrl" ? "wasm" : "fonts";
    const data = getPdfDataFile(`${dir}/${filename}`);
    if (!data) throw new Error(`同梱データにありません: ${dir}/${filename}`);
    return data;
  }
}

const EMBEDDED_OPTIONS: Partial<DocumentInitParameters> = {
  cMapUrl: "embedded:/cmaps/",
  cMapPacked: true,
  wasmUrl: "embedded:/wasm/",
  useWorkerFetch: false,
  // フォントごとの「文字コード → 文字」の対応表も受け取る（ToUnicode の無い PDF で、文字の位置を特定するのに使う）
  fontExtraProperties: true,
  BinaryDataFactory: EmbeddedBinaryDataFactory as unknown as DocumentInitParameters["BinaryDataFactory"],
};

/** getDocument に常に渡す追加オプション（テストで CMap の場所などを指定する） */
export function setDocumentOptions(o: Partial<DocumentInitParameters>): void {
  extra = o;
}

export function documentOptions(): Partial<DocumentInitParameters> {
  if (Object.keys(extra).length) return extra;
  return typeof document !== "undefined" ? EMBEDDED_OPTIONS : {};
}

export async function getPdfJs(): Promise<typeof pdfjs> {
  if (!ready) {
    // HTML に埋め込んだワーカーを使う（すべての PDF で1つのワーカーを共有）。Node.js（テスト）では workerSrc 任せ
    if (typeof document !== "undefined") pdfjs.GlobalWorkerOptions.workerPort = getPdfWorker();
    ready = true;
  }
  return pdfjs;
}

/**
 * 開いた PDF を閉じて、ワーカー側の資源を放す。閉じ方は読み込みのタスク（loadingTask）にある
 * （PDFDocumentProxy の destroy は pdf.js 6 で無くなった）
 */
export function closePdf(pdf: { loadingTask: { destroy(): Promise<void> } }): Promise<void> {
  return pdf.loadingTask.destroy();
}

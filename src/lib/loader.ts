import { closePdf, documentOptions, getPdfJs } from "./pdfjs";
import { uid } from "./geometry";
import { tr, AppError } from "./i18n";
import { looksEncrypted, PasswordError, type SecurityInfo, unlockPdf } from "./security";
import type { Matrix, PageItem, SourceDoc, StoredImage } from "./types";
import { displayName } from "./fileName";

/** パスワードを尋ねる。null を返すと読み込みを中止する。retry は前回のパスワードが違ったとき true */
export type AskPassword = (name: string, retry: boolean) => Promise<string | null>;

export async function loadPdfFile(file: File, askPassword?: AskPassword, onWarning?: (message: string) => void): Promise<{ doc: SourceDoc; pages: PageItem[] }> {
  const pdfjs = await getPdfJs();
  let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
  let security: SecurityInfo | null = null;

  // 暗号化されていれば先に解除し、以後は暗号化の無い PDF として扱う（pdf-lib が内容を読めるようにする）
  if (looksEncrypted(bytes)) {
    let password = "";
    let retry = false;
    for (;;) {
      try {
        const r = await unlockPdf(bytes, password);
        bytes = r.bytes;
        security = r.info;
        break;
      } catch (e) {
        if (e instanceof PasswordError) {
          if (!askPassword) throw new AppError(tr("load.password", { name: displayName(file.name) }));
          const pw = await askPassword(displayName(file.name), retry);
          if (pw == null) throw new AppError(tr("load.cancelled", { name: displayName(file.name) }));
          password = pw;
          retry = true;
          continue;
        }
        // 対応していない方式や壊れた辞書：pdf.js に任せて表示だけでも試みる
        onWarning?.(tr("load.unlockFailed", { name: displayName(file.name), message: e instanceof Error ? e.message : String(e) }));
        break;
      }
    }
  }

  const task = pdfjs.getDocument({ ...documentOptions(), data: bytes.slice() });
  task.onPassword = () => {
    task.destroy();
  };
  let pdf;
  try {
    pdf = await task.promise;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/password/i.test(msg)) throw new AppError(tr("load.password", { name: displayName(file.name) }));
    throw new AppError(tr("load.failed", { name: displayName(file.name), message: msg }));
  }

  const doc: SourceDoc = { id: uid("src"), name: displayName(file.name), bytes, pdf, pageCount: pdf.numPages, security, signed: looksSigned(bytes) };
  const pages: PageItem[] = [];
  try {
    for (let i = 0; i < pdf.numPages; i++) {
      const page = await pdf.getPage(i + 1);
      const vp = page.getViewport({ scale: 1 });
      pages.push({
        id: uid("pg"),
        srcId: doc.id,
        srcIndex: i,
        baseRotation: page.rotate,
        extraRotation: 0,
        width: vp.width,
        height: vp.height,
        viewTransform: vp.transform as Matrix,
        objects: [],
      });
    }
  } catch (e) {
    // ページの一覧が壊れている（ページ数が合わない・循環しているなど）：ファイル名を添えて、読み込めなかったことを伝える
    void closePdf(pdf);
    throw new AppError(tr("load.failed", { name: displayName(file.name), message: e instanceof Error ? e.message : String(e) }));
  }
  // ページが 1 枚も無い PDF：何も起きないままにせず、知らせる
  if (!pages.length) {
    void closePdf(pdf);
    throw new AppError(tr("load.noPages", { name: displayName(file.name) }));
  }
  return { doc, pages };
}

export function blankPage(width = 595.28, height = 841.89): PageItem {
  return {
    id: uid("pg"),
    srcId: null,
    srcIndex: 0,
    baseRotation: 0,
    extraRotation: 0,
    width,
    height,
    viewTransform: [1, 0, 0, -1, 0, height],
    objects: [],
  };
}

/** 画像ファイルを PNG / JPEG として取り込む（それ以外は canvas 経由で PNG 化） */
export async function loadImageFile(file: File): Promise<StoredImage> {
  const url0 = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new AppError(tr("load.notImage", { name: displayName(file.name) })));
      el.src = url0;
    });
    let bytes: Uint8Array;
    let mime: StoredImage["mime"];
    if (file.type === "image/png" || file.type === "image/jpeg") {
      bytes = new Uint8Array(await file.arrayBuffer());
      mime = file.type;
    } else {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext("2d")!.drawImage(img, 0, 0);
      const blob = await new Promise<Blob>((res, rej) =>
        c.toBlob((b) => (b ? res(b) : rej(new AppError(tr("load.imageConvert")))), "image/png"),
      );
      bytes = new Uint8Array(await blob.arrayBuffer());
      mime = "image/png";
    }
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
    return { id: uid("img"), bytes, mime, url, width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url0);
  }
}

/** 電子署名（/ByteRange を持つ署名辞書）があるか。署名辞書はオブジェクトストリームに入れられないので、バイト列を直接探せば足りる */
export function looksSigned(bytes: Uint8Array): boolean {
  const pat = Array.from("/ByteRange", (c) => c.charCodeAt(0));
  outer: for (let i = 0; i <= bytes.length - pat.length; i++) {
    if (bytes[i] !== 0x2f || bytes[i + 1] !== 0x42) continue;
    for (let j = 2; j < pat.length; j++) if (bytes[i + j] !== pat[j]) continue outer;
    return true;
  }
  return false;
}

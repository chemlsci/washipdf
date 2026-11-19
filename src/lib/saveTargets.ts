/**
 * 保存先まわり：名前を付けて保存・上書き保存（File System Access API。対応ブラウザのみ）、共有シート、印刷。
 * どれもブラウザの中だけで完結し、通信はしない。
 */
import { safeFileName } from "./fileName";

/** 書き込み先のファイル（対応ブラウザでユーザーが選んだもの） */
export type FileHandle = FileSystemFileHandle & {
  requestPermission?: (o: { mode: "readwrite" }) => Promise<PermissionState>;
};

interface PickerWindow {
  showSaveFilePicker?: (o: { suggestedName?: string; types?: { description?: string; accept: Record<string, string[]> }[] }) => Promise<FileHandle>;
  showOpenFilePicker?: (o: { multiple?: boolean; types?: { description?: string; accept: Record<string, string[]> }[] }) => Promise<FileHandle[]>;
}
const w = (): PickerWindow => (typeof window === "undefined" ? {} : (window as unknown as PickerWindow));

export const canPickSaveFile = () => typeof w().showSaveFilePicker === "function";
export const canPickOpenFile = () => typeof w().showOpenFilePicker === "function";

/** ユーザーが取り消したとき（エラーとして出さない） */
export const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

/** 保存先を選んでもらう。取り消したら null */
export async function pickSaveFile(suggestedName: string): Promise<FileHandle | null> {
  try {
    return await w().showSaveFilePicker!({ suggestedName, types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }] });
  } catch (e) {
    if (isAbort(e)) return null;
    throw e;
  }
}

/** 開くファイルを選んでもらう（上書き保存できるよう、ファイルそのものへの参照も受け取る）。取り消したら null */
export async function pickOpenFiles(): Promise<{ file: File; handle: FileHandle }[] | null> {
  try {
    const handles = await w().showOpenFilePicker!({
      multiple: true,
      types: [{ description: "PDF / images", accept: { "application/pdf": [".pdf"], "image/*": [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif"] } }],
    });
    return await Promise.all(handles.map(async (handle) => ({ file: await handle.getFile(), handle })));
  } catch (e) {
    if (isAbort(e)) return null;
    throw e;
  }
}

/** ドロップされたファイルへの参照（対応ブラウザのみ）。イベントの処理中に同期的に呼ぶこと */
export function handlesFromDrop(dt: DataTransfer | null): Promise<FileHandle | null>[] {
  const out: Promise<FileHandle | null>[] = [];
  for (const it of dt?.items ?? []) {
    const get = (it as unknown as { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> }).getAsFileSystemHandle;
    if (it.kind !== "file" || !get) continue;
    out.push(
      get
        .call(it)
        .then((h) => (h && h.kind === "file" ? (h as FileHandle) : null))
        .catch(() => null),
    );
  }
  return out;
}

/** 書き込みの許可を求める（ユーザー操作の直後に呼ぶ）。許可されなければ false */
export async function allowWrite(handle: FileHandle): Promise<boolean> {
  if (!handle.requestPermission) return true;
  try {
    return (await handle.requestPermission({ mode: "readwrite" })) === "granted";
  } catch {
    return false;
  }
}

/** 書き込めなかったあとの、保存先のファイルの状態（利用者への知らせを正しく出すために区別する） */
export type FileStateAfter =
  /** 書き込む前のまま（中身は入れ替わっていない） */
  | "intact"
  /** 今回の「名前を付けて保存」でこのアプリが作った空のファイルで、片付けた */
  | "removed"
  /** 中身が入れ替わったが、書いた内容と合わない（空・途中まで、など） */
  | "damaged";

/** 選んだファイルへ書き込めなかった（または、書けたことを確かめられなかった） */
export class WriteFailed extends Error {
  readonly fileState: FileStateAfter;
  constructor(fileState: FileStateAfter, cause?: unknown) {
    super("write failed");
    this.name = "WriteFailed";
    this.fileState = fileState;
    this.cause = cause;
  }
}

type Writable = { write: (data: BufferSource | Blob) => Promise<void>; close: () => Promise<void>; abort?: (reason?: unknown) => Promise<void> };

/** 先頭と末尾を読み直して、書いた内容と同じかを確かめる（全部は読まない。大きさだけでは、同じ大きさの別の中身を見逃す） */
async function sameEdges(file: File, bytes: Uint8Array): Promise<boolean> {
  const n = Math.min(1024, bytes.length);
  try {
    const head = new Uint8Array(await file.slice(0, n).arrayBuffer());
    const tail = new Uint8Array(await file.slice(bytes.length - n).arrayBuffer());
    if (head.length !== n || tail.length !== n) return false;
    for (let i = 0; i < n; i++) if (head[i] !== bytes[i] || tail[i] !== bytes[bytes.length - n + i]) return false;
    return true;
  } catch {
    // 中身を読み直せない保存先では確かめようがない（大きさは合っている）
    return true;
  }
}

/**
 * 選んだファイルへ書き込み、書けたことを確かめる。
 * 端末やアプリの組み合わせによっては、書き込みが成功したように見えて中身が空（0 B）のままになることがある
 * （スマホで、保存先が別アプリの管理する場所のとき）。書いた後に読み直し、合わなければ別の渡し方でもう一度試す。
 * それでも合わなければ WriteFailed を投げる（呼び出し側がダウンロードに切り替える）。
 *
 * 前からあったファイルを失わないための決まり：
 * - 書き込みは一時的な場所に行われ、close() で初めて保存先と入れ替わる。途中で失敗したら close() せず abort() する
 *   （失敗した書き込みを close() すると、途中までの中身で保存先を置き換えるおそれがある）
 * - 保存先のファイルは消さない。消してよいのは、今回の「名前を付けて保存」でできた空のファイル（fresh）だけ
 */
export async function writeToHandle(handle: FileHandle, bytes: Uint8Array, opts: { fresh?: boolean } = {}): Promise<void> {
  // 書き込む前の姿。読めなければ「前からあった」ものとして扱う（消さない）
  let before: { size: number; lastModified: number } | null = null;
  try {
    const f = await handle.getFile();
    before = { size: f.size, lastModified: f.lastModified };
  } catch {
    before = null;
  }
  const createdNow = !!opts.fresh && before?.size === 0;
  // close() まで進んだことがあるか（＝保存先の中身が入れ替わったか）
  let committed = false;
  let lastError: unknown;
  const attempt = async (data: BufferSource | Blob) => {
    const out = (await handle.createWritable()) as unknown as Writable;
    try {
      await out.write(data);
    } catch (e) {
      try {
        await out.abort?.(e);
      } catch {
        /* すでに閉じられている */
      }
      throw e;
    }
    await out.close();
    committed = true;
    // 読み直せない保存先では確かめようがないので、書けたものとして扱う（書き込み自体は例外なく終わっている）
    let file: File;
    try {
      file = await handle.getFile();
    } catch {
      return true;
    }
    return file.size === bytes.length && (await sameEdges(file, bytes));
  };
  let ok = false;
  try {
    ok = await attempt(bytes as BufferSource);
  } catch (e) {
    lastError = e;
  }
  if (!ok) {
    try {
      ok = await attempt(new Blob([bytes as BlobPart], { type: "application/pdf" }));
    } catch (e) {
      lastError = e;
    }
  }
  if (ok) return;
  // 失敗したあとの姿を確かめる
  let after: { size: number; lastModified: number } | null = null;
  try {
    const f = await handle.getFile();
    after = { size: f.size, lastModified: f.lastModified };
  } catch {
    after = null;
  }
  if (createdNow && (!after || after.size === 0)) {
    // 今回できた空のファイルだけを片付ける（中身のあるファイル・前からあったファイルには触れない）
    try {
      await (handle as unknown as { remove?: () => Promise<void> }).remove?.();
    } catch {
      /* 消せなくても先へ進む */
    }
    throw new WriteFailed("removed", lastError);
  }
  // 大きさも更新時刻も書き込む前と同じなら、中身は入れ替わっていない（書き込みが黙って捨てられた場合を含む）。
  // 比べられないときは、close() まで進んでいれば「入れ替わった」とみなす
  const same = !!before && !!after && before.size === after.size && before.lastModified === after.lastModified;
  const comparable = !!before && !!after;
  throw new WriteFailed(same ? "intact" : comparable || committed ? "damaged" : "intact", lastError);
}

/**
 * 保存先を選んだときにできた空のファイルを片付ける（選んだのに、何も書かずに終わったとき）。
 * 中身のあるファイル・大きさを確かめられないファイルには触れない
 */
export async function removeIfEmpty(handle: FileHandle): Promise<void> {
  try {
    if ((await handle.getFile()).size !== 0) return;
    await (handle as unknown as { remove?: () => Promise<void> }).remove?.();
  } catch {
    /* 消せなくても困らない */
  }
}

const pdfFile = (bytes: Uint8Array, name: string) => new File([bytes as BlobPart], name, { type: "application/pdf" });

/** このブラウザが PDF ファイルの共有（OS の共有シート）に対応しているか */
export function canShareFiles(): boolean {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function" || typeof navigator.canShare !== "function") return false;
  try {
    return navigator.canShare({ files: [pdfFile(new Uint8Array([0x25, 0x50, 0x44, 0x46]), "a.pdf")] });
  } catch {
    return false;
  }
}

/**
 * 共有シートを開く。"shared"：共有した／"cancelled"：ユーザーが閉じた／
 * "needs-tap"：書き出しに時間がかかり、ユーザー操作の扱いが切れた（もう一度ボタンを押してもらう必要がある）
 */
export async function sharePdf(bytes: Uint8Array, name: string): Promise<"shared" | "cancelled" | "needs-tap"> {
  try {
    await navigator.share({ files: [pdfFile(bytes, name)], title: name });
    return "shared";
  } catch (e) {
    if (isAbort(e)) return "cancelled";
    if (e instanceof DOMException && e.name === "NotAllowedError") return "needs-tap";
    throw e;
  }
}

/** ファイル名に使えない文字を置き換え、拡張子 .pdf を付ける */
export function pdfFileName(input: string, fallback: string): string {
  const base = safeFileName(String(input ?? "").trim().replace(/\.pdf$/i, ""), "", 120);
  return `${base || safeFileName(fallback, "document")}.pdf`;
}

let printFrame: HTMLIFrameElement | null = null;
let printUrl: string | null = null;

/** ブラウザ内蔵の PDF 表示でそのまま印刷できる見込みがあるか（スマホや一部のブラウザはできない） */
export function canPrintInline(): boolean {
  if (typeof navigator === "undefined") return false;
  const enabled = (navigator as Navigator & { pdfViewerEnabled?: boolean }).pdfViewerEnabled;
  if (enabled === false) return false;
  // Safari は iframe の中の PDF を印刷できない（白紙になる）
  const ua = navigator.userAgent;
  if (/Safari\//.test(ua) && !/Chrom(e|ium)\/|Edg\/|Firefox\//.test(ua)) return false;
  return enabled === true;
}

/**
 * PDF を見えない枠に読み込み、印刷ダイアログを開く（画像化しないので、文字は文字のまま印刷される）。
 * 枠と URL は、印刷ダイアログが閉じた後も次の印刷まで残す（途中で消すと印刷できないブラウザがある）。
 */
export function printPdf(bytes: Uint8Array): Promise<void> {
  if (printFrame) printFrame.remove();
  if (printUrl) URL.revokeObjectURL(printUrl);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none";
  printFrame = frame;
  printUrl = url;
  return new Promise((resolve, reject) => {
    frame.onload = () => {
      // 内蔵ビューアーの準備が終わるまで少し待つ
      setTimeout(() => {
        try {
          frame.contentWindow!.focus();
          frame.contentWindow!.print();
          resolve();
        } catch (e) {
          reject(e);
        }
      }, 400);
    };
    frame.onerror = () => reject(new Error("print"));
    frame.src = url;
    document.body.appendChild(frame);
  });
}

/** 別のタブで PDF を開く（そのまま印刷できないブラウザ向け。ユーザー操作の直後に呼ぶ） */
export function openPdfInNewTab(bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

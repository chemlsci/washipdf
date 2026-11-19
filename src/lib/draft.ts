/**
 * 作業の自動保存（下書き）：ブラウザの IndexedDB に、ページ構成・編集・設定と元 PDF のバイト列を残す。
 * 次回開いたときに「前回の作業を復元」できる。通信はしない（ブラウザの中だけ）。
 *
 * - "state"：軽い部分（ページ構成・オブジェクト・設定）。変更のたびに書く
 * - "blob:<id>"：元 PDF と画像のバイト列。初めて現れたときだけ書き、参照されなくなったら消す
 * - パスワード付きで開いた PDF は保存しない（解除済みの内容を残さないため）。保護の設定も残さない
 *   （保護を設定していたかどうかだけを残し、復元したときに「設定し直してください」と知らせる。パスワードは残さない）
 * - 最後に書いてから EXPIRE_MS たった下書きは、次に開いたときに消す（共用の端末に、いつまでも残さない）
 * - 利用者が自動保存を切っているあいだは書かない。切ったときに、残っている下書きも消す
 *
 * 注意：HTML ファイルを直接開いて使うとき（file://）、ブラウザーによっては、同じ端末のほかの HTML ファイルからも
 * この保存領域を読める。「このソフトについて」の説明と、自動保存を切るスイッチはこのためにある
 */
import type { DocSettings } from "./docOps";
import { defaultSecurity } from "./security";
import type { PageItem, SourceDoc, StoredImage } from "./types";

const DB_NAME = "washi-pdf";
const STORE = "draft";
const STATE_KEY = "state";
/** これより大きい下書きは保存しない（ブラウザの容量と書き込み時間の目安） */
const MAX_BYTES = 400 * 1024 * 1024;
/** 下書きを残しておく期間（最後の自動保存から） */
export const EXPIRE_MS = 7 * 24 * 60 * 60 * 1000;
const SETTING_KEY = "washi-pdf.autosave";

/**
 * HTML ファイルを直接開いて使っているか（ダウンロード版）。この場合、ブラウザーによっては、同じ端末のほかの HTML ファイルからも
 * 保存領域を読めるので、自動保存は既定で切っておく（「このソフトについて」で入れられる）
 */
export const isLocalFile = () => typeof location !== "undefined" && location.protocol === "file:";

/** 自動保存の設定が、利用者に選ばれていない（既定のまま）か */
export function autosaveIsDefault(): boolean {
  try {
    return localStorage.getItem(SETTING_KEY) == null;
  } catch {
    return true;
  }
}

/** 自動保存を使うか（利用者の設定。既定は、Web 版では使う、ダウンロード版では使わない） */
export function autosaveEnabled(): boolean {
  try {
    const v = localStorage.getItem(SETTING_KEY);
    if (v === "on") return true;
    if (v === "off") return false;
    return !isLocalFile();
  } catch {
    return !isLocalFile();
  }
}

export function setAutosaveEnabled(on: boolean): void {
  try {
    localStorage.setItem(SETTING_KEY, on ? "on" : "off");
  } catch {
    /* 設定を残せなくても、この起動のあいだは呼び出し側の状態で動く */
  }
}

/**
 * 下書きの読み書きは、呼ばれた順に 1 つずつ行う。
 * 「書いている途中に文書を閉じた」とき、あとから終わった書き込みが、消したはずの下書きを作り直してしまうのを防ぐ
 */
let queue: Promise<unknown> = Promise.resolve();
function inOrder<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

export interface DraftState {
  v: 1;
  savedAt: number;
  baseName: string;
  currentId: string | null;
  pages: PageItem[];
  settings: DocSettings;
  sources: { id: string; name: string }[];
  images: { id: string; mime: StoredImage["mime"]; width: number; height: number }[];
  /** 保存時のパスワード保護を設定していたか（パスワードそのものは残さない） */
  hadProtection?: boolean;
}

export interface DraftSummary {
  baseName: string;
  pageCount: number;
  savedAt: number;
}

const hasIdb = () => typeof indexedDB !== "undefined";

/** 保存領域を開くのを待つ上限。ブラウザーの設定によっては、開く要求に何の返事も来ないことがある */
const OPEN_TIMEOUT_MS = 8000;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    // 返事が来ないまま待ち続けない（待ち続けると、あとに並んだ読み書きも、すべて止まってしまう）
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      reject(new Error("indexedDB timeout"));
    }, OPEN_TIMEOUT_MS);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      clearTimeout(timer);
      // 待つのをやめたあとで開いたものは、使わずに閉じる
      if (late) req.result.close();
      else resolve(req.result);
    };
    req.onerror = () => {
      clearTimeout(timer);
      reject(req.error ?? new Error("indexedDB"));
    };
    req.onblocked = () => {
      clearTimeout(timer);
      // このあとで開けることもある。そのときは使わずに閉じる
      late = true;
      reject(new Error("indexedDB blocked"));
    };
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result: T | undefined;
    const req = run(store);
    if (req) req.onsuccess = () => (result = req.result);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error ?? new Error("indexedDB"));
    t.onabort = () => reject(t.error ?? new Error("indexedDB aborted"));
  });
}

/* ---------- 同じ端末で、アプリを 2 つ以上のタブで開いているとき ----------
 * 下書きは 1 つしか置けない。後から書いたタブが前のタブの下書きを置き換え、前のタブの元 PDF を「使われていない」として消してしまう。
 * そこで、下書きを書けるのは「下書きの係」を取れた 1 つのタブだけにする（ブラウザーの Web Locks。タブを閉じると自動で手放される）。
 * 係でないタブは自動保存せず、その旨を知らせ、閉じる前に確認を出す。係のタブがいる間は、ほかのタブで復元を尋ねたり、下書きを消したりしない。
 * Web Locks の無い環境では、これまでどおり（係の取り合いをしない）。
 */
const LOCK = "washi-pdf-draft";
type Locks = {
  request: (name: string, opts: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<void> | void) => Promise<unknown>;
  query: () => Promise<{ held?: { name?: string }[] }>;
};
const locks = (): Locks | null => {
  const l = typeof navigator !== "undefined" ? (navigator as unknown as { locks?: Locks }).locks : undefined;
  return l && typeof l.request === "function" && typeof l.query === "function" ? l : null;
};
let releaseLock: (() => void) | null = null;
let claiming: Promise<boolean> | null = null;

/** 下書きの係を取る（取れたら、手放すまで持ち続ける）。取れなければ false（ほかのタブが係） */
function claimDraft(): Promise<boolean> {
  if (releaseLock) return Promise.resolve(true);
  const l = locks();
  if (!l) return Promise.resolve(true);
  if (!claiming)
    claiming = new Promise<boolean>((resolve) => {
      l.request(LOCK, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          return;
        }
        return new Promise<void>((done) => {
          releaseLock = () => {
            releaseLock = null;
            done();
          };
          resolve(true);
        });
      }).catch(() => resolve(true));
    }).finally(() => (claiming = null));
  return claiming;
}

/** 下書きの係を手放す（文書を閉じたとき）。このタブが書いた下書きはそのまま残る */
export function releaseDraft(): void {
  releaseLock?.();
}

/** ほかのタブが下書きの係をしているか（このタブが係なら false） */
async function heldElsewhere(): Promise<boolean> {
  if (releaseLock) return false;
  const l = locks();
  if (!l) return false;
  try {
    return !!(await l.query()).held?.some((h) => h.name === LOCK);
  } catch {
    return false;
  }
}

/** 古くなった下書きか（最後に書いてから EXPIRE_MS を過ぎた。時計が大きく戻っている場合も古いものとして扱う） */
export const isExpired = (savedAt: number, now = Date.now()) => !Number.isFinite(savedAt) || now - savedAt > EXPIRE_MS || savedAt - now > EXPIRE_MS;

/** 下書きの有無と概要（復元を尋ねる前に使う）。古くなった下書き・自動保存を切っているときの下書きは、ここで消す */
export function peekDraft(): Promise<DraftSummary | null> {
  return inOrder(async () => {
    if (!hasIdb()) return null;
    // ほかのタブで編集中の文書の下書き：そのタブがまだ使っているので、ここでは尋ねない（消しもしない）
    if (await heldElsewhere()) return null;
    try {
      const db = await openDb();
      try {
        const state = (await tx<DraftState>(db, "readonly", (s) => s.get(STATE_KEY))) ?? null;
        if (!state) return null;
        if (!autosaveEnabled() || isExpired(state.savedAt) || !Array.isArray(state.pages) || !state.pages.length) {
          await tx(db, "readwrite", (s) => s.clear());
          return null;
        }
        return { baseName: String(state.baseName), pageCount: state.pages.length, savedAt: state.savedAt };
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
  });
}

export interface DraftInput {
  baseName: string;
  currentId: string | null;
  pages: PageItem[];
  settings: DocSettings;
  sources: Map<string, SourceDoc>;
  images: Map<string, StoredImage>;
}

/**
 * 自動保存の結果。saved 以外は「この文書は自動保存されていない」ことを表す（理由を利用者に知らせる）：
 * protected＝パスワード付きで開いた PDF を含む／too-large＝大きすぎる／unavailable＝保存領域を使えない（ブラウザーの設定・容量など）／
 * other-tab＝ほかのタブで編集中の文書が下書きを使っている
 */
export type DraftStatus = "saved" | "protected" | "too-large" | "unavailable" | "other-tab";

/** 下書きを書く */
export function saveDraft(d: DraftInput): Promise<DraftStatus> {
  return inOrder(() => writeDraft(d));
}

async function writeDraft(d: DraftInput): Promise<DraftStatus> {
  if (!hasIdb()) return "unavailable";
  if (!(await claimDraft())) return "other-tab";
  const usedSrc = new Set(d.pages.map((p) => p.srcId).filter((x): x is string => !!x));
  const usedImg = new Set<string>();
  for (const p of d.pages) for (const o of p.objects) if (o.type === "image") usedImg.add(o.imageId);
  if (d.settings.decor.watermark.imageId) usedImg.add(d.settings.decor.watermark.imageId);
  let total = 0;
  for (const id of usedSrc) {
    const s = d.sources.get(id);
    if (!s) return "unavailable";
    if (s.security) return "protected";
    total += s.bytes.length;
  }
  for (const id of usedImg) total += d.images.get(id)?.bytes.length ?? 0;
  for (const a of d.settings.attachments) total += a.bytes.length;
  if (total > MAX_BYTES) return "too-large";
  const state: DraftState = {
    v: 1,
    savedAt: Date.now(),
    baseName: d.baseName,
    currentId: d.currentId,
    pages: d.pages,
    settings: { ...d.settings, security: defaultSecurity() },
    sources: [...usedSrc].map((id) => ({ id, name: d.sources.get(id)!.name })),
    images: [...usedImg].filter((id) => d.images.has(id)).map((id) => {
      const im = d.images.get(id)!;
      return { id, mime: im.mime, width: im.width, height: im.height };
    }),
    hadProtection: d.settings.security.enabled || undefined,
  };
  try {
    const db = await openDb();
    try {
      const keys = ((await tx<IDBValidKey[]>(db, "readonly", (s) => s.getAllKeys())) ?? []).map(String);
      const want = new Set([...[...usedSrc].map((id) => `blob:${id}`), ...state.images.map((i) => `blob:${i.id}`)]);
      await tx(db, "readwrite", (s) => {
        s.put(state, STATE_KEY);
        for (const k of keys) if (k !== STATE_KEY && !want.has(k)) s.delete(k);
        for (const id of usedSrc) if (!keys.includes(`blob:${id}`)) s.put(d.sources.get(id)!.bytes, `blob:${id}`);
        for (const im of state.images) if (!keys.includes(`blob:${im.id}`)) s.put(d.images.get(im.id)!.bytes, `blob:${im.id}`);
      });
      return "saved";
    } finally {
      db.close();
    }
  } catch {
    return "unavailable";
  }
}

export interface LoadedDraft {
  state: DraftState;
  sourceBytes: Map<string, Uint8Array>;
  imageBytes: Map<string, Uint8Array>;
}

export function loadDraft(): Promise<LoadedDraft | null> {
  return inOrder(readDraft);
}

async function readDraft(): Promise<LoadedDraft | null> {
  if (!hasIdb()) return null;
  try {
    const db = await openDb();
    try {
      const state = (await tx<DraftState>(db, "readonly", (s) => s.get(STATE_KEY))) ?? null;
      if (!state || state.v !== 1) return null;
      const sourceBytes = new Map<string, Uint8Array>();
      const imageBytes = new Map<string, Uint8Array>();
      for (const s of state.sources) {
        const b = await tx<Uint8Array>(db, "readonly", (st) => st.get(`blob:${s.id}`));
        if (!b) return null;
        sourceBytes.set(s.id, b);
      }
      for (const im of state.images) {
        const b = await tx<Uint8Array>(db, "readonly", (st) => st.get(`blob:${im.id}`));
        if (b) imageBytes.set(im.id, b);
      }
      return { state, sourceBytes, imageBytes };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export function clearDraft(): Promise<void> {
  return inOrder(eraseDraft);
}

async function eraseDraft(): Promise<void> {
  if (!hasIdb()) return;
  // ほかのタブが使っている下書きは消さない
  if (await heldElsewhere()) return;
  try {
    const db = await openDb();
    try {
      await tx(db, "readwrite", (s) => s.clear());
    } finally {
      db.close();
    }
  } catch {
    /* 消せなくても困らない */
  }
}

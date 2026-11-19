import type { Record as HistRecord } from "@/lib/useHistory";
import { ShortcutsDialog } from "./tools/ShortcutsDialog";
import { AnnotListDialog } from "./tools/AnnotListDialog";
import { BatchDialog } from "./tools/BatchDialog";
import { askConfirm } from "@/lib/confirm";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type DocDecor, type DocMeta, defaultSettings } from "@/lib/docOps";
import { buildPdf, type BuildOptions } from "@/lib/exportPdf";
import { uid } from "@/lib/geometry";
import { clamp, LIMITS } from "@/lib/limits";
import { detectLang, isRtl, type Lang, LangContext, LANGS, saveLang, setCurrentLang, useLang, useT, AppError } from "@/lib/i18n";
import { ocrConfig } from "@/lib/ocr";
import { addOcrLayer } from "@/lib/ocrLayer";
import { type AskPassword, blankPage, loadImageFile, loadPdfFile } from "@/lib/loader";
import { checkForUpdate, downloadUpdate, hasSavedApp, savedVersion, type VersionInfo, versionLabel } from "@/lib/appUpdate";
import { autosaveEnabled, autosaveIsDefault, clearDraft, isLocalFile, type DraftStatus, type DraftSummary, loadDraft, peekDraft, releaseDraft, saveDraft, setAutosaveEnabled } from "@/lib/draft";
import { defaultFont, ensureInputFallback, warmFonts } from "@/lib/fonts";
import type { RedactCheck } from "@/lib/redactCheck";
import type { SecuritySettings } from "@/lib/security";
import type { CompressSettings, CompressStats } from "@/lib/compress";
import { type AttachmentItem, readAttachments } from "@/lib/attachments";
import { imposePdf, type ImposeOptions } from "@/lib/impose";
import { getLibDoc } from "@/lib/libDoc";
import { type OutlineItem, readOutlines } from "@/lib/outlines";
import { findBlankPages, fitImageToPaper, PAPER_SIZES, reversePages } from "@/lib/pageOps";
import { closePdf, documentOptions, getPdfJs } from "@/lib/pdfjs";
import { renderToCanvas } from "@/lib/render";
import { fillForm } from "@/lib/forms";
import { exportText } from "@/lib/textExport";
import { clearPageTextCache } from "@/lib/textRuns";
import type { Doc, EditObj, ImageObj, PageItem, SourceDoc, StoredImage, TextEditObj } from "@/lib/types";
import { loadTheme, saveTheme, type Theme } from "@/lib/theme";
import { useHistory } from "@/lib/useHistory";
import { createZip, downloadBlob } from "@/lib/zip";
import { allowWrite, canPickOpenFile, canPickSaveFile, canPrintInline, canShareFiles, type FileHandle, handlesFromDrop, openPdfInNewTab, pdfFileName, pickOpenFiles, pickSaveFile, printPdf, removeIfEmpty, sharePdf, WriteFailed, writeToHandle } from "@/lib/saveTargets";
import { checkOutput } from "@/lib/outputCheck";
import { ConfirmHost, Dialog } from "./Dialog";
import { CrashNotice, ErrorBoundary } from "./ErrorBoundary";
import { TYPE_LABEL } from "./PropertiesPanel";
import { EditorView } from "./EditorView";
import { Icon } from "./Icon";
import { Logo, Wordmark } from "./Logo";
import { OrganizeView } from "./OrganizeView";
import { type Mode, Rail } from "./Rail";
import { SplitDialog } from "./SplitDialog";
import { type ToolId, ToolsView } from "./ToolsView";
import type { FocusRequest } from "./EditorView";
import { ExportImagesDialog, ExportTextDialog, type ImageExportOptions, type ImageToPdfOptions, ImageToPdfDialog, MetadataDialog } from "./tools/ExportDialogs";
import { FormDialog } from "./tools/FormDialog";
import { OcrDialog, type OcrOutcome } from "./tools/OcrDialog";
import { PasswordDialog, ProtectDialog } from "./tools/SecurityDialogs";
import { CompressDialog, formatBytes } from "./tools/CompressDialog";
import { AttachmentsDialog } from "./tools/AttachmentsDialog";
import { CompareDialog } from "./tools/CompareDialog";
import { ImposeDialog } from "./tools/ImposeDialog";
import { OutlineDialog } from "./tools/OutlineDialog";
import { WarekiDialog } from "./tools/WarekiDialog";
import { FindDialog, type FindResult } from "./tools/FindDialog";
import { ChangeSummaryDialog } from "./tools/ChangeSummaryDialog";
import { CropDialog, InterleaveDialog, ResizeDialog } from "./tools/PageToolsDialogs";
import { HeaderFooterDialog, PageNumbersDialog, WatermarkDialog } from "./tools/StampDialogs";
import { displayName } from "@/lib/fileName";

/** 言語の状態を持つ外側。中身（Studio）は useT() で文言を引く */
export default function WashiPdf(props: { embedFont?: BuildOptions["embedFont"] } = {}) {
  const [lang, setLangState] = useState<Lang>(() => {
    const l = detectLang();
    setCurrentLang(l);
    return l;
  });
  // 入力欄：端末にフォントが無い文字（タイ語・ヒンディー語・アラビア語など）を入力・表示したときは、同梱フォントで表示する
  useEffect(() => {
    const on = (e: Event) => {
      const el = e.target;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) ensureInputFallback(el.value);
    };
    document.addEventListener("input", on, true);
    document.addEventListener("focusin", on, true);
    return () => {
      document.removeEventListener("input", on, true);
      document.removeEventListener("focusin", on, true);
    };
  }, []);
  // <html lang dir> を言語に合わせる（アラビア語などは右から左）
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = isRtl(lang) ? "rtl" : "ltr";
  }, [lang]);
  const setLang = useCallback((l: Lang) => {
    setCurrentLang(l);
    saveLang(l);
    clearPageTextCache();
    setLangState(l);
  }, []);
  return (
    <LangContext.Provider value={{ lang, setLang }}>
      <Studio {...props} />
    </LangContext.Provider>
  );
}

/** 履歴の 1 手で何が変わったか（「元に戻す：楕円の追加」のように出す）。分からなければ「変更」 */
function describeStep(a: Doc, b: Doc, t: ReturnType<typeof useT>): string {
  const label = (o: EditObj) => t(o.type === "stamp" && o.frame === "grid" ? "sign.approval" : TYPE_LABEL[o.type]);
  if (a.pages.length !== b.pages.length || a.pages.some((pg, i) => pg.id !== b.pages[i].id)) return t("history.pages");
  for (let i = 0; i < a.pages.length; i++) {
    const pa = a.pages[i];
    const pb = b.pages[i];
    if (pa === pb) continue;
    if (pa.objects !== pb.objects) {
      const before = new Map(pa.objects.map((o) => [o.id, o]));
      const after = new Map(pb.objects.map((o) => [o.id, o]));
      const added = pb.objects.find((o) => !before.has(o.id));
      if (added) return t("history.add", { what: label(added) });
      const removed = pa.objects.find((o) => !after.has(o.id));
      if (removed) return t("history.remove", { what: label(removed) });
      const changed = pb.objects.find((o) => before.get(o.id) !== o);
      if (changed) return t("history.edit", { what: label(changed) });
    }
    return t("history.pages");
  }
  return a.settings !== b.settings ? t("history.settings") : t("history.change");
}

type DialogId = ToolId | "about" | "changes" | "saveName" | "shortcuts" | null;

const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;

function Studio({ embedFont }: { embedFont?: BuildOptions["embedFont"] }) {
  const t = useT();
  const sources = useRef(new Map<string, SourceDoc>()).current;
  const images = useRef(new Map<string, StoredImage>()).current;
  // 文書を開く前（ページが無い状態）へは「元に戻す」で戻らない
  const hist = useHistory<Doc>({ pages: [], settings: defaultSettings() }, (d) => d.pages.length === 0);
  const { pages, settings } = hist.state;

  const [mode, setMode] = useState<Mode>("pages");
  // 注釈の一覧から、編集画面のその場所へ移るときの頼み
  const [focusReq, setFocusReq] = useState<FocusRequest | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "error" | "info"; text: string; ms?: number } | null>(null);
  const [dialog, setDialog] = useState<DialogId>(null);
  /** 読み込み中の PDF がパスワードを要求したときの入力待ち */
  const [pwPrompt, setPwPrompt] = useState<{ name: string; retry: boolean; resolve: (pw: string | null) => void } | null>(null);
  const askPassword = useCallback<AskPassword>((name, retry) => new Promise((resolve) => setPwPrompt({ name, retry, resolve })), []);
  const [pendingImages, setPendingImages] = useState<File[] | null>(null);
  const [baseName, setBaseName] = useState("document");
  /** 上書きできる保存先：開いた元のファイル（original）か、「名前を付けて保存」で選んだファイル */
  const [saveTarget, setSaveTarget] = useState<{ handle: FileHandle; name: string; original: boolean } | null>(null);
  /** 書き出しに時間がかかってユーザー操作の扱いが切れたとき、もう一度押してもらうための待ち（共有・別タブで開く） */
  const [ready, setReady] = useState<{ kind: "share" | "print"; bytes: Uint8Array; name: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  /** 画像だけを選ぶ入力（画像から PDF） */
  const imageInput = useRef<HTMLInputElement>(null);
  const insertAtRef = useRef<number | undefined>(undefined);
  /** 起動時に見つかった前回の下書き（復元するか尋ねる） */
  const [draft, setDraft] = useState<DraftSummary | null>(null);
  const draftChecked = useRef(false);

  const showError = (e: unknown) => setToast({ kind: "error", text: e instanceof Error ? e.message : String(e) });
  const info = (text: string) => setToast({ kind: "info", text });

  /* ---------- 文書の切り替え ---------- */

  /** 読み込みの途中か（途中は、新しい文書への切り替えや、使われていない元 PDF の片付けをしない） */
  const loading = useRef(0);
  /** 自動保存の様子（この文書について）。status は直近の結果、told は「自動保存されない」と知らせ済みの理由 */
  const autosave = useRef<{ status: DraftStatus | "off" | null; told: string | null }>({ status: null, told: null });
  /** 最後に保存（書き出し）した時点の文書。これと同じなら、閉じても失うものは無い */
  const savedState = useRef<Doc | null>(null);
  /** 最後に自動保存できた時点の文書。いまの文書と違えば、まだ下書きに入っていない編集がある */
  const draftedState = useRef<Doc | null>(null);
  /** 下書きから復元した文書か（復元した内容は「元に戻す」の履歴に無いが、保存していない編集として扱う） */
  const restoredUnsaved = useRef(false);
  const stateRef = useRef(hist.state);
  stateRef.current = hist.state;
  /** 文書を手放すたびに進む番号（時間のかかる処理の結果が、もう別の文書のものになっていないかを見分ける） */
  const docGen = useRef(0);

  /**
   * いまの文書を手放す：履歴・設定・元 PDF・画像・保存先を、すべて最初の状態に戻す。
   * 文書を閉じるときだけでなく、何も無い画面から次の文書を始めるときにも必ず通す
   * （前の文書のパスワード保護・透かしなどの設定や、上書き保存の保存先を、次の文書へ持ち越さないため）
   */
  const resetDocument = useCallback(
    (keepDraft = false) => {
      docGen.current++;
      // 履歴も消す：手放した文書の元データは破棄するので、「元に戻す」で戻れてはいけない
      hist.reset({ pages: [], settings: defaultSettings() });
      for (const src of sources.values()) void closePdf(src.pdf).catch(() => undefined);
      sources.clear();
      for (const im of images.values()) URL.revokeObjectURL(im.url);
      images.clear();
      clearPageTextCache();
      setSelected(new Set());
      setCurrentId(null);
      setMode("pages");
      setBaseName("document");
      setSaveTarget(null);
      autosave.current = { status: null, told: null };
      savedState.current = null;
      draftedState.current = null;
      restoredUnsaved.current = false;
      // 手放した文書についての知らせを、次の文書の画面に残さない
      setToast(null);
      setNotice(null);
      // 下書きの係も手放す（ほかのタブが自動保存できるように。下書きを残すときも、次に書くときに取り直す）
      if (!keepDraft) void clearDraft().then(releaseDraft);
      else releaseDraft();
    },
    [hist, sources, images],
  );

  /* ---------- 自動保存（下書き） ---------- */

  /** 自動保存を使うか（利用者の設定。「このソフトについて」で切り替える） */
  const [autosaveOn, setAutosaveOn] = useState(autosaveEnabled);
  /** 起動時の下書きの確認が済んだら解決する（確認が済む前に開かれたファイルは、済むまで待たせる） */
  const draftReady = useRef<{ promise: Promise<void>; done: boolean; resolve: () => void } | null>(null);
  if (!draftReady.current) {
    let resolve = () => {};
    const promise = new Promise<void>((r) => (resolve = r));
    draftReady.current = { promise, done: false, resolve };
  }
  /** 復元を尋ねている最中か（描き直しを待たずに分かるように ref でも持つ） */
  const draftAsking = useRef(false);
  /** 復元を尋ねている間に開かれたファイル（答えが出るまで開かずに待たせる） */
  const [pendingOpen, setPendingOpen] = useState<{ files: File[]; insertAt?: number; handles?: (FileHandle | null)[] } | null>(null);
  /** 手の空いたときに出す知らせ（ほかの知らせを押しのけない） */
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (draftChecked.current) return;
    draftChecked.current = true;
    const ready = () => {
      draftReady.current!.done = true;
      draftReady.current!.resolve();
    };
    // 保存領域から返事が来ない環境でも、ファイルを開くのをいつまでも待たせない
    const giveUp = setTimeout(ready, 4000);
    void peekDraft().then((d) => {
      clearTimeout(giveUp);
      // 待ちきれずに先へ進んだあとでも、まだ何も開いていなければ尋ねる。すでに文書を開き始めていたら尋ねない
      if (d && (!draftReady.current!.done || (!stateRef.current.pages.length && !loading.current))) {
        draftAsking.current = true;
        setDraft(d);
      }
      ready();
    });
  }, []);

  const draftInput = useRef({ pages, settings, baseName, currentId });
  draftInput.current = { pages, settings, baseName, currentId };
  useEffect(() => {
    // 変更が落ち着いてから書く。復元を尋ねている間は上書きしない
    if (draft) return;
    const write = () => {
      const d = draftInput.current;
      if (!d.pages.length) return;
      if (!autosaveOn) {
        autosave.current.status = "off";
        // ダウンロード版で、既定のまま自動保存が切れているとき：編集を始めたら一度だけ、そのことと入れ方を知らせる
        if (isLocalFile() && autosaveIsDefault() && leaveGuard.current.needed && autosave.current.told !== "off-local") {
          autosave.current.told = "off-local";
          setNotice(t("draft.offLocal"));
        }
        return;
      }
      const gen = docGen.current;
      const snapshot = stateRef.current;
      void saveDraft({ ...d, sources, images }).then((status) => {
        // 書いている間に別の文書へ切り替わっていたら、その結果は使わない
        if (gen !== docGen.current) return;
        autosave.current.status = status;
        if (status === "saved") draftedState.current = snapshot;
        // 自動保存されないときは、文書ごとに 1 回だけ、理由を添えて知らせる
        if (status !== "saved" && autosave.current.told !== status) {
          autosave.current.told = status;
          setNotice(t(status === "protected" ? "draft.offProtected" : status === "too-large" ? "draft.offLarge" : status === "other-tab" ? "draft.offOtherTab" : "draft.offUnavailable"));
        }
      });
    };
    const tm = setTimeout(write, 1500);
    const onHide = () => {
      if (document.visibilityState === "hidden") write();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      clearTimeout(tm);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [pages, settings, baseName, currentId, sources, images, draft, autosaveOn, t]);

  // すべてのページを消したら、残っている下書きも消す（開き直したときに、消した文書の復元を尋ねないように）。
  // 「元に戻す」でページが戻れば、また自動保存される
  const hadPages = useRef(false);
  useEffect(() => {
    if (pages.length) hadPages.current = true;
    else if (hadPages.current) {
      hadPages.current = false;
      void clearDraft();
    }
  }, [pages.length]);

  /** 自動保存の入り切り。切ったら、残っている下書きもすぐに消す */
  const changeAutosave = useCallback((on: boolean) => {
    setAutosaveEnabled(on);
    setAutosaveOn(on);
    autosave.current = { status: on ? null : "off", told: null };
    if (!on) void clearDraft();
  }, []);

  // 保存していない編集があり、下書きにも残っていないときは、閉じる・読み込み直す前にブラウザーに確かめさせる
  const leaveGuard = useRef({ needed: false, skip: false });
  leaveGuard.current.needed = pages.length > 0 && (hist.canUndo || restoredUnsaved.current) && hist.state !== savedState.current;
  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => {
      const g = leaveGuard.current;
      // 下書きに入っているのが、いまの文書そのものなら失うものは無い（直前の編集がまだ書かれていなければ確かめる）
      if (!g.needed || g.skip || (autosave.current.status === "saved" && draftedState.current === stateRef.current)) return;
      e.preventDefault();
      // 古いブラウザーは returnValue を見る
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, []);

  const restoreDraft = useCallback(async () => {
    draftAsking.current = false;
    setDraft(null);
    setPendingOpen(null);
    setBusy(t("draft.restoring"));
    loading.current++;
    try {
      // 念のため、開いているものがあれば手放してから復元する（下書きは残す）
      resetDocument(true);
      const d = await loadDraft();
      if (!d) throw new AppError(t("draft.missing"));
      for (const s of d.state.sources) {
        const bytes = d.sourceBytes.get(s.id)!;
        const { doc } = await loadPdfFile(new File([bytes as BlobPart], s.name, { type: "application/pdf" }));
        doc.id = s.id;
        sources.set(s.id, doc);
      }
      for (const im of d.state.images) {
        const bytes = d.imageBytes.get(im.id);
        if (!bytes) continue;
        images.set(im.id, { id: im.id, bytes, mime: im.mime, width: im.width, height: im.height, url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: im.mime })) });
      }
      const ids = new Set(sources.keys());
      const restored = d.state.pages.filter((p) => !p.srcId || ids.has(p.srcId));
      setBaseName(displayName(d.state.baseName));
      hist.update(() => ({ pages: restored, settings: { ...defaultSettings(), ...d.state.settings } }), false);
      restoredUnsaved.current = true;
      setCurrentId(d.state.currentId && restored.some((p) => p.id === d.state.currentId) ? d.state.currentId : (restored[0]?.id ?? null));
      // パスワードは下書きに残していない。保護を設定していた文書なら、設定し直すよう知らせる（黙って保護なしで保存されないように）
      if (d.state.hadProtection) setToast({ kind: "error", text: `${t("draft.restored", { n: restored.length })}\n${t("draft.protectionLost")}` });
      else info(t("draft.restored", { n: restored.length }));
    } catch (e) {
      showError(e);
      void clearDraft();
    } finally {
      loading.current--;
      setBusy(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources, images, hist, t, resetDocument]);

  /** 下書きを破棄する。尋ねている間に開かれたファイルがあれば、続けてそれを開く */
  const discardDraft = () => {
    draftAsking.current = false;
    setDraft(null);
    void clearDraft();
    const p = pendingOpen;
    setPendingOpen(null);
    if (p) addFilesRef.current(p.files, p.insertAt, p.handles);
  };

  /** ページ一覧だけを更新する（履歴に残す） */
  const updatePages = useCallback(
    (fn: (p: PageItem[]) => PageItem[], record: HistRecord = true) =>
      hist.update((d) => {
        const next = fn(d.pages);
        return next === d.pages ? d : { ...d, pages: next };
      }, record),
    [hist],
  );
  const updateDecor = (fn: (d: DocDecor) => DocDecor) => hist.update((d) => ({ ...d, settings: { ...d.settings, decor: fn(d.settings.decor) } }));
  const updateMeta = (m: DocMeta) => hist.update((d) => ({ ...d, settings: { ...d.settings, meta: m } }));

  useEffect(() => {
    if (!toast) return;
    // ms が 0 の知らせ（保存の結果の警告など、読んで対応が要るもの）は、閉じるまで出したままにする
    if (toast.ms === 0) return;
    const tm = setTimeout(() => setToast(null), toast.ms ?? (toast.kind === "error" ? 7000 : 3500));
    return () => clearTimeout(tm);
  }, [toast]);

  // 控えめな知らせ（自動保存されない理由など）は、ほかの知らせや処理が終わってから出す
  useEffect(() => {
    if (!notice || toast || busy) return;
    setToast({ kind: "info", text: notice, ms: 9000 });
    setNotice(null);
  }, [notice, toast, busy]);

  // 選択中ページ・編集中ページが消えたら整合させる
  useEffect(() => {
    const ids = new Set(pages.map((p) => p.id));
    setSelected((s) => {
      const n = new Set([...s].filter((id) => ids.has(id)));
      return n.size === s.size ? s : n;
    });
    if (currentId && !ids.has(currentId)) setCurrentId(pages[0]?.id ?? null);
    if (!pages.length && mode === "edit") setMode("pages");
  }, [pages, currentId, mode]);

  /* ---------- 読み込み ---------- */

  const addPdfs = useCallback(
    async (files: File[], insertAt?: number) => {
      setBusy(t("load.busy"));
      loading.current++;
      const added: PageItem[] = [];
      const unlocked: SourceDoc[] = [];
      const loadedDocs: SourceDoc[] = [];
      try {
        for (const f of files) {
          try {
            const { doc, pages: ps } = await loadPdfFile(f, askPassword, (m) => setToast({ kind: "error", text: m }));
            sources.set(doc.id, doc);
            added.push(...ps);
            if (doc.security) unlocked.push(doc);
            loadedDocs.push(doc);
          } catch (e) {
            showError(e);
          }
        }
        if (added.length) {
          if (sources.size === 1 || !pages.length) setBaseName(displayName(files[0].name).replace(/\.pdf$/i, ""));
          updatePages((prev) => {
            const at = insertAt == null ? prev.length : Math.max(0, Math.min(prev.length, insertAt));
            return [...prev.slice(0, at), ...added, ...prev.slice(at)];
          });
          setCurrentId((c) => c ?? added[0].id);
          // 最初の編集で固まらないよう、既定フォントと pdf-lib の読み込みを暇なときに済ませる
          warmFonts([defaultFont("sans"), defaultFont("serif")]);
          for (const doc of loadedDocs) setTimeout(() => void getLibDoc(doc).catch(() => undefined), 1200);
          if (pages.length) info(t("load.added", { n: added.length }));
          if (unlocked.length) info(t("load.unlocked", { name: unlocked[0].name, method: unlocked[0].security?.method ?? "" }));
          const signed = loadedDocs.find((d) => d.signed);
          if (signed) setToast({ kind: "error", text: t("load.signed", { name: signed.name }) });
          // しおりと添付ファイルを引き継ぐ（履歴には積まず、ページ追加と同じ 1 手にする）
          for (const doc of loadedDocs) {
            try {
              const lib = await getLibDoc(doc);
              const ids = added.filter((p) => p.srcId === doc.id).map((p) => p.id);
              const outline = readOutlines(lib, ids);
              const atts = readAttachments(lib).map((a) => ({ ...a, id: uid("att"), srcId: doc.id }));
              if (outline.length || atts.length) hist.update((d) => ({ ...d, settings: { ...d.settings, outline: [...d.settings.outline, ...outline], attachments: [...d.settings.attachments, ...atts] } }), false);
            } catch {
              /* 読めなくても本体の読み込みは成功している */
            }
          }
        }
      } finally {
        loading.current--;
        setBusy(null);
      }
    },
    [pages.length, sources, updatePages, t, askPassword, hist],
  );

  /** 画像をページとして追加する（用紙設定のダイアログを経由） */
  const addImagesAsPages = useCallback(
    async (files: File[], o: ImageToPdfOptions, insertAt?: number) => {
      // 何も無い画面から始めるとき：前の文書の設定・履歴・保存先を持ち越さない（PDF を読み込んでいる途中なら、そちらが済ませている）
      if (!stateRef.current.pages.length && !loading.current) resetDocument();
      setBusy(t("load.busy"));
      loading.current++;
      try {
        const paper = o.paper ? (PAPER_SIZES.find((p) => p.id === o.paper) ?? null) : null;
        const added: PageItem[] = [];
        for (const f of files) {
          try {
            const img = await loadImageFile(f);
            images.set(img.id, img);
            const fit = fitImageToPaper(img.width, img.height, paper, clamp(o.marginMm, 0, 50, 0) * (72 / 25.4));
            const page = blankPage(fit.w, fit.h);
            const obj: ImageObj = { id: uid(), type: "image", x: (fit.w - fit.imgW) / 2, y: (fit.h - fit.imgH) / 2, w: fit.imgW, h: fit.imgH, imageId: img.id, opacity: 1 };
            page.objects.push(obj);
            added.push(page);
          } catch (e) {
            showError(e);
          }
        }
        if (added.length) {
          if (!pages.length) setBaseName(displayName(files[0].name).replace(/\.[^.]+$/, ""));
          updatePages((prev) => {
            const at = insertAt == null ? prev.length : Math.max(0, Math.min(prev.length, insertAt));
            return [...prev.slice(0, at), ...added, ...prev.slice(at)];
          });
          setCurrentId((c) => c ?? added[0].id);
          info(t("load.added", { n: added.length }));
        }
      } finally {
        loading.current--;
        setBusy(null);
      }
    },
    [images, pages.length, updatePages, t, resetDocument],
  );

  const addFiles = useCallback(
    (files: File[], insertAt?: number, handles?: (FileHandle | null)[]) => {
      const pdfs = files.filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
      const imgs = files.filter((f) => f.type.startsWith("image/") || IMAGE_RE.test(f.name));
      if (!pdfs.length && !imgs.length) {
        if (files.length) showError(t("load.notPdf"));
        return;
      }
      // 起動時の下書きの確認がまだなら、済むまで待つ（確認の前に開くと、残っていた下書きを尋ねる前に消してしまう）
      if (!draftReady.current!.done) {
        void draftReady.current!.promise.then(() => addFilesRef.current(files, insertAt, handles));
        return;
      }
      // 復元を尋ねている間に開かれたファイルは、答えが出るまで待たせる（黙って下書きを捨てたり、復元で置き換えたりしない）
      if (draftAsking.current) {
        setPendingOpen({ files, insertAt, handles });
        return;
      }
      // 何も無い画面から始めるとき：前の文書の設定・履歴・保存先を持ち越さない（すべてのページを消したあとに開いた場合など）。
      // 画像だけのときは、用紙の設定で取りやめることがあるので、実際にページを足すとき（addImagesAsPages）に行う
      if (pdfs.length && !pages.length && !loading.current) resetDocument();
      // 上書き保存の対象：何も開いていない状態で PDF を 1 つだけ開いたときの、そのファイル。あとから別の PDF を足したら対象から外す
      if (pdfs.length) {
        const h = !pages.length && files.length === 1 ? (handles?.[0] ?? null) : null;
        if (h) fileStamps.current.set(h, { size: files[0].size, lastModified: files[0].lastModified });
        setSaveTarget((cur) => (h ? { handle: h, name: files[0].name, original: true } : cur?.original ? null : cur));
      }
      insertAtRef.current = insertAt;
      if (pdfs.length) void addPdfs(pdfs, insertAt);
      if (imgs.length) {
        setPendingImages(imgs);
        setDialog("fromImages");
      }
    },
    [addPdfs, t, pages.length, resetDocument],
  );
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;

  const openPicker = (insertAt?: number) => {
    insertAtRef.current = insertAt;
    // 対応ブラウザでは、あとで上書き保存できるようにファイルへの参照も受け取る
    if (canPickOpenFile()) {
      pickOpenFiles()
        .then((r) => r && addFiles(r.map((x) => x.file), insertAt, r.map((x) => x.handle)))
        .catch(() => fileInput.current?.click());
      return;
    }
    fileInput.current?.click();
  };

  /** 画像から PDF：画像だけを選んでもらう（文書を開いていなくても始められる） */
  const pickImages = () => {
    setPendingImages(null);
    insertAtRef.current = undefined;
    imageInput.current?.click();
  };

  /** 白紙 1 ページの文書から始める（A4 縦） */
  const startBlank = () => {
    if (!pages.length && !loading.current) resetDocument();
    const bp = blankPage();
    updatePages(() => [bp]);
    setCurrentId(bp.id);
  };

  /* ---------- 書き出し ---------- */

  const compressStats = useRef<CompressStats | null>(null);
  /** 墨消しを保存後に確かめた結果（直前の書き出しのもの） */
  const redactCheck = useRef<RedactCheck | null>(null);
  /** plain：パスワード保護を掛けずに組み立てる（このアプリの中でもう一度読み込む途中の PDF 用。暗号化したままでは読み直せない） */
  const build = useCallback(
    (subset: PageItem[], label: string, warnings?: string[], plain = false, leftovers?: string[]) => {
      compressStats.current = null;
      redactCheck.current = null;
      return buildPdf(subset, sources, images, {
        onRedactCheck: (r) => (redactCheck.current = r),
        embedFont,
        settings: plain ? { ...settings, security: { ...settings.security, enabled: false } } : settings,
        fileName: baseName,
        onProgress: (done, total) => setBusy(`${label} ${done}/${total}`),
        onWarning: (m) => warnings?.push(m),
        onLeftover: (m) => leftovers?.push(m),
        onCompressStats: (s) => (compressStats.current = s),
      });
    },
    [sources, images, embedFont, settings, baseName],
  );

  /**
   * 組み立てて、できた PDF を deliver に渡す（省略時はダウンロード）。deliver が文字列を返したら、それを完了の知らせとして出す
   * （{ problem } を返したら、警告として出す）。
   * verify：渡す前に、できた PDF を開き直せるか確かめる（保存のとき。壊れた出力で、前からあるファイルを置き換えないため）
   */
  const exportPages = useCallback(
    async (subset: PageItem[], filename: string, deliver?: (bytes: Uint8Array) => Promise<string | { problem: string } | void>, verify = !deliver): Promise<"done" | "check-failed" | "cancelled" | "error" | void> => {
      if (!subset.length) return;
      setBusy(t("export.busy"));
      // 書き出しを始めた時点の文書（文書全体を保存できたら、「ここまでは保存済み」として覚える）
      const snapshot = stateRef.current;
      try {
        const warnings: string[] = [];
        const leftovers: string[] = [];
        const bytes = await build(subset, t("export.busy"), warnings, false, leftovers);
        // 墨消しした語がほかの所（文書情報・しおり・ほかのページなど）に残っている：書き込む前に確かめる
        if (leftovers.length) {
          setBusy(null);
          const go = await askConfirm(`${leftovers.slice(0, 3).join("\n")}${leftovers.length > 3 ? `\n${t("export.more", { n: leftovers.length - 3 })}` : ""}\n\n${t("redact.leftoverConfirm")}`, t("redact.saveAnyway"));
          if (!go) return "cancelled";
          setBusy(t("export.busy"));
        }
        if (verify) {
          setBusy(t("export.checking"));
          const check = await checkOutput(bytes, subset.length, settings.security);
          if (!check.ok) {
            // 開き直せない出力は、選んだファイルへは書き込まない。それでも受け取りたい人には、ダウンロードとして渡す
            setBusy(null);
            if (await askConfirm(t("export.checkFailed", { reason: check.reason }), t("export.checkDownload"))) downloadBlob(new Blob([bytes as BlobPart], { type: "application/pdf" }), filename);
            return "check-failed";
          }
        }
        let done: string | void = undefined;
        const problems: string[] = [];
        if (deliver) {
          const r = await deliver(bytes);
          if (r && typeof r === "object") problems.push(r.problem);
          else done = r;
        } else downloadBlob(new Blob([bytes as BlobPart], { type: "application/pdf" }), filename);
        // 保存（ダウンロード・ファイルへの書き込み）として文書全体を渡せた。共有・印刷・一部のページの取り出しは数えない
        if (verify && subset === snapshot.pages) savedState.current = snapshot;
        const cs = compressStats.current;
        const rc = redactCheck.current;
        // 知らせ：圧縮の結果・保存先・墨消しの確認結果。警告や未確認があれば、そちらを優先して出す
        const notes = [cs ? t("compress.result", { n: cs.recompressed, total: cs.images, before: formatBytes(sourceSize), after: formatBytes(bytes.length) }) + (cs.merged || cs.repacked ? ` ${t("compress.resultMore", { merged: cs.merged ?? 0, repacked: cs.repacked ?? 0 })}` : "") + (cs.fonts ? ` ${t("compress.resultFonts", { fonts: cs.fonts, size: formatBytes(cs.fontSaved ?? 0) })}` : "") : done, rc && rc.pages > 0 && !rc.unverified.length ? t("redact.verified", { n: rc.verified }) : null].filter((x): x is string => !!x);
        if (warnings.length) problems.push(`${t("export.overflowWarning")}\n${warnings.slice(0, 3).join("\n")}${warnings.length > 3 ? `\n${t("export.more", { n: warnings.length - 3 })}` : ""}`);
        if (rc?.unverified.length) problems.push(t("redact.unverified", { pages: rc.unverified.slice(0, 8).join(", ") + (rc.unverified.length > 8 ? "…" : "") }));
        // 元の文書に付いていた保護（パスワード・印刷やコピーの制限）は、保存した PDF には付いていない。付け直していなければ知らせる
        const protectedSrc = [...new Set(subset.map((pg) => pg.srcId))].map((id) => (id ? sources.get(id) : undefined)).find((d) => d?.security);
        if (protectedSrc && !settings.security?.enabled) notes.push(t("export.protectionRemoved", { name: protectedSrc.name }));
        if (problems.length) setToast({ kind: "error", text: problems.join("\n"), ms: 0 });
        else if (notes.length) info(notes.join("\n"));
        return "done";
      } catch (e) {
        // 訳した知らせはそのまま、内部の（英語の）例外は「保存できませんでした」で包んで知らせる
        showError(e instanceof AppError ? e : t("export.failed", { detail: e instanceof Error ? e.message : String(e) }));
        return "error";
      } finally {
        setBusy(null);
      }
    },
    [build, t, sources, settings.security],
  );

  const exportGroups = useCallback(
    async (groups: { name: string; pages: PageItem[] }[]) => {
      setBusy(t("export.splitting"));
      try {
        const files: { name: string; data: Uint8Array }[] = [];
        for (let i = 0; i < groups.length; i++) {
          setBusy(t("export.splittingProgress", { done: i + 1, total: groups.length }));
          files.push({ name: groups[i].name, data: await build(groups[i].pages, t("export.splitting")) });
        }
        if (files.length === 1) downloadBlob(new Blob([files[0].data as BlobPart], { type: "application/pdf" }), files[0].name);
        else downloadBlob(createZip(files), `${baseName}_split.zip`);
        setDialog(null);
      } catch (e) {
        showError(e);
      } finally {
        setBusy(null);
      }
    },
    [baseName, build, t],
  );

  /** サイズで分割：実際に組み立ててサイズを測りながら、上限に収まるページ数ずつに分ける */
  const exportBySize = useCallback(
    async (limit: number) => {
      // 上限は 100 KB 〜 4 GB に収める（極端に小さい値だと、ページごとに何度も組み立て直して終わらなくなる）
      const limitBytes = clamp(limit, 100 * 1024, 0xffffffff, 10 * 1024 * 1024);
      setBusy(t("export.splitting"));
      try {
        const N = pages.length;
        const files: { name: string; data: Uint8Array }[] = [];
        let over = 0;
        const whole = await build(pages, t("export.splitting"));
        if (whole.length <= limitBytes) files.push({ name: `${baseName}.pdf`, data: whole });
        else {
          const per = whole.length / N;
          let i = 0;
          while (i < N) {
            // 収まると分かった最大のページ数（lo）と、超えると分かった最小のページ数（hi）の間を詰めていく
            const rest = N - i;
            let lo = 0;
            let hi = rest + 1;
            let best: { n: number; bytes: Uint8Array } | null = null;
            let n = Math.max(1, Math.min(rest, Math.floor((limitBytes / per) * 0.9)));
            for (let tries = 0; tries < 10; tries++) {
              const label = `${t("export.splitting")} ${i + 1}-${i + n} / ${N}`;
              setBusy(label);
              const bytes = await build(pages.slice(i, i + n), label);
              if (bytes.length <= limitBytes) {
                lo = n;
                best = { n, bytes };
                // 残りを全部入れた・これ以上増やせない・上限に十分近い、のどれかなら決める
                if (lo === rest || hi - lo <= 1 || bytes.length >= limitBytes * 0.85) break;
                n = hi <= rest ? Math.floor((lo + hi) / 2) : Math.min(rest, Math.max(lo + 1, Math.floor(lo * (limitBytes / bytes.length) * 0.95)));
              } else {
                hi = n;
                if (n === 1) {
                  // 1 ページで上限を超える：そのページだけのファイルにする
                  best = { n: 1, bytes };
                  over++;
                  break;
                }
                if (lo > 0 && hi - lo <= 1) break;
                n = lo > 0 ? Math.floor((lo + hi) / 2) : Math.max(1, Math.min(n - 1, Math.floor(n * (limitBytes / bytes.length) * 0.9)));
              }
            }
            if (!best) {
              const bytes = await build(pages.slice(i, i + 1), t("export.splitting"));
              if (bytes.length > limitBytes) over++;
              best = { n: 1, bytes };
            }
            files.push({ name: `${baseName}_p${i + 1}${best.n > 1 ? `-${i + best.n}` : ""}.pdf`, data: best.bytes });
            i += best.n;
          }
        }
        if (files.length === 1) downloadBlob(new Blob([files[0].data as BlobPart], { type: "application/pdf" }), files[0].name);
        else downloadBlob(createZip(files), `${baseName}_split.zip`);
        setDialog(null);
        if (over) setToast({ kind: "error", text: `${t("split.sizeDone", { n: files.length })}\n${t("split.sizeOver", { n: over })}` });
        else info(t("split.sizeDone", { n: files.length }));
      } catch (e) {
        showError(e);
      } finally {
        setBusy(null);
      }
    },
    [pages, build, baseName, t],
  );

  /* ---------- 保存・共有・印刷 ---------- */

  /**
   * 書き出すページの元になった PDF の名前。どのページも同じ 1 つの PDF から来ていればその名前、混ざっていれば最初に開いた PDF の名前
   * （あとから足した PDF のページだけを抜き出したのに、最初の PDF の名前で保存されるのを防ぐ）
   */
  const nameOf = (list: PageItem[]): string => {
    const ids = new Set(list.map((p) => p.srcId).filter(Boolean));
    const only = ids.size === 1 && list.every((p) => p.srcId) ? sources.get([...ids][0] as string) : undefined;
    return only?.name ? only.name.replace(/\.pdf$/i, "") : baseName;
  };
  const defaultName = pdfFileName(`${nameOf(pages)}_edited`, "document_edited");
  /** そのまま印刷できない端末で、共有（OS の共有シート）を使えるか */
  const printViaShare = useMemo(() => !canPrintInline() && canShareFiles(), []);

  /** 保存先のファイルの、開いた（書いた）時点の大きさと更新時刻 */
  const fileStamps = useRef(new WeakMap<FileHandle, { size: number; lastModified: number }>());
  const stampOf = async (handle: FileHandle) => {
    try {
      const f = await handle.getFile();
      return { size: f.size, lastModified: f.lastModified };
    } catch {
      return null;
    }
  };

  /** 選んだファイルへ書き込む（許可の確認はユーザー操作の直後に行う必要があるので、組み立てより先に求める） */
  const saveToHandle = async (handle: FileHandle, name: string, o: { confirmText?: string; fresh?: boolean } = {}) => {
    if (!(await allowWrite(handle))) {
      showError(t("save.denied"));
      return;
    }
    // 開いた（前に書いた）あとで、ほかのアプリがこのファイルを書き換えていたら、黙って上書きしない
    const known = fileStamps.current.get(handle);
    const now = !o.fresh && known ? await stampOf(handle) : null;
    if (known && now && (now.size !== known.size || now.lastModified !== known.lastModified)) {
      if (!(await askConfirm(t("save.changedOutside", { name }), t("save.overwriteAnyway")))) return;
    } else if (o.confirmText && !(await askConfirm(o.confirmText, t("save.overwrite")))) return;
    const result = await exportPages(
      pages,
      name,
      async (bytes) => {
        try {
          await writeToHandle(handle, bytes, { fresh: o.fresh });
          // 書いた時点の姿を覚える（次の保存の前に、ほかで変えられていないかを比べる）
          const st = await stampOf(handle);
          if (st) fileStamps.current.set(handle, st);
        } catch (e) {
          if (!(e instanceof WriteFailed)) throw e;
          // 選んだ場所に書けなかった：編集後の PDF はダウンロードとして渡し、保存先のファイルがどうなったかを正しく伝える
          downloadBlob(new Blob([bytes as BlobPart], { type: "application/pdf" }), name);
          // 前のままのファイルは、次の保存でもう一度試せるように保存先として残す。それ以外（片付けた・壊れた）は保存先の指定をやめる
          if (e.fileState !== "intact") setSaveTarget(null);
          return { problem: t(e.fileState === "intact" ? "save.failedIntact" : e.fileState === "damaged" ? "save.failedDamaged" : "save.fallbackDownload", { name }) };
        }
        return t("save.saved", { name });
      },
      true,
    );
    // いま選んだ保存先に何も書かずに終わった（点検に通らなかった・組み立てに失敗した）：
    // 保存先を選んだときにできた空のファイルを残さず、保存先の指定もやめる
    if (o.fresh && result !== "done") {
      await removeIfEmpty(handle);
      setSaveTarget(null);
    }
  };

  /** 保存ボタン・Ctrl+S：「名前を付けて保存」で選んだファイルがあればそこへ、無ければダウンロード */
  const save = () => {
    if (!pages.length) return;
    if (saveTarget && !saveTarget.original) void saveToHandle(saveTarget.handle, saveTarget.name).catch(showError);
    else void exportPages(pages, defaultName);
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  // キー操作から呼ぶもの（最新の状態で動くよう、描くたびに入れ替える）
  const keyActions = useRef({ find: () => {}, print: () => {} });

  const saveAs = async () => {
    if (!canPickSaveFile()) {
      setDialog("saveName");
      return;
    }
    let handle: FileHandle | null = null;
    const started = performance.now();
    try {
      handle = await pickSaveFile(saveTarget && !saveTarget.original ? saveTarget.name : defaultName);
    } catch {
      // 保存先を選ぶ画面を出せない環境（権限や埋め込みの制限など）：名前を入力してダウンロードする方法に切り替える
      setDialog("saveName");
      return;
    }
    if (!handle) {
      // 取り消し。ただし、画面が出る間もなく「取り消し」が返る環境がある（保存先を選ぶ画面を出せないブラウザや、アプリ内ブラウザ）。
      // 人が取り消せる速さではないので、名前を入力してダウンロードする方法に切り替える（何も起きないまま終わらせない）
      if (performance.now() - started < 350) setDialog("saveName");
      return;
    }
    try {
      setSaveTarget({ handle, name: handle.name, original: false });
      // fresh：いま選んだ保存先。書けずに空のファイルだけが残ったら、それは片付けてよい
      await saveToHandle(handle, handle.name, { fresh: true });
    } catch (e) {
      showError(e);
    }
  };

  const overwriteOriginal = () => {
    if (!saveTarget?.original) return;
    void saveToHandle(saveTarget.handle, saveTarget.name, { confirmText: t("save.overwriteConfirm", { name: saveTarget.name }) }).catch(showError);
  };

  const shareFile = () =>
    exportPages(pages, defaultName, async (bytes) => {
      if ((await sharePdf(bytes, defaultName)) === "needs-tap") setReady({ kind: "share", bytes, name: defaultName });
    });

  const printFile = () =>
    exportPages(pages, defaultName, async (bytes) => {
      if (canPrintInline()) {
        try {
          await printPdf(bytes);
          return;
        } catch {
          /* 下の「別のタブで開く」へ */
        }
      }
      setReady({ kind: "print", bytes, name: defaultName });
    });

  keyActions.current = {
    find: () => {
      if (pages.length) setDialog("find");
    },
    print: () => {
      if (pages.length) void printFile();
    },
  };
  /** PDF → 画像：編集を含めるため、いったん PDF を組み立ててから pdf.js で描画する */
  const exportImages = useCallback(
    async (o: ImageExportOptions) => {
      const subset = pages.filter((p) => o.pageIds.has(p.id));
      if (!subset.length) return;
      setDialog(null);
      setBusy(t("images.rendering"));
      try {
        // 画像にするための途中の PDF なので、保護は掛けない（掛けると、ここで開き直せない）
        const bytes = await build(subset, t("export.busy"), undefined, true);
        const pdfjs = await getPdfJs();
        const pdf = await pdfjs.getDocument({ ...documentOptions(), data: bytes.slice() }).promise;
        const tmp: SourceDoc = { id: "export", name: baseName, bytes, pdf, pageCount: pdf.numPages };
        const files: { name: string; data: Uint8Array }[] = [];
        try {
        const ext = o.format === "png" ? "png" : "jpg";
        for (let i = 0; i < pdf.numPages; i++) {
          setBusy(`${t("images.rendering")} ${i + 1}/${pdf.numPages}`);
          const canvas = document.createElement("canvas");
          const page = await pdf.getPage(i + 1);
          await renderToCanvas(canvas, tmp, i, clamp(o.dpi, LIMITS.dpi.min, LIMITS.dpi.max, 150) / 72, page.rotate);
          const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new AppError(t("images.failed", { n: i + 1 })))), o.format === "png" ? "image/png" : "image/jpeg", o.quality));
          canvas.width = 0;
          canvas.height = 0;
          // ファイル名の番号は、文書の中でのページ番号（一部のページだけ書き出しても、どのページか分かるように）
          const pageNo = pages.indexOf(subset[i]) + 1 || i + 1;
          files.push({ name: `${baseName}_p${String(pageNo).padStart(3, "0")}.${ext}`, data: new Uint8Array(await blob.arrayBuffer()) });
        }
        } finally {
          await closePdf(pdf).catch(() => undefined);
        }
        if (files.length === 1) downloadBlob(new Blob([files[0].data as BlobPart], { type: o.format === "png" ? "image/png" : "image/jpeg" }), files[0].name);
        else downloadBlob(createZip(files), `${baseName}_images.zip`);
      } catch (e) {
        showError(e);
      } finally {
        setBusy(null);
      }
    },
    [pages, build, baseName, t],
  );

  const exportTextFile = useCallback(
    async (format: "txt" | "md", pageIds: Set<string>) => {
      setDialog(null);
      setBusy(t("text.extracting"));
      try {
        const subset = pages.filter((p) => pageIds.has(p.id));
        const text = await exportText(subset, sources, format, (d, n) => setBusy(`${t("text.extracting")} ${d}/${n}`));
        downloadBlob(new Blob([text], { type: format === "md" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8" }), `${baseName}.${format}`);
      } catch (e) {
        showError(e);
      } finally {
        setBusy(null);
      }
    },
    [pages, sources, baseName, t],
  );

  const removeBlankPages = useCallback(async () => {
    setBusy(t("blank.scanning"));
    try {
      const blank = await findBlankPages(pages, sources);
      if (!blank.size) {
        info(t("blank.none"));
        return;
      }
      if (blank.size >= pages.length) {
        info(t("blank.all"));
        return;
      }
      if (!(await askConfirm(t("blank.confirm", { n: blank.size }), t("common.delete")))) return;
      updatePages((prev) => prev.filter((p) => !blank.has(p.id)));
      info(t("blank.removed", { n: blank.size }));
    } catch (e) {
      showError(e);
    } finally {
      setBusy(null);
    }
  }, [pages, sources, updatePages, t]);

  /** 面付け（N-up・小冊子）：組み立ててから面付けし、別名で保存 */
  const runImpose = useCallback(
    async (o: ImposeOptions) => {
      setBusy(t("nup.busy"));
      try {
        // 面付けは、組み立てた PDF をもう一度読み込んで行う。途中の PDF には保護を掛けず、できあがった PDF に掛ける
        const bytes = await build(pages, t("export.busy"), undefined, true);
        const out = await imposePdf(bytes, o, settings.security.enabled ? settings.security : undefined);
        downloadBlob(new Blob([out as BlobPart], { type: "application/pdf" }), `${baseName}_${o.booklet ? "booklet" : `${o.perSheet}up`}.pdf`);
      } catch (e) {
        showError(e);
      } finally {
        setBusy(null);
      }
    },
    [build, pages, baseName, t, settings.security],
  );

  /** 文書比較用：いまの文書を組み立てる（比べるために読み直すので、保護は掛けない） */
  const buildCurrent = useCallback(async () => {
    try {
      return await build(pages, t("export.busy"), undefined, true);
    } finally {
      setBusy(null);
    }
  }, [build, pages, t]);

  /**
   * 元 PDF のバイト列を書き換えて読み込み直す（フォーム入力・文字認識など）。ページの並びと編集はそのまま。
   * 書き換える前の PDF は、ここでは手放さない：元に戻したとき（Ctrl+Z）に、前の状態のページを表示・保存できる必要がある。
   * 履歴のどこからも使われなくなった時点で、下の片付けが手放す
   */
  const rewriteSource = useCallback(
    async (src: SourceDoc, transform: (bytes: Uint8Array) => Promise<Uint8Array>) => {
      const bytes = await transform(src.bytes);
      const file = new File([bytes as BlobPart], src.name, { type: "application/pdf" });
      const { doc, pages: fresh } = await loadPdfFile(file);
      doc.security = src.security;
      sources.set(doc.id, doc);
      clearPageTextCache();
      updatePages((prev) =>
        prev.map((p) => {
          if (p.srcId !== src.id) return p;
          const np = fresh[p.srcIndex];
          return np ? { ...p, srcId: doc.id, viewTransform: np.viewTransform, width: np.width, height: np.height, baseRotation: np.baseRotation } : p;
        }),
      );
    },
    [sources, updatePages],
  );

  /** これまでに文書（履歴を含む）から使われたことのある元 PDF の id */
  const everUsed = useRef(new Set<string>());
  // 元 PDF の片付け：いまの文書からも、「元に戻す」「やり直す」で行ける先からも使われなくなった元 PDF を手放す
  // （書き換えのたびに前の PDF を残すので、放っておくと増え続ける）。操作が落ち着いてから、読み込みの途中でないときに行う
  useEffect(() => {
    if (sources.size < 2) return;
    const tm = setTimeout(() => {
      if (loading.current) return;
      const used = new Set<string>();
      const known = everUsed.current;
      const seen = new Set<PageItem[]>();
      for (const d of [...hist.past, hist.state, ...hist.future]) {
        if (seen.has(d.pages)) continue;
        seen.add(d.pages);
        for (const pg of d.pages) if (pg.srcId) used.add(pg.srcId);
      }
      for (const id of used) known.add(id);
      for (const [id, src] of sources) {
        // 一度も使われたことのないものは、読み込んだ直後でまだ画面に反映されていないだけかもしれないので残す
        if (used.has(id) || !known.has(id)) continue;
        sources.delete(id);
        known.delete(id);
        void closePdf(src.pdf).catch(() => undefined);
      }
    }, 3000);
    return () => clearTimeout(tm);
  }, [hist.past, hist.state, hist.future, sources]);

  /** 文字認識の結果を、見えない文字の層として元 PDF に足す（ページの並びと編集はそのまま） */
  const applyOcr = useCallback(
    async (r: OcrOutcome) => {
      setDialog(null);
      setBusy(t("ocr.applying"));
      try {
        for (const [id, results] of r.bySource) {
          const src = sources.get(id);
          if (src) await rewriteSource(src, (b) => addOcrLayer(b, results));
        }
        info(t("ocr.done", { pages: r.pages, words: r.words }) + (r.edited ? ` ${t("ocr.editedSkipped", { n: r.edited })}` : ""));
      } catch (e) {
        showError(e);
      } finally {
        setBusy(null);
      }
    },
    [rewriteSource, sources, t],
  );

  const applyForm = useCallback(
    async (src: SourceDoc, values: Record<string, string | boolean>, flatten: boolean) => {
      setDialog(null);
      setBusy(t("form.writing"));
      try {
        await rewriteSource(src, (b) => fillForm(b, values, flatten));
        info(t("form.done", { n: Object.keys(values).length }));
      } catch (e) {
        showError(e);
      } finally {
        setBusy(null);
      }
    },
    [rewriteSource, t],
  );

  /* ---------- ツールの実行 ---------- */

  const runTool = (id: ToolId) => {
    switch (id) {
      case "reverse":
        updatePages(reversePages);
        info(t("tool.reverse.done"));
        return;
      case "removeBlank":
        void removeBlankPages();
        return;
      case "extract":
        void exportPages(
          pages.filter((p) => selected.has(p.id)),
          `${nameOf(pages.filter((p) => selected.has(p.id)))}_extract.pdf`,
        );
        return;
      case "stripAnnots":
        hist.update((d) => ({ ...d, settings: { ...d.settings, stripAnnotations: !d.settings.stripAnnotations } }));
        return;
      case "grayscale":
        hist.update((d) => ({ ...d, settings: { ...d.settings, grayscale: !d.settings.grayscale } }));
        info(t(settings.grayscale ? "grayscale.off" : "grayscale.on"));
        return;
      case "fromImages":
        pickImages();
        return;
      default:
        setDialog(id);
    }
  };

  const modalOpen = dialog !== null || !!draft || !!pwPrompt || !!ready;

  // グローバルショートカット
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      const mod = e.ctrlKey || e.metaKey;
      // ダイアログを開いている間・処理中は、後ろの文書を動かさない
      // （確認のダイアログも含む：askConfirm の確認は、この画面の状態には現れないので、表示そのものを見る）
      if (modalOpen || busy || document.querySelector(".modal-back")) {
        if (mod && e.key.toLowerCase() === "s") e.preventDefault();
        return;
      }
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) hist.redo();
        else hist.undo();
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        hist.redo();
      } else if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveRef.current();
      } else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
        // ブラウザのページ内検索ではなく、文書の中を探す
        e.preventDefault();
        keyActions.current.find();
      } else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "p") {
        // ブラウザでこの画面を印刷するのではなく、文書を印刷する
        e.preventDefault();
        keyActions.current.print();
      } else if (!mod && !e.altKey && e.key === "?") {
        e.preventDefault();
        setDialog("shortcuts");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hist, modalOpen, busy]);

  // ページ外へのドロップでブラウザがPDFを開いてしまうのを防ぐ
  useEffect(() => {
    const prevent = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      if (!(e.target as HTMLElement)?.closest?.("[data-dropzone]")) {
        const files = [...e.dataTransfer.files];
        const hs = handlesFromDrop(e.dataTransfer);
        void Promise.all(hs).then((h) => addFiles(files, undefined, h.length === files.length ? h : undefined));
      }
    };
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", onDrop);
    };
  }, [addFiles]);

  // PWA としてインストールしたとき、OS から PDF を「Washi PDF で開く」と渡されるファイルを受け取る（File Handling API）。
  // 受け取りの登録は 1 回だけにし、最新の addFiles を ref 経由で呼ぶ。
  useEffect(() => {
    const lq = (window as unknown as { launchQueue?: LaunchQueue }).launchQueue;
    if (!lq) return;
    lq.setConsumer(async (params) => {
      if (!params.files?.length) return;
      const files = await Promise.all(params.files.map((h) => h.getFile()));
      addFilesRef.current(files, undefined, params.files as FileHandle[]);
    });
  }, []);

  /** いまの文書が使っている元 PDF（「元に戻す」のために残してある、書き換える前の PDF は含めない） */
  const usedSources = useMemo(() => [...new Set(pages.map((p) => p.srcId))].map((id) => (id ? sources.get(id) : undefined)).filter((s): s is SourceDoc => !!s), [pages, sources]);
  const sourceSize = useMemo(() => [...new Set(pages.map((p) => p.srcId))].reduce((n, id) => n + (id ? (sources.get(id)?.bytes.length ?? 0) : 0), 0), [pages, sources]);
  const editedCount = useMemo(() => pages.filter((p) => p.objects.length || p.crop || p.scaleTo).length, [pages]);
  const activeFlags = {
    numbering: settings.decor.numbering.enabled,
    headerFooter: settings.decor.header.enabled || settings.decor.footer.enabled,
    watermark: settings.decor.watermark.enabled,
    metadata: settings.meta.sanitize || !!(settings.meta.title || settings.meta.author || settings.meta.subject || settings.meta.keywords),
    crop: pages.some((p) => p.crop),
    resize: pages.some((p) => p.scaleTo),
    stripAnnots: settings.stripAnnotations,
    protect: settings.security.enabled,
    compress: settings.compress.enabled,
    grayscale: settings.grayscale,
    outline: settings.outline.length > 0,
    attachments: settings.attachments.length > 0,
  };
  const updateOutline = (items: OutlineItem[]) => hist.update((d) => ({ ...d, settings: { ...d.settings, outline: items } }));
  const updateAttachments = (items: AttachmentItem[]) => hist.update((d) => ({ ...d, settings: { ...d.settings, attachments: items } }));
  const updateCompress = (c: CompressSettings) => hist.update((d) => ({ ...d, settings: { ...d.settings, compress: c } }));
  const updateSecurity = (sec: SecuritySettings) => hist.update((d) => ({ ...d, settings: { ...d.settings, security: sec } }));

  /** 圧縮の試算：いまの設定でいったん組み立て、結果のサイズと再圧縮枚数を返す */
  const estimateCompress = useCallback(
    async (c: CompressSettings) => {
      let stats: CompressStats = { images: 0, recompressed: 0, skipped: 0, before: 0, after: 0, errors: [] };
      const bytes = await buildPdf(pages, sources, images, {
        embedFont,
        settings: { ...settings, compress: { ...c, enabled: true }, security: { ...settings.security, enabled: false } },
        fileName: baseName,
        onCompressStats: (sd) => (stats = sd),
      });
      return { after: bytes.length, stats };
    },
    [pages, sources, images, embedFont, settings, baseName],
  );

  /** 圧縮のプレビュー：設定 c で 1 ページだけ組み立てる */
  const previewCompress = useCallback(
    (c: CompressSettings, pageIndex: number) =>
      buildPdf([pages[pageIndex]], sources, images, { embedFont, settings: { ...defaultSettings(), meta: settings.meta, compress: { ...c, enabled: true } }, fileName: baseName }),
    [pages, sources, images, embedFont, settings.meta, baseName],
  );

  /** プレビュー用：1 ページ（トリミング適用済みなど）だけ組み立てる */
  const previewOnePage = useCallback(
    (page: PageItem) => buildPdf([page], sources, images, { embedFont, settings: { ...defaultSettings(), meta: settings.meta }, fileName: baseName }),
    [sources, images, embedFont, settings.meta, baseName],
  );

  /** プレビュー用：文書の装飾 decor で 1 ページだけ組み立てる（保護・圧縮などは掛けない） */
  const previewDecor = useCallback(
    (decor: DocDecor, pageIndex: number) => {
      const page = pages[pageIndex];
      return buildPdf([page], sources, images, {
        embedFont,
        settings: { ...settings, decor, security: { ...settings.security, enabled: false }, compress: { ...settings.compress, enabled: false }, grayscale: false, outline: [], attachments: [] },
        fileName: baseName,
        decorPages: pages,
      });
    },
    [pages, sources, images, embedFont, settings, baseName],
  );

  /** 和暦変換：検出した日付を実編集として各ページに追加する */
  const applyWareki = (edits: { pageId: string; obj: TextEditObj }[]) => {
    if (!edits.length) return;
    const byPage = new Map<string, TextEditObj[]>();
    for (const e of edits) byPage.set(e.pageId, [...(byPage.get(e.pageId) ?? []), e.obj]);
    updatePages((prev) => prev.map((p) => (byPage.has(p.id) ? { ...p, objects: [...p.objects, ...byPage.get(p.id)!] } : p)));
    info(t("wareki.done", { n: edits.length }));
  };

  /** 検索と置換・墨消し：選んだ一致を、実編集・墨消し・追加済みの文字の書き換えとして 1 手で適用する */
  const applyFind = (r: FindResult) => {
    if (!r.count) return;
    const add = new Map<string, EditObj[]>();
    for (const a of r.add) add.set(a.pageId, [...(add.get(a.pageId) ?? []), a.obj]);
    const patch = new Map(r.patch.map((x) => [`${x.pageId}:${x.objId}`, x.text]));
    updatePages((prev) =>
      prev.map((p) => {
        const touched = add.has(p.id) || r.patch.some((x) => x.pageId === p.id);
        if (!touched) return p;
        const objects = p.objects.map((o) => {
          const text = patch.get(`${p.id}:${o.id}`);
          return text !== undefined && (o.type === "text" || o.type === "textedit") ? { ...o, text } : o;
        });
        return { ...p, objects: [...objects, ...(add.get(p.id) ?? [])] };
      }),
    );
    info(t(r.mode === "redact" ? "find.doneRedact" : "find.doneReplace", { n: r.count }));
  };

  /** 編集画面を開く。ページ整理で選んでいるページがあれば、その最後のページを開く */
  const openEditor = (id?: string) => {
    if (!pages.length) return;
    const lastSel = [...pages].reverse().find((p) => selected.has(p.id))?.id;
    setCurrentId(id ?? lastSel ?? currentId ?? pages[0].id);
    setMode("edit");
  };

  /** 文書を閉じて最初の画面に戻る（保存した PDF には影響しない） */
  const closeDocument = async () => {
    if (pages.length && !(await askConfirm(t("close.confirm"), t("common.close")))) return;
    resetDocument();
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand" title={t("app.name")}>
          <Logo size={32} className="brand-mark" />
          <Wordmark className="brand-name" />
        </div>
        {pages.length > 0 && (
          <div className="doc-title" title={baseName}>
            {baseName}
            <span className="muted"> · {t("common.pages", { n: pages.length })}</span>
          </div>
        )}
        <div className="spacer" />
        {pages.length > 0 && (
          <div className="actions">
            <button className="icon-btn" title={hist.canUndo && hist.prev ? t("top.undoWhat", { what: describeStep(hist.prev, hist.state, t) }) : t("top.undo")} disabled={!hist.canUndo} onClick={hist.undo}>
              <Icon name="undo" />
            </button>
            <button className="icon-btn" title={hist.canRedo && hist.next ? t("top.redoWhat", { what: describeStep(hist.state, hist.next, t) }) : t("top.redo")} disabled={!hist.canRedo} onClick={hist.redo}>
              <Icon name="redo" />
            </button>
            <span className="divider" />
            <button className="btn" onClick={() => openPicker()} title={t("top.addPdf")}>
              <Icon name="plus" /> <span className="label">{t("top.addPdf")}</span>
            </button>
            <div className="split-btn">
              <button className="btn primary" onClick={save} title={saveTarget && !saveTarget.original ? `${t("top.save")} — ${saveTarget.name}` : t("top.save")}>
                <Icon name="download" /> <span className="label">{t("top.save")}</span>
              </button>
              <SaveMenu
                label={t("top.saveMenu")}
                items={[
                  { id: "as", icon: "file-plus", label: t("save.as"), onClick: () => void saveAs() },
                  ...(saveTarget?.original ? [{ id: "overwrite", icon: "download", label: t("save.overwrite"), onClick: overwriteOriginal }] : []),
                  ...(canShareFiles() ? [{ id: "share", icon: "share", label: t("save.share"), onClick: () => void shareFile() }] : []),
                  { id: "print", icon: "printer", label: t("save.print"), onClick: () => void printFile() },
                ]}
              />
            </div>
            <button className="icon-btn" title={t("change.title")} aria-label={t("change.title")} onClick={() => setDialog("changes")}>
              <Icon name="list-check" />
            </button>
            <button className="icon-btn" data-action="close" title={t("top.close")} aria-label={t("top.close")} onClick={closeDocument}>
              <Icon name="x" />
            </button>
          </div>
        )}
        <ThemeSwitch />
        <LangSwitch />
        <button className="icon-btn" title={t("top.about")} aria-label={t("top.about")} onClick={() => setDialog("about")}>
          <Icon name="info" />
        </button>
      </header>

      <input
        ref={fileInput}
        type="file"
        accept="application/pdf,.pdf,image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          addFiles(files, insertAtRef.current);
        }}
      />

      <input
        ref={imageInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          addFiles(files, insertAtRef.current);
        }}
      />

      <div className="body">
        <Rail mode={mode} onChange={(m) => (m === "edit" ? openEditor() : setMode(m))} disabled={!pages.length} />
        <main className="main">
          {/* 画面の描画で思わぬ例外が出ても、文書と編集の履歴（この外側で持っている）は失わない。案内を出し、ページ整理の画面から続けられるようにする */}
          <ErrorBoundary
            fallback={(error, reset) => (
              <CrashNotice error={error}>
                <button
                  className="btn primary"
                  onClick={() => {
                    setMode("pages");
                    setDialog(null);
                    reset();
                  }}
                >
                  {t("crash.retry")}
                </button>
              </CrashNotice>
            )}
          >
          {pages.length === 0 ? (
            <EmptyState onPick={() => openPicker()} onDrop={(f, h) => addFiles(f, undefined, h)} onImages={pickImages} onBlank={startBlank} />
          ) : mode === "pages" ? (
            <OrganizeView
              pages={pages}
              sources={sources}
              selected={selected}
              setSelected={setSelected}
              update={updatePages}
              onAddFiles={addFiles}
              onPickFiles={openPicker}
              onAddBlank={(at) => {
                const ref = pages[Math.max(0, at - 1)];
                const bp = ref ? blankPage(ref.width, ref.height) : blankPage();
                updatePages((prev) => [...prev.slice(0, at), bp, ...prev.slice(at)]);
              }}
              onOpenEditor={openEditor}
              currentId={currentId}
              onExtract={(subset) => exportPages(subset, `${nameOf(subset)}_extract.pdf`)}
              onSplit={() => setDialog("split")}
              editedCount={editedCount}
            />
          ) : mode === "edit" ? (
            <EditorView
              pages={pages}
              sources={sources}
              images={images}
              currentId={currentId ?? pages[0].id}
              setCurrentId={setCurrentId}
              onBack={() => setMode("pages")}
              update={updatePages}
              checkpoint={hist.checkpoint}
              onError={showError}
              onInfo={info}
              focus={focusReq}
            />
          ) : (
            <ToolsView onRun={runTool} activeFlags={activeFlags} hasPages={pages.length > 0} hasSelection={selected.size > 0} ocr={!!ocrConfig()} />
          )}
          </ErrorBoundary>
        </main>
      </div>

      {/* ダイアログの描画で例外が出たら、そのダイアログだけを閉じて続けられるようにする（後ろの文書はそのまま） */}
      <ErrorBoundary
        fallback={(error, reset) => {
          const close = () => {
            setDialog(null);
            setReady(null);
            pwPrompt?.resolve(null);
            setPwPrompt(null);
            draftAsking.current = false;
            setDraft(null);
            setPendingOpen(null);
            reset();
          };
          return (
            <Dialog title={t("crash.title")} onClose={close}>
              <CrashNotice error={error}>
                <button className="btn primary" onClick={close}>
                  {t("crash.retry")}
                </button>
              </CrashNotice>
            </Dialog>
          );
        }}
      >
      {dialog === "split" && <SplitDialog pages={pages} baseName={baseName} selected={selected} outline={settings.outline} onClose={() => setDialog(null)} onRun={exportGroups} onRunBySize={(bytes) => void exportBySize(bytes)} />}
      {dialog === "shortcuts" && <ShortcutsDialog onClose={() => setDialog(null)} />}
      {dialog === "batch" && <BatchDialog embedFont={embedFont} onClose={() => setDialog(null)} />}
      {dialog === "annotList" && (
        <AnnotListDialog
          pages={pages}
          sources={sources}
          includeSource={!settings.stripAnnotations}
          onClose={() => setDialog(null)}
          onJump={(e) => {
            // 編集画面のそのページへ移り、その注釈を示す
            setDialog(null);
            setMode("edit");
            setCurrentId(e.pageId);
            setFocusReq({ pageId: e.pageId, rect: e.rect, objId: e.objId, n: Date.now() });
          }}
        />
      )}
      {dialog === "find" && <FindDialog pages={pages} sources={sources} onApply={applyFind} onClose={() => setDialog(null)} />}
      {dialog === "ocr" && ocrConfig() && <OcrDialog config={ocrConfig()!} pages={pages} selected={selected} sources={sources} onApply={(r) => void applyOcr(r)} onClose={() => setDialog(null)} />}
      {dialog === "saveName" && (
        <SaveNameDialog
          initial={defaultName}
          onSave={(name) => {
            setDialog(null);
            void exportPages(pages, pdfFileName(name, `${baseName}_edited`));
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {ready && (
        <Dialog title={t(ready.kind === "share" ? "save.share" : "save.print")} onClose={() => setReady(null)}>
          <p>{t(ready.kind === "share" ? "save.shareReady" : printViaShare ? "save.printShare" : "save.printFallback")}</p>
          <div className="ready-actions">
            <button
              className="btn primary"
              autoFocus
              onClick={() => {
                const r = ready;
                setReady(null);
                // 印刷：共有できる端末（スマホなど）では、共有の一覧から印刷を選んでもらう（別のタブで開いても印刷の操作が無いことが多い）
                if (r.kind === "share" || printViaShare) void sharePdf(r.bytes, r.name).catch(showError);
                else openPdfInNewTab(r.bytes);
              }}
            >
              <Icon name={ready.kind === "share" || printViaShare ? "share" : "printer"} /> {t(ready.kind === "share" ? "save.shareNow" : printViaShare ? "save.share" : "save.openTab")}
            </button>
            {ready.kind === "print" && printViaShare && (
              <button
                className="btn ghost"
                onClick={() => {
                  const r = ready;
                  setReady(null);
                  openPdfInNewTab(r.bytes);
                }}
              >
                {t("save.openTab")}
              </button>
            )}
          </div>
        </Dialog>
      )}
      {dialog === "about" && (
        <AboutDialog
          autosave={autosaveOn}
          onAutosave={changeAutosave}
          hasDocument={pages.length > 0}
          onReload={() => {
            // 利用者が確かめたうえでの読み込み直しなので、ブラウザーの確認は重ねない
            leaveGuard.current.skip = true;
            location.reload();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "changes" && <ChangeSummaryDialog pages={pages} settings={settings} onClose={() => setDialog(null)} />}
      {dialog === "numbering" && <PageNumbersDialog decor={settings.decor} pageCount={pages.length} preview={previewDecor} onApply={(d) => updateDecor(() => d)} onClose={() => setDialog(null)} />}
      {dialog === "headerFooter" && <HeaderFooterDialog decor={settings.decor} pageCount={pages.length} preview={previewDecor} onApply={(d) => updateDecor(() => d)} onClose={() => setDialog(null)} />}
      {dialog === "watermark" && <WatermarkDialog decor={settings.decor} pageCount={pages.length} preview={previewDecor} images={images} onApply={(d) => updateDecor(() => d)} onClose={() => setDialog(null)} />}
      {dialog === "crop" && <CropDialog pages={pages} selected={selected} previewPage={previewOnePage} onApply={(next) => updatePages(() => next)} onClose={() => setDialog(null)} />}
      {dialog === "resize" && <ResizeDialog pages={pages} selected={selected} onApply={(next) => updatePages(() => next)} onClose={() => setDialog(null)} />}
      {dialog === "interleave" && <InterleaveDialog pages={pages} sources={sources} onApply={(next) => updatePages(() => next)} onClose={() => setDialog(null)} />}
      {dialog === "toImages" && <ExportImagesDialog pages={pages} selected={selected} onRun={exportImages} onClose={() => setDialog(null)} />}
      {dialog === "toText" && <ExportTextDialog pages={pages} sources={sources} selected={selected} onRun={exportTextFile} onClose={() => setDialog(null)} />}
      {dialog === "metadata" && <MetadataDialog meta={settings.meta} source={pages.find((pg) => pg.srcId)?.srcId ? sources.get(pages.find((pg) => pg.srcId)!.srcId!) : undefined} onApply={updateMeta} onClose={() => setDialog(null)} />}
      {dialog === "nup" && <ImposeDialog pageCount={pages.length} onRun={(o) => void runImpose(o)} onClose={() => setDialog(null)} />}
      {dialog === "outline" && <OutlineDialog outline={settings.outline} pages={pages} onApply={updateOutline} onClose={() => setDialog(null)} />}
      {dialog === "wareki" && <WarekiDialog pages={pages} sources={sources} onApply={applyWareki} onClose={() => setDialog(null)} />}
      {dialog === "attachments" && <AttachmentsDialog attachments={settings.attachments} sources={sources} onApply={updateAttachments} onClose={() => setDialog(null)} />}
      {dialog === "compare" && <CompareDialog currentName={baseName} buildCurrent={buildCurrent} askPassword={askPassword} onInsert={(f) => addFiles([f], pages.length)} onClose={() => setDialog(null)} />}
      {dialog === "compress" && <CompressDialog compress={settings.compress} sourceBytes={sourceSize} estimate={estimateCompress} previewPage={previewCompress} pageCount={pages.length} onApply={updateCompress} onClose={() => setDialog(null)} />}
      {dialog === "protect" && <ProtectDialog security={settings.security} sources={usedSources} onApply={updateSecurity} onClose={() => setDialog(null)} />}
      {draft && <DraftDialog draft={draft} pendingName={pendingOpen?.files[0]?.name} onRestore={() => void restoreDraft()} onDiscard={discardDraft} />}
      {pwPrompt && (
        <PasswordDialog
          name={pwPrompt.name}
          retry={pwPrompt.retry}
          onSubmit={(pw) => {
            pwPrompt.resolve(pw);
            setPwPrompt(null);
          }}
          onClose={() => {
            pwPrompt.resolve(null);
            setPwPrompt(null);
          }}
        />
      )}
      {dialog === "form" && <FormDialog sources={usedSources} onApply={applyForm} onClose={() => setDialog(null)} />}
      {dialog === "fromImages" && pendingImages && (
        <ImageToPdfDialog
          count={pendingImages.length}
          onRun={(o) => {
            setDialog(null);
            void addImagesAsPages(pendingImages, o, insertAtRef.current);
            setPendingImages(null);
          }}
          onClose={() => {
            setDialog(null);
            setPendingImages(null);
          }}
        />
      )}
      </ErrorBoundary>

      {busy && (
        <div className="busy" role="status">
          <div className="spinner" />
          {busy}
        </div>
      )}
      <ConfirmHost />
      {toast && (
        // 知らせ：警告（error）は読み上げで割り込んで知らせ、それ以外は控えめに知らせる。閉じるボタンでも、本文を押しても閉じる
        <div className={`toast ${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"} aria-live={toast.kind === "error" ? "assertive" : "polite"} onClick={() => setToast(null)}>
          <span className="toast-text">{toast.text}</span>
          <button type="button" className="icon-btn small toast-close" aria-label={t("common.close")} title={t("common.close")} onClick={() => setToast(null)}>
            <Icon name="x" />
          </button>
        </div>
      )}
    </div>
  );
}

/** 画面の明るさの切り替え（押すたびに 自動 → 明るい → 暗い） */
function ThemeSwitch() {
  const t = useT();
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const next: Record<Theme, Theme> = { auto: "light", light: "dark", dark: "auto" };
  const label = t(`theme.${theme}`);
  return (
    <button
      type="button"
      className="icon-btn theme-switch"
      title={t("theme.title", { now: label })}
      aria-label={t("theme.title", { now: label })}
      onClick={() => {
        const v = next[theme];
        saveTheme(v);
        setTheme(v);
      }}
    >
      <Icon name={theme === "dark" ? "moon" : theme === "light" ? "sun" : "contrast"} />
    </button>
  );
}

/** 画面の明るさを 3 つから選ぶ（「このソフトについて」の中。上のバーに入りきらないスマホでも選べるように） */
function ThemeChoice() {
  const t = useT();
  const [theme, setTheme] = useState<Theme>(loadTheme);
  return (
    <div className="field">
      <span>{t("theme.label")}</span>
      <div className="seg small" role="group">
        {(["auto", "light", "dark"] as const).map((k) => (
          <button
            key={k}
            type="button"
            className={theme === k ? "on" : ""}
            aria-pressed={theme === k}
            onClick={() => {
              saveTheme(k);
              setTheme(k);
            }}
          >
            {t(`theme.${k}`).replace(/[（(].*[)）]\s*$/, "")}
          </button>
        ))}
      </div>
    </div>
  );
}

function LangSwitch() {
  const { lang, setLang } = useLang();
  const t = useT();
  // 見た目は「地球儀＋いまの言語名」。本物の select を透明にして重ね、OS 標準の選択 UI を使う（スマホではアイコンだけになる）
  return (
    <label className="lang-switch" title={t("common.language")}>
      <Icon name="globe" />
      <span className="lang-current" aria-hidden>
        {LANGS.find((l) => l.id === lang)?.label}
      </span>
      <select value={lang} onChange={(e) => setLang(e.target.value as Lang)} aria-label={t("common.language")}>
        {LANGS.map((l) => (
          <option key={l.id} value={l.id} lang={l.id}>
            {l.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** 保存ボタンの横のメニュー（名前を付けて保存・上書き・共有・印刷） */
function SaveMenu({ label, items }: { label: string; items: { id: string; icon: string; label: string; onClick: () => void }[] }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="menu-wrap" ref={wrap}>
      <button className="btn primary menu-caret" aria-haspopup="menu" aria-expanded={open} title={label} aria-label={label} onClick={() => setOpen((v) => !v)}>
        <span className="caret-down">
          <Icon name="chevron" size={16} />
        </span>
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          {items.map((it) => (
            <button
              key={it.id}
              role="menuitem"
              data-menu={it.id}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
            >
              <Icon name={it.icon} /> {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** アプリの更新（端末に保存した版から起動しているときだけ出す）。確かめるのも取り込むのも、ここで押したときだけ */
function UpdateSection({ hasDocument, onReload }: { hasDocument: boolean; onReload: () => void }) {
  const t = useT();
  const [current, setCurrent] = useState<VersionInfo | null>(null);
  const [state, setState] = useState<"idle" | "checking" | "latest" | "available" | "applying" | "failed" | "login">("idle");
  const [latest, setLatest] = useState<VersionInfo | null>(null);
  const saved = hasSavedApp();
  useEffect(() => {
    if (saved) savedVersion().then(setCurrent).catch(() => undefined);
  }, [saved]);
  if (!saved) return null;
  const check = async () => {
    setState("checking");
    try {
      const r = await checkForUpdate();
      setLatest(r.latest);
      setState(r.available ? "available" : "latest");
    } catch (e) {
      // 配信元がログインの画面へ回した（ログインで守られたサイトで、ログインの期限が切れたなど）
      setState(e instanceof Error && e.message === "login" ? "login" : "failed");
    }
  };
  const apply = async () => {
    // 更新は画面を読み込み直す。文書を開いているときは、先に確かめる（保存していない編集を黙って失わせない）
    if (hasDocument && !(await askConfirm(t("update.confirm"), t("update.apply")))) return;
    setState("applying");
    try {
      await downloadUpdate();
      onReload();
    } catch (e) {
      // 配信元がログインの画面へ回した（ログインで守られたサイトで、ログインの期限が切れたなど）
      setState(e instanceof Error && e.message === "login" ? "login" : "failed");
    }
  };
  return (
    <div className="update-box">
      <h3>{t("update.title")}</h3>
      <p>{t("update.note")}</p>
      <div className="update-row">
        <span className="muted">{t("update.current", { v: versionLabel(current) })}</span>
        <span className="spacer" />
        {state === "available" ? (
          <button className="btn small primary" onClick={() => void apply()}>
            {t("update.apply")}
          </button>
        ) : (
          <button className="btn small" disabled={state === "checking" || state === "applying"} onClick={() => void check()}>
            {t("update.check")}
          </button>
        )}
      </div>
      {state !== "idle" && (
        <p className={`note ${state === "failed" || state === "login" ? "err" : ""}`} role="status">
          {state === "checking" && t("update.checking")}
          {state === "latest" && t("update.latest")}
          {state === "available" && t("update.available", { v: versionLabel(latest) })}
          {state === "applying" && t("update.applying")}
          {state === "failed" && t("update.failed")}
          {state === "login" && t("update.login")}
        </p>
      )}
    </div>
  );
}

/** ファイル名を決めて保存（保存先を選ぶ画面を出せないブラウザ用） */
function SaveNameDialog({ initial, onSave, onClose }: { initial: string; onSave: (name: string) => void; onClose: () => void }) {
  const t = useT();
  const [name, setName] = useState(initial);
  return (
    <Dialog
      title={t("save.as")}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" disabled={!name.trim()} onClick={() => onSave(name)}>
            <Icon name="download" /> {t("top.save")}
          </button>
        </>
      }
    >
      <label className="field">
        <span>{t("save.nameLabel")}</span>
        <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && onSave(name)} onFocus={(e) => e.target.setSelectionRange(0, e.target.value.replace(/\.pdf$/i, "").length)} autoFocus spellCheck={false} />
      </label>
    </Dialog>
  );
}

/** このソフトについて：バージョン・ライセンス・同梱部品のライセンス文（HTML に埋め込んだものを表示） */
function AboutDialog({ autosave, onAutosave, hasDocument, onReload, onClose }: { autosave: boolean; onAutosave: (on: boolean) => void; hasDocument: boolean; onReload: () => void; onClose: () => void }) {
  const t = useT();
  // 版の番号に、作った時点（コミットの番号と日時）を添える。単一ファイル版は自分では更新されないので、手元の版が最新かをここで見分ける
  const [commit, committed] = (process.env.APP_COMMIT ?? "").split(",");
  const when = committed ? new Date(committed) : null;
  const version = [process.env.APP_VERSION ?? "dev", commit, when && !Number.isNaN(when.getTime()) ? when.toLocaleString(undefined, { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }) : ""].filter(Boolean).join(" · ");
  const notice = document.getElementById("app-notice")?.textContent?.trim() ?? "";
  const third = document.getElementById("third-party-licenses")?.textContent?.trim() ?? "";
  return (
    <Dialog title={t("about.title")} onClose={onClose} className="about">
      <div className="about-hero">
        <Logo size={56} />
        <div>
          <Wordmark className="about-wordmark" />
          <div className="muted">{t("about.version", { v: version })}</div>
        </div>
      </div>
      <ThemeChoice />
      <h3>{t("about.h.use")}</h3>
      <ul className="about-list">
        <li>{t("about.free")}</li>
        <li>{t("about.license")}</li>
        <li>{t("about.official")}</li>
        <li>
          {t("about.site")}{" "}
          <a href="https://washipdf.com" target="_blank" rel="noopener noreferrer">
            washipdf.com
          </a>
        </li>
      </ul>
      <h3>{t("about.h.data")}</h3>
      <ul className="about-list">
        <li>{t("about.privacy")}</li>
        <li>{t("about.offline")}</li>
        <li>{t("about.csp")}</li>
        <li>
          {t("about.webOnly")}
          <ul>
            <li>{t("about.webUpdate")}</li>
            <li>{t("about.webOcr")}</li>
          </ul>
        </li>
      </ul>
      <h3>{t("about.h.draft")}</h3>
      <ul className="about-list">
        {/* ダウンロード版は既定で自動保存しないので、その版に合う説明を先頭に出す */}
        <li>{t(isLocalFile() ? "about.draftLocal" : "about.draft1")}</li>
        <li>{t("about.draft2")}</li>
        <li>{t("about.draft3")}</li>
        <li>{t("about.draft4")}</li>
      </ul>
      <p>{t("about.draft5")}</p>
      <label className="checkbox">
        <input type="checkbox" checked={autosave} onChange={(e) => onAutosave(e.target.checked)} /> {t("about.draftToggle")}
      </label>
      <UpdateSection hasDocument={hasDocument} onReload={onReload} />
      {notice && <pre className="license-text short">{notice}</pre>}
      <h3>{t("about.thirdParty")}</h3>
      <pre className="license-text" tabIndex={0}>{third}</pre>
    </Dialog>
  );
}

/** 前回の下書きを復元するか尋ねる */
function DraftDialog({ draft, pendingName, onRestore, onDiscard }: { draft: DraftSummary; pendingName?: string; onRestore: () => void; onDiscard: () => void }) {
  const t = useT();
  const when = new Date(draft.savedAt).toLocaleString();
  return (
    <div className="modal-back">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="draft-title">
        <div className="modal-head">
          <h2 id="draft-title">{t("draft.title")}</h2>
        </div>
        <div className="modal-body">
          <p>{t("draft.desc", { name: draft.baseName, n: draft.pageCount, time: when })}</p>
          <p className="muted">{t("draft.note")}</p>
          {pendingName && (
            <p className="note" role="status">
              {t("draft.pendingOpen", { name: pendingName })}
            </p>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onDiscard}>
            {t("draft.discard")}
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn primary" onClick={onRestore} autoFocus>
            {t("draft.restore")}
          </button>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ onPick, onDrop, onImages, onBlank }: { onPick: () => void; onDrop: (files: File[], handles?: (FileHandle | null)[]) => void; onImages: () => void; onBlank: () => void }) {
  const t = useT();
  const [over, setOver] = useState(false);
  return (
    <div className="empty">
      <div className="hero">
        <Logo size={72} />
        <Wordmark className="hero-wordmark" />
      </div>
      <div
        data-dropzone
        className={`dropzone ${over ? "over" : ""}`}
        role="button"
        tabIndex={0}
        onClick={onPick}
        onKeyDown={(e) => {
          if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            onPick();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const files = [...e.dataTransfer.files];
          const hs = handlesFromDrop(e.dataTransfer);
          void Promise.all(hs).then((h) => onDrop(files, h.length === files.length ? h : undefined));
        }}
      >
        <div className="dz-icon">
          <Icon name="upload" size={34} />
        </div>
        <h1>
          <span className="hint-pointer">{t("empty.title")}</span>
          <span className="hint-touch">{t("empty.titleTouch")}</span>
        </h1>
        <p>
          <span className="hint-pointer">{t("empty.sub")}</span>
          <span className="hint-touch">{t("empty.subTouch")}</span>
        </p>
      </div>
      {/* PDF が手元に無くても始められる入口 */}
      <div className="empty-alt">
        <button className="btn ghost" onClick={onImages}>
          <Icon name="image" /> {t("tool.fromImages")}
        </button>
        <button className="btn ghost" onClick={onBlank}>
          <Icon name="file-plus" /> {t("empty.blank")}
        </button>
      </div>
      {/* 機能の一覧は置かず、いちばん大事な約束だけを示す */}
      <p className="empty-privacy">
        <Icon name="lock" /> {t("empty.f4")}
      </p>
    </div>
  );
}

/** File Handling API（Chromium 系のデスクトップ PWA）の最小限の型 */
interface LaunchParams {
  files?: FileSystemFileHandle[];
}
interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void | Promise<void>): void;
}

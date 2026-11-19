import { approvalLayout } from "./approval";
import {
  degrees,
  LineCapStyle,
  PDFArray,
  PDFDict,
  PDFDocument,
  type PDFFont,
  PDFHexString,
  type PDFImage,
  PDFName,
  PDFNumber,
  type PDFObject,
  PDFObjectCopier,
  type PDFPage,
  PDFRef,
  PDFStream,
  PDFString,
  popGraphicsState,
  pushGraphicsState,
  concatTransformationMatrix,
  rgb,
} from "pdf-lib";
import { baselineOffset, LINE_HEIGHT, loadFontBytes } from "./fonts";
import { fmt } from "./contentStream";
import { decodeStreamBytes } from "./pdfFontInfo";
import { apply, invert, multiply as multiplyMatrix, normRot } from "./geometry";
import { tr, AppError } from "./i18n";
import { addInk, addLink, addMarkup, addNote, removeLinkAnnots, stripAnnotations } from "./annots";
import { buildAnchoredContent, visualToLogical, WORDCHAR, WORDISH } from "./anchoredEdit";
import { planInPlace } from "./inPlaceEdit";
import { splitBlockEdit } from "./blockEdit";
import { analyzePage, loadLibPdf } from "./libDoc";
import { writeAttachments } from "./attachments";
import { compressImages, type CompressStats } from "./compress";
import { optimizeStreams, stripAuxiliary } from "./optimize";
import { shrinkFonts } from "./fontShrink";
import { grayscaleDocument } from "./grayscale";
import { writeOutlines } from "./outlines";
import { encryptDocument } from "./security";
import { embedSubsetFont, finishSubsetFonts } from "./pdfFont";
import { drawTextMaybeShaped, isShapingFont, mirrored, prepareShapedEmbedding } from "./shape";
import { wordPieces } from "./rtlWrite";
import { colorTriple, drawVerticalColumns, layoutVertical, verticalColumns, verticalColumnsContent, verticalFontMeasurer, verticalMeasurer } from "./verticalText";
import { clipRedactedAreas, displayRectToPage, pageFontForShow, removeAnnotsIn, rewritePageContent } from "./redact";
import { samePath, type ShowOp } from "./textOps";
import { collectNonPageTexts, describePlace, findLeftovers, pageTextsOf, type RedactCheck, redactedWords, removedTextIsGone, scrubLabels, textInRects, type TextRunLite } from "./redactCheck";
import { forgetUnusedGlyphs } from "./redactFonts";
import { cleanUpAfterRemoval, copyLayers, dropUnusedXObjects, relinkCopiedPages, removeUnreachableObjects, stripActiveActions } from "./purge";
import { redactImageRegions } from "./redactImages";
import { appendContent, buildTextEditContent, bundledWriter, originalWriter, type TextWriter } from "./textEdit";
import { bundledHasGlyph, coverage, fontDef, fontList, fontRuns, measureBundled, pickFont } from "./fonts";
import { applyMeta, decorTexts, defaultSettings, type DocSettings, drawDecor, hasDecor } from "./docOps";
import { writeFields } from "./formWrite";
import { drawMeasure } from "./measure";
import type { EditObj, FieldObj, FontKey, ImageEditObj, LinkObj, Matrix, PageItem, RedactObj, SourceDoc, StoredImage, TextEditObj } from "./types";

function color(hex: string | null | undefined) {
  if (!hex) return undefined;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return rgb(0, 0, 0);
  const n = parseInt(m[1], 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** 既存コンテンツを q ... Q で包み、変換行列が残っていても追記が正しい位置に描かれるようにする */
function isolateExistingContent(doc: PDFDocument, page: PDFPage) {
  const ctx = doc.context;
  const start = ctx.register(ctx.contentStream([pushGraphicsState()]));
  const end = ctx.register(ctx.contentStream([popGraphicsState()]));
  page.node.normalize();
  page.node.wrapContentStreams(start, end);
}

export interface BuildOptions {
  onProgress?: (done: number, total: number) => void;
  /** 墨消しがあるとき、保存した PDF を読み直して確かめた結果 */
  onRedactCheck?: (r: RedactCheck) => void;
  /** 文書全体の設定（ページ番号・透かし・メタデータ）。省略時は無し */
  settings?: DocSettings;
  /** テンプレートの {file} に入れる名前 */
  fileName?: string;
  /** 実編集で収まりきらなかった等の警告 */
  onWarning?: (message: string) => void;
  /** 墨消しした語が、文書情報・しおり・ほかのページなどに残っているとき。保存の前に確かめるのに使う（知らせの文） */
  onLeftover?: (message: string) => void;
  /** まとめて処理から呼ぶとき：墨消しの残りの知らせを「直してから保存し直す」ではなく「処理したファイルを開いて直す」案内にする */
  batch?: boolean;
  /** 検査用：文字の書き換え 1 件ごとに、どの書き方になったか（"anchored"＝変えた部分だけ／それ以外＝行を組み直した理由） */
  onEditPath?: (how: string, original: string) => void;
  /** 検査用：文字を変えていない書き換えも書き直す（既定では元のまま残す）。横書きは「書き足す」経路を通す＝その経路で元と同じ見た目になるかを確かめられる */
  rewriteUnchanged?: boolean;
  /** 圧縮を掛けたときの結果 */
  onCompressStats?: (stats: CompressStats) => void;
  /** フォント埋め込みの差し替え（テスト用） */
  embedFont?: (doc: PDFDocument, key: FontKey, text: string) => Promise<PDFFont>;
  /** ページ番号・ヘッダーなどの {n}/{N} を数える基準のページ一覧（プレビューで 1 ページだけ組み立てるとき、文書全体を渡す） */
  decorPages?: PageItem[];
}

export async function defaultEmbedFont(doc: PDFDocument, key: FontKey, text: string): Promise<PDFFont> {
  const fontkit = (await import("@pdf-lib/fontkit")).default;
  doc.registerFontkit(fontkit);
  // 使った文字だけを残したフォントを自前で作って埋め込む（整形フォントは整形後の字形も残す）
  return embedSubsetFont(doc, await loadFontBytes(key), text, isShapingFont(key) ? prepareShapedEmbedding(key, text) : undefined);
}

export async function buildPdf(
  pages: PageItem[],
  sources: Map<string, SourceDoc>,
  images: Map<string, StoredImage>,
  opts: BuildOptions = {},
): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  out.setProducer("Washi PDF (pdf-lib)");
  out.setCreator("Washi PDF");
  const settings = opts.settings ?? defaultSettings();
  const fileName = opts.fileName ?? "document";

  // 文字を使う場合のみ fontkit と日本語フォントを読み込む
  const usedText = new Map<FontKey, string>();
  for (const p of pages)
    for (const o of p.objects) {
      if (o.type === "text" && o.text.trim()) {
        usedText.set(o.font, (usedText.get(o.font) ?? "") + o.text);
        // 主のフォントに無い字は、その字を持つ同梱フォントで書く。区間ごとに整形するので、区間を 1 行ずつ渡す
        if (!o.vertical) {
          for (const line of o.text.split("\n")) {
            const runs = fontRuns(o.font, line);
            if (runs.length > 1) for (const r of runs) usedText.set(r.key, `${usedText.get(r.key) ?? ""}\n${r.text.trim()}\n`);
          }
        }
      }
      if (o.type === "stamp" && o.text.trim()) usedText.set(o.font, (usedText.get(o.font) ?? "") + o.text);
      // 実編集：元フォントで書く場合も、書けなかったときの代替用に同梱フォントを用意しておく
      if (o.type === "textedit" && o.text.trim()) {
        const key = fallbackKey(o);
        usedText.set(key, (usedText.get(key) ?? "") + o.text);
        // 変えた語だけを同梱フォントで書く場合の分。語ごとに整形するので、語を 1 行ずつ渡す（行全体で整形したときと字形が変わることがある）
        const alt = altKey(o);
        // （語の中の変えていない部分は、入力するときの字の順に直してから整形するので、その形も渡す）
        const words = [...wordsOf(o.text), ...wordsOf(changedPart(o))];
        // 行全体の字（空白を含む）も渡す：語の間の空白も、このフォントの字形で書く
        usedText.set(alt, `${usedText.get(alt) ?? ""}\n${o.text}\n${[...words, ...words.map(visualToLogical)].join("\n")}\n`);
        // 右から左へ書く文字の行は、語ごとに、向きとフォントで分けた区間を書く（rtlWrite）。その区間を 1 行ずつ渡す。
        // 行の向きは字形を見るまで分からないので、どちらの向きの分も入れておく（整形しないフォントは、左右逆の形のかっこも）
        if (o.rtl) {
          for (const word of o.text.trim().split(/\s+/).filter(Boolean))
            for (const base of ["R", "L"] as const)
              for (const piece of wordPieces(o.family, word, base) ?? []) usedText.set(piece.key, `${usedText.get(piece.key) ?? ""}\n${piece.text}\n${isShapingFont(piece.key) ? "" : `${mirrored(piece.text)}\n`}`);
        }
      }
    }
  const decorItems = opts.decorPages ?? pages;
  for (const [key, text] of decorTexts(settings.decor, decorItems.length, fileName)) usedText.set(key, (usedText.get(key) ?? "") + text);
  const fonts = new Map<FontKey, PDFFont>();
  const embed = opts.embedFont ?? defaultEmbedFont;
  for (const [key, text] of usedText) fonts.set(key, await embed(out, key, text));

  // 元PDFごとに必要なページをまとめてコピー
  const libDocs = new Map<string, PDFDocument>();
  const copied = new Map<string, PDFPage>();
  const bySrc = new Map<string, PageItem[]>();
  const layerParts: { src: PDFDocument; srcIndices: number[]; copied: PDFPage[] }[] = [];
  for (const p of pages) {
    if (!p.srcId) continue;
    const arr = bySrc.get(p.srcId) ?? [];
    arr.push(p);
    bySrc.set(p.srcId, arr);
  }
  for (const [srcId, items] of bySrc) {
    const src = sources.get(srcId);
    if (!src) throw new AppError(tr("export.sourceMissing"));
    let lib = libDocs.get(srcId);
    if (!lib) {
      lib = await loadLibPdf(src);
      libDocs.set(srcId, lib);
    }
    // 同じページを複製したときは、写しごとに別々にコピーする（1 回のコピーで同じページを 2 度写すと、中身・注釈の配列を
    // 共有してしまい、片方に足した注釈や白塗りがもう片方にも出る）。n 回目に出てきたページは n 回目のコピーで写す
    const rounds: PageItem[][] = [];
    const seen = new Map<number, number>();
    for (const it of items) {
      const n = seen.get(it.srcIndex) ?? 0;
      seen.set(it.srcIndex, n + 1);
      (rounds[n] ??= []).push(it);
    }
    for (const round of rounds) {
      const idx = round.map((i) => i.srcIndex);
      let result: PDFPage[];
      try {
        result = await out.copyPages(lib, idx);
      } catch (e) {
        // 構造が壊れていて写せない（ページの親子が輪になっている、入れ子が深すぎるなど）：pdf.js で作り直したものから写す
        if (e instanceof AppError) throw e;
        lib = await loadLibPdf(src, true);
        libDocs.set(srcId, lib);
        result = await out.copyPages(lib, idx);
      }
      round.forEach((it, i) => copied.set(it.id, result[i]));
      layerParts.push({ src: lib, srcIndices: idx, copied: result });
      // リンクの飛び先などが指すページを、出力の本物のページへ付け替える（隠れた写しに元の内容が残らないように）
      relinkCopiedPages(out, lib, idx, result);
    }
  }

  // レイヤーの表示・非表示の設定を引き継ぐ（非表示のレイヤーが、保存後に見えてしまわないように）
  copyLayers(out, layerParts);

  // アクセシビリティ用のタグ（/StructTreeRoot・/MarkInfo）：1 つの文書の全ページを、それぞれ 1 回ずつ保存するとき（開いて編集して保存する
  // ふつうの使い方）だけ引き継ぐ。ほかの文書と合わせたり、ページを削ったりしたときは、タグとページの対応が崩れるので引き継がない
  // 墨消し・元の注釈の削除・リンクの作り直し・元の画像の削除があるときも引き継がない：タグは注釈や画像の説明（/Alt）を
  // 自分で指しているので、ページから外したリンクや注釈、消した画像の説明がファイルに残ってしまう
  const removesContent =
    settings.stripAnnotations ||
    // リンクの道具を選んだだけで、元のリンクが 1 つも無かったページは、何も外していない
    pages.some((p) => (Array.isArray(p.linksImported) ? p.linksImported.length > 0 : !!p.linksImported) || p.objects.some((o) => o.type === "redact" || o.type === "imageedit"));
  if (bySrc.size === 1 && !removesContent) {
    const [srcId, items] = [...bySrc][0];
    const lib = libDocs.get(srcId);
    const idx = items.map((i) => i.srcIndex);
    if (lib && idx.length === lib.getPageCount() && new Set(idx).size === idx.length)
      copyStructure(
        out,
        lib,
        idx,
        items.map((i) => copied.get(i.id)!),
      );
  }

  const embeddedImages = new Map<string, PDFImage>();
  const getImage = async (id: string) => {
    let img = embeddedImages.get(id);
    if (!img) {
      const s = images.get(id);
      if (!s) throw new AppError(tr("export.imageMissing"));
      img = s.mime === "image/png" ? await out.embedPng(s.bytes) : await out.embedJpg(s.bytes);
      embeddedImages.set(id, img);
    }
    return img;
  };

  const removedTexts: string[] = [];
  /** 消した画像・書き換える前の Form XObject（保存前にファイルから取り除く） */
  const sensitiveRefs: PDFRef[] = [];
  /** 墨消しのあるページ（保存後の検証に使う）。index は出力でのページ番号（0 始まり） */
  const redactedPages: { index: number; item: PageItem; removed: string[]; uncertain: boolean }[] = [];
  for (const src of new Set(pages.map((p) => p.srcId && sources.get(p.srcId)))) if (src && src.signed) opts.onWarning?.(tr("export.signedWarning", { name: src.name }));
  let done = 0;
  // リンクは全ページを作ってから足す（後ろのページへのリンクは、そのページができるまで行き先を書けない）
  const pendingLinks: { page: PDFPage; item: PageItem; obj: LinkObj }[] = [];
  const pendingFields: { page: PDFPage; item: PageItem; obj: FieldObj }[] = [];
  const scaledPages: { page: PDFPage; ux: number; uy: number }[] = [];
  for (const item of pages) {
    const page = item.srcId ? out.addPage(copied.get(item.id)!) : out.addPage([item.width, item.height]);
    // ページの内容（/Contents）は、ストリームか、ストリームの配列でなければならない。壊れた PDF で別のものが入っていると、
    // 書き足すときに止まるので、ストリームでないものは外す（表示側も、ストリームでないものは描かない）
    {
      const raw = page.node.get(PDFName.of("Contents"));
      const v = raw instanceof PDFRef ? out.context.lookup(raw) : raw;
      if (v instanceof PDFArray) {
        const ok = v.asArray().filter((x) => (x instanceof PDFRef ? out.context.lookup(x) : x) instanceof PDFStream);
        if (ok.length !== v.size()) page.node.set(PDFName.of("Contents"), out.context.obj(ok));
      } else if (v !== undefined && !(v instanceof PDFStream)) page.node.delete(PDFName.of("Contents"));
    }
    page.setRotation(degrees(normRot(item.baseRotation + item.extraRotation)));
    // 元 PDF の注釈（リンク・コメント・フォームの見た目）を外す。自分で付ける注釈はこの後に追加する
    if (settings.stripAnnotations && item.srcId) stripAnnotations(page);
    // 元のリンクを部品として読み込んだページは、元のリンクを外す（部品から作り直す。消した・変えたリンクが元のまま残らないように）
    else if (item.linksImported && item.srcId) removeLinkAnnots(page, libDocs.get(item.srcId)?.getPage(item.srcIndex), item.linksImported);
    let removedContent = false;
    const inPlace = new Set<TextEditObj>();
    const unchanged = new Set<TextEditObj>();
    const placed = new Set<TextEditObj>();
    if (item.objects.length) {
      // 段落の書き換えは、変えた行だけの書き換えに分ける（変えていない行は元のまま残る）
      const objects = underRedaction(item.objects.flatMap((o): EditObj[] => (o.type === "textedit" ? (splitBlockEdit(o, !!opts.rewriteUnchanged) ?? [o]) : [o])), pages.indexOf(item) + 1, !!opts.rewriteUnchanged);
      const edits = objects.filter((o): o is TextEditObj => o.type === "textedit");
      const imageDeletes = objects.filter((o): o is ImageEditObj => o.type === "imageedit");
      const redacts = objects.filter((o): o is RedactObj => o.type === "redact");
      if (item.srcId && (edits.length || imageDeletes.length || redacts.length)) {
        const pageNo = pages.indexOf(item) + 1;
        // 範囲に一部だけ掛かる画像は、その範囲の画素だけを塗りつぶした複製に差し替える（スキャン文書でページ全体が消えないように）
        // 元のページの解析を済ませておく（ToUnicode の無いフォントの文字の対応表が、ここで用意される。
        // 墨消しで取り除いた文字を記録し、保存後に確かめるのに使う）
        const srcDoc = sources.get(item.srcId);
        if (redacts.length && srcDoc) await analyzePage(srcDoc, item.srcIndex).catch(() => undefined);
        let imgs: Awaited<ReturnType<typeof redactImageRegions>>;
        try {
          imgs = await redactImageRegions(out, page, item, redacts, sources.get(item.srcId));
        } catch (e) {
          if (e instanceof AppError) throw e;
          throw new AppError(tr("export.contentUnreadable", { page: pageNo, detail: e instanceof Error ? e.message : String(e) }));
        }
        if (imgs.whole) opts.onWarning?.(tr("redact.imageWhole", { page: pageNo }));
        // できるときは、元の命令の文字列だけを差し替える（位置・字送り・重なりの順序は元のまま＝変えていない字が動かない）。
        // 縦書きの 1 列、横書きで 1 つの命令の中に収まる書き換えが当てはまる。当てはまらない書き換えは、あとで書き足す
        const rewriteEdits: TextEditObj[] = [];
        const afterRewrite: (() => void)[] = [];
        for (const e of edits) {
          let plan = null;
          // 大きさ・色を変えていないこと（命令の中の字だけを入れ替えるので、それ以外は元のままになる）
          const untouched = isUntouched(e);
          // 編集を始めたが何も変えなかった行は、元のまま残す（書き直さない）
          if (untouched && e.text === e.original && !opts.rewriteUnchanged) {
            plan = { removals: [] };
            unchanged.add(e);
          } else if (untouched && srcDoc && !e.complex && !(opts.rewriteUnchanged && e.text === e.original && !e.vertical)) plan = planInPlace(e, await analyzePage(srcDoc, item.srcIndex));
          // 命令の中だけでは済まない書き換え（空白の増減、字数が増える、複数の命令にまたがる 等）：
          // 変えた部分だけを組み直した内容を、元の命令があった場所に差し込む（重なりの順序・切り抜きが元のまま保たれる）
          if (!plan && srcDoc && !e.vertical && e.font === "original" && e.text.trim()) {
            const ap = anchoredInPlace(out, page, item, e, await analyzePage(srcDoc, item.srcIndex), opts.onEditPath, fonts);
            if (ap) {
              plan = ap;
              placed.add(e);
              afterRewrite.push(ap.after);
            }
          }
          // 字形の並びのままの行（インド系の文字など）は、上の方法で書けなければ書き換えない：行を丸ごと打ち直すと、
          // 変えていない部分まで崩れる。元のまま残して知らせる
          if (!plan && e.complex) {
            plan = { removals: [] };
            unchanged.add(e);
            // 文字のほか、フォントや大きさを変えた場合も（この行ではどちらも変えられない）
            if (e.text !== e.original || e.font !== "original" || (e.source && Math.abs(e.fontSize - e.source.fontSize) > 1e-6)) opts.onWarning?.(tr("export.complexNotApplied", { text: e.original.slice(0, 20) }));
          }
          if (plan) inPlace.add(e);
          rewriteEdits.push(plan ? { ...e, removals: plan.removals } : e);
        }
        const removedHere: string[] = [];
        let uncertain = false;
        try {
          rewritePageContent(out, page, item, { textEdits: rewriteEdits, imageDeletes, redacts, onWarning: opts.onWarning, pageNo, onRemovedText: (t) => removedHere.push(t), onUncertain: () => (uncertain = true), imageReplacements: imgs.replacements, imageKeep: imgs.keep, onSensitiveRef: (r) => sensitiveRefs.push(r) });
        } catch (e) {
          // ページの内容を読み取れない（壊れた圧縮・対応していない形式など）：消したことを確かめられないので保存しない
          if (e instanceof AppError) throw e;
          throw new AppError(tr("export.contentUnreadable", { page: pageNo, detail: e instanceof Error ? e.message : String(e) }));
        }
        for (const f of afterRewrite) f();
        removedContent = true;
        removedTexts.push(...removedHere);
        if (redacts.length) redactedPages.push({ index: pageNo - 1, item, removed: removedHere, uncertain });
      }
      if (item.srcId) isolateExistingContent(out, page);
      if (item.srcId && redacts.length) {
        // 図形（パス）は命令を消せないので、範囲を除いたクリップで見えなくする。範囲に掛かる元の注釈も外す
        clipRedactedAreas(out, page, item, redacts);
        removeAnnotsIn(out, page, redacts.map((r) => displayRectToPage(item, r)));
      }
      const src = item.srcId ? sources.get(item.srcId) : undefined;
      // 単位の大きいページ（/UserUnit。1 単位が 1/72 インチより大きい）：画面の座標は、実際の大きさ（pt）で数えている。
      // ページの中身に描く部品は、単位を合わせた座標の中で描く（そのままだと、塗りや文字が UserUnit 倍の大きさになる）
      const uuObj = page.node.lookup(PDFName.of("UserUnit"));
      const uu = uuObj instanceof PDFNumber && uuObj.asNumber() > 0 ? uuObj.asNumber() : 1;
      const drawItem: PageItem = uu === 1 ? item : { ...item, viewTransform: item.viewTransform.map((v, i) => (i < 4 ? v / uu : v)) as Matrix };
      if (uu !== 1) page.pushOperators(pushGraphicsState(), concatTransformationMatrix(1 / uu, 0, 0, 1 / uu, 0, 0));
      for (const obj of objects) {
        if (obj.type === "textedit" && placed.has(obj)) continue; // 差し込み済み（経路は差し込んだときに知らせてある）
        else if (obj.type === "textedit" && inPlace.has(obj)) opts.onEditPath?.(unchanged.has(obj) ? "unchanged" : "in-place", obj.original);
        else if (obj.type === "textedit") await drawTextEdit(out, page, drawItem, obj, src, fonts, opts.onWarning, opts.onEditPath);
        else if (obj.type === "markup") addMarkup(out, page, item, obj);
        else if (obj.type === "note") addNote(out, page, item, obj);
        else if (obj.type === "ink") addInk(out, page, item, obj);
        else if (obj.type === "link") pendingLinks.push({ page, item, obj });
        else if (obj.type === "field") pendingFields.push({ page, item, obj });
        else if (obj.type === "measure") await drawMeasure(out, page, drawItem, obj);
        else await drawObject(page, drawItem, obj, fonts, getImage);
      }
      if (uu !== 1) page.pushOperators(popGraphicsState());
    }

    // 消した内容の手がかりを残さない（縮小画像・編集用データ・使われなくなったフォントや画像の登録）。
    // 足した文字が元のフォントを使うことがあるので、部品を描き終えてから調べる
    if (removedContent) cleanUpAfterRemoval(out, page);
    if (hasDecor(settings.decor)) await drawDecor(out, page, item, decorItems.indexOf(item), decorItems, settings.decor, fileName, { fonts, getImage });
    const scaled = applyCropAndScale(out, page, item);
    if (scaled) scaledPages.push({ page, ...scaled });
    opts.onProgress?.(++done, pages.length);
  }

  const outPages = out.getPages();
  // 元の PDF の JavaScript・外部プログラムの起動は外す（足すリンク・入力欄より前に）
  stripActiveActions(out);
  for (const l of pendingLinks) addLink(out, l.page, l.item, l.obj, (id) => outPages[pages.findIndex((p) => p.id === id)]?.ref);
  await writeFields(out, pendingFields);
  // 大きさを変えたページは、注釈（元の注釈・足したリンク・入力欄など）の位置も同じ割合で動かす
  for (const s of scaledPages) scaleAnnotations(out, s.page, s.ux, s.uy);
  if (settings.outline?.length) writeOutlines(out, settings.outline, (id) => pages.findIndex((p) => p.id === id));
  if (settings.attachments?.length) await writeAttachments(out, settings.attachments);
  const compressStats = settings.compress?.enabled ? await compressImages(out, settings.compress) : null;
  if (settings.grayscale) await grayscaleDocument(out);
  // 文書情報：最初のページの元の文書から引き継ぎ（タイトル・作成者など）、文書情報の画面で入れた値で上書きする
  const firstSrc = pages.find((p) => p.srcId)?.srcId;
  const firstLib = firstSrc ? libDocs.get(firstSrc) : undefined;
  if (firstLib) inheritInfo(out, firstLib);
  // フォームの入力欄：ページと一緒に写した入力欄（ウィジェット）から、文書の入力欄の一覧（/AcroForm）を作り直す
  rebuildAcroForm(out, [...libDocs.values()], firstLib);
  // 文書の言語（/Lang）は、最初のページの元の文書から引き継ぐ（読み上げ・検索の言語の判断に使われる）
  const lang = firstLib?.catalog.lookup(PDFName.of("Lang"));
  if (lang instanceof PDFString || lang instanceof PDFHexString) out.catalog.set(PDFName.of("Lang"), lang);
  // 文書の開き方の指定など（読む向き・見開き・しおりを開いて表示・色の基準）も、最初のページの元の文書から引き継ぐ。
  // ページ番号の振り方（/PageLabels）は、1 つの文書の全ページを元の順のまま保存するときだけ（順が変わると、番号がずれる）
  if (firstLib) {
    const whole = bySrc.size === 1 && pages.length === firstLib.getPageCount() && pages.every((p, i) => p.srcIndex === i);
    inheritCatalog(out, firstLib, whole);
  }
  applyMeta(out, settings.meta);
  await finishSubsetFonts(out, fonts.values());
  // 墨消しの取りこぼし：ページ内容以外は暗号化の前に調べる
  const words = redactedWords(removedTexts);
  // ページ番号のラベルとレイヤーの名前に残った語は、ここで取り除く（画面では直せないため）
  if (words.length) scrubLabels(out, words);
  const targets = words.length ? collectNonPageTexts(out, settings.outline ?? [], settings.attachments ?? []) : [];
  // 「消した」ものの元データをファイルに残さない：書き換える前の内容ストリームや、描画命令を外した画像は、
  // どこからも参照されていなくても pdf-lib が書き出してしまう。埋め込み（フォント・画像）を済ませてから取り除く
  await out.flush();
  dropUnusedXObjects(out, sensitiveRefs);
  // 墨消ししたページのフォントから、どこでも使われなくなった字の手がかり（対応表・幅・字の形）を取り除く
  if (redactedPages.length) forgetUnusedGlyphs(out, redactedPages.map((rp) => outPages[rp.index]).filter(Boolean));
  // 圧縮を選んでいるときは、画像以外も小さくする（どれも見た目は変わらない）：
  // 表示に使われない付随データを外す → 丸ごと埋め込まれたフォントから使っていない字を除く →（参照されなくなったものを取り除く）→ 重複したデータの統合と、圧縮のやり直し
  const fontStats = compressStats ? (stripAuxiliary(out), shrinkFonts(out)) : null;
  removeUnreachableObjects(out);
  if (compressStats) {
    const more = optimizeStreams(out);
    opts.onCompressStats?.({ ...compressStats, merged: more.merged, repacked: more.recompressed, fonts: fontStats?.fonts, fontSaved: fontStats?.saved });
  }
  let bytes: Uint8Array;
  if (settings.security?.enabled) {
    // 暗号化はオブジェクト単位。保存時に作られるオブジェクトストリームには掛けられないので使わない
    await out.flush();
    await encryptDocument(out, settings.security);
    bytes = await out.save({ useObjectStreams: false });
  } else bytes = await out.save({ useObjectStreams: true });
  if (redactedPages.length && (opts.onWarning || opts.onRedactCheck)) {
    let texts: string[] | null = null;
    let runs: TextRunLite[][] | null = null;
    try {
      ({ texts, runs } = await pageTextsOf(bytes, settings.security?.enabled ? settings.security.userPassword || settings.security.ownerPassword : undefined));
    } catch {
      /* 読めなければページ内容の検査は省く */
    }
    if (words.length && opts.onWarning) {
      texts?.forEach((text, i) => targets.push({ place: { kind: "page", page: i + 1 }, text }));
      for (const l of findLeftovers(words, targets).slice(0, 5)) {
        // 本文に残っているなら検索での墨消しへ、それ以外（文書情報・しおりなど）ならその編集へ案内する
        const inText = l.places.some((pl) => pl.kind === "page");
        const msg = tr(opts.batch ? "redact.leftoverBatch" : inText ? "redact.leftoverText" : "redact.leftover", { word: l.word, where: l.places.slice(0, 4).map(describePlace).join(tr("common.sep")), tool: tr("tool.find"), mode: tr("find.modeRedact") });
        opts.onWarning(msg);
        // 保存の前に確かめられるように、別にも知らせる
        opts.onLeftover?.(msg);
      }
    }
    // 保存した PDF を読み直して、消した文字がそのページから実際に減っているかを確かめる
    if (opts.onRedactCheck) {
      const result: RedactCheck = { pages: redactedPages.length, verified: 0, unverified: [] };
      for (const rp of redactedPages) {
        let ok = false;
        try {
          const src = rp.item.srcId ? sources.get(rp.item.srcId) : undefined;
          if (texts && src && !rp.uncertain) {
            const c = await (await src.pdf.getPage(rp.item.srcIndex + 1)).getTextContent();
            ok = removedTextIsGone(c.items.map((it) => ("str" in it ? it.str : "")).join(" "), texts[rp.index] ?? "", rp.removed);
            // 消したと数えた文字だけでなく、範囲の中に字が残っていないかも位置で確かめる（消し損ねた字を見逃さない）。
            // 大きさを変えたページは、範囲も同じ割合で拡大縮小してから比べる
            if (ok && runs) {
              const k = scaleOf(rp.item);
              const rects = rp.item.objects
                .filter((o): o is RedactObj => o.type === "redact")
                .map((o) => displayRectToPage(rp.item, o))
                .map((q) => ({ x0: q.x0 * k.ux, y0: q.y0 * k.uy, x1: q.x1 * k.ux, y1: q.y1 * k.uy }));
              if (textInRects(runs[rp.index] ?? [], rects).length) ok = false;
            }
          }
        } catch {
          ok = false;
        }
        if (ok) result.verified++;
        else result.unverified.push(rp.index + 1);
      }
      opts.onRedactCheck(result);
    }
  }
  return bytes;
}

/** トリミング（CropBox）とサイズ変更（内容全体を拡大縮小して MediaBox を変える）を適用する */
/** ページの注釈の座標（矩形・四辺形・線の点など）を ux・uy 倍にする（ページの大きさを変えたとき） */
function scaleAnnotations(doc: PDFDocument, page: PDFPage, ux: number, uy: number) {
  const annots = page.node.lookup(PDFName.of("Annots"));
  if (!(annots instanceof PDFArray)) return;
  const scaleList = (arr: PDFArray) =>
    doc.context.obj(arr.asArray().map((v, i) => (v instanceof PDFNumber ? v.asNumber() * (i % 2 ? uy : ux) : v)));
  for (const a of annots.asArray()) {
    const d = a instanceof PDFRef ? doc.context.lookup(a) : a;
    if (!(d instanceof PDFDict)) continue;
    for (const key of ["Rect", "QuadPoints", "Vertices", "L", "CL"]) {
      const v = d.lookup(PDFName.of(key));
      if (v instanceof PDFArray) d.set(PDFName.of(key), scaleList(v));
    }
    const ink = d.lookup(PDFName.of("InkList"));
    if (ink instanceof PDFArray) d.set(PDFName.of("InkList"), doc.context.obj(ink.asArray().map((p) => { const l = p instanceof PDFRef ? doc.context.lookup(p) : p; return l instanceof PDFArray ? scaleList(l) : p; })));
  }
}

/** 書き換えた行の、大きさ・色・位置・フォントを変えていないか（字だけを入れ替えた書き換え） */
const isUntouched = (e: TextEditObj): boolean =>
  e.font === "original" && !!e.source && Math.abs(e.fontSize - e.source.fontSize) < 1e-6 && e.fillColorOps !== null && Math.abs(e.x - e.source.x) < 1e-6;

/**
 * 墨消しの範囲に掛かる、このアプリで足した部品の扱い（墨消しは元の内容から消すので、足した部品には届かない。
 * そのままだと、塗りの下に文字や画像のデータが残る）：
 * - リンク：範囲に掛かれば外す（行き先の URL を残さない）
 * - 書き換えた行（元の内容の層に書くので、重なりの順に関係なく）・墨消しより下にある文字・画像・スタンプ：
 *   範囲にすっかり入っていれば書かない。一部だけ掛かっていれば、消し残しを作らないよう保存を止めて知らせる
 */
function underRedaction(objects: EditObj[], pageNo: number, rewriteUnchanged: boolean): EditObj[] {
  const redacts = objects.map((o, i) => ({ o, i })).filter((x): x is { o: RedactObj; i: number } => x.o.type === "redact");
  if (!redacts.length) return objects;
  const box = (o: EditObj): { x: number; y: number; w: number; h: number } | null => {
    if (o.type === "line") return { x: Math.min(o.x, o.x + o.dx), y: Math.min(o.y, o.y + o.dy), w: Math.abs(o.dx), h: Math.abs(o.dy) };
    const b = o as { x: number; y: number; w?: number; h?: number };
    return typeof b.w === "number" && typeof b.h === "number" ? { x: b.x, y: b.y, w: b.w, h: b.h } : null;
  };
  const out: EditObj[] = [];
  objects.forEach((o, j) => {
    const kind = o.type;
    const guarded = kind === "link" || kind === "textedit" || kind === "text" || kind === "image" || (kind === "stamp" && o.frame !== "grid");
    const b = guarded ? box(o) : null;
    if (!b) {
      out.push(o);
      return;
    }
    // 編集を始めたが何も変えなかった行は、元の字のまま残る（＝ふつうの墨消しが届く）ので対象にしない
    if (o.type === "textedit" && isUntouched(o) && o.text === o.original && !rewriteUnchanged) {
      out.push(o);
      return;
    }
    let keep: EditObj | null = o;
    for (const r of redacts) {
      // 文字・画像・スタンプは、墨消しより上に置いたもの（墨消しのあとに足した説明の文字など）はそのまま
      if ((kind === "text" || kind === "image" || kind === "stamp") && j > r.i) continue;
      const ox = Math.min(b.x + b.w, r.o.x + r.o.w) - Math.max(b.x, r.o.x);
      const oy = Math.min(b.y + b.h, r.o.y + r.o.h) - Math.max(b.y, r.o.y);
      if (ox <= 0.5 || oy <= 0.5) continue;
      if (kind === "link") {
        keep = null;
        break;
      }
      // すっかり入っている（はみ出しが 1pt 以内、または面積の 9 割以上）
      const inside = (b.x >= r.o.x - 1 && b.y >= r.o.y - 1 && b.x + b.w <= r.o.x + r.o.w + 1 && b.y + b.h <= r.o.y + r.o.h + 1) || (ox * oy) / Math.max(1e-6, b.w * b.h) >= 0.9;
      if (!inside) {
        const what = kind === "textedit" || kind === "text" || kind === "stamp" ? (o as { text: string }).text.replace(/\s+/g, " ").trim().slice(0, 20) : "";
        throw new AppError(tr(kind === "image" ? "redact.overImage" : "redact.overText", { page: pageNo, text: what }));
      }
      // 書き換えた行は、元の字を消すところだけ残して、新しい字を書かない
      keep = kind === "textedit" ? ({ ...o, text: "" } as EditObj) : null;
      break;
    }
    if (keep) out.push(keep);
  });
  return out;
}

/** ページの大きさの変更（scaleTo）で、PDF の座標（ユーザー空間）の x・y に掛かる倍率。変更が無ければ 1 */
function scaleOf(item: PageItem): { ux: number; uy: number } {
  if (!item.scaleTo) return { ux: 1, uy: 1 };
  const M = invert(item.viewTransform);
  const sx = item.scaleTo.width / item.width;
  const sy = item.scaleTo.height / item.height;
  // 表示座標の拡大率を、ユーザー空間の軸に割り当てる（90 度回転したページでは x と y が入れ替わる）
  const swap = Math.abs(M[0]) < 1e-9;
  return { ux: swap ? sy : sx, uy: swap ? sx : sy };
}

function applyCropAndScale(doc: PDFDocument, page: PDFPage, item: PageItem): { ux: number; uy: number } | null {
  const M = invert(item.viewTransform);
  if (item.crop) {
    const c = item.crop;
    const pts = [apply(M, c.x, c.y), apply(M, c.x + c.w, c.y), apply(M, c.x, c.y + c.h), apply(M, c.x + c.w, c.y + c.h)];
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    page.setCropBox(x0, y0, Math.max(...xs) - x0, Math.max(...ys) - y0);
  }
  if (item.scaleTo) {
    const sx = item.scaleTo.width / item.width;
    const sy = item.scaleTo.height / item.height;
    if (Math.abs(sx - 1) > 1e-6 || Math.abs(sy - 1) > 1e-6) {
      // 表示座標の拡大率を、ユーザー空間の軸に割り当てる（90 度回転したページでは x と y が入れ替わる）
      const swap = Math.abs(M[0]) < 1e-9;
      const ux = swap ? sy : sx;
      const uy = swap ? sx : sy;
      const ctx = doc.context;
      const start = ctx.register(ctx.flateStream(`q ${ux} 0 0 ${uy} 0 0 cm\n`));
      const end = ctx.register(ctx.flateStream("\nQ\n"));
      page.node.normalize();
      page.node.wrapContentStreams(start, end);
      // CropBox は無ければ MediaBox が返るので、先に有無を見てから両方を拡大縮小する
      const hadCrop = !!page.node.CropBox();
      const mb = page.getMediaBox();
      const cb = page.getCropBox();
      page.setMediaBox(mb.x * ux, mb.y * uy, mb.width * ux, mb.height * uy);
      if (hadCrop) page.setCropBox(cb.x * ux, cb.y * uy, cb.width * ux, cb.height * uy);
      return { ux, uy };
    }
  }
  return null;
}

/**
 * 変えた部分だけを組み直した内容（anchoredEdit）を、行の最初の命令があった場所に差し込む計画を立てる。
 *
 * ページの最後に書き足すと、その文字は最前面に出る（元は図や半透明の枠の下にあった文字が上に来る、切り抜きが外れる）。
 * 元の場所に差し込めば、重なりの順序も切り抜きも元のままになる。差し込みは「文字の区間をいったん閉じ、状態を保存し、
 * 座標系をページの基準に戻して書き、状態を戻して、文字の区間を開き直す」という形にする。
 * 開き直したあと、行の先頭位置（Tlm）と書き始めの位置（Tm）を元に戻すので、後ろに続く命令は元の位置のままになる。
 *
 * 差し込めない場合（行の命令が複数の部品にまたがる、最初の命令が改行つきの命令、位置を戻せない 等）は null（最後に書き足す）。
 */
function anchoredInPlace(
  out: PDFDocument,
  page: PDFPage,
  item: PageItem,
  o: TextEditObj,
  a: Awaited<ReturnType<typeof analyzePage>>,
  onEditPath?: (how: string, original: string) => void,
  fonts?: Map<FontKey, PDFFont>,
): { removals: TextEditObj["removals"]; after: () => void } | null {
  if (a.error || !o.fontResName || !o.removals.length) return null;
  const show = showForFont(a.shows, o);
  if (!show?.font) return null;
  const path = o.removals[0].path ?? [];
  if (o.removals.some((r) => !samePath(r.path ?? [], path))) return null;
  // 行の命令のうち、内容の中で最初に出てくるもの（そこに差し込む）
  // 書き直した行を差し込む場所。「代わりの文字」の囲み（/Span <</ActualText …>> BDC … EMC）の中に差し込むと、書いた字が
  // すべてその囲みの文字として読まれてしまう（Chrome は、右から左の行のかっこ 1 字ずつをこの囲みに入れる）。囲みの外の命令を選ぶ
  const byIndex = [...o.removals].sort((p, q) => p.index - q.index);
  const showOf = (r: (typeof byIndex)[number]) => a.shows.find((s) => s.index === r.index && samePath(s.path, path));
  const first = byIndex.find((r) => {
    const s = showOf(r);
    return !!s && !s.actual && (s.op === "Tj" || s.op === "TJ");
  }) ?? byIndex[0];
  const host = showOf(first);
  if (!host || (host.op !== "Tj" && host.op !== "TJ") || !host.ctm || !host.tlm || !host.tm || !host.size || !host.hscale) return null;
  // 行の命令の間に、塗り・線・画像などの描画が挟まっていることがある（塗った枠の下と上に、同じ文字を重ねて書いている文書など）。
  // 全部を最初の位置に集めると、あとの分が枠に隠れる。描画で区切ったまとまりごとに、それぞれの場所へ差し込む。
  // まとまりのどれかが単独では行の文字列にならない（重ね書きではなく、行が描画をまたいで続いている）なら、差し込まない
  const stream = path.length ? a.forms.find((f) => samePath(f.path, path))?.ops : a.ops;
  if (!stream) return null;
  const paints = new Set(["f", "F", "f*", "B", "B*", "b", "b*", "S", "s", "sh", "Do", "BI", "EI"]);
  const ordered = [...o.removals].sort((p, q) => p.index - q.index);
  const groups: (typeof ordered)[] = [[ordered[0]]];
  for (let k = 1; k < ordered.length; k++) {
    let split = false;
    for (let i = ordered[k - 1].index + 1; i < ordered[k].index; i++) if (paints.has(stream[i]?.op)) split = true;
    if (split) groups.push([ordered[k]]);
    else groups[groups.length - 1].push(ordered[k]);
  }
  if (groups.length > 1) {
    const parts = groups.map((g) => anchoredInPlace(out, page, item, { ...o, removals: g }, a, undefined, fonts));
    if (parts.some((x) => !x)) return null;
    onEditPath?.("anchored", o.original);
    return { removals: parts.flatMap((x) => x!.removals), after: () => parts.forEach((x) => x!.after()) };
  }
  const det = host.ctm[0] * host.ctm[3] - host.ctm[1] * host.ctm[2];
  if (!(Math.abs(det) > 1e-9)) return null;
  // 書き始めの位置は、行の先頭から文字の進む向きに進んだ所にあるはず（そうでなければ、TJ の数値では戻せない）
  const d = multiplyMatrix(invert(host.tlm), host.tm);
  if (Math.abs(d[0] - 1) > 1e-6 || Math.abs(d[1]) > 1e-6 || Math.abs(d[2]) > 1e-6 || Math.abs(d[3] - 1) > 1e-6 || Math.abs(d[5]) > 1e-4) return null;
  // 差し込む場所では、フォントはその内容（ページ、または部品）での名前で呼べる
  const w = originalWriter(o.fontResName, show.font);
  let reason = "";
  // 変えた語を同梱フォントで書く場合のフォント。ページの直下の内容にだけ使う（部品の中からは、ページのフォントを呼べない）。
  // フォントをページに登録するのは内容を書き換えた後（先にリソースに触ると、内容の並びが変わることがある）なので、名前だけ先に決める
  const key = altKey(o);
  const altFont = path.length ? undefined : fonts?.get(key);
  const altName = altFont ? altResName(page, key) : "";
  const alt = altFont ? altWriter(key, altFont, altName) : null;
  // 右から左へ書く文字の行は、語ごとに別の同梱フォントを使うことがある（アラビア文字・ヘブライ文字・欧文）
  const altUsed = new Map<string, PDFFont>();
  const altFor = (k: FontKey): TextWriter | null => {
    const f = path.length ? undefined : fonts?.get(k);
    if (!f) return null;
    const name = altResName(page, k);
    altUsed.set(name, f);
    return altWriter(k, f, name);
  };
  const content = buildAnchoredContent(item, o, a, show, w, (r) => (reason = r), (s) => s.fontResName, alt, o.rtl ? altFor : undefined);
  if (content === null) return null;
  const mixed = reason === "mixed";
  const inv = invert(host.ctm);
  const num = (v: number) => (Math.abs(v) < 1e-12 ? "0" : v.toFixed(8).replace(/\.?0+$/, ""));
  const mat = (m: number[]) => m.map(num).join(" ");
  const back = Math.abs(d[4]) > 1e-9 ? ` [${fmt((-d[4] / (host.size * host.hscale)) * 1000)}] TJ` : "";
  const block = `ET\nq\n${mat(inv)} cm\n${content}\nQ\nBT\n${mat(host.tlm)} Tm${back}`;
  // 書いた字が対応表に無ければ足す（部品の中のフォントは、ページから引ける名前を作って探す）
  // （ページのリソースに触ると内容の並びが変わることがあるので、内容を書き換えた後で行う）
  const fontName = o.fontResName;
  const after = () => {
    const dictName = path.length ? pageFontForShow(out, page, a.forms, path, fontName) : fontName;
    if (dictName) extendToUnicode(out, page, dictName, w.unmapped);
    if (mixed && o.rtl) for (const [name, f] of altUsed) page.node.setFontDictionary(PDFName.of(name), f.ref);
    else if (mixed && altFont) page.node.setFontDictionary(PDFName.of(altName), altFont.ref);
  };
  onEditPath?.(mixed ? "anchored-mixed" : "anchored", o.original);
  return { after, removals: o.removals.map((r) => (r === first ? { ...r, replacement: r.replacement ? `${block}\n${r.replacement}` : block } : r)) };
}

/**
 * 文書の構造（タグ）を写す。タグが指すページと注釈は、写したページ・注釈を指すように対応付けてから写す
 * （対応付けないと、ページと注釈がもう 1 組複製されてしまう）
 */
function copyStructure(out: PDFDocument, src: PDFDocument, srcIndices: number[], copiedPages: PDFPage[]) {
  const root = src.catalog.get(PDFName.of("StructTreeRoot"));
  if (!root) return;
  const copier = PDFObjectCopier.for(src.context, out.context);
  const mapped = (copier as unknown as { traversedObjects?: Map<PDFObject, PDFObject> }).traversedObjects;
  if (!mapped) return;
  const srcPages = src.getPages();
  srcIndices.forEach((k, i) => {
    const sp = srcPages[k];
    const op = copiedPages[i];
    if (!sp || !op) return;
    mapped.set(sp.ref, op.ref);
    const sa = sp.node.lookup(PDFName.of("Annots"));
    const oa = op.node.lookup(PDFName.of("Annots"));
    if (sa instanceof PDFArray && oa instanceof PDFArray)
      for (let j = 0; j < Math.min(sa.size(), oa.size()); j++) {
        const a = sa.get(j);
        const b = oa.get(j);
        if (a instanceof PDFRef && b instanceof PDFRef) mapped.set(a, b);
      }
  });
  try {
    out.catalog.set(PDFName.of("StructTreeRoot"), copier.copy(root));
    const mark = src.catalog.get(PDFName.of("MarkInfo"));
    if (mark) out.catalog.set(PDFName.of("MarkInfo"), copier.copy(mark));
  } catch {
    out.catalog.delete(PDFName.of("StructTreeRoot"));
  }
}

/**
 * 出力のページにある入力欄（ウィジェット注釈）をたどって、入力欄の一覧（/AcroForm の /Fields）を作り直す。
 * ページを写すと入力欄はページと一緒に写るが、文書の入力欄の一覧（カタログの /AcroForm）は写らないため、
 * そのままでは保存した PDF がフォームとして扱われない。見た目の既定（/DA・/DR）などは元の文書から写す
 */
function rebuildAcroForm(out: PDFDocument, libs: PDFDocument[], first: PDFDocument | undefined) {
  const roots: PDFRef[] = [];
  const seen = new Set<string>();
  for (const page of out.getPages()) {
    const annots = page.node.lookup(PDFName.of("Annots"));
    if (!(annots instanceof PDFArray)) continue;
    for (let i = 0; i < annots.size(); i++) {
      let ref: PDFObject = annots.get(i);
      const first = ref instanceof PDFRef ? out.context.lookup(ref) : ref;
      if (!(first instanceof PDFDict) || first.get(PDFName.of("Subtype")) !== PDFName.of("Widget")) continue;
      let dict: PDFDict = first;
      // いちばん上の入力欄（親を持たないもの）まで上がる
      for (let depth = 0; depth < 20; depth++) {
        const parent: PDFObject | undefined = dict.get(PDFName.of("Parent"));
        const pd: PDFObject | undefined = parent instanceof PDFRef ? out.context.lookup(parent) : undefined;
        if (!(parent instanceof PDFRef) || !(pd instanceof PDFDict)) break;
        ref = parent;
        dict = pd;
      }
      if (!(ref instanceof PDFRef) || seen.has(ref.toString())) continue;
      seen.add(ref.toString());
      roots.push(ref);
    }
  }
  if (!roots.length) return;
  // ページを削った・選んで保存したとき：どのページにも無い欄（/Kids の中の、消えたページの欄）を外す
  const onPage = new Set<string>();
  for (const page of out.getPages()) {
    const annots = page.node.lookup(PDFName.of("Annots"));
    if (annots instanceof PDFArray) for (const a of annots.asArray()) if (a instanceof PDFRef) onPage.add(a.toString());
  }
  const prune = (ref: PDFRef, depth: number): boolean => {
    const d = out.context.lookup(ref);
    if (!(d instanceof PDFDict) || depth > 20) return false;
    const kids = d.lookup(PDFName.of("Kids"));
    if (!(kids instanceof PDFArray)) return onPage.has(ref.toString());
    const keep = kids.asArray().filter((k) => k instanceof PDFRef && prune(k, depth + 1));
    if (keep.length !== kids.size()) d.set(PDFName.of("Kids"), out.context.obj(keep));
    return keep.length > 0 || onPage.has(ref.toString());
  };
  const live = roots.filter((r) => prune(r, 0));
  // ほかの文書と合わせたとき：同じ名前のいちばん上の欄が別々にあると、ビューアは 1 つの欄とみなして値が混ざる。後ろのものに番号を足す
  const names = new Set<string>();
  for (const r of live) {
    const d = out.context.lookup(r);
    const t = d instanceof PDFDict ? d.lookup(PDFName.of("T")) : undefined;
    if (!(d instanceof PDFDict) || !(t instanceof PDFString || t instanceof PDFHexString)) continue;
    const base = t.decodeText();
    let name = base;
    for (let k = 2; names.has(name); k++) name = `${base}_${k}`;
    names.add(name);
    if (name !== base) d.set(PDFName.of("T"), PDFHexString.fromText(name));
  }
  if (!live.length) return;
  const form = out.context.obj({ Fields: live });
  // この保存で作った入力欄（pdf-lib のフォーム）の、見た目の既定（/DA・/DR）はそのまま使う
  const made = out.catalog.lookup(PDFName.of("AcroForm"));
  if (made instanceof PDFDict) for (const key of ["DA", "DR"]) {
    const v = made.get(PDFName.of(key));
    if (v !== undefined) form.set(PDFName.of(key), v);
  }
  // 元の文書の /AcroForm から、見た目の既定（/DA・/DR・/Q）と、見た目を作り直すかの指定（/NeedAppearances）を写す
  const src = [first, ...libs].find((d) => d?.catalog.lookup(PDFName.of("AcroForm")) instanceof PDFDict);
  const old = src?.catalog.lookup(PDFName.of("AcroForm"));
  if (src && old instanceof PDFDict) {
    const copier = PDFObjectCopier.for(src.context, out.context);
    for (const key of ["DA", "DR", "Q", "NeedAppearances"]) {
      const v = old.get(PDFName.of(key));
      if (v !== undefined && form.get(PDFName.of(key)) === undefined) form.set(PDFName.of(key), copier.copy(v));
    }
  }
  // 欄の /DA が使うフォントを、/DR（欄の既定の部品）にそろえる（見た目を作り直すビューアがフォントを見つけられるように）。
  // この保存で作った欄のフォントは、欄の見た目（/AP）の部品にだけ入っているので、そこから写す
  const drFonts = (() => {
    let dr = form.lookup(PDFName.of("DR"));
    if (!(dr instanceof PDFDict)) form.set(PDFName.of("DR"), (dr = out.context.obj({})));
    const drDict = dr as PDFDict;
    let fonts = drDict.lookup(PDFName.of("Font"));
    if (!(fonts instanceof PDFDict)) drDict.set(PDFName.of("Font"), (fonts = out.context.obj({})));
    return fonts as PDFDict;
  })();
  for (const page of out.getPages()) {
    const annots = page.node.lookup(PDFName.of("Annots"));
    if (!(annots instanceof PDFArray)) continue;
    for (const a of annots.asArray()) {
      const w = a instanceof PDFRef ? out.context.lookup(a) : a;
      if (!(w instanceof PDFDict) || w.get(PDFName.of("Subtype")) !== PDFName.of("Widget")) continue;
      let da: PDFObject | undefined = w.lookup(PDFName.of("DA"));
      for (let p = w, depth = 0; !da && depth < 20; depth++) {
        const parent = p.lookup(PDFName.of("Parent"));
        if (!(parent instanceof PDFDict)) break;
        da = parent.lookup(PDFName.of("DA"));
        p = parent;
      }
      const m = da instanceof PDFString || da instanceof PDFHexString ? /\/([^\s/]+)\s+[\d.]+\s+Tf/.exec(da.decodeText()) : null;
      if (!m || drFonts.has(PDFName.of(m[1]))) continue;
      const ap = w.lookup(PDFName.of("AP"));
      const n = ap instanceof PDFDict ? ap.lookup(PDFName.of("N")) : undefined;
      const streams = n instanceof PDFStream ? [n] : n instanceof PDFDict ? n.values().map((v) => (v instanceof PDFRef ? out.context.lookup(v) : v)) : [];
      for (const st of streams) {
        const res = st instanceof PDFStream ? st.dict.lookup(PDFName.of("Resources")) : undefined;
        const f = res instanceof PDFDict ? res.lookup(PDFName.of("Font")) : undefined;
        const font = f instanceof PDFDict ? f.get(PDFName.of(m[1])) : undefined;
        if (font) {
          drFonts.set(PDFName.of(m[1]), font);
          break;
        }
      }
    }
  }
  out.catalog.set(PDFName.of("AcroForm"), out.context.register(form));
}

/**
 * 元の文書のカタログから、開き方の指定を写す：表示の設定（/ViewerPreferences：右から左に読む、など）、ページの並べ方（/PageLayout）、
 * 開いたときに出すもの（/PageMode）、色の基準（/OutputIntents）。withLabels のときはページ番号の振り方（/PageLabels）も。
 * PDF/A などの規格への適合の表示（XMP メタデータ）は写さない（編集した文書が、その規格に合っているとは限らないため）
 */
function inheritCatalog(out: PDFDocument, src: PDFDocument, withLabels: boolean) {
  if (src.isEncrypted) return;
  const copier = PDFObjectCopier.for(src.context, out.context);
  for (const key of ["ViewerPreferences", "PageLayout", "PageMode", "OutputIntents", ...(withLabels ? ["PageLabels"] : [])]) {
    const v = src.catalog.get(PDFName.of(key));
    if (v === undefined || out.catalog.has(PDFName.of(key))) continue;
    try {
      out.catalog.set(PDFName.of(key), copier.copy(v));
    } catch {
      /* 写せないものは、付けない */
    }
  }
}

/** 元の文書の文書情報（タイトル・作成者・サブタイトル・キーワード・作成ソフト・作成日）を、出力に写す。暗号化されたままの文書は写さない */
export function inheritInfo(out: PDFDocument, src: PDFDocument) {
  if (src.isEncrypted) return;
  try {
    const title = src.getTitle();
    const author = src.getAuthor();
    const subject = src.getSubject();
    const keywords = src.getKeywords();
    const creator = src.getCreator();
    const created = src.getCreationDate();
    if (title) out.setTitle(title);
    if (author) out.setAuthor(author);
    if (subject) out.setSubject(subject);
    if (keywords) out.setKeywords([keywords]);
    if (creator) out.setCreator(creator);
    if (created) out.setCreationDate(created);
  } catch {
    /* 読めない文書情報は写さない */
  }
}

/**
 * 元フォントで、元の文書では使っていなかった字を書いたとき、フォントの文字対応表（ToUnicode）に追記する。
 * 追記しないと、書いた字は見えていても検索・コピーで別の字（または無し）になる。
 */
function extendToUnicode(out: PDFDocument, page: PDFPage, resName: string, unmapped: Map<number, string> | undefined) {
  if (!unmapped?.size) return;
  const fonts = page.node.Resources()?.lookup(PDFName.of("Font"));
  const font = fonts instanceof PDFDict ? fonts.lookup(PDFName.of(resName)) : undefined;
  if (!(font instanceof PDFDict)) return;
  const old = decodeStreamBytes(out, font.get(PDFName.of("ToUnicode")));
  if (!old) return; // 対応表を持たないフォントは、表示側が別の方法で文字を決めているので触らない
  const text = Array.from(old, (b) => String.fromCharCode(b)).join("");
  const at = text.lastIndexOf("endcmap");
  if (at < 0) return;
  const h4 = (n: number) => n.toString(16).padStart(4, "0").toUpperCase();
  const lines = [...unmapped].map(([code, ch]) => `<${h4(code)}> <${Array.from({ length: ch.length }, (_, i) => h4(ch.charCodeAt(i))).join("")}>`);
  let add = "";
  for (let i = 0; i < lines.length; i += 100) add += `${Math.min(100, lines.length - i)} beginbfchar\n${lines.slice(i, i + 100).join("\n")}\nendbfchar\n`;
  const next = text.slice(0, at) + add + text.slice(at);
  font.set(PDFName.of("ToUnicode"), out.context.register(out.context.flateStream(Uint8Array.from(next, (c) => c.charCodeAt(0)))));
  unmapped.clear();
}

/** 元フォントで書けないときに使う同梱フォント（指定が無ければ系統とテキストから選ぶ） */
export function fallbackKey(o: TextEditObj): FontKey {
  if (o.font !== "original" && fontDef(o.font)) return o.font;
  return pickFont(o.family, o.text);
}

/** 文字列の中の語（整形の要る字の続き。anchoredEdit が語の切れ目とみなす所で切ったもの）と、空白で区切った語 */
function wordsOf(text: string): string[] {
  const out = new Set(text.split(/\s+/).filter(Boolean));
  let cur = "";
  for (const ch of `${text} `) {
    if (WORDISH.test(ch)) cur += ch;
    else {
      if (cur) out.add(cur);
      cur = "";
    }
  }
  return [...out];
}

/** 変えた語だけを同梱フォントで書くときのフォント：変えた部分（語の切れ目まで広げたもの）の文字で選ぶ */
function altKey(o: TextEditObj): FontKey {
  const changed = changedPart(o).trim() || o.text;
  // 欧文だけの語は、欧文用のフォント（Noto Sans / Serif）があればそれで書く：和文フォントの欧文は字幅が広く、
  // 引用符などが全角の幅になるので、欧文の行に混ぜると不自然になる
  if (!/[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/.test(changed)) {
    const latin = fontList().filter((f) => f.scripts.includes("latin") && !f.scripts.includes("han") && !f.scripts.includes("hangul"));
    const pick = latin.find((f) => f.family === o.family) ?? latin[0];
    if (pick && coverage(pick.id, changed) === 1) return pick.id;
  }
  return pickFont(o.family, changed);
}

/** 変えた部分を、語の切れ目まで広げたもの。広げた分（変えていない字）は、入力するときの字の順に直す（anchoredEdit と同じ） */
function changedPart(o: TextEditObj): string {
  const A = o.original ?? "";
  const B = o.text;
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let q = 0;
  while (q < A.length - p && q < B.length - p && A[A.length - 1 - q] === B[B.length - 1 - q]) q++;
  const p0 = p;
  const q0 = q;
  while (p > 0 && WORDCHAR.test(B[p - 1]) && WORDCHAR.test(B[p] ?? " ")) p--;
  while (q > 0 && WORDCHAR.test(B[B.length - q]) && WORDCHAR.test(B[B.length - q - 1] ?? " ")) q--;
  return visualToLogical(B.slice(p, p0)) + B.slice(p0, B.length - q0) + visualToLogical(B.slice(B.length - q0, B.length - q));
}

/** 同梱フォントの書き手（フォントの登録は呼び出し側で行う）。そのフォントに無い字は書けないと答える */
function altWriter(key: FontKey, font: PDFFont, resName: string): TextWriter {
  return { ...bundledWriter(null, key, font, resName), canWrite: (t) => [...t].every((ch) => /\s/.test(ch) || bundledHasGlyph(key, ch.codePointAt(0)!)) };
}

const altNames = new WeakMap<PDFPage, Map<FontKey, string>>();
/** 同梱フォントをページから呼ぶ名前を決める（そのページでまだ使われていない名前。同じフォントには同じ名前） */
function altResName(page: PDFPage, key: FontKey): string {
  let m = altNames.get(page);
  if (!m) altNames.set(page, (m = new Map()));
  let name = m.get(key);
  if (!name) {
    const fonts = page.node.Resources()?.lookup(PDFName.of("Font"));
    const taken = new Set([...(fonts instanceof PDFDict ? fonts.keys() : []).map((k) => k.decodeText()), ...m.values()]);
    let n = 1;
    while (taken.has(`WashiAlt${n}`)) n++;
    name = `WashiAlt${n}`;
    m.set(key, name);
  }
  return name;
}

/** 実編集の文字を書き込む。元フォントを使う指定でも、書けない文字があれば同梱フォントに切り替える */
async function drawTextEdit(
  out: PDFDocument,
  page: PDFPage,
  item: PageItem,
  o: TextEditObj,
  src: SourceDoc | undefined,
  fonts: Map<FontKey, PDFFont>,
  onWarning?: (m: string) => void,
  onEditPath?: (how: string, original: string) => void,
) {
  if (!o.text.trim()) return;
  let how = o.vertical ? "vertical" : o.font !== "original" ? "bundled-font" : "no-font";
  if (o.vertical) onEditPath?.(how, o.original);
  if (o.vertical) return drawVerticalEdit(out, page, item, o, src, fonts, onWarning);
  let writer: TextWriter | null = null;
  if (o.font === "original" && o.fontResName && src) {
    const a = await analyzePage(src, item.srcIndex);
    const show = showForFont(a.shows, o);
    const resName = show?.path.length ? pageFontForShow(out, page, a.forms, show.path, o.fontResName) : o.fontResName;
    if (show?.font && resName) {
      const w = originalWriter(resName, show.font);
      // 変えた部分だけを組み直せるなら、そうする（変えていない字は元の位置・フォントのまま）
      const formFonts = new Map<string, string | null>();
      const formFont = (s: ShowOp) => {
        const key = `${s.path.join("/")}|${s.fontResName}`;
        if (!formFonts.has(key)) formFonts.set(key, pageFontForShow(out, page, a.forms, s.path, s.fontResName));
        return formFonts.get(key) ?? null;
      };
      const key = altKey(o);
      const altFont = fonts.get(key);
      const altName = altFont ? altResName(page, key) : "";
      const anchored = buildAnchoredContent(item, o, a, show, w, (r) => (how = r), formFont, altFont ? altWriter(key, altFont, altName) : null);
      if (anchored !== null) {
        if (how === "mixed" && altFont) page.node.setFontDictionary(PDFName.of(altName), altFont.ref);
        onEditPath?.(how === "mixed" ? "anchored-appended-mixed" : "anchored-appended", o.original);
        appendContent(out, page, anchored);
        extendToUnicode(out, page, resName, w.unmapped);
        return;
      }
      // 行を丸ごと組み直すとき、タイ文字は元のフォントでは書かない：上下に付く記号の字形と位置を前後の字から決める必要があり、
      // 1 字ずつ既定の字形で並べると記号が重なる。整形のできる同梱フォントで書く
      if (w.canWrite(o.text.replace(/\s/g, "")) && !/[\u0e00-\u0e7f]/.test(o.text)) writer = w;
    }
  }
  if (!writer) {
    const key = fallbackKey(o);
    const font = fonts.get(key);
    if (!font) return;
    writer = bundledWriter(page, key, font);
  }
  onEditPath?.(how, o.original);
  const { layout, content } = buildTextEditContent(item, o, writer);
  extendToUnicode(out, page, writer.resName, writer.unmapped);
  if (layout.overflow) onWarning?.(tr("export.overflowItem", { text: o.original.slice(0, 20), lines: layout.lines.length, max: o.lines }));
  appendContent(out, page, content);
}

/**
 * 元フォントで書き直すときに使う文字描画命令（フォントの情報をここから取る）。
 * 1 行に複数のフォントが混ざっていることがある（本文の中の斜体など）。フォント名（o.fontResName）と、文字コードへの
 * 変換表（命令のフォント情報）は必ず同じフォントのものにする：食い違うと、別のフォントの文字コードで書いて文字化けする。
 */
function showForFont(shows: ShowOp[], o: TextEditObj): ShowOp | undefined {
  const mine = o.removals.map((r) => shows.find((s) => s.index === r.index && samePath(s.path, r.path) && s.font)).filter((s): s is ShowOp => !!s);
  return mine.find((s) => s.fontResName === o.fontResName);
}

/** 縦書きの実編集：元の縦書きフォントが使えればそのまま、無ければ同梱フォントで 1 文字ずつ積む。列は箱の高さで折り返し、列数を超えれば縮小する */
async function drawVerticalEdit(out: PDFDocument, page: PDFPage, item: PageItem, o: TextEditObj, src: SourceDoc | undefined, fonts: Map<FontKey, PDFFont>, onWarning?: (m: string) => void) {
  const cx = o.x + o.w - o.fontSize / 2;
  const warn = (layout: { lines: string[]; overflow: boolean }) => {
    if (layout.overflow) onWarning?.(tr("export.overflowItem", { text: o.original.slice(0, 20), lines: layout.lines.length, max: o.lines }));
  };
  if (o.font === "original" && o.fontResName && src) {
    const a = await analyzePage(src, item.srcIndex);
    const show = showForFont(a.shows, o);
    const resName = show?.path.length ? pageFontForShow(out, page, a.forms, show.path, o.fontResName) : o.fontResName;
    if (show?.font?.vertical && resName) {
      const w = originalWriter(resName, show.font);
      if (w.canWrite(o.text.replace(/\s/g, ""))) {
        const layout = layoutVertical(o.text, o.fontSize, o.h, o.lines, verticalFontMeasurer);
        warn(layout);
        const colorOps = o.fillColorOps ?? `${colorTriple(o.color).map((v) => fmt(v)).join(" ")} rg`;
        appendContent(out, page, verticalColumnsContent(item, w, layout.lines, { cx, top: o.y, fontSize: layout.fontSize, pitch: o.lineHeight, colorOps }));
        // 元の文書で使っていなかった字は、文字の対応表に足す（横書きと同じ。足さないと検索・コピーで別の字になる）
        extendToUnicode(out, page, resName, w.unmapped);
        return;
      }
    }
  }
  const key = fallbackKey(o);
  const font = fonts.get(key);
  if (!font) return;
  const layout = layoutVertical(o.text, o.fontSize, o.h, o.lines, verticalMeasurer(key));
  warn(layout);
  drawVerticalColumns(page, item, key, font, layout.lines, { cx, top: o.y, fontSize: layout.fontSize, pitch: o.lineHeight, color: colorTriple(o.color) });
}

async function drawObject(
  page: PDFPage,
  item: PageItem,
  o: EditObj,
  fonts: Map<FontKey, PDFFont>,
  getImage: (id: string) => Promise<PDFImage>,
) {
  // 表示座標 → PDF座標
  const M = invert(item.viewTransform);
  const rotDeg = (Math.atan2(M[1], M[0]) * 180) / Math.PI;
  const rot = degrees(rotDeg);
  const P = (x: number, y: number) => {
    const [px, py] = apply(M, x, y);
    return { x: px, y: py };
  };

  switch (o.type) {
    case "text": {
      const font = fonts.get(o.font);
      if (!font) return;
      if (o.vertical) {
        const pitch = o.fontSize * LINE_HEIGHT;
        drawVerticalColumns(page, item, o.font, font, verticalColumns(o.text, Infinity), { cx: o.x + pitch / 2, top: o.y, fontSize: o.fontSize, pitch, color: colorTriple(o.color) });
        return;
      }
      const lines = o.text.split("\n");
      // 表示上の時計回りは、上下反転した PDF 座標では反時計回りの負の角度になる
      const t = ((o.rotation ?? 0) * Math.PI) / 180;
      const sin = Math.sin(t);
      const cos = Math.cos(t);
      lines.forEach((line, i) => {
        if (!line) return;
        const off = baselineOffset(o.fontSize, i);
        const pt = P(o.x - off * sin, o.y + off * cos);
        const angle = rotDeg - (o.rotation ?? 0);
        // 主のフォントに無い字（アラビア語の中の日本語など）は、その字を持つ同梱フォントで書く。区間を左から順に並べる
        // （右から左へ書く文字で始まる行は、区間の並びを逆にする：先頭の区間が右端に来る）
        let runs = fontRuns(o.font, line).filter((r) => fonts.has(r.key));
        const rtl = /^[^\p{L}]*[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/u.test(line);
        if (runs.length < 2) runs = [{ key: o.font, text: line }];
        else if (rtl) runs = [...runs].reverse();
        const mixed = runs.length > 1;
        const spaceW = measureBundled(o.font, " ", o.fontSize);
        let adv = 0;
        const a = (angle * Math.PI) / 180;
        for (const r of runs) {
          const f = fonts.get(r.key)!;
          // 区間の端の空白は、区間の中で整形しない（右から左の区間では、末尾の空白が左側へ回ってしまう）。幅だけ空ける
          const lead = mixed ? /^\s*/.exec(r.text)![0].length : 0;
          const core = mixed ? r.text.trim() : r.text;
          const trail = mixed ? r.text.length - lead - core.length : 0;
          adv += (rtl ? trail : lead) * spaceW;
          if (core) {
            const at = { x: pt.x + adv * Math.cos(a), y: pt.y + adv * Math.sin(a) };
            if (!drawTextMaybeShaped(page, r.key, f, core, { ...at, size: o.fontSize, color: o.color, rotateDeg: angle, base: mixed ? (rtl ? "R" : "L") : undefined })) page.drawText(core, { ...at, size: o.fontSize, font: f, color: color(o.color), rotate: degrees(angle) });
            adv += measureBundled(r.key, core, o.fontSize);
          }
          adv += (rtl ? lead : trail) * spaceW;
        }
      });
      return;
    }
    case "imageedit":
      return; // 元の描画命令を消すだけ
    case "redact": {
      const pt = P(o.x, o.y + o.h);
      page.drawRectangle({ ...pt, width: o.w, height: o.h, rotate: rot, color: color(o.fill) });
      return;
    }
    // 四角（枠と塗り）と白塗りは同じ描き方
    case "rect":
    case "whiteout": {
      const pt = P(o.x, o.y + o.h);
      page.drawRectangle({
        ...pt,
        width: o.w,
        height: o.h,
        rotate: rot,
        color: color(o.fill),
        borderColor: color(o.stroke),
        borderWidth: o.stroke ? o.strokeWidth : 0,
        opacity: o.opacity,
        borderOpacity: o.opacity,
      });
      return;
    }
    case "ellipse": {
      const c = P(o.x + o.w / 2, o.y + o.h / 2);
      page.drawEllipse({
        ...c,
        xScale: o.w / 2,
        yScale: o.h / 2,
        rotate: rot,
        color: color(o.fill),
        borderColor: color(o.stroke),
        borderWidth: o.stroke ? o.strokeWidth : 0,
        opacity: o.opacity,
        borderOpacity: o.opacity,
      });
      return;
    }
    case "line": {
      page.drawLine({
        start: P(o.x, o.y),
        end: P(o.x + o.dx, o.y + o.dy),
        thickness: o.strokeWidth,
        color: color(o.stroke),
        opacity: o.opacity,
        lineCap: LineCapStyle.Round,
      });
      return;
    }
    case "image": {
      const img = await getImage(o.imageId);
      const pt = P(o.x, o.y + o.h);
      page.drawImage(img, { ...pt, width: o.w, height: o.h, rotate: rot, opacity: o.opacity });
      return;
    }
    case "stamp": {
      const font = fonts.get(o.font);
      if (!font) return;
      // 枠（角丸の代わりに太めの線）と中央揃えの文字。回転は箱の中心を軸にする
      const t = (-o.rotation * Math.PI) / 180;
      const cx = o.x + o.w / 2;
      const cy = o.y + o.h / 2;
      const rotPt = (lx: number, ly: number) => {
        const dx = lx - cx;
        const dy = ly - cy;
        return P(cx + dx * Math.cos(t) + dy * Math.sin(t), cy - dx * Math.sin(t) + dy * Math.cos(t));
      };
      const bw = Math.max(1, o.fontSize * 0.12);
      const angle = degrees(rotDeg + o.rotation);
      const frame = o.frame ?? "rect";
      const drawFrame = (inset: number) => {
        if (frame === "none") return;
        if (frame === "ellipse") {
          const ec = rotPt(cx, cy);
          page.drawEllipse({ x: ec.x, y: ec.y, xScale: Math.max(1, o.w / 2 - inset), yScale: Math.max(1, o.h / 2 - inset), rotate: angle, borderColor: color(o.color), borderWidth: bw, borderOpacity: o.opacity });
        } else {
          const corner = rotPt(o.x + inset, o.y + o.h - inset);
          page.drawRectangle({ ...corner, width: Math.max(1, o.w - inset * 2), height: Math.max(1, o.h - inset * 2), rotate: angle, borderColor: color(o.color), borderWidth: bw, opacity: 0, borderOpacity: o.opacity });
        }
      };
      if (frame === "grid") {
        // 承認欄：外枠・見出しの下の線・欄の区切りの線と、欄ごとに中央にそろえた見出し（入らなければ縮める）
        const l = approvalLayout(o);
        const line = (x1: number, y1: number, x2: number, y2: number) => page.drawLine({ start: rotPt(x1, y1), end: rotPt(x2, y2), thickness: l.line, color: color(o.color), opacity: o.opacity });
        line(o.x, o.y, o.x + o.w, o.y);
        line(o.x, o.y + o.h, o.x + o.w, o.y + o.h);
        line(o.x, o.y + l.header, o.x + o.w, o.y + l.header);
        for (let i = 0; i <= l.titles.length; i++) line(o.x + i * l.col, o.y, o.x + i * l.col, o.y + o.h);
        l.titles.forEach((title, i) => {
          if (!title) return;
          const size = Math.min(o.fontSize, (o.fontSize * l.col * 0.88) / Math.max(1e-6, font.widthOfTextAtSize(title, o.fontSize)));
          const tw = font.widthOfTextAtSize(title, size);
          const tx = o.x + i * l.col + (l.col - tw) / 2;
          const ty = o.y + l.header / 2 + size * 0.36;
          if (!drawTextMaybeShaped(page, o.font, font, title, { ...rotPt(tx, ty), size, color: o.color, opacity: o.opacity, rotateDeg: angle.angle }))
            page.drawText(title, { ...rotPt(tx, ty), size, font, color: color(o.color), opacity: o.opacity, rotate: angle });
        });
        return;
      }
      drawFrame(0);
      if (o.double && frame !== "none") drawFrame(Math.max(1.5, bw * 1.1) + bw);
      const tw = font.widthOfTextAtSize(o.text, o.fontSize);
      const tx = o.x + (o.w - tw) / 2;
      const ty = o.y + o.h / 2 + o.fontSize * 0.36;
      if (!drawTextMaybeShaped(page, o.font, font, o.text, { ...rotPt(tx, ty), size: o.fontSize, color: o.color, opacity: o.opacity, rotateDeg: angle.angle }))
        page.drawText(o.text, { ...rotPt(tx, ty), size: o.fontSize, font, color: color(o.color), opacity: o.opacity, rotate: angle });
      return;
    }
    default:
      return;
  }
}

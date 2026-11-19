import type { SecurityInfo } from "./security";
import type { PDFDocumentProxy } from "pdfjs-dist";

/** 6要素のアフィン行列 [a, b, c, d, e, f] */
export type Matrix = [number, number, number, number, number, number];

/** 読み込んだ元PDF（変更不可・追記のみ） */
export interface SourceDoc {
  id: string;
  name: string;
  /** pdf-lib 用の元バイト列（pdf.js には複製を渡す） */
  bytes: Uint8Array;
  pdf: PDFDocumentProxy;
  pageCount: number;
  /** 元ファイルがパスワード保護されていた場合、その内容（読み込み時に解除済み） */
  security?: SecurityInfo | null;
  /** 電子署名が付いている（編集して保存すると無効になる） */
  signed?: boolean;
}

/** 同梱フォントの id（assets/fonts/fonts.json）。例 "gothic", "mincho", "notosans" */
export type FontKey = string;

interface ObjBase {
  id: string;
  /** 表示座標（pt、左上原点、元ページの /Rotate を適用した向き） */
  x: number;
  y: number;
}

export interface TextObj extends ObjBase {
  type: "text";
  /** 縦書き（x,y は右端の列の左上。列は左へ増える） */
  vertical?: boolean;
  text: string;
  fontSize: number;
  font: FontKey;
  color: string;
  /** 回転角（度、時計回り）。左上 (x, y) を中心に回す */
  rotation?: number;
}

export interface ShapeObj extends ObjBase {
  type: "rect" | "ellipse" | "whiteout";
  w: number;
  h: number;
  stroke: string | null;
  fill: string | null;
  strokeWidth: number;
  opacity: number;
}

export interface LineObj extends ObjBase {
  type: "line";
  /** 終点 = (x + dx, y + dy) */
  dx: number;
  dy: number;
  stroke: string;
  strokeWidth: number;
  opacity: number;
}

export interface ImageObj extends ObjBase {
  type: "image";
  w: number;
  h: number;
  imageId: string;
  opacity: number;
}

/** 注釈：ハイライト・下線・取り消し線（保存時は本物の PDF 注釈になる） */
export interface MarkupObj extends ObjBase {
  type: "markup";
  kind: "highlight" | "underline" | "strikeout";
  w: number;
  h: number;
  color: string;
  opacity: number;
  /** コメント（注釈のポップアップに入る） */
  contents: string;
  /** 作者（注釈の一覧に出る。文書の比較の書き出しなどで付ける） */
  author?: string;
}

/** 付箋（Text 注釈） */
export interface NoteObj extends ObjBase {
  type: "note";
  color: string;
  contents: string;
  author: string;
}

/** 手書き（Ink 注釈）。points は (x, y) を基準にした相対座標 */
export interface InkObj extends ObjBase {
  type: "ink";
  paths: [number, number][][];
  w: number;
  h: number;
  stroke: string;
  strokeWidth: number;
  opacity: number;
}

/** スタンプの枠の形 */
/** grid は承認欄（役職の見出しと押印欄。text に見出しを「,」区切りで入れる。lib/approval.ts） */
export type StampFrame = "none" | "rect" | "ellipse" | "grid";

/** スタンプ（枠付きの文字。内容として描く） */
export interface StampObj extends ObjBase {
  type: "stamp";
  text: string;
  w: number;
  h: number;
  color: string;
  font: FontKey;
  fontSize: number;
  /** 回転角（度、時計回り） */
  rotation: number;
  opacity: number;
  /** 枠の形。無指定は四角（後方互換） */
  frame?: StampFrame;
  /** 二重枠（印鑑風） */
  double?: boolean;
}

/** 既存画像の削除（差し替えは「削除＋同じ位置に新しい画像」で表す） */
export interface ImageEditObj extends ObjBase {
  type: "imageedit";
  /** 元のコンテンツストリーム内の Do（または BI）命令の番号 */
  opIndex: number;
  /** 命令が属するストリーム（Form XObject の中なら Do 命令の index の列） */
  path?: number[];
  name: string;
  w: number;
  h: number;
}

/** 墨消し：範囲に掛かる文字・画像のデータを取り除き、図形は見えなくしてから塗りつぶす */
export interface RedactObj extends ObjBase {
  type: "redact";
  w: number;
  h: number;
  fill: string;
}

/** リンク（押すと URL を開く、または文書の中のページへ移る範囲）。保存すると PDF のリンク注釈になる */
export interface LinkObj extends ObjBase {
  type: "link";
  w: number;
  h: number;
  target: { kind: "url"; url: string } | { kind: "page"; pageId: string };
}

/**
 * フォームの入力欄（保存すると PDF の入力欄になる）。kind：文字（1 行）・文字（複数行）・チェックボックス・選択肢（ドロップダウン）・
 * ラジオボタン（同じ名前の欄が 1 つの組になり、value が選んだときの値）・日付（文字の欄に、書き方の説明を付ける）・署名欄
 */
export interface FieldObj extends ObjBase {
  type: "field";
  kind: "text" | "multiline" | "checkbox" | "dropdown" | "radio" | "date" | "signature";
  /** ラジオボタンの、この選択肢の値 */
  value?: string;
  /** 入力欄の名前（文書の中で重ならないようにする） */
  name: string;
  w: number;
  h: number;
  /** 選択肢（ドロップダウン） */
  options: string[];
}

/**
 * 計測：距離（2 点）または面積（3 点以上の多角形）。点は (x, y) からの相対位置（pt）。
 * scale は縮尺の分母（1:100 なら 100）。表示と保存では、紙の上の長さに縮尺を掛けた実寸を unit で出す
 */
export interface MeasureObj extends ObjBase {
  type: "measure";
  kind: "distance" | "area";
  pts: [number, number][];
  w: number;
  h: number;
  scale: number;
  unit: "mm" | "cm" | "m";
  color: string;
}

export type EditObj = TextObj | ShapeObj | LineObj | ImageObj | TextEditObj | MarkupObj | NoteObj | InkObj | StampObj | ImageEditObj | RedactObj | LinkObj | FieldObj | MeasureObj;

/** 出力するページ1枚分 */
export interface PageItem {
  id: string;
  /** null なら白紙ページ */
  srcId: string | null;
  srcIndex: number;
  /** 元ページの /Rotate */
  baseRotation: number;
  /** ユーザーが追加した回転（0/90/180/270） */
  extraRotation: number;
  /** 元の向き（baseRotation 適用後）での表示サイズ（pt） */
  width: number;
  height: number;
  /** PDF座標 → 表示座標（scale 1） */
  viewTransform: Matrix;
  objects: EditObj[];
  /** トリミング（元の向きの表示座標、pt）。無ければページ全体 */
  crop?: { x: number; y: number; w: number; h: number };
  /**
   * 元の PDF のリンクを、編集できる部品（LinkObj）として読み込んだ。値は読み込んだリンクの元の参照（pdf.js の注釈 id）。
   * 保存するときは、そのリンクだけを外して部品から作り直す（読み込めなかったリンクは元のまま残す）。true は古い形式
   */
  linksImported?: boolean | string[];
  /** 出力時のページサイズ（元の向きの表示座標、pt）。無ければそのまま */
  scaleTo?: { width: number; height: number };
}

/** 履歴の対象となる文書全体の状態 */
export interface Doc {
  pages: PageItem[];
  settings: import("./docOps").DocSettings;
}

export interface StoredImage {
  id: string;
  bytes: Uint8Array;
  mime: "image/png" | "image/jpeg";
  url: string;
  width: number;
  height: number;
}

export type Tool =
  | "measure"
  | "field"
  | "link"
  | "select"
  | "text"
  | "edit-text"
  | "rect"
  | "ellipse"
  | "line"
  | "whiteout"
  | "highlight"
  | "underline"
  | "strikeout"
  | "note"
  | "ink"
  | "stamp"
  | "redact"
  | "image-edit";

/** 既存テキストの実編集：元の文字描画命令を消し、新しい文字を書く */
export interface TextEditObj extends ObjBase {
  type: "textedit";
  /** 消す命令（コンテンツストリーム内の命令番号と、確認用の命令名、置き換え文字列） */
  /** 消す命令。path はその命令が属するストリーム（ページなら空、Form XObject なら Do 命令の index の列） */
  removals: { index: number; op: string; replacement: string; path?: number[] }[];
  /** 元の文字列 */
  original: string;
  /** 新しい文字列（改行は段落編集時のみ） */
  text: string;
  /** 元のテキストブロックの幅・高さ（表示座標 pt） */
  w: number;
  h: number;
  /** 1行目のベースライン（表示座標 y） */
  baseline: number;
  /** 行送り（複数行ブロックのとき。単一行なら fontSize × 1.2 相当） */
  lineHeight: number;
  /** 元の行数（この行数に収める） */
  lines: number;
  fontSize: number;
  /** 書き込みに使うフォント。"original" は元 PDF のフォントを再利用 */
  font: FontKey | "original";
  /** 作ったときの位置と大きさ（1 行の書き換えのみ）。動かした量・大きさを変えたかどうかを知るために持つ。room は字を足して広げてよい幅（段落の右端まで） */
  source?: { x: number; baseline: number; fontSize: number; room: number; roomLeft?: number };
  /**
   * 段落（複数行）の書き換えのとき、行ごとの情報。保存時に「変えた行だけ」を書き直すのに使う（blockEdit.ts）。
   * origin は作ったときの位置と大きさ（動かしたり大きさを変えたりしたら、行ごとには分けない）
   */
  parts?: {
    text: string;
    x: number;
    top: number;
    w: number;
    h: number;
    baseline: number;
    fontSize: number;
    fontResName: string | null;
    removals: { index: number; op: string; replacement: string; path?: number[] }[];
    fillColorOps: string | null;
    strokeColorOps: string | null;
    renderMode: number;
    charSpacing: number;
    wordSpacing: number;
    hscale: number;
    previewFont?: string;
  }[];
  origin?: { x: number; y: number; fontSize: number };
  /** 表示側でのフォントの登録名（編集中の画面表示を、埋め込みフォントそのもので行うため） */
  previewFont?: string;
  /** 元フォントのリソース名（"original" のとき） */
  fontResName: string | null;
  /** 元フォントで新しい文字を書ける見込みがあるか（無い文字は保存時に同梱フォントへ切り替わる） */
  originalUsable: boolean;
  /**
   * 前後の字で形が変わる文字（インド系など）や、何の字か分からない字形を含む行。行の文字列は字形の並びのままで、
   * 打ち直しても同じ形にはならないので、変えた語だけを同梱フォントで書き、ほかは元の字形のまま残す方法でだけ書き換える
   */
  complex?: boolean;
  /** 右から左へ書く文字（アラビア系・ヘブライ）を含む行の、行の向き。文字列は語を読む順に並べたもので、語の単位で書き換える（complex でもある） */
  rtl?: "R" | "L";
  /** 元フォント名（表示用） */
  srcFontName: string;
  /** 元フォントの系統（代替フォントを選ぶときの基準） */
  family: "sans" | "serif";
  /** 表示用の文字色 */
  color: string;
  /** 元の色をそのまま再現する命令列（例 "0 0 1 rg"）。null なら color から作る */
  fillColorOps: string | null;
  strokeColorOps: string | null;
  renderMode: number;
  charSpacing: number;
  wordSpacing: number;
  hscale: number;
  /** 揃え */
  align: "left" | "center" | "right";
  /** 画面プレビューで元の文字を隠す色（保存時には使わない） */
  cover: string;
  /** 縦書き（x,y,w,h は右端の列の箱。列は lineHeight の間隔で左へ増える） */
  vertical?: boolean;
}

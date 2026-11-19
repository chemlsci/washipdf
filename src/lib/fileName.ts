/**
 * ファイル名の無害化。文書の中の名前（添付ファイル・しおりの題名・元のファイル名）や利用者の入力を、
 * ダウンロードするファイルや ZIP の中のファイルの名前にする前に、必ずここを通す。
 */

/** 文字の並びの向きを変える制御文字（"exe.pdf" を "fdp.exe" のように見せかけられる） */
const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/g;
/** 制御文字（改行・タブ・NUL など） */
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
/** 相手のいないサロゲート（壊れた文字） */
const LONE_SURROGATES = /\p{Cs}/gu;
/** フォルダーの区切りと、Windows で名前に使えない記号 */
const PATH_CHARS = /[\\/:*?"<>|]/g;
/** Windows が特別扱いする名前（拡張子が付いていても開けない・作れない） */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

/**
 * ファイル名として安全な文字列にする：
 * - フォルダーの区切り（/ \）と使えない記号は "_" に、制御文字と向きを変える制御文字は取り除く
 * - 先頭の "."（隠しファイル・".." で上のフォルダーを指す名前）と、末尾の "." や空白を取り除く
 * - Windows が特別扱いする名前（CON・NUL など）は、先頭に "_" を付ける
 * - 長すぎる名前は、拡張子を残して切り詰める
 * 何も残らなければ fallback を返す
 */
export function safeFileName(input: unknown, fallback = "file", maxLength = 120): string {
  let s = typeof input === "string" ? input : "";
  s = s
    .replace(BIDI_CONTROLS, "")
    .replace(CONTROLS, " ")
    .replace(LONE_SURROGATES, "")
    .replace(PATH_CHARS, "_")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");
  const chars = [...s];
  if (chars.length > maxLength) {
    const ext = /\.[A-Za-z0-9]{1,10}$/.exec(s)?.[0] ?? "";
    s = chars.slice(0, Math.max(1, maxLength - ext.length)).join("").replace(/[.\s]+$/, "") + ext;
  }
  if (RESERVED.test(s)) s = `_${s}`;
  return s || fallback;
}

/** 名前の重複を避ける：すでに使われている名前なら、拡張子の前に連番を付ける（大文字・小文字の違いは同じ名前とみなす） */
export function uniqueFileName(name: string, used: Set<string>): string {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let out = name;
  for (let k = 2; used.has(out.toLowerCase()); k++) out = `${base} (${k})${ext}`;
  used.add(out.toLowerCase());
  return out;
}

/**
 * 画面に出すための名前：文字の向きを変える制御文字を取り除く（「…\u202Efdp.exe」が「…exe.pdf」に見えるようなすり替えを防ぐ）。
 * 名前そのもの（保存するファイル名など）は変えない
 */
export function displayName(name: string): string {
  return String(name ?? "").replace(BIDI_CONTROLS, "");
}

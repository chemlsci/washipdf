/**
 * 単純フォント（Type1 / TrueType）のエンコーディング表と、グリフ名 → Unicode の最小限の対応。
 * 標準14フォントの幅引き（AFM）と、元フォントで新しい文字が書けるかの判定に使う。
 */
import { Encodings } from "@pdf-lib/standard-fonts";

const ASCII_NAMES =
  "space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore grave a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde".split(
    " ",
  );

function fromAscii(): (string | null)[] {
  const t: (string | null)[] = new Array(256).fill(null);
  ASCII_NAMES.forEach((n, i) => (t[32 + i] = n));
  return t;
}

export const STANDARD_ENCODING: (string | null)[] = (() => {
  const t = fromAscii();
  t[39] = "quoteright";
  t[96] = "quoteleft";
  const high: [number, string][] = [
    [161, "exclamdown"], [162, "cent"], [163, "sterling"], [164, "fraction"], [165, "yen"], [166, "florin"], [167, "section"],
    [168, "currency"], [169, "quotesingle"], [170, "quotedblleft"], [171, "guillemotleft"], [172, "guilsinglleft"], [173, "guilsinglright"],
    [174, "fi"], [175, "fl"], [177, "endash"], [178, "dagger"], [179, "daggerdbl"], [180, "periodcentered"], [182, "paragraph"],
    [183, "bullet"], [184, "quotesinglbase"], [185, "quotedblbase"], [186, "quotedblright"], [187, "guillemotright"], [188, "ellipsis"],
    [189, "perthousand"], [191, "questiondown"], [193, "grave"], [194, "acute"], [195, "circumflex"], [196, "tilde"], [197, "macron"],
    [198, "breve"], [199, "dotaccent"], [200, "dieresis"], [202, "ring"], [203, "cedilla"], [205, "hungarumlaut"], [206, "ogonek"],
    [207, "caron"], [208, "emdash"], [225, "AE"], [227, "ordfeminine"], [232, "Lslash"], [233, "Oslash"], [234, "OE"], [235, "ordmasculine"],
    [241, "ae"], [245, "dotlessi"], [248, "lslash"], [249, "oslash"], [250, "oe"], [251, "germandbls"],
  ];
  for (const [c, n] of high) t[c] = n;
  return t;
})();

export const MAC_ROMAN_ENCODING: (string | null)[] = (() => {
  const t = fromAscii();
  const high =
    "Adieresis Aring Ccedilla Eacute Ntilde Odieresis Udieresis aacute agrave acircumflex adieresis atilde aring ccedilla eacute egrave ecircumflex edieresis iacute igrave icircumflex idieresis ntilde oacute ograve ocircumflex odieresis otilde uacute ugrave ucircumflex udieresis dagger degree cent sterling section bullet paragraph germandbls registered copyright trademark acute dieresis notequal AE Oslash infinity plusminus lessequal greaterequal yen mu partialdiff summation product pi integral ordfeminine ordmasculine Omega ae oslash questiondown exclamdown logicalnot radical florin approxequal Delta guillemotleft guillemotright ellipsis space Agrave Atilde Otilde OE oe endash emdash quotedblleft quotedblright quoteleft quoteright divide lozenge ydieresis Ydieresis fraction currency guilsinglleft guilsinglright fi fl daggerdbl periodcentered quotesinglbase quotedblbase perthousand Acircumflex Ecircumflex Aacute Edieresis Egrave Iacute Icircumflex Idieresis Igrave Oacute Ocircumflex apple Ograve Uacute Ucircumflex Ugrave dotlessi circumflex tilde macron breve dotaccent ring cedilla hungarumlaut ogonek caron".split(
      " ",
    );
  high.forEach((n, i) => (t[128 + i] = n));
  return t;
})();

export const WIN_ANSI_ENCODING: (string | null)[] = (() => {
  const t: (string | null)[] = new Array(256).fill(null);
  const enc = Encodings.WinAnsi;
  for (const cp of enc.supportedCodePoints) {
    const { code, name } = enc.encodeUnicodeCodePoint(cp);
    if (t[code] == null) t[code] = name;
  }
  // 未定義領域は bullet（Acrobat の挙動に合わせる）
  for (const c of [127, 129, 141, 143, 144, 157]) if (t[c] == null) t[c] = "bullet";
  t[160] = "space";
  t[173] = "hyphen";
  return t;
})();

/** グリフ名 → Unicode コードポイント（AGL の必要部分） */
const GLYPH_TO_UNICODE: Map<string, number> = (() => {
  const m = new Map<string, number>();
  const enc = Encodings.WinAnsi;
  for (const cp of enc.supportedCodePoints) {
    const { name } = enc.encodeUnicodeCodePoint(cp);
    if (!m.has(name)) m.set(name, cp);
  }
  const extra: [string, number][] = [
    ["space", 0x20], ["quotesingle", 0x27], ["grave", 0x60], ["quoteleft", 0x2018], ["quoteright", 0x2019], ["fraction", 0x2044],
    ["fi", 0xfb01], ["fl", 0xfb02], ["dotlessi", 0x131], ["Lslash", 0x141], ["lslash", 0x142], ["notequal", 0x2260],
    ["infinity", 0x221e], ["lessequal", 0x2264], ["greaterequal", 0x2265], ["partialdiff", 0x2202], ["summation", 0x2211],
    ["product", 0x220f], ["pi", 0x3c0], ["integral", 0x222b], ["Omega", 0x3a9], ["radical", 0x221a], ["approxequal", 0x2248],
    ["Delta", 0x2206], ["lozenge", 0x25ca], ["apple", 0xf8ff], ["breve", 0x2d8], ["dotaccent", 0x2d9], ["ring", 0x2da],
    ["ogonek", 0x2db], ["caron", 0x2c7], ["hungarumlaut", 0x2dd], ["minus", 0x2212], ["bullet", 0x2022], ["Euro", 0x20ac],
    ["nbspace", 0xa0], ["sfthyphen", 0xad], ["middot", 0xb7], ["periodcentered", 0xb7], ["mu", 0xb5], ["hyphen", 0x2d],
    ["endash", 0x2013], ["emdash", 0x2014], ["ellipsis", 0x2026], ["trademark", 0x2122], ["dagger", 0x2020], ["daggerdbl", 0x2021],
    ["perthousand", 0x2030], ["quotedblleft", 0x201c], ["quotedblright", 0x201d], ["quotesinglbase", 0x201a], ["quotedblbase", 0x201e],
    ["guilsinglleft", 0x2039], ["guilsinglright", 0x203a], ["florin", 0x192], ["circumflex", 0x2c6], ["tilde", 0x2dc],
    ["Scaron", 0x160], ["scaron", 0x161], ["Zcaron", 0x17d], ["zcaron", 0x17e], ["OE", 0x152], ["oe", 0x153], ["Ydieresis", 0x178],
    ["yen", 0xa5], ["currency", 0xa4], ["section", 0xa7], ["paragraph", 0xb6], ["degree", 0xb0], ["plusminus", 0xb1],
    ["multiply", 0xd7], ["divide", 0xf7], ["logicalnot", 0xac], ["registered", 0xae], ["copyright", 0xa9], ["macron", 0xaf],
    ["acute", 0xb4], ["dieresis", 0xa8], ["cedilla", 0xb8], ["brokenbar", 0xa6], ["cent", 0xa2], ["sterling", 0xa3],
    ["exclamdown", 0xa1], ["questiondown", 0xbf], ["ordfeminine", 0xaa], ["ordmasculine", 0xba], ["guillemotleft", 0xab],
    ["guillemotright", 0xbb], ["onequarter", 0xbc], ["onehalf", 0xbd], ["threequarters", 0xbe], ["onesuperior", 0xb9],
    ["twosuperior", 0xb2], ["threesuperior", 0xb3], ["AE", 0xc6], ["ae", 0xe6], ["Oslash", 0xd8], ["oslash", 0xf8],
    ["germandbls", 0xdf], ["Thorn", 0xde], ["thorn", 0xfe], ["Eth", 0xd0], ["eth", 0xf0],
  ];
  for (const [n, cp] of extra) if (!m.has(n)) m.set(n, cp);
  return m;
})();

export function glyphNameToUnicode(name: string): number | null {
  const direct = GLYPH_TO_UNICODE.get(name);
  if (direct != null) return direct;
  let m = /^uni([0-9A-Fa-f]{4})/.exec(name);
  if (m) return parseInt(m[1], 16);
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) return parseInt(m[1], 16);
  // "a123" 形式などは不明
  if (name.length === 1) return name.codePointAt(0)!;
  return null;
}

export function baseEncodingByName(name: string | null): (string | null)[] | null {
  switch (name) {
    case "WinAnsiEncoding":
      return WIN_ANSI_ENCODING;
    case "MacRomanEncoding":
      return MAC_ROMAN_ENCODING;
    case "StandardEncoding":
    case "MacExpertEncoding":
      return STANDARD_ENCODING;
    default:
      return null;
  }
}

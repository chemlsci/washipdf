// 配布する「版」の一覧（サイト・リリースで共通）。版ごとに違うのは、文字を書き換えるときに使う同梱フォントだけ。
// UI はどの版にも 20 言語すべてが入っている。
export const EDITIONS = [
  {
    id: "ja",
    fonts: "ja",
    lang: "ja",
    label: "日本語",
    labelEn: "Japanese",
    description: "日本語 PDF の本文をそのまま書き換えられる PDF エディタ。ブラウザーの中だけで動き、PDF をどこにも送りません。",
  },
  {
    id: "en",
    fonts: "intl",
    lang: "en",
    label: "English",
    labelEn: "English / International",
    description: "A PDF editor that rewrites the actual text inside your PDFs. Runs in your browser; your PDFs are never sent anywhere.",
  },
  {
    id: "zh-cn",
    fonts: "zh-CN",
    lang: "zh-CN",
    label: "简体中文",
    labelEn: "Simplified Chinese",
    description: "可直接改写 PDF 正文的编辑器。完全在浏览器中运行，PDF 不会发送到任何地方。",
  },
  {
    id: "zh-tw",
    fonts: "zh-TW",
    lang: "zh-TW",
    label: "繁體中文",
    labelEn: "Traditional Chinese",
    description: "可直接改寫 PDF 正文的編輯器。完全在瀏覽器中執行，PDF 不會傳送到任何地方。",
  },
  {
    id: "ko",
    fonts: "ko",
    lang: "ko",
    label: "한국어",
    labelEn: "Korean",
    description: "PDF 본문을 그대로 고쳐 쓸 수 있는 편집기. 브라우저에서만 동작하며 PDF를 어디에도 보내지 않습니다.",
  },
  {
    id: "all",
    fonts: "all",
    lang: "en",
    label: "All languages",
    labelEn: "All languages",
    description: "Washi PDF with every bundled font (Japanese, Chinese, Korean and more). Largest download. Your PDFs are never sent anywhere.",
  },
];

/** 配信サービスの静的ファイル 1 つの上限。これを超える版は、別の置き場（オブジェクトストレージ）から配信する */
export const PAGES_FILE_LIMIT = 25 * 1024 * 1024;

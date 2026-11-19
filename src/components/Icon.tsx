import type { ReactNode } from "react";

const P: Record<string, ReactNode> = {
  // 白紙ページを削除：×の付いたページ
  "page-x": (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9.5 12.5l5 5M14.5 12.5l-5 5" />
    </>
  ),
  // 選択ページを保存：ページから外へ出る矢印
  "page-out": (
    <>
      <path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
      <path d="M15 3h6v6M21 3l-9 9" />
    </>
  ),
  // テキストへ書き出す：文字の行があるページ
  "page-text": (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M8.5 12h7M8.5 15.5h7M8.5 19h4" />
    </>
  ),
  // 透かし：しずく
  droplet: <path d="M12 3.5s6 6.4 6 10.9a6 6 0 0 1-12 0C6 9.9 12 3.5 12 3.5z" />,
  // 注釈の一覧：項目の並び
  list: (
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <circle cx="4.5" cy="6" r="1" />
      <circle cx="4.5" cy="12" r="1" />
      <circle cx="4.5" cy="18" r="1" />
    </>
  ),
  // 元の注釈を削除：斜線の付いた付箋
  "note-off": (
    <>
      <path d="M8 4h11a1 1 0 0 1 1 1v10M20 18.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5" />
      <path d="M3 3l18 18" />
    </>
  ),
  // まとめて処理：重なったページ
  layers: (
    <>
      <path d="M8 7V5a2 2 0 0 1 2-2h7l4 4v10a2 2 0 0 1-2 2h-2" />
      <path d="M13 7H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9z" />
    </>
  ),
  file: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </>
  ),
  ruler: (
    <>
      <path d="M3 17 17 3l4 4L7 21z" />
      <path d="M7 13l2 2M10 10l2 2M13 7l2 2" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />,
  contrast: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor" stroke="none" />
    </>
  ),
  grid: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1" />
      <rect x="13" y="4" width="7" height="7" rx="1" />
      <rect x="4" y="13" width="7" height="7" rx="1" />
      <rect x="13" y="13" width="7" height="7" rx="1" />
    </>
  ),
  pen: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </>
  ),
  undo: (
    <>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </>
  ),
  redo: (
    <>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" />
    </>
  ),
  share: (
    <>
      <path d="M12 15V3M8 7l4-4 4 4" />
      <path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" />
    </>
  ),
  pipette: (
    <>
      <path d="m14 5 5 5" />
      <path d="M16.5 2.5a2.1 2.1 0 0 1 3 0l2 2a2.1 2.1 0 0 1 0 3L18 11l-5-5 3.5-3.5Z" />
      <path d="m14 7-9.5 9.5a2 2 0 0 0-.5 1L3.5 21l3.5-.5a2 2 0 0 0 1-.5L17.5 10.5" />
    </>
  ),
  printer: (
    <>
      <path d="M7 8V3h10v5" />
      <rect x="3" y="8" width="18" height="9" rx="2" />
      <path d="M7 14h10v7H7z" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  scissors: (
    <>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4" />
      <path d="m7 9 5-5 5 5" />
      <path d="M20 16v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3" />
    </>
  ),
  type: (
    <>
      <path d="M4 7V5h16v2" />
      <path d="M9 19h6M12 5v14" />
    </>
  ),
  edit: (
    <>
      <path d="M4 20h4L19 9l-4-4L4 16z" />
      <path d="m13.5 6.5 4 4" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  "rotate-ccw": (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </>
  ),
  "rotate-cw": (
    <>
      <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
      <path d="M21 3v5h-5" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M10 11v6M14 11v6" />
      <path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
      <path d="M9 7V4h6v3" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="2" />
      <path d="m21 16-5-5-9 9" />
    </>
  ),
  square: <rect x="4" y="5" width="16" height="14" rx="1.5" />,
  circle: <ellipse cx="12" cy="12" rx="9" ry="7.5" />,
  line: <path d="M5 19 19 5" />,
  eraser: (
    <>
      <path d="m7 21-4-4a1.4 1.4 0 0 1 0-2L14 4a1.4 1.4 0 0 1 2 0l5 5a1.4 1.4 0 0 1 0 2L11 21z" />
      <path d="M21 21H7M9 10l6 6" />
    </>
  ),
  cursor: <path d="m5 3 14 7-6 2-2 6z" />,
  washi: (
    <>
      <path d="M7 3h7l5 5v12.3c-1 .7-1.9-.3-2.9.3s-1.9.9-2.9.3-2 .7-3 .2-1.9-1-2.9-.4-1.9.7-2.9.1-1.5.3-2.4-.3V3z" fill="currentColor" stroke="none" />
      <path d="M14 3v5h5" fill="none" stroke="#3656e0" strokeWidth="1.6" />
      <path d="M10 11h6M10 14.5h6M10 18h3" stroke="#3656e0" strokeWidth="1.6" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  "text-edit": (
    <>
      <path d="M4 6h10M9 6v12" />
      <path d="M14 18h6M17 12v9" />
      <rect x="2.5" y="3.5" width="13" height="16" rx="1" strokeDasharray="2 2" />
    </>
  ),
  "zoom-in": (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5M11 8v6M8 11h6" />
    </>
  ),
  "zoom-out": (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5M8 11h6" />
    </>
  ),
  fit: (
    <>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </>
  ),
  x: <path d="M6 6l12 12M18 6 6 18" />,
  "file-plus": (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M12 11v6M9 14h6" />
    </>
  ),
  front: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="1.5" fill="currentColor" fillOpacity=".25" />
      <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
    </>
  ),
  back: (
    <>
      <rect x="4" y="4" width="12" height="12" rx="1.5" fill="currentColor" fillOpacity=".25" />
      <path d="M8 16v3a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-3" />
    </>
  ),
  chevron: <path d="m9 6 6 6-6 6" />,
  highlight: (
    <>
      <path d="m9 11 4 4L20 8l-4-4z" />
      <path d="m9 11-3 3 4 4 3-3" />
      <path d="M3 21h8" />
    </>
  ),
  underline: (
    <>
      <path d="M6 4v6a6 6 0 0 0 12 0V4" />
      <path d="M4 20h16" />
    </>
  ),
  strikeout: (
    <>
      <path d="M16 6a4 4 0 0 0-4-3H9a4 4 0 0 0 0 8h6a4 4 0 0 1 0 8H9a4 4 0 0 1-4-3" />
      <path d="M4 12h16" />
    </>
  ),
  note: (
    <>
      <path d="M4 4h16v11H9l-4 4v-4H4z" />
      <path d="M8 8h8M8 11.5h5" />
    </>
  ),
  "pen-ink": (
    <>
      <path d="M3 21c3-6 7-9 12-13l3 3c-4 5-7 9-13 12z" />
      <path d="m14 7 3 3" />
    </>
  ),
  booklet: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M12 5v14M7 9h2M15 9h2M7 13h2M15 13h2" />
    </>
  ),
  bookmark: (
    <>
      <path d="M6 3h12v18l-6-4-6 4z" />
    </>
  ),
  paperclip: (
    <>
      <path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.3 3.3 0 0 1 4.7 4.7L9.5 17a1.7 1.7 0 0 1-2.4-2.4L15 7" />
    </>
  ),
  compare: (
    <>
      <rect x="3" y="4" width="8" height="16" rx="1.5" />
      <rect x="13" y="4" width="8" height="16" rx="1.5" />
      <path d="M5.5 9h3M15.5 9h3M5.5 13h3M15.5 13h3" />
    </>
  ),
  grayscale: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4v16M12 4a8 8 0 0 1 0 16" fill="currentColor" />
    </>
  ),
  scan: (
    <>
      <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
      <path d="M8 9h8M8 12h8M8 15h5" />
    </>
  ),
  compress: (
    <>
      <path d="M4 14h6v6M10 14l-6 6M20 10h-6V4M14 10l6-6" />
    </>
  ),
  redact: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" fill="currentColor" />
      <path d="M7 10h10M7 14h6" stroke="var(--bg, #fff)" />
    </>
  ),
  "image-edit": (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9" r="1.5" />
      <path d="m21 16-4-4-7 7" />
      <path d="m14 5 5 5M19 5l-5 5" />
    </>
  ),
  form: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9h4M7 13h10M7 17h6" />
      <path d="m14 8 1.5 1.5L18 7" />
    </>
  ),
  tools: (
    <>
      <path d="M14.7 6.3a4 4 0 0 0 5 5L9.6 21.4a2.1 2.1 0 0 1-3-3L16.7 8.3" />
      <path d="M14.7 6.3 18 3l3 3-3.3 3.3" />
    </>
  ),
  reverse: (
    <>
      <path d="M4 7h12l-3-3M20 17H8l3 3" />
    </>
  ),
  interleave: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1" />
      <rect x="13" y="13" width="7" height="7" rx="1" />
      <path d="M13 7.5h7M4 16.5h7" strokeDasharray="2 2" />
    </>
  ),
  crop: (
    <>
      <path d="M6 2v14a2 2 0 0 0 2 2h14" />
      <path d="M18 22V8a2 2 0 0 0-2-2H2" />
    </>
  ),
  resize: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 15 15 9M15 15V9H9" />
    </>
  ),
  hash: <path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />,
  calendar: <path d="M3 9h18M7 3v3M17 3v3M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" />,
  check: <path d="M20 6 9 17l-5-5" />,
  "list-check": <path d="M3 6h2m-2 6h2m-2 6h2M9 6h12M9 12h12M9 18h12" />,
  header: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M7 14h10M7 17h6" />
    </>
  ),
  stamp: (
    <>
      <path d="M5 21h14M6 17h12a1 1 0 0 0 1-1v-2a3 3 0 0 0-3-3h-1l-1-6a2 2 0 0 0-4 0l-1 6H8a3 3 0 0 0-3 3v2a1 1 0 0 0 1 1z" />
    </>
  ),
  // 署名：下線の上に、手書きの線
  sign: (
    <>
      <path d="M3 20h18" />
      <path d="M4 15c2-6 4-9 6-9 3 0-2 9 1 9 2 0 3-4 5-4 2 0 1 3 4 3" />
    </>
  ),
};

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {P[name]}
    </svg>
  );
}

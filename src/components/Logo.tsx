/**
 * Washi PDF のロゴ（assets/logo.svg と同じ絵。favicon はビルド時に assets/logo.svg を使う）。
 * 青の角丸に和紙の一枚（右上を折り返し）、下部に青グラデの流線（漉き水の流れ）。
 */
export function Logo({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="washi-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3d66ea" />
          <stop offset="1" stopColor="#1f3eb0" />
        </linearGradient>
        <linearGradient id="washi-flow" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#5fc5ff" stopOpacity="0.35" />
          <stop offset="0.45" stopColor="#8fdcff" />
          <stop offset="1" stopColor="#ffffff" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="url(#washi-bg)" />
      <path d="M18 10h19l9 9v23H18z" fill="#ffffff" />
      <path d="M37 10v9h9z" fill="#c9d6f9" />
      <path d="M24 25h14M24 31h14M24 37h8" stroke="#2f55d4" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M7 50c9-7 15 2 23-1s13-7 27-4" fill="none" stroke="url(#washi-flow)" strokeWidth="3.4" strokeLinecap="round" />
      <path d="M11 57c8-5 13 1 21-1s12-5 25-3" fill="none" stroke="url(#washi-flow)" strokeWidth="2.4" strokeLinecap="round" opacity="0.85" />
    </svg>
  );
}

/** 文字ロゴ：Washi を太く、PDF を細く */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={`wordmark ${className ?? ""}`}>
      Washi <span className="wordmark-pdf">PDF</span>
    </span>
  );
}

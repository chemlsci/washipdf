// ビルド成果物（dist/washi-pdf.html）が外部に通信しないことを静的に検査する。
//   node scripts/check-offline.mjs [dist/washi-pdf.html]
// 実際にブラウザで開いて通信ゼロを確かめるのは test/e2e/*.mjs（Playwright）が担当する。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = process.argv[2] ?? join(root, "dist", "washi-pdf.html");
const html = readFileSync(file, "utf8");

const problems = [];
const warnings = [];

// 0. Content-Security-Policy で通信を禁じていること（connect-src 'none'）。改ざんされても外部送信をブラウザが拒む
const csp = /<meta\s+http-equiv=["']Content-Security-Policy["']\s+content="([^"]+)"/i.exec(html);
if (!csp) problems.push("CSP の meta タグが無い（connect-src 'none' で通信を禁じる想定）");
else {
  if (!/connect-src\s+'none'/.test(csp[1])) problems.push("CSP に connect-src 'none' が無い");
  if (!/default-src\s+'none'/.test(csp[1])) problems.push("CSP に default-src 'none' が無い");
  if (!/form-action\s+'none'/.test(csp[1])) problems.push("CSP に form-action 'none' が無い");
}

// 1. 外部リソースを読み込むタグが無いこと
const tagChecks = [
  [/<script[^>]+src\s*=\s*["']?(?!data:)[^"'>\s]+/gi, "外部スクリプト <script src>"],
  [/<link[^>]+href\s*=\s*["']?(?:https?:)?\/\//gi, "外部 <link href>"],
  [/<iframe[^>]+src\s*=\s*["']?(?:https?:)?\/\//gi, "外部 <iframe>"],
  [/<img[^>]+src\s*=\s*["']?(?:https?:)?\/\//gi, "外部 <img>"],
  [/@import\s+(?:url\()?["']?(?:https?:)?\/\//gi, "CSS @import（外部）"],
  [/url\(\s*["']?(?:https?:)?\/\/[^)]*\)/gi, "CSS url()（外部）"],
];
for (const [re, label] of tagChecks) {
  const m = html.match(re);
  if (m) problems.push(`${label}: ${m.slice(0, 3).join(", ")}`);
}
// フォントの @font-face が外部を指していないこと
for (const m of html.matchAll(/@font-face\s*{[^}]*}/g)) {
  if (/https?:\/\//.test(m[0])) problems.push(`@font-face が外部を参照: ${m[0].slice(0, 80)}`);
}

// 2. 埋め込んだ JS（アプリ本体・ワーカー）を復元して、通信系 API の使用箇所を数える
// （gzip で縮めて埋め込んだもの（data-enc="gzip"）は戻してから調べる）
function decodeAsset(id) {
  const m = new RegExp(`<script type="application/octet-stream" id="asset-${id}"( data-enc="gzip")?>([^<]*)</script>`).exec(html);
  if (!m) return "";
  const raw = Buffer.from(m[2].replace(/\s+/g, ""), "base64");
  return (m[1] ? gunzipSync(raw) : raw).toString("utf8");
}
const app = decodeAsset("app");
const worker = decodeAsset("pdf-worker");
if (!app) problems.push("アプリ本体（asset-app）が見つかりません");
if (!worker) problems.push("pdf.js ワーカー（asset-pdf-worker）が見つかりません");

const apiChecks = [
  [/importScripts\s*\(/g, "importScripts("],
  [/navigator\.sendBeacon/g, "navigator.sendBeacon"],
  [/new\s+WebSocket\s*\(/g, "new WebSocket("],
  [/new\s+EventSource\s*\(/g, "new EventSource("],
  [/XMLHttpRequest/g, "XMLHttpRequest"],
  [/\bfetch\s*\(/g, "fetch("],
];
for (const [name, code] of [
  ["app", app],
  ["worker", worker],
]) {
  for (const [re, label] of apiChecks) {
    const n = (code.match(re) ?? []).length;
    if (n) warnings.push(`${name}: ${label} × ${n}`);
  }
  // 絶対 URL を引数に取る fetch / XHR open / import() が無いこと
  const hard = code.match(/(?:fetch|open|import)\s*\(\s*["'`]https?:\/\/[^"'`]+/g);
  if (hard) problems.push(`${name}: 絶対 URL への通信: ${hard.slice(0, 3).join(", ")}`);
}

console.log(`検査対象: ${file} (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(1)} MB)`);
for (const w of warnings) console.log(`  参考（API の存在のみ。pdf.js が URL 読み込み用に持っているもの）: ${w}`);
if (problems.length) {
  console.error("外部通信の可能性があります:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log("静的検査 OK: 外部リソースの読み込み・絶対 URL への通信はありません");

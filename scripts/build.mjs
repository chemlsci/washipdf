// アプリ全体を HTML 1ファイル（dist/washi-pdf.html）にまとめる。
//   node scripts/build.mjs          … 本番ビルド
//   node scripts/build.mjs --watch  … ソース変更のたびに作り直す（開発用。ブラウザで再読み込みして確認）
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as esbuild from "esbuild";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const watch = process.argv.includes("--watch");
// --pwa … ホスティング版（washipdf.com など）向け。manifest / Service Worker を参照し、
//         インストール（ホーム画面に追加）とオフライン起動に対応する。配布用の単一ファイルでは使わない。
const pwa = process.argv.includes("--pwa");
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
// --entry / --out はテスト用（別のエントリーから同じ形式の HTML を作る）
const entry = arg("entry") ?? join(root, "src", "main.tsx");
// --fonts=ja,latin … 同梱するフォントパック（assets/fonts/fonts.json の packs）。all で全部
const fontPacks = (arg("fonts") ?? "ja").split(",").map((s) => s.trim()).filter(Boolean);
const outFile = arg("out") ?? join(root, "dist", "washi-pdf.html");
// --ocr=<設定の JSON ファイル> … 文字認識（OCR）を使える版にする（ホスティング版だけ。--pwa と一緒に使う）。
//   設定：{ "engine": "<エンジンの URL>", "engineSimd": "<SIMD 版のエンジンの URL>", "langs": [{ "code": "jpn", "url": "…", "vertical": { "code": "jpn_vert", "url": "…" } }, …],
//           "licenses": "<エンジンと言語データのライセンス文>" }
//   エンジンと言語データは同じサイトに置き、使うときにだけプログラムとして読み込む（src/lib/ocr.ts）。
//   そのために script-src に 'self' を足す。通信の禁止（connect-src 'none'）は変えない。配布用の単一ファイルでは使わない
const ocrFile = arg("ocr");
if (ocrFile && !pwa) throw new Error("--ocr は --pwa と一緒に使います（配布用の単一ファイルには文字認識を入れません）");
const ocr = ocrFile ? JSON.parse(readFileSync(ocrFile, "utf8")) : null;

const b64 = (buf) => Buffer.from(buf).toString("base64");
/**
 * 埋め込むデータを gzip で縮める（フォントは 4〜6 割、プログラムは 3 割ほどになる。HTML が小さくなり、
 * Web 版の大きな版も静的配信の上限に収まる）。ヘッダーの OS の欄は「不明」にそろえ、どの環境で作っても同じバイト列にする
 */
const pack = (buf) => {
  const z = gzipSync(Buffer.from(buf), { level: 9 });
  z[9] = 0xff;
  return b64(z);
};
const read = (p) => readFileSync(join(root, p));

/**
 * pdf.js が実行時に取りに行くデータ（定義済み CMap・WASM）を1つのバイト列にまとめる。
 * 形式：[4バイト: 索引の長さ][索引 JSON {name: [offset, length]}][データ…]
 * 定義済み CMap（日本語・中国語簡体／繁体・韓国語。非埋め込みの MS 明朝などで必要）を全部と、
 * JPEG 2000 / JBIG2 / ICC の WASM と、記号のフォント 2 つを同梱する。タイ語・アラビア語などは CMap を使わないので追加は不要。
 */
function packPdfData(pdfjsDir) {
  const files = [];
  const cmapDir = join(pdfjsDir, "cmaps");
  for (const f of readdirSync(cmapDir).sort()) if (f.endsWith(".bcmap")) files.push([`cmaps/${f}`, readFileSync(join(cmapDir, f))]);
  // WASM が使えないブラウザ向けの *_nowasm_fallback.js（合計 1MB 超）は、対応ブラウザがすべて WASM 対応のため同梱しない
  for (const f of ["jbig2.wasm", "openjpeg.wasm", "qcms_bg.wasm"]) {
    files.push([`wasm/${f}`, readFileSync(join(pdfjsDir, "wasm", f))]);
  }
  // 記号のフォント（Symbol・ZapfDingbats の代わり。合わせて約 46KB）。チェックボックスやラジオボタンの見た目を pdf.js が作り直すとき
  // （NeedAppearances の付いたフォーム。LibreOffice が出すものなど）や、これらのフォントを埋め込まずに使う PDF で要る。
  // 無いと端末のフォント次第になり、✓ や ● が別の字形・豆腐になる
  for (const f of ["FoxitDingbats.pfb", "FoxitSymbol.pfb"]) files.push([`fonts/${f}`, readFileSync(join(pdfjsDir, "standard_fonts", f))]);
  const index = {};
  let offset = 0;
  for (const [name, buf] of files) {
    index[name] = [offset, buf.length];
    offset += buf.length;
  }
  const head = Buffer.from(JSON.stringify(index), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(head.length);
  return Buffer.concat([len, head, ...files.map(([, b]) => b)]);
}

/** fonts.json から、指定したパックのフォントを集める */
function loadFonts() {
  const manifest = JSON.parse(read("assets/fonts/fonts.json").toString("utf8"));
  const packs = fontPacks.includes("all") ? Object.keys(manifest.packs) : fontPacks;
  const ids = [];
  for (const p of packs) {
    if (!manifest.packs[p]) throw new Error(`fonts.json に無いパックです: ${p}（${Object.keys(manifest.packs).join(", ")}）`);
    for (const id of manifest.packs[p]) if (!ids.includes(id)) ids.push(id);
  }
  return ids.map((id) => {
    const f = manifest.fonts[id];
    if (!f) throw new Error(`fonts.json に無いフォントです: ${id}`);
    return { id, name: f.name, family: f.family, scripts: f.scripts, shaping: !!f.shaping, bytes: read(`assets/fonts/${f.file}`) };
  });
}

function loadStaticAssets() {
  const pdfjsDir = dirname(require.resolve("pdfjs-dist/package.json"));
  return {
    pdfData: packPdfData(pdfjsDir),
    // file:// ではモジュール形式のワーカーが動かないため、通常のスクリプト形式に変換して埋め込む
    worker: esbuild.transformSync(readFileSync(join(pdfjsDir, "legacy", "build", "pdf.worker.min.mjs"), "utf8"), {
      format: "iife",
      minify: true,
      target: ["chrome100", "edge100", "firefox100", "safari15"],
      legalComments: "inline",
    }).code,
    fonts: loadFonts(),
    // 同梱部品のライセンス文（scripts/licenses.mjs --write で生成）。アプリ内「このソフトについて」から参照する
    licenses: read("THIRD_PARTY_LICENSES").toString("utf8"),
    notice: read("NOTICE").toString("utf8"),
    version: JSON.parse(read("package.json").toString("utf8")).version,
  };
}

// アイコンは assets/logo.svg（和紙の一枚：右上を折り、下端を手漉きの耳にしている）
const ICON = "data:image/svg+xml," + encodeURIComponent(read("assets/logo.svg").toString("utf8").replace(/\s+/g, " ").trim());

function page({ js, css, assets }) {
  // 埋め込むデータは gzip で縮めて base64 にする（data-enc で印を付ける。取り出すのは src/lib/assets.ts）
  const data = (id, bytes) => `<script type="application/octet-stream" id="asset-${id}" data-enc="gzip">${pack(bytes)}</script>`;
  // JS 本体も base64 にして Blob から読み込む（</script> などの文字列で HTML が壊れるのを確実に防ぐ）。
  // 縮めた本体は、ブラウザーの展開の機能（DecompressionStream）で戻してから読み込む
  const boot = `(function(){var t=document.getElementById("asset-app");var s=atob(t.textContent.replace(/\\s+/g,""));var u=new Uint8Array(s.length);for(var i=0;i<s.length;i++)u[i]=s.charCodeAt(i);var z=t.getAttribute("data-enc")==="gzip";t.textContent="";function fail(){document.getElementById("root").innerHTML='<div class="boot">起動できませんでした。Chrome / Edge / Firefox / Safari の最新版で開いてください。<br>Could not start. Please open it in the latest Chrome, Edge, Firefox or Safari.</div>'}function run(b){var e=document.createElement("script");e.type="module";e.src=URL.createObjectURL(b);e.onerror=fail;document.body.appendChild(e)}if(!z){run(new Blob([u],{type:"text/javascript"}));return}if(typeof DecompressionStream==="undefined"){fail();return}new Response(new Blob([u]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer().then(function(b){run(new Blob([b],{type:"text/javascript"}))},fail)})();`;
  // Service Worker の登録（ホスティング版のみ）。アプリ本体の通信は connect-src 'none' のまま禁止され、
  // SW は同じ配布元の静的ファイルをキャッシュしてオフライン起動を可能にするだけ。利用者のデータは送らない。
  const swReg = `if("serviceWorker" in navigator){addEventListener("load",function(){navigator.serviceWorker.register("./sw.js",{scope:"./"}).catch(function(){})})}`;
  // 配布用の単一ファイルは外部通信を全面禁止（connect-src 'none'）。PWA 版も同じく通信は禁止したまま、
  // manifest / worker / icon の読み込みだけ同一オリジンに許可する（SW のキャッシュ取得は SW 側の文脈で行われ、このCSPの対象外）。
  // 'wasm-unsafe-eval'：同梱した WASM（JPEG 2000・JBIG2／ファクス形式の復号。白黒のスキャンに多い）を動かすために要る。
  // これが無いと、そうした画像のあるページが表示できない。許すのは WASM のコンパイルだけで、eval や通信は許さない
  // 文字認識を使える版だけ、同じサイトのプログラム（エンジンと言語データ）を読み込めるようにする
  // ページに直接書いたプログラムは、ここで作る 3 つ（画面の明るさ・起動・Service Worker の登録）だけ。中身のハッシュで名指しして許す
  // （'unsafe-inline' は使わない：万一ページに余計な <script> や onclick= が紛れ込んでも、動かない）。
  // アプリ本体は blob: の URL から読み込む（上の boot）。データ用の <script type="application/…"> は実行されないので対象外
  // 覚えている画面の明るさを、最初の描画より前に当てる（<head> に置く。本体の読み込みを待つと、そのあいだ違う色の画面が見える）。
  // キーと値は src/lib/theme.ts と同じ
  // 最初に動かす守り：このページ（と、このページが作る小窓）で WebRTC を使えなくする。
  // アプリは WebRTC を使わない。CSP では止められない通信の手段なので、不正なスクリプトが動いたときの抜け道を減らす
  const guard = `(function(){var N=["RTCPeerConnection","webkitRTCPeerConnection","mozRTCPeerConnection","RTCDataChannel","RTCIceCandidate","RTCSessionDescription","RTCRtpSender","RTCRtpReceiver","RTCRtpTransceiver","RTCIceTransport","RTCDtlsTransport","RTCSctpTransport"];function off(w){if(!w)return;for(var i=0;i<N.length;i++){try{Object.defineProperty(w,N[i],{value:undefined,writable:false,configurable:false})}catch(e){}}}off(window);try{new MutationObserver(function(ms){for(var i=0;i<ms.length;i++){var a=ms[i].addedNodes;for(var j=0;j<a.length;j++){var n=a[j];if(n.tagName==="IFRAME"){try{off(n.contentWindow)}catch(e){}n.addEventListener("load",function(){try{off(this.contentWindow)}catch(e){}})}}}}).observe(document.documentElement,{childList:true,subtree:true})}catch(e){}})();`;
  const themeBoot = `try{var t=localStorage.getItem("washi-pdf.theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;
  const hashOf = (code) => `'sha256-${createHash("sha256").update(code, "utf8").digest("base64")}'`;
  const inline = hashOf(guard) + " " + hashOf(themeBoot) + " " + hashOf(boot) + (pwa ? ` ${hashOf(swReg)}` : "");
  const csp = pwa
    ? `default-src 'none'; script-src ${inline} 'wasm-unsafe-eval' blob:` + (ocr ? " 'self'" : "") + "; style-src 'unsafe-inline'; img-src data: blob: 'self'; font-src data:; worker-src 'self' blob:; child-src blob:; connect-src 'none'; base-uri 'none'; form-action 'none'; manifest-src 'self'"
    : `default-src 'none'; script-src ${inline} 'wasm-unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; worker-src blob:; child-src blob:; connect-src 'none'; base-uri 'none'; form-action 'none'`;
  const pwaHead = pwa
    ? `<link rel="manifest" href="manifest.webmanifest" crossorigin="use-credentials">
<meta name="theme-color" content="#2f55d4">
<link rel="apple-touch-icon" href="apple-touch-icon.png">`
    : "";
  return `<!doctype html>
<html lang="ja" dir="ltr">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1, interactive-widget=resizes-content">
<title>Washi PDF</title>
<script>${guard}</script>
<script>${themeBoot}</script>
<link rel="icon" href="${ICON}">
${pwaHead}<style>${css}</style>
</head>
<body>
<div id="root"><div class="boot">読み込み中… / Loading…</div></div>
<noscript><div class="boot">JavaScript を有効にしてください。<br>Please enable JavaScript.</div></noscript>
${data("pdf-worker", assets.worker)}
${data("pdf-data", assets.pdfData)}
${assets.fonts.map((f) => data(`font-${f.id}`, f.bytes)).join("\n")}
<script type="application/json" id="fonts-manifest">${JSON.stringify(assets.fonts.map(({ id, name, family, scripts, shaping }) => ({ id, name, family, scripts, shaping })))}</script>
${data("app", js)}
<script type="text/plain" id="app-notice">
${assets.notice.replace(/<\/script/gi, "<\\/script")}
</script>
<script type="text/plain" id="third-party-licenses">
${(assets.licenses + (ocr?.licenses ? `\n${ocr.licenses}` : "")).replace(/<\/script/gi, "<\\/script")}
</script>${ocr ? `\n<script type="application/json" id="ocr-config">${JSON.stringify({ engine: ocr.engine, engineSimd: ocr.engineSimd, langs: ocr.langs }).replace(/</g, "\\u003c")}</script>` : ""}
<script>${boot}</script>
${pwa ? `<script>${swReg}</script>` : ""}
</body>
</html>
`;
}

/**
 * どの時点のソースから作ったか（コミットの短い番号と日時）。「このソフトについて」に出して、手元の版が最新かを見分けられるようにする。
 * 同じコミットからは同じ値になる（作成時刻は入れない＝同じソースからは同じファイルができる）。git が無ければ空。
 */
function commitInfo() {
  try {
    return execSync("git log -1 --abbrev=7 --format=%h,%cI", { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

const assets = loadStaticAssets();

const writeHtml = {
  name: "single-html",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length) return;
      const js = result.outputFiles.find((f) => f.path.endsWith(".js"));
      const css = result.outputFiles.find((f) => f.path.endsWith(".css"));
      mkdirSync(dirname(outFile), { recursive: true });
      const html = page({ js: js.contents, css: css ? css.text : "", assets });
      writeFileSync(outFile, html);
      const mb = (Buffer.byteLength(html) / 1024 / 1024).toFixed(1);
      console.log(`[washi-pdf] ${new Date().toLocaleTimeString()} ${outFile} (${mb} MB, fonts: ${assets.fonts.map((f) => f.id).join(" ")})`);
    });
  },
};

const options = {
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  splitting: false,
  minify: !watch && !process.argv.includes("--no-minify"),
  sourcemap: false,
  write: false,
  outdir: join(root, "dist", ".tmp"),
  target: ["chrome100", "edge100", "firefox100", "safari15"],
  jsx: "automatic",
  alias: { "@": join(root, "src") },
  define: { "process.env.NODE_ENV": watch || process.argv.includes("--profile") ? '"development"' : '"production"', "process.env.APP_VERSION": JSON.stringify(assets.version), "process.env.APP_COMMIT": JSON.stringify(commitInfo()) },
  legalComments: "eof",
  logLevel: "warning",
  plugins: [writeHtml],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("[washi-pdf] 変更を監視しています（Ctrl+C で終了）");
} else {
  await esbuild.build(options);
}

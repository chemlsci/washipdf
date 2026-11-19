// 依存ライブラリのライセンスを走査する。
//   node scripts/licenses.mjs --check   … 禁止ライセンス（GPL / LGPL / AGPL / MPL など）や不明なものがあれば失敗（CI 用）
//   node scripts/licenses.mjs --write   … 同梱する部品のライセンス文を THIRD_PARTY_LICENSES にまとめて書き出す
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** 使用してよいライセンス（SPDX 識別子）。これ以外は不明として失敗させる */
const ALLOWED = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "0BSD",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "Zlib",
  "Unlicense",
  "CC0-1.0",
  "CC-BY-4.0",
  "OFL-1.1",
  "Python-2.0",
  "BlueOak-1.0.0",
  "PSF-2.0",
]);
/** 使用禁止（コピーレフト系） */
const FORBIDDEN = /\b(A?GPL|LGPL|MPL|EUPL|CDDL|SSPL|BUSL|OSL|CPAL|EPL|CC-BY-SA|CC-BY-NC)\b/i;

/** "(MIT AND Zlib)" / "MIT OR Apache-2.0" のような式を識別子に分解する */
function parseExpr(lic) {
  return String(lic)
    .replace(/[()]/g, " ")
    .split(/\s+(?:AND|OR|WITH)\s+|\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

function licenseOf(json) {
  if (typeof json.license === "string") return json.license;
  if (json.license && typeof json.license === "object" && json.license.type) return json.license.type;
  if (Array.isArray(json.licenses)) return json.licenses.map((l) => (typeof l === "string" ? l : l.type)).join(" OR ");
  return "";
}

/** node_modules を再帰的に歩いて、インストールされている全パッケージを集める */
function walk(dir, out) {
  if (!existsSync(dir)) return;
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const p = join(dir, d.name);
    if (d.name.startsWith("@")) {
      walk(p, out);
      continue;
    }
    if (d.name.startsWith(".")) continue;
    const pj = join(p, "package.json");
    if (existsSync(pj)) {
      const json = JSON.parse(readFileSync(pj, "utf8"));
      if (json.name) out.set(`${json.name}@${json.version}`, { name: json.name, version: json.version, dir: p, license: licenseOf(json), json });
    }
    walk(join(p, "node_modules"), out);
  }
}

/** package.json の dependencies から実行時に同梱される可能性のあるパッケージ（推移的）を求める */
function productionSet(all) {
  const byName = new Map();
  for (const v of all.values()) byName.set(v.name, v); // 同名は代表 1 つで十分（ライセンス確認用）
  const seen = new Set();
  const stack = Object.keys(pkg.dependencies ?? {});
  while (stack.length) {
    const n = stack.pop();
    if (seen.has(n)) continue;
    seen.add(n);
    const v = byName.get(n);
    if (!v) continue;
    // optionalDependencies（pdf.js の Node.js 用 canvas など）はブラウザ向けバンドルに入らないので辿らない
    for (const dep of Object.keys(v.json.dependencies ?? {})) stack.push(dep);
  }
  return seen;
}

function readLicenseText(dir) {
  const names = readdirSync(dir).filter((f) => /^(license|licence|copying)(\.|$)/i.test(f));
  if (!names.length) return null;
  return readFileSync(join(dir, names[0]), "utf8").trim();
}

const all = new Map();
walk(join(root, "node_modules"), all);
const prod = productionSet(all);
const mode = process.argv.includes("--write") ? "write" : "check";

let failed = false;
const rows = [];
for (const v of [...all.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  const ids = parseExpr(v.license);
  let status = "ok";
  if (!ids.length) status = "UNKNOWN";
  else if (ids.some((id) => FORBIDDEN.test(id))) status = "FORBIDDEN";
  else if (!ids.every((id) => ALLOWED.has(id))) status = "UNKNOWN";
  const isProd = prod.has(v.name);
  if (status !== "ok") failed = true;
  rows.push({ ...v, status, isProd });
}

/** ライセンス文のファイルがパッケージに入っていないもの：代わりに書く説明 */
const NO_TEXT = {
  "@pdf-lib/fontkit": "MIT License (declared in the package's package.json; the package ships no license file).\nCopyright: Devon Govett (fontkit), Andrew Dillon (@pdf-lib/fontkit).\nThe libraries bundled inside this package are listed under \"Components bundled inside @pdf-lib/fontkit\" below.",
};

if (mode === "check") {
  const w = Math.max(...rows.map((r) => `${r.name}@${r.version}`.length));
  for (const r of rows) {
    const mark = r.status === "ok" ? "  " : "!!";
    console.log(`${mark} ${`${r.name}@${r.version}`.padEnd(w)}  ${(r.license || "(none)").padEnd(18)} ${r.isProd ? "runtime" : "dev"} ${r.status !== "ok" ? r.status : ""}`);
  }
  console.log(`\n${rows.length} packages (${rows.filter((r) => r.isProd).length} runtime)`);
  if (failed) {
    console.error("\n禁止ライセンスまたは不明なライセンスのパッケージがあります。");
    process.exit(1);
  }
  console.log("ライセンス検証 OK（寛容ライセンスのみ）");
} else {
  const sections = [];
  sections.push(
    [
      "Washi PDF — third-party components",
      "",
      "本ソフトウェア（Apache License 2.0）には、以下の部品が同梱されています。",
      "This software bundles the following third-party components.",
      "このファイルは scripts/licenses.mjs --write で生成しています。",
      "",
    ].join("\n"),
  );
  // 実行時に同梱されるパッケージ（バンドル対象）。開発時だけ使うものは含めない
  const bundled = rows.filter((r) => r.isProd).filter((r, i, arr) => arr.findIndex((x) => x.name === r.name) === i);
  for (const r of bundled) {
    const text = readLicenseText(r.dir);
    const home = r.json.homepage || (r.json.repository && (typeof r.json.repository === "string" ? r.json.repository : r.json.repository.url)) || "";
    sections.push(`${"=".repeat(72)}\n${r.name} ${r.version}\nLicense: ${r.license}\n${home ? `URL: ${home}\n` : ""}${"-".repeat(72)}\n${text ?? NO_TEXT[r.name] ?? "(license text not included in the package; see the URL above)"}\n`);
  }
  // パッケージに入っている、別の部品（パッケージの一覧には出てこないもの）。ライセンス文は assets/licenses/ に写してある
  const inner = [
    ["Components bundled inside @pdf-lib/fontkit", join(root, "assets", "licenses", "fontkit-bundled.txt"), ""],
    ["core-js (polyfills inside the pdf.js legacy build)", join(root, "assets", "licenses", "core-js.txt"), "License: MIT\nURL: https://github.com/zloirock/core-js\n"],
  ];
  for (const [title, file, head] of inner) {
    sections.push(`${"=".repeat(72)}\n${title}\n${head}${"-".repeat(72)}\n${readFileSync(file, "utf8").trim()}\n`);
  }
  // pdf.js に同梱されているデータ（CMap・WASM）
  const pdfjsDir = join(root, "node_modules", "pdfjs-dist");
  const extras = [
    ["Adobe CMap resources (bundled by pdf.js)", join(pdfjsDir, "cmaps", "LICENSE")],
    ["OpenJPEG (JPEG 2000 decoder, WASM; bundled by pdf.js)", join(pdfjsDir, "wasm", "LICENSE_OPENJPEG")],
    ["pdf.js OpenJPEG glue", join(pdfjsDir, "wasm", "LICENSE_PDFJS_OPENJPEG")],
    ["JBIG2 decoder (from PDFium; WASM, bundled by pdf.js)", join(pdfjsDir, "wasm", "LICENSE_JBIG2")],
    ["pdf.js JBIG2 glue", join(pdfjsDir, "wasm", "LICENSE_PDFJS_JBIG2")],
    ["qcms (ICC color management, WASM; bundled by pdf.js)", join(pdfjsDir, "wasm", "LICENSE_QCMS")],
    ["pdf.js qcms glue", join(pdfjsDir, "wasm", "LICENSE_PDFJS_QCMS")],
    ["Foxit symbol fonts (FoxitDingbats, FoxitSymbol; from PDFium, bundled by pdf.js)", join(pdfjsDir, "standard_fonts", "LICENSE_FOXIT")],
  ];
  for (const [title, file] of extras) {
    if (!existsSync(file)) continue;
    sections.push(`${"=".repeat(72)}\n${title}\n${"-".repeat(72)}\n${readFileSync(file, "utf8").trim()}\n`);
  }
  // フォント（assets/fonts/fonts.json に載っているものすべて。ライセンス文が同じものはまとめる）
  const fm = JSON.parse(readFileSync(join(root, "assets/fonts/fonts.json"), "utf8"));
  const byLicense = new Map();
  for (const f of Object.values(fm.fonts)) {
    const arr = byLicense.get(f.license) ?? [];
    arr.push(f.name);
    byLicense.set(f.license, arr);
  }
  for (const [file, names] of byLicense) {
    sections.push(`${"=".repeat(72)}\n${names.join(", ")} (font)\nLicense: OFL-1.1\n${"-".repeat(72)}\n${readFileSync(join(root, "assets/fonts", file), "utf8").trim()}\n`);
  }
  // 改行は LF にそろえる（パッケージによって CRLF のライセンス文がある。OS によってファイルが変わらないように）
  writeFileSync(join(root, "THIRD_PARTY_LICENSES"), sections.join("\n").replace(/\r\n?/g, "\n"));
  console.log(`THIRD_PARTY_LICENSES を書き出しました（${bundled.length} パッケージ + データ + フォント）`);
  if (failed) {
    console.error("注意：禁止または不明なライセンスのパッケージがあります。--check で確認してください。");
    process.exit(1);
  }
}

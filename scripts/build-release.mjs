// GitHub Releases に添付する配布用の単一 HTML（6 版）を out/ に作り、SHA-256 と英日併記のリリースノートを書く。
//   node scripts/build-release.mjs v1.2.3
// 配布用は PWA 要素を含まない厳格版（connect-src 'none'、ローカルでダブルクリックして使う）。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EDITIONS } from "./editions.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ver = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? `v${JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version}`;
// リリースノートのリンク先：CI ではそのリポジトリ（GITHUB_REPOSITORY）
const repo = process.env.GITHUB_REPOSITORY ?? "chemlsci/washipdf";
const out = join(root, "out");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 書き換えられる文字（英 / 日）
const CAN_EDIT = {
  ja: ["Japanese, Latin, Greek, Cyrillic, Vietnamese, Thai, Arabic, Hebrew, Hindi, Bengali", "日本語・欧文・ギリシャ・キリル・ベトナム・タイ・アラビア・ヘブライ・ヒンディー・ベンガル"],
  en: ["Latin, Greek, Cyrillic, Vietnamese, Thai, Arabic, Hebrew, Hindi, Bengali (no CJK)", "欧文・ギリシャ・キリル・ベトナム・タイ・アラビア・ヘブライ・ヒンディー・ベンガル（漢字・かな・ハングルは不可）"],
  "zh-cn": ["Simplified Chinese, Latin", "簡体字中国語・欧文"],
  "zh-tw": ["Traditional Chinese, Latin", "繁体字中国語・欧文"],
  ko: ["Korean, Latin", "韓国語・欧文"],
  all: ["Everything above (largest)", "上記すべて（最大サイズ）"],
};

const rows = [];
for (const ed of EDITIONS) {
  const name = `washi-pdf-${ver}-${ed.id}.html`;
  const file = join(out, name);
  execFileSync("node", [join(root, "scripts", "build.mjs"), `--fonts=${ed.fonts}`, `--out=${file}`], { stdio: "inherit" });
  execFileSync("node", [join(root, "scripts", "check-offline.mjs"), file], { stdio: "inherit" });
  const buf = readFileSync(file);
  rows.push({ ed, name, size: buf.length, sha: createHash("sha256").update(buf).digest("hex") });
}
writeFileSync(join(out, "SHA256SUMS.txt"), rows.map((r) => `${r.sha}  ${r.name}`).join("\n") + "\n");

const mib = (n) => `${(n / 1048576).toFixed(1)} MiB`;
const table = [
  "| File / ファイル | Edits / 書き換えられる文字 | Size | SHA-256 |",
  "| --- | --- | --- | --- |",
  ...rows.map((r) => `| \`${r.name}\` | ${CAN_EDIT[r.ed.id][0]}<br>${CAN_EDIT[r.ed.id][1]} | ${mib(r.size)} | \`${r.sha}\` |`),
].join("\n");

writeFileSync(
  join(out, "notes.md"),
  `## Washi PDF ${ver}

**Official downloads are only the HTML files attached to this release.** Online version: <https://washipdf.com>
**公式の配布物は、このリリースに添付した HTML ファイルだけです。** オンライン版：<https://washipdf.com>

${table}

Every edition has the same features and a 20-language UI. They differ only in the bundled fonts used when rewriting text.
どの版も機能は同じで、画面は 20 言語に切り替えられます。違いは、文字を書き換えるときに使う同梱フォント（書ける文字）だけです。

### How to use / 使い方
1. Download the edition for your documents (if unsure: \`-ja\` for Japanese, \`-en\` for others).
   用途に合う版をダウンロード（迷ったら日本語の文書は \`-ja\`、それ以外は \`-en\`）
2. Double-click it to open in your browser (latest Chrome / Edge / Firefox / Safari). No install, no server, no network connection needed.
   ダブルクリックしてブラウザーで開く。インストール・サーバー・ネットワーク接続は不要
3. Load a PDF, edit, and press "Save".
   PDF を読み込んで編集し、「保存」でダウンロード

Files are processed only inside your browser; the app makes no network requests. A Content-Security-Policy (\`connect-src 'none'\`) tells the browser to block connections, and nothing is loaded from a CDN.
Text recognition (OCR) is only in the web version (<https://washipdf.com>). On iPhone / iPad we recommend the web version.
ファイルはブラウザーの中だけで処理され、アプリは通信を行いません。CSP（\`connect-src 'none'\`）で外部への接続をブラウザに止めさせており、CDN からも何も読み込みません。
文字認識（OCR）は Web 版（<https://washipdf.com>）だけの機能です。iPhone / iPad では Web 版をおすすめします。

### Verify / 改ざんの確認
SHA-256 (also in \`SHA256SUMS.txt\`) / SHA-256 の照合：
\`\`\`
sha256sum <file>                      # Linux
shasum -a 256 <file>                  # macOS
certutil -hashfile <file> SHA256      # Windows
\`\`\`
Build provenance (proves the file was built by this repository's CI) / CI が作った本物かの確認：
\`\`\`
gh attestation verify <file> --repo ${repo}
\`\`\`

License: Apache-2.0. Third-party licenses: THIRD_PARTY_LICENSES and "About" in the app.
ライセンス：Apache-2.0。同梱部品のライセンスは THIRD_PARTY_LICENSES とアプリ内「このソフトについて」を参照。
`,
);
for (const r of rows) console.log(`  ${r.name.padEnd(36)} ${mib(r.size).padStart(10)}  ${r.sha.slice(0, 12)}`);
console.log("out/ を作成しました");

# Contributing / 開発に参加するには

Thank you for your interest in Washi PDF. Bug reports, self-made test PDFs (no real documents), translations and code are all welcome.

## Before you start

- **Security problems** go through [SECURITY.md](SECURITY.md), not public issues.
- **Do not attach PDFs that contain personal or confidential information.** A small file that reproduces the problem is best. Files attached to public issues are public.
- For a larger change, please open an issue first so we can agree on the approach.

## Development

Requires Node.js 22.13 or later.

```bash
npm install
npm run dev          # rebuild dist/washi-pdf.html on change
npm run typecheck
npm test             # unit tests (text extraction, image diffs, re-reading saved files)
npm run build
npm run e2e          # browser tests (needs: npx playwright install chromium)
```

`dist/washi-pdf.html` is the whole application; open it from the file system to try a change.

## Rules that keep the project's promises

- **No network access.** The app must work with `connect-src 'none'`. Do not add analytics, remote fonts, CDNs or automatic updates (the web version looks for a newer version on its own site only when the user presses “Check for updates”, and installs it only when the user chooses to). `node scripts/check-offline.mjs` and the E2E tests enforce this.
- **Dependencies** must have a licence accepted by `node scripts/licenses.mjs --check`; run `node scripts/licenses.mjs --write` when they change.
- **Tests** accompany behaviour changes. A change to how existing text is rewritten or redacted needs a test that re-reads the saved PDF.
- **Translations** live in `src/lib/locales/`. Every key must exist in all languages (`npm test` checks this; see `docs/i18n.md`, in Japanese). Most translations were produced by machine translation and corrections by native speakers are very welcome.

## Pull requests

- Keep each pull request to one topic.
- This repository receives one commit per release: day-to-day development happens elsewhere and is published here when a version is released. An accepted pull request is therefore applied there and appears in the next release commit (with credit in the release notes) rather than being merged directly.
- Describe what changed and how you checked it (browser, OS, the commands above).
- By contributing you agree that your contribution is licensed under the Apache License 2.0, the licence of this project.

---

## 日本語

Washi PDF に関心を持っていただき、ありがとうございます。不具合の報告、自作の検証用 PDF（実際の文書は不可）、翻訳、コードのいずれも歓迎します。

### はじめに

- **セキュリティ上の問題**は、公開の Issue ではなく [SECURITY.md](SECURITY.md) の方法で報告してください。
- **個人情報や機密を含む PDF は添付しないでください。** 問題を再現できる小さなファイルが最適です。公開の Issue に添付したファイルは誰でも見られます。
- 大きな変更は、先に Issue で方針を相談してください。

### 開発

Node.js 22.13 以上が必要です。コマンドは上の英語の節と同じです。`dist/washi-pdf.html` がアプリのすべてで、ファイルとして開けば変更を試せます。

### 守ってほしいこと

- **通信をしない。** `connect-src 'none'` のまま動くこと。解析・外部フォント・CDN・自動更新は足さないでください（Web 版が自分のサイトに新しい版を確かめに行くのは、利用者が「更新を確認」を押したときだけで、取り込むのも利用者が選んだときだけです。`node scripts/check-offline.mjs` と E2E が検査します）。
- **依存部品**は、`node scripts/licenses.mjs --check` が通るライセンスのものだけ。変えたら `node scripts/licenses.mjs --write` を実行してください。
- **テスト**を、動作の変更と一緒に。元の文字の書き換えや墨消しを変えるときは、保存した PDF を読み直すテストが必要です。
- **翻訳**は `src/lib/locales/` にあります。どのキーも全言語にそろえてください（`npm test` が検査します。`docs/i18n.md`）。多くの翻訳は機械翻訳で作ったものなので、その言語を母語とする方の修正を歓迎します。

### プルリクエスト

- 1 つのプルリクエストは 1 つの話題に。
- このリポジトリには、リリースごとに 1 つのコミットを置きます（日々の開発は別の場所で行い、リリースのときにまとめて反映します）。受け入れたプルリクエストは、直接マージするのではなく、次のリリースのコミットに取り込みます（リリースノートにお名前を記載します）。
- 何を変えたか、どう確かめたか（ブラウザー、OS、上のコマンド）を書いてください。
- 投稿した内容は、このプロジェクトと同じ Apache License 2.0 で提供することに同意したものとします。

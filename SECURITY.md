# Security Policy / セキュリティポリシー

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

- Use GitHub's **"Report a vulnerability"** button on the Security tab of this repository (private vulnerability reporting), or
- write to **contact@washipdf.com**.

Please include the version (shown in “About Washi PDF”), the browser and OS, and the steps to reproduce. If a PDF is needed to reproduce the problem, send one that contains no personal or confidential information.

We aim to reply within 7 days. Fixes are published as a new release; the reporter is credited unless they prefer otherwise.

## What counts as a vulnerability here

Washi PDF processes PDFs only inside the browser and never sends them, or anything you type, anywhere. The downloaded HTML file makes no network requests; the web version only receives the app itself, updates (when you ask) and text-recognition data from washipdf.com. In both, a Content-Security-Policy (`connect-src 'none'`) forbids connections. We especially want to hear about:

- any way to make the app send data out of the browser,
- script execution caused by a crafted PDF, file name, or pasted text,
- redaction that leaves the removed text or image recoverable from the saved file,
- a saved "protected" PDF that can be opened without the password,
- a mismatch between the published SHA-256 and the distributed file.

Not considered vulnerabilities: the weakness of RC4 (offered only for old readers), print / copy permissions being ignored by other software (whether they are honoured is up to the reader software), and the fact that the web version trusts the site it is served from (use the verified download for confidential work).

## Supported versions

Only the latest release receives fixes.

---

## 脆弱性の報告

セキュリティ上の問題は、**公開の Issue には書かないでください**。

- このリポジトリの Security タブにある **「Report a vulnerability」**（非公開の報告）を使うか、
- **contact@washipdf.com** へお送りください。

バージョン（「このソフトについて」に表示）、ブラウザーと OS、再現の手順を添えてください。再現に PDF が必要なときは、個人情報や機密を含まないものをお願いします。

7 日以内の返信を目指します。修正は新しいリリースとして公開し、希望されない場合を除いて報告者のお名前を記載します。

## 対象になるもの

Washi PDF は PDF をブラウザーの中だけで処理し、PDF や入力した内容をどこにも送りません。ダウンロード版（HTML ファイル）は一切通信しません。Web 版は、アプリ本体・更新（押したときだけ）・文字認識のデータを washipdf.com から受け取るだけです。どちらも Content-Security-Policy（`connect-src 'none'`）で接続を禁じています。特に次のような問題の報告を歓迎します。

- アプリからブラウザーの外へデータを送らせる方法
- 細工した PDF・ファイル名・貼り付けた文字で、スクリプトが実行される
- 墨消しで消したはずの文字や画像が、保存したファイルから取り出せる
- 「保護」して保存した PDF が、パスワードなしで開ける
- 公開している SHA-256 と、配布しているファイルが一致しない

次のものは脆弱性として扱いません：RC4 の弱さ（古いソフト向けに残している選択肢です）、印刷・コピーの制限がほかのソフトで守られないこと（守るかどうかは閲覧ソフト次第です）、Web 版が配信元のサイトを信頼すること（機密の文書には、確認したダウンロード版をお使いください）。

## 修正の対象

最新のリリースだけを修正の対象にします。

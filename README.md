<p align="center"><img src="assets/logo.svg" width="96" alt="Washi PDF"></p>

# Washi PDF

**English** | [日本語](README.ja.md)

**Edit PDFs right in your browser. Your files never leave it.**

**Online: [washipdf.com](https://washipdf.com)** (installable as a PWA) / **Download: [Releases](https://github.com/chemlsci/washipdf/releases)**

A PDF editor that runs from **a single HTML file**. Double-click the downloaded file (for example `washi-pdf-v1.0.1-ja.html`) and it opens in your browser — no install, no admin rights, no server. PDFs are processed only inside your browser and are never sent anywhere. The downloaded file makes no network requests at all; the web version only receives the app itself, updates (when you ask) and text-recognition data from washipdf.com. On top of that, a Content-Security-Policy (`default-src 'none'; connect-src 'none'`) tells the browser to block connections (fetch / XHR / WebSocket), external scripts, images and fonts, and form posts, so that code which slipped in through a crafted PDF or a bug would have no ordinary way to send data out. This is defence in depth, not an absolute guarantee. Of the channels a CSP cannot block, WebRTC is disabled when the app starts, and leaving the app for an outside page asks you first (this works in browsers with the Navigation API; elsewhere only opening new windows is checked). A replaced or tampered file can be detected with the SHA-256 published on Releases.

**No CDN, either.** pdf.js, fonts, WASM and CMaps are all bundled into the one HTML file, so nothing is fetched at run time. With apps that load components from a CDN, a compromised CDN or upstream package means tampered code arrives from the official URL (e.g. the 2024 polyfill.io incident), and the CDN can see when, from which IP and which component was requested. With Washi PDF you **verify the file once (SHA-256) and it stays the same forever** — instead of trusting a server every time you open it.

It can also **edit the text already in a PDF**, with particular care for Japanese. On lines it can rewrite, the old text is deleted and the new text is written in its place, so searching or copying the saved PDF no longer finds the old text (the app tells you before you edit a line where the new text can only be drawn over the old one).

## Features

| Area | What you can do |
| --- | --- |
| Edit existing text | Click a line or paragraph and rewrite it; or drag to select several lines. The original text-drawing operators are removed and new text is written. Line breaking with Japanese kinsoku rules, automatic shrink-to-fit with warnings, reuse of the original font (missing glyphs fall back to bundled fonts). Vertical writing supported |
| Start | Drop or choose a PDF, or start without one: from images, or from a blank page |
| Pages | Merge, reorder (drag / long-press on phones), rotate, delete, duplicate, insert blank pages or other PDFs, reverse the order, interleave two scans (fronts and backs), remove blank pages, split (every N pages / ranges / selection / by bookmark / by file size) |
| Insert & annotate | Text, images, shapes, whiteout, signatures (drawn by hand, a seal made from a name, or an image with its background made transparent; placed as an image and flattened into the page — not a certificate-based digital signature), highlight / underline / strikeout, notes, freehand, stamps (rectangle / ellipse / double ring), approval boxes (a row of title cells such as manager / staff; a signature or seal dropped into a cell is resized to fit it, also in boxes drawn by other software), links (to a web address or a page), measuring (distances, multi-point paths and areas at a scale such as 1:100; the scale can also be set by entering the real length of a line you draw), a list of all annotations with jump-to and delete |
| Forms | Fill in and flatten existing forms; create fields (text, multi-line, checkbox, drop-down, radio buttons, date, signature), or let the app place them in the empty cells and blank lines it finds in tables |
| Find & replace / redact | Search the whole document, review the matches in a list, then rewrite them (real edit) or redact them in one step. Case and full-/half-width differences can be ignored. Ready-made patterns find e-mail addresses, card numbers and Japanese formats (phone numbers starting with 0 or +81, postal codes, My Number); other formats, names and addresses are found by typing them |
| Batch | Apply compression, page numbers, a watermark, redaction of personal information, removal of document info (author, creator software, …), and a password to several PDFs at once, and download them as a ZIP |
| Redaction & original images | Delete or replace an image of the original PDF. Redaction removes text, images and vector paths under the area from the file itself (an image that is only partly covered keeps its other pixels; the original image, the pre-edit content streams and hidden page copies are purged from the saved file), verifies the saved PDF by reading it back, and warns if the redacted words remain elsewhere (metadata, bookmarks, other pages). Traces of the removed text are removed too: alternate text (/ActualText) around it, page thumbnails, other applications’ private data, fonts that were only used by the removed text, and — in fonts shared with other text — the mapping, widths and (for TrueType and Type3 fonts) outlines of characters no longer used anywhere. Text or images inside tiling patterns and transparency masks cannot be removed (the app warns and does not report the page as verified). A redaction that only partly covers text or an image added in the app stops the save with an explanation. JavaScript, launch, form-submit and open-another-file actions of the original PDF, and links to addresses other than http(s), mailto and tel, are dropped on save |
| Whole document | Page numbers / Bates, header & footer, watermark, crop, resize, N-up & booklet, bookmarks, attachments, metadata, grayscale, compression (image downsampling and re-encoding, removing unused glyphs from fully embedded fonts, merging duplicate data, dropping data that is not used for display; also a mode that only makes changes which do not affect the look, and an opt-in conversion of scanned pages to 1-bit black and white with a zoomable preview), compare two PDFs (added, deleted and moved pages are matched up, changed words are highlighted on the page, content that only moved down is not reported, scans are aligned before comparing; zoom, jump from the list, and export as an annotated PDF, report pages inserted into the current document, or Markdown), change summary before saving |
| Security | Open RC4 / AES-128 / AES-256 PDFs with a password; save with AES-256 (or RC4 128-bit for old readers) and permissions |
| Text recognition (OCR) — web version only | Reads the text on scanned (image-only) pages and lays it over the page as invisible text: the page looks the same, but the text can be searched, selected and copied, and words can be found and redacted. 21 languages including Japanese (also vertical), English, Chinese and Korean. Recognition runs on the device; the PDF and its images are not sent. The engine (Tesseract) and the language data are large, so they are not in the downloadable HTML; the web version loads them from the same site when used |
| Convert | PDF → images / text / Markdown, images → PDF |
| Save, share, print | Save as (pick the destination where the browser supports it), overwrite the original file (Chrome / Edge, with confirmation), share sheet (where supported), print. Every saved PDF is reopened to check it before it replaces a file; if the check fails, the file is left alone and a download is offered. Overwriting warns if another app changed the file since it was opened |
| Other | Continuous scrolling through the pages, fit to page width (PC default) or to the whole page, light / dark screen, undo / redo (the button shows what will be undone), keyboard shortcuts (press ? for the list; Ctrl+S save, Ctrl+F find, Ctrl+P print), autosave & restore (IndexedDB), Japanese era ⇄ Western year conversion, 20 UI languages (including right-to-left) |

Browsers: current Chrome / Edge / Firefox / Safari. CI runs the editing flows in Chromium, and a walk-through (open, rewrite text, every tool, save) in Firefox and WebKit, at desktop and phone screen sizes. It has not yet been verified systematically on physical iPhone / Android devices — reports are welcome.

## What works in which script

Opening, viewing, organizing pages, annotating, redacting an area you mark, and all whole-document functions work on PDFs in any language. What depends on the script is **editing text that is already in the PDF** and **finding a word to replace or redact**.

| Script of the text in the PDF | View, pages, annotate, redact a marked area | Rewrite existing text | Find → replace | Find → redact | Add new text |
| --- | --- | --- | --- | --- | --- |
| Japanese, Chinese, Korean (horizontal) | ✅ | ✅ | ✅ | ✅ | ✅ (edition with the font) |
| Japanese vertical writing | ✅ | ✅ (same or fewer characters stay in place; longer text is fitted by shrinking) | ✅ | ⚠️ whole column | ✅ |
| Latin (English, European languages, Vietnamese, …), Cyrillic, Greek | ✅ | ✅ | ✅ | ✅ | ✅ |
| Thai | ✅ | ✅ | ✅ | ✅ by word; the whole line where the glyphs cannot be matched | ✅ (editions with the font: Japanese, English, All) |
| Arabic script (Arabic, Persian, Urdu), Hebrew | ✅ | ⚠️ word by word: the words you change are written in a bundled font, the other words keep their original glyphs (numbers and Latin words in the line stay in the document font when it has the characters) | ⚠️ same | ✅ by word; the whole line where the glyphs cannot be matched | ✅ (editions with the font: Japanese, English, All) |
| Indic scripts (Hindi, Bengali, Gujarati, Punjabi, …) | ✅ | ⚠️ word by word: the words you change are written in a bundled font, everything else keeps its original glyphs (new words in Hindi/Devanagari and Bengali; in the other scripts you can delete words or replace them with text in another script) | ⚠️ same, where the word is found (see below) | ✅ by word, where the word is found; the whole line where the glyphs cannot be matched | ✅ Hindi, Bengali · ❌ others |
| Lao, Khmer, Myanmar, Tibetan | ✅ | ⚠️ overlay only | ❌ | ❌ mark the area with the Redact tool | ❌ |

- **Overlay only** means the old text is covered and new text is written on top. The old text stays in the file; use redaction if it must be removed.
- Why the limits: in these scripts a letter changes shape with its neighbours and glyphs are stored in visual order, so the characters and glyphs in the PDF cannot be matched reliably. Rewriting glyph by glyph would break the joining or drop characters.
- **Word by word** (Indic scripts, and lines in any script that contain a few glyphs with no character assigned): the text of such a line is the glyph sequence as stored, which is not the spelling you would type (a vowel sign may come before its consonant, and many conjuncts have no character assigned). So only the words you actually change are rewritten — shaped properly in a bundled font — and the rest of the line is left untouched. Retype whole words. While editing, the page shows the real saved result. If a line cannot be handled this way, it is left as it was and you are told. Searching matches the spelling you type against the stored order as well (a vowel sign written before its consonant is handled), but a word containing a conjunct that has no character assigned cannot be found; mark such an area with the Redact tool.
- The same applies in any script when a character you add is missing from the document's font: only that word (in Japanese/Chinese/Korean, only that character) switches to a bundled font; the rest of the line keeps the original font.
- Arabic script and Hebrew: in the PDF the glyphs are stored in visual order (left to right). The text of a line is rebuilt from the glyph positions: words are cut out and put in reading order, and brackets and sentence-final punctuation are turned to their logical form. When you edit, only the words you change are written in a bundled font; the other words keep their original glyphs and are shifted towards the end of the line (to the left in a right-to-left line) by the difference in width. The bundled font is sized to match the width of the words in the original line, and the whole line is squeezed horizontally if it no longer fits. A run of numbers or Latin words is rewritten as a whole. On a line with long Latin phrases at both ends the direction can be misjudged, so the words appear in a different order (the page shows the real saved result while you edit). Lines inside form XObjects, and lines whose text cannot be rebuilt from the glyphs, are overlay only.
- Thai: vowel and tone marks are stored as separate glyphs whose height depends on the letter below. A rewritten word reuses the mark shapes the same page already uses for that combination; a combination the page never uses gets the font's default mark, which can sit slightly higher or lower than the original typesetting.
- After every save with redactions, the saved file is read back and you are warned if a redacted word is still found.
- Checked against public documents in Japanese, English, Chinese (Simplified / Traditional), Korean, Russian, Vietnamese, Spanish, French, Italian, Portuguese, Polish, Tagalog, Haitian Creole, Arabic, Persian, Urdu, Bengali, Gujarati, Punjabi, Khmer, Thai and Hindi.

## Editions

Every edition has the same features and a 20-language UI. They differ only in the **fonts bundled for writing new text**. Viewing, page organizing, annotation and redaction work on PDFs in any language with any edition.

| Edition | Can write | Size | Online |
| --- | --- | --- | --- |
| `ja` Japanese | Japanese, Latin, Greek, Cyrillic, Vietnamese, Thai, Arabic, Hebrew, Hindi, Bengali | ~14 MiB | [/app/ja/](https://washipdf.com/app/ja/) |
| `en` English / International | Latin, Greek, Cyrillic, Vietnamese, Thai, Arabic, Hebrew, Hindi, Bengali (no CJK) | ~5 MiB | [/app/en/](https://washipdf.com/app/en/) |
| `zh-cn` Simplified Chinese | Simplified Chinese, Latin (sans & serif) | ~23 MiB | [/app/zh-cn/](https://washipdf.com/app/zh-cn/) |
| `zh-tw` Traditional Chinese | Traditional Chinese, Latin (sans & serif) | ~17 MiB | [/app/zh-tw/](https://washipdf.com/app/zh-tw/) |
| `ko` Korean | Korean, Latin (sans & serif) | ~15 MiB | [/app/ko/](https://washipdf.com/app/ko/) |
| `all` All languages | Everything above (heavy on phones) | ~57 MiB | [/app/all/](https://washipdf.com/app/all/) |

## Install as an app (PWA)

Each edition on [washipdf.com](https://washipdf.com) can be installed from the browser menu ("Install app" / "Add to Home Screen"). After the first visit it **works offline**; a Service Worker caches the app. On desktop Chrome / Edge the installed app can also **open `.pdf` files from "Open with"** (File Handling API).

**Using the downloaded single HTML file on a phone**: on Android, pick the file in the Files app and choose "Open with Chrome". Typing a `file://` address or opening it with "HTML Viewer" usually does not work (behaviour differs between devices). If it will not open, use the web version above (once installed it also works offline). On iPhone / iPad we recommend the web version.

The installed app is still **not allowed to connect anywhere**: the PWA build keeps `connect-src 'none'`. The only requests are for the app's own static files on the same origin (the app and its icons; a small version file when you press "Check for updates" — the app never checks on its own, and a new version is installed only when you choose to update); your PDFs are not sent. The one thing loaded later is text recognition (OCR, web version only): when you use it, the engine and the language data are loaded from the same origin as program files (the build adds `script-src 'self'` for this; `connect-src 'none'` stays), so the host can tell that OCR was used and which languages were chosen — but the PDF and its images are not sent.

**What travels where**

| | Receives from the site | Sends |
| --- | --- | --- |
| Web version in a browser tab | The app (first visit); a new version (only when you press "Check for updates"); text recognition files (when you use OCR) | Nothing — PDFs, file names and edits stay on the device |
| Web version installed as an app (PWA) | Same as above; it starts from the copy saved on the device | Nothing |
| Downloaded HTML file | Nothing — it makes no connections | Nothing |

The server can see that files were requested (IP address, time, which file). The browser itself may also re-read the service worker file to manage the saved app. The service worker (`sw.js`) is produced by the site's build, not by this repository; it is served with each edition at `https://washipdf.com/app/<edition>/sw.js` (for example `/app/ja/sw.js`), where anyone can read it. It only stores and serves the app's own files from the same site.

**Hosted vs. downloaded.** The hosting server only sees that the app was opened (IP and time). Because every feature is in one file, it cannot tell which tool you used (the exception is text recognition, see above). However, trusting a hosted app means trusting its host on every update — if the repository or hosting account were compromised, the whole HTML (including its CSP) could be replaced. **For confidential documents, use the downloaded file from Releases** after checking its SHA-256, or put the verified file on your own intranet server.

## Downloads and verification

- **The official downloads are the HTML files attached to the versioned releases (`vX.Y.Z`) on this repository's [Releases](https://github.com/chemlsci/washipdf/releases) page**, each with SHA-256 and build provenance. The official web version is [washipdf.com](https://washipdf.com).
  ```
  sha256sum <file>                                # Linux
  shasum -a 256 <file>                            # macOS
  certutil -hashfile <file> SHA256                # Windows
  gh attestation verify <file> --repo chemlsci/washipdf   # proves it was built by this repository's CI
  ```
- **You can check a download before you open it.** The release files are built by GitHub's CI from the source in this repository, and each build is recorded with a signature in a public log (build provenance). `gh attestation verify` shows which commit a file was built from and exposes a file replaced by hand; if you downloaded it directly from Releases, you can normally just use it. For a copy you received from someone else, compare its SHA-256 with the value on the release.
- No Docker image is provided.

**Trademark:** the software is Apache-2.0, which does not grant trademark rights. The name "Washi PDF" and its logo are for official builds only; please use a different name for modified versions (see `NOTICE`).

## Design choices

- **Licence**: Apache-2.0; bundled parts are under permissive licences only (MIT, Apache-2.0, BSD, ISC, 0BSD, Zlib, OFL; no GPL / LGPL / AGPL / MPL)
- **Distribution**: one HTML file, double-click to run; no server, Docker or HTTPS needed
- **Network**: your PDFs and what you type are never sent. The downloaded file makes no network requests; the web version only receives the app, updates and text-recognition data from washipdf.com. Everything, including fonts and WASM, is bundled; the CSP forbids connections; CI checks this statically and in a real browser (Playwright)
- **Japanese text editing**: kinsoku line breaking, Japanese glyphs (BIZ UD fonts), font fallback, reuse of the original font

The focus is on the quality of fixing text in Japanese PDFs and on a permissive licence, a single HTML file and never sending your PDFs anywhere, rather than on the number of features.

## Build

Only builders need Node.js 22.13 or later. Build from a git clone of the release tag: the commit id is embedded in the file, so a build from a source archive without git history has a different SHA-256.

```bash
npm ci
npm run build        # → dist/washi-pdf.html (ja edition)
node scripts/build.mjs --fonts=intl --out=dist/washi-pdf-en.html   # font packs: ja, intl (the `en` edition), zh-CN, zh-TW, ko, all; also latin
```

| Command | Purpose |
| --- | --- |
| `npm run dev` | Rebuild on every save |
| `npm test` | Automated tests (text replaced in the file, no pixel changes outside edits, reload, kinsoku, annotations, encryption interop, …) |
| `npm run e2e` | Open the built HTML from `file://` in Playwright and run full editing flows, checking that no network request is made |
| `npm run licenses` | License check (fails on forbidden or unknown licenses) |
| `npm run check-offline` | Static check that the build loads nothing external |
| `node scripts/build-release.mjs v1.2.3` | Build the six release files, SHA-256 and bilingual release notes into `out/` |

## CI

| Workflow | Purpose |
| --- | --- |
| `build.yml` | On every push / PR: type check → license check → font check → tests → build → zero-network checks (static + Playwright in Chromium). A second job runs a walk-through in Firefox and WebKit (it does not block the build). |
| `release.yml` | On a `v*` tag (it must match the version in `package.json`): builds the six editions, `SHA256SUMS.txt` and build provenance, and creates a draft Release that is published after review |
| `gitleaks.yml` | Secret scanning |


This repository receives one commit per release; development happens elsewhere (see [CONTRIBUTING.md](CONTRIBUTING.md)).

## How it works (short)

- **Single file:** `scripts/build.mjs` (esbuild) inlines the app, the pdf.js worker, CMaps, WASM and font packs into one HTML, gzip-compressed and base64-encoded (restored when the app opens; the HTML is about half the size of embedding the fonts as they are). Fonts are subset by our own TrueType subsetter (`src/lib/ttfSubset.ts`) when saving.
- **Real text editing:** our own content-stream tokenizer maps each text operator (`Tj` / `TJ` / `'` / `"`) to the lines pdf.js reports, removes the edited operators and writes new text in the original box (`src/lib/textEdit.ts`, `src/lib/layout.ts`).

## Limitations

- A digitally signed PDF loses its signature when it is saved (the content changes). Certificate-encrypted PDFs cannot be opened.
- Signatures placed with the app are images on the page, not certificate-based digital signatures.
- Text is rewritten line by line or within one paragraph box; there is no reflow across paragraphs or pages.
- Vertical text can be rewritten when it is written with a vertical encoding (Identity-V and the like). Vertical text that a browser's print function or LibreOffice produces by placing horizontal glyphs one below another may not be grouped into columns correctly (redaction, annotations and page operations still work).
- Right after you rotate a page that is stored sideways so that it reads upright, its existing text cannot be rewritten. Save the file and open it again to rewrite it.
- Conformance marks such as PDF/A are not carried over to the saved file (an edited document may no longer conform). Layer visibility, links inside the document, bookmark positions and the opening view are carried over.
- Lines the app cannot rebuild (unknown font encodings, some complex scripts, see the table above) can only be covered and retyped; the app says so before you edit.
- Redaction removes text, images and vector shapes under the box; content that is only hidden by a clipping path or drawn by a shading is covered, and the app warns about it.
- Work in progress (the opened PDF itself and your edits) is saved automatically in the browser's IndexedDB so that it can be restored (in the web version; in the downloaded HTML file autosave is off until you turn it on in “About Washi PDF”). It is deleted when you close the document, and when the app is next opened more than 7 days after the last autosave (until then it stays in the browser). PDFs opened with a password, and documents larger than 400 MB, are not autosaved. Only one tab autosaves at a time; other tabs say so. Passwords are never autosaved: after a restore, set password protection again before saving. Anyone who uses the same browser can see it from the restore prompt, and when you open the HTML file directly, other HTML files opened in the same browser may be able to read it. On a shared computer, or for sensitive documents, turn autosave off in “About Washi PDF”.
- Invisible text (such as an OCR layer), text used as a clipping path and text inside form XObjects nested more than 6 levels deep cannot be rewritten in place; it is covered and retyped (shown with an orange frame).
- Non-embedded Japanese fonts that use a predefined CMap (such as `90ms-RKSJ-H`) can be shown and searched, but new text is written in a bundled font.
- Arabic and Hebrew are written in visual order, with the reading order added as `/ActualText`; software that ignores it may show the letters of a word reversed.
- Text recognition (OCR) exists only in the web version.
- When comparing documents, pages without text information (scans) are compared by appearance only, so a change of a short word may not be found. In documents over 40 pages, graphic and image differences are screened at a reduced size, so very small ones may be missed (over 1,000 pages, only the page you are viewing is checked). On pages with text, text is compared as text, so a change of only its color or position is not reported; the highlight positions on the page are approximate.
- Compression does not re-encode to JBIG2 or JPEG 2000.
- Very heavy pages (millions of drawing operations, content streams of tens of MB, deeply repeated form XObjects) can make the app very slow or stop the tab, especially on phones. Pages are drawn at a lower resolution when zooming in would exceed the browser's canvas limit (they look slightly blurred instead of blank).

See [README.ja.md](README.ja.md) for the detailed design notes.

## Support

Washi PDF is free and stays free. If it saves you time, you can support its development on [Ko-fi](https://ko-fi.com/chemlsci). It is entirely optional: the app works the same either way, and supporters get no extra features.

## License

- This software: Apache License 2.0 (`LICENSE`, `NOTICE`)
- Bundled components: `THIRD_PARTY_LICENSES` (pdf.js: Apache-2.0, pdf-lib: MIT, React: MIT, pako: MIT AND Zlib, Adobe CMaps: BSD-3-Clause, OpenJPEG: BSD-2-Clause, JBIG2 (PDFium): BSD-3-Clause, qcms: MIT, Foxit symbol fonts (PDFium): BSD-3-Clause, BIZ UD and Noto fonts: OFL-1.1, …)

Please do not add real-world PDFs to the repository, even for tests. `test/fixtures/` contains only self-made files (most are generated by `npm run make-fixtures`; the others by the scripts in `test/`, LibreOffice or Chromium from text written for the tests).

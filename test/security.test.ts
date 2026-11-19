import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PDFDocument } from "pdf-lib";
import { Aes } from "@/lib/crypto/aes";
import { md5 } from "@/lib/crypto/md5";
import { rc4 } from "@/lib/crypto/rc4";
import { defaultSettings } from "@/lib/docOps";
import { buildPdf } from "@/lib/exportPdf";
import { PasswordError, type SecuritySettings, unlockPdf } from "@/lib/security";
import { fixtures, loadSource, openPdf, pageText } from "./helpers";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const utf8 = (s: string) => new TextEncoder().encode(s);

test("暗号プリミティブ：MD5・RC4 の既知ベクタ、AES-CBC は WebCrypto と一致", async () => {
  assert.equal(hex(md5(utf8(""))), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(hex(md5(utf8("abc"))), "900150983cd24fb0d6963f7d28e17f72");
  assert.equal(hex(md5(utf8("The quick brown fox jumps over the lazy dog"))), "9e107d9d372bb6826bd81d3542a419d6");
  assert.equal(hex(rc4(utf8("Key"), utf8("Plaintext"))), "bbf316e8d940af0ad3");
  // FIPS-197 C.1 / C.3 の例
  const k128 = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
  const pt = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const out = new Uint8Array(16);
  new Aes(k128).encryptBlock(pt, 0, out, 0);
  assert.equal(hex(out), "69c4e0d86a7b0430d8cdb78070b4c55a");
  const k256 = Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex");
  new Aes(k256).encryptBlock(pt, 0, out, 0);
  assert.equal(hex(out), "8ea2b7ca516745bfeafc49904b496089");
  const back = new Uint8Array(16);
  new Aes(k256).decryptBlock(out, 0, back, 0);
  assert.equal(hex(back), hex(pt));
  // CBC（詰め物あり）を WebCrypto と突き合わせる
  for (const bits of [128, 256] as const) {
    const key = crypto.getRandomValues(new Uint8Array(bits / 8));
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const data = crypto.getRandomValues(new Uint8Array(1000 + bits));
    const ck = await crypto.subtle.importKey("raw", key, "AES-CBC", false, ["encrypt", "decrypt"]);
    const want = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, ck, data));
    const got = new Aes(key).cbcEncrypt(iv, data, true);
    assert.equal(hex(got), hex(want), `AES-${bits} CBC encrypt`);
    assert.equal(hex(new Aes(key).cbcDecrypt(iv, want, true)), hex(data), `AES-${bits} CBC decrypt`);
  }
});

const ENC_FIXTURES = [
  { file: "enc-rc4-40.pdf", method: "RC4 40bit" },
  { file: "enc-rc4-128.pdf", method: "RC4 128bit" },
  { file: "enc-aes-128.pdf", method: "AES-128" },
  { file: "enc-aes-256.pdf", method: "AES-256" },
];

for (const f of ENC_FIXTURES) {
  test(`解錠：${f.file}（pypdf で暗号化）を閲覧・権限パスワードで開ける`, async () => {
    const bytes = new Uint8Array(readFileSync(join(fixtures, f.file)));
    await assert.rejects(unlockPdf(bytes, "wrong"), (e: unknown) => e instanceof PasswordError);
    await assert.rejects(unlockPdf(bytes, ""), (e: unknown) => e instanceof PasswordError);
    const user = await unlockPdf(bytes, "user");
    assert.ok(user.info && !user.info.owner && user.info.hadUserPassword);
    assert.equal(user.info?.method, f.method);
    const owner = await unlockPdf(bytes, "owner");
    assert.ok(owner.info?.owner);
    // 復号した結果は暗号化の無い普通の PDF：pdf-lib がそのまま読め、pdf.js で文字が取れる
    const lib = await PDFDocument.load(user.bytes);
    assert.equal(lib.isEncrypted, false);
    assert.equal(lib.getPageCount(), 1);
    const pdf = await openPdf(user.bytes);
    const text = await pageText(pdf, 1);
    assert.ok(text.includes("株式会社サンプル商事"), text.slice(0, 80));
    assert.ok(text.includes("本書は自動テスト用に生成した架空の文書です。"), text);
  });
}

test("解錠：閲覧パスワード無し（権限のみ）の PDF は空パスワードで開け、権限が読める", async () => {
  const bytes = new Uint8Array(readFileSync(join(fixtures, "enc-owner-only.pdf")));
  const r = await unlockPdf(bytes, "");
  assert.ok(r.info && !r.info.owner && !r.info.hadUserPassword);
  assert.deepEqual(r.info?.permissions, { print: false, modify: false, copy: true, annotate: false });
  const o = await unlockPdf(bytes, "owner");
  assert.ok(o.info?.owner && !o.info.hadUserPassword);
  assert.ok((await pageText(await openPdf(r.bytes), 1)).includes("株式会社サンプル商事"));
});

test("解錠した PDF をアプリの経路で読み込み、文字の編集に必要な解析ができる", async () => {
  const bytes = new Uint8Array(readFileSync(join(fixtures, "enc-aes-256.pdf")));
  const { bytes: plain } = await unlockPdf(bytes, "user");
  const tmp = join(fixtures, "..", "..", "dist", ".test", "unlocked.pdf");
  writeFileSync(tmp, plain);
  const { doc, pages } = await loadSource(tmp);
  const { getPageText } = await import("@/lib/textRuns");
  const { runs, pageError } = await getPageText(doc, pages[0]);
  assert.equal(pageError, null);
  assert.ok(runs.some((r) => r.text.includes("株式会社サンプル商事") && r.editable), runs.map((r) => r.text).join("|"));
});

for (const method of ["aes256", "rc4"] as const) {
  test(`保護：${method} で暗号化して保存した PDF を pdf.js が開け、権限が反映される`, async () => {
    const { doc, pages } = await loadSource(join(fixtures, "ja-subset-identity.pdf"));
    // 旧式（RC4）のパスワードは Latin-1 の範囲だけ。AES-256 は UTF-8 なので日本語も使える
    const userPw = method === "rc4" ? "see-it" : "みる";
    const ownerPw = method === "rc4" ? "owner-secret" : "owner-秘密";
    const security: SecuritySettings = { enabled: true, userPassword: userPw, ownerPassword: ownerPw, method, permissions: { print: false, modify: false, copy: true, annotate: false } };
    const settings = { ...defaultSettings(), security };
    const bytes = await buildPdf(pages, new Map([[doc.id, doc]]), new Map(), { settings });
    // 暗号化されている（pdf-lib は ignoreEncryption 無しでは拒否する）
    await assert.rejects(PDFDocument.load(bytes), /encrypted/i);
    // pdf.js：パスワード無しは拒否、閲覧パスワードで開ける
    await assert.rejects(openPdf(bytes), (e: unknown) => (e as Error).name === "PasswordException");
    await assert.rejects(openPdf(bytes, "wrong"), (e: unknown) => (e as Error).name === "PasswordException");
    const pdf = await openPdf(bytes, userPw);
    assert.equal(pdf.numPages, 1);
    assert.ok((await pageText(pdf, 1)).includes("株式会社サンプル商事"));
    // pdf.js の版によって、配列か Set で返る
    const perms = [...((await pdf.getPermissions()) ?? [])];
    assert.ok(perms && !perms.includes(4) && perms.includes(16), JSON.stringify(perms));
    // 権限パスワードでも開ける（pdf.js）
    const pdf2 = await openPdf(bytes, ownerPw);
    assert.equal(pdf2.numPages, 1);
    // 自分の解錠処理でも往復できる
    const r = await unlockPdf(bytes, ownerPw);
    assert.ok(r.info?.owner && r.info.hadUserPassword);
    assert.equal(r.info?.method, method === "aes256" ? "AES-256" : "RC4 128bit");
    assert.deepEqual(r.info?.permissions, security.permissions);
    assert.ok((await pageText(await openPdf(r.bytes), 1)).includes("株式会社サンプル商事"));
    // 文書情報も暗号化されて読める
    const meta = await pdf.getMetadata();
    assert.equal((meta.info as { Producer?: string }).Producer, "Washi PDF (pdf-lib)");

    // 他実装（pypdf）でも開ける。python3 と pypdf が無ければ飛ばす
    const tmp = join(fixtures, "..", "..", "dist", ".test", `protected-${method}.pdf`);
    writeFileSync(tmp, bytes);
    const py = spawnSync("python3", ["-I", "-c", `
import sys
try:
    from pypdf import PdfReader
except Exception:
    print("SKIP"); sys.exit(0)
r = PdfReader(sys.argv[1])
assert r.is_encrypted
assert r.decrypt(sys.argv[2]) > 0, "user password rejected"
print(r.pages[0].extract_text())
`, tmp, userPw], { encoding: "utf-8" });
    if (py.status === 0 && !py.stdout.startsWith("SKIP")) assert.ok(py.stdout.includes("株式会社サンプル商事"), py.stdout.slice(0, 200));
    else if (py.status !== 0) assert.fail(py.stderr);
  });
}

test("保護：閲覧パスワード無し・権限パスワードのみでも保存でき、空パスワードで開ける", async () => {
  const { doc, pages } = await loadSource(join(fixtures, "ja-subset-identity.pdf"));
  const settings = { ...defaultSettings(), security: { enabled: true, userPassword: "", ownerPassword: "o", method: "aes256" as const, permissions: { print: true, modify: false, copy: false, annotate: true } } };
  const bytes = await buildPdf(pages, new Map([[doc.id, doc]]), new Map(), { settings });
  const pdf = await openPdf(bytes);
  assert.equal(pdf.numPages, 1);
  const r = await unlockPdf(bytes, "");
  assert.ok(r.info && !r.info.owner && !r.info.hadUserPassword);
  assert.deepEqual(r.info?.permissions, settings.security.permissions);
});

test("読み込み経路：パスワード入力の問い合わせ → 解錠 → SourceDoc に保護情報が残る", async () => {
  const { loadPdfFile } = await import("@/lib/loader");
  const bytes = new Uint8Array(readFileSync(join(fixtures, "enc-rc4-128.pdf")));
  const fake = { name: "enc-rc4-128.pdf", type: "application/pdf", arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } as unknown as File;
  const asked: boolean[] = [];
  const answers = ["nope", "user"];
  const { doc, pages } = await loadPdfFile(fake, async (_name, retry) => {
    asked.push(retry);
    return answers.shift() ?? null;
  });
  assert.deepEqual(asked, [false, true], "1 回目は retry=false、2 回目は retry=true");
  assert.equal(pages.length, 1);
  assert.equal(doc.security?.method, "RC4 128bit");
  assert.equal(doc.security?.hadUserPassword, true);
  assert.equal(await PDFDocument.load(doc.bytes).then((d) => d.isEncrypted), false, "保持するバイト列は復号済み");
  // 中止
  await assert.rejects(loadPdfFile(fake, async () => null), /中止|cancelled/);
  // 問い合わせ無しなら従来どおりエラー
  await assert.rejects(loadPdfFile(fake), /パスワード|password/);
});

test("AES-256 のパスワード：見えない文字は除き、ASCII 以外の空白は半角の空白にしてから NFKC にそろえる（SASLprep）", async () => {
  const { saslPrep } = await import("@/lib/security");
  assert.equal(saslPrep("ab­cd"), "abcd");
  assert.equal(saslPrep("a​b﻿c"), "abc");
  assert.equal(saslPrep("pass word　x"), "pass word x");
  assert.equal(saslPrep("ＡＢＣ１２３"), "ABC123");
  assert.equal(saslPrep("plain-ascii!"), "plain-ascii!");
});

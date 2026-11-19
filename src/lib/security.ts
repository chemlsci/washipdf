/**
 * PDF の標準セキュリティハンドラ（ISO 32000-1 §7.6 / 32000-2 §7.6.4）。
 *
 * - 読み込み：RC4 40/128 ビット（R2〜R4）、AES-128（AESV2）、AES-256（R5/R6）を復号し、
 *   暗号化の無い通常の PDF バイト列に直す。以後は pdf.js も pdf-lib も普通に扱える。
 * - 書き出し：AES-256（R6）または RC4 128 ビット（R3）で暗号化し、閲覧・権限パスワードと
 *   権限ビット（印刷・変更・コピー・注釈）を付ける。
 *
 * 復号は pdf-lib のパーサを継承して「オブジェクトを読んだ直後、オブジェクトストリームを展開する前」に
 * 行う。これで ObjStm の中身も正しく読める。pdf-lib 自体には暗号化の読み書きが無い。
 */
import {
  PDFArray,
  type PDFContext,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  type PDFObject,
  PDFObjectStreamParser,
  PDFParser,
  PDFRawStream,
  type PDFRef,
  PDFStream,
  PDFString,
  PDFXRefStreamParser,
} from "pdf-lib";
import { Aes, aesDecryptWithIv, aesEncryptWithIv } from "./crypto/aes";
import { md5 } from "./crypto/md5";
import { rc4 } from "./crypto/rc4";
import { concat, randomBytes, sha } from "./crypto/sha";

/* ---------- 設定 ---------- */

export type EncryptMethod = "aes256" | "rc4";

export interface Permissions {
  print: boolean;
  modify: boolean;
  copy: boolean;
  annotate: boolean;
}

export interface SecuritySettings {
  enabled: boolean;
  /** 開くためのパスワード（空なら誰でも開ける） */
  userPassword: string;
  /** 権限を変更するためのパスワード（空なら閲覧パスワードと同じにする） */
  ownerPassword: string;
  method: EncryptMethod;
  permissions: Permissions;
}

export const ALL_PERMISSIONS: Permissions = { print: true, modify: true, copy: true, annotate: true };

export function defaultSecurity(): SecuritySettings {
  return { enabled: false, userPassword: "", ownerPassword: "", method: "aes256", permissions: { ...ALL_PERMISSIONS } };
}

/** 元 PDF がどう保護されていたか（解除後に表示する） */
export interface SecurityInfo {
  /** 例 "AES-256", "RC4 128bit" */
  method: string;
  /** 権限パスワードで開いたか */
  owner: boolean;
  permissions: Permissions;
  /** 閲覧パスワードが設定されていた（空では開けなかった） */
  hadUserPassword: boolean;
}

export class PasswordError extends Error {
  constructor() {
    super("password");
    this.name = "PasswordError";
  }
}

export class UnsupportedEncryptionError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "UnsupportedEncryptionError";
  }
}

/* ---------- 権限ビット（表 22） ---------- */

const P_PRINT = 1 << 2;
const P_MODIFY = 1 << 3;
const P_COPY = 1 << 4;
const P_ANNOTATE = 1 << 5;
const P_FILL = 1 << 8;
const P_ACCESS = 1 << 9;
const P_ASSEMBLE = 1 << 10;
const P_PRINT_HQ = 1 << 11;
/** 1〜2 ビットは 0、7〜8 と 13〜32 ビットは 1 と決まっている */
const P_BASE = 0xfffff0c0 | 0;

export function permissionsToP(perm: Permissions): number {
  let p = P_BASE | P_ACCESS; // 読み上げ支援の抽出は常に許す
  if (perm.print) p |= P_PRINT | P_PRINT_HQ;
  if (perm.modify) p |= P_MODIFY | P_ASSEMBLE;
  if (perm.copy) p |= P_COPY;
  if (perm.annotate) p |= P_ANNOTATE | P_FILL;
  return p | 0;
}

export function permissionsFromP(p: number): Permissions {
  return { print: !!(p & P_PRINT), modify: !!(p & P_MODIFY), copy: !!(p & P_COPY), annotate: !!(p & P_ANNOTATE) };
}

/* ---------- Encrypt 辞書の読み取り ---------- */

type Cfm = "none" | "rc4" | "aesv2" | "aesv3";

interface EncryptInfo {
  ref: PDFRef | null;
  v: number;
  r: number;
  lengthBytes: number;
  o: Uint8Array;
  u: Uint8Array;
  oe: Uint8Array;
  ue: Uint8Array;
  p: number;
  encryptMetadata: boolean;
  stmf: Cfm;
  strf: Cfm;
  id0: Uint8Array;
}

const EMPTY = new Uint8Array(0);

function strBytes(o: PDFObject | undefined): Uint8Array {
  if (o instanceof PDFString || o instanceof PDFHexString) return o.asBytes();
  return EMPTY;
}

function readEncryptInfo(ctx: PDFContext): EncryptInfo | null {
  const raw = ctx.trailerInfo.Encrypt;
  if (!raw) return null;
  const dict = ctx.lookup(raw);
  if (!(dict instanceof PDFDict)) return null;
  const name = (k: string) => {
    const v = dict.lookup(PDFName.of(k));
    return v instanceof PDFName ? v.decodeText() : undefined;
  };
  const num = (k: string, def: number) => {
    const v = dict.lookup(PDFName.of(k));
    return v instanceof PDFNumber ? v.asNumber() : def;
  };
  const filter = name("Filter");
  if (filter !== "Standard") throw new UnsupportedEncryptionError(`filter ${filter ?? "?"}`);
  const v = num("V", 0);
  const r = num("R", v >= 5 ? 6 : v >= 4 ? 4 : v >= 2 ? 3 : 2);
  let lengthBytes = v === 1 ? 5 : Math.max(5, Math.min(32, Math.round(num("Length", 40) / 8)));
  let stmf: Cfm = "rc4";
  let strf: Cfm = "rc4";
  if (v >= 4) {
    const cf = dict.lookup(PDFName.of("CF"));
    const resolve = (which: string): Cfm => {
      const n = name(which) ?? "Identity";
      if (n === "Identity") return "none";
      const f = cf instanceof PDFDict ? cf.lookup(PDFName.of(n)) : undefined;
      if (!(f instanceof PDFDict)) return "none";
      const cfm = f.lookup(PDFName.of("CFM"));
      const cfmName = cfm instanceof PDFName ? cfm.decodeText() : "None";
      const len = f.lookup(PDFName.of("Length"));
      if (len instanceof PDFNumber) {
        const l = len.asNumber();
        lengthBytes = l > 40 ? Math.round(l / 8) : l; // バイトで書く実装とビットで書く実装の両方がある
      }
      if (cfmName === "AESV2") return "aesv2";
      if (cfmName === "AESV3") return "aesv3";
      if (cfmName === "V2") return "rc4";
      if (cfmName === "None") return "none";
      throw new UnsupportedEncryptionError(`CFM ${cfmName}`);
    };
    stmf = resolve("StmF");
    strf = resolve("StrF");
  }
  if (v >= 5) lengthBytes = 32;
  const em = dict.lookup(PDFName.of("EncryptMetadata"));
  const encryptMetadata = !(em && "asBoolean" in em && typeof em.asBoolean === "function" && em.asBoolean() === false);
  const idArr = ctx.lookup(ctx.trailerInfo.ID);
  const id0 = idArr instanceof PDFArray && idArr.size() > 0 ? strBytes(ctx.lookup(idArr.get(0))) : EMPTY;
  return {
    ref: raw instanceof PDFDict ? null : (raw as PDFRef),
    v,
    r,
    lengthBytes,
    o: strBytes(dict.lookup(PDFName.of("O"))),
    u: strBytes(dict.lookup(PDFName.of("U"))),
    oe: strBytes(dict.lookup(PDFName.of("OE"))),
    ue: strBytes(dict.lookup(PDFName.of("UE"))),
    p: num("P", -1) | 0,
    encryptMetadata,
    stmf,
    strf,
    id0,
  };
}

function describe(info: EncryptInfo): string {
  if (info.r >= 5) return "AES-256";
  if (info.stmf === "aesv2") return "AES-128";
  return `RC4 ${info.lengthBytes * 8}bit`;
}

/* ---------- 鍵の計算（R2〜R4：MD5 + RC4） ---------- */

const PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

/** 旧式はパスワードを 1 文字 1 バイト（Latin-1 相当）で扱う */
function padPassword(pw: string): Uint8Array {
  const out = new Uint8Array(32);
  const n = Math.min(32, pw.length);
  for (let i = 0; i < n; i++) out[i] = pw.charCodeAt(i) & 0xff;
  out.set(PAD.subarray(0, 32 - n), n);
  return out;
}

function legacyKey(padded: Uint8Array, info: EncryptInfo): Uint8Array {
  const pBytes = new Uint8Array(4);
  new DataView(pBytes.buffer).setInt32(0, info.p, true);
  let input = concat(padded, info.o.subarray(0, 32), pBytes, info.id0);
  if (info.r >= 4 && !info.encryptMetadata) input = concat(input, Uint8Array.from([0xff, 0xff, 0xff, 0xff]));
  let hash = md5(input);
  const n = info.r === 2 ? 5 : info.lengthBytes;
  if (info.r >= 3) for (let i = 0; i < 50; i++) hash = md5(hash.subarray(0, n));
  return hash.slice(0, n);
}

const xorKey = (key: Uint8Array, i: number) => key.map((b) => b ^ i);

function computeU(key: Uint8Array, info: EncryptInfo): Uint8Array {
  if (info.r === 2) return rc4(key, PAD);
  let x = rc4(key, md5(concat(PAD, info.id0)));
  for (let i = 1; i <= 19; i++) x = rc4(xorKey(key, i), x);
  return concat(x, new Uint8Array(16));
}

function ownerRc4Key(ownerPadded: Uint8Array, info: EncryptInfo): Uint8Array {
  let hash = md5(ownerPadded);
  const n = info.r === 2 ? 5 : info.lengthBytes;
  if (info.r >= 3) for (let i = 0; i < 50; i++) hash = md5(hash);
  return hash.slice(0, n);
}

function computeO(ownerPadded: Uint8Array, userPadded: Uint8Array, info: EncryptInfo): Uint8Array {
  const key = ownerRc4Key(ownerPadded, info);
  let x = rc4(key, userPadded);
  if (info.r >= 3) for (let i = 1; i <= 19; i++) x = rc4(xorKey(key, i), x);
  return x;
}

function userPasswordFromOwner(ownerPadded: Uint8Array, info: EncryptInfo): Uint8Array {
  const key = ownerRc4Key(ownerPadded, info);
  if (info.r === 2) return rc4(key, info.o.subarray(0, 32));
  let x: Uint8Array = info.o.slice(0, 32);
  for (let i = 19; i >= 0; i--) x = rc4(xorKey(key, i), x);
  return x;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

function authLegacy(info: EncryptInfo, password: string): { key: Uint8Array; owner: boolean } | null {
  const check = (padded: Uint8Array) => {
    const key = legacyKey(padded, info);
    const u = computeU(key, info);
    const n = info.r === 2 ? 32 : 16;
    return equal(u.subarray(0, n), info.u.subarray(0, n)) ? key : null;
  };
  const padded = padPassword(password);
  let key = check(padded);
  if (key) return { key, owner: false };
  key = check(userPasswordFromOwner(padded, info));
  if (key) return { key, owner: true };
  return null;
}

/* ---------- 鍵の計算（R5/R6：SHA-256 系） ---------- */

const ZERO16 = new Uint8Array(16);

/**
 * AES-256 のパスワードの正規化（PDF 2.0 が定める SASLprep の、文字の置き換えの部分）。
 * 見えない文字（ソフトハイフン・幅のない空白・異体字の選択子など）は取り除き、ASCII 以外の空白は半角の空白にしてから NFKC にそろえる。
 * これをしないと、パスワードにそうした文字が入っているとき、規格どおりのソフト（Acrobat・qpdf など）で開けない
 */
export function saslPrep(pw: string): string {
  return pw
    .replace(/[\u00ad\u034f\u1806\u180b-\u180d\u200b-\u200d\u2060\ufe00-\ufe0f\ufeff]/g, "")
    .replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, " ")
    .normalize("NFKC");
}

/** SASLprep で正規化した UTF-8（127 バイトまで） */
function utf8Password(pw: string): Uint8Array {
  return new TextEncoder().encode(saslPrep(pw)).subarray(0, 127);
}

/** アルゴリズム 2.B（R6）。R5 は単純な SHA-256 */
async function hash2B(pw: Uint8Array, salt: Uint8Array, udata: Uint8Array, r: number): Promise<Uint8Array> {
  let k = await sha(256, concat(pw, salt, udata));
  if (r === 5) return k;
  let i = 0;
  for (;;) {
    const unit = concat(pw, k, udata);
    const k1 = new Uint8Array(unit.length * 64);
    for (let j = 0; j < 64; j++) k1.set(unit, j * unit.length);
    const e = new Aes(k.subarray(0, 16)).cbcEncrypt(k.subarray(16, 32), k1, false);
    let sum = 0;
    for (let j = 0; j < 16; j++) sum += e[j];
    const mod = sum % 3;
    k = await sha(mod === 0 ? 256 : mod === 1 ? 384 : 512, e);
    i++;
    if (i >= 64 && e[e.length - 1] <= i - 32) break;
  }
  return k.subarray(0, 32);
}

async function authR6(info: EncryptInfo, password: string): Promise<{ key: Uint8Array; owner: boolean } | null> {
  if (info.u.length < 48 || info.o.length < 48 || info.ue.length < 32 || info.oe.length < 32) throw new UnsupportedEncryptionError("broken AES-256 dictionary");
  const pw = utf8Password(password);
  const u = info.u;
  const o = info.o;
  if (equal(await hash2B(pw, u.subarray(32, 40), EMPTY, info.r), u.subarray(0, 32))) {
    const ik = await hash2B(pw, u.subarray(40, 48), EMPTY, info.r);
    return { key: new Aes(ik).cbcDecrypt(ZERO16, info.ue.subarray(0, 32), false), owner: false };
  }
  if (equal(await hash2B(pw, o.subarray(32, 40), u.subarray(0, 48), info.r), o.subarray(0, 32))) {
    const ik = await hash2B(pw, o.subarray(40, 48), u.subarray(0, 48), info.r);
    return { key: new Aes(ik).cbcDecrypt(ZERO16, info.oe.subarray(0, 32), false), owner: true };
  }
  return null;
}

/* ---------- オブジェクト単位の暗号・復号 ---------- */

const SALT_AES = Uint8Array.from([0x73, 0x41, 0x6c, 0x54]);

function toHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

class ObjectCipher {
  constructor(
    private readonly key: Uint8Array,
    private readonly stmf: Cfm,
    private readonly strf: Cfm,
    private readonly r: number,
    private readonly encryptMetadata: boolean,
  ) {}

  /** アルゴリズム 1：オブジェクト番号・世代番号から個別鍵を作る（AES-256 は文書鍵をそのまま使う） */
  private objectKey(ref: PDFRef, aes: boolean): Uint8Array {
    if (this.r >= 5) return this.key;
    const n = ref.objectNumber;
    const g = ref.generationNumber;
    const extra = Uint8Array.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, g & 0xff, (g >> 8) & 0xff]);
    const hash = md5(aes ? concat(this.key, extra, SALT_AES) : concat(this.key, extra));
    return hash.subarray(0, Math.min(this.key.length + 5, 16));
  }

  private bytes(data: Uint8Array, ref: PDFRef, cfm: Cfm, encrypt: boolean): Uint8Array {
    switch (cfm) {
      case "none":
        return data;
      case "rc4":
        return rc4(this.objectKey(ref, false), data);
      case "aesv2":
        return encrypt ? aesEncryptWithIv(this.objectKey(ref, true), data) : aesDecryptWithIv(this.objectKey(ref, true), data);
      case "aesv3":
        return encrypt ? aesEncryptWithIv(this.key, data) : aesDecryptWithIv(this.key, data);
    }
  }

  /** オブジェクトの中の文字列とストリーム本体を変換する。辞書・配列はその場で書き換え、文字列とストリームは新しいオブジェクトを返す */
  transform(obj: PDFObject, ref: PDFRef, encrypt: boolean): PDFObject {
    if (obj instanceof PDFString || obj instanceof PDFHexString) {
      return PDFHexString.of(toHex(this.bytes(obj.asBytes(), ref, this.strf, encrypt)));
    }
    if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) obj.set(i, this.transform(obj.get(i), ref, encrypt));
      return obj;
    }
    if (obj instanceof PDFStream) {
      const type = obj.dict.get(PDFName.of("Type"));
      if (type === PDFName.of("XRef")) return obj;
      this.transform(obj.dict, ref, encrypt);
      if (type === PDFName.of("Metadata") && !this.encryptMetadata) return obj;
      return PDFRawStream.of(obj.dict, this.bytes(obj.getContents(), ref, this.stmf, encrypt));
    }
    if (obj instanceof PDFDict) {
      for (const [k, v] of obj.entries()) obj.set(k, this.transform(v, ref, encrypt));
      return obj;
    }
    return obj;
  }
}

/* ---------- 復号しながら読むパーサ ---------- */

const ENDOBJ = [0x65, 0x6e, 0x64, 0x6f, 0x62, 0x6a];

class ScanParser extends PDFParser {
  cipher: ObjectCipher | null = null;
  encryptRef: PDFRef | null = null;
  expandObjectStreams = true;
  constructor(bytes: Uint8Array) {
    super(bytes, Infinity, false, false);
  }
}

// pdf-lib では private なので、プロトタイプに直接差し替える。中身は元の実装に復号を挟んだもの
(ScanParser.prototype as unknown as { parseIndirectObject: () => Promise<PDFRef> }).parseIndirectObject = async function (this: ScanParser) {
  // biome-ignore lint/suspicious/noExplicitAny: pdf-lib の非公開メソッドを呼ぶ
  const self = this as any;
  const ref: PDFRef = self.parseIndirectObjectHeader();
  self.skipWhitespaceAndComments();
  let object: PDFObject = self.parseObject();
  self.skipWhitespaceAndComments();
  self.matchKeyword(ENDOBJ);
  const type = object instanceof PDFRawStream ? object.dict.lookup(PDFName.of("Type")) : undefined;
  const isXref = type === PDFName.of("XRef");
  const isObjStm = type === PDFName.of("ObjStm");
  const isEncryptDict = this.encryptRef != null && ref.objectNumber === this.encryptRef.objectNumber && ref.generationNumber === this.encryptRef.generationNumber;
  if (this.cipher && !isXref && !isEncryptDict) object = this.cipher.transform(object, ref, false);
  if (isXref) PDFXRefStreamParser.forStream(object as PDFRawStream).parseIntoContext();
  else if (isObjStm && this.expandObjectStreams) await PDFObjectStreamParser.forStream(object as PDFRawStream, self.shouldWaitForTick).parseIntoContext();
  else this.context.assign(ref, object);
  return ref;
};

/* ---------- 公開 API ---------- */

/** 暗号化されていそうか（/Encrypt がバイト列に含まれるか）。読み込みのたびに全体を 2 回解析しないための前段チェック */
export function looksEncrypted(bytes: Uint8Array): boolean {
  const pat = [0x2f, 0x45, 0x6e, 0x63, 0x72, 0x79, 0x70, 0x74]; // "/Encrypt"
  outer: for (let i = 0; i <= bytes.length - pat.length; i++) {
    if (bytes[i] !== 0x2f) continue;
    for (let j = 1; j < pat.length; j++) if (bytes[i + j] !== pat[j]) continue outer;
    return true;
  }
  return false;
}

export interface UnlockResult {
  bytes: Uint8Array;
  info: SecurityInfo;
}

/**
 * パスワードで解錠し、暗号化を外した PDF バイト列を返す。
 * 暗号化されていなければ bytes をそのまま返し info は null。パスワードが違えば PasswordError。
 */
export async function unlockPdf(bytes: Uint8Array, password: string): Promise<{ bytes: Uint8Array; info: SecurityInfo | null }> {
  if (!looksEncrypted(bytes)) return { bytes, info: null };
  // 1 回目：Encrypt 辞書と ID を読む（オブジェクトストリームは展開しない。中身が暗号化されているため）
  const scan = new ScanParser(bytes);
  scan.expandObjectStreams = false;
  const ctx1 = await scan.parseDocument();
  const info = readEncryptInfo(ctx1);
  if (!info) return { bytes, info: null };
  const auth = info.r >= 5 ? await authR6(info, password) : authLegacy(info, password);
  if (!auth) throw new PasswordError();
  // 空パスワードで開けないなら、閲覧パスワードが掛かっていたということ
  const hadUserPassword = password !== "" && !(info.r >= 5 ? await authR6(info, "") : authLegacy(info, ""));

  // 2 回目：復号しながら読み直し、Encrypt を外して保存する
  const parser = new ScanParser(bytes);
  parser.cipher = new ObjectCipher(auth.key, info.stmf, info.strf, info.r, info.encryptMetadata);
  parser.encryptRef = info.ref;
  const ctx = await parser.parseDocument();
  ctx.trailerInfo.Encrypt = undefined;
  if (info.ref) ctx.delete(info.ref);
  const doc = new (PDFDocument as unknown as new (c: PDFContext, ignoreEncryption: boolean, updateMetadata: boolean) => PDFDocument)(ctx, false, false);
  const out = await doc.save({ useObjectStreams: true, updateFieldAppearances: false });
  return {
    bytes: out,
    info: { method: describe(info), owner: auth.owner, permissions: permissionsFromP(info.p), hadUserPassword },
  };
}

/**
 * pdf-lib 文書を暗号化する。この後は必ず `save({ useObjectStreams: false })` で保存すること
 * （オブジェクトストリームは保存時に作られるため、ここで暗号化できない）。
 */
export async function encryptDocument(doc: PDFDocument, s: SecuritySettings): Promise<void> {
  const ctx = doc.context;
  const id = randomBytes(16);
  ctx.trailerInfo.ID = ctx.obj([PDFHexString.of(toHex(id)), PDFHexString.of(toHex(id))]);
  const p = permissionsToP(s.permissions);
  const ownerPw = s.ownerPassword || s.userPassword;
  let dict: PDFDict;
  let cipher: ObjectCipher;
  if (s.method === "rc4") {
    const info: EncryptInfo = { ref: null, v: 2, r: 3, lengthBytes: 16, o: EMPTY, u: EMPTY, oe: EMPTY, ue: EMPTY, p, encryptMetadata: true, stmf: "rc4", strf: "rc4", id0: id };
    const userPadded = padPassword(s.userPassword);
    info.o = computeO(padPassword(ownerPw), userPadded, info);
    const key = legacyKey(userPadded, info);
    info.u = computeU(key, info);
    dict = ctx.obj({ Filter: "Standard", V: 2, R: 3, Length: 128, P: p, O: PDFHexString.of(toHex(info.o)), U: PDFHexString.of(toHex(info.u)) });
    cipher = new ObjectCipher(key, "rc4", "rc4", 3, true);
  } else {
    const key = randomBytes(32);
    const upw = utf8Password(s.userPassword);
    const opw = utf8Password(ownerPw);
    const uvs = randomBytes(8);
    const uks = randomBytes(8);
    const u = concat(await hash2B(upw, uvs, EMPTY, 6), uvs, uks);
    const ue = new Aes(await hash2B(upw, uks, EMPTY, 6)).cbcEncrypt(ZERO16, key, false);
    const ovs = randomBytes(8);
    const oks = randomBytes(8);
    const o = concat(await hash2B(opw, ovs, u, 6), ovs, oks);
    const oe = new Aes(await hash2B(opw, oks, u, 6)).cbcEncrypt(ZERO16, key, false);
    const block = new Uint8Array(16);
    new DataView(block.buffer).setInt32(0, p, true);
    block.fill(0xff, 4, 8);
    block.set([0x54, 0x61, 0x64, 0x62], 8); // 'T' (メタデータも暗号化), 'a', 'd', 'b'
    block.set(randomBytes(4), 12);
    const perms = new Aes(key).cbcEncrypt(ZERO16, block, false); // 1 ブロックの ECB と同じ
    dict = ctx.obj({
      Filter: "Standard",
      V: 5,
      R: 6,
      Length: 256,
      P: p,
      O: PDFHexString.of(toHex(o)),
      U: PDFHexString.of(toHex(u)),
      OE: PDFHexString.of(toHex(oe)),
      UE: PDFHexString.of(toHex(ue)),
      Perms: PDFHexString.of(toHex(perms)),
      CF: { StdCF: { AuthEvent: "DocOpen", CFM: "AESV3", Length: 32 } },
      StmF: "StdCF",
      StrF: "StdCF",
    });
    cipher = new ObjectCipher(key, "aesv3", "aesv3", 6, true);
  }
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    const n = cipher.transform(obj, ref, true);
    if (n !== obj) ctx.assign(ref, n);
  }
  ctx.trailerInfo.Encrypt = ctx.register(dict);
}

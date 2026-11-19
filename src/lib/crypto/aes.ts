/**
 * AES-128 / AES-256（FIPS 197）の純 JS 実装と CBC モード。
 * WebCrypto の AES-CBC はパディング無しの処理ができず、PDF の鍵導出（R6 の 2.B ハッシュや UE/OE の計算）に
 * 使えないため自前で持つ。同期処理なので pdf-lib のオブジェクト走査の中からそのまま呼べる。
 */

const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
{
  // GF(2^8) の逆元とアフィン変換で S-box を生成する
  let p = 1;
  let q = 1;
  do {
    p = (p ^ (p << 1) ^ (p & 0x80 ? 0x1b : 0)) & 0xff;
    q ^= q << 1;
    q ^= q << 2;
    q ^= q << 4;
    q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    const rotl = (x: number, n: number) => ((x << n) | (x >> (8 - n))) & 0xff;
    const x = q ^ rotl(q, 1) ^ rotl(q, 2) ^ rotl(q, 3) ^ rotl(q, 4);
    SBOX[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  SBOX[0] = 0x63;
  for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
}

const xtime = (x: number) => ((x << 1) ^ (x & 0x80 ? 0x1b : 0)) & 0xff;
const mul = (a: number, b: number) => {
  let r = 0;
  while (b) {
    if (b & 1) r ^= a;
    a = xtime(a);
    b >>= 1;
  }
  return r;
};
// MixColumns 用の乗算表
const M2 = new Uint8Array(256);
const M3 = new Uint8Array(256);
const M9 = new Uint8Array(256);
const M11 = new Uint8Array(256);
const M13 = new Uint8Array(256);
const M14 = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  M2[i] = mul(i, 2);
  M3[i] = mul(i, 3);
  M9[i] = mul(i, 9);
  M11[i] = mul(i, 11);
  M13[i] = mul(i, 13);
  M14[i] = mul(i, 14);
}

export class Aes {
  private readonly rounds: number;
  /** ラウンド鍵（16 バイト × (rounds+1)） */
  private readonly rk: Uint8Array;

  constructor(key: Uint8Array) {
    if (key.length !== 16 && key.length !== 24 && key.length !== 32) throw new Error(`AES key length ${key.length}`);
    const nk = key.length / 4;
    this.rounds = nk + 6;
    const words = 4 * (this.rounds + 1);
    const w = new Uint8Array(words * 4);
    w.set(key);
    let rcon = 1;
    for (let i = nk; i < words; i++) {
      let t0 = w[(i - 1) * 4];
      let t1 = w[(i - 1) * 4 + 1];
      let t2 = w[(i - 1) * 4 + 2];
      let t3 = w[(i - 1) * 4 + 3];
      if (i % nk === 0) {
        // RotWord → SubWord → 先頭バイトに Rcon
        const n0 = SBOX[t1] ^ rcon;
        const n1 = SBOX[t2];
        const n2 = SBOX[t3];
        const n3 = SBOX[t0];
        t0 = n0;
        t1 = n1;
        t2 = n2;
        t3 = n3;
        rcon = xtime(rcon);
      } else if (nk > 6 && i % nk === 4) {
        t0 = SBOX[t0];
        t1 = SBOX[t1];
        t2 = SBOX[t2];
        t3 = SBOX[t3];
      }
      const p = (i - nk) * 4;
      w[i * 4] = w[p] ^ t0;
      w[i * 4 + 1] = w[p + 1] ^ t1;
      w[i * 4 + 2] = w[p + 2] ^ t2;
      w[i * 4 + 3] = w[p + 3] ^ t3;
    }
    this.rk = w;
  }

  /** 1 ブロック（16 バイト）を暗号化して out に書く */
  encryptBlock(inp: Uint8Array, io: number, out: Uint8Array, oo: number): void {
    const s = new Uint8Array(16);
    const t = new Uint8Array(16);
    const rk = this.rk;
    for (let i = 0; i < 16; i++) s[i] = inp[io + i] ^ rk[i];
    for (let r = 1; r <= this.rounds; r++) {
      // SubBytes + ShiftRows（列優先：s[c*4+row]）
      for (let c = 0; c < 4; c++)
        for (let row = 0; row < 4; row++) t[c * 4 + row] = SBOX[s[((c + row) & 3) * 4 + row]];
      const k = r * 16;
      if (r < this.rounds) {
        for (let c = 0; c < 4; c++) {
          const a0 = t[c * 4];
          const a1 = t[c * 4 + 1];
          const a2 = t[c * 4 + 2];
          const a3 = t[c * 4 + 3];
          s[c * 4] = M2[a0] ^ M3[a1] ^ a2 ^ a3 ^ rk[k + c * 4];
          s[c * 4 + 1] = a0 ^ M2[a1] ^ M3[a2] ^ a3 ^ rk[k + c * 4 + 1];
          s[c * 4 + 2] = a0 ^ a1 ^ M2[a2] ^ M3[a3] ^ rk[k + c * 4 + 2];
          s[c * 4 + 3] = M3[a0] ^ a1 ^ a2 ^ M2[a3] ^ rk[k + c * 4 + 3];
        }
      } else {
        for (let i = 0; i < 16; i++) s[i] = t[i] ^ rk[k + i];
      }
    }
    out.set(s, oo);
  }

  /** 1 ブロックを復号して out に書く */
  decryptBlock(inp: Uint8Array, io: number, out: Uint8Array, oo: number): void {
    const s = new Uint8Array(16);
    const t = new Uint8Array(16);
    const rk = this.rk;
    const kLast = this.rounds * 16;
    for (let i = 0; i < 16; i++) s[i] = inp[io + i] ^ rk[kLast + i];
    for (let r = this.rounds - 1; r >= 0; r--) {
      // InvShiftRows + InvSubBytes
      for (let c = 0; c < 4; c++)
        for (let row = 0; row < 4; row++) t[((c + row) & 3) * 4 + row] = INV_SBOX[s[c * 4 + row]];
      const k = r * 16;
      for (let i = 0; i < 16; i++) t[i] ^= rk[k + i];
      if (r > 0) {
        for (let c = 0; c < 4; c++) {
          const a0 = t[c * 4];
          const a1 = t[c * 4 + 1];
          const a2 = t[c * 4 + 2];
          const a3 = t[c * 4 + 3];
          s[c * 4] = M14[a0] ^ M11[a1] ^ M13[a2] ^ M9[a3];
          s[c * 4 + 1] = M9[a0] ^ M14[a1] ^ M11[a2] ^ M13[a3];
          s[c * 4 + 2] = M13[a0] ^ M9[a1] ^ M14[a2] ^ M11[a3];
          s[c * 4 + 3] = M11[a0] ^ M13[a1] ^ M9[a2] ^ M14[a3];
        }
      } else {
        s.set(t);
      }
    }
    out.set(s, oo);
  }

  /** CBC 暗号化。pad=true なら PKCS#7 で詰める（入力長が 16 の倍数でなくてもよい） */
  cbcEncrypt(iv: Uint8Array, data: Uint8Array, pad: boolean): Uint8Array {
    let src = data;
    if (pad) {
      const n = 16 - (data.length % 16);
      src = new Uint8Array(data.length + n);
      src.set(data);
      src.fill(n, data.length);
    } else if (data.length % 16) throw new Error("AES-CBC: length is not a multiple of 16");
    const out = new Uint8Array(src.length);
    const block = new Uint8Array(16);
    let prev = iv;
    let po = 0;
    for (let off = 0; off < src.length; off += 16) {
      for (let i = 0; i < 16; i++) block[i] = src[off + i] ^ prev[po + i];
      this.encryptBlock(block, 0, out, off);
      prev = out;
      po = off;
    }
    return out;
  }

  /** CBC 復号。pad=true なら PKCS#7 の詰め物を外す（壊れた詰め物は寛容に扱う） */
  cbcDecrypt(iv: Uint8Array, data: Uint8Array, pad: boolean): Uint8Array {
    const len = data.length - (data.length % 16);
    const out = new Uint8Array(len);
    for (let off = 0; off < len; off += 16) {
      this.decryptBlock(data, off, out, off);
      const prev = off === 0 ? iv : data;
      const po = off === 0 ? 0 : off - 16;
      for (let i = 0; i < 16; i++) out[off + i] ^= prev[po + i];
    }
    if (!pad || !len) return out;
    const n = out[len - 1];
    if (n >= 1 && n <= 16 && n <= len) return out.subarray(0, len - n);
    return out;
  }
}

/** AES-CBC（PKCS#7 詰め物、先頭 16 バイトがランダム IV）で暗号化する。PDF のストリーム・文字列用 */
export function aesEncryptWithIv(key: Uint8Array, data: Uint8Array): Uint8Array {
  const iv = new Uint8Array(16);
  crypto.getRandomValues(iv);
  const body = new Aes(key).cbcEncrypt(iv, data, true);
  const out = new Uint8Array(16 + body.length);
  out.set(iv);
  out.set(body, 16);
  return out;
}

/** 先頭 16 バイトを IV とみなして AES-CBC を復号する */
export function aesDecryptWithIv(key: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length < 32) return new Uint8Array(0);
  return new Aes(key).cbcDecrypt(data.subarray(0, 16), data.subarray(16), true);
}

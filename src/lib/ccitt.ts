/**
 * 白黒 2 値の画像を、ファクスの方式（CCITT Group 4 / ITU-T T.6）で圧縮する。
 * 文字や線の多い白黒の画像は、汎用の圧縮（Deflate）よりかなり小さくなる。PDF の /CCITTFaxDecode（/K -1）で読める。
 */

// 連続する同じ色の長さ（ラン）の符号。T.4 の表 2・3
const WHITE_TERM =
  "00110101 000111 0111 1000 1011 1100 1110 1111 10011 10100 00111 01000 001000 000011 110100 110101 101010 101011 0100111 0001100 0001000 0010111 0000011 0000100 0101000 0101011 0010011 0100100 0011000 00000010 00000011 00011010 00011011 00010010 00010011 00010100 00010101 00010110 00010111 00101000 00101001 00101010 00101011 00101100 00101101 00000100 00000101 00001010 00001011 01010010 01010011 01010100 01010101 00100100 00100101 01011000 01011001 01011010 01011011 01001010 01001011 00110010 00110011 00110100".split(
    " ",
  );
const BLACK_TERM =
  "0000110111 010 11 10 011 0011 0010 00011 000101 000100 0000100 0000101 0000111 00000100 00000111 000011000 0000010111 0000011000 0000001000 00001100111 00001101000 00001101100 00000110111 00000101000 00000010111 00000011000 000011001010 000011001011 000011001100 000011001101 000001101000 000001101001 000001101010 000001101011 000011010010 000011010011 000011010100 000011010101 000011010110 000011010111 000001101100 000001101101 000011011010 000011011011 000001010100 000001010101 000001010110 000001010111 000001100100 000001100101 000001010010 000001010011 000000100100 000000110111 000000111000 000000100111 000000101000 000001011000 000001011001 000000101011 000000101100 000001011010 000001100110 000001100111".split(
    " ",
  );
// 64 の倍数（64〜1728）
const WHITE_MAKEUP =
  "11011 10010 010111 0110111 00110110 00110111 01100100 01100101 01101000 01100111 011001100 011001101 011010010 011010011 011010100 011010101 011010110 011010111 011011000 011011001 011011010 011011011 010011000 010011001 010011010 011000 010011011".split(
    " ",
  );
const BLACK_MAKEUP =
  "0000001111 000011001000 000011001001 000001011011 000000110011 000000110100 000000110101 0000001101100 0000001101101 0000001001010 0000001001011 0000001001100 0000001001101 0000001110010 0000001110011 0000001110100 0000001110101 0000001110110 0000001110111 0000001010010 0000001010011 0000001010100 0000001010101 0000001011010 0000001011011 0000001100100 0000001100101".split(
    " ",
  );
// 1792〜2560（白黒共通）
const EXT_MAKEUP = "00000001000 00000001100 00000001101 000000010010 000000010011 000000010100 000000010101 000000010110 000000010111 000000011100 000000011101 000000011110 000000011111".split(" ");

type Code = [bits: number, length: number];
const code = (s: string): Code => [parseInt(s, 2), s.length];
const TERM = [WHITE_TERM.map(code), BLACK_TERM.map(code)];
const MAKEUP = [WHITE_MAKEUP.map(code), BLACK_MAKEUP.map(code)];
const EXT = EXT_MAKEUP.map(code);
const PASS = code("0001");
const HORIZONTAL = code("001");
// 上の行との位置の差 -3〜+3（a1 - b1）
const VERTICAL = ["0000010", "000010", "010", "1", "011", "000011", "0000011"].map(code);
const EOFB = code("000000000001");

class BitWriter {
  private buf: Uint8Array;
  private pos = 0;
  private acc = 0;
  private n = 0;
  constructor(size: number) {
    this.buf = new Uint8Array(Math.max(64, size));
  }
  put([bits, length]: Code): void {
    for (let i = length - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((bits >> i) & 1);
      if (++this.n === 8) {
        if (this.pos === this.buf.length) {
          const next = new Uint8Array(this.buf.length * 2);
          next.set(this.buf);
          this.buf = next;
        }
        this.buf[this.pos++] = this.acc;
        this.acc = 0;
        this.n = 0;
      }
    }
  }
  finish(): Uint8Array {
    while (this.n !== 0) this.put([0, 1]);
    return this.buf.slice(0, this.pos);
  }
}

function putRun(out: BitWriter, color: number, length: number): void {
  let n = length;
  while (n >= 2560) {
    out.put(EXT[12]);
    n -= 2560;
  }
  if (n >= 1792) {
    const i = (n - 1792) >> 6;
    out.put(EXT[i]);
    n -= 1792 + i * 64;
  } else if (n >= 64) {
    const i = (n >> 6) - 1;
    out.put(MAKEUP[color][i]);
    n -= (i + 1) * 64;
  }
  out.put(TERM[color][n]);
}

/**
 * pixels：1 画素 1 バイト（0 = 白、0 以外 = 黒）、左上から行ごと。
 * 返り値は /CCITTFaxDecode（/K -1、/Columns width、/Rows height、/BlackIs1 は既定の false）の中身
 */
export function encodeG4(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const out = new BitWriter((width * height) >> 6);
  // 行ごとの「色が変わる位置」の並び（先頭は白から始まる。終わりに width を番兵として 2 つ置く）
  let ref = new Int32Array(width + 3);
  let cur = new Int32Array(width + 3);
  let refN = 0;
  ref[0] = ref[1] = width;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let n = 0;
    let prev = 0;
    for (let x = 0; x < width; x++) {
      const v = pixels[row + x] ? 1 : 0;
      if (v !== prev) {
        cur[n++] = x;
        prev = v;
      }
    }
    const curN = n;
    cur[n] = cur[n + 1] = width;

    let a0 = -1;
    let color = 0;
    let ci = 0; // cur の中で、a0 より右にある最初の変化点
    let ri = 0; // ref の中の探索位置
    while (a0 < width) {
      while (ci < curN && cur[ci] <= a0) ci++;
      const a1 = ci < curN ? cur[ci] : width;
      // b1：上の行で a0 より右にあり、いまの色と反対の色に変わる位置（変化点の番号の偶奇が色を表す：偶数番目は白→黒）
      while (ri > 0 && ref[ri - 1] > a0) ri--;
      while (ri < refN && (ref[ri] <= a0 || (ri & 1) !== color)) ri++;
      const b1 = ri < refN ? ref[ri] : width;
      const b2 = ri + 1 < refN ? ref[ri + 1] : width;
      if (b2 < a1) {
        out.put(PASS);
        a0 = b2;
      } else if (Math.abs(a1 - b1) <= 3) {
        out.put(VERTICAL[a1 - b1 + 3]);
        a0 = a1;
        color ^= 1;
      } else {
        const a2 = ci + 1 < curN ? cur[ci + 1] : width;
        out.put(HORIZONTAL);
        putRun(out, color, a1 - Math.max(a0, 0));
        putRun(out, color ^ 1, a2 - a1);
        a0 = a2;
      }
    }
    const t = ref;
    ref = cur;
    cur = t;
    refN = curN;
  }
  out.put(EOFB);
  out.put(EOFB);
  return out.finish();
}

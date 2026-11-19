// CFF（Compact Font Format）フォントの、必要な所だけの読み取り。
// PDF に一部だけ埋め込まれた CFF フォント（FontFile3）では、使われていない字の字形が「何も描かない字形（endchar だけ）」として
// 残っていることがある。文字の対応表（ToUnicode）を別のフォントと共有している文書では、その字が「書ける」ように見えてしまうので、
// 字形に輪郭があるかをここで確かめる。

export interface CffInfo {
  glyphCount: number;
  /** CID で字形を引くフォントか（そうでなければ、字形番号がそのまま CID） */
  cidKeyed: boolean;
  /** CID → 字形番号。無ければ null */
  gidOfCid(cid: number): number | null;
  /** その字形に輪郭があるか（何も描かない字形なら false） */
  hasOutline(gid: number): boolean;
}

interface Index {
  count: number;
  /** i 番目のデータの範囲 */
  range(i: number): [number, number];
  /** INDEX の直後の位置 */
  end: number;
}

function readIndex(b: Uint8Array, at: number): Index {
  const count = (b[at] << 8) | b[at + 1];
  if (count === 0) return { count: 0, range: () => [0, 0], end: at + 2 };
  const offSize = b[at + 2];
  if (offSize < 1 || offSize > 4) throw new Error("bad INDEX");
  const offAt = at + 3;
  const off = (i: number) => {
    let v = 0;
    for (let k = 0; k < offSize; k++) v = v * 256 + b[offAt + i * offSize + k];
    return v;
  };
  const base = offAt + (count + 1) * offSize - 1;
  return { count, range: (i) => [base + off(i), base + off(i + 1)], end: base + off(count) };
}

/** DICT を読む：演算子（12 で始まるものは 1200 + 次のバイト）→ 直前までの数値 */
function readDict(b: Uint8Array, start: number, end: number): Map<number, number[]> {
  const out = new Map<number, number[]>();
  let nums: number[] = [];
  let p = start;
  while (p < end) {
    const v = b[p];
    if (v <= 21) {
      let op = v;
      p++;
      if (v === 12) op = 1200 + b[p++];
      out.set(op, nums);
      nums = [];
    } else if (v === 28) {
      nums.push(((b[p + 1] << 8) | b[p + 2]) << 16 >> 16);
      p += 3;
    } else if (v === 29) {
      nums.push((b[p + 1] << 24) | (b[p + 2] << 16) | (b[p + 3] << 8) | b[p + 4]);
      p += 5;
    } else if (v === 30) {
      // 実数（BCD）。値は使わないので読み飛ばす
      p++;
      while (p < end) {
        const x = b[p++];
        if ((x & 15) === 15 || x >> 4 === 15) break;
      }
      nums.push(0);
    } else if (v >= 32 && v <= 246) {
      nums.push(v - 139);
      p++;
    } else if (v >= 247 && v <= 250) {
      nums.push((v - 247) * 256 + b[p + 1] + 108);
      p += 2;
    } else if (v >= 251 && v <= 254) {
      nums.push(-(v - 251) * 256 - b[p + 1] - 108);
      p += 2;
    } else p++;
  }
  return out;
}

/** OpenType（OTTO）に包まれていれば、中の CFF 表を取り出す */
function cffTable(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 12 && bytes[0] === 0x4f && bytes[1] === 0x54 && bytes[2] === 0x54 && bytes[3] === 0x4f) {
    const n = (bytes[4] << 8) | bytes[5];
    for (let i = 0; i < n; i++) {
      const p = 12 + i * 16;
      if (String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]) !== "CFF ") continue;
      const off = ((bytes[p + 8] << 24) | (bytes[p + 9] << 16) | (bytes[p + 10] << 8) | bytes[p + 11]) >>> 0;
      const len = ((bytes[p + 12] << 24) | (bytes[p + 13] << 16) | (bytes[p + 14] << 8) | bytes[p + 15]) >>> 0;
      return bytes.subarray(off, off + len);
    }
  }
  return bytes;
}

export function parseCff(input: Uint8Array): CffInfo | null {
  try {
    const b = cffTable(input);
    if (b.length < 8 || b[0] !== 1) return null;
    const names = readIndex(b, b[2]);
    const tops = readIndex(b, names.end);
    if (tops.count < 1) return null;
    const [ts, te] = tops.range(0);
    const top = readDict(b, ts, te);
    const csAt = top.get(17)?.[0];
    if (!csAt) return null;
    // 字形の書き方が Type 2 でないもの（古い Type 1 形式）は判定しない
    if ((top.get(1206)?.[0] ?? 2) !== 2) return null;
    const cs = readIndex(b, csAt);
    const cidKeyed = top.has(1230);
    // charset：字形番号 → CID（CID で引くフォントのとき）
    let cidToGid: Map<number, number> | null = null;
    if (cidKeyed) {
      cidToGid = new Map([[0, 0]]);
      const at = top.get(15)?.[0] ?? 0;
      if (at > 2) {
        const format = b[at];
        let p = at + 1;
        let gid = 1;
        if (format === 0) {
          for (; gid < cs.count; gid++, p += 2) cidToGid.set((b[p] << 8) | b[p + 1], gid);
        } else if (format === 1 || format === 2) {
          while (gid < cs.count && p < b.length) {
            const first = (b[p] << 8) | b[p + 1];
            const left = format === 1 ? b[p + 2] : (b[p + 2] << 8) | b[p + 3];
            p += format === 1 ? 3 : 4;
            for (let k = 0; k <= left && gid < cs.count; k++) cidToGid.set(first + k, gid++);
          }
        } else return null;
      }
    }
    const hasOutline = (gid: number): boolean => {
      if (gid < 0 || gid >= cs.count) return false;
      const [s, e] = cs.range(gid);
      // 先頭の数値（字幅など）を読み飛ばして、最初の命令を見る。数値が 1 つ以下で endchar（14）なら、何も描かない字形
      let p = s;
      let nums = 0;
      while (p < e) {
        const v = b[p];
        if (v === 28) p += 3;
        else if (v === 255) p += 5;
        else if (v >= 32 && v <= 246) p += 1;
        else if (v >= 247 && v <= 254) p += 2;
        else return !(v === 14 && nums <= 1);
        nums++;
      }
      return false;
    };
    return { glyphCount: cs.count, cidKeyed, gidOfCid: (cid) => (cidToGid ? (cidToGid.get(cid) ?? null) : cid), hasOutline };
  } catch {
    return null;
  }
}

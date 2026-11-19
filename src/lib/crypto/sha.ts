/** SHA-2 は WebCrypto（ブラウザ・Node ともに同梱、通信なし）を使う */
export async function sha(bits: 256 | 384 | 512, data: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest(`SHA-${bits}`, data as BufferSource);
  return new Uint8Array(buf);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

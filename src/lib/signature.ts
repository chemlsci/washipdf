// 署名の画像を作る：手書き（線）・印鑑風（文字を枠で囲む）・画像（白い背景を透明にする）。
// どれも背景が透明の PNG にして、ページには画像として置く（保存するとページの内容に焼き込まれる。注釈ではない）。
// 証明書を使う電子署名ではない。

export interface Stroke {
  /** 点の並び（キャンバスの座標）。p はペンの筆圧（0〜1。ペンで書いたときだけ） */
  points: { x: number; y: number; p?: number }[];
  color: string;
  width: number;
}

const toBlob = (c: HTMLCanvasElement): Promise<Blob> =>
  new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob"))), "image/png"));

/** 線を、なめらかな曲線で描く（点と点の中点を通る 2 次曲線） */
/** 筆圧に応じた線の太さ（筆圧が無ければ、決めた太さのまま。筆圧 0.5 で決めた太さ） */
const widthAt = (s: Stroke, i: number) => {
  const p = s.points[i]?.p;
  return p === undefined ? s.width : s.width * (0.35 + 1.3 * Math.max(0, Math.min(1, p)));
};

/**
 * 線を描く。from を渡すと、その点より先の部分だけを描き足す（書いている最中に、全部を描き直さないため）。
 * 隣り合う点の中点を通る 2 次曲線でつなぎ、区間ごとに、その点の筆圧の太さで描く。
 * open：書いている最中（最後の点までの直線は、次の点が来ると曲線に変わるので、まだ描かない）
 */
export function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, scale = 1, dx = 0, dy = 0, from = 0, open = false): void {
  const p = s.points;
  if (!p.length) return;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  const X = (i: number) => (p[i].x + dx) * scale;
  const Y = (i: number) => (p[i].y + dy) * scale;
  const mx = (i: number) => (X(i) + X(i + 1)) / 2;
  const my = (i: number) => (Y(i) + Y(i + 1)) / 2;
  if (p.length === 1) {
    ctx.beginPath();
    ctx.arc(X(0), Y(0), (widthAt(s, 0) * scale) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  // 区間 i：点 i-1 と i の中点から、点 i を制御点にして、点 i と i+1 の中点まで（最初と最後は端の点から・端の点まで）
  for (let i = Math.max(1, from); i < (open ? p.length - 1 : p.length); i++) {
    ctx.beginPath();
    ctx.lineWidth = widthAt(s, i) * scale;
    if (i === 1) ctx.moveTo(X(0), Y(0));
    else ctx.moveTo(mx(i - 1), my(i - 1));
    if (i < p.length - 1) ctx.quadraticCurveTo(X(i), Y(i), mx(i), my(i));
    else ctx.lineTo(X(i), Y(i));
    ctx.stroke();
  }
}

export function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[], scale = 1, dx = 0, dy = 0): void {
  for (const s of strokes) drawStroke(ctx, s, scale, dx, dy);
}

/** 手書きの線を、余白を切り詰めた透明の PNG にする。線が無ければ null */
export async function strokesToPng(strokes: Stroke[]): Promise<{ blob: Blob; width: number; height: number } | null> {
  const pts = strokes.flatMap((s) => s.points.map((q) => ({ ...q, w: s.width })));
  if (!pts.length) return null;
  const pad = Math.max(...strokes.map((s) => s.width * 1.65)) + 2;
  const x0 = Math.min(...pts.map((q) => q.x)) - pad;
  const y0 = Math.min(...pts.map((q) => q.y)) - pad;
  const x1 = Math.max(...pts.map((q) => q.x)) + pad;
  const y1 = Math.max(...pts.map((q) => q.y)) + pad;
  // 拡大しても線が粗く見えないよう、画面の 3 倍の細かさで描く
  const k = 3;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil((x1 - x0) * k));
  c.height = Math.max(1, Math.ceil((y1 - y0) * k));
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  drawStrokes(ctx, strokes, k, -x0, -y0);
  return { blob: await toBlob(c), width: x1 - x0, height: y1 - y0 };
}

export interface SealOptions {
  text: string;
  shape: "round" | "square";
  color: string;
  /** 文字のフォント（CSS の font-family） */
  fontFamily: string;
}

/** 文字の並べ方：漢字・かなの短い名前は縦書き（4 字は 2 列）、それ以外は横書き（長ければ 2 行） */
export function sealLayout(text: string): { vertical: boolean; lines: string[] } {
  const chars = [...text.trim()];
  const cjk = chars.length > 0 && chars.every((ch) => /[぀-ヿ㐀-鿿豈-﫿가-힯々〆ー]/.test(ch));
  if (cjk && chars.length <= 3) return { vertical: true, lines: [chars.join("")] };
  if (cjk && chars.length <= 6) {
    const half = Math.ceil(chars.length / 2);
    // 縦書きは右の列から読む
    return { vertical: true, lines: [chars.slice(0, half).join(""), chars.slice(half).join("")] };
  }
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2 && text.trim().length > 6) {
    const half = Math.ceil(words.length / 2);
    return { vertical: false, lines: [words.slice(0, half).join(" "), words.slice(half).join(" ")] };
  }
  return { vertical: false, lines: [text.trim()] };
}

/** 印鑑風の画像をキャンバスに描く（size は 1 辺の画素数） */
export function drawSeal(ctx: CanvasRenderingContext2D, size: number, o: SealOptions): void {
  ctx.clearRect(0, 0, size, size);
  const line = size * 0.045;
  const inset = line / 2 + size * 0.02;
  ctx.strokeStyle = o.color;
  ctx.fillStyle = o.color;
  ctx.lineWidth = line;
  ctx.beginPath();
  if (o.shape === "round") ctx.arc(size / 2, size / 2, size / 2 - inset, 0, Math.PI * 2);
  else {
    const r = size * 0.08;
    const a = inset;
    const b = size - inset;
    ctx.moveTo(a + r, a);
    ctx.arcTo(b, a, b, b, r);
    ctx.arcTo(b, b, a, b, r);
    ctx.arcTo(a, b, a, a, r);
    ctx.arcTo(a, a, b, a, r);
    ctx.closePath();
  }
  ctx.stroke();
  const { vertical, lines } = sealLayout(o.text);
  if (!lines[0]) return;
  // 文字を入れられる範囲（丸は内接する正方形より少し広く使う）
  const box = size * (o.shape === "round" ? 0.66 : 0.76);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (vertical) {
    const cols = lines.length;
    const rows = Math.max(...lines.map((l) => [...l].length));
    const cell = Math.min(box / cols, box / rows);
    ctx.font = `${cell * 0.98}px ${o.fontFamily}`;
    lines.forEach((l, ci) => {
      const chars = [...l];
      // 右の列から
      const x = size / 2 + ((cols - 1) / 2 - ci) * cell;
      chars.forEach((ch, ri) => ctx.fillText(ch, x, size / 2 + (ri - (chars.length - 1) / 2) * cell * (rows > chars.length ? rows / chars.length : 1)));
    });
    return;
  }
  // 横書き：幅と高さの両方に収まる大きさにする
  let fs = box / lines.length;
  ctx.font = `${fs}px ${o.fontFamily}`;
  const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
  if (widest > box) fs *= box / widest;
  ctx.font = `${fs}px ${o.fontFamily}`;
  lines.forEach((l, i) => ctx.fillText(l, size / 2, size / 2 + (i - (lines.length - 1) / 2) * fs * 1.1));
}

export async function sealToPng(o: SealOptions): Promise<{ blob: Blob; width: number; height: number }> {
  const size = 480;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  drawSeal(c.getContext("2d")!, size, o);
  return { blob: await toBlob(c), width: size, height: size };
}

/**
 * 画像（紙に書いた署名や印影の写真など）の白い背景を透明にする。
 * 明るさがしきい値より明るい画素は完全に透明、暗い画素は不透明、その間はなめらかにつなぐ（縁がぎざぎざにならないように）。
 * 余白は切り詰める。
 */
export function whiteToTransparent(img: ImageData, threshold = 200): { data: ImageData; box: { x: number; y: number; w: number; h: number } | null } {
  const d = img.data;
  const soft = 60;
  let x0 = img.width;
  let y0 = img.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const a = lum >= threshold ? 0 : lum <= threshold - soft ? 1 : (threshold - lum) / soft;
      d[i + 3] = Math.round(d[i + 3] * a);
      if (d[i + 3] > 24) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return { data: img, box: x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } };
}

/** 画像ファイルを署名用の PNG にする（大きすぎる画像は縮める。transparent なら白い背景を透明にして余白を切る） */
export async function imageToSignaturePng(file: Blob, transparent: boolean): Promise<{ blob: Blob; width: number; height: number }> {
  const url = URL.createObjectURL(file);
  try {
    const el = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("image"));
      im.src = url;
    });
    const k = Math.min(1, 1600 / Math.max(el.naturalWidth, el.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(el.naturalWidth * k));
    c.height = Math.max(1, Math.round(el.naturalHeight * k));
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(el, 0, 0, c.width, c.height);
    if (!transparent) return { blob: await toBlob(c), width: c.width, height: c.height };
    const { data, box } = whiteToTransparent(ctx.getImageData(0, 0, c.width, c.height));
    ctx.putImageData(data, 0, 0);
    if (!box) return { blob: await toBlob(c), width: c.width, height: c.height };
    const out = document.createElement("canvas");
    out.width = box.w;
    out.height = box.h;
    out.getContext("2d")!.drawImage(c, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
    return { blob: await toBlob(out), width: box.w, height: box.h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** この画面を開いている間だけ覚えておく署名（もう一度置くときに選べる）。端末には保存しない */
export interface KeptSignature {
  id: string;
  blob: Blob;
  url: string;
  /** ページに置くときの幅（pt） */
  widthPt: number;
}
const kept: KeptSignature[] = [];
export const keptSignatures = (): readonly KeptSignature[] => kept;
export function keepSignature(blob: Blob, widthPt: number): KeptSignature {
  const s = { id: `sig${Date.now()}${kept.length}`, blob, url: URL.createObjectURL(blob), widthPt };
  kept.unshift(s);
  for (const old of kept.splice(6)) URL.revokeObjectURL(old.url);
  return s;
}

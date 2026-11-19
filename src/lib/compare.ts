/**
 * 文書比較の計算（画面に依存しない部分）：
 * - 描画した画像の差分（矩形にまとめる。スキャンした紙は、ずれ・傾き・にじみを打ち消してから比べる）
 * - 行の差分と、変わった行の中の語・文字単位の差分、改行の位置だけの違いの見分け
 * - ページの対応づけ（追加・削除・移動を見分ける）
 */

export interface ImageLike {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface DiffBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

const NEIGHBORS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
];

/** 違いのある格子（flag が 1）を、隣り合うものどうしで矩形にまとめる */
function flagsToBoxes(flag: Uint8Array, cols: number, rows: number, cell: number, minCells = 1): DiffBox[] {
  const boxes: DiffBox[] = [];
  const visited = new Uint8Array(flag.length);
  for (let i = 0; i < flag.length; i++) {
    if (!flag[i] || visited[i]) continue;
    let minC = cols;
    let maxC = -1;
    let minR = rows;
    let maxR = -1;
    const queue = [i];
    visited[i] = 1;
    let cells = 0;
    while (queue.length) {
      const c = queue.pop()!;
      cells++;
      const cx = c % cols;
      const cy = Math.floor(c / cols);
      minC = Math.min(minC, cx);
      maxC = Math.max(maxC, cx);
      minR = Math.min(minR, cy);
      maxR = Math.max(maxR, cy);
      for (const [dx, dy] of NEIGHBORS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const n = nx + ny * cols;
        if (flag[n] && !visited[n]) {
          visited[n] = 1;
          queue.push(n);
        }
      }
    }
    if (cells >= minCells) boxes.push({ x: minC * cell, y: minR * cell, w: (maxC - minC + 1) * cell, h: (maxR - minR + 1) * cell });
  }
  return boxes;
}

export interface DiffImageOptions {
  /** スキャンした紙など：全体と区画ごとのずれを合わせ、近くの色で説明できる差は違いとしない */
  tolerant?: boolean;
}

/**
 * 2 枚の画像を比べ、違いのある領域を矩形で返す。cell ピクセル四方の格子で判定し、隣り合う格子をまとめる。
 * 大きさが違えば、片方にしか無い部分も「違い」になる。
 */
export function diffImages(a: ImageLike, b: ImageLike, cell = 12, threshold = 48, opts: DiffImageOptions = {}): { boxes: DiffBox[]; changedCells: number; totalCells: number } {
  if (opts.tolerant) return diffImagesTolerant(a, b, cell);
  const W = Math.max(a.width, b.width);
  const H = Math.max(a.height, b.height);
  const cols = Math.ceil(W / cell);
  const rows = Math.ceil(H / cell);
  const flag = new Uint8Array(cols * rows);
  const px = (img: ImageLike, x: number, y: number): [number, number, number] | null => {
    if (x >= img.width || y >= img.height) return null;
    const i = (y * img.width + x) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const pa = px(a, x, y);
      const pb = px(b, x, y);
      let changed: boolean;
      // 片方だけにある部分は白以外を違いとする（大きさの違うページで、どちらの外でもない所は違いなし）
      if (!pa && !pb) changed = false;
      else if (!pa || !pb) changed = (pa ?? pb)!.some((v) => v < 250);
      else changed = Math.abs(pa[0] - pb[0]) + Math.abs(pa[1] - pb[1]) + Math.abs(pa[2] - pb[2]) > threshold;
      if (changed) {
        const c = Math.floor(x / cell) + Math.floor(y / cell) * cols;
        if (flag[c] < 255) flag[c]++;
      }
    }
  }
  // ノイズ除け：格子内で数ピクセル以上
  for (let i = 0; i < flag.length; i++) flag[i] = flag[i] >= 3 ? 1 : 0;
  let changedCells = 0;
  for (let i = 0; i < flag.length; i++) changedCells += flag[i];
  return { boxes: flagsToBoxes(flag, cols, rows, cell), changedCells, totalCells: flag.length };
}

/** 明るさだけの画像（0〜255） */
interface Gray {
  g: Uint8Array;
  w: number;
  h: number;
}

function toGray(img: ImageLike): Gray {
  const n = img.width * img.height;
  const g = new Uint8Array(n);
  const d = img.data;
  for (let i = 0; i < n; i++) g[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8;
  return { g, w: img.width, h: img.height };
}

/** 縮小（f 画素四方の平均） */
function shrink(src: Gray, f: number): Gray {
  const w = Math.max(1, Math.floor(src.w / f));
  const h = Math.max(1, Math.floor(src.h / f));
  const g = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let yy = 0; yy < f; yy++) for (let xx = 0; xx < f; xx++) s += src.g[(y * f + yy) * src.w + x * f + xx];
      g[y * w + x] = s / (f * f);
    }
  }
  return { g, w, h };
}

/** a の (x0..x1, y0..y1) と、b を (dx, dy) ずらした所との差の平均（重なる所だけ。step 画素おき） */
function sad(a: Gray, b: Gray, dx: number, dy: number, x0: number, y0: number, x1: number, y1: number, step: number): number {
  let s = 0;
  let n = 0;
  for (let y = y0; y < y1; y += step) {
    const by = y + dy;
    if (by < 0 || by >= b.h) continue;
    for (let x = x0; x < x1; x += step) {
      const bx = x + dx;
      if (bx < 0 || bx >= b.w) continue;
      s += Math.abs(a.g[y * a.w + x] - b.g[by * b.w + bx]);
      n++;
    }
  }
  return n ? s / n : Infinity;
}

/** ページ全体のずれ（b を (dx, dy) ずらすと a に重なる）を探す */
function globalShift(a: Gray, b: Gray): [number, number] {
  const f = 4;
  const sa = shrink(a, f);
  const sb = shrink(b, f);
  const R = Math.max(2, Math.ceil(Math.max(sa.w, sa.h) * 0.03));
  let best = Infinity;
  let bx = 0;
  let by = 0;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const v = sad(sa, sb, dx, dy, R, R, sa.w - R, sa.h - R, 1) + (Math.abs(dx) + Math.abs(dy)) * 1e-3;
      if (v < best) {
        best = v;
        bx = dx;
        by = dy;
      }
    }
  }
  // 元の大きさで細かく合わせる
  let fx = bx * f;
  let fy = by * f;
  best = Infinity;
  const cx = fx;
  const cy = fy;
  for (let dy = -f; dy <= f; dy++) {
    for (let dx = -f; dx <= f; dx++) {
      const v = sad(a, b, cx + dx, cy + dy, 0, 0, a.w, a.h, 2) + (Math.abs(dx) + Math.abs(dy)) * 1e-3;
      if (v < best) {
        best = v;
        fx = cx + dx;
        fy = cy + dy;
      }
    }
  }
  return [fx, fy];
}

/** 点 (x, y) ごとの値 v[k] を、v = c0 + c1·x + c2·y で近似する（最小二乗）。点が少なければ一定値 */
function fitPlane(pts: number[][], k: number, fallback: number): [number, number, number] {
  if (pts.length < 6) return [fallback, 0, 0];
  // 正規方程式
  const M = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const v = [0, 0, 0];
  for (const p of pts) {
    const r = [1, p[0], p[1]];
    for (let i = 0; i < 3; i++) {
      v[i] += r[i] * p[k];
      for (let j = 0; j < 3; j++) M[i][j] += r[i] * r[j];
    }
  }
  const det = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const d = det(M);
  if (Math.abs(d) < 1e-9) return [fallback, 0, 0];
  const out: number[] = [];
  for (let c = 0; c < 3; c++) {
    const m = M.map((row, i) => row.map((x, j) => (j === c ? v[i] : x)));
    out.push(det(m) / d);
  }
  return [out[0], out[1], out[2]];
}

/**
 * スキャンした紙どうしの差分。全体のずれを合わせ、さらに区画ごとに数画素のずれ（傾き）を合わせる。
 * そのうえで、近く（1 画素）の色で説明できる差は違いとしない。まとまった差だけを残す
 */
function diffImagesTolerant(ia: ImageLike, ib: ImageLike, fullCell: number): { boxes: DiffBox[]; changedCells: number; totalCells: number } {
  // 半分に縮めて比べる（文字の縁のにじみや、画素より細かいずれをならす）
  const F = 2;
  const a = shrink(toGray(ia), F);
  const b = shrink(toGray(ib), F);
  const cell = Math.max(2, Math.round(fullCell / F));
  const [gx, gy] = globalShift(a, b);
  const W = a.w;
  const H = a.h;
  const cols = Math.ceil(W / cell);
  const rows = Math.ceil(H / cell);
  const count = new Uint16Array(cols * rows);
  const thr = 72;
  const BLOCK = 32;
  const L = 3;
  const bAt = (x: number, y: number) => (x < 0 || y < 0 || x >= b.w || y >= b.h ? 255 : b.g[y * b.w + x]);
  const aAt = (x: number, y: number) => (x < 0 || y < 0 || x >= a.w || y >= a.h ? 255 : a.g[y * a.w + x]);
  // 区画ごとのずれ。文字や線のある区画のずれから、ページ全体のずれ方（平行移動と傾き）を求める
  const bc = Math.ceil(W / BLOCK);
  const br = Math.ceil(H / BLOCK);
  const shiftX = new Int16Array(bc * br);
  const shiftY = new Int16Array(bc * br);
  const fit: number[][] = [];
  for (let r = 0; r < br; r++) {
    for (let q = 0; q < bc; q++) {
      const bx0 = q * BLOCK;
      const by0 = r * BLOCK;
      const bx1 = Math.min(W, bx0 + BLOCK);
      const by1 = Math.min(H, by0 + BLOCK);
      let best = Infinity;
      let ox = gx;
      let oy = gy;
      for (let dy = -L; dy <= L; dy++) {
        for (let dx = -L; dx <= L; dx++) {
          const v = sad(a, b, gx + dx, gy + dy, bx0, by0, bx1, by1, 2) + (Math.abs(dx) + Math.abs(dy)) * 0.05;
          if (v < best) {
            best = v;
            ox = gx + dx;
            oy = gy + dy;
          }
        }
      }
      shiftX[r * bc + q] = ox;
      shiftY[r * bc + q] = oy;
      let ink = 0;
      for (let y = by0; y < by1; y += 2) for (let x = bx0; x < bx1; x += 2) if (a.g[y * W + x] < 160) ink++;
      if (ink * 4 > (bx1 - bx0) * (by1 - by0) * 0.03) fit.push([(bx0 + bx1) / 2, (by0 + by1) / 2, ox, oy]);
    }
  }
  const mx = fitPlane(fit, 2, gx);
  const my = fitPlane(fit, 3, gy);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const va = a.g[y * W + x];
      const blk = Math.floor(y / BLOCK) * bc + Math.floor(x / BLOCK);
      // ページ全体のずれ方（小数のまま、まわりの 4 点から補う）か、区画のずれで合えば同じとみなす
      const fx = x + mx[0] + mx[1] * x + mx[2] * y;
      const fy = y + my[0] + my[1] * x + my[2] * y;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const vm = (bAt(x0, y0) * (1 - tx) + bAt(x0 + 1, y0) * tx) * (1 - ty) + (bAt(x0, y0 + 1) * (1 - tx) + bAt(x0 + 1, y0 + 1) * tx) * ty;
      let ok = Math.abs(va - vm) <= thr || Math.abs(va - bAt(x + shiftX[blk], y + shiftY[blk])) <= thr;
      if (!ok) {
        // 区画のずれ ±1 の範囲（区画の境で、ずれの求め方が揺れる分）
        for (let ny = -1; ny <= 1 && !ok; ny++) for (let nx = -1; nx <= 1 && !ok; nx++) if (Math.abs(va - bAt(Math.round(fx) + nx, Math.round(fy) + ny)) <= thr / 2) ok = true;
      }
      if (ok) continue;
      const c = Math.floor(x / cell) + Math.floor(y / cell) * cols;
      count[c]++;
    }
  }
  // まとまった差だけ：格子内の点が多く、かつ隣にも違いのある格子があるもの（にじみや汚れの点を除く）
  const minPx = Math.max(4, Math.round(cell * cell * 0.06));
  const strong = new Uint8Array(cols * rows);
  for (let i = 0; i < count.length; i++) strong[i] = count[i] >= minPx ? 1 : 0;
  const flag = new Uint8Array(cols * rows);
  for (let i = 0; i < strong.length; i++) {
    if (!strong[i]) continue;
    const cx = i % cols;
    const cy = Math.floor(i / cols);
    let near = 0;
    for (const [dx, dy] of NEIGHBORS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      if (strong[nx + ny * cols]) near++;
    }
    if (near > 0 || count[i] >= minPx * 4) flag[i] = 1;
  }
  let changedCells = 0;
  for (let i = 0; i < flag.length; i++) changedCells += flag[i];
  const boxes = flagsToBoxes(flag, cols, rows, cell, 3).map((bx) => ({ x: bx.x * F, y: bx.y * F, w: bx.w * F, h: bx.h * F }));
  return { boxes, changedCells, totalCells: flag.length };
}

/**
 * 行を合わせて比べる差分（文字の PDF 向け）。上の方で行が増えると、その下は全部ずれるので、
 * 画像の横 1 列（行）どうしを最長共通部分列で対応づけてから、合わなかった行だけを調べる。
 * 合わなかった行でも、相手の画像のどこかに同じ行があれば（表の枠が縦に伸びただけ、など）違いとしない。
 * 枠は、いまの文書の画像の上（boxesA）と、比べた PDF の画像の上（boxesB）に分けて返す
 */
export function diffImagesAligned(a: ImageLike, b: ImageLike, cell = 12): { boxesA: DiffBox[]; boxesB: DiffBox[] } {
  const G = 3; // 横は 3 画素ずつまとめる（にじみの違いをならす）
  const W = Math.max(a.width, b.width);
  const cw = Math.ceil(W / G);
  const rowsOf = (img: ImageLike) => {
    const rows: Uint8Array[] = [];
    const hashes: number[] = [];
    for (let y = 0; y < img.height; y++) {
      const r = new Uint8Array(cw);
      let h = 0x811c9dc5;
      for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4;
        if (img.data[i] * 77 + img.data[i + 1] * 150 + img.data[i + 2] * 29 < 170 * 256) r[(x / G) | 0] = 1;
      }
      for (let c = 0; c < cw; c++) {
        h ^= r[c] + 1;
        h = Math.imul(h, 0x01000193);
      }
      rows.push(r);
      hashes.push(h >>> 0);
    }
    return { rows, hashes };
  };
  const A = rowsOf(a);
  const B = rowsOf(b);
  const setA = new Set(A.hashes);
  const setB = new Set(B.hashes);
  const n = A.hashes.length;
  const m = B.hashes.length;
  // 行の対応づけ（前後の同じ行を除いてから）
  let pre = 0;
  while (pre < n && pre < m && A.hashes[pre] === B.hashes[pre]) pre++;
  let post = 0;
  while (post < n - pre && post < m - pre && A.hashes[n - 1 - post] === B.hashes[m - 1 - post]) post++;
  const N = n - pre - post;
  const M = m - pre - post;
  const pairs: [number, number][] = []; // 対応した行（-1 は相手なし）
  if (N * M <= 6_000_000) {
    const dp = new Uint16Array((N + 1) * (M + 1));
    for (let i = N - 1; i >= 0; i--) {
      for (let j = M - 1; j >= 0; j--) {
        dp[i * (M + 1) + j] = A.hashes[pre + i] === B.hashes[pre + j] ? dp[(i + 1) * (M + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (M + 1) + j], dp[i * (M + 1) + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < N || j < M) {
      if (i < N && j < M && A.hashes[pre + i] === B.hashes[pre + j]) {
        pairs.push([pre + i++, pre + j++]);
      } else if (j >= M || (i < N && dp[(i + 1) * (M + 1) + j] >= dp[i * (M + 1) + j + 1])) pairs.push([pre + i++, -1]);
      else pairs.push([-1, pre + j++]);
    }
  } else {
    for (let k = 0; k < Math.max(N, M); k++) pairs.push([k < N ? pre + k : -1, k < M ? pre + k : -1]);
  }
  const colsA = Math.ceil(a.width / cell);
  const colsB = Math.ceil(b.width / cell);
  const cntA = new Uint16Array(colsA * Math.ceil(a.height / cell));
  const cntB = new Uint16Array(colsB * Math.ceil(b.height / cell));
  const hit = (cnt: Uint16Array, cols: number, c: number, y: number) => {
    const k = Math.floor((c * G) / cell) + Math.floor(y / cell) * cols;
    if (k < cnt.length) cnt[k]++;
  };
  const ink = (r: Uint8Array, c: number) => c >= 0 && c < cw && r[c] === 1;
  // 隙間（対応しなかった行の続き）ごとに調べる
  let k = 0;
  while (k < pairs.length) {
    if (pairs[k][0] >= 0 && pairs[k][1] >= 0) {
      k++;
      continue;
    }
    const ga: number[] = [];
    const gb: number[] = [];
    while (k < pairs.length && !(pairs[k][0] >= 0 && pairs[k][1] >= 0)) {
      if (pairs[k][0] >= 0) ga.push(pairs[k][0]);
      else gb.push(pairs[k][1]);
      k++;
    }
    const p = Math.min(ga.length, gb.length);
    // 同じ場所で書き換わった行：列ごとに比べる（上下 1 行・左右 1 列のずれは許す）
    for (let q = 0; q < p; q++) {
      const ya = ga[q];
      const yb = gb[q];
      const ra = A.rows[ya];
      const rb = B.rows[yb];
      const near = (rows: Uint8Array[], y: number, c: number) => {
        for (let dy = -1; dy <= 1; dy++) {
          const r = rows[y + dy];
          if (r && (ink(r, c) || ink(r, c - 1) || ink(r, c + 1))) return true;
        }
        return false;
      };
      for (let c = 0; c < cw; c++) {
        if (ra[c] && !near(B.rows, yb, c)) hit(cntA, colsA, c, ya);
        if (rb[c] && !near(A.rows, ya, c)) hit(cntB, colsB, c, yb);
      }
    }
    // 片方にだけある行：相手の画像のどこにも同じ行が無いときだけ違いとする
    for (const y of ga.slice(p)) if (!setB.has(A.hashes[y])) for (let c = 0; c < cw; c++) if (A.rows[y][c]) hit(cntA, colsA, c, y);
    for (const y of gb.slice(p)) if (!setA.has(B.hashes[y])) for (let c = 0; c < cw; c++) if (B.rows[y][c]) hit(cntB, colsB, c, y);
  }
  const boxes = (cnt: Uint16Array, cols: number) => {
    const rows = cnt.length / cols;
    const flag = new Uint8Array(cnt.length);
    for (let i = 0; i < cnt.length; i++) flag[i] = cnt[i] >= 3 ? 1 : 0;
    return flagsToBoxes(flag, cols, rows, cell);
  };
  return { boxesA: boxes(cntA, colsA), boxesB: boxes(cntB, colsB) };
}

// ───────────────────────── 文字の差分 ─────────────────────────

export interface LineDiff {
  kind: "same" | "add" | "del";
  text: string;
}

/** 比べるための文字列。loose なら空白をすべて除き、全角・半角をそろえる（NFKC） */
export function normKey(s: string, loose: boolean): string {
  return loose ? s.normalize("NFKC").replace(/\s+/gu, "") : s.normalize("NFC").replace(/\s+/gu, " ").trim();
}

/** 1 ページで比べる行の上限 */
export const MAX_LINES = 2000;

/** 行単位の差分（最長共通部分列）。key で比べる（既定はそのまま）。大きすぎる入力は先頭 MAX_LINES 行で打ち切る */
export function diffLines(a: string[], b: string[], key: (s: string) => string = (s) => s): LineDiff[] {
  const A = a.slice(0, MAX_LINES);
  const B = b.slice(0, MAX_LINES);
  const ka = A.map(key);
  const kb = B.map(key);
  // 前後の同じ行は先に取り除く（表を小さくする）
  let pre = 0;
  while (pre < ka.length && pre < kb.length && ka[pre] === kb[pre]) pre++;
  let post = 0;
  while (post < ka.length - pre && post < kb.length - pre && ka[ka.length - 1 - post] === kb[kb.length - 1 - post]) post++;
  const out: LineDiff[] = [];
  for (let i = 0; i < pre; i++) out.push({ kind: "same", text: A[i] });
  const n = ka.length - pre - post;
  const m = kb.length - pre - post;
  const dp = new Uint16Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = ka[pre + i] === kb[pre + j] ? dp[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ka[pre + i] === kb[pre + j]) {
      out.push({ kind: "same", text: A[pre + i] });
      i++;
      j++;
    } else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) {
      out.push({ kind: "del", text: A[pre + i] });
      i++;
    } else {
      out.push({ kind: "add", text: B[pre + j] });
      j++;
    }
  }
  while (i < n) out.push({ kind: "del", text: A[pre + i++] });
  while (j < m) out.push({ kind: "add", text: B[pre + j++] });
  for (let k = ka.length - post; k < ka.length; k++) out.push({ kind: "same", text: A[k] });
  return out;
}

/** 文字列の一部。mark は「相手に無い部分」 */
export interface Segment {
  text: string;
  mark: boolean;
}

/** 行の中の文字の範囲（start 以上 end 未満。行は元の行番号） */
export interface CharRange {
  line: number;
  start: number;
  end: number;
}

/** まとまった違い：del だけ／add だけ／両方（変更）。reflow は改行の位置だけが違う（文字は同じ） */
export interface Hunk {
  kind: "del" | "add" | "change" | "reflow";
  /** いまの文書の側（del・change・reflow） */
  a: Segment[];
  /** 比べた PDF の側（add・change・reflow） */
  b: Segment[];
  /** 印の付いた文字が、元のどの行のどこにあるか（ページの上で色を付けるため） */
  aRefs: CharRange[];
  bRefs: CharRange[];
  /** この違いの行（いまの文書・比べた PDF） */
  aLines: number[];
  bLines: number[];
  /** 比べた PDF で、この違いのある位置（次に続く行。削除だけの違いを示す場所） */
  anchorB: number;
}

/** 区切りの語：漢字・かな・タイ文字などは 1 文字ずつ、数字も 1 文字ずつ、ほかの文字は空白までを 1 語にする */
const TOKEN = /\s+|\p{N}|(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}])[\p{L}\p{M}])+|[\s\S]/gu;

export function tokenize(s: string): string[] {
  return s.match(TOKEN) ?? [];
}

/** 行をつなぐ：英字どうしなら空白をはさむ。つないだ文字が元のどの行の何文字目か（はさんだ空白は -1）も返す */
function joinLinesMap(lines: string[], nums: number[]): { text: string; line: number[]; pos: number[] } {
  let out = "";
  const line: number[] = [];
  const pos: number[] = [];
  lines.forEach((l, k) => {
    const lead = l.length - l.trimStart().length;
    const t = l.trim();
    if (!t) return;
    if (out && /[\p{L}\p{N}.,;:!?)]$/u.test(out) && /^[\p{L}\p{N}(]/u.test(t) && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(out) && !/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(t)) {
      out += " ";
      line.push(-1);
      pos.push(-1);
    }
    for (let c = 0; c < t.length; c++) {
      line.push(nums[k]);
      pos.push(lead + c);
    }
    out += t;
  });
  return { text: out, line, pos };
}

/** 印の付いた部分を、元の行の文字の範囲にする */
function refsOf(segs: Segment[], map: { line: number[]; pos: number[] }): CharRange[] {
  const out: CharRange[] = [];
  let off = 0;
  for (const sg of segs) {
    if (sg.mark) {
      for (let k = off; k < off + sg.text.length; k++) {
        const ln = map.line[k];
        if (ln == null || ln < 0) continue;
        const p = map.pos[k];
        const last = out[out.length - 1];
        if (last && last.line === ln && last.end === p) last.end = p + 1;
        else out.push({ line: ln, start: p, end: p + 1 });
      }
    }
    off += sg.text.length;
  }
  return out;
}

/** 語の差分。表が大きくなりすぎるときは、前後の同じ部分を除いた残りをまとめて違いとする */
export function diffTokens(a: string, b: string, loose: boolean): { a: Segment[]; b: Segment[] } {
  const ta = tokenize(a);
  const tb = tokenize(b);
  const ws = (t: string) => /^\s+$/u.test(t);
  const key = (t: string) => (ws(t) ? " " : loose ? t.normalize("NFKC") : t);
  // 比べる語（loose なら空白は比べない）
  const ia = ta.map((_, i) => i).filter((i) => !(loose && ws(ta[i])));
  const ib = tb.map((_, i) => i).filter((i) => !(loose && ws(tb[i])));
  const ka = ia.map((i) => key(ta[i]));
  const kb = ib.map((i) => key(tb[i]));
  const ma = new Uint8Array(ta.length);
  const mb = new Uint8Array(tb.length);
  let pre = 0;
  while (pre < ka.length && pre < kb.length && ka[pre] === kb[pre]) pre++;
  let post = 0;
  while (post < ka.length - pre && post < kb.length - pre && ka[ka.length - 1 - post] === kb[kb.length - 1 - post]) post++;
  const n = ka.length - pre - post;
  const m = kb.length - pre - post;
  if (n * m > 2_000_000) {
    for (let k = pre; k < pre + n; k++) ma[ia[k]] = 1;
    for (let k = pre; k < pre + m; k++) mb[ib[k]] = 1;
  } else {
    const dp = new Uint16Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * (m + 1) + j] = ka[pre + i] === kb[pre + j] ? dp[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (ka[pre + i] === kb[pre + j]) {
        i++;
        j++;
      } else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) ma[ia[pre + i++]] = 1;
      else mb[ib[pre + j++]] = 1;
    }
    while (i < n) ma[ia[pre + i++]] = 1;
    while (j < m) mb[ib[pre + j++]] = 1;
  }
  return { a: segments(ta, ma), b: segments(tb, mb) };
}

/** 印の付いた語の間の空白にも印を付けてつなげ、同じ印の部分をまとめる */
function segments(tokens: string[], mark: Uint8Array): Segment[] {
  const out: Segment[] = [];
  for (let i = 0; i < tokens.length; i++) {
    let m = mark[i] === 1;
    if (!m && /^\s+$/u.test(tokens[i]) && mark[i - 1] && mark[i + 1]) m = true;
    const last = out[out.length - 1];
    if (last && last.mark === m) last.text += tokens[i];
    else out.push({ text: tokens[i], mark: m });
  }
  return out;
}

/** 行の差分を、まとまった違い（hunk）にする。続いて変わった行はつないで比べ、語・文字単位の違いに印を付ける */
export function textHunks(a: string[], b: string[], loose: boolean): Hunk[] {
  const diff = diffLines(a, b, (s) => normKey(s, loose));
  const hunks: Hunk[] = [];
  let del: number[] = [];
  let add: number[] = [];
  let ia = 0;
  let ib = 0;
  const flush = () => {
    if (!del.length && !add.length) return;
    const ma = joinLinesMap(del.map((i) => a[i]), del);
    const mb = joinLinesMap(add.map((i) => b[i]), add);
    const base = { aLines: del, bLines: add, anchorB: add.length ? add[0] : Math.min(ib, Math.max(0, b.length - 1)) };
    if (del.length && add.length) {
      if (normKey(ma.text, loose) === normKey(mb.text, loose)) hunks.push({ kind: "reflow", a: [{ text: ma.text, mark: false }], b: [{ text: mb.text, mark: false }], aRefs: [], bRefs: [], ...base });
      else {
        const d = diffTokens(ma.text, mb.text, loose);
        hunks.push({ kind: "change", ...d, aRefs: refsOf(d.a, ma), bRefs: refsOf(d.b, mb), ...base });
      }
    } else if (del.length) {
      const sg = [{ text: ma.text, mark: true }];
      hunks.push({ kind: "del", a: sg, b: [], aRefs: refsOf(sg, ma), bRefs: [], ...base });
    } else {
      const sg = [{ text: mb.text, mark: true }];
      hunks.push({ kind: "add", a: [], b: sg, aRefs: [], bRefs: refsOf(sg, mb), ...base });
    }
    del = [];
    add = [];
  };
  for (const d of diff) {
    if (d.kind === "same") {
      flush();
      ia++;
      ib++;
    } else if (d.kind === "del") del.push(ia++);
    else add.push(ib++);
  }
  flush();
  return hunks;
}

// ───────────────────────── ページの対応づけ ─────────────────────────

const MH = 64;
const SEEDS = (() => {
  const s = new Uint32Array(MH);
  let x = 0x9e3779b9;
  for (let i = 0; i < MH; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    s[i] = x >>> 0;
  }
  return s;
})();

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** ページの文字の指紋（3 文字ずつの並びの MinHash）。文字が無ければ null */
export function textPrint(lines: string[]): Uint32Array | null {
  const s = normKey(lines.join(""), true);
  if (!s) return null;
  const sig = new Uint32Array(MH).fill(0xffffffff);
  const shingles = new Set<number>();
  if (s.length < 3) shingles.add(fnv(s));
  for (let i = 0; i + 3 <= s.length; i++) shingles.add(fnv(s.slice(i, i + 3)));
  for (const h of shingles) {
    for (let k = 0; k < MH; k++) {
      let x = (h ^ SEEDS[k]) >>> 0;
      x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
      x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
      x = (x ^ (x >>> 16)) >>> 0;
      if (x < sig[k]) sig[k] = x;
    }
  }
  return sig;
}

export function textSim(a: Uint32Array, b: Uint32Array): number {
  let same = 0;
  for (let k = 0; k < MH; k++) if (a[k] === b[k]) same++;
  return same / MH;
}

/** 縮小画像の指紋の一辺（縦横比によらず、この大きさの正方形にする） */
export const PRINT_SIDE = 48;

/** 見た目の指紋：縮小した明るさの並び（平均 0・長さ 1）。白紙なら null */
export function imagePrint(img: ImageLike): Float32Array | null {
  const S = PRINT_SIDE;
  const v = new Float32Array(S * S);
  const sum = new Float32Array(S * S);
  const cnt = new Float32Array(S * S);
  for (let y = 0; y < img.height; y++) {
    const gy = Math.min(S - 1, Math.floor((y * S) / img.height));
    for (let x = 0; x < img.width; x++) {
      const gx = Math.min(S - 1, Math.floor((x * S) / img.width));
      const i = (y * img.width + x) * 4;
      sum[gy * S + gx] += 255 - (img.data[i] * 77 + img.data[i + 1] * 150 + img.data[i + 2] * 29) / 256;
      cnt[gy * S + gx]++;
    }
  }
  let mean = 0;
  for (let i = 0; i < v.length; i++) {
    v[i] = cnt[i] ? sum[i] / cnt[i] : 0;
    mean += v[i];
  }
  mean /= v.length;
  let norm = 0;
  for (let i = 0; i < v.length; i++) {
    v[i] -= mean;
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm);
  if (norm < 1e-3 * v.length) return null;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

/** 指紋を 90 度回したもの（turns 回） */
export function rotatePrint(p: Float32Array, turns: number): Float32Array {
  const S = PRINT_SIDE;
  let cur = p;
  for (let t = 0; t < ((turns % 4) + 4) % 4; t++) {
    const out = new Float32Array(S * S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) out[x * S + (S - 1 - y)] = cur[y * S + x];
    cur = out;
  }
  return cur;
}

export function imageSim(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return Math.max(0, s);
}

/** 対応づけの結果の 1 件。a・b はページ番号（0 から）。move は順番の変わったページ */
export interface PagePair {
  a: number | null;
  b: number | null;
  kind: "pair" | "del" | "add" | "move";
}

/** 順番を保ったまま、score（0 以下なら組にしない）の合計が最も大きくなる組み合わせ。as・bs はページ番号の並び */
function dpAlign(as: number[], bs: number[], score: (i: number, j: number) => number): PagePair[] {
  const n = as.length;
  const m = bs.length;
  const W = m + 1;
  const dp = new Float32Array((n + 1) * W);
  const sc = new Float32Array(n * m);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) sc[i * m + j] = score(as[i], bs[j]);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      let v = Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
      const s = sc[i * m + j];
      if (s > 0) v = Math.max(v, dp[(i + 1) * W + j + 1] + s);
      dp[i * W + j] = v;
    }
  }
  const steps: PagePair[] = [];
  let i = 0;
  let j = 0;
  const EPS = 1e-5;
  while (i < n || j < m) {
    if (i < n && j < m) {
      const s = sc[i * m + j];
      if (s > 0 && Math.abs(dp[i * W + j] - (dp[(i + 1) * W + j + 1] + s)) < EPS) {
        steps.push({ a: as[i++], b: bs[j++], kind: "pair" });
        continue;
      }
      if (Math.abs(dp[i * W + j] - dp[(i + 1) * W + j]) < EPS) steps.push({ a: as[i++], b: null, kind: "del" });
      else steps.push({ a: null, b: bs[j++], kind: "add" });
    } else if (i < n) steps.push({ a: as[i++], b: null, kind: "del" });
    else steps.push({ a: null, b: bs[j++], kind: "add" });
  }
  return steps;
}

/** 隙間（組と組の間）ごとに fn で置き換える */
function eachGap(steps: PagePair[], fn: (gap: PagePair[]) => PagePair[]): PagePair[] {
  const out: PagePair[] = [];
  let k = 0;
  while (k < steps.length) {
    if (steps[k].kind !== "del" && steps[k].kind !== "add") {
      out.push(steps[k++]);
      continue;
    }
    const gap: PagePair[] = [];
    while (k < steps.length && (steps[k].kind === "del" || steps[k].kind === "add")) gap.push(steps[k++]);
    out.push(...fn(gap));
  }
  return out;
}

/**
 * ページの対応づけ。
 * 1. よく似たページ（strong）どうしを、順番を保ったまま組にする
 * 2. 組にならなかったページで、よく似た相手が離れた所にあれば「移動」（move）
 * 3. 同じ隙間に残ったページは、少し似ていれば（weak）順番を保って組にし、それでも残れば順に組にする（書き換えたページ）
 */
export function alignPages(
  n: number,
  m: number,
  strong: (i: number, j: number) => number,
  weak: (i: number, j: number) => number,
  move: (i: number, j: number) => number,
): PagePair[] {
  // 大きすぎる文書は、番号どうしで組にする
  if (n * m > 4_000_000) {
    const out: PagePair[] = [];
    for (let i = 0; i < Math.max(n, m); i++) out.push({ a: i < n ? i : null, b: i < m ? i : null, kind: i < n && i < m ? "pair" : i < n ? "del" : "add" });
    return out;
  }
  const range = (k: number) => Array.from({ length: k }, (_, i) => i);
  const steps = dpAlign(range(n), range(m), strong);
  // 移動
  const dels = steps.filter((s) => s.kind === "del");
  const adds = steps.filter((s) => s.kind === "add");
  const cands: { d: PagePair; ad: PagePair; s: number }[] = [];
  for (const d of dels)
    for (const ad of adds) {
      const s = move(d.a!, ad.b!);
      if (s > 0) cands.push({ d, ad, s });
    }
  cands.sort((x, y) => y.s - x.s);
  const usedD = new Set<PagePair>();
  const usedA = new Set<PagePair>();
  for (const c of cands) {
    if (usedD.has(c.d) || usedA.has(c.ad)) continue;
    usedD.add(c.d);
    usedA.add(c.ad);
    c.d.kind = "move";
    c.d.b = c.ad.b;
  }
  const rest = steps.filter((s) => !usedA.has(s));
  return eachGap(rest, (gap) => {
    const ds = gap.filter((g) => g.kind === "del").map((g) => g.a!);
    const as = gap.filter((g) => g.kind === "add").map((g) => g.b!);
    if (!ds.length || !as.length) return gap;
    return eachGap(dpAlign(ds, as, weak), (g2) => {
      const d2 = g2.filter((g) => g.kind === "del");
      const a2 = g2.filter((g) => g.kind === "add");
      const p = Math.min(d2.length, a2.length);
      const out: PagePair[] = [];
      for (let q = 0; q < p; q++) out.push({ a: d2[q].a, b: a2[q].b, kind: "pair" });
      return [...out, ...d2.slice(p), ...a2.slice(p)];
    });
  });
}

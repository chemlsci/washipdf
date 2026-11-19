/**
 * TrueType（glyf 形式）フォントの簡易サブセット化。
 *
 * @pdf-lib/fontkit のサブセット機能は、同梱の BIZ UD フォントでグリフデータが壊れる（文字の形が欠ける）ため、
 * ここで「使う文字以外のグリフを空にしたフォント」を作り、pdf-lib には subset: false で渡す。
 * グリフ番号は元のまま変えないので、幅・カーソル位置などはすべて元フォントと一致する。
 */

const DROP_TABLES = new Set(["GSUB", "GPOS", "GDEF", "BASE", "JSTF", "DSIG", "hdmx", "LTSH", "VDMX", "vhea", "vmtx", "VORG", "meta", "kern"]);

interface TableRec {
  tag: string;
  offset: number;
  length: number;
}

export interface TtfInfo {
  view: DataView;
  bytes: Uint8Array;
  tables: Map<string, TableRec>;
  numGlyphs: number;
  longLoca: boolean;
}

/** needCmap=false：字形の輪郭だけを見る用途（PDF に埋め込まれた、cmap を持たない一部埋め込みフォント） */
export function parseTtf(bytes: Uint8Array, needCmap = true): TtfInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numTables = view.getUint16(4);
  const tables = new Map<string, TableRec>();
  for (let i = 0; i < numTables; i++) {
    const p = 12 + i * 16;
    const tag = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
    tables.set(tag, { tag, offset: view.getUint32(p + 8), length: view.getUint32(p + 12) });
  }
  for (const t of ["head", "maxp", "loca", "glyf", "cmap"]) {
    if (!tables.has(t) && (needCmap || t !== "cmap")) throw new Error(`TrueType フォントに ${t} テーブルがありません`);
  }
  const head = tables.get("head")!;
  const maxp = tables.get("maxp")!;
  return {
    view,
    bytes,
    tables,
    numGlyphs: view.getUint16(maxp.offset + 4),
    longLoca: view.getInt16(head.offset + 50) === 1,
  };
}

function locaOffset(f: TtfInfo, gid: number): number {
  const loca = f.tables.get("loca")!;
  return f.longLoca ? f.view.getUint32(loca.offset + gid * 4) : f.view.getUint16(loca.offset + gid * 2) * 2;
}

/** グリフの生データ（glyf テーブル内の該当部分） */
export function glyphData(f: TtfInfo, gid: number): Uint8Array {
  if (gid < 0 || gid >= f.numGlyphs) return new Uint8Array(0);
  const glyf = f.tables.get("glyf")!;
  const a = locaOffset(f, gid);
  const b = locaOffset(f, gid + 1);
  return f.bytes.subarray(glyf.offset + a, glyf.offset + Math.max(a, b));
}

/** Unicode コードポイント → グリフ番号（cmap の format 12 / 4 を参照） */
/** 表が壊れていて読めないときは 0（字形なし）を返す */
export function glyphIdForCodePoint(f: TtfInfo, cp: number): number {
  try {
    return glyphIdForCodePointRaw(f, cp);
  } catch {
    return 0;
  }
}

function glyphIdForCodePointRaw(f: TtfInfo, cp: number): number {
  const cmap = f.tables.get("cmap")!;
  const v = f.view;
  const n = v.getUint16(cmap.offset + 2);
  let fmt12 = -1;
  let fmt4 = -1;
  for (let i = 0; i < n; i++) {
    const p = cmap.offset + 4 + i * 8;
    const pid = v.getUint16(p);
    const eid = v.getUint16(p + 2);
    const off = cmap.offset + v.getUint32(p + 4);
    const format = v.getUint16(off);
    if (format === 12 && (pid === 3 || pid === 0)) fmt12 = off;
    if (format === 4 && ((pid === 3 && eid === 1) || pid === 0)) fmt4 = off;
  }
  if (fmt12 >= 0) {
    const groups = v.getUint32(fmt12 + 12);
    let lo = 0;
    let hi = groups - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const p = fmt12 + 16 + mid * 12;
      const start = v.getUint32(p);
      const end = v.getUint32(p + 4);
      if (cp < start) hi = mid - 1;
      else if (cp > end) lo = mid + 1;
      else return v.getUint32(p + 8) + (cp - start);
    }
    return 0;
  }
  if (fmt4 >= 0 && cp <= 0xffff) {
    const segX2 = v.getUint16(fmt4 + 6);
    const ends = fmt4 + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const ranges = deltas + segX2;
    for (let i = 0; i < segX2; i += 2) {
      if (cp > v.getUint16(ends + i)) continue;
      const start = v.getUint16(starts + i);
      if (cp < start) return 0;
      const delta = v.getInt16(deltas + i);
      const ro = v.getUint16(ranges + i);
      if (ro === 0) return (cp + delta) & 0xffff;
      const g = v.getUint16(ranges + i + ro + (cp - start) * 2);
      return g === 0 ? 0 : (g + delta) & 0xffff;
    }
  }
  return 0;
}

/** 複合グリフが参照している部品グリフ */
function componentGlyphs(data: Uint8Array): number[] {
  if (data.length < 10) return [];
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (v.getInt16(0) >= 0) return [];
  const out: number[] = [];
  let p = 10;
  for (;;) {
    if (p + 4 > data.length) break;
    const flags = v.getUint16(p);
    out.push(v.getUint16(p + 2));
    p += 4 + (flags & 0x0001 ? 4 : 2);
    if (flags & 0x0008) p += 2;
    else if (flags & 0x0040) p += 4;
    else if (flags & 0x0080) p += 8;
    if (!(flags & 0x0020)) break;
  }
  return out;
}

function checksum(data: Uint8Array): number {
  let sum = 0;
  const padded = data.length % 4 ? new Uint8Array(data.length + (4 - (data.length % 4))) : data;
  if (padded !== data) padded.set(data);
  const v = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  for (let i = 0; i < padded.length; i += 4) sum = (sum + v.getUint32(i)) >>> 0;
  return sum;
}

type CmapGroup = [start: number, end: number, gid: number];

/** コードポイント順に並べ、コードポイントもグリフ番号も連続している所を1つのグループにまとめる */
function cmapGroups(pairs: [number, number][]): CmapGroup[] {
  const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
  const groups: CmapGroup[] = [];
  for (const [cp, gid] of sorted) {
    const last = groups[groups.length - 1];
    if (last && cp === last[1] + 1 && gid === last[2] + (cp - last[0])) last[1] = cp;
    else groups.push([cp, cp, gid]);
  }
  return groups;
}

/** format 4（基本多言語面のみ）。Windows / Acrobat が標準として探す (3,1) 用 */
function cmapFormat4(groups: CmapGroup[]): Uint8Array | null {
  const segs = groups.filter(([a]) => a <= 0xfffe).map(([a, b, g]): CmapGroup => [a, Math.min(b, 0xfffe), g]);
  segs.push([0xffff, 0xffff, 0]); // 終端（.notdef に対応させる決まり）
  const n = segs.length;
  const len = 16 + n * 8;
  if (len > 0xffff) return null;
  const out = new Uint8Array(len);
  const v = new DataView(out.buffer);
  let es = 0;
  while (1 << (es + 1) <= n) es++;
  v.setUint16(0, 4);
  v.setUint16(2, len);
  v.setUint16(6, n * 2);
  v.setUint16(8, 2 << es);
  v.setUint16(10, es);
  v.setUint16(12, n * 2 - (2 << es));
  const ends = 14;
  const starts = ends + n * 2 + 2;
  const deltas = starts + n * 2;
  segs.forEach(([a, b, g], i) => {
    v.setUint16(ends + i * 2, b);
    v.setUint16(starts + i * 2, a);
    v.setUint16(deltas + i * 2, b === 0xffff ? 1 : (g - a) & 0xffff); // idRangeOffset は 0 のまま
  });
  return out;
}

/** format 12（全面）。基本多言語面外の文字も引ける (3,10) 用 */
function cmapFormat12(groups: CmapGroup[]): Uint8Array {
  const out = new Uint8Array(16 + groups.length * 12);
  const v = new DataView(out.buffer);
  v.setUint16(0, 12);
  v.setUint32(4, out.length);
  v.setUint32(12, groups.length);
  groups.forEach(([a, b, g], i) => {
    const p = 16 + i * 12;
    v.setUint32(p, a);
    v.setUint32(p + 4, b);
    v.setUint32(p + 8, g);
  });
  return out;
}

/**
 * 使う文字のコードポイント → グリフ番号の対応だけを持つ cmap。
 * (3,1) format 4 と (3,10) format 12 の両方を入れる（元フォントと同じ構成）。
 * (3,10) だけだと仕様外になり、Acrobat が「埋め込みフォントを抽出できません」と警告して表示・検索できなくなる。
 */
function buildCmap(pairs: [number, number][]): Uint8Array {
  const groups = cmapGroups(pairs);
  const subs: [number, number, Uint8Array][] = [];
  const f4 = cmapFormat4(groups);
  if (f4) subs.push([3, 1, f4]);
  subs.push([3, 10, cmapFormat12(groups)]);
  let size = 4 + subs.length * 8;
  for (const [, , d] of subs) size += d.length;
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  v.setUint16(2, subs.length);
  let off = 4 + subs.length * 8;
  subs.forEach(([pid, eid, d], i) => {
    v.setUint16(4 + i * 8, pid);
    v.setUint16(6 + i * 8, eid);
    v.setUint32(8 + i * 8, off);
    out.set(d, off);
    off += d.length;
  });
  return out;
}

/** name テーブルの PostScript 名（nameID 6） */
export function postScriptName(f: TtfInfo): string | null {
  const t = f.tables.get("name");
  if (!t) return null;
  const v = f.view;
  const count = v.getUint16(t.offset + 2);
  const strings = t.offset + v.getUint16(t.offset + 4);
  for (let i = 0; i < count; i++) {
    const p = t.offset + 6 + i * 12;
    if (v.getUint16(p + 6) !== 6) continue;
    const pid = v.getUint16(p);
    const len = v.getUint16(p + 8);
    const start = strings + v.getUint16(p + 10);
    let s = "";
    if (pid === 3 || pid === 0) for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode(v.getUint16(start + k));
    else for (let k = 0; k < len; k++) s += String.fromCharCode(f.bytes[start + k]);
    s = s.replace(/[^\x21-\x7e]|[\[\](){}<>/%#]/g, "");
    if (s) return s;
  }
  return null;
}

/** 指定した文字だけを描けるフォントを作る（グリフ番号は元のまま） */
/** 送り幅と左サイドベアリング（hmtx） */
function hMetric(f: TtfInfo, gid: number): [number, number] {
  const hhea = f.tables.get("hhea");
  const hmtx = f.tables.get("hmtx");
  if (!hhea || !hmtx) return [0, 0];
  const numH = f.view.getUint16(hhea.offset + 34);
  if (numH === 0) return [0, 0];
  if (gid < numH) return [f.view.getUint16(hmtx.offset + gid * 4), f.view.getInt16(hmtx.offset + gid * 4 + 2)];
  const lsbOff = hmtx.offset + numH * 4 + (gid - numH) * 2;
  return [f.view.getUint16(hmtx.offset + (numH - 1) * 4), lsbOff + 2 <= hmtx.offset + hmtx.length ? f.view.getInt16(lsbOff) : 0];
}

/**
 * text の文字に加えて、整形で使うグリフ番号（extraGids）も残す。グリフ番号は変えない。
 * clones（新しい番号 → 元の番号）を渡すと、同じ字形を別の番号として末尾に複製する
 * （1 つの字形が複数の文字を表すとき、ToUnicode を正確にするため）。
 */
/**
 * keepCmap：文字コード → 字形の表（cmap）を元のまま残す。1 バイトの文字コードで書くフォント（PDF の TrueType）は、
 * 表示ソフトがこの表で字形を引くので、作り直さない（字形の番号は変わらないので、元の表がそのまま使える）
 */
export function subsetTtf(font: Uint8Array, text: string, extraGids?: Iterable<number>, clones?: Map<number, number>, alsoDrop?: readonly string[], keepCmap = false, scrubMetrics = false): Uint8Array {
  // 文字から字形を引かない（字形番号だけを渡された）ときは、文字の対応表（cmap）が無いフォントでもよい
  const f = parseTtf(font, text.length > 0);
  const pairs: [number, number][] = [];
  const keep = new Set<number>([0]);
  for (const g of extraGids ?? []) if (g > 0 && g < f.numGlyphs) keep.add(g);
  const cloneList = [...(clones ?? [])].filter(([n, src]) => n >= f.numGlyphs && src > 0 && src < f.numGlyphs);
  for (const [, src] of cloneList) keep.add(src);
  const numGlyphs = cloneList.length ? Math.max(f.numGlyphs, ...cloneList.map(([n]) => n + 1)) : f.numGlyphs;
  const srcOf = (gid: number) => (gid < f.numGlyphs ? gid : (clones?.get(gid) ?? 0));
  const seen = new Set<number>();
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (seen.has(cp)) continue;
    seen.add(cp);
    const gid = glyphIdForCodePoint(f, cp);
    if (gid) {
      pairs.push([cp, gid]);
      keep.add(gid);
    }
  }
  // 複合グリフの部品もたどって残す
  const stack = [...keep];
  while (stack.length) {
    for (const c of componentGlyphs(glyphData(f, stack.pop()!))) {
      if (c < f.numGlyphs && !keep.has(c)) {
        keep.add(c);
        stack.push(c);
      }
    }
  }

  // 新しい glyf / loca（long 形式）。複製は元の字形データをそのまま使う
  const want = (gid: number) => (gid < f.numGlyphs ? keep.has(gid) : clones?.has(gid) === true);
  let glyfLen = 0;
  for (let gid = 0; gid < numGlyphs; gid++) if (want(gid)) glyfLen += (glyphData(f, srcOf(gid)).length + 3) & ~3;
  const glyf = new Uint8Array(glyfLen);
  const loca = new Uint8Array((numGlyphs + 1) * 4);
  const lv = new DataView(loca.buffer);
  let pos = 0;
  for (let gid = 0; gid < numGlyphs; gid++) {
    lv.setUint32(gid * 4, pos);
    if (want(gid)) {
      const d = glyphData(f, srcOf(gid));
      glyf.set(d, pos);
      pos += (d.length + 3) & ~3;
    }
  }
  lv.setUint32(numGlyphs * 4, pos);

  const tableData = new Map<string, Uint8Array>();
  for (const [tag, rec] of f.tables) {
    if (DROP_TABLES.has(tag) || alsoDrop?.includes(tag)) continue;
    tableData.set(tag, font.slice(rec.offset, rec.offset + rec.length));
  }
  tableData.set("glyf", glyf);
  tableData.set("loca", loca);
  if (!keepCmap || !tableData.has("cmap")) tableData.set("cmap", buildCmap(pairs));
  // 墨消しの後始末で使うとき：空にした字形の幅（hmtx）も 0 にする（フォントの中の幅から、何の字だったかを推し量れないように）
  if (keepCmap || scrubMetrics) {
    const hmtx = tableData.get("hmtx");
    const hhea = tableData.get("hhea");
    if (hmtx && hhea && hhea.length >= 36) {
      const numH = new DataView(hhea.buffer, hhea.byteOffset, hhea.byteLength).getUint16(34);
      const copy = hmtx.slice();
      // 最後の幅の項目は、それ以降の字形すべての幅を兼ねる。以降に残す字形があれば、その幅には触らない
      let lastShared = false;
      for (let gid = numH - 1; gid < f.numGlyphs; gid++) if (keep.has(gid)) lastShared = true;
      for (let gid = 1; gid < f.numGlyphs; gid++) {
        if (keep.has(gid)) continue;
        if (gid < numH) {
          const o = gid * 4;
          if (o + 4 > copy.length) break;
          if (!(gid === numH - 1 && lastShared)) copy[o] = copy[o + 1] = 0;
          copy[o + 2] = copy[o + 3] = 0;
        } else {
          const o = numH * 4 + (gid - numH) * 2;
          if (o + 2 > copy.length) break;
          copy[o] = copy[o + 1] = 0;
        }
      }
      tableData.set("hmtx", copy);
    }
  }
  if (numGlyphs !== f.numGlyphs) {
    // 複製した分だけ hmtx を伸ばし、maxp / hhea のグリフ数を更新する
    const hmtx = new Uint8Array(numGlyphs * 4);
    const hv = new DataView(hmtx.buffer);
    for (let gid = 0; gid < numGlyphs; gid++) {
      const [adv, lsb] = hMetric(f, srcOf(gid));
      hv.setUint16(gid * 4, adv);
      hv.setInt16(gid * 4 + 2, lsb);
    }
    tableData.set("hmtx", hmtx);
    const hhea = tableData.get("hhea")!;
    new DataView(hhea.buffer, hhea.byteOffset, hhea.byteLength).setUint16(34, numGlyphs);
    const maxp = tableData.get("maxp")!;
    new DataView(maxp.buffer, maxp.byteOffset, maxp.byteLength).setUint16(4, numGlyphs);
  }
  const head = tableData.get("head")!;
  const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  hv.setUint32(8, 0); // checkSumAdjustment（最後に計算し直す）
  hv.setInt16(50, 1); // indexToLocFormat = long
  const post = tableData.get("post");
  if (post && post.length > 32) {
    // グリフ名を持たない version 3.0 にする
    const p3 = post.slice(0, 32);
    new DataView(p3.buffer).setUint32(0, 0x00030000);
    tableData.set("post", p3);
  }

  // フォントファイルを組み立てる
  const tags = [...tableData.keys()].sort();
  const numTables = tags.length;
  let entrySelector = 0;
  while (1 << (entrySelector + 1) <= numTables) entrySelector++;
  const searchRange = (1 << entrySelector) * 16;
  let size = 12 + numTables * 16;
  for (const t of tags) size += (tableData.get(t)!.length + 3) & ~3;
  const out = new Uint8Array(size);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, 0x00010000);
  ov.setUint16(4, numTables);
  ov.setUint16(6, searchRange);
  ov.setUint16(8, entrySelector);
  ov.setUint16(10, numTables * 16 - searchRange);
  let offset = 12 + numTables * 16;
  let headOffset = 0;
  tags.forEach((tag, i) => {
    const data = tableData.get(tag)!;
    const p = 12 + i * 16;
    for (let k = 0; k < 4; k++) out[p + k] = tag.charCodeAt(k);
    ov.setUint32(p + 4, checksum(data));
    ov.setUint32(p + 8, offset);
    ov.setUint32(p + 12, data.length);
    out.set(data, offset);
    if (tag === "head") headOffset = offset;
    offset += (data.length + 3) & ~3;
  });
  ov.setUint32(headOffset + 8, (0xb1b0afba - checksum(out)) >>> 0);
  return out;
}

/** グリフの送り幅（unitsPerEm 単位）。hmtx / hhea から引く */
export function advanceWidth(f: TtfInfo, gid: number): number {
  const hhea = f.tables.get("hhea");
  const hmtx = f.tables.get("hmtx");
  if (!hhea || !hmtx) return 0;
  const numH = f.view.getUint16(hhea.offset + 34);
  if (numH === 0) return 0;
  const i = Math.min(gid, numH - 1);
  return f.view.getUint16(hmtx.offset + i * 4);
}

/**
 * 文字コード → 字形番号（PDF に埋め込まれた、記号用の対応表だけを持つ一部埋め込みフォント向け）。
 * (1,0) と (3,0) の表を、文字コードそのまま・0xF000 を足した値の順に引く。見つからなければ 0
 */
/** 表が壊れていて読めないときは 0（字形なし）を返す */
export function glyphIdForCode(f: TtfInfo, code: number): number {
  try {
    return glyphIdForCodeRaw(f, code);
  } catch {
    return 0;
  }
}

function glyphIdForCodeRaw(f: TtfInfo, code: number): number {
  const cmap = f.tables.get("cmap");
  if (!cmap) return 0;
  const v = f.view;
  const n = v.getUint16(cmap.offset + 2);
  const look = (off: number, c: number): number => {
    const format = v.getUint16(off);
    if (format === 0) return c < 256 ? v.getUint8(off + 6 + c) : 0;
    if (format === 6) {
      const first = v.getUint16(off + 6);
      const count = v.getUint16(off + 8);
      return c >= first && c < first + count ? v.getUint16(off + 10 + (c - first) * 2) : 0;
    }
    if (format === 4) {
      const segX2 = v.getUint16(off + 6);
      const ends = off + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const ranges = deltas + segX2;
      for (let i = 0; i < segX2; i += 2) {
        if (c > v.getUint16(ends + i)) continue;
        const start = v.getUint16(starts + i);
        if (c < start) return 0;
        const delta = v.getInt16(deltas + i);
        const ro = v.getUint16(ranges + i);
        if (ro === 0) return (c + delta) & 0xffff;
        const g = v.getUint16(ranges + i + ro + (c - start) * 2);
        return g === 0 ? 0 : (g + delta) & 0xffff;
      }
    }
    return 0;
  };
  for (let i = 0; i < n; i++) {
    const p = cmap.offset + 4 + i * 8;
    const pid = v.getUint16(p);
    const eid = v.getUint16(p + 2);
    if (!((pid === 1 && eid === 0) || (pid === 3 && eid === 0))) continue;
    const off = cmap.offset + v.getUint32(p + 4);
    const g = look(off, code) || look(off, 0xf000 + code);
    if (g) return g;
  }
  return 0;
}

/** 字形の上端の高さ（em に対する比）。輪郭の無い字形は null */
export function glyphTopEm(f: TtfInfo, gid: number): number | null {
  const d = glyphData(f, gid);
  if (d.length < 10) return null;
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getInt16(8) / unitsPerEm(f);
}

/** 大文字の高さ（em に対する比）。OS/2 表（版 2 以降）に無ければ null */
export function capHeightEm(f: TtfInfo): number | null {
  const os2 = f.tables.get("OS/2");
  if (!os2 || os2.length < 90 || f.view.getUint16(os2.offset) < 2) return null;
  const v = f.view.getInt16(os2.offset + 88) / unitsPerEm(f);
  return v > 0.4 && v < 0.95 ? v : null;
}

export function unitsPerEm(f: TtfInfo): number {
  const head = f.tables.get("head")!;
  return f.view.getUint16(head.offset + 18) || 1000;
}

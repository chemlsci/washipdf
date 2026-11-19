/**
 * 保存する PDF から、「消した」ものの元データを本当に取り除く。
 * pdf-lib は、どこからも参照されていないオブジェクトもファイルに書き出す。そのため、内容ストリームを書き換えたり
 * 画像の描画命令を外したりしただけでは、元の内容ストリーム（消した文字が入っている）や元の画像がファイルに残り、
 * 解析ツールで取り出せてしまう。保存の直前に次の 2 つを行う。
 *   1. dropUnusedXObjects：消した画像・書き換えた Form XObject が、リソース辞書に名前だけ残っていたら外す
 *   2. removeUnreachableObjects：文書のルートからたどれないオブジェクトをすべて削除する
 * あわせて relinkCopiedPages：ページを複製するとき、注釈（リンクの飛び先など）が指す「別のページ」が、ページ一覧に載らない
 * 隠れた写しとして二重に作られる（pdf-lib の複製の仕様）。この写しには元の内容がそのまま入るので、参照を本物のページへ
 * 付け替えて、写しがどこからも参照されないようにする（リンクの飛び先も正しくなる）。
 */
import { PDFArray, PDFDict, type PDFDocument, PDFHexString, PDFName, PDFNull, PDFNumber, type PDFObject, type PDFPage, PDFRef, PDFStream, PDFString } from "pdf-lib";
import { findNamedDest } from "./outlines";
import { tokenizeContent } from "./contentStream";
import { pageContentBytes } from "./libDoc";
import { decodeStreamBytes } from "./pdfFontInfo";

const XOBJECT = PDFName.of("XObject");
const RESOURCES = PDFName.of("Resources");

/**
 * sensitive（消した画像・書き換える前の Form XObject の参照）が、どの内容からも使われていない名前でリソース辞書に
 * 残っていたら、その名前を外す。別のページがその画像を実際に描いている場合は、そのページの分は残す。
 * 返り値は外した名前の数。
 */
export function dropUnusedXObjects(doc: PDFDocument, sensitive: PDFRef[]): number {
  if (!sensitive.length) return 0;
  const tags = new Set(sensitive.map((r) => r.tag));
  const ctx = doc.context;
  /** /XObject 辞書ごとの、実際に使われている名前 */
  const used = new Map<PDFDict, Set<string>>();
  const visited = new Set<string>();
  const walk = (content: Uint8Array, resources: PDFDict | undefined, key: string, depth: number) => {
    if (visited.has(key) || depth > 12) return;
    visited.add(key);
    const xo = resources?.lookup(XOBJECT);
    if (!(xo instanceof PDFDict)) return;
    let names = used.get(xo);
    if (!names) used.set(xo, (names = new Set()));
    for (const op of tokenizeContent(content)) {
      if (op.op !== "Do" || op.operands[0]?.kind !== "name") continue;
      const n = op.operands[0].value;
      names.add(n);
      const raw = xo.get(PDFName.of(n));
      const target = raw ? ctx.lookup(raw) : undefined;
      if (!(target instanceof PDFStream) || String(target.dict.get(PDFName.of("Subtype"))) !== "/Form") continue;
      const own = target.dict.lookup(RESOURCES);
      const inner = decodeStreamBytes(doc, target);
      // 自前のリソースが無いフォームは、呼び出し元のリソースで名前を解決する
      if (inner) walk(inner, own instanceof PDFDict ? own : resources, `${raw instanceof PDFRef ? raw.tag : n}@${own instanceof PDFDict ? "own" : key}`, depth + 1);
    }
  };
  doc.getPages().forEach((page, i) => {
    try {
      walk(pageContentBytes(doc, page), page.node.Resources(), `page${i}`, 0);
    } catch {
      /* 読めないページは触らない */
    }
  });
  let dropped = 0;
  for (const [xo, names] of used) {
    for (const [k, v] of xo.entries()) {
      if (v instanceof PDFRef && tags.has(v.tag) && !names.has(k.decodeText())) {
        xo.delete(k);
        dropped++;
      }
    }
  }
  return dropped;
}

/** 文書のルート（trailer）からたどれないオブジェクトを削除する。返り値は削除した数 */
export function removeUnreachableObjects(doc: PDFDocument): number {
  const ctx = doc.context;
  const seen = new Set<string>();
  const stack: PDFObject[] = [];
  const t = ctx.trailerInfo;
  for (const o of [t.Root, t.Info, t.Encrypt, t.ID]) if (o) stack.push(o);
  while (stack.length) {
    const o = stack.pop()!;
    if (o instanceof PDFRef) {
      if (seen.has(o.tag)) continue;
      seen.add(o.tag);
      const target = ctx.lookup(o);
      if (target) stack.push(target);
    } else if (o instanceof PDFStream) stack.push(o.dict);
    else if (o instanceof PDFDict) for (const v of o.values()) stack.push(v);
    else if (o instanceof PDFArray) for (const v of o.asArray()) stack.push(v);
  }
  let removed = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!seen.has(ref.tag)) {
      ctx.delete(ref);
      removed++;
    }
  }
  return removed;
}

/**
 * 複製したページの注釈などが指すページ参照を、出力の本物のページへ付け替える（出力に無いページを指すものは null にする）。
 * 元のページと複製したページを同じ形でたどり、元の側がページを指している所を見つける。
 * @param srcIndices 複製した元ページの番号（copiedPages と同じ並び）
 */
export function relinkCopiedPages(out: PDFDocument, src: PDFDocument, srcIndices: number[], copiedPages: PDFPage[]): number {
  const srcPages = src.getPages();
  const indexOf = new Map(srcPages.map((p, i) => [p.ref.tag, i]));
  const real = new Map<number, PDFRef>();
  srcIndices.forEach((k, i) => {
    if (!real.has(k)) real.set(k, copiedPages[i].ref);
  });
  let fixed = 0;
  const visited = new Set<string>();
  const SKIP = new Set(["Resources", "Contents", "AP", "Thumb"]);
  const target = (s: PDFObject | undefined, o: PDFObject | undefined): PDFObject | undefined => {
    // 元の側がページを指していれば、付け替え先（本物のページ、無ければ null）を返す
    if (!(s instanceof PDFRef) || !(o instanceof PDFRef)) return undefined;
    const k = indexOf.get(s.tag);
    if (k !== undefined) return real.get(k) ?? PDFNull;
    // 元の文書の時点で、ページ一覧に載っていないページ（以前の保存でできた隠れた写しなど）を指している場合：
    // どのページに当たるか分からないので参照を外す（そのままにすると、写しの内容ごと複製されてしまう）
    const t = src.context.lookup(s);
    return t instanceof PDFDict && String(t.get(PDFName.of("Type"))) === "/Page" ? PDFNull : undefined;
  };
  /** 名前つきの行き先を、出力のページを指す配列に直す。行き先のページが出力に無ければ null */
  const explicitDest = (name: string): PDFObject | null => {
    let d = findNamedDest(src, name);
    if (d instanceof PDFDict) d = d.lookup(PDFName.of("D"));
    if (!(d instanceof PDFArray) || !d.size()) return null;
    const first = d.get(0);
    const k = first instanceof PDFRef ? indexOf.get(first.tag) : undefined;
    const page = k === undefined ? undefined : real.get(k);
    if (!page) return null;
    // 位置の指定（/XYZ 左 上 倍率 など）は、名前・数・null だけなので、そのまま使える
    const rest = d.asArray().slice(1).map((v) => (v instanceof PDFRef ? src.context.lookup(v) : v)).filter((v): v is PDFObject => v instanceof PDFName || v instanceof PDFNumber || v === PDFNull);
    return out.context.obj([page, ...rest]);
  };
  const walk = (s: PDFObject | undefined, o: PDFObject | undefined, depth: number) => {
    if (!s || !o || depth > 10) return;
    if (s instanceof PDFRef) {
      if (!(o instanceof PDFRef) || visited.has(`${s.tag}>${o.tag}`)) return;
      visited.add(`${s.tag}>${o.tag}`);
      walk(src.context.lookup(s), out.context.lookup(o), depth);
    } else if (s instanceof PDFDict && o instanceof PDFDict) {
      for (const [key, sv] of s.entries()) {
        if (SKIP.has(key.decodeText())) continue;
        const ov = o.get(key);
        // 名前で指した行き先（/Dest /sec1、/A << /S /GoTo /D (sec1) >>）：名前の表（/Dests・/Names/Dests）は出力に写らないので、
        // ここで「ページと位置」の形に直す（そのままだと、リンクがどこにも飛ばなくなる）
        const k = key.decodeText();
        if (k === "Dest" || (k === "D" && String(s.get(PDFName.of("S"))) === "/GoTo")) {
          const named = sv instanceof PDFRef ? src.context.lookup(sv) : sv;
          if (named instanceof PDFName || named instanceof PDFString || named instanceof PDFHexString) {
            const dest = explicitDest(named.decodeText());
            if (dest) o.set(key, dest);
            else o.delete(key);
            fixed++;
            continue;
          }
        }
        const t = target(sv, ov);
        if (t !== undefined) {
          if (t !== ov) {
            o.set(key, t);
            fixed++;
          }
        } else walk(sv, ov, depth + 1);
      }
    } else if (s instanceof PDFArray && o instanceof PDFArray) {
      const n = Math.min(s.size(), o.size());
      for (let i = 0; i < n; i++) {
        const sv = s.get(i);
        const ov = o.get(i);
        const t = target(sv, ov);
        if (t !== undefined) {
          if (t !== ov) {
            o.set(i, t);
            fixed++;
          }
        } else walk(sv, ov, depth + 1);
      }
    }
  };
  copiedPages.forEach((page, i) => {
    const sp = srcPages[srcIndices[i]];
    if (!sp) return;
    for (const key of ["Annots", "B"]) walk(sp.node.get(PDFName.of(key)), page.node.get(PDFName.of(key)), 0);
  });
  return fixed;
}

/**
 * 内容を消したページ（墨消し・画像の削除・文字の書き換え）の後始末：
 * - ページの縮小画像（/Thumb：消す前の見た目が入っている）、ほかのソフトの編集用データ（/PieceInfo）、ページごとのメタデータを外す
 * - 内容のどこからも使われなくなったフォント・XObject の登録を外す（消した字にだけ使われていたフォントをファイルに残さない。
 *   部分埋め込みのフォントには「使った字の一覧」が入っているので、残すと消した字を推し量れる）。
 * リソース辞書はほかのページと共有されていることがあるので、複製してから触る。
 * 名前の使われ方は広めに数える：ページの内容、そこから呼ばれる部品（Form XObject）、Type3 フォントの字形、タイリングパターンの
 * どこかに出てくる名前は残す（部品が自前のリソースを持つかどうかは区別しない＝外しすぎない）
 */
export function cleanUpAfterRemoval(doc: PDFDocument, page: PDFPage): void {
  const ctx = doc.context;
  for (const k of ["Thumb", "PieceInfo", "Metadata"]) page.node.delete(PDFName.of(k));
  const res = page.node.Resources();
  if (!res) return;
  const fontNames = new Set<string>();
  const xoNames = new Set<string>();
  const seen = new Set<PDFStream>();
  let failed = false;
  // フォントは「その名前で実際に字を描いているか」で数える（墨消しは字を描く命令だけを消し、フォントを選ぶ命令 Tf は残るため）。
  // いまのフォントは描画の状態の一部なので、q / Q で戻り、部品（Form XObject）は呼び出し元のフォントを引き継ぐ
  const scan = (bytes: Uint8Array | null, resources: PDFDict | undefined, depth: number, font: string | null) => {
    if (!bytes || depth > 16) {
      failed = failed || !bytes;
      return;
    }
    let ops;
    try {
      ops = tokenizeContent(bytes);
    } catch {
      failed = true;
      return;
    }
    const xo = resources?.lookup(XOBJECT);
    let cur = font;
    const stack: (string | null)[] = [];
    const draws = (o: (typeof ops)[number]["operands"][number] | undefined): boolean =>
      !!o && ((o.kind === "string" && o.bytes.length > 0) || (o.kind === "array" && o.items.some((it) => it.kind === "string" && it.bytes.length > 0)));
    for (const op of ops) {
      if (op.op === "q") stack.push(cur);
      else if (op.op === "Q") cur = stack.pop() ?? cur;
      else if (op.op === "Tj" || op.op === "TJ" || op.op === "'") {
        if (cur && draws(op.operands[0])) fontNames.add(cur);
      } else if (op.op === '"') {
        if (cur && draws(op.operands[2])) fontNames.add(cur);
      }
      // 名前は「#23」のような書き方（#＋16 進 2 桁）を元の字に戻してから比べる（リソース辞書の側の名前と合わせる）
      const raw = op.operands[0]?.kind === "name" ? op.operands[0].value : null;
      if (!raw) continue;
      const n = raw.replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
      if (op.op === "Tf") cur = n;
      else if (op.op === "Do") {
        xoNames.add(n);
        const target = xo instanceof PDFDict ? xo.lookup(PDFName.of(n)) : undefined;
        if (target instanceof PDFStream && String(target.dict.get(PDFName.of("Subtype"))) === "/Form") {
          // 同じ部品でも、呼び出し元のフォントが違えば数え直す（数は少ないので、深さの上限だけで止める）
          const own = target.dict.lookup(RESOURCES);
          const inherits = !(own instanceof PDFDict);
          if (!seen.has(target) || inherits) {
            seen.add(target);
            scan(decodeStreamBytes(doc, target), inherits ? resources : (own as PDFDict), depth + 1, inherits ? cur : null);
          }
        }
      }
    }
  };
  try {
    scan(pageContentBytes(doc, page), res, 0, null);
  } catch {
    failed = true;
  }
  // Type3 フォントの字形・タイリングパターン・ソフトマスクの中身も、ページのリソースの名前を使うことがある
  const each = (dictName: string, f: (v: PDFObject) => void) => {
    const d = res.lookup(PDFName.of(dictName));
    if (d instanceof PDFDict) for (const [, v] of d.entries()) f(v instanceof PDFRef ? (ctx.lookup(v) as PDFObject) : v);
  };
  each("Font", (f) => {
    const procs = f instanceof PDFDict && String(f.get(PDFName.of("Subtype"))) === "/Type3" ? f.lookup(PDFName.of("CharProcs")) : undefined;
    if (procs instanceof PDFDict)
      for (const [, v] of procs.entries()) {
        const st = v instanceof PDFRef ? ctx.lookup(v) : v;
        if (st instanceof PDFStream) scan(decodeStreamBytes(doc, st), res, 1, null);
      }
  });
  each("Pattern", (pt) => {
    if (pt instanceof PDFStream) scan(decodeStreamBytes(doc, pt), res, 1, null);
  });
  each("ExtGState", (gs) => {
    const sm = gs instanceof PDFDict ? gs.lookup(PDFName.of("SMask")) : undefined;
    const g = sm instanceof PDFDict ? sm.lookup(PDFName.of("G")) : undefined;
    if (g instanceof PDFStream) scan(decodeStreamBytes(doc, g), res, 1, null);
  });
  // 読めない内容があったら、登録は触らない（使っている名前を数え損ねて、必要なものを外さないように）
  if (failed) return;
  const copy = res.clone(ctx);
  let changed = false;
  let stub: PDFRef | undefined;
  for (const [dictName, used] of [
    ["Font", fontNames],
    ["XObject", xoNames],
  ] as const) {
    const d = res.lookup(PDFName.of(dictName));
    if (!(d instanceof PDFDict)) continue;
    const kept = d.clone(ctx);
    for (const [k] of d.entries()) {
      if (used.has(k.decodeText())) continue;
      // フォントは、名前を選ぶ命令（Tf）が内容に残っていることがあるので、名前は残して中身だけ標準フォントの指定に替える
      if (dictName === "Font") kept.set(k, (stub ??= ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" }))));
      else kept.delete(k);
      changed = true;
    }
    copy.set(PDFName.of(dictName), kept);
  }
  if (changed) page.node.set(RESOURCES, copy);
}

/**
 * 元の PDF に入っている「開いたとき・押したときに動くもの」のうち、JavaScript・外部のプログラムの起動・送信・ほかのファイルを開く動作と、
 * http(s)・mailto・tel 以外のアドレスへのリンクを外す
 * （ページを開いたとき・閉じたときの動作 /AA、注釈・入力欄の動作 /A・/AA）。文書全体の JavaScript は、
 * 保存のときに引き継がないので、残っていても動かないか、印刷のプレビューなどで思わぬ所で動くだけになる
 */
export function stripActiveActions(doc: PDFDocument): void {
  const ctx = doc.context;
  const active = (a: PDFObject | undefined): boolean => {
    const d = a instanceof PDFRef ? ctx.lookup(a) : a;
    if (!(d instanceof PDFDict)) return false;
    const s = String(d.get(PDFName.of("S")));
    // スクリプト・外部プログラムの起動・送信・外部のファイルを開く動作は外す
    if (["/JavaScript", "/Launch", "/SubmitForm", "/ImportData", "/GoToR", "/GoToE", "/Rendition", "/RichMediaExecute"].includes(s)) return true;
    // アドレスは http(s)・mailto・tel だけを残す（javascript: や file: などは外す）
    if (s === "/URI") {
      const u = d.lookup(PDFName.of("URI"));
      const url = u instanceof PDFString || u instanceof PDFHexString ? u.decodeText().trim() : "";
      if (!/^(https?:|mailto:|tel:)/i.test(url)) return true;
    }
    return active(d.get(PDFName.of("Next")));
  };
  for (const page of doc.getPages()) {
    page.node.delete(PDFName.of("AA"));
    const annots = page.node.lookup(PDFName.of("Annots"));
    if (!(annots instanceof PDFArray)) continue;
    for (const r of annots.asArray()) {
      // 入れ子の入力欄：親の辞書にも /AA（計算・書式のスクリプト）がある
      let d: PDFObject | undefined = r instanceof PDFRef ? ctx.lookup(r) : r;
      for (let depth = 0; d instanceof PDFDict && depth < 20; depth++) {
        d.delete(PDFName.of("AA"));
        if (active(d.get(PDFName.of("A")))) d.delete(PDFName.of("A"));
        const parent: PDFObject | undefined = d.get(PDFName.of("Parent"));
        d = parent instanceof PDFRef ? ctx.lookup(parent) : undefined;
      }
    }
  }
}

/**
 * レイヤー（表示・非表示を切り替えられる内容。Optional Content）の設定を、元の文書から引き継ぐ。
 * ページを写すと、レイヤーそのもの（ページのリソースから指されている）は一緒に写るが、「どのレイヤーが非表示か」などの
 * 設定（カタログの /OCProperties）は写らない。そのままだと、非表示のレイヤーが保存後に全部見えてしまう。
 * 元のページと写したページを並べてたどり、元のレイヤー → 写しのレイヤーの対応を作って、設定を組み立て直す
 * （複数の文書を合わせたときは、それぞれの設定を足し合わせる。非表示の指定は、非表示のレイヤーの一覧に直す）
 */
export function copyLayers(out: PDFDocument, parts: { src: PDFDocument; srcIndices: number[]; copied: PDFPage[] }[]): void {
  const allOcgs: PDFRef[] = [];
  const off: PDFRef[] = [];
  const order: PDFObject[] = [];
  const autoStates: PDFObject[] = [];
  const locked: PDFRef[] = [];
  const radio: PDFObject[] = [];
  const have = new Set<string>();
  /** 文書ごとに、元のレイヤー → 写し（同じページを複製したときは複数） */
  const maps = new Map<PDFDocument, Map<string, PDFRef[]>>();
  for (const { src, srcIndices, copied } of parts) {
    if (!(src.catalog.lookup(PDFName.of("OCProperties")) instanceof PDFDict)) continue;
    let map = maps.get(src);
    if (!map) maps.set(src, (map = new Map()));
    const visited = new Set<string>();
    const m = map;
    const walk = (s: PDFObject | undefined, o: PDFObject | undefined, depth: number): void => {
      if (!s || !o || depth > 60) return;
      if (s instanceof PDFRef) {
        if (!(o instanceof PDFRef)) return;
        const key = `${s.tag}>${o.tag}`;
        if (visited.has(key)) return;
        visited.add(key);
        const sd = src.context.lookup(s);
        if (sd instanceof PDFDict && String(sd.get(PDFName.of("Type"))) === "/OCG") {
          const list = m.get(s.tag) ?? [];
          if (!list.some((r) => r.tag === o.tag)) list.push(o);
          m.set(s.tag, list);
          return;
        }
        walk(sd, out.context.lookup(o), depth + 1);
      } else if (s instanceof PDFStream && o instanceof PDFStream) walk(s.dict, o.dict, depth + 1);
      else if (s instanceof PDFDict && o instanceof PDFDict) {
        for (const [key, sv] of s.entries()) {
          const k = key.decodeText();
          if (k === "Parent" || k === "P") continue;
          walk(sv, o.get(key), depth + 1);
        }
      } else if (s instanceof PDFArray && o instanceof PDFArray) {
        const n = Math.min(s.size(), o.size());
        for (let i = 0; i < n; i++) walk(s.get(i), o.get(i), depth + 1);
      }
    };
    const srcPages = src.getPages();
    copied.forEach((page, i) => {
      const sp = srcPages[srcIndices[i]];
      if (sp) walk(sp.node, page.node, 0);
    });
  }
  for (const [src, map] of maps) {
    const ocp = src.catalog.lookup(PDFName.of("OCProperties"));
    if (!(ocp instanceof PDFDict) || !map.size) continue;
    const mapped = (v: PDFObject | undefined): PDFRef[] => (v instanceof PDFRef ? (map.get(v.tag) ?? []) : []);
    const mapList = (v: PDFObject | undefined): PDFRef[] => (v instanceof PDFArray ? v.asArray().flatMap(mapped) : []);
    /** 入れ子の並び（レイヤーの一覧の表示順など）：レイヤーは写しに、見出しの文字はそのまま */
    const mapNested = (v: PDFObject | undefined, depth = 0): PDFObject[] => {
      if (!(v instanceof PDFArray) || depth > 8) return [];
      const res: PDFObject[] = [];
      for (const e of v.asArray()) {
        if (e instanceof PDFRef) {
          const t = src.context.lookup(e);
          if (t instanceof PDFArray) res.push(out.context.obj(mapNested(t, depth + 1)));
          else res.push(...mapped(e));
        } else if (e instanceof PDFArray) res.push(out.context.obj(mapNested(e, depth + 1)));
        else if (e instanceof PDFString || e instanceof PDFHexString) res.push(PDFHexString.fromText(e.decodeText()));
      }
      return res;
    };
    const all = mapList(ocp.lookup(PDFName.of("OCGs")));
    // 一覧に載っていなくても、ページから指されていたレイヤーは入れる
    for (const list of map.values()) for (const r of list) if (!all.some((x) => x.tag === r.tag)) all.push(r);
    for (const r of all) {
      if (have.has(r.tag)) continue;
      have.add(r.tag);
      allOcgs.push(r);
    }
    const d = ocp.lookup(PDFName.of("D"));
    if (!(d instanceof PDFDict)) continue;
    // 非表示のレイヤー：既定が「すべて非表示」なら、表示の指定に無いもの全部。そうでなければ、非表示の指定にあるもの
    const base = String(d.get(PDFName.of("BaseState")));
    const on = new Set(mapList(d.lookup(PDFName.of("ON"))).map((r) => r.tag));
    const hidden = base === "/OFF" ? all.filter((r) => !on.has(r.tag)) : mapList(d.lookup(PDFName.of("OFF")));
    off.push(...hidden);
    order.push(...mapNested(d.lookup(PDFName.of("Order"))));
    locked.push(...mapList(d.lookup(PDFName.of("Locked"))));
    const rb = d.lookup(PDFName.of("RBGroups"));
    if (rb instanceof PDFArray) for (const g of rb.asArray()) radio.push(out.context.obj(mapList(g instanceof PDFRef ? src.context.lookup(g) : g)));
    // 表示・印刷などの場面ごとに切り替える指定
    const as = d.lookup(PDFName.of("AS"));
    if (as instanceof PDFArray)
      for (const e of as.asArray()) {
        const a = e instanceof PDFRef ? src.context.lookup(e) : e;
        if (!(a instanceof PDFDict)) continue;
        const ocgs = mapList(a.lookup(PDFName.of("OCGs")));
        const cat = a.lookup(PDFName.of("Category"));
        if (!ocgs.length) continue;
        autoStates.push(out.context.obj({ Event: a.get(PDFName.of("Event")) ?? PDFName.of("View"), OCGs: ocgs, ...(cat instanceof PDFArray ? { Category: cat.asArray().filter((x) => x instanceof PDFName) } : {}) }));
      }
  }
  if (!allOcgs.length) return;
  const config: Record<string, PDFObject | PDFObject[]> = { OFF: off };
  if (order.length) config.Order = order;
  if (locked.length) config.Locked = locked;
  if (radio.length) config.RBGroups = radio;
  if (autoStates.length) config.AS = autoStates;
  out.catalog.set(PDFName.of("OCProperties"), out.context.obj({ OCGs: allOcgs, D: config }));
}

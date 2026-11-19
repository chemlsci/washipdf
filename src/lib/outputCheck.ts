/**
 * 保存する前の自己点検：できあがった PDF を pdf.js で開き直し、開けること・ページ数が合うことを確かめる。
 * 壊れた出力で、前からあるファイルを置き換えてしまわないための最後の関門。
 * ページの描画はしない（開いて、最初と最後のページを取り出すだけ。大きな文書でも軽い）。
 */
import { closePdf, documentOptions, getPdfJs } from "./pdfjs";
import { saslPrep, type SecuritySettings } from "./security";

export type OutputCheck = { ok: true } | { ok: false; reason: string };

/** これより長くかかったら、確かめられなかったものとして扱う（固まったまま待たせない） */
const TIMEOUT_MS = 120_000;

/**
 * 開くときに渡すパスワード。AES-256 は、書き込むときと同じく SASLprep（NFKC を含む）でそろえる
 * （pdf.js は正規化しないので、そのまま渡すと全角の英数字などで開けず、正しい出力を誤って止めてしまう）
 */
function openPassword(security?: SecuritySettings): string | undefined {
  if (!security?.enabled || !security.userPassword) return undefined;
  return security.method === "aes256" ? saslPrep(security.userPassword) : security.userPassword;
}

export async function checkOutput(bytes: Uint8Array, expectedPages: number, security?: SecuritySettings): Promise<OutputCheck> {
  const head = String.fromCharCode(...bytes.subarray(0, Math.min(1024, bytes.length)));
  if (!head.includes("%PDF-")) return { ok: false, reason: "no %PDF header" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pdfjs = await getPdfJs();
    // pdf.js は渡したバイト列をワーカーへ移す（こちらでは使えなくなる）ので、複製を渡す
    const task = pdfjs.getDocument({ ...documentOptions(), data: bytes.slice(), password: openPassword(security) });
    // パスワードが合わないときに入力待ちで止まらないようにする
    task.onPassword = () => {
      void task.destroy();
    };
    const run = (async () => {
      const pdf = await task.promise;
      try {
        if (pdf.numPages !== expectedPages) return { ok: false as const, reason: `pages ${pdf.numPages} / ${expectedPages}` };
        await pdf.getPage(1);
        if (pdf.numPages > 1) await pdf.getPage(pdf.numPages);
        return { ok: true as const };
      } finally {
        await closePdf(pdf).catch(() => undefined);
      }
    })();
    const timeout = new Promise<OutputCheck>((resolve) => {
      timer = setTimeout(() => {
        void task.destroy().catch(() => undefined);
        resolve({ ok: false, reason: "timeout" });
      }, TIMEOUT_MS);
    });
    return await Promise.race([run, timeout]);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

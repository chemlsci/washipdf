/**
 * ページの移動の確認：アプリの外のページへ移ろうとしたら、移る前に尋ねる。
 * CSP では、ページの移動（location の書き換え・window.open）を止められない。不正なスクリプトが動いたときに、
 * 移動先のアドレスに中身を載せて外へ送る抜け道を、利用者の確認なしには使えないようにする。
 * アプリ自身の移動（読み込み直し・同じサイトの中・ダウンロード・blob の表示）は尋ねない。
 * スクリプトが作ったリンクの click() も見張る。ページの移動を見張る仕組み（Navigation API）の無いブラウザーでは、
 * window.open とスクリプトによるリンクの click() だけを見張る
 */
import { tr } from "./i18n";

/** アプリの中の移動か（尋ねなくてよい移動か） */
export function allowedDestination(u: URL, here: URL): boolean {
  if (u.protocol === "blob:" || u.protocol === "about:") return true;
  if (here.protocol === "file:") return u.protocol === "file:" && u.pathname === here.pathname;
  return u.origin === here.origin;
}

const ask = (u: URL) => window.confirm(tr("nav.confirm", { host: u.host || u.protocol.replace(/:$/, "") }));

interface NavigateEventLike extends Event {
  cancelable: boolean;
  hashChange: boolean;
  downloadRequest: string | null;
  navigationType: string;
  destination: { url: string };
}

let installed = false;
export function installNavGuard(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const nav = (window as unknown as { navigation?: EventTarget }).navigation;
  nav?.addEventListener("navigate", (ev) => {
    const e = ev as NavigateEventLike;
    if (!e.cancelable || e.hashChange || e.downloadRequest != null || e.navigationType === "reload") return;
    let u: URL;
    try {
      u = new URL(e.destination.url);
    } catch {
      return;
    }
    if (allowedDestination(u, new URL(location.href))) return;
    if (!ask(u)) e.preventDefault();
  });
  const open = window.open.bind(window);
  // スクリプトが作ったリンクの click()（人の操作ではない）で外のページへ行くとき。新しいタブ（target=_blank）は
  // ページの移動の見張り（Navigation API）に掛からないので、止めて尋ねる。
  // 文書に入っているリンクは click の知らせで、文書に入れていないリンクは click() そのもので見張る
  /** 外へ行くリンクなら尋ね、行ってよければ新しいタブで開く。止めたら true */
  const intercept = (el: HTMLAnchorElement | HTMLAreaElement): boolean => {
    if (el.hasAttribute("download")) return false;
    let u: URL;
    try {
      u = new URL(el.href, location.href);
    } catch {
      return true;
    }
    if (allowedDestination(u, new URL(location.href))) return false;
    if (ask(u)) open(u.href, "_blank", "noopener");
    return true;
  };
  document.addEventListener(
    "click",
    (ev) => {
      if (ev.isTrusted) return;
      const el = (ev.target as Element | null)?.closest?.("a[href], area[href]") as HTMLAnchorElement | HTMLAreaElement | null;
      if (!el || !intercept(el)) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
    },
    true,
  );
  for (const proto of [HTMLAnchorElement.prototype, HTMLAreaElement.prototype]) {
    const click = proto.click;
    proto.click = function (this: HTMLAnchorElement | HTMLAreaElement) {
      // 文書に入っているリンクは、上の click の知らせで見張る
      if (!this.isConnected && this.getAttribute("href") != null && intercept(this)) return;
      click.call(this);
    };
  }
  window.open = function (url?: string | URL, target?: string, features?: string) {
    if (url != null && String(url) !== "") {
      let u: URL;
      try {
        u = new URL(String(url), location.href);
      } catch {
        return null;
      }
      if (!allowedDestination(u, new URL(location.href)) && !ask(u)) return null;
    }
    return open(url, target, features);
  } as typeof window.open;
}

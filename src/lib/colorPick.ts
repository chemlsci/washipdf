/**
 * ページから色を拾う（スポイト）ための、画面をまたぐ小さな状態。
 * 色を選ぶ欄が「拾いたい」と頼み（request）、ページの側が次のタップでその場所の色を返す（deliver）。
 * 頼んでいる間は、ページ側はタップをほかの操作（選択・描画）に使わない。
 */
type Listener = () => void;
let pending: ((hex: string) => void) | null = null;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l());

export const colorPick = {
  /** 拾うのを待っているか */
  active: () => pending !== null,
  request(cb: (hex: string) => void) {
    pending = cb;
    emit();
  },
  cancel() {
    if (!pending) return;
    pending = null;
    emit();
  },
  /** ページ側：拾った色を渡す */
  deliver(hex: string) {
    const cb = pending;
    pending = null;
    emit();
    cb?.(hex);
  },
  subscribe(l: Listener) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
};

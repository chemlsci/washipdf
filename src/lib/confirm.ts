// アプリの中で出す確認（ブラウザ標準の confirm() の代わり。ほかの画面のダイアログと見た目をそろえる）。
// askConfirm(文) は、OK なら true、キャンセル（閉じる・Esc）なら false で終わる。画面は ConfirmHost が出す
type Request = { text: string; ok?: string; resolve: (ok: boolean) => void };

let current: Request | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());

/** ok：確定のボタンの文言（例：「削除」「閉じる」）。省略すると「OK」 */
export function askConfirm(text: string, ok?: string): Promise<boolean> {
  return new Promise((resolve) => {
    // 前の確認が残っていれば、キャンセル扱いにして置き換える
    current?.resolve(false);
    const req: Request = {
      text,
      ok,
      resolve: (ok) => {
        if (current === req) current = null;
        emit();
        resolve(ok);
      },
    };
    current = req;
    emit();
  });
}

export const confirmStore = {
  subscribe(f: () => void) {
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  },
  get: () => current,
};

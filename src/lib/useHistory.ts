import { useCallback, useState } from "react";

interface H<T> {
  past: T[];
  present: T;
  future: T[];
}

const LIMIT = 100;

export type Record = boolean | "cancel";

/**
 * 取り消し/やり直し付きの状態。ドラッグ中は checkpoint() → update(fn, false) を使う。
 * isBlank：戻ると「何も開いていない」状態になる時点。そこへは戻さない（文書を開いた直後に「元に戻す」を押して、文書が閉じないように）
 */
export function useHistory<T>(initial: T, isBlank?: (v: T) => boolean) {
  const [h, setH] = useState<H<T>>({ past: [], present: initial, future: [] });

  /**
   * record：true は 1 手として残す。false は直前の手に含める（ドラッグの途中など）。
   * "cancel" は、直前の手を取りやめる（押しただけで作らなかった計測・ペンなど。作った手と消した手の両方を履歴に残さない）
   */
  const update = useCallback((fn: (prev: T) => T, record: Record = true) => {
    setH((s) => {
      const next = fn(s.present);
      if (next === s.present) return s;
      if (record === "cancel") return s.past.length ? { past: s.past.slice(0, -1), present: next, future: s.future } : { ...s, present: next };
      return record
        ? { past: [...s.past.slice(-LIMIT + 1), s.present], present: next, future: [] }
        : { ...s, present: next };
    });
  }, []);

  const checkpoint = useCallback(() => {
    setH((s) => ({ past: [...s.past.slice(-LIMIT + 1), s.present], present: s.present, future: [] }));
  }, []);

  const undo = useCallback(() => {
    setH((s) =>
      s.past.length && !isBlank?.(s.past[s.past.length - 1]) ? { past: s.past.slice(0, -1), present: s.past[s.past.length - 1], future: [s.present, ...s.future] } : s,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const redo = useCallback(() => {
    setH((s) => (s.future.length ? { past: [...s.past, s.present], present: s.future[0], future: s.future.slice(1) } : s));
  }, []);

  /** 履歴ごと作り直す（文書を閉じたときなど。閉じた文書へ「元に戻す」で戻れないようにする） */
  const reset = useCallback((value: T) => setH({ past: [], present: value, future: [] }), []);

  return {
    state: h.present,
    reset,
    update,
    checkpoint,
    undo,
    redo,
    canUndo: h.past.length > 0 && !isBlank?.(h.past[h.past.length - 1]),
    /** 「元に戻す」で戻る先・「やり直す」で進む先（何が変わるかを説明するのに使う） */
    prev: h.past[h.past.length - 1] as T | undefined,
    /** 戻れる先・進める先のすべて（どこからも使われなくなったデータを見分けるのに使う） */
    past: h.past as readonly T[],
    future: h.future as readonly T[],
    next: h.future[0] as T | undefined,
    canRedo: h.future.length > 0,
  };
}

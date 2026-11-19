import type React from "react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { confirmStore } from "@/lib/confirm";
import { useT } from "@/lib/i18n";
import { Icon } from "./Icon";

/** 共通のモーダル。Esc と背景クリックで閉じる */
export function Dialog({
  title,
  onClose,
  children,
  footer,
  wide = false,
  className,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  className?: string;
}) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // 開いたらダイアログへフォーカスを移し、閉じたら元の場所へ戻す（キーボード・読み上げで後ろの画面に迷い込まない）
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = box.current;
    if (el && !el.contains(document.activeElement)) el.focus();
    return () => {
      if (prev && document.contains(prev)) prev.focus?.();
    };
  }, []);
  /** Tab でダイアログの外へ出ないようにする */
  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !box.current) return;
    const items = [...box.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute("disabled") && x.offsetParent !== null);
    if (!items.length) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === box.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} tabIndex={-1} onKeyDown={trapTab} className={`modal ${wide ? "wide" : ""} ${className ?? ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t("common.close")}>
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** 数値入力（空や不正な値は無視） */
/**
 * 数の入力欄。打っている途中の文字（「-」だけ、空、「1.」など、まだ数にならない形）を、そのまま持つ。
 * 数として読めるときだけ onValue に渡し（文字のまま。範囲に収めるのは呼ぶ側）、欄を離れたら表示をいまの値に合わせる。
 * （値をそのまま value に渡す書き方だと、途中の形が元の値に戻されて、「-45」が「-3045」になる、消して打ち直せない、などが起きる）
 */
export function NumInput({
  value,
  onValue,
  onFocus,
  onBlur,
  ...rest
}: { value: number; onValue: (raw: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type">) {
  const [text, setText] = useState(String(value));
  const editing = useRef(false);
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    if (!editing.current) setText(String(value));
  }, [value]);
  return (
    <input
      {...rest}
      type="number"
      value={text}
      onFocus={(e) => {
        editing.current = true;
        onFocus?.(e);
      }}
      onChange={(e) => {
        setText(e.target.value);
        if (Number.isFinite(parseFloat(e.target.value))) onValue(e.target.value);
      }}
      onBlur={(e) => {
        editing.current = false;
        onBlur?.(e);
        // 離れたあとの値（onBlur で範囲に収めた値を含む）を表示する
        queueMicrotask(() => setText(String(latest.current)));
      }}
    />
  );
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}) {
  return (
    <label className="field">
      <span>
        {label}
        {suffix ? ` (${suffix})` : ""}
      </span>
      <NumInput
        value={value}
        min={min}
        max={max}
        step={step}
        // 上限は打っている途中でも掛ける（桁を足して、とても大きな値にならないように）。下限は、打ち終わってから掛ける
        onValue={(raw) => onChange(typeof max === "number" ? Math.min(max, parseFloat(raw)) : parseFloat(raw))}
        onBlur={() => {
          if (typeof min === "number" && value < min) onChange(min);
        }}
      />
    </label>
  );
}

/** askConfirm() の確認を出す（アプリに 1 つ置く） */
export function ConfirmHost() {
  const t = useT();
  const req = useSyncExternalStore(confirmStore.subscribe, confirmStore.get, () => null);
  if (!req) return null;
  return (
    <Dialog
      title={t("common.confirm")}
      onClose={() => req.resolve(false)}
      className="confirm-dialog"
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={() => req.resolve(false)}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" autoFocus onClick={() => req.resolve(true)}>
            {req.ok ?? t("common.ok")}
          </button>
        </>
      }
    >
      <p className="confirm-text">{req.text}</p>
    </Dialog>
  );
}

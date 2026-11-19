/** パスワード入力（読み込み時）と、保存時のパスワード保護・権限の設定 */
import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { saslPrep, type SecuritySettings } from "@/lib/security";
import type { SourceDoc } from "@/lib/types";
import { Dialog } from "../Dialog";

export function PasswordDialog({ name, retry, onSubmit, onClose }: { name: string; retry: boolean; onSubmit: (password: string) => void; onClose: () => void }) {
  const t = useT();
  const [pw, setPw] = useState("");
  const [show, setShow] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const submit = () => onSubmit(pw);
  return (
    <Dialog
      title={t("pw.title")}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" onClick={submit}>
            {t("pw.open")}
          </button>
        </>
      }
    >
      <p className="note">{t("pw.message", { name })}</p>
      {retry && <p className="note error">{t("pw.retry")}</p>}
      <label className="field">
        <span>{t("pw.placeholder")}</span>
        <input
          ref={input}
          type={show ? "text" : "password"}
          value={pw}
          autoComplete="off"
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> {t("protect.show")}
      </label>
    </Dialog>
  );
}

// RC4（古い方式）のパスワードは、半角の英数字・記号だけにする（ほかのソフトとの互換のため）
const ASCII_ONLY = /^[\x20-\x7e]*$/;

/**
 * ほかのソフトで開けなくなるおそれのあるパスワードか。
 * このアプリは規格どおり、パスワードを正規化（NFKC）してから使う。正規化しないソフト（少なくない）では、
 * 全角の英数字や半角カナを含むパスワードを同じように打っても開けない。半角の英数字・記号以外は、ソフトによる扱いの差が出やすい
 */
export const riskyPassword = (pw: string) => pw !== saslPrep(pw) || /[^\x20-\x7e]/.test(pw);

export function ProtectDialog({ security, sources, onApply, onClose }: { security: SecuritySettings; sources: SourceDoc[]; onApply: (s: SecuritySettings) => void; onClose: () => void }) {
  const t = useT();
  const [v, setV] = useState<SecuritySettings>({ ...security, permissions: { ...security.permissions } });
  const [show, setShow] = useState(false);
  const protectedSources = sources.filter((s) => s.security);
  const rc4CharProblem = v.method === "rc4" && !(ASCII_ONLY.test(v.userPassword) && ASCII_ONLY.test(v.ownerPassword));
  const noPassword = v.enabled && !v.userPassword && !v.ownerPassword;
  const invalid = v.enabled && (rc4CharProblem || noPassword);
  // 止めはしない（日本語のパスワードを使いたい人もいる）。受け取る人が開けなくなるおそれを知らせる
  const risky = v.enabled && !rc4CharProblem && (riskyPassword(v.userPassword) || riskyPassword(v.ownerPassword));
  const perm = (key: keyof SecuritySettings["permissions"], label: string) => (
    <label className="checkbox" key={key}>
      <input type="checkbox" checked={v.permissions[key]} onChange={(e) => setV({ ...v, permissions: { ...v.permissions, [key]: e.target.checked } })} /> {label}
    </label>
  );
  return (
    <Dialog
      title={t("tool.protect")}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            className="btn primary"
            disabled={invalid}
            onClick={() => {
              onApply(v);
              onClose();
            }}
          >
            {t("stamp.apply")}
          </button>
        </>
      }
    >
      {protectedSources.map((s) => (
        <p className="note" key={s.id}>
          {t("protect.sourceInfo", { name: s.name, method: s.security?.method ?? "" })}
        </p>
      ))}
      <label className="checkbox">
        <input type="checkbox" checked={v.enabled} onChange={(e) => setV({ ...v, enabled: e.target.checked })} /> {t("protect.enable")}
      </label>
      <fieldset className="group" disabled={!v.enabled}>
        <label className="field">
          <span>{t("protect.userPassword")}</span>
          <input type={show ? "text" : "password"} autoComplete="new-password" value={v.userPassword} onChange={(e) => setV({ ...v, userPassword: e.target.value })} />
        </label>
        <p className="note">{t("protect.userHelp")}</p>
        <label className="field">
          <span>{t("protect.ownerPassword")}</span>
          <input type={show ? "text" : "password"} autoComplete="new-password" value={v.ownerPassword} onChange={(e) => setV({ ...v, ownerPassword: e.target.value })} />
        </label>
        <p className="note">{t("protect.ownerHelp")}</p>
        <label className="checkbox">
          <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> {t("protect.show")}
        </label>
        <label className="field">
          <span>{t("protect.method")}</span>
          <select value={v.method} onChange={(e) => setV({ ...v, method: e.target.value as SecuritySettings["method"] })}>
            <option value="aes256">{t("protect.aes256")}</option>
            <option value="rc4">{t("protect.rc4")}</option>
          </select>
        </label>
        <div className="field">
          <span>{t("protect.permissions")}</span>
          <div className="perm-grid">
            {perm("print", t("protect.print"))}
            {perm("modify", t("protect.modify"))}
            {perm("copy", t("protect.copy"))}
            {perm("annotate", t("protect.annotate"))}
          </div>
        </div>
        {rc4CharProblem && <p className="note error">{t("protect.latin1")}</p>}
        {risky && (
          <p className="note warn" role="status">
            {t("protect.nonAscii")}
          </p>
        )}
        {noPassword && <p className="note error">{t("protect.needPassword")}</p>}
      </fieldset>
      <p className="note">{t("protect.note")}</p>
    </Dialog>
  );
}

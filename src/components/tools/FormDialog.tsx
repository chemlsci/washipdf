/** フォーム入力：元 PDF の入力欄に値を書き込む */
import { useEffect, useState } from "react";
import { type FormFieldInfo, readFormFields } from "@/lib/forms";
import { useT } from "@/lib/i18n";
import { hasOwn } from "@/lib/safeObject";
import type { SourceDoc } from "@/lib/types";
import { Dialog } from "../Dialog";

export function FormDialog({ sources, onApply, onClose }: { sources: SourceDoc[]; onApply: (src: SourceDoc, values: Record<string, string | boolean>, flatten: boolean) => void; onClose: () => void }) {
  const t = useT();
  const [srcId, setSrcId] = useState(sources[0]?.id ?? "");
  const [fields, setFields] = useState<FormFieldInfo[] | null>(null);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  // 欄の名前は PDF に書かれた文字列。自分で入れた値だけを読む（"constructor" のような名前の欄で、関数を値として拾わないように）
  const valueOf = (name: string): string | boolean | undefined => (hasOwn(values, name) ? values[name] : undefined);
  const [flatten, setFlatten] = useState(false);
  const src = sources.find((s) => s.id === srcId);
  useEffect(() => {
    let alive = true;
    setFields(null);
    if (!src) return;
    readFormFields(src.bytes).then(
      (f) => {
        if (!alive) return;
        setFields(f);
        setValues(Object.fromEntries(f.map((x) => [x.name, x.value])));
      },
      () => alive && setFields([]),
    );
    return () => {
      alive = false;
    };
  }, [src]);
  return (
    <Dialog
      title={t("tool.form")}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" disabled={!src || !fields?.length} onClick={() => src && onApply(src, values, flatten)}>
            {t("form.apply")}
          </button>
        </>
      }
    >
      {sources.length > 1 && (
        <label className="field">
          <span>{t("form.source")}</span>
          <select value={srcId} onChange={(e) => setSrcId(e.target.value)}>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {fields === null ? (
        <p className="note">{t("form.loading")}</p>
      ) : fields.length === 0 ? (
        <p className="note">{t("form.none")}</p>
      ) : (
        <div className="form-fields">
          {fields.map((f) => (
            <label key={f.name} className={f.kind === "checkbox" ? "checkbox" : "field"}>
              {f.kind === "checkbox" ? (
                <>
                  <input type="checkbox" checked={!!valueOf(f.name)} onChange={(e) => setValues({ ...values, [f.name]: e.target.checked })} /> {f.name}
                </>
              ) : (
                <>
                  <span>{f.name}</span>
                  {f.kind === "text" && f.multiline ? (
                    <textarea rows={3} maxLength={f.maxLength} value={String(valueOf(f.name) ?? "")} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />
                  ) : f.options ? (
                    <select value={String(valueOf(f.name) ?? "")} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}>
                      <option value="">—</option>
                      {f.options.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input maxLength={f.maxLength} value={String(valueOf(f.name) ?? "")} disabled={f.kind === "other"} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />
                  )}
                </>
              )}
            </label>
          ))}
        </div>
      )}
      <label className="checkbox">
        <input type="checkbox" checked={flatten} onChange={(e) => setFlatten(e.target.checked)} /> {t("form.flatten")}
      </label>
      <p className="note">{t("form.help")}</p>
    </Dialog>
  );
}

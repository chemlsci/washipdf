import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { colorPick } from "@/lib/colorPick";
import { previewLayout, type PreviewLayout } from "@/lib/editPreview";
import { fallbackKey } from "@/lib/exportPdf";
import { baselineOffset, fontDef, fontList, pickFont } from "@/lib/fonts";
import { safeLinkUrl } from "@/lib/annots";
import { approvalTitles } from "@/lib/approval";
import { clamp, clampInt, LIMITS } from "@/lib/limits";
import { MAX_SCALE, measureLabel, MIN_SCALE, scaleForLength } from "@/lib/measure";
import { normAngle, uid } from "@/lib/geometry";
import { NumInput } from "./Dialog";
import { type Key, useT } from "@/lib/i18n";
import type { EditObj, FontKey, ImageEditObj, PageItem, ShapeObj, SourceDoc, StoredImage, TextEditObj, TextObj } from "@/lib/types";
import { Icon } from "./Icon";
import { DEFAULTS, type UpdateObjects } from "./PageEditor";

const SWATCHES = ["#111111", "#ffffff", "#e11d48", "#2563eb", "#16a34a", "#f59e0b"];

/** スタンプのプリセット文言（表示言語に追従して翻訳される） */
const APPROVAL_PRESETS: Key[] = ["approval.preset1", "approval.preset2", "approval.preset3"];
const STAMP_PRESETS: Key[] = ["stamp.p.approved", "stamp.p.checked", "stamp.p.received", "stamp.p.confidential", "stamp.p.urgent", "stamp.p.draft", "stamp.p.copy", "stamp.p.completed"];

export const TYPE_LABEL: Record<EditObj["type"], Key> = {
  text: "prop.text",
  rect: "prop.rect",
  ellipse: "prop.ellipse",
  line: "prop.line",
  whiteout: "prop.whiteout",
  image: "prop.image",
  textedit: "prop.textedit",
  markup: "prop.markup",
  note: "prop.note",
  ink: "prop.ink",
  stamp: "prop.stamp",
  imageedit: "prop.imageEdit",
  redact: "prop.redact",
  link: "prop.link",
  field: "prop.field",
  measure: "prop.measure",
};

export function PropertiesPanel({
  obj,
  images,
  source,
  page,
  updateObjects,
  onDeselect,
  onReplaceImage,
  focusText = false,
  pages = [],
}: {
  /** 文書のページ（リンクの行き先を選ぶのに使う） */
  pages?: PageItem[];
  obj: EditObj;
  images: Map<string, StoredImage>;
  source?: SourceDoc;
  page: PageItem;
  updateObjects: UpdateObjects;
  onDeselect: () => void;
  onReplaceImage?: (obj: ImageEditObj, file: File) => void;
  /** スマホ：文字の入力欄に自動でフォーカスする（ページ上では編集しない） */
  focusText?: boolean;
}) {
  const t = useT();
  // 同じ項目の連続変更（カラーピッカーのドラッグ等）は1回の履歴にまとめる
  const last = useRef<{ key: string; t: number }>({ key: "", t: 0 });
  const patch = (field: string, p: Partial<EditObj>) => {
    const key = `${obj.id}:${field}`;
    const now = Date.now();
    const record = !(last.current.key === key && now - last.current.t < 1000);
    last.current = { key, t: now };
    updateObjects((objs) => objs.map((o) => (o.id === obj.id ? ({ ...o, ...p } as EditObj) : o)), record);
  };

  const remove = () => {
    updateObjects((objs) => objs.filter((o) => o.id !== obj.id));
    onDeselect();
  };
  const duplicate = () => updateObjects((objs) => [...objs, { ...obj, id: uid(), x: obj.x + 10, y: obj.y + 10 }]);
  const toFront = () => updateObjects((objs) => [...objs.filter((o) => o.id !== obj.id), obj]);
  const toBack = () => updateObjects((objs) => [obj, ...objs.filter((o) => o.id !== obj.id)]);

  if (obj.type === "textedit") {
    return (
      <TextEditProps
        obj={obj}
        source={source}
        page={page}
        patch={patch}
        remove={remove}
        focusText={focusText}
        toOverlay={(cover, text) => {
          updateObjects((objs) => [...objs.filter((o) => o.id !== obj.id), cover, text]);
          onDeselect();
        }}
      />
    );
  }

  return (
    <div className="props-body">
      <h3>{t(obj.type === "stamp" && obj.frame === "grid" ? "sign.approval" : TYPE_LABEL[obj.type])}</h3>

      {obj.type === "text" && (
        <>
          <label className="checkbox">
            <input type="checkbox" checked={!!obj.vertical} onChange={(e) => patch("vertical", { vertical: e.target.checked })} /> {t("prop.vertical")}
          </label>
          {focusText && (
            <label className="field">
              <span>{t("prop.chars")}</span>
              <textarea rows={3} value={obj.text} onChange={(e) => patch("text", { text: e.target.value })} spellCheck={false} dir="auto" autoFocus />
            </label>
          )}
          <label className="field">
            <span>{t("prop.font")}</span>
            <select value={obj.font} onChange={(e) => patch("font", { font: e.target.value as FontKey })}>
              {fontList().map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}（{t(f.family === "serif" ? "font.serif" : "font.sans")}）
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t("prop.size")}</span>
            <NumInput
              min={4}
              max={400}
              step={0.5}
              value={obj.fontSize}
              onValue={(raw) => {
                const v = parseFloat(raw);
                if (v > 0) patch("fontSize", { fontSize: Math.min(v, LIMITS.fontSize.max) });
              }}
            />
          </label>
          <ColorField label={t("prop.color")} value={obj.color} onChange={(c) => patch("color", { color: c ?? "#000000" })} />
          <label className="field">
            <span>{t("prop.rotation")}</span>
            <NumInput
              min={-180}
              max={180}
              step={1}
              value={obj.rotation ?? 0}
              onValue={(raw) => {
                const v = parseFloat(raw);
                if (Number.isFinite(v)) patch("rotation", { rotation: normAngle(v) });
              }}
            />
          </label>
          <div className="prop-actions">
            <button className="btn small" onClick={() => patch(`rot-${Date.now()}`, { rotation: normAngle((obj.rotation ?? 0) - 90) })} title={t("prop.rotLeft")}>
              <Icon name="rotate-ccw" size={16} /> {t("prop.rotLeft")}
            </button>
            <button className="btn small" onClick={() => patch(`rot-${Date.now()}`, { rotation: normAngle((obj.rotation ?? 0) + 90) })} title={t("prop.rotRight")}>
              <Icon name="rotate-cw" size={16} /> {t("prop.rotRight")}
            </button>
            <button className="btn small" onClick={() => patch(`rot-${Date.now()}`, { rotation: 0 })} title={t("prop.rotReset")}>
              0°
            </button>
          </div>
          <p className="note">{t("prop.textNote")}</p>
        </>
      )}

      {(obj.type === "rect" || obj.type === "ellipse") && (
        <>
          <ColorField label={t("prop.stroke")} value={obj.stroke} allowNone onChange={(c) => patch("stroke", { stroke: c })} />
          <label className="field">
            <span>{t("prop.strokeWidth")}</span>
            <NumInput
              min={0.25}
              max={50}
              step={0.25}
              value={obj.strokeWidth}
              onValue={(raw) => patch("strokeWidth", { strokeWidth: clamp(raw, 0.25, 100, 1) })}
            />
          </label>
          <ColorField label={t("prop.fill")} value={obj.fill} allowNone onChange={(c) => patch("fill", { fill: c })} />
          <Opacity value={obj.opacity} onChange={(v) => patch("opacity", { opacity: v })} />
        </>
      )}

      {obj.type === "markup" && (
        <>
          <div className="seg">
            {(["highlight", "underline", "strikeout"] as const).map((k) => (
              <button key={k} className={obj.kind === k ? "on" : ""} aria-pressed={obj.kind === k} onClick={() => patch("kind", { kind: k })}>
                {t(k === "highlight" ? "tool.highlight" : k === "underline" ? "tool.underline" : "tool.strikeout")}
              </button>
            ))}
          </div>
          <ColorField label={t("prop.colorPlain")} value={obj.color} swatches={["#ffe234", "#a8f0a0", "#9fd3ff", "#ffb3c7", "#e11d48", "#111111"]} onChange={(c) => patch("color", { color: c ?? "#ffe234" })} />
          <Opacity value={obj.opacity} onChange={(v) => patch("opacity", { opacity: v })} />
          <label className="field">
            <span>{t("prop.comment")}</span>
            <textarea rows={3} value={obj.contents} onChange={(e) => patch("contents", { contents: e.target.value })} spellCheck={false} dir="auto" />
          </label>
          <p className="note">{t("prop.markupNote")}</p>
        </>
      )}

      {obj.type === "note" && (
        <>
          <label className="field">
            <span>{t("prop.comment")}</span>
            <textarea rows={4} value={obj.contents} onChange={(e) => patch("contents", { contents: e.target.value })} spellCheck={false} dir="auto" autoFocus={focusText || !obj.contents} />
          </label>
          <label className="field">
            <span>{t("prop.author")}</span>
            <input value={obj.author} onChange={(e) => patch("author", { author: e.target.value })} />
          </label>
          <ColorField label={t("prop.colorPlain")} value={obj.color} swatches={["#ffd43b", "#ff8a65", "#8be0a3", "#8ec5ff", "#f3a4ff"]} onChange={(c) => patch("color", { color: c ?? "#ffd43b" })} />
          <p className="note">{t("prop.noteNote")}</p>
        </>
      )}

      {obj.type === "ink" && (
        <>
          <ColorField label={t("prop.stroke")} value={obj.stroke} onChange={(c) => patch("stroke", { stroke: c ?? "#000000" })} />
          <label className="field">
            <span>{t("prop.strokeWidth")}</span>
            <NumInput min={0.25} max={30} step={0.25} value={obj.strokeWidth} onValue={(raw) => patch("strokeWidth", { strokeWidth: clamp(raw, 0.25, 100, 1) })} />
          </label>
          <Opacity value={obj.opacity} onChange={(v) => patch("opacity", { opacity: v })} />
          <p className="note">{t("prop.inkNote")}</p>
        </>
      )}

      {obj.type === "stamp" && obj.frame === "grid" && (
        <>
          <label className="field">
            <span>{t("approval.titles")}</span>
            <input
              value={obj.text}
              autoFocus={focusText}
              onChange={(e) => {
                const text = e.target.value;
                DEFAULTS.stamp.grid = text;
                // 欄の数が変わったら、欄の幅を保ったまま全体の幅を変える
                const n0 = approvalTitles(obj.text).length;
                const n1 = approvalTitles(text).length;
                patch("text", { text, w: (obj.w / n0) * n1 });
              }}
            />
          </label>
          <div className="chips">
            {APPROVAL_PRESETS.map((k) => {
              const label = t(k);
              return (
                <button
                  key={k}
                  type="button"
                  className={`chip ${obj.text === label ? "on" : ""}`} aria-pressed={obj.text === label}
                  onClick={() => {
                    DEFAULTS.stamp.grid = label;
                    patch("text", { text: label, w: (obj.w / approvalTitles(obj.text).length) * approvalTitles(label).length });
                  }}
                >
                  {label.replace(/,/g, " · ")}
                </button>
              );
            })}
          </div>
          <div className="field-row">
            <label className="field">
              <span>{t("prop.font")}</span>
              <select value={obj.font} onChange={(e) => patch("font", { font: e.target.value })}>
                {fontList().map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t("prop.size")}</span>
              <NumInput min={4} max={60} step={1} value={Math.round(obj.fontSize * 10) / 10} onValue={(raw) => patch("fontSize", { fontSize: clamp(raw, 4, LIMITS.fontSize.max, 10) })} />
            </label>
          </div>
          <ColorField label={t("prop.color")} value={obj.color} swatches={["#222222", "#2f55d4", "#d6334a", "#16a34a"]} onChange={(c) => patch("color", { color: c ?? "#222222" })} />
          <Opacity value={obj.opacity} onChange={(v) => patch("opacity", { opacity: v })} />
          <p className="note">{t("approval.note")}</p>
        </>
      )}

      {obj.type === "stamp" && obj.frame !== "grid" && (
        <>
          <label className="field">
            <span>{t("prop.chars")}</span>
            <input value={obj.text} onChange={(e) => patch("text", { text: e.target.value })} autoFocus={focusText} />
          </label>
          <div className="chips">
            {STAMP_PRESETS.map((k) => {
              const label = t(k);
              return (
                <button key={k} type="button" className={`chip ${obj.text === label ? "on" : ""}`} aria-pressed={obj.text === label} onClick={() => patch("text", { text: label })}>
                  {label}
                </button>
              );
            })}
          </div>
          <div className="field">
            <span>{t("stamp.frame")}</span>
            <div className="seg">
              {(["none", "rect", "ellipse"] as const).map((fr) => (
                <button key={fr} type="button" className={(obj.frame ?? "rect") === fr ? "on" : ""} aria-pressed={(obj.frame ?? "rect") === fr} onClick={() => patch("frame", { frame: fr })}>
                  {t(`frame.${fr}`)}
                </button>
              ))}
            </div>
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={!!obj.double} disabled={(obj.frame ?? "rect") === "none"} onChange={(e) => patch("double", { double: e.target.checked })} /> {t("stamp.double")}
          </label>
          <div className="field-row">
            <label className="field">
              <span>{t("prop.font")}</span>
              <select value={obj.font} onChange={(e) => patch("font", { font: e.target.value })}>
                {fontList().map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t("prop.size")}</span>
              <NumInput min={6} max={200} step={1} value={obj.fontSize} onValue={(raw) => {
                  // 枠も文字と同じ割合で大きくする（中心はそのまま）。文字だけ大きくすると枠からはみ出す
                  const fontSize = clamp(raw, 6, LIMITS.fontSize.max, 18);
                  const k = fontSize / (obj.fontSize || fontSize);
                  const w = obj.w * k;
                  const h = obj.h * k;
                  patch("fontSize", { fontSize, w, h, x: obj.x + (obj.w - w) / 2, y: obj.y + (obj.h - h) / 2 });
                }} />
            </label>
          </div>
          <ColorField label={t("prop.color")} value={obj.color} swatches={["#d6334a", "#2f55d4", "#16a34a", "#111111", "#7c3aed"]} onChange={(c) => patch("color", { color: c ?? "#d6334a" })} />
          <label className="field">
            <span>{t("prop.rotation")}</span>
            <NumInput min={-180} max={180} step={1} value={obj.rotation} onValue={(raw) => patch("rotation", { rotation: normAngle(parseFloat(raw) || 0) })} />
          </label>
          <Opacity value={obj.opacity} onChange={(v) => patch("opacity", { opacity: v })} />
        </>
      )}

      {obj.type === "measure" && (
        <>
          <p className="measure-value">
            {t(obj.kind === "area" ? "measure.area" : obj.pts.length > 2 ? "measure.path" : "measure.distance")}：<strong>{measureLabel(obj)}</strong>
          </p>
          {obj.kind === "distance" && <MeasureCalibrate obj={obj} pageObjects={page.objects} updateObjects={updateObjects} />}
          <div className="field-row">
            <label className="field">
              <span>{t("measure.scale")}</span>
              <span className="measure-scale" dir="ltr">
                1 :
                <NumInput
                  min={0.01}
                  step="any"
                  value={obj.scale}
                  onValue={(raw) => {
                    const v = parseFloat(raw);
                    if (!(v >= MIN_SCALE && v <= MAX_SCALE)) return;
                    DEFAULTS.measure.scale = v;
                    patch("scale", { scale: v });
                  }}
                />
              </span>
            </label>
            <label className="field">
              <span>{t("measure.unit")}</span>
              <select
                value={obj.unit}
                onChange={(e) => {
                  const u = e.target.value as "mm" | "cm" | "m";
                  DEFAULTS.measure.unit = u;
                  patch("unit", { unit: u });
                }}
              >
                <option value="mm">mm</option>
                <option value="cm">cm</option>
                <option value="m">m</option>
              </select>
            </label>
          </div>
          <ColorField
            label={t("prop.stroke")}
            value={obj.color}
            swatches={["#d6334a", "#2f55d4", "#16a34a", "#111111"]}
            onChange={(c) => {
              DEFAULTS.measure.color = c ?? "#d6334a";
              patch("color", { color: c ?? "#d6334a" });
            }}
          />
          <p className="note">{t("measure.note")}</p>
        </>
      )}

      {obj.type === "field" && (
        <>
          <label className="field">
            <span>{t("field.kind")}</span>
            <select
              value={obj.kind}
              onChange={(e) => {
                const k = e.target.value as typeof obj.kind;
                const square = (k === "checkbox" || k === "radio") && obj.kind !== "checkbox" && obj.kind !== "radio" ? { w: Math.min(obj.w, obj.h, 18), h: Math.min(obj.w, obj.h, 18) } : {};
                patch("kind", { kind: k, ...square, ...(k === "radio" && !obj.value ? { value: t("field.radioValueDefault") } : {}) });
              }}
            >
              {(["text", "multiline", "date", "checkbox", "radio", "dropdown", "signature"] as const).map((k) => (
                <option key={k} value={k}>
                  {t(`field.kind.${k}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t(obj.kind === "radio" ? "field.group" : "field.name")}</span>
            <input value={obj.name} autoFocus={focusText} spellCheck={false} onChange={(e) => patch("name", { name: e.target.value })} />
          </label>
          {obj.kind === "radio" && (
            <label className="field">
              <span>{t("field.radioValue")}</span>
              <input value={obj.value ?? ""} spellCheck={false} onChange={(e) => patch("value", { value: e.target.value })} />
            </label>
          )}
          {obj.kind === "dropdown" && (
            <label className="field">
              <span>{t("field.options")}</span>
              <textarea rows={4} value={obj.options.join("\n")} onChange={(e) => patch("options", { options: e.target.value.split("\n") })} />
            </label>
          )}
          {obj.kind === "radio" && <p className="note">{t("field.radioNote")}</p>}
          {obj.kind === "date" && <p className="note">{t("field.dateNote")}</p>}
          {obj.kind === "signature" && <p className="note">{t("field.signatureNote")}</p>}
          <p className="note">{t("field.note")}</p>
        </>
      )}

      {obj.type === "link" && (
        <>
          <div className="seg">
            <button type="button" className={obj.target.kind === "url" ? "on" : ""} aria-pressed={obj.target.kind === "url"} onClick={() => obj.target.kind !== "url" && patch("target", { target: { kind: "url", url: "" } })}>
              {t("link.url")}
            </button>
            <button type="button" className={obj.target.kind === "page" ? "on" : ""} aria-pressed={obj.target.kind === "page"} onClick={() => obj.target.kind !== "page" && pages.length && patch("target", { target: { kind: "page", pageId: pages[0].id } })}>
              {t("link.page")}
            </button>
          </div>
          {obj.target.kind === "url" ? (
            <label className="field">
              <span>{t("link.url")}</span>
              <input type="url" dir="ltr" inputMode="url" placeholder="https://" value={obj.target.url} autoFocus={focusText} spellCheck={false} onChange={(e) => patch("target", { target: { kind: "url", url: e.target.value.trim() } })} />
            </label>
          ) : (
            <label className="field">
              <span>{t("link.page")}</span>
              <select value={pages.some((pg) => obj.target.kind === "page" && pg.id === obj.target.pageId) ? obj.target.pageId : ""} onChange={(e) => e.target.value && patch("target", { target: { kind: "page", pageId: e.target.value } })}>
                {/* 行き先のページが消されたとき：先頭のページを選んでいるように見せない */}
                {!pages.some((pg) => obj.target.kind === "page" && pg.id === obj.target.pageId) && <option value="">—</option>}
                {pages.map((pg, i) => (
                  <option key={pg.id} value={pg.id}>
                    {t("wareki.pageNo", { n: i + 1 })}
                  </option>
                ))}
              </select>
            </label>
          )}
          {obj.target.kind === "url" && obj.target.url && !safeLinkUrl(obj.target.url) && <p className="note error">{t("link.badUrl")}</p>}
          {obj.target.kind === "page" && !pages.some((pg) => obj.target.kind === "page" && pg.id === obj.target.pageId) && <p className="note error">{t("link.pageMissing")}</p>}
          <p className="note">{t("link.note")}</p>
        </>
      )}

      {obj.type === "whiteout" && (
        <>
          <ColorField label={t("prop.fillColor")} value={obj.fill} onChange={(c) => patch("fill", { fill: c ?? "#ffffff" })} />
          <p className="note">{t("prop.whiteoutNote")}</p>
        </>
      )}

      {obj.type === "redact" && (
        <>
          <ColorField label={t("prop.fillColor")} value={obj.fill} onChange={(c) => patch("fill", { fill: c ?? "#000000" })} />
          <p className="note">{t("prop.redactNote")}</p>
        </>
      )}

      {obj.type === "imageedit" && (
        <>
          <p className="note">{t("prop.imageEditNote")}</p>
          <label className="btn small file-btn">
            {t("prop.replaceImage")}
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onReplaceImage?.(obj, f);
                e.target.value = "";
              }}
            />
          </label>
        </>
      )}

      {obj.type === "line" && (
        <>
          <ColorField label={t("prop.stroke")} value={obj.stroke} onChange={(c) => patch("stroke", { stroke: c ?? "#000000" })} />
          <label className="field">
            <span>{t("prop.strokeWidth")}</span>
            <NumInput
              min={0.25}
              max={50}
              step={0.25}
              value={obj.strokeWidth}
              onValue={(raw) => patch("strokeWidth", { strokeWidth: clamp(raw, 0.25, 100, 1) })}
            />
          </label>
          <Opacity value={obj.opacity} onChange={(v) => patch("opacity", { opacity: v })} />
          <p className="note">{t("prop.lineNote")}</p>
        </>
      )}

      {obj.type === "image" && (
        <>
          <Opacity value={obj.opacity} onChange={(v) => patch("opacity", { opacity: v })} />
          <button
            className="btn small"
            onClick={() => {
              const img = images.get(obj.imageId);
              if (img) patch("ratio", { h: (obj.w * img.height) / img.width });
            }}
          >
            {t("prop.resetRatio")}
          </button>
        </>
      )}

      {obj.type !== "line" && obj.type !== "text" && obj.type !== "note" && obj.type !== "ink" && obj.type !== "measure" && (
        <div className="field-row">
          <label className="field">
            <span>{t("prop.width")}</span>
            <NumInput min={1} value={Math.round(obj.w * 10) / 10} onValue={(raw) => patch("w", { w: clamp(raw, 1, LIMITS.pagePt.max, 1) })} />
          </label>
          <label className="field">
            <span>{t("prop.height")}</span>
            <NumInput min={1} value={Math.round(obj.h * 10) / 10} onValue={(raw) => patch("h", { h: clamp(raw, 1, LIMITS.pagePt.max, 1) })} />
          </label>
        </div>
      )}

      <div className="prop-actions">
        <button className="btn small" onClick={toFront} title={t("prop.front")}>
          <Icon name="front" size={16} /> {t("prop.front")}
        </button>
        <button className="btn small" onClick={toBack} title={t("prop.back")}>
          <Icon name="back" size={16} /> {t("prop.back")}
        </button>
        <button className="btn small" onClick={duplicate} title={t("prop.duplicate")}>
          <Icon name="copy" size={16} /> {t("prop.duplicate")}
        </button>
        <button className="btn small danger" onClick={remove} title={t("prop.deleteTip")}>
          <Icon name="trash" size={16} /> {t("prop.delete")}
        </button>
      </div>
    </div>
  );
}

function TextEditProps({
  obj,
  source,
  page,
  patch,
  remove,
  focusText,
  toOverlay,
}: {
  obj: TextEditObj;
  source?: SourceDoc;
  page: PageItem;
  patch: (field: string, p: Partial<TextEditObj>) => void;
  remove: () => void;
  focusText: boolean;
  /** この書き換えをやめて、上書き（元の文字を隠す白塗り＋その上の文字）に置き換える */
  toOverlay: (cover: ShapeObj, text: TextObj) => void;
}) {
  const t = useT();
  const [layout, setLayout] = useState<PreviewLayout | null>(null);
  useEffect(() => {
    let alive = true;
    previewLayout(obj, source, page.srcIndex).then(
      (l) => alive && setLayout(l),
      () => alive && setLayout(null),
    );
    return () => {
      alive = false;
    };
  }, [obj, source, page.srcIndex]);
  const fontOptions: { value: TextEditObj["font"]; label: string }[] = [
    ...(obj.fontResName ? [{ value: "original" as const, label: t("prop.originalFont", { name: obj.srcFontName.replace(/^[A-Z]{6}\+/, "") || t("prop.unknownFont") }) }] : []),
    ...fontList().map((f) => ({ value: f.id as TextEditObj["font"], label: `${f.name}（${t(f.family === "serif" ? "font.serif" : "font.sans")}）` })),
  ];
  const fallbackName = fontDef(pickFont(obj.family, obj.text))?.name ?? "";
  const [tab, setTab] = useState<"text" | "format" | "layout">("text");
  const status = layout
    ? layout.overflow
      ? t("prop.overflow", { lines: layout.lines.length, max: obj.lines })
      : layout.shrunk
        ? t("prop.shrunk", { size: layout.fontSize, percent: Math.round((layout.fontSize / obj.fontSize) * 100) })
        : t("prop.fits", { lines: layout.lines.length })
    : "";
  const usedFont = layout?.usesOriginal ? t("badge.originalFont") : (fontDef(fallbackKey(obj))?.name ?? "");
  return (
    <div className="props-body">
      <h3>{t("prop.textedit")}</h3>
      <div className="props-tabs" role="tablist">
        {(["text", "format", "layout"] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
            {t(k === "text" ? "prop.tab.text" : k === "format" ? "prop.tab.format" : "prop.tab.layout")}
          </button>
        ))}
      </div>
      {tab === "text" && (
        <>
          <label className="field">
            <span>{t("prop.newText")}</span>
            <textarea
              rows={Math.min(8, Math.max(2, obj.lines + 1))}
              value={obj.text}
              onChange={(e) => patch("text", { text: e.target.value })}
              spellCheck={false} dir="auto"
              autoFocus={focusText}
            />
          </label>
          {obj.complex ? (
            <>
              <p className="note">{t("prop.complexNote")}</p>
              {/* 語単位の書き換えでは思った形にならないとき：元の文字を隠して、その上に同梱フォントで書く方式へ切り替える
                  （元の文字のデータはファイルに残る。消す必要があれば墨消しを使う） */}
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  const fs = Math.round(obj.fontSize * 10) / 10;
                  const cover: ShapeObj = { id: uid(), type: "whiteout", x: obj.x - 1, y: obj.y - 1, w: obj.w + 2, h: obj.h + 2, stroke: null, fill: obj.cover || "#ffffff", strokeWidth: 0, opacity: 1 };
                  const text: TextObj = { id: uid(), type: "text", x: obj.x, y: obj.baseline - baselineOffset(fs), text: obj.text, fontSize: fs, font: obj.font !== "original" ? obj.font : pickFont(obj.family, obj.text), color: obj.color };
                  toOverlay(cover, text);
                }}
              >
                {t("prop.toOverlay")}
              </button>
            </>
          ) : (
            <>
              {layout && (
                <p className={`note status ${layout.overflow ? "warn" : ""}`}>
                  {[usedFont, status].filter(Boolean).join(" · ")}
                </p>
              )}
              {obj.font === "original" && layout && !layout.usesOriginal && <p className="note warn">{t("prop.fallbackNote", { font: fallbackName })}</p>}
            </>
          )}
          <details className="field original">
            <summary>{t("prop.original")}</summary>
            <div className="original-text">{obj.original}</div>
          </details>
        </>
      )}
      {tab === "format" && (
        <>
          <label className="field">
            <span>{t("prop.font")}</span>
            <select value={obj.font} onChange={(e) => patch("font", { font: e.target.value as TextEditObj["font"] })}>
              {fontOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          {obj.font === "original" && layout && !layout.usesOriginal && <p className="note warn">{t("prop.fallbackNote", { font: fallbackName })}</p>}
          <div className="field-row">
            <label className="field">
              <span>{t("prop.size")}</span>
              <NumInput
                min={4}
                max={400}
                step={0.5}
                value={obj.fontSize}
                onValue={(raw) => {
                  const v = parseFloat(raw);
                  if (v > 0) patch("fontSize", { fontSize: Math.min(v, LIMITS.fontSize.max) });
                }}
              />
            </label>
            <label className="field">
              <span>{t("prop.lineHeight")}</span>
              <NumInput min={1} step={0.5} value={Math.round(obj.lineHeight * 10) / 10} onValue={(raw) => patch("lineHeight", { lineHeight: clamp(raw, 1, 1000, 1) })} />
            </label>
          </div>
          <ColorField label={t("prop.color")} value={obj.color} onChange={(c) => patch("color", { color: c ?? "#000000", fillColorOps: null, strokeColorOps: null })} />
        </>
      )}
      {tab === "layout" && (
        <>
          <div className="field-row">
            <label className="field">
              <span>{t(obj.vertical ? "prop.columns" : "prop.lines")}</span>
              <NumInput min={1} max={200} step={1} value={obj.lines} onValue={(raw) => patch("lines", { lines: clampInt(raw, 1, 200, 1) })} />
            </label>
            <label className="field">
              <span>{t("prop.widthPt")}</span>
              <NumInput min={1} value={Math.round(obj.w * 10) / 10} onValue={(raw) => patch("w", { w: clamp(raw, 1, LIMITS.pagePt.max, 1) })} />
            </label>
          </div>
          <div className="field">
            <span>{t("prop.align")}</span>
            <div className="seg">
              {(["left", "center", "right"] as const).map((a) => (
                <button key={a} className={obj.align === a ? "on" : ""} aria-pressed={obj.align === a} onClick={() => patch("align", { align: a })}>
                  {t(a === "left" ? "prop.alignLeft" : a === "center" ? "prop.alignCenter" : "prop.alignRight")}
                </button>
              ))}
            </div>
          </div>
          {layout && <p className={`note ${layout.overflow ? "warn" : ""}`}>{status}</p>}
          <p className="note">{t("prop.texteditNote")}</p>
        </>
      )}
      <div className="prop-actions">
        <button className="btn small danger" onClick={remove} title={t("prop.revertTip")}>
          <Icon name="trash" size={16} /> {t("prop.revert")}
        </button>
      </div>
    </div>
  );
}

function ColorField({
  label,
  value,
  onChange,
  allowNone,
  swatches = SWATCHES,
}: {
  swatches?: string[];
  label: string;
  value: string | null;
  onChange: (c: string | null) => void;
  allowNone?: boolean;
}) {
  const t = useT();
  const picking = useSyncExternalStore(colorPick.subscribe, colorPick.active, () => false);
  return (
    <div className="field">
      <span>{label}</span>
      <div className="color-row">
        <input type="color" value={value ?? "#ffffff"} onChange={(e) => onChange(e.target.value)} aria-label={label} />
        {/* スポイト：押してから、ページ上の拾いたい色の場所をタップする */}
        <button className={`swatch pick ${picking ? "on" : ""}`} onClick={() => (colorPick.active() ? colorPick.cancel() : colorPick.request((c) => onChange(c)))} title={t("color.pick")} aria-label={t("color.pick")} aria-pressed={picking}>
          <Icon name="pipette" />
        </button>
        {swatches.map((c) => (
          <button
            key={c}
            className={`swatch ${value?.toLowerCase() === c ? "on" : ""}`} aria-pressed={value?.toLowerCase() === c}
            style={{ background: c }}
            onClick={() => onChange(c)}
            aria-label={c}
          />
        ))}
        {allowNone && (
          <button className={`swatch none ${value === null ? "on" : ""}`} aria-pressed={value === null} onClick={() => onChange(null)} title={t("common.none")} aria-label={t("common.none")} />
        )}
      </div>
    </div>
  );
}

function Opacity({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const t = useT();
  return (
    <label className="field">
      <span>{t("prop.opacity", { n: Math.round(value * 100) })}</span>
      <input type="range" min={0.05} max={1} step={0.05} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} />
    </label>
  );
}

/**
 * 縮尺を合わせる：寸法が分かっている線の実際の長さを入れると、縮尺を求めて、この線とページのほかの計測に使う
 * （図面の縮尺が分からない・書かれていないときに）。次に引く計測もこの縮尺になる
 */
function MeasureCalibrate({ obj, pageObjects, updateObjects }: { obj: Extract<EditObj, { type: "measure" }>; pageObjects: EditObj[]; updateObjects: UpdateObjects }) {
  const t = useT();
  const [real, setReal] = useState("");
  const apply = () => {
    const v = parseFloat(real.replace(",", "."));
    const s = scaleForLength(obj, v);
    if (!s) return;
    const scale = Math.round(s * 1e4) / 1e4;
    DEFAULTS.measure.scale = scale;
    updateObjects((objs) => objs.map((o) => (o.type === "measure" ? { ...o, scale } : o)));
    setReal("");
  };
  // 別の線を選んだら、入れかけの値は消す
  useEffect(() => setReal(""), [obj.id]);
  const others = pageObjects.filter((o) => o.type === "measure" && o.id !== obj.id).length;
  return (
    <div className="field">
      <span>{t("measure.real")}</span>
      <div className="measure-calibrate">
        <input type="number" min={0} step="any" inputMode="decimal" value={real} placeholder={obj.unit} onChange={(e) => setReal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && apply()} />
        <span>{obj.unit}</span>
        <button type="button" className="btn small" disabled={!(parseFloat(real) > 0)} onClick={apply}>
          {t("measure.fit")}
        </button>
      </div>
      <small className="note">{t(others ? "measure.fitNoteAll" : "measure.fitNote")}</small>
    </div>
  );
}

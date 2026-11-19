/**
 * いまの編集内容を一覧にまとめる（保存前の確認用）。ページに付けた編集と、文書全体の設定の両方を見る。
 * 文言は i18n のキーで返し、表示側で翻訳する。
 */
import type { DocSettings } from "./docOps";
import type { Key } from "./i18n";
import type { EditObj, PageItem } from "./types";

export interface ChangeItem {
  /** i18n キー */
  label: Key;
  /** 件数や内容（そのまま表示） */
  detail?: string;
  /** 関係するページ番号（1 始まり、複数可） */
  pages?: number[];
}

const OBJECT_LABEL: Partial<Record<EditObj["type"], Key>> = {
  text: "change.addText",
  textedit: "change.editText",
  rect: "change.shape",
  ellipse: "change.shape",
  line: "change.shape",
  whiteout: "change.whiteout",
  redact: "change.redact",
  markup: "change.markup",
  note: "change.note",
  ink: "change.ink",
  stamp: "change.stamp",
  image: "change.image",
  imageedit: "change.imageEdit",
};

export function summarizeChanges(pages: PageItem[], settings: DocSettings): ChangeItem[] {
  const items: ChangeItem[] = [];

  // --- 文書全体の設定 ---
  const d = settings.decor;
  if (d.numbering.enabled) items.push({ label: "change.numbering", detail: d.numbering.template });
  if (d.header.enabled) items.push({ label: "change.header" });
  if (d.footer.enabled) items.push({ label: "change.footer" });
  if (d.watermark.enabled) items.push({ label: "change.watermark", detail: d.watermark.kind === "text" ? d.watermark.text : undefined });
  if (settings.grayscale) items.push({ label: "change.grayscale" });
  if (settings.compress?.enabled) items.push({ label: "change.compress" });
  if (settings.security?.enabled) items.push({ label: "change.protect" });
  if (settings.meta?.sanitize) items.push({ label: "change.sanitize" });
  else if (settings.meta && (settings.meta.title || settings.meta.author || settings.meta.subject || settings.meta.keywords)) items.push({ label: "change.metadata" });
  if (settings.stripAnnotations) items.push({ label: "change.stripAnnots" });
  if (settings.outline?.length) items.push({ label: "change.outline", detail: String(settings.outline.length) });
  if (settings.attachments?.length) items.push({ label: "change.attachments", detail: String(settings.attachments.length) });

  // --- ページに付けた編集（種類ごとにページを集約） ---
  const byType = new Map<Key, Set<number>>();
  let rotated = 0;
  let cropped = 0;
  let resized = 0;
  pages.forEach((p, i) => {
    const no = i + 1;
    if (p.extraRotation % 360 !== 0) rotated++;
    if (p.crop) cropped++;
    if (p.scaleTo) resized++;
    for (const o of p.objects) {
      const key = OBJECT_LABEL[o.type];
      if (!key) continue;
      if (!byType.has(key)) byType.set(key, new Set());
      byType.get(key)!.add(no);
    }
  });
  if (rotated) items.push({ label: "change.rotate", detail: String(rotated) });
  if (cropped) items.push({ label: "change.crop", detail: String(cropped) });
  if (resized) items.push({ label: "change.resize", detail: String(resized) });
  // 編集の多い順
  const order: Key[] = ["change.editText", "change.addText", "change.redact", "change.whiteout", "change.markup", "change.note", "change.ink", "change.stamp", "change.shape", "change.image", "change.imageEdit"];
  for (const key of order) {
    const set = byType.get(key);
    if (set && set.size) items.push({ label: key, detail: String(set.size), pages: [...set].sort((a, b) => a - b) });
  }
  return items;
}

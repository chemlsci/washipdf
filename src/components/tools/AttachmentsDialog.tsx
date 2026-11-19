/** 添付ファイルの一覧・追加・削除・ダウンロード */
import { useState } from "react";
import type { AttachmentItem } from "@/lib/attachments";
import { uid } from "@/lib/geometry";
import { useT } from "@/lib/i18n";
import type { SourceDoc } from "@/lib/types";
import { downloadBlob } from "@/lib/zip";
import { Dialog } from "../Dialog";
import { Icon } from "../Icon";
import { formatBytes } from "./CompressDialog";
import { displayName } from "@/lib/fileName";

export function AttachmentsDialog({ attachments, sources, onApply, onClose }: { attachments: AttachmentItem[]; sources: Map<string, SourceDoc>; onApply: (items: AttachmentItem[]) => void; onClose: () => void }) {
  const t = useT();
  const [items, setItems] = useState<AttachmentItem[]>(attachments.map((a) => ({ ...a })));
  const addFiles = async (files: File[]) => {
    const added: AttachmentItem[] = [];
    for (const f of files) added.push({ id: uid("att"), name: f.name, bytes: new Uint8Array(await f.arrayBuffer()), mime: f.type || "application/octet-stream", description: "", srcId: null });
    setItems((prev) => [...prev, ...added]);
  };
  return (
    <Dialog
      title={t("tool.attachments")}
      onClose={onClose}
      wide
      footer={
        <>
          <label className="btn file-btn">
            <Icon name="plus" /> {t("attach.add")}
            <input
              type="file"
              multiple
              hidden
              onChange={(e) => {
                void addFiles([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
          </label>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            className="btn primary"
            onClick={() => {
              onApply(items);
              onClose();
            }}
          >
            {t("stamp.apply")}
          </button>
        </>
      }
    >
      {!items.length && <p className="note">{t("attach.empty")}</p>}
      <div className="attach-list">
        {items.map((a) => (
          <div key={a.id} className="attach-row">
            <Icon name="paperclip" />
            <div className="attach-body">
              <b>{displayName(a.name)}</b>
              <small>
                {formatBytes(a.bytes.length)} · {a.mime}
                {a.srcId && sources.get(a.srcId) ? ` · ${t("attach.from", { name: sources.get(a.srcId)!.name })}` : ""}
              </small>
              <input value={a.description} placeholder={t("attach.description")} onChange={(e) => setItems((prev) => prev.map((x) => (x.id === a.id ? { ...x, description: e.target.value } : x)))} />
            </div>
            {/* 種類（MIME）と名前は PDF に書かれた値で、信用できない。必ず「中身の分からないファイル」としてダウンロードさせ、
                ブラウザーに HTML などとして開かせない（名前は downloadBlob が無害化する） */}
            <button className="icon-btn" title={t("attach.download")} onClick={() => downloadBlob(new Blob([a.bytes as BlobPart], { type: "application/octet-stream" }), a.name)}>
              <Icon name="download" />
            </button>
            <button className="icon-btn danger" title={t("common.delete")} onClick={() => setItems((prev) => prev.filter((x) => x.id !== a.id))}>
              <Icon name="trash" />
            </button>
          </div>
        ))}
      </div>
      <p className="note">{t("attach.help")}</p>
    </Dialog>
  );
}

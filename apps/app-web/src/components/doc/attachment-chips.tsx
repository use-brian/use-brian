"use client";

/**
 * The staged-attachment chip row shown above a chat composer while files are
 * uploading / ready to send. Driven entirely by the `Attachment[]` state from
 * `useFileAttachments`; renders nothing when empty so hosts can mount it
 * unconditionally.
 *
 * Shared by `FloatingChat`, `PageComments`, and `CommentThreadBody`.
 *
 * [COMP:app-web/attachment-chips]
 */

import * as React from "react";
import { AlertCircle, FileText, Loader2, Paperclip, X } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import type { Attachment } from "@/lib/use-file-attachments";

/**
 * Drop-target overlay shown while a file is dragged over a chat surface. The
 * host puts `position: relative` on the drop container, spreads `dropProps`
 * from `useFileDrop`, and renders this with `active={isDragging}`. Covers the
 * container with a dashed-border "Drop files to attach" affordance.
 */
export function FileDropOverlay({ active }: { active: boolean }) {
  const t = useT().attachments;
  if (!active) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-[inherit] border-2 border-dashed border-ring bg-background/85 backdrop-blur-[1px]">
      <span className="inline-flex items-center gap-2 rounded-md bg-background/90 px-3 py-1.5 text-[13px] font-medium text-foreground shadow-sm">
        <Paperclip className="size-4" aria-hidden />
        {t.dropToAttach}
      </span>
    </div>
  );
}

export function AttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: Attachment[];
  onRemove: (localId: string) => void;
}) {
  const t = useT().attachments;
  if (attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {attachments.map((a) => {
        const isError = a.status === "error";
        return (
          <span
            key={a.localId}
            title={isError ? a.error || t.uploadFailed : a.fileName}
            className={
              "inline-flex max-w-[180px] items-center gap-1.5 rounded-md border py-1 pl-1.5 pr-1 text-[12px] " +
              (isError
                ? "border-destructive/40 bg-destructive/10 text-destructive"
                : "border-border bg-muted/50 text-foreground/80")
            }
          >
            {a.status === "uploading" ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
            ) : isError ? (
              <AlertCircle className="size-3.5 shrink-0" />
            ) : a.previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={a.previewUrl}
                alt=""
                className="size-4 shrink-0 rounded-sm object-cover"
              />
            ) : (
              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate">
              {a.status === "uploading" ? t.uploading : a.fileName}
            </span>
            <button
              type="button"
              aria-label={t.remove}
              onClick={() => onRemove(a.localId)}
              className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </span>
        );
      })}
    </div>
  );
}

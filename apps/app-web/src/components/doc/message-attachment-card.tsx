"use client";


/**
 * Renders a chat/comment message's uploaded attachments as file cards — an
 * image thumbnail (sourced from the base64 the message persists, so it
 * survives past the 7-day upload cache) or a mime-type icon, with the
 * filename and a type label. Replaces the raw `<attached_file>` markup / plain
 * "📎 filename" text in the history.
 *
 * Driven by `parseMessageAttachments` (lib/api/sessions). Three preview
 * shapes:
 *  - an image whose bytes ride the message opens in the shared
 *    `VisualLightbox` (pan/zoom);
 *  - a PDF whose bytes ride the message opens in an in-app iframe viewer;
 *  - an office/structured document (docx/pptx/xlsx/csv/…) opens the same
 *    viewer, but the PDF is rendered server-side from the upload cache
 *    (`GET /api/files/:id/preview-pdf`, LibreOffice) — available while the
 *    7-day cache lives, honest "unavailable" copy after.
 * Anything else stays a static card.
 *
 * [COMP:app-web/message-attachment-card]
 */

import * as React from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Download, FileAudio, FileImage, FileText, FileVideo, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { useFileCacheMedia } from "@/lib/use-doc-media";
import { hasConvertiblePdfPreview } from "@/lib/convertible-preview";
import { VisualLightbox } from "./visual-lightbox";
import { PdfFrame, useLocalFileUrl, type PreviewState } from "./file-preview";
import type { MessageAttachmentRef } from "@/lib/api/sessions";


/** "image/png" → "PNG", "application/pdf" → "PDF", "text/markdown" → "MARKDOWN". */
function typeLabel(mime: string): string {
  if (mime === "application/pdf") return "PDF";
  const sub = mime.split("/")[1] ?? mime;
  return (sub.split(/[.+]/).pop() ?? sub).toUpperCase().slice(0, 12);
}

function FileGlyph({ mime }: { mime: string }) {
  const cls = "size-5 text-muted-foreground";
  if (mime.startsWith("image/")) return <FileImage className={cls} aria-hidden />;
  if (mime.startsWith("audio/")) return <FileAudio className={cls} aria-hidden />;
  if (mime.startsWith("video/")) return <FileVideo className={cls} aria-hidden />;
  return <FileText className={cls} aria-hidden />;
}

/** What feeds the PDF viewer: bytes the client already holds, or a server render. */
type PdfSource = { kind: "dataUrl"; dataUrl: string } | { kind: "remote"; workspaceId: string; fileId: string };

/**
 * In-app PDF viewer. The browser's own PDF plugin renders inside the iframe,
 * so scroll/zoom come for free; the header offers the bytes as a download.
 *
 * A `dataUrl` source is either a `data:` URL (history path — decoded to a
 * Blob here, because Chromium refuses to render PDFs straight from `data:`
 * frames) or a `blob:` object URL (live-send path — owned by the message,
 * never revoked). A `remote` source is fetched with auth on open (the
 * server-side office→PDF render), with loading and honest-failure states.
 */
function PdfPreviewDialog({
  open,
  onOpenChange,
  name,
  source,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  source: PdfSource;
}) {
  const t = useT().attachments;
  // The same body the Chat side pane's file tab renders (chat-parity T10):
  // bytes the client holds, or the authenticated server render.
  const local = useLocalFileUrl(source.kind === "dataUrl" ? source.dataUrl : null, open);
  const remote = useFileCacheMedia(open&&source.kind==='remote'?source.workspaceId:null,open&&source.kind==='remote'?source.fileId:null,'pdf');
  const state: PreviewState = source.kind==='remote'
    ? remote.url?{kind:'ready',src:remote.url}:remote.error?{kind:'error'}:{kind:'loading'}
    : local;
  const src = state.kind === "ready" ? state.src : null;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop
          className={cn(
            "fixed inset-0 z-50 bg-background/65 transition-opacity duration-150",
            "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
          )}
        />
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex h-[88dvh] w-[min(960px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg bg-background shadow-xl",
            "transition-all duration-150",
            "data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0",
            "data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0",
          )}
        >
          <div className="flex items-center gap-1 border-b border-border py-1.5 pl-3 pr-2">
            <Dialog.Title className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
              {name}
            </Dialog.Title>
            {src ? (
              <a
                href={src}
                download={name}
                aria-label={t.download}
                title={t.download}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Download className="size-4" aria-hidden />
              </a>
            ) : null}
            <Dialog.Close
              aria-label={t.close}
              title={t.close}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" aria-hidden />
            </Dialog.Close>
          </div>
          <PdfFrame name={name} state={state} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function AttachmentCard({
  attachment,
  workspaceId,
}: {
  attachment: MessageAttachmentRef;
  workspaceId?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const isImage = attachment.mime.startsWith("image/");
  const isPdf = attachment.mime === "application/pdf";
  // Office/structured docs render server-side, so they need the file id (to
  // address the cache row) and the workspace (the access-gate scope).
  const isConvertible =
    !isImage &&
    !isPdf &&
    !!attachment.id &&
    !!workspaceId &&
    hasConvertiblePdfPreview(attachment.mime, attachment.name);
  const hasLocalBytes = !!attachment.dataUrl && (isImage || isPdf);
  const previewable = hasLocalBytes || isConvertible;
  const cardClass =
    "flex w-full max-w-[280px] items-center gap-2.5 rounded-lg border border-border bg-background/60 p-1.5";

  const body = (
    <>
      {isImage && attachment.dataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={attachment.dataUrl}
          alt={attachment.name}
          className="size-11 shrink-0 rounded-md object-cover"
        />
      ) : (
        <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-md bg-muted">
          <FileGlyph mime={attachment.mime} />
        </span>
      )}
      <span className="min-w-0 flex-1 pr-1">
        <span className="block truncate text-[13px] font-medium leading-tight text-foreground">
          {attachment.name}
        </span>
        <span className="mt-0.5 block text-[11.5px] uppercase tracking-wide text-muted-foreground">
          {typeLabel(attachment.mime)}
        </span>
      </span>
    </>
  );

  // Cards with nothing to open stay static.
  if (!previewable) return <div className={cardClass}>{body}</div>;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(cardClass, "text-left transition-colors hover:bg-accent")}
      >
        {body}
      </button>
      {isImage ? (
        <VisualLightbox open={open} onOpenChange={setOpen} label={attachment.name}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={attachment.dataUrl}
            alt={attachment.name}
            className="mx-auto max-h-[80vh] w-auto max-w-full object-contain"
          />
        </VisualLightbox>
      ) : (
        <PdfPreviewDialog
          open={open}
          onOpenChange={setOpen}
          name={attachment.name}
          source={
            hasLocalBytes
              ? { kind: "dataUrl", dataUrl: attachment.dataUrl! }
              : {
                  kind: "remote",
                  workspaceId: workspaceId!,
                  fileId: attachment.id,
                }
          }
        />
      )}
    </>
  );
}

export function MessageAttachments({
  attachments,
  workspaceId,
}: {
  attachments: MessageAttachmentRef[];
  /**
   * Scope for server-rendered office previews. Optional: without it, office
   * cards stay static (image/PDF previews are unaffected — their bytes are
   * local).
   */
  workspaceId?: string;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {attachments.map((a) => (
        <AttachmentCard key={a.id || a.name} attachment={a} workspaceId={workspaceId} />
      ))}
    </div>
  );
}

"use client";


import { publicRuntimeConfig } from "@/lib/runtime-public-config";
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
import { Download, FileAudio, FileImage, FileText, FileVideo, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { authFetch } from "@/lib/auth-fetch";
import { hasConvertiblePdfPreview } from "@/lib/convertible-preview";
import { VisualLightbox } from "./visual-lightbox";
import type { MessageAttachmentRef } from "@/lib/api/sessions";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

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
type PdfSource = { kind: "dataUrl"; dataUrl: string } | { kind: "remote"; url: string };

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
  const [state, setState] = React.useState<
    { kind: "idle" } | { kind: "loading" } | { kind: "ready"; src: string } | { kind: "error" }
  >({ kind: "idle" });

  // The host builds `source` inline each render, so the effect keys on the
  // stable primitives inside it — depending on the object identity would
  // refetch on every render while open.
  const sourceKey = source.kind === "dataUrl" ? source.dataUrl : source.url;
  React.useEffect(() => {
    if (!open) {
      setState({ kind: "idle" });
      return;
    }
    if (source.kind === "dataUrl") {
      if (!source.dataUrl.startsWith("data:")) {
        setState({ kind: "ready", src: source.dataUrl });
        return;
      }
      const m = /^data:([^;]+);base64,(.+)$/.exec(source.dataUrl);
      if (!m) {
        setState({ kind: "error" });
        return;
      }
      const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: m[1] }));
      setState({ kind: "ready", src: url });
      return () => URL.revokeObjectURL(url);
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ kind: "loading" });
    authFetch(source.url)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        objectUrl = URL.createObjectURL(blob);
        if (!cancelled) setState({ kind: "ready", src: objectUrl });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "error" });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sourceKey stands in for the unstable `source` object
  }, [open, source.kind, sourceKey]);

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
            "fixed left-1/2 top-1/2 z-50 flex h-[88vh] w-[min(960px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg bg-background shadow-xl",
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
          {src ? (
            <iframe src={src} title={name} className="min-h-0 w-full flex-1" />
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
              {state.kind === "error" ? (
                <p className="text-[13px] text-muted-foreground">{t.previewUnavailable}</p>
              ) : (
                <p className="inline-flex items-center gap-2 text-[13px] text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  {t.preparing}
                </p>
              )}
            </div>
          )}
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
                  url: `${API_URL}/api/files/${encodeURIComponent(attachment.id)}/preview-pdf?workspaceId=${encodeURIComponent(workspaceId!)}`,
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

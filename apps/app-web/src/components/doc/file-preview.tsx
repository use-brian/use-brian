"use client";

/**
 * One file preview body, shared by the attachment modals and the Chat side
 * pane's `file` tab (chat-parity T10). The modals (`PdfPreviewDialog`,
 * `VisualLightbox`) remain for surfaces without a pane; the pane renders this
 * body inline, so a file opened from a chat stays beside the conversation.
 *
 * - A PDF renders in the browser's own viewer inside an iframe. A `data:`
 *   URL is decoded to a Blob first (Chromium refuses PDFs from `data:`
 *   frames); a `blob:` URL is used as-is; otherwise the bytes come from the
 *   authenticated media routes.
 * - An Office or other convertible document renders through the server's
 *   PDF projection (`preview-pdf`).
 * - An image renders in the pan/zoom stage.
 * - Anything else says so honestly and offers the download.
 *
 * `source` picks the byte route: `cache` is a chat upload (`/api/files/:id`),
 * `durable` a stored workspace file (`/api/doc-files/...`).
 *
 * [COMP:app-web/chat-side-pane]
 */

import * as React from "react";
import { Download, Loader2 } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { useDocMedia, useFileCacheMedia } from "@/lib/use-doc-media";
import { hasConvertiblePdfPreview } from "@/lib/convertible-preview";
import { ZoomableVisual } from "./visual-lightbox";

export type FilePreviewSource = "cache" | "durable";

export type PreviewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; src: string }
  | { kind: "error" };

/**
 * Bytes the client already holds, as something an iframe or `<img>` can show.
 * A `data:` URL becomes an object URL (revoked when it changes); anything
 * else is used as-is.
 */
export function useLocalFileUrl(dataUrl: string | null, active = true): PreviewState {
  const [state, setState] = React.useState<PreviewState>({ kind: "idle" });
  React.useEffect(() => {
    if (!active || !dataUrl) {
      setState({ kind: "idle" });
      return;
    }
    if (!dataUrl.startsWith("data:")) {
      setState({ kind: "ready", src: dataUrl });
      return;
    }
    const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
    if (!match) {
      setState({ kind: "error" });
      return;
    }
    const bytes = Uint8Array.from(atob(match[2]!), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: match[1] }));
    setState({ kind: "ready", src: url });
    return () => URL.revokeObjectURL(url);
  }, [active, dataUrl]);
  return state;
}

/** The PDF frame, or its loading / honest-failure state. */
export function PdfFrame({ name, state }: { name: string; state: PreviewState }) {
  const t = useT().attachments;
  if (state.kind === "ready") {
    return <iframe src={state.src} title={name} className="min-h-0 w-full flex-1" />;
  }
  return (
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
  );
}

function mediaState(media: { url: string | null; error: unknown }): PreviewState {
  return media.url ? { kind: "ready", src: media.url } : media.error ? { kind: "error" } : { kind: "loading" };
}

/**
 * The inline preview of one file: what the `file` tab renders. Fills its
 * container (a flex column) and owns no chrome beyond a download link.
 */
export function FilePreviewBody({
  workspaceId,
  name,
  mime,
  fileId,
  dataUrl,
  source,
}: {
  workspaceId: string;
  name: string;
  mime: string;
  fileId: string | null;
  dataUrl?: string | null;
  source: FilePreviewSource;
}) {
  const t = useT().attachments;
  const isImage = mime.startsWith("image/");
  const isPdf = mime === "application/pdf";
  const convertible = !isImage && !isPdf && hasConvertiblePdfPreview(mime, name);
  const local = useLocalFileUrl(dataUrl ?? null);
  const hasLocal = !!dataUrl && (isImage || isPdf);
  const remoteId = hasLocal ? null : fileId;
  // Cache uploads render through `/api/files/:id/preview(-pdf)`; stored files
  // through the durable route (originals only: there is no durable PDF
  // projection for Office files, so those offer the download instead).
  const cache = useFileCacheMedia(
    source === "cache" && remoteId ? workspaceId : null,
    source === "cache" ? remoteId : null,
    isPdf || convertible ? "pdf" : "original",
  );
  const durable = useDocMedia(
    source === "durable" && remoteId && (isImage || isPdf) ? workspaceId : null,
    source === "durable" && (isImage || isPdf) ? remoteId : null,
  );
  const state: PreviewState = hasLocal
    ? local
    : source === "cache"
      ? remoteId && (isImage || isPdf || convertible) ? mediaState(cache) : { kind: "error" }
      : remoteId && (isImage || isPdf) ? mediaState(durable) : { kind: "error" };
  const downloadHref = state.kind === "ready" ? state.src : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-file-preview={isImage ? "image" : isPdf || convertible ? "pdf" : "none"}>
      <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-3 py-1.5">
        <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{name}</p>
        {downloadHref ? (
          <a
            href={downloadHref}
            download={name}
            aria-label={t.download}
            title={t.download}
            className="grid size-11 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground sm:size-8"
          >
            <Download className="size-4" aria-hidden />
          </a>
        ) : null}
      </div>
      {isImage && state.kind === "ready" ? (
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <ZoomableVisual label={name}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={state.src} alt={name} className="mx-auto max-h-full w-auto max-w-full object-contain" />
          </ZoomableVisual>
        </div>
      ) : (
        <PdfFrame name={name} state={state} />
      )}
    </div>
  );
}

"use client";

/**
 * Renders a chat/comment message's uploaded attachments as file cards — an
 * image thumbnail (sourced from the base64 the message persists, so it
 * survives past the 7-day upload cache) or a mime-type icon, with the
 * filename and a type label. Replaces the raw `<attached_file>` markup / plain
 * "📎 filename" text in the history.
 *
 * Driven by `parseMessageAttachments` (lib/api/sessions). Image cards link to
 * the full-size image; non-image cards are static (the original bytes aren't
 * available client-side once the upload cache expires).
 *
 * [COMP:app-web/message-attachment-card]
 */

import * as React from "react";
import { FileAudio, FileImage, FileText, FileVideo } from "lucide-react";
import { cn } from "@/lib/utils";
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

function AttachmentCard({ attachment }: { attachment: MessageAttachmentRef }) {
  const isImage = attachment.mime.startsWith("image/");
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

  // Image cards open full size; non-image cards have no client-side bytes.
  return isImage && attachment.dataUrl ? (
    <a
      href={attachment.dataUrl}
      target="_blank"
      rel="noreferrer"
      className={cn(cardClass, "transition-colors hover:bg-accent")}
    >
      {body}
    </a>
  ) : (
    <div className={cardClass}>{body}</div>
  );
}

export function MessageAttachments({
  attachments,
}: {
  attachments: MessageAttachmentRef[];
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {attachments.map((a) => (
        <AttachmentCard key={a.id || a.name} attachment={a} />
      ))}
    </div>
  );
}

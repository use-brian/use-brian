"use client";

/**
 * File cards for outbound assistant attachments (the `sendFile` tool).
 *
 * Each card soft-references a durable `workspace_files` row
 * (`session_messages.attachments`, migration 273). Clicking downloads
 * through `fetchDocFileBlob` (doc-file-url.ts) — signed-URL mint via
 * `?redirect=0` + direct storage fetch (a CORS fetch can't follow the
 * route's cross-origin 302 — see the helper's comment; local-disk dev
 * streams the bytes) — and the blob is handed to the browser as a named
 * download. A plain `<a href>` can't be used here: the route is
 * `requireAuth` (header-only).
 *
 * See docs/architecture/channels/adapter-pattern.md → "Outbound documents"
 * and docs/architecture/features/files.md → "sendFile".
 * [COMP:app-web/chat-file-attachment]
 */

import { useState } from "react";
import type { ChatFileAttachment } from "@use-brian/chat-ui";
import { Download, FileText, Loader2 } from "lucide-react";
import { fetchDocFileBlob } from "@/components/doc/doc-file-url";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

/** Mirrors `formatBytes` in `components/doc/block-file.tsx` (module-private there). */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function downloadAttachment(att: ChatFileAttachment): Promise<void> {
  const blob = await fetchDocFileBlob(att.workspaceId, att.fileId);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = att.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function FileAttachmentCard({ attachment }: { attachment: ChatFileAttachment }) {
  const t = useT().chat.fileAttachments;
  const [state, setState] = useState<"idle" | "downloading" | "error">("idle");

  async function handleClick(): Promise<void> {
    if (state === "downloading") return;
    setState("downloading");
    try {
      await downloadAttachment(attachment);
      setState("idle");
    } catch (err) {
      console.error("[chat] attachment download failed:", err);
      setState("error");
    }
  }

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      title={state === "error" ? t.downloadFailed : t.download}
      className={cn(
        "group/file flex w-full max-w-[340px] items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-accent",
        state === "downloading" && "cursor-progress opacity-70",
      )}
    >
      <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-foreground">
          {attachment.name}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {state === "error"
            ? t.downloadFailed
            : state === "downloading"
              ? t.downloading
              : (attachment.caption ?? formatBytes(attachment.sizeBytes))}
        </span>
      </span>
      {state === "downloading" ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden />
      ) : (
        <Download
          className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/file:opacity-100"
          aria-hidden
        />
      )}
    </button>
  );
}

export function ChatFileAttachments({
  attachments,
}: {
  attachments: ChatFileAttachment[];
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {attachments.map((att) => (
        <FileAttachmentCard key={att.fileId} attachment={att} />
      ))}
    </div>
  );
}

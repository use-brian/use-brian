"use client";

/**
 * Upload-recording entry point (recording-to-brain). A file picker + the upload
 * flow hook. Drop it into the Brain / Studio surface where a workspace member
 * can hand the brain a long call recording. Neutral chrome (no blue) per the
 * app-web design language.
 */

import { useRef } from "react";
import { useT } from "@/lib/i18n/client";
import { useRecordingUpload } from "@/lib/recordings/use-recording-upload";

export function RecordingUploadButton({
  workspaceId,
  assistantId,
}: {
  workspaceId: string;
  assistantId: string;
}) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const { run, status, message } = useRecordingUpload(workspaceId, assistantId);
  const busy = status === "uploading" || status === "processing";

  const label =
    status === "uploading"
      ? t.recordings.uploading
      : status === "processing"
        ? t.recordings.processing
        : t.recordings.uploadButton;

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={inputRef}
        type="file"
        accept="audio/*,video/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void run(f);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        className="inline-flex w-fit items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
      >
        {label}
      </button>
      {message ? (
        <p
          className={
            status === "error"
              ? "text-sm text-destructive"
              : "text-sm text-muted-foreground"
          }
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}

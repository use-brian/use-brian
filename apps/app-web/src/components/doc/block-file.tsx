"use client";

// [COMP:app-web/block-file]
/**
 * Phase 2 media block — `kind: 'file'`.
 *
 * Generic file attachment. Same durable upload + ref shape as
 * `block-image.tsx` but accepts any MIME and renders the filled state as a
 * pill (icon + name + size + download). No inline preview in v1 — PDF and
 * audio previews land in Phase 2 v2.
 *
 * Durable storage: uploads write to the permanent `workspace_files`
 * GCS-backed store via `POST /api/doc-files/:workspaceId/upload`; the ref
 * is `{ bucket: 'workspace_files', path: <fileId>, … }`.
 *
 * Download flow: the filled-state pill is an anchor pointing at the resolved
 * read URL with the `download` attribute set so the browser saves rather than
 * navigates. A `workspace_files` ref resolves through
 * `GET /api/doc-files/:workspaceId/:id` (302 → signed GCS URL); the
 * `file_cache` preview route is kept only as a legacy fallback.
 */

import { useEffect, useRef, useState } from "react";
import { useT, format } from "@/lib/i18n/client";
import { authFetch } from "@/lib/auth-fetch";
import { hasPendingMediaUpload, takeMediaUpload } from "./doc-media-uploads";
import { UploadSpinner } from "./upload-spinner";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

type FileRef = {
  bucket: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  name: string;
};

type FileBlock = {
  kind: "file";
  id: string;
  ref: FileRef | null;
};

type Props = {
  block: FileBlock;
  blockId: string;
  /** Active workspace — scopes the durable `/api/doc-files` upload + read. */
  workspaceId: string;
  readOnly?: boolean;
  onChange?: (patch: Partial<FileBlock>) => void;
  onAction?: (actionId: string, params?: Record<string, unknown>) => void;
};

function signedReadUrlFor(ref: FileRef, workspaceId: string): string | null {
  if (ref.bucket === "workspace_files") {
    return `${API_URL}/api/doc-files/${workspaceId}/${encodeURIComponent(ref.path)}`;
  }
  if (ref.bucket === "file_cache") {
    return `${API_URL}/api/files/${encodeURIComponent(ref.path)}/preview`;
  }
  return null;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function FileIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0 text-muted-foreground"
    >
      <path d="M3 2.5h6L13 6.5v7a1 1 0 01-1 1H3a1 1 0 01-1-1v-10a1 1 0 011-1z" />
      <path d="M9 2.5V6.5h4" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M8 2v8M4.5 7L8 10.5 11.5 7M3 13h10" />
    </svg>
  );
}

export function BlockFile({ block, workspaceId, readOnly, onChange }: Props) {
  const t = useT().docPage;
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Seed `uploading` from the drop registry so a drag-dropped block paints its
  // "Uploading…" state on the very first render (no flash of the empty picker).
  const [uploading, setUploading] = useState(() => hasPendingMediaUpload(block.id));
  const [uploadingName, setUploadingName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Drag-drop / paste hand-off: `doc-media-paste.ts` inserts this empty block
  // and stashes the dropped file under `block.id`. Claim it on mount and run
  // the same upload the picker uses, so the progress shows on the block.
  useEffect(() => {
    const queued = takeMediaUpload(block.id);
    if (queued) void handleFile(queued);
    // Mount-only: the file is claimed once; deps would re-run on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleFiles(files: FileList | null): void {
    const file = files?.[0];
    if (file) void handleFile(file);
  }

  async function handleFile(file: File): Promise<void> {
    setError(null);
    setUploadingName(file.name);
    setUploading(true);
    try {
      const form = new FormData();
      form.append("files", file);
      const res = await authFetch(
        `${API_URL}/api/doc-files/${workspaceId}/upload`,
        { method: "POST", body: form },
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
      }
      const data = (await res.json()) as {
        files: Array<{
          id?: string;
          name?: string;
          mimeType?: string;
          sizeBytes?: number;
          error?: string;
        }>;
      };
      const first = data.files?.[0];
      if (!first || first.error || !first.id) {
        throw new Error(first?.error ?? t.mediaBlock.uploadFailed);
      }
      onChange?.({
        ref: {
          bucket: "workspace_files",
          path: first.id,
          mimeType: first.mimeType ?? file.type ?? "application/octet-stream",
          sizeBytes: first.sizeBytes ?? file.size,
          name: first.name ?? file.name,
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      setUploadingName(null);
    }
  }

  if (!block.ref) {
    return (
      <div className="w-full">
        <button
          type="button"
          disabled={readOnly || uploading}
          onClick={() => inputRef.current?.click()}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border bg-muted/20 px-4 py-6 text-sm text-muted-foreground transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {uploading ? (
            <span className="flex items-center gap-2">
              <UploadSpinner />
              {uploadingName
                ? format(t.mediaBlock.uploadingNamed, { name: uploadingName })
                : t.mediaBlock.uploading}
            </span>
          ) : (
            t.mediaBlock.uploadFile
          )}
        </button>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            void handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
        {error && (
          <p className="mt-2 text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  const url = signedReadUrlFor(block.ref, workspaceId);
  const meta = format(t.mediaBlock.fileMeta, {
    size: formatBytes(block.ref.sizeBytes),
  });

  return (
    <div className="flex items-center gap-3 rounded-md border border-border bg-muted/20 px-3 py-2">
      <FileIcon />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-foreground" title={block.ref.name}>
          {block.ref.name}
        </div>
        <div className="text-xs text-muted-foreground">{meta}</div>
      </div>
      {url ? (
        <a
          href={url}
          download={block.ref.name}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t.mediaBlock.downloadAria}
          title={t.mediaBlock.downloadAria}
          className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <DownloadIcon />
        </a>
      ) : (
        <span
          aria-disabled
          className="flex h-7 items-center px-2 text-xs text-muted-foreground"
          title={t.mediaBlock.previewUnavailable}
        >
          {t.mediaBlock.previewUnavailable}
        </span>
      )}
    </div>
  );
}

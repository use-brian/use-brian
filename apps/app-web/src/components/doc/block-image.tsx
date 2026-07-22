"use client";

// [COMP:app-web/block-image]
/**
 * Phase 2 media block — `kind: 'image'`.
 *
 * Two visual states:
 *
 *   - `ref === null` → drop zone with a "Pick image" button. Clicking
 *     opens a native file picker (image/* only); on selection the file
 *     is uploaded through the durable `POST /api/doc-files/:workspaceId/upload`
 *     route. On success the block's `ref` field is set via `onChange`.
 *   - `ref` is set → `<img src={signedUrl}>` with the caption rendered
 *     below in caption-text weight. `alt` flows to the HTML attribute.
 *
 * Durable storage: doc block media is written to the permanent
 * `workspace_files` GCS-backed primitive via `/api/doc-files`, NOT the
 * transient `file_cache` chat-attachment store (7-day TTL) — a doc
 * *page* is durable, so its backing image must be too. The stored ref is
 * `{ bucket: 'workspace_files', path: <fileId>, mimeType, sizeBytes, name }`.
 * `resolveFileRefUrl()` (`doc-file-url.ts`) resolves a `workspace_files` ref
 * through the authenticated `GET /api/doc-files/:workspaceId/:id?redirect=0`
 * mint to a short-lived signed storage URL for the `<img src>` (the route is
 * Bearer-only, so its own URL 401s as a plain src; the signed URL never
 * lands in the doc). The `file_cache` branch is kept only as a legacy
 * fallback for any pre-existing refs, and resolves through the signed
 * preview-URL mint (WS3 #8).
 *
 * Per the agent brief, this component intentionally accepts the
 * richer `(block, blockId, readOnly, onChange, onAction)` prop set
 * even though page-renderer.tsx only forwards `block` today — P2G
 * threads the rest in when wiring the new variants.
 */

import { useEffect, useRef, useState } from "react";
import { useT, format } from "@/lib/i18n/client";
import { authFetch } from "@/lib/auth-fetch";
import { hasPendingMediaUpload, takeMediaUpload } from "./doc-media-uploads";
import {
  resolveFileRefUrl,
  type FileRef,
} from "./doc-file-url";
import { UploadSpinner } from "./upload-spinner";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

type ImageBlock = {
  kind: "image";
  id: string;
  ref: FileRef | null;
  alt?: string;
  caption?: string;
};

type Props = {
  block: ImageBlock;
  blockId: string;
  /** Active workspace — scopes the durable `/api/doc-files` upload + read. */
  workspaceId: string;
  readOnly?: boolean;
  onChange?: (patch: Partial<ImageBlock>) => void;
  onAction?: (actionId: string, params?: Record<string, unknown>) => void;
};

export function BlockImage({ block, workspaceId, readOnly, onChange }: Props) {
  const t = useT().docPage;
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Seed `uploading` from the drop registry so a drag-dropped block paints its
  // "Uploading…" state on the very first render (no flash of the empty picker).
  const [uploading, setUploading] = useState(() => hasPendingMediaUpload(block.id));
  const [uploadingName, setUploadingName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Resolved `<img src>`. Both ref kinds resolve through an authenticated
  // mint round-trip (`resolveFileRefUrl`): durable `workspace_files` refs
  // yield the short-lived signed storage URL — the read route is Bearer-only,
  // so its URL can never be used as a plain `<img src>` (no Authorization
  // header → 401) — and legacy `file_cache` refs yield the signed preview
  // URL. Guarded against out-of-order settles + unmount.
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!block.ref) {
      setResolvedUrl(null);
      return;
    }
    let cancelled = false;
    void resolveFileRefUrl(block.ref, workspaceId).then((url) => {
      if (!cancelled) setResolvedUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [block.ref, workspaceId]);

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
    if (!file.type.startsWith("image/")) {
      setError(t.mediaBlock.imageOnlyError);
      return;
    }
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
      // The /api/doc-files route writes to the permanent `workspace_files`
      // GCS-backed store; encode that sink in `bucket` so `resolveFileRefUrl()`
      // resolves it through the signed-read endpoint.
      onChange?.({
        ref: {
          bucket: "workspace_files",
          path: first.id,
          mimeType: first.mimeType ?? file.type,
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

  // ── Empty state — drop zone ─────────────────────────────────────────
  if (!block.ref) {
    return (
      <div className="w-full">
        <button
          type="button"
          disabled={readOnly || uploading}
          onClick={() => inputRef.current?.click()}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border bg-muted/20 px-4 py-8 text-sm text-muted-foreground transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {uploading ? (
            <span className="flex items-center gap-2">
              <UploadSpinner />
              {uploadingName
                ? format(t.mediaBlock.uploadingNamed, { name: uploadingName })
                : t.mediaBlock.uploading}
            </span>
          ) : (
            t.mediaBlock.uploadImage
          )}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            void handleFiles(e.target.files);
            // Allow re-picking the same file on retry.
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

  // ── Filled state ────────────────────────────────────────────────────
  const url = resolvedUrl;

  return (
    <figure className="w-full">
      {url ? (
        <img
          src={url}
          alt={block.alt ?? block.ref.name}
          loading="lazy"
          className="block w-full rounded-md border border-border bg-background object-contain"
        />
      ) : (
        <div className="flex w-full items-center justify-center rounded-md border border-dashed border-border bg-muted/20 px-4 py-12 text-sm text-muted-foreground">
          {t.mediaBlock.previewUnavailable}
        </div>
      )}
      {(block.caption !== undefined || !readOnly) && (
        <figcaption className="mt-1">
          {readOnly ? (
            block.caption ? (
              <span className="text-xs text-muted-foreground">{block.caption}</span>
            ) : null
          ) : (
            <input
              type="text"
              defaultValue={block.caption ?? ""}
              placeholder={t.mediaBlock.captionPlaceholder}
              onBlur={(e) => {
                const next = e.target.value;
                if (next !== (block.caption ?? "")) {
                  onChange?.({ caption: next });
                }
              }}
              className="w-full border-0 bg-transparent px-0 py-0 text-xs text-muted-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-0"
            />
          )}
        </figcaption>
      )}
    </figure>
  );
}

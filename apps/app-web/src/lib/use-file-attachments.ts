"use client";

/**
 * Shared chat-attachment state for every doc surface where a human chats
 * with the AI: the side-panel / mobile `FloatingChat` and the comment
 * composers (`PageComments`, `CommentThreadBody`). Mirrors the upload flow in
 * `apps/web`'s chat composer.
 *
 * Lifecycle of one attachment:
 *   1. `upload()` stages optimistic chips (status `uploading`, local preview
 *      URL for images) and POSTs the raw files to `/api/files/upload`
 *      (multipart, field `files`). That endpoint parses + caches each file in
 *      `file_cache` (transient, 7-day TTL) and returns a `fileId` per file.
 *   2. The returned ids are matched back to the staged chips by order; each
 *      flips to `done` (with its `fileId`) or `error`.
 *   3. The host reads `fileIds()` on send and passes them in the `/api/chat`
 *      body. The chat route turns them into model content blocks, so the
 *      file's information is extracted and fed into the prompt. The assistant
 *      then decides whether to persist a lasting-value file to the
 *      `workspace_files` primitive via `fileWrite`.
 *
 * The hook owns NO send logic — the host wires `fileIds()` into its own
 * `/api/chat` call and calls `clear()` afterwards.
 *
 * [COMP:app-web/file-attachments]
 */

import * as React from "react";
import { authFetch } from "@/lib/auth-fetch";
import { useT } from "@/lib/i18n/client";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * Client-side upload ceiling. Mirrors the backend `MAX_FILE_SIZE` in
 * `packages/api/src/routes/files.ts` (20 MB) so an oversized file is rejected
 * with a clear chip here instead of dying as an opaque Cloud Run 413 (its
 * platform 32 MiB request cap) or a generic 500 from the multer limit. Video is
 * rejected regardless of size (the route's mime allowlist excludes `video/`);
 * a host that supplies `onRouteMedia` diverts video to the recordings pipeline
 * (direct-to-GCS + transcription) instead. See docs/architecture/features/files.md
 * -> "Client-side upload guard" and docs/architecture/media/transcription.md.
 */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

type AttachmentStatus = "uploading" | "done" | "error";

export type Attachment = {
  /** Stable client id — the chip key + reconciliation handle. */
  localId: string;
  /** Server `file_cache` id, present once `status === "done"`. */
  fileId?: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** Object URL for image previews; revoked on remove / clear. */
  previewUrl?: string;
  status: AttachmentStatus;
  error?: string;
};

export type FileAttachmentsApi = {
  attachments: Attachment[];
  /** True while any file is still uploading — hosts block send on this. */
  uploading: boolean;
  /** True when at least one attachment is uploaded and ready to send. */
  hasReady: boolean;
  /** Ready (`done`) file ids, for the `/api/chat` body. */
  fileIds: () => string[];
  upload: (files: FileList | File[]) => Promise<void>;
  remove: (localId: string) => void;
  clear: () => void;
  /**
   * Empty the tray on send WITHOUT revoking the ready (`done`) chips' preview
   * object URLs — ownership of those URLs transfers to the just-sent user
   * message, which renders them as thumbnails until a reload rebuilds the image
   * from the server-persisted copy. Uploading / errored chips are dropped and
   * their URLs revoked as usual. The host snapshots the chips it needs from
   * `attachments` (same render) before calling this, so it returns nothing.
   * `clear()` (revokes everything) is still the right call for an abandoned tray.
   */
  detach: () => void;
};

type UploadResponse = {
  sessionId?: string;
  files: Array<{ id?: string; error?: string }>;
};

// ── Pure reconciliation helpers (unit-tested without a DOM) ──────────

/**
 * Fold an upload response back into the attachment list. The response files
 * are in the same order as the staged batch, so we walk the list and consume
 * one response per staged chip — flipping each to `done` (with its `fileId`)
 * or `error`. Other (already-resolved, or concurrently-staged) chips are left
 * untouched.
 */
export function applyUploadResult(
  prev: Attachment[],
  stagedLocalIds: ReadonlySet<string>,
  responseFiles: ReadonlyArray<{ id?: string; error?: string }>,
): Attachment[] {
  const next = [...prev];
  let idx = 0;
  for (let i = 0; i < next.length; i++) {
    if (!stagedLocalIds.has(next[i].localId)) continue;
    const result = responseFiles[idx++];
    if (!result) continue;
    next[i] =
      result.error || !result.id
        ? { ...next[i], status: "error", error: result.error ?? "upload failed" }
        : { ...next[i], fileId: result.id, status: "done" };
  }
  return next;
}

/** Mark every chip in the staged batch as failed (whole-request error). */
export function markStagedError(
  prev: Attachment[],
  stagedLocalIds: ReadonlySet<string>,
  message: string,
): Attachment[] {
  return prev.map((a) =>
    stagedLocalIds.has(a.localId) ? { ...a, status: "error" as const, error: message } : a,
  );
}

/**
 * The ready (`done`, uploaded) chips — the ones that ride the send and whose
 * previews the sent message adopts. The single definition of "handed off";
 * both `readyFileIds` (turn body) and `previewUrlsToRevokeOnDetach` (which URLs
 * to keep alive) derive from it, so the revoke side can never disagree with the
 * snapshot side and orphan-revoke a URL the message still shows.
 */
export function readyAttachments(
  attachments: ReadonlyArray<Attachment>,
): Attachment[] {
  return attachments.filter((a) => a.status === "done" && !!a.fileId);
}

/** Ready (`done`) file ids, in chip order. */
export function readyFileIds(attachments: ReadonlyArray<Attachment>): string[] {
  return readyAttachments(attachments).map((a) => a.fileId!);
}

/**
 * The preview object URLs to revoke when the tray is detached on send: every
 * chip's URL EXCEPT the ready ones, whose URLs are handed to the sent message
 * and must stay valid for the thumbnail. Pure — unit-tested without a DOM.
 */
export function previewUrlsToRevokeOnDetach(
  attachments: ReadonlyArray<Attachment>,
): string[] {
  const keep = new Set(readyAttachments(attachments).map((a) => a.localId));
  return attachments
    .filter((a) => !!a.previewUrl && !keep.has(a.localId))
    .map((a) => a.previewUrl!);
}

/** Why a file was kept out of the `/api/files/upload` POST. */
type RejectReason = "too_large" | "video_unsupported";

export type PartitionedUpload = {
  /** Files that go through the normal cache upload. */
  attach: File[];
  /** Video handed to the recordings pipeline (only when the host can route). */
  media: File[];
  /** Files never POSTed — surfaced as clear error chips instead of a 413. */
  rejected: Array<{ file: File; reason: RejectReason }>;
};

/**
 * Split a picked/dropped/pasted batch into the three upload lanes. Pure so it
 * unit-tests without a DOM (same stance as the reconciliation helpers above).
 *
 * - `video/*` → `media` when `canRouteMedia` (a host wired `onRouteMedia`);
 *   otherwise `rejected` as `video_unsupported` (the cache route's mime
 *   allowlist excludes video, so it could never attach here anyway).
 * - non-video over `maxBytes` → `rejected` as `too_large`.
 * - everything else → `attach` (the unchanged POST path).
 */
export function partitionUpload(
  files: readonly File[],
  opts: { maxBytes: number; canRouteMedia: boolean },
): PartitionedUpload {
  const attach: File[] = [];
  const media: File[] = [];
  const rejected: PartitionedUpload["rejected"] = [];
  for (const file of files) {
    const isVideo = file.type.startsWith("video/");
    if (isVideo && opts.canRouteMedia) {
      media.push(file);
    } else if (isVideo) {
      rejected.push({ file, reason: "video_unsupported" });
    } else if (file.size > opts.maxBytes) {
      rejected.push({ file, reason: "too_large" });
    } else {
      attach.push(file);
    }
  }
  return { attach, media, rejected };
}

/**
 * The image files carried by a clipboard paste — but ONLY when the paste has
 * no plain-text payload. This is the standard "paste a screenshot / copied
 * image → attach" gate: a bare image paste (a screenshot on the clipboard, or
 * "Copy image" from a browser / preview) carries no `text/plain`, so its image
 * files attach; pasting rich text from Word / Excel / a web page drags a
 * rendered image along *next to* the real `text/plain`, so we leave it to the
 * textarea and paste it as text instead of hijacking it into an attachment.
 * Non-image files are ignored — chat paste is for pictures; other file types
 * still go through the paperclip or drag-drop. The host feeds the result to
 * `upload()`, which stages the same chip a picker/drop would.
 */
export function imageFilesFromClipboard(
  clipboard:
    | { files?: ArrayLike<File> | null; getData: (type: string) => string }
    | null
    | undefined,
): File[] {
  if (!clipboard) return [];
  if (clipboard.getData("text/plain").trim().length > 0) return [];
  return Array.from(clipboard.files ?? []).filter((f) => f.type.startsWith("image/"));
}

/**
 * @param getSessionId Optional accessor for the session the upload should be
 *   cached against (e.g. a comment thread's `sessionId`). Read lazily on each
 *   upload so a session adopted mid-conversation is picked up. The `fileId`
 *   itself is session-agnostic on the read path, so this is best-effort.
 * @param opts.maxBytes Reject non-video files over this size before POSTing
 *   (default {@link MAX_ATTACHMENT_BYTES}). Guards against the opaque Cloud Run
 *   413 / multer 500.
 * @param opts.onRouteMedia When set, `video/*` files are diverted here (e.g. the
 *   recordings transcription pipeline) instead of the cache upload, and no chip
 *   is staged for them. When absent, video is rejected as unsupported-here.
 */
export function useFileAttachments(
  getSessionId?: () => string | undefined,
  opts?: { maxBytes?: number; onRouteMedia?: (files: File[]) => void },
): FileAttachmentsApi {
  const t = useT();
  const [attachments, setAttachments] = React.useState<Attachment[]>([]);

  // Keep accessors/config in refs so `upload` stays referentially stable.
  const sessionIdRef = React.useRef(getSessionId);
  sessionIdRef.current = getSessionId;
  const optsRef = React.useRef(opts);
  optsRef.current = opts;
  const rejectCopyRef = React.useRef(t.attachments);
  rejectCopyRef.current = t.attachments;

  const upload = React.useCallback(async (fileList: FileList | File[]) => {
    const all = Array.from(fileList);
    if (all.length === 0) return;

    const { attach, media, rejected } = partitionUpload(all, {
      maxBytes: optsRef.current?.maxBytes ?? MAX_ATTACHMENT_BYTES,
      canRouteMedia: !!optsRef.current?.onRouteMedia,
    });

    // Divert video to the host's media pipeline (recordings). No chip staged —
    // that flow owns its own cost-confirm + status UI.
    if (media.length > 0) optsRef.current?.onRouteMedia?.(media);

    // Guard: rejected files never POST; they surface as clear error chips so the
    // user gets a message instead of an opaque 413 / silent failure.
    if (rejected.length > 0) {
      const copy = rejectCopyRef.current;
      const rejectedChips: Attachment[] = rejected.map(({ file, reason }) => ({
        localId: crypto.randomUUID(),
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        status: "error" as const,
        error: reason === "too_large" ? copy.tooLarge : copy.videoUnsupported,
      }));
      setAttachments((prev) => [...prev, ...rejectedChips]);
    }

    if (attach.length === 0) return;

    const files = attach;
    const staged: Attachment[] = files.map((f) => ({
      localId: crypto.randomUUID(),
      fileName: f.name,
      mimeType: f.type || "application/octet-stream",
      sizeBytes: f.size,
      previewUrl: f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined,
      status: "uploading" as const,
    }));
    setAttachments((prev) => [...prev, ...staged]);

    const formData = new FormData();
    for (const f of files) formData.append("files", f);
    const sid = sessionIdRef.current?.();
    if (sid) formData.append("sessionId", sid);

    try {
      // Don't set Content-Type — the browser adds the multipart boundary.
      const res = await authFetch(`${API_URL}/api/files/upload`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) throw new Error("upload failed");
      const data = (await res.json()) as UploadResponse;
      const stagedIds = new Set(staged.map((s) => s.localId));
      setAttachments((prev) => applyUploadResult(prev, stagedIds, data.files));
    } catch (err) {
      const stagedIds = new Set(staged.map((s) => s.localId));
      setAttachments((prev) => markStagedError(prev, stagedIds, (err as Error).message));
    }
  }, []);

  const remove = React.useCallback((localId: string) => {
    setAttachments((prev) => {
      const removed = prev.find((a) => a.localId === localId);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((a) => a.localId !== localId);
    });
  }, []);

  const clear = React.useCallback(() => {
    setAttachments((prev) => {
      for (const a of prev) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      return [];
    });
  }, []);

  const detach = React.useCallback(() => {
    setAttachments((prev) => {
      // Keep the handed-off (ready) chips' object URLs alive — the sent message
      // now owns them. Revoke only the chips being dropped (uploading/errored).
      for (const url of previewUrlsToRevokeOnDetach(prev)) {
        URL.revokeObjectURL(url);
      }
      return [];
    });
  }, []);

  const fileIds = React.useCallback(() => readyFileIds(attachments), [attachments]);

  const uploading = attachments.some((a) => a.status === "uploading");
  const hasReady = attachments.some((a) => a.status === "done" && !!a.fileId);

  return { attachments, uploading, hasReady, fileIds, upload, remove, clear, detach };
}

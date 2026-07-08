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

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

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

/** Ready (`done`) file ids, in chip order. */
export function readyFileIds(attachments: ReadonlyArray<Attachment>): string[] {
  return attachments
    .filter((a) => a.status === "done" && !!a.fileId)
    .map((a) => a.fileId!);
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
 */
export function useFileAttachments(
  getSessionId?: () => string | undefined,
): FileAttachmentsApi {
  const [attachments, setAttachments] = React.useState<Attachment[]>([]);

  // Keep the accessor in a ref so `upload` stays referentially stable.
  const sessionIdRef = React.useRef(getSessionId);
  sessionIdRef.current = getSessionId;

  const upload = React.useCallback(async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (files.length === 0) return;

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

  const fileIds = React.useCallback(() => readyFileIds(attachments), [attachments]);

  const uploading = attachments.some((a) => a.status === "uploading");
  const hasReady = attachments.some((a) => a.status === "done" && !!a.fileId);

  return { attachments, uploading, hasReady, fileIds, upload, remove, clear };
}

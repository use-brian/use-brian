import { publicRuntimeConfig } from "@/lib/runtime-public-config";
/**
 * Durable-file SDK (app-web) — ordinary files either stage with
 * POST /api/files/store or explicitly decompose with POST /api/files/ingest;
 * LinkedIn ZIP archives use the dedicated lossless /api/imports/linkedin queue.
 *
 * Both paths preserve the original bytes. Only `/ingest` decomposes content
 * into entities / memories / tasks (Pipeline B). `/store` is the durable
 * staging boundary Pins uses for the upload itself; a file dropped on Pins is
 * then queued through `reingestStoredFile` (`POST /api/files/:fileId/ingest`)
 * because pinning is consent to save it to the brain (2026-08-07).
 *
 * Specs: docs/architecture/features/files.md -> "Direct ingest" and
 * docs/architecture/brain/linkedin-import.md.
 */

import { authFetch, getValidAccessToken } from "@/lib/auth-fetch";
import { usesGatewayCredentials } from "@/lib/desktop-auth-source";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

/** Keep one multipart body below Cloud Run's 32 MiB HTTP/1 request ceiling. */
export const MAX_INGEST_FILE_BYTES = 30 * 1024 * 1024;
/** Work Bench storage-only lane. Larger files are split into signed PUT parts. */
export const MAX_STORED_FILE_BYTES = 1024 * 1024 * 1024;
/** A transfer above this size needs an explicit pre-flight confirmation. */
export const LARGE_FILE_CONFIRM_BYTES = 100 * 1024 * 1024;

/**
 * Human-readable size for user-facing copy ("62.7 MB").
 * MB not MiB: the number a user reads next to a limit should match the number
 * their file manager showed them, and no user is served by the distinction.
 */
export function formatFileSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Split a batch against the multipart ceiling BEFORE anything is POSTed.
 *
 * This has to happen client-side because an oversized body never becomes an
 * HTTP error the caller can read: Cloud Run drops the connection at the edge,
 * past the CDN, before Express or multer sees a byte. `fetch` then rejects
 * with a bare `TypeError: Failed to fetch`, which is indistinguishable from
 * being offline and says nothing about size. A user who exported a 62.7 MB
 * .docx (2026-08-29) had no way to learn a limit existed.
 *
 * The 20 MB transient-attachment lane has guarded this way since it shipped
 * (`use-file-attachments.ts` -> `partitionUpload`); the durable ingest lane
 * simply never got the same treatment.
 */
export function partitionByIngestSize(
  files: File[],
  maxBytes: number = MAX_INGEST_FILE_BYTES,
): { accepted: File[]; tooLarge: File[] } {
  const accepted: File[] = [];
  const tooLarge: File[] = [];
  for (const file of files) {
    if (file.size > maxBytes) tooLarge.push(file);
    else accepted.push(file);
  }
  return { accepted, tooLarge };
}

export type IngestCounts = {
  entities: number;
  edges: number;
  memories: number;
  tasks: number;
};

/** Terminal + in-flight states of one queued `file_ingest_jobs` row. */
export type IngestJobStatus = "pending" | "processing" | "done" | "failed";

export type IngestFileResult = {
  fileName: string;
  ok: boolean;
  fileId?: string;
  path?: string;
  sizeBytes?: number;
  /**
   * `stored` = bytes filed, nothing interpreted (the /store lane).
   * `queued` = bytes filed AND parse/chunk/Pipeline B handed to the worker
   * (the /ingest lane). The upload response deliberately does not wait for
   * that work, so poll `jobId` through `getIngestJobStatus` for the outcome.
   */
  status?: "queued" | "stored";
  jobId?: string | null;
  /** A job for this file was already in flight; the work is happening either way. */
  alreadyQueued?: boolean;
  /** A model distillation produced the ingested text (PDF / image). */
  distilled?: boolean;
  /** Content was decomposed through Pipeline B (false = stored only). */
  decomposed?: boolean;
  counts?: IngestCounts;
  /** Dedicated, lossless LinkedIn archive queue result (ZIPs bypass Pipeline B). */
  linkedinImport?: {
    runId: string;
    status: "pending" | "processing" | "completed" | "failed";
    rows: number;
  };
  error?: string;
};

/** Total brain rows a file produced — the "N added" the chip shows. */
export function totalAdded(counts: IngestCounts | undefined): number {
  if (!counts) return 0;
  return counts.entities + counts.edges + counts.memories + counts.tasks;
}

export type StoreFilesOptions = {
  onProgress?: (file: File, uploadedBytes: number, totalBytes: number) => void;
};

/**
 * `fetch` does not expose request-body progress. Work Bench opts into this XHR
 * transport for its small multipart lane so the same progress callback covers
 * every accepted file, not only files large enough for signed parts.
 */
async function uploadMultipartFile(
  url: string,
  formData: FormData,
  file: File,
  options: StoreFilesOptions,
): Promise<Response> {
  if (!options.onProgress || typeof XMLHttpRequest === "undefined") {
    return authFetch(url, { method: "POST", body: formData });
  }

  const token = await getValidAccessToken();
  if (!token) {
    return authFetch(url, { method: "POST", body: formData });
  }

  const response = await new Promise<Response>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.withCredentials = usesGatewayCredentials();
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) return;
      const uploadedBytes = Math.min(
        file.size,
        Math.round((event.loaded / event.total) * file.size),
      );
      options.onProgress?.(file, uploadedBytes, file.size);
    };
    xhr.onload = () => {
      if (xhr.status !== 401) {
        options.onProgress?.(file, file.size, file.size);
      }
      const headers = new Headers();
      const contentType = xhr.getResponseHeader("Content-Type");
      if (contentType) headers.set("Content-Type", contentType);
      resolve(new Response(xhr.responseText || null, {
        status: xhr.status,
        statusText: xhr.statusText,
        headers,
      }));
    };
    xhr.onerror = () => reject(new TypeError("Upload request failed"));
    xhr.onabort = () => reject(new DOMException("Upload aborted", "AbortError"));
    xhr.send(formData);
  });

  // A fresh token was acquired before the XHR. If the server still rejects it,
  // hand the request to the standard refresh-and-retry path. This is rare, but
  // preserves authFetch's session behavior rather than turning token rotation
  // into a file error.
  if (response.status === 401) {
    return authFetch(url, { method: "POST", body: formData });
  }
  return response;
}

/**
 * Poll one queued ingest. `null` means the status could not be read (offline,
 * a transient 5xx) — NOT that the ingest failed. The job is durable server-side,
 * so a caller must keep showing "analyzing" rather than inventing a failure.
 */
export async function getIngestJobStatus(
  jobId: string,
): Promise<{ status: IngestJobStatus; error?: string } | null> {
  try {
    const res = await authFetch(`${API_URL}/api/files/ingest-jobs/${jobId}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { status?: IngestJobStatus; error?: string };
    return data.status ? { status: data.status, ...(data.error ? { error: data.error } : {}) } : null;
  } catch {
    return null;
  }
}

/**
 * Upload + ingest a UI batch. Each file travels in its own request so the
 * selected files' combined bytes cannot exceed Cloud Run's request ceiling.
 * Request failures become that file's `ok: false` result, preserving successful
 * siblings and the caller's positional reconciliation.
 */
async function uploadDurableFiles(
  workspaceId: string,
  files: File[],
  action: "store" | "ingest",
  options: StoreFilesOptions = {},
): Promise<IngestFileResult[]> {
  const results: IngestFileResult[] = [];
  for (const file of files) {
    const formData = new FormData();
    formData.append("files", file);
    formData.append("workspaceId", workspaceId);

    try {
      // Don't set Content-Type — the browser adds the multipart boundary.
      const url = `${API_URL}/api/files/${action}`;
      const res = action === "store"
        ? await uploadMultipartFile(url, formData, file, options)
        : await authFetch(url, { method: "POST", body: formData });
      const data = (await res.json().catch(() => null)) as
        | { files?: IngestFileResult[]; error?: string; detail?: string }
        | null;
      if (!res.ok) {
        results.push({
          fileName: file.name,
          ok: false,
          error: data?.detail ?? data?.error ?? `Ingest failed (HTTP ${res.status})`,
        });
        continue;
      }
      results.push(
        data?.files?.[0] ?? {
          fileName: file.name,
          ok: false,
          error: `Ingest failed (HTTP ${res.status})`,
        },
      );
    } catch (err) {
      results.push({
        fileName: file.name,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

type ChunkedUploadStart = {
  uploadId: string;
  parts: Array<{
    index: number;
    offset: number;
    sizeBytes: number;
    url: string;
  }>;
};

const waitForRetry = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function putChunkWithRetry(url: string, bytes: Blob): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: bytes,
      });
      if (!response.ok) throw new Error(`Part upload failed (HTTP ${response.status})`);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await waitForRetry(250 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Part upload failed");
}

async function storeFileChunked(
  workspaceId: string,
  file: File,
  options: StoreFilesOptions,
): Promise<IngestFileResult> {
  const startResponse = await authFetch(`${API_URL}/api/files/uploads/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId,
      fileName: file.name,
      mime: file.type || "application/octet-stream",
      sizeBytes: file.size,
    }),
  });
  const start = (await startResponse.json().catch(() => null)) as
    | (ChunkedUploadStart & { error?: string; detail?: string })
    | null;
  if (!startResponse.ok || !start?.uploadId || !Array.isArray(start.parts)) {
    throw new Error(start?.detail ?? start?.error ?? `Upload failed (HTTP ${startResponse.status})`);
  }

  let completed = false;
  try {
    let uploadedBytes = 0;
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(3, start.parts.length) },
      async () => {
        while (cursor < start.parts.length) {
          const part = start.parts[cursor];
          cursor += 1;
          const slice = file.slice(part.offset, part.offset + part.sizeBytes);
          if (slice.size !== part.sizeBytes) throw new Error("Upload part size changed");
          await putChunkWithRetry(part.url, slice);
          uploadedBytes += part.sizeBytes;
          options.onProgress?.(file, uploadedBytes, file.size);
        }
      },
    );
    await Promise.all(workers);

    const completeResponse = await authFetch(
      `${API_URL}/api/files/uploads/${encodeURIComponent(start.uploadId)}/complete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      },
    );
    const result = (await completeResponse.json().catch(() => null)) as
      | (IngestFileResult & { detail?: string })
      | null;
    if (!completeResponse.ok || !result?.ok || !result.fileId) {
      throw new Error(result?.detail ?? result?.error ?? `Upload failed (HTTP ${completeResponse.status})`);
    }
    completed = true;
    return result;
  } finally {
    if (!completed) {
      await authFetch(`${API_URL}/api/files/uploads/${encodeURIComponent(start.uploadId)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      }).catch(() => undefined);
    }
  }
}

/** Store durable bytes without parsing, distilling, indexing, or Pipeline B. */
export function storeFiles(
  workspaceId: string,
  files: File[],
  options: StoreFilesOptions = {},
): Promise<IngestFileResult[]> {
  return (async () => {
    const results: IngestFileResult[] = [];
    for (const file of files) {
      if (file.size <= MAX_INGEST_FILE_BYTES) {
        results.push(...await uploadDurableFiles(workspaceId, [file], "store", options));
        continue;
      }
      try {
        results.push(await storeFileChunked(workspaceId, file, options));
      } catch (error) {
        results.push({
          fileName: file.name,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  })();
}

/** Store and explicitly decompose files into the workspace brain. */
export function ingestFiles(
  workspaceId: string,
  files: File[],
): Promise<IngestFileResult[]> {
  return uploadDurableFiles(workspaceId, files, "ingest");
}

type LinkedInImportResponse = {
  run: {
    id: string;
    status: "pending" | "processing" | "completed" | "failed";
    counts: { rows: number };
    error?: string | null;
  };
};

type LinkedInImportPollOptions = {
  pollIntervalMs?: number;
  timeoutMs?: number;
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function linkedInResult(file: File, data: LinkedInImportResponse): IngestFileResult {
  return {
    fileName: file.name,
    ok: data.run.status === "completed",
    linkedinImport: {
      runId: data.run.id,
      status: data.run.status,
      rows: data.run.counts.rows,
    },
    ...(data.run.status === "failed" ? { error: data.run.error ?? "LinkedIn import failed" } : {}),
  };
}

/**
 * Store + enqueue a complete LinkedIn data-export ZIP. The backend preserves
 * every member/row and builds the identity/referral graph asynchronously.
 */
export async function ingestLinkedInArchive(
  workspaceId: string,
  file: File,
  options: LinkedInImportPollOptions = {},
): Promise<IngestFileResult> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("workspaceId", workspaceId);
  const res = await authFetch(`${API_URL}/api/imports/linkedin`, {
    method: "POST",
    body: formData,
  });
  const data = (await res.json().catch(() => null)) as
    | (LinkedInImportResponse & { error?: string; detail?: string })
    | null;
  if (!res.ok || !data?.run) {
    throw new Error(
      data?.detail || data?.error || `LinkedIn import failed (HTTP ${res.status})`,
    );
  }
  if (data.run.status === "completed" || data.run.status === "failed") {
    return linkedInResult(file, data);
  }

  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + (options.timeoutMs ?? 30 * 60_000);
  while (Date.now() <= deadline) {
    await wait(pollIntervalMs);
    const statusRes = await authFetch(
      `${API_URL}/api/imports/linkedin/${encodeURIComponent(data.run.id)}`,
    );
    const statusData = (await statusRes.json().catch(() => null)) as
      | (LinkedInImportResponse & { error?: string; detail?: string })
      | null;
    if (!statusRes.ok || !statusData?.run) {
      throw new Error(
        statusData?.detail ||
          statusData?.error ||
          `LinkedIn import status failed (HTTP ${statusRes.status})`,
      );
    }
    if (statusData.run.status === "completed" || statusData.run.status === "failed") {
      return linkedInResult(file, statusData);
    }
  }
  throw new Error(`LinkedIn import ${data.run.id} is still processing`);
}

/** Outcome of a stored-file (re-)ingest request. */
export type ReingestOutcome =
  | { status: "queued"; jobId: string | null }
  | {
      status: "requires_confirmation";
      fileName: string;
      sizeBytes: number;
      detail: string;
    }
  | { status: "in_flight" };

/** Which recording owns a stored audio/video file. */
export type RecordingForFile = {
  recordingId: string;
  /** The recording rows were created just now; no byte was copied. */
  adopted: boolean;
  /** A processing run already completed, so a re-run can duplicate memories. */
  alreadyProcessed: boolean;
};

/**
 * Resolve the recording behind a stored media file —
 * POST /api/files/:fileId/ingest refuses audio and video by design, because
 * media is transcribed rather than parsed. This is where that refusal leads:
 * the same "Re-ingest to brain" click resolves (or adopts) the recording that
 * owns the bytes, and the caller then runs the ordinary recording flow -
 * estimate, the cost + blueprint confirmation, process.
 *
 * Starts nothing and spends nothing on its own. Spec:
 * docs/architecture/brain/file-artifacts.md -> "Re-ingest".
 */
export async function recordingForStoredFile(
  workspaceId: string,
  fileId: string,
): Promise<RecordingForFile> {
  const res = await authFetch(
    `${API_URL}/api/files/${encodeURIComponent(fileId)}/recording`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    },
  );
  const data = (await res.json().catch(() => null)) as
    | (Partial<RecordingForFile> & { detail?: string; error?: string })
    | null;
  if (!res.ok || !data?.recordingId) {
    throw new Error(data?.detail ?? data?.error ?? `Could not resolve the recording (HTTP ${res.status})`);
  }
  return {
    recordingId: data.recordingId,
    adopted: data.adopted === true,
    alreadyProcessed: data.alreadyProcessed === true,
  };
}

/**
 * Deterministic (re-)ingestion of a file ALREADY stored in workspace_files —
 * POST /api/files/:fileId/ingest. The server enforces the double-ingestion
 * guard: an already-ingested file answers `requires_confirmation` until the
 * request is re-sent with `confirm: true` (the caller must show the user a
 * confirmation first; re-ingesting spends model credits and can duplicate
 * extracted memories). Spec: docs/architecture/brain/file-artifacts.md ->
 * "Re-ingest".
 */
export async function reingestStoredFile(
  workspaceId: string,
  fileId: string,
  opts: { confirm?: boolean } = {},
): Promise<ReingestOutcome> {
  const res = await authFetch(`${API_URL}/api/files/${encodeURIComponent(fileId)}/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, ...(opts.confirm ? { confirm: true } : {}) }),
  });
  const data = (await res.json().catch(() => null)) as
    | {
        jobId?: string | null;
        requiresConfirmation?: boolean;
        fileName?: string;
        sizeBytes?: number;
        detail?: string;
        error?: string;
      }
    | null;
  if (res.status === 202) return { status: "queued", jobId: data?.jobId ?? null };
  if (res.status === 409 && data?.requiresConfirmation) {
    return {
      status: "requires_confirmation",
      fileName: data.fileName ?? "",
      sizeBytes: data.sizeBytes ?? 0,
      detail: data.detail ?? "",
    };
  }
  if (res.status === 409 && data?.error === "ingest_in_flight") return { status: "in_flight" };
  // `error` is a CODE (`file_too_large`, `quota_exceeded`); `detail` is the
  // sentence written for a person. Showing the code makes the user search
  // for a phrase that exists nowhere in the product.
  throw new Error(data?.detail || data?.error || `Ingest failed (HTTP ${res.status})`);
}

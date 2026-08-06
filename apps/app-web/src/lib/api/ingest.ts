/**
 * Durable-file SDK (app-web) — ordinary files either stage with
 * POST /api/files/store or explicitly decompose with POST /api/files/ingest;
 * LinkedIn ZIP archives use the dedicated lossless /api/imports/linkedin queue.
 *
 * Both paths preserve the original bytes. Only `/ingest` decomposes content
 * into entities / memories / tasks (Pipeline B). `/store` is the reversible
 * staging boundary used by Pins before the user has supplied a purpose.
 *
 * Specs: docs/architecture/features/files.md -> "Direct ingest" and
 * docs/architecture/brain/linkedin-import.md.
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** Keep one multipart body below Cloud Run's 32 MiB HTTP/1 request ceiling. */
export const MAX_INGEST_FILE_BYTES = 30 * 1024 * 1024;
/** Work Bench storage-only lane. Larger files are split into signed PUT parts. */
export const MAX_STORED_FILE_BYTES = 1024 * 1024 * 1024;
/** A transfer above this size needs an explicit pre-flight confirmation. */
export const LARGE_FILE_CONFIRM_BYTES = 100 * 1024 * 1024;

export type IngestCounts = {
  entities: number;
  edges: number;
  memories: number;
  tasks: number;
};

export type IngestFileResult = {
  fileName: string;
  ok: boolean;
  fileId?: string;
  path?: string;
  sizeBytes?: number;
  /** A model distillation produced the ingested text (PDF / image). */
  distilled?: boolean;
  /** Content was decomposed through Pipeline B (false = stored only). */
  decomposed?: boolean;
  counts?: IngestCounts;
  /** Segments written to the retrieval index. */
  segments?: number;
  /**
   * The segment cap stopped chunking before the file's tail: part of the
   * document is stored but not searchable. Rendered, never swallowed.
   */
  truncated?: boolean;
  /** Set when the file was stored but deliberately not interpreted. */
  skipped?: "unsupported_type" | "empty" | "not_requested";
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
): Promise<IngestFileResult[]> {
  const results: IngestFileResult[] = [];
  for (const file of files) {
    const formData = new FormData();
    formData.append("files", file);
    formData.append("workspaceId", workspaceId);

    try {
      // Don't set Content-Type — the browser adds the multipart boundary.
      const res = await authFetch(`${API_URL}/api/files/${action}`, {
        method: "POST",
        body: formData,
      });
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

export type StoreFilesOptions = {
  onProgress?: (file: File, uploadedBytes: number, totalBytes: number) => void;
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
        results.push(...await uploadDurableFiles(workspaceId, [file], "store"));
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
    | (LinkedInImportResponse & { error?: string })
    | null;
  if (!res.ok || !data?.run) {
    throw new Error(data?.error ?? `LinkedIn import failed (HTTP ${res.status})`);
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
      | (LinkedInImportResponse & { error?: string })
      | null;
    if (!statusRes.ok || !statusData?.run) {
      throw new Error(statusData?.error ?? `LinkedIn import status failed (HTTP ${statusRes.status})`);
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
  throw new Error(data?.error ?? `Ingest failed (HTTP ${res.status})`);
}

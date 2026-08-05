/**
 * File-ingest SDK (app-web) — ordinary files use POST /api/files/ingest;
 * LinkedIn ZIP archives use the dedicated lossless /api/imports/linkedin queue.
 *
 * One multipart request stores each file's raw bytes in the workspace brain
 * AND decomposes its content into entities / memories / tasks (Pipeline B),
 * server-side and deterministically (no chat turn). Returns a per-file result.
 * Backs the Home "Add files to your brain" drop block.
 *
 * Specs: docs/architecture/features/files.md -> "Direct ingest" and
 * docs/architecture/brain/linkedin-import.md.
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** Keep one multipart body below Cloud Run's 32 MiB HTTP/1 request ceiling. */
export const MAX_INGEST_FILE_BYTES = 30 * 1024 * 1024;

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
export async function ingestFiles(
  workspaceId: string,
  files: File[],
): Promise<IngestFileResult[]> {
  const results: IngestFileResult[] = [];
  for (const file of files) {
    const formData = new FormData();
    formData.append("files", file);
    formData.append("workspaceId", workspaceId);

    try {
      // Don't set Content-Type — the browser adds the multipart boundary.
      const res = await authFetch(`${API_URL}/api/files/ingest`, {
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

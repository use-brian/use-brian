/**
 * File-ingest SDK (app-web) — POST /api/files/ingest.
 *
 * One multipart request stores each file's raw bytes in the workspace brain
 * AND decomposes its content into entities / memories / tasks (Pipeline B),
 * server-side and deterministically (no chat turn). Returns a per-file result.
 * Backs the Home "Add files to your brain" drop block.
 *
 * Spec: docs/architecture/features/files.md -> "Direct ingest".
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

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
  error?: string;
};

/** Total brain rows a file produced — the "N added" the chip shows. */
export function totalAdded(counts: IngestCounts | undefined): number {
  if (!counts) return 0;
  return counts.entities + counts.edges + counts.memories + counts.tasks;
}

/**
 * Upload + ingest up to a few files in one request. Throws on a whole-request
 * failure (auth, 4xx, network); per-file failures come back as `ok: false`
 * entries in the result array.
 */
export async function ingestFiles(
  workspaceId: string,
  files: File[],
): Promise<IngestFileResult[]> {
  const formData = new FormData();
  for (const f of files) formData.append("files", f);
  formData.append("workspaceId", workspaceId);

  // Don't set Content-Type — the browser adds the multipart boundary.
  const res = await authFetch(`${API_URL}/api/files/ingest`, {
    method: "POST",
    body: formData,
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error ?? `Ingest failed (HTTP ${res.status})`);
  }
  const data = (await res.json()) as { files: IngestFileResult[] };
  return data.files;
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

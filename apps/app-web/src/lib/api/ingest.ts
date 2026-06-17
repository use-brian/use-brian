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

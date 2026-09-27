import { publicRuntimeConfig } from "@/lib/runtime-public-config";
/** Resolve doc media through authenticated no-store byte reads.
 * Legacy file_cache references retain their separately signed preview lane.
 * [COMP:app-web/doc-file-url]
 */

import { authFetch } from "@/lib/auth-fetch";
import { protectProjection, type ProtectedProjection } from "@/lib/use-protected-projection";
import { SurfaceCacheEvictionError } from "@/lib/surface-cache";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

export type FileRef = {
  bucket: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  name: string;
};

/** One admission for bytes and their lifetime, including the body transfer. */
async function readDocMedia(workspaceId: string, fileId: string) {
  const started = performance.now();
  try {
    const res = await authFetch(`${API_URL}/api/doc-files/${encodeURIComponent(workspaceId)}/${encodeURIComponent(fileId)}?redirect=0`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`doc file fetch failed: HTTP ${res.status}`);
    const header = res.headers.get('X-Brian-Media-Valid-For-Ms');
    const validForMs = header === null ? NaN : Number(header);
    if (!Number.isFinite(validForMs) || validForMs <= 0) throw new Error('media_lifetime_missing_or_expired');
    const blob = await res.blob();
    return { blob, ...protectProjection({ validForMs }, started) };
  } catch (error) {
    throw error instanceof SurfaceCacheEvictionError ? error : new SurfaceCacheEvictionError(error);
  }
}

/** Byte-only validation; display/download consumers use the protected hooks. */
export async function fetchDocFileBlob(workspaceId: string, fileId: string): Promise<Blob> {
  return (await readDocMedia(workspaceId, fileId)).blob;
}

export type DocMediaProjection = ProtectedProjection<{ url: string; mimeType: string; validForMs: number }>;

/** Create a cache-owned URL only after the whole byte read is admitted. */
export async function fetchDocMediaProjection(workspaceId: string, fileId: string): Promise<DocMediaProjection> {
  const { blob, ...projection } = await readDocMedia(workspaceId, fileId);
  return { ...projection, mimeType: blob.type, url: URL.createObjectURL(blob) };
}

/**
 * Resolve legacy cache references only. Durable references require the
 * identity-bound protected media hook, never an unmanaged URL.
 */
export async function resolveFileRefUrl(
  ref: FileRef,
  workspaceId: string,
): Promise<string | null> {
  if (ref.bucket === "file_cache") {
    try {
      const res = await authFetch(
        `${API_URL}/api/files/${encodeURIComponent(ref.path)}/preview-url?workspaceId=${encodeURIComponent(workspaceId)}`,
      );
      if (!res.ok) return null;
      const data = (await res.json()) as { url?: string };
      // The mint route returns a root-relative `/api/files/...` path; make it
      // absolute against the API origin so it works as a cross-origin src.
      return data.url ? `${API_URL}${data.url}` : null;
    } catch {
      return null;
    }
  }

  return null;
}

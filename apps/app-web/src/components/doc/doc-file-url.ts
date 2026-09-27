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

/** Read durable media without handing a provider capability to the browser. */
export async function fetchDocFileBlob(workspaceId: string, fileId: string): Promise<Blob> {
  const res = await authFetch(
    `${API_URL}/api/doc-files/${encodeURIComponent(workspaceId)}/${encodeURIComponent(fileId)}?redirect=0`,
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error(`doc file fetch failed: HTTP ${res.status}`);
  return res.blob();
}

/** Callers revoke the object URL when its view is replaced or unmounted. */
export async function resolveDocFileSrc(workspaceId: string, fileId: string): Promise<string> {
  return URL.createObjectURL(await fetchDocFileBlob(workspaceId, fileId));
}

export type DocMediaProjection = ProtectedProjection<{url:string;validForMs:number}>;

/** Cached displays require a server lifetime; ordinary one-shot downloads don't. */
export async function fetchDocMediaProjection(workspaceId:string,fileId:string):Promise<DocMediaProjection> {
  const started=performance.now();
  try {
    const res=await authFetch(`${API_URL}/api/doc-files/${encodeURIComponent(workspaceId)}/${encodeURIComponent(fileId)}?redirect=0`,{cache:'no-store'});
    if(!res.ok)throw new Error(`doc file fetch failed: HTTP ${res.status}`);
    const header=res.headers.get('X-Brian-Media-Valid-For-Ms');
    const validForMs=header===null?NaN:Number(header);
    if(!Number.isFinite(validForMs)||validForMs<=0)throw new Error('media_lifetime_missing_or_expired');
    const blob=await res.blob();
    // Validate expiry before creating a resource that would need disposal.
    const projection=protectProjection({validForMs},started);
    return {...projection,url:URL.createObjectURL(blob)};
  } catch(error) {
    throw error instanceof SurfaceCacheEvictionError?error:new SurfaceCacheEvictionError(error);
  }
}

/**
 * Resolve any supported `FileRef` to a browser-loadable URL. Both branches
 * require an authenticated round-trip; returns null when the ref's bucket
 * is unknown or the read fails (caller shows "preview unavailable").
 */
export async function resolveFileRefUrl(
  ref: FileRef,
  workspaceId: string,
): Promise<string | null> {
  if (ref.bucket === "workspace_files") {
    try {
      return await resolveDocFileSrc(workspaceId, ref.path);
    } catch {
      return null;
    }
  }

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

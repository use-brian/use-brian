import { publicRuntimeConfig } from "@/lib/runtime-public-config";
/** Resolve doc media through authenticated no-store byte reads.
 * Temporary file-cache previews use the same protected byte lifetime.
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
async function readMedia(url: string) {
  const started = performance.now();
  try {
    const res = await authFetch(url, { cache: 'no-store' });
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
  return (await readMedia(docMediaUrl(workspaceId, fileId))).blob;
}

export type DocMediaProjection = ProtectedProjection<{ url: string; mimeType: string; validForMs: number }>;

/** Create a cache-owned URL only after the whole byte read is admitted. */
export async function fetchDocMediaProjection(workspaceId: string, fileId: string): Promise<DocMediaProjection> {
  const { blob, ...projection } = await readMedia(docMediaUrl(workspaceId, fileId));
  return { ...projection, mimeType: blob.type, url: URL.createObjectURL(blob) };
}

export type CachedMediaRepresentation = 'original' | 'pdf';

function docMediaUrl(workspaceId:string,fileId:string):string {
  return `${API_URL}/api/doc-files/${encodeURIComponent(workspaceId)}/${encodeURIComponent(fileId)}?redirect=0`;
}

/** Temporary rows use authenticated bytes, never a signed capability. */
export async function fetchCachedMediaProjection(workspaceId:string,fileId:string,representation:CachedMediaRepresentation):Promise<DocMediaProjection> {
  const endpoint=representation==='pdf'?'preview-pdf':'preview';
  const {blob,...projection}=await readMedia(`${API_URL}/api/files/${encodeURIComponent(fileId)}/${endpoint}?workspaceId=${encodeURIComponent(workspaceId)}`);
  return {...projection,mimeType:blob.type,url:URL.createObjectURL(blob)};
}

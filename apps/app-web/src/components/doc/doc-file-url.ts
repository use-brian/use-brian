/**
 * Resolve a doc-block `FileRef` to a browser-loadable URL.
 *
 * Two backing stores:
 *
 *   - `workspace_files` (the durable doc-media sink) → the signed-read
 *     endpoint `GET /api/doc-files/:workspaceId/:id`. The route is
 *     Bearer-auth only, so its URL is NEVER usable directly as an
 *     `<img src>` / anchor href (a plain subresource request carries no
 *     Authorization header → 401). Every consumer resolves through the
 *     authenticated `?redirect=0` mint below, which returns the short-lived
 *     signed storage URL — that URL is self-authorizing and loads as a
 *     plain `<img src>` / href / direct fetch.
 *   - `file_cache` (legacy fallback, pre-durable-storage refs) → the transient
 *     chat-attachment preview route. That route is UNAUTHENTICATED but
 *     signature-gated (WS3 #8): a bare id no longer returns bytes. We first
 *     mint a short-lived signed preview URL via the authenticated
 *     `GET /api/files/:id/preview-url` (access-scoped server-side), then hand
 *     the returned `?sig=…` URL to the `<img>` — which loads cross-origin
 *     without the SameSite=Lax cookie.
 *
 * [COMP:app-web/doc-file-url]
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type FileRef = {
  bucket: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  name: string;
};

/**
 * The one authenticated read of `GET /api/doc-files/:workspaceId/:id`.
 *
 * Always sends `?redirect=0`: a CORS fetch must NOT follow the route's
 * default 302 to the signed storage URL — redirected across origins
 * (app → api → storage.googleapis.com) it gets a tainted origin, the
 * browser sends `Origin: null` on the storage leg, the bucket CORS config
 * only matches the app origins, and the browser blocks the response. Under
 * `?redirect=0` the route returns the signed URL as `{ url }` JSON instead.
 * The local-disk dev backend has no signed URL and streams the bytes from
 * the route itself; that arrives as a non-JSON response.
 */
async function mintDocFileRead(
  workspaceId: string,
  fileId: string,
): Promise<{ url: string } | { res: Response }> {
  const res = await authFetch(
    `${API_URL}/api/doc-files/${encodeURIComponent(workspaceId)}/${encodeURIComponent(fileId)}?redirect=0`,
  );
  if (!res.ok) throw new Error(`doc file fetch failed: HTTP ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const { url } = (await res.json()) as { url?: string };
    if (!url) throw new Error("doc file fetch failed: no signed url");
    return { url };
  }
  return { res };
}

/**
 * Fetch a durable `workspace_files` doc file's bytes as a Blob, for
 * byte consumers (the `PageIcon` image-icon loader, chat attachment / file
 * block named downloads). The signed URL is fetched directly — a single-hop
 * CORS request carrying the real app origin, which the bucket config allows.
 */
export async function fetchDocFileBlob(
  workspaceId: string,
  fileId: string,
): Promise<Blob> {
  const minted = await mintDocFileRead(workspaceId, fileId);
  if ("res" in minted) return minted.res.blob();
  const bytes = await fetch(minted.url);
  if (!bytes.ok) throw new Error(`doc file fetch failed: HTTP ${bytes.status}`);
  return bytes.blob();
}

/**
 * Resolve a durable `workspace_files` doc file to a URL loadable by a plain
 * `<img src>` / anchor href: the signed storage URL (short-lived — ~1h — so
 * resolve per mount, don't persist it), or an object-URL of the streamed
 * bytes in local-disk dev.
 */
export async function resolveDocFileSrc(
  workspaceId: string,
  fileId: string,
): Promise<string> {
  const minted = await mintDocFileRead(workspaceId, fileId);
  if ("url" in minted) return minted.url;
  return URL.createObjectURL(await minted.res.blob());
}

/**
 * Resolve any supported `FileRef` to a browser-loadable URL. Both branches
 * are an authenticated mint round-trip; returns null when the ref's bucket
 * is unknown or the mint fails (caller shows "preview unavailable").
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

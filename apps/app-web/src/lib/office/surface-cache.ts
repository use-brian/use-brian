/**
 * Office readers share the ONE surface cache. Collection, preview and panel reads carry
 * viewer-bound deadlines and hard invalidation. First-paint list hints inherit
 * their collection lifetime without suppressing the editor's parallel reads.
 * Spec: docs/architecture/features/perceived-performance.md.
 * [COMP:app-web/office-surface-cache]
 */

import { useEffect, useLayoutEffect, useRef } from "react";
import { OfficeApiError, type OfficeArtifact } from "@/lib/office/api";
import { invalidateSurfaceCache, seedSurfaceCache, useCachedResource, SurfaceCacheEvictionError, markSurfaceCacheStale, readSurfaceCache } from "@/lib/surface-cache";
import { officePanelCachePrefix, officeListCacheKey, type OfficeListView } from "@/lib/surface-prefetch";

/** Every lifecycle view the home lists, in the order a tap most likely came from. */
import { useOptionalWorkspaceContext } from "@/lib/workspace-context";
import { officeMetadataRemaining, inheritOfficeMetadata } from './metadata';
import { getUserInfo } from '@/lib/user';

/** Bounded Office reads reuse the shared cache's generation and expiry ownership. */
export function useOfficeMetadataResource<T>(key: string | null, viewerId: string, fetcher: () => Promise<T>, seed?: T, seedIsHint = false) {
  // A seed enters cache ownership once. Invalidation must never resurrect it
  // merely because a parent still holds the original initial-data prop.
  const seedOwner = useRef({key, unused: true});
  const initialSeed = seedOwner.current.key === key && seedOwner.current.unused && officeMetadataRemaining(seed, viewerId) > 0 ? seed : undefined;
  useLayoutEffect(() => {
    if (seedOwner.current.key !== key || !seedOwner.current.unused) return;
    seedOwner.current.unused = false;
    if (key && initialSeed && readSurfaceCache(key).data === undefined && readSurfaceCache(key).error === undefined)
      seedSurfaceCache(key, initialSeed, {expiresInMs: value => officeMetadataRemaining(value, viewerId)}, seedIsHint);
  }, [key, initialSeed, viewerId, seedIsHint]);
  const previous = useRef(key);
  useLayoutEffect(() => {
    if (previous.current && previous.current !== key) invalidateSurfaceCache(previous.current);
    previous.current = key;
  }, [key]);
  const cache = useCachedResource(key, async () => {
    try { return await fetcher(); }
    catch (error) {
      if (error instanceof OfficeApiError && ([401,403,404].includes(error.status) || ['office_projection_changed','office_projection_expired'].includes(error.message)))
        throw new SurfaceCacheEvictionError(error);
      throw error;
    }
  }, {expiresInMs: value => officeMetadataRemaining(value, viewerId)});
  const retained = cache.data ?? (cache.error === undefined ? initialSeed : undefined);
  useEffect(() => {
    if (!key) return;
    // Refresh joins in-flight reads and retains data only until its original TTL.
    // Authority events and expiry still invalidate (and fence late responses).
    const revalidate = () => { void cache.refresh(); };
    const visible = () => {if (document.visibilityState === 'visible') revalidate();};
    window.addEventListener('focus', revalidate);
    document.addEventListener('visibilitychange', visible);
    return () => {window.removeEventListener('focus', revalidate);document.removeEventListener('visibilitychange', visible);};
  }, [key, cache.refresh]);
  useEffect(() => {
    if (!key || !retained) return;
    const ttl = officeMetadataRemaining(retained, viewerId);
    if (ttl <= 0) {invalidateSurfaceCache(key);return;}
    // Also owns expiry for an already warm entry. A refresh failure cannot extend it.
    const expiry = setTimeout(() => invalidateSurfaceCache(key), Math.ceil(ttl));
    const renew = ttl > 1000 ? setTimeout(() => {void cache.refresh();}, Math.max(500, ttl - Math.min(5000, ttl / 2))) : undefined;
    return () => {clearTimeout(expiry);clearTimeout(renew);};
  }, [key, viewerId, retained, cache.refresh]);
  return {...cache, data: officeMetadataRemaining(retained, viewerId) > 0 ? retained : undefined};
}

/** Replace a protected Office slot only with a current server publication. */
export function publishOfficeMetadataResource<T>(key:string|null,value:T,viewerId:string):boolean{
  if(!key||officeMetadataRemaining(value,viewerId)<=0)return false
  invalidateSurfaceCache(key)
  return seedSurfaceCache(key,value,{expiresInMs:data=>officeMetadataRemaining(data,viewerId)})
}

const OFFICE_LIST_VIEWS: readonly OfficeListView[] = ["active", "archived", "trash", "retained"];

/**
 * The artifact's row as the home last painted it, from whichever view's
 * cached list carries it - or null when no list of this workspace is cached.
 * A list row is the same `OfficeArtifact` shape the row endpoint returns, so
 * the shell can paint title / family / role from it; it is never used to
 * decide anything the snapshot decides.
 */
export function officeArtifactFromListCache(workspaceId: string, artifactId: string, viewerId = getUserInfo()?.id ?? ""): OfficeArtifact | null {
  for (const view of OFFICE_LIST_VIEWS) {
    const rows = readSurfaceCache<OfficeArtifact[]>(officeListCacheKey(workspaceId, view, viewerId)).data;
    const row = rows?.find((candidate) => candidate.artifactId === artifactId);
    if (row && officeMetadataRemaining(rows, viewerId) > 0) return inheritOfficeMetadata({...row}, rows, viewerId);
  }
  return null;
}

/**
 * Mark the given cache prefixes stale whenever the tab returns to the
 * foreground. Stale, not gone: the mounted surface repaints from what it has
 * and `useCachedResource` refetches behind the paint.
 */
export function useOfficeCacheRevalidation(prefixes: readonly string[]): void {
  const joined = prefixes.join("|");
  useEffect(() => {
    if (typeof document === "undefined" || !joined) return;
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      for (const prefix of joined.split("|")) markSurfaceCacheStale(prefix);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [joined]);
}

/** Panel caches share one viewer/workspace owner even while their tabs unmount. */
export function useOfficePanelIdentity() {
  const workspace = useOptionalWorkspaceContext();
  const viewerId = workspace?.me.id ?? "";
  const prefix = workspace && viewerId ? officePanelCachePrefix(workspace.workspaceId, viewerId) : null;
  const previous = useRef(prefix);
  useLayoutEffect(() => {
    if (previous.current && previous.current !== prefix) invalidateSurfaceCache(previous.current);
    previous.current = prefix;
  }, [prefix]);
  return { prefix, viewerId };
}

/**
 * Persistent last-known-good tier BENEATH the in-memory surface cache.
 *
 * `lib/surface-cache.ts` removes the skeleton on a repeat navigation, but it
 * dies on reload. The instant-navigation plan (§6.4) names the lists worth
 * keeping on-device across reloads: the sidebar page tree, Chat sessions, the
 * Tasks list, the CRM config + current collection, and Feed. This module is
 * the disk half for the surface-cache keyed ones: an IndexedDB envelope per
 * (viewer, workspace, resource) in the same KV store `clearLocalDocCaches()`
 * drops on sign-out, mirroring `brain-content-cache.ts`.
 *
 * Identity includes every access-shaping axis, so a key is
 *
 *   surface-content:v1:<viewerId>:<workspaceId>:<resource>
 *
 * and the envelope also records the MEMORY key it was written for. A resource
 * that stands for a moving target (the CRM's "current collection", whose
 * memory key carries the filter query) hydrates only when the stored memory
 * key equals the one the surface is asking for, so a stale filter's rows are
 * never painted under a different filter's header.
 *
 * **How hydration works with the memory store.** `useCachedResource` starts
 * its network fetch in a mount effect, and `loadSurfaceCache` dedupes by key,
 * so a disk read that lands after that effect would join the network promise
 * instead of painting. `useSurfaceContentCache` therefore claims the key
 * FIRST: declared above the surface's `useCachedResource` call, its effect
 * runs first and starts a disk-first load (disk hit → seed the entry, then
 * mark it stale so the hook revalidates behind the paint; disk miss → fall
 * through to the network). The surface's own effect then joins that load.
 * The returned fetcher persists every successful network value, and an
 * authoritative 401 / 403 / 404 evicts BOTH tiers - a denied list is never
 * painted from a copy, and never falls back.
 *
 * Spec: docs/architecture/features/perceived-performance.md → "Surface cache"
 * (disk tier). [COMP:app-web/surface-content-cache]
 */

import { useCallback, useEffect, useRef } from "react";
import { getUserInfo } from "@/lib/user";
import {
  SurfaceCacheEvictionError,
  loadSurfaceCache,
  markSurfaceCacheStale,
  readSurfaceCache,
} from "@/lib/surface-cache";
import { idbDelete, idbGet, idbSet } from "./idb";

const CACHE_VERSION = 1;
const KEY_PREFIX = "surface-content";

/**
 * Content lease (perceived-performance.md, "Content lease for protected lists").
 * A disk copy is painted only within this window of the network read that wrote
 * it (the access-token lifetime, shared with the Feed disk tier).
 */
export const OFFLINE_AUTHORITY_MS = 60 * 60_000;
/** A network value expires this long after its request started. */
export const SURFACE_CONTENT_LEASE_MS = 30_000;
export const SURFACE_CONTENT_RENEW_MS = 15_000;
const leaseDeadlines = new WeakMap<object, number>();

function lease<T>(value: T, deadline: number): T {
  if (value && typeof value === "object") leaseDeadlines.set(value, deadline);
  return value;
}

/** Remaining authority of a leased value; an unleased value has none. */
export function surfaceContentRemaining(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  return Math.max(0, (leaseDeadlines.get(value) ?? 0) - performance.now());
}

/** Fetch and lease a value from its request start. */
export async function leaseSurfaceContent<T>(fetch: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const value = lease(await fetch(), started + SURFACE_CONTENT_LEASE_MS);
  if (surfaceContentRemaining(value) <= 0) {
    throw new SurfaceCacheEvictionError(new Error("surface_content_expired"));
  }
  return value;
}

/**
 * Renew a mounted surface's lease every 15 seconds while visible and on return to
 * the foreground. A failed renewal leaves the deadline where it was.
 */
export function useSurfaceContentRenewal(refresh: () => Promise<unknown>, active = true): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!active) return;
    const renew = () => {
      if (document.visibilityState === "visible") void refreshRef.current().catch(() => {});
    };
    const timer = setInterval(renew, SURFACE_CONTENT_RENEW_MS);
    window.addEventListener("focus", renew);
    document.addEventListener("visibilitychange", renew);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", renew);
      document.removeEventListener("visibilitychange", renew);
    };
  }, [active]);
}

export type SurfaceContentCacheScope = {
  viewerId: string;
  workspaceId: string;
};

export type SurfaceContentCacheEntry<T> = {
  value: T;
  updatedAt: number;
};

type StoredEnvelope = {
  version: typeof CACHE_VERSION;
  updatedAt: number;
  /** The in-memory surface-cache key this value was fetched for. */
  key: string;
  value: unknown;
};

function segment(value: string): string {
  return encodeURIComponent(value);
}

/** Stable, access-scoped IndexedDB key for one surface resource. */
export function surfaceContentCacheKey(
  scope: SurfaceContentCacheScope,
  resource: string,
): string {
  return [
    KEY_PREFIX,
    `v${CACHE_VERSION}`,
    segment(scope.viewerId),
    segment(scope.workspaceId),
    segment(resource),
  ].join(":");
}

/**
 * The signed-in viewer's scope for a workspace, or `null` when no viewer is
 * readable (SSR, a cleared cookie). With no viewer there is no disk tier: a
 * workspace-only key would paint one account's rows to the next.
 */
export function surfaceContentCacheScope(
  workspaceId: string | null | undefined,
): SurfaceContentCacheScope | null {
  if (!workspaceId) return null;
  const viewerId = getUserInfo()?.id;
  return viewerId ? { viewerId, workspaceId } : null;
}

/**
 * A 401 / 403 / 404 is an authoritative loss of access (or a deletion) and
 * must evict the local copy; a thrown network failure or a 5xx is not. The
 * API SDKs report the status either as an `Error` with a numeric `status`
 * property or as the trailing `(NNN)` of the message, so both are read.
 */
export function isAuthoritativeSurfaceDenial(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number") return status === 401 || status === 403 || status === 404;
  if (error instanceof Error) {
    const match = /\((401|403|404)\)\.?\s*$/.exec(error.message)
      ?? /^HTTP (401|403|404)\b/.exec(error.message);
    return match !== null;
  }
  return false;
}

function isEnvelope(value: unknown): value is StoredEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredEnvelope>;
  return (
    candidate.version === CACHE_VERSION &&
    typeof candidate.updatedAt === "number" &&
    Number.isFinite(candidate.updatedAt) &&
    typeof candidate.key === "string" &&
    "value" in candidate
  );
}

/**
 * Read + validate a cached resource for one memory key. Corrupt, old-version,
 * private-mode, missing, and other-key entries all collapse to `null`; a cache
 * failure must never break a surface.
 */
export async function readSurfaceContentCache<T>(
  scope: SurfaceContentCacheScope,
  resource: string,
  memoryKey: string,
  isValue: (value: unknown) => value is T,
): Promise<SurfaceContentCacheEntry<T> | null> {
  const stored = await idbGet<unknown>(surfaceContentCacheKey(scope, resource));
  if (!isEnvelope(stored) || stored.key !== memoryKey || !isValue(stored.value)) {
    return null;
  }
  // Outside the authority window, or future-dated: never painted as current.
  const age = Date.now() - stored.updatedAt;
  if (age > OFFLINE_AUTHORITY_MS || age < -60_000) return null;
  return { value: stored.value, updatedAt: stored.updatedAt };
}

/** Best-effort last-known-good replacement. */
export async function writeSurfaceContentCache<T>(
  scope: SurfaceContentCacheScope,
  resource: string,
  memoryKey: string,
  value: T,
): Promise<void> {
  const envelope: StoredEnvelope = {
    version: CACHE_VERSION,
    updatedAt: Date.now(),
    key: memoryKey,
    value,
  };
  await idbSet(surfaceContentCacheKey(scope, resource), envelope);
}

/** Evict a resource after an authoritative denial / deletion response. */
async function deleteSurfaceContentCache(
  scope: SurfaceContentCacheScope,
  resource: string,
): Promise<void> {
  await idbDelete(surfaceContentCacheKey(scope, resource));
}

/**
 * Wire a surface-cache key to the disk tier.
 *
 *   const fetchRows = useSurfaceContentCache({ key, workspaceId, resource,
 *     isValue, fetch: () => fetchWorkspaceTasks(workspaceId) });
 *   const rows = useCachedResource(key, fetchRows);
 *
 * Call it ABOVE the `useCachedResource` that reads the same key (React runs a
 * component's effects in declaration order, and this one has to claim the key
 * before the hook's own load starts - see the module comment). Returns the
 * fetcher to hand to `useCachedResource`: the network fetch, persisting each
 * success and evicting both tiers on an authoritative denial.
 *
 * No-op (plain pass-through fetcher) without a viewer or a key.
 */
export function useSurfaceContentCache<T>(options: {
  /** The in-memory surface-cache key the surface reads. */
  key: string | null;
  workspaceId: string;
  /** Disk resource name, scoped per viewer + workspace by this module. */
  resource: string;
  /** Shape guard for a stored value - a corrupt or old-shape copy is a miss. */
  isValue: (value: unknown) => value is T;
  /** The network fetch. Read through a ref, so an inline arrow is fine. */
  fetch: () => Promise<T>;
}): () => Promise<T> {
  const { key, workspaceId, resource } = options;
  const fetchRef = useRef(options.fetch);
  fetchRef.current = options.fetch;
  const isValueRef = useRef(options.isValue);
  isValueRef.current = options.isValue;

  const persisting = useCallback(async (): Promise<T> => {
    const scope = surfaceContentCacheScope(workspaceId);
    try {
      const value = await leaseSurfaceContent(() => fetchRef.current());
      if (scope && key) void writeSurfaceContentCache(scope, resource, key, value);
      return value;
    } catch (error) {
      if (isAuthoritativeSurfaceDenial(error)) {
        // Never paint a denied list from a copy: drop the seeded memory entry
        // too, so the surface shows its load-failed state instead of the rows
        // the server just refused.
        if (scope) void deleteSurfaceContentCache(scope, resource);
        // Let the owning request publish the denial and clear data atomically.
        // Invalidating here would detach this request, discard its error, and
        // make useCachedResource start another cold load indefinitely.
        throw new SurfaceCacheEvictionError(error);
      }
      throw error;
    }
  }, [key, resource, workspaceId]);

  useEffect(() => {
    if (!key) return;
    const scope = surfaceContentCacheScope(workspaceId);
    if (!scope) return;
    // A warm memory entry (a revisit, a hover warm that already landed) wins;
    // the disk copy is only for a cold load.
    if (readSurfaceCache(key).data !== undefined) return;
    let seeded = false;
    const diskFirst = async (): Promise<T> => {
      const cached = await readSurfaceContentCache<T>(
        scope,
        resource,
        key,
        isValueRef.current,
      );
      if (cached) {
        seeded = true;
        return lease(cached.value, performance.now() + cached.updatedAt + OFFLINE_AUTHORITY_MS - Date.now());
      }
      return persisting();
    };
    // Joins an in-flight load for the key if one already exists (then
    // `diskFirst` never runs and nothing is seeded). On a disk hit the entry
    // is marked stale right after it lands, so `useCachedResource` revalidates
    // over the network behind the painted rows.
    void loadSurfaceCache(key, diskFirst, { expiresInMs: surfaceContentRemaining }).then(() => {
      if (seeded) markSurfaceCacheStale(key);
    });
  }, [key, persisting, resource, workspaceId]);

  return persisting;
}

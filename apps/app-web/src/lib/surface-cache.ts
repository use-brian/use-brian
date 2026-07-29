/**
 * Surface cache - a stale-while-revalidate store for surface-level fetches.
 *
 * Every `/w/[workspaceId]/*` surface is a client component that fetches its
 * list on mount, and app-web ships no data-cache library. So leaving Tasks for
 * Brain and coming back re-fetched the task list from zero and painted an empty
 * pane for the whole round trip - every time, even for a list the user had been
 * staring at ten seconds earlier. Skeletons make that wait look intentional;
 * this makes most of it not happen.
 *
 * The contract, deliberately small (four behaviours, no query language):
 *
 *  - **Cached data paints immediately.** A revisit renders last-known content
 *    on the first frame instead of a skeleton.
 *  - **Stale data revalidates behind the paint.** Past `staleMs` the hook still
 *    returns the cached value, kicks off a refetch, and flags `revalidating` so
 *    a surface can show a quiet indicator rather than a blocking state.
 *  - **In-flight requests dedupe by key.** Two components (or a prefetch and a
 *    mount) asking for the same key share one request.
 *  - **Writes invalidate by prefix.** After a mutation, `invalidateSurfaceCache`
 *    drops the affected keys so the next read is authoritative.
 *
 * **Browser only.** The store is module-level, so on the server it would be
 * shared across every request and could leak one user's data into another's
 * render. Every read and write is guarded on `window`; during SSR the hook
 * reports an empty entry and the surface renders its normal loading state.
 * These surfaces are all `"use client"` with mount-time fetches, so nothing is
 * lost.
 *
 * Framework-free apart from the one hook at the bottom, so the store half unit
 * tests in plain Node.
 *
 * Spec: docs/architecture/features/perceived-performance.md
 * [COMP:app-web/surface-cache]
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

/** How long a value is considered fresh enough to skip revalidation. */
const DEFAULT_STALE_MS = 30_000;

export type CacheEntry<T> = {
  /** Last successful value, if any. Survives a failed revalidation. */
  data: T | undefined;
  /** Error from the most recent attempt, cleared by the next success. */
  error: unknown;
  /** `performance`-independent timestamp of the last successful load. */
  updatedAt: number;
  /** A revalidation (or first load) is in flight. */
  revalidating: boolean;
};

const EMPTY: CacheEntry<never> = {
  data: undefined,
  error: undefined,
  updatedAt: 0,
  revalidating: false,
};

type Listener = () => void;

const store = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
const listeners = new Map<string, Set<Listener>>();

const isBrowser = () => typeof window !== "undefined";

function emit(key: string): void {
  const set = listeners.get(key);
  if (!set) return;
  for (const listener of set) listener();
}

function put(key: string, patch: Partial<CacheEntry<unknown>>): void {
  const current = store.get(key) ?? EMPTY;
  // Replace, never mutate: `useSyncExternalStore` compares snapshots by
  // identity, so an in-place edit would not re-render.
  store.set(key, { ...current, ...patch });
  emit(key);
}

/** Current entry for a key, or the empty entry. Never returns undefined. */
export function readSurfaceCache<T>(key: string | null): CacheEntry<T> {
  if (!key || !isBrowser()) return EMPTY as CacheEntry<T>;
  return (store.get(key) as CacheEntry<T> | undefined) ?? (EMPTY as CacheEntry<T>);
}

/** True when a key has no value, or its value is older than `staleMs`. */
export function isSurfaceCacheStale(
  key: string | null,
  staleMs: number = DEFAULT_STALE_MS,
): boolean {
  const entry = readSurfaceCache(key);
  if (entry.data === undefined) return true;
  return Date.now() - entry.updatedAt > staleMs;
}

/**
 * Run (or join) a load for a key. Resolves with the cached value on success.
 * Concurrent calls for the same key share one request.
 */
export function loadSurfaceCache<T>(
  key: string,
  fetcher: () => Promise<T>,
): Promise<T | undefined> {
  if (!isBrowser()) return Promise.resolve(undefined);
  const existing = inflight.get(key) as Promise<T | undefined> | undefined;
  if (existing) return existing;

  put(key, { revalidating: true });
  const request = fetcher()
    .then((data) => {
      put(key, {
        data,
        error: undefined,
        updatedAt: Date.now(),
        revalidating: false,
      });
      return data;
    })
    .catch((error: unknown) => {
      // Keep the last good value: a failed refresh should not blank a surface
      // the user is reading. Consumers decide whether to surface `error`.
      put(key, { error, revalidating: false });
      return undefined;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, request);
  return request;
}

/**
 * Fire-and-forget warm - what intent-prefetch calls on hover. No-ops when the
 * key is already fresh or already loading, so hovering a rail of links a dozen
 * times costs one request each at most.
 */
export function warmSurfaceCache<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  staleMs: number = DEFAULT_STALE_MS,
): void {
  if (!key || !isBrowser()) return;
  if (inflight.has(key)) return;
  if (!isSurfaceCacheStale(key, staleMs)) return;
  void loadSurfaceCache(key, fetcher);
}

/**
 * Apply a local edit to a cached value - the optimistic-update seam.
 *
 * A surface that mutates a row (mark a task done, drop a deal) used to patch
 * its own `useState` copy. That copy dies on unmount, so leaving and returning
 * showed the pre-edit row until the refetch landed. Writing the patch here
 * instead means the edit is what the next visit paints, and every mounted
 * subscriber sees it at once.
 *
 * No-ops when nothing is cached yet: there is no value to patch, and inventing
 * one would fabricate a list the server never sent.
 */
export function mutateSurfaceCache<T>(
  key: string | null,
  updater: (previous: T) => T,
): void {
  if (!key || !isBrowser()) return;
  const current = store.get(key) as CacheEntry<T> | undefined;
  if (!current || current.data === undefined) return;
  put(key, { data: updater(current.data) });
}

/**
 * Drop cached entries. Pass an exact key, or a key ending in `:` to clear a
 * whole family (`invalidateSurfaceCache('tasks:' + workspaceId)` after a task
 * mutation). Entries are removed rather than marked stale so the next read
 * cannot paint a value the user just changed.
 */
export function invalidateSurfaceCache(prefix: string): void {
  if (!isBrowser()) return;
  const dropped: string[] = [];
  for (const key of store.keys()) {
    if (key === prefix || key.startsWith(prefix)) dropped.push(key);
  }
  for (const key of dropped) {
    store.delete(key);
    emit(key);
  }
}

/** Test seam - drops everything, including subscriptions' cached values. */
export function resetSurfaceCache(): void {
  store.clear();
  inflight.clear();
}

/**
 * Test seam for the subscription half - the hook uses `subscribe` below via
 * `useSyncExternalStore`, which a plain-Node test cannot exercise.
 */
export function subscribeForTest(key: string, listener: Listener): () => void {
  return subscribe(key, listener);
}

function subscribe(key: string, listener: Listener): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

export type UseCachedResource<T> = CacheEntry<T> & {
  /** No value yet AND a load is running - the only state needing a skeleton. */
  loading: boolean;
  /** Force a revalidation (after a mutation, or a manual refresh control). */
  refresh: () => Promise<T | undefined>;
};

/**
 * Subscribe a component to a cached resource.
 *
 * Pass `key: null` to disable (e.g. before the workspace id resolves) - the
 * hook then reports the empty entry and never fetches.
 *
 * `fetcher` is read through a ref, so an inline arrow does not re-trigger
 * loads. The KEY is the dependency: change it to fetch something else.
 */
export function useCachedResource<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  options?: { staleMs?: number },
): UseCachedResource<T> {
  const staleMs = options?.staleMs ?? DEFAULT_STALE_MS;
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const entry = useSyncExternalStore(
    useCallback(
      (listener: Listener) => (key ? subscribe(key, listener) : () => {}),
      [key],
    ),
    useCallback(() => readSurfaceCache<T>(key), [key]),
    useCallback(() => EMPTY as CacheEntry<T>, []),
  );

  // Load when there is nothing fresh to show. Keyed on `entry` as well as
  // `key`, so an `invalidateSurfaceCache` from elsewhere in the app REPAIRS a
  // mounted surface instead of stranding it: invalidation drops the value and
  // notifies, this re-runs and refetches. Without the `entry` dependency an
  // invalidated surface would sit on an empty state until its key changed.
  //
  // It terminates because each branch removes its own trigger: a success makes
  // the entry fresh, an in-flight load is skipped, and a cold-load failure
  // bails out (below) rather than retrying forever against a broken endpoint -
  // that case waits for an explicit `refresh()`, which the surfaces expose as
  // a retry control.
  useEffect(() => {
    if (!key) return;
    if (entry.revalidating) return;
    if (entry.data === undefined && entry.error !== undefined) return;
    if (entry.data !== undefined && !isSurfaceCacheStale(key, staleMs)) return;
    void loadSurfaceCache(key, () => fetcherRef.current());
  }, [key, staleMs, entry]);

  const refresh = useCallback(async () => {
    if (!key) return undefined;
    return loadSurfaceCache<T>(key, () => fetcherRef.current());
  }, [key]);

  return {
    ...entry,
    loading: entry.data === undefined && (entry.revalidating || !entry.error),
    refresh,
  };
}

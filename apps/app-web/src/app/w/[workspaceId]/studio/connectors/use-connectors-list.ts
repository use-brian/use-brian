"use client";

/**
 * The connectors list's data layer - `useCachedResource` over
 * `connectorsCacheKey(workspaceId)` (instant-navigation contract N1-N8).
 *
 * Before this the page held `useState<Connector[]>([])` + `loading=true` and
 * fetched on every mount, so every entry into Studio (whose root redirects
 * here) replaced the whole section with "Loading connectors..." even when the
 * user had left it ten seconds earlier. Now the rail paints from the cached
 * rows on the first frame and revalidates behind the paint; the skeleton is
 * for the cold case only.
 *
 * Kept as a hook beside the page (not inside it) so the cache behaviour is
 * unit-testable with a tiny host component - the page itself is 5,000 lines
 * of forms and cannot practically be rendered in a test.
 *
 * - `connectors`   the rows (empty until the first load settles).
 * - `loading`      no rows yet AND nothing cached - the ONLY skeleton state.
 * - `refresh()`    force a revalidation (after a mutation, on tab-visible).
 * - `mutate(fn)`   apply an optimistic edit to the cached rows (a rename, a
 *                  `connected` flip, a removed row); no-op before the first
 *                  load, when there is no list to patch.
 * - `markStale()`  keep the rows, revalidate behind them (tab-visible /
 *                  bfcache restore: the user may have finished an OAuth
 *                  round trip elsewhere).
 * - `invalidate()` drop the rows so the next read is authoritative (after
 *                  the USER's own destructive mutation, never a signal).
 *
 * There is no connector primitive on the workspace event spine
 * (`lib/surface-cache-invalidation.ts`), so this key has no spine mark; the
 * visibility / pageshow refetch the page already carried stays as the
 * revalidation trigger.
 *
 * Spec: docs/architecture/features/perceived-performance.md
 * [COMP:app-web/studio-connectors-cache]
 */

import { useCallback } from "react";
import { fetchConnectorsList, type Connector } from "@/lib/api/connectors";
import {
  invalidateSurfaceCache,
  markSurfaceCacheStale,
  mutateSurfaceCache,
  useCachedResource,
} from "@/lib/surface-cache";
import { connectorsCacheKey } from "@/lib/surface-prefetch";
import { useLeasedResource } from "@/lib/offline/surface-content-cache";

const EMPTY_ROWS: Connector[] = [];

export type ConnectorsListState = {
  connectors: Connector[];
  /** No rows yet and nothing cached: render the cold skeleton. */
  loading: boolean;
  /** A revalidation is running behind rows already on screen. */
  revalidating: boolean;
  refresh: () => Promise<Connector[] | undefined>;
  mutate: (updater: (previous: Connector[]) => Connector[]) => void;
  markStale: () => void;
  invalidate: () => void;
};

export function useConnectorsList(workspaceId: string): ConnectorsListState {
  const key = workspaceId ? connectorsCacheKey(workspaceId) : null;
  const entry = useLeasedResource<Connector[]>(key, () => fetchConnectorsList(workspaceId));

  const mutate = useCallback(
    (updater: (previous: Connector[]) => Connector[]) => {
      mutateSurfaceCache<Connector[]>(key, updater);
    },
    [key],
  );
  const markStale = useCallback(() => {
    if (key) markSurfaceCacheStale(key);
  }, [key]);
  const invalidate = useCallback(() => {
    if (key) invalidateSurfaceCache(key);
  }, [key]);

  return {
    connectors: entry.data ?? EMPTY_ROWS,
    loading: entry.loading,
    revalidating: entry.revalidating,
    refresh: entry.refresh,
    mutate,
    markStale,
    invalidate,
  };
}

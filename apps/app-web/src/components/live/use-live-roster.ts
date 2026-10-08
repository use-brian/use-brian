"use client";

/**
 * Shared Live-roster loader. Both the persistent sidebar and the route-owned
 * detail pane consume the same endpoint and refresh vocabulary; keeping the
 * lifecycle here prevents the two chrome regions from drifting even though
 * they mount on opposite sides of the workspace layout boundary.
 *
 * The roster lives in the surface cache under `liveRosterCacheKey(wid)`
 * (`live:<wid>:<viewer>`, built in `lib/surface-prefetch.ts` so the Live
 * icon's hover warm and this read are the same string). Two consequences the
 * old `useState` copy could not give: the sidebar mount and the Live surface
 * mount share ONE slot and ONE request instead of fetching twice on every
 * entry, and a revisit paints the last-known roster on its first frame
 * (instant-navigation contract N1). Staleness comes from the one spine map
 * (`lib/surface-cache-invalidation.ts`: `LIVE_REFRESH_EVENT`,
 * `WORKFLOW_REFRESH_EVENT` and `SCHEDULED_JOB_REFRESH_EVENT` all mark
 * `live:<wid>`), so this hook carries no data listener of its own (N3). The
 * window `focus` refetch survives as mark-stale + refresh: a tab returning
 * from the background may have missed the stream, and the roster is a
 * liveness surface where a minute-old copy is the wrong answer.
 *
 * [COMP:app-web/live-app] / [COMP:app-web/live-roster-cache]
 */

import { useEffect } from "react";
import { fetchLiveRoster, liveRosterRemaining, type LiveWorkItem } from "@/lib/api/live";
import { liveRosterCacheKey } from "@/lib/surface-prefetch";
import { markSurfaceCacheStale, useCachedResource } from "@/lib/surface-cache";

export type LiveRosterState = {
  /** The last good roster; empty until the first load lands. */
  items: LiveWorkItem[];
  /** A roster is in hand, or a load has settled (success or failure). Gates
   *  the empty-state copy so a cold cache shows a skeleton, never "Quiet". */
  loaded: boolean;
  /** The most recent load failed. `items` still carry the last good roster,
   *  so a failed revalidation never blanks a roster already on screen. */
  error: boolean;
};

/** Stable empty roster so consumers keyed on identity do not re-run on every render. */
const EMPTY_ITEMS: LiveWorkItem[] = [];

export function useLiveRoster(workspaceId: string): LiveRosterState {
  const key = workspaceId ? liveRosterCacheKey(workspaceId) : null;
  const { data, error, refresh } = useCachedResource<LiveWorkItem[]>(key,
    () => fetchLiveRoster(workspaceId), { expiresInMs: liveRosterRemaining },
  );

  // Focus is the one trigger the spine cannot supply: the stream may have been
  // released while the tab was hidden. Mark stale first so a mount that reads
  // the key meanwhile refetches on its own, then join the refresh (the store
  // dedupes the two into one request).
  useEffect(() => {
    if (!key) return;
    const onFocus = () => {
      markSurfaceCacheStale(key);
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [key, refresh]);

  return {
    items: data ?? EMPTY_ITEMS,
    loaded: data !== undefined || error !== undefined,
    error: error !== undefined,
  };
}

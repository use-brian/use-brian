"use client";

/**
 * Studio -> Assistants data layer (instant-navigation contract N1 / N2 / N3).
 *
 * The rail reads `assistantsCacheKey(workspaceId)` - the same slot Studio ->
 * Channels reads for its attach picker - through `useCachedResource`, so a
 * revisit paints the rows on the first frame. The spine map already marks
 * `assistants:<wid>` stale on `ASSISTANT_REFRESH_EVENT`, so the page carries
 * no refetch listener of its own.
 *
 * The sidebar-cache merge survives: `<AssistantDetail>` edits (rename, icon
 * regenerate, clearance) publish through `setCachedAssistants`, and the
 * listener here writes them into the cached rail rows with
 * `mutateSurfaceCache` instead of a component-local copy that died on
 * unmount.
 *
 * [COMP:app-web/studio-lists-cache]
 */

import { useCallback, useEffect } from "react";
import { listAssistants, type StudioAssistantSummary } from "@/lib/api/studio";
import { onAssistantsChanged, type Assistant } from "@/lib/sidebar-cache";
import { mutateSurfaceCache, useCachedResource } from "@/lib/surface-cache";
import { assistantsCacheKey } from "@/lib/surface-prefetch";
import { useLeasedResource } from "@/lib/offline/surface-content-cache";

/**
 * Merge sidebar-cache rows into the rail list - only the fields the rail
 * renders, only for ids already in the list. Returns `prev` (same identity)
 * when nothing changed so subscribers do not re-render.
 */
export function mergeSidebarAssistants(
  prev: StudioAssistantSummary[],
  cached: Assistant[],
): StudioAssistantSummary[] {
  let changed = false;
  const next = prev.map((a) => {
    const c = cached.find((x) => x.id === a.id);
    if (!c) return a;
    const nextName = c.name ?? a.name;
    const nextIconSeed = typeof c.iconSeed === "number" ? c.iconSeed : a.iconSeed;
    const nextClearance = c.clearance ?? a.clearance;
    if (
      nextName === a.name &&
      nextIconSeed === a.iconSeed &&
      nextClearance === a.clearance
    ) return a;
    changed = true;
    return { ...a, name: nextName, iconSeed: nextIconSeed, clearance: nextClearance };
  });
  return changed ? next : prev;
}

export function useAssistantsData(workspaceId: string | null) {
  const key = workspaceId ? assistantsCacheKey(workspaceId) : null;
  const res = useLeasedResource<StudioAssistantSummary[]>(key, () =>
    listAssistants(workspaceId as string),
  );

  const update = useCallback(
    (updater: (prev: StudioAssistantSummary[]) => StudioAssistantSummary[]) => {
      mutateSurfaceCache<StudioAssistantSummary[]>(key, updater);
    },
    [key],
  );

  useEffect(() => {
    return onAssistantsChanged((cached) => {
      update((prev) => mergeSidebarAssistants(prev, cached));
    });
  }, [update]);

  return {
    /** null until the first list lands (cold) - the skeleton state. */
    assistants: res.data ?? null,
    loading: res.loading,
    revalidating: res.revalidating,
    error: res.data === undefined ? res.error : undefined,
    refresh: res.refresh,
    update,
  };
}

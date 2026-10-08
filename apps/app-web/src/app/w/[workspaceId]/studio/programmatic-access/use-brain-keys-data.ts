"use client";

/**
 * Studio -> Programmatic access data layer (instant-navigation contract N1 /
 * N2 / N7). The six reads the page needs (brain keys, OAuth authorizations,
 * context teams + projects, assistants, capture profiles) already ran in one
 * `Promise.all`; they now land in ONE cache key (`brainKeysCacheKey`) so a
 * revisit paints every section on the first frame, and the page's
 * optimistic edits (revoke, cap change, capture binding) write through
 * `mutateSurfaceCache`.
 *
 * A 403 is the backend's "not an admin" answer, surfaced as `adminOnly`
 * rather than a generic load error. No spine primitive covers keys today,
 * so the key relies on mount revalidation (N3).
 *
 * [COMP:app-web/studio-lists-cache]
 */

import { useCallback } from "react";
import { listBrainKeys, type BrainKey } from "@/lib/api/brain-keys";
import {
  listOAuthAuthorizations,
  type OAuthAuthorization,
} from "@/lib/api/oauth-authorizations";
import {
  listContextProjects,
  listContextTeams,
  type ContextProject,
  type ContextTeam,
} from "@/lib/api/context-scopes";
import { listAssistants, type StudioAssistantSummary } from "@/lib/api/studio";
import { listCaptureProfiles, type CaptureProfile } from "@/lib/api/programmatic-capture";
import { mutateSurfaceCache, useCachedResource } from "@/lib/surface-cache";
import { brainKeysCacheKey } from "@/lib/surface-prefetch";
import { useLeasedResource } from "@/lib/offline/surface-content-cache";

export type BrainKeysSnapshot = {
  keys: BrainKey[];
  authorizations: OAuthAuthorization[];
  teams: ContextTeam[];
  projects: ContextProject[];
  assistants: StudioAssistantSummary[];
  captureProfiles: CaptureProfile[];
};

async function fetchBrainKeysSnapshot(workspaceId: string): Promise<BrainKeysSnapshot> {
  const [keys, authorizations, teams, projects, assistants, captureProfiles] =
    await Promise.all([
      listBrainKeys(workspaceId),
      listOAuthAuthorizations(workspaceId),
      listContextTeams(workspaceId),
      listContextProjects(workspaceId),
      listAssistants(workspaceId),
      listCaptureProfiles(workspaceId),
    ]);
  return { keys, authorizations, teams, projects, assistants, captureProfiles };
}

export function useBrainKeysData(workspaceId: string | null) {
  const key = workspaceId ? brainKeysCacheKey(workspaceId) : null;
  const res = useLeasedResource<BrainKeysSnapshot>(key, () =>
    fetchBrainKeysSnapshot(workspaceId as string),
  );

  const update = useCallback(
    (updater: (prev: BrainKeysSnapshot) => BrainKeysSnapshot) => {
      mutateSurfaceCache<BrainKeysSnapshot>(key, updater);
    },
    [key],
  );

  const errorMessage =
    res.data === undefined && res.error !== undefined
      ? res.error instanceof Error
        ? res.error.message
        : String(res.error)
      : null;

  return {
    /** undefined until the first snapshot lands (cold) - the skeleton state. */
    data: res.data,
    loading: res.loading,
    revalidating: res.revalidating,
    /** The backend 403s non-admins - a targeted message, not a load error. */
    adminOnly: errorMessage !== null && errorMessage.includes("403"),
    error: errorMessage !== null && !errorMessage.includes("403") ? errorMessage : null,
    refresh: res.refresh,
    update,
  };
}

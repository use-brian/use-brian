"use client";

/**
 * Studio -> Knowledge data layer (instant-navigation contract N1 / N2 / N7).
 *
 * Two independent fetches, two keys, both in flight at once: the source list
 * (`kbSourcesCacheKey`, marked stale by the spine on any brain change, since
 * a knowledge sync lands `kb_chunk` rows) and the GitHub connector instances
 * the Add-source modal offers (`kbInstancesCacheKey`, non-fatal: an empty
 * list is the modal's own no-connector state).
 *
 * [COMP:app-web/studio-lists-cache]
 */

import { publicRuntimeConfig } from "@/lib/runtime-public-config";
import type { ConnectorInstanceOption } from "@/components/knowledge/add-source-modal";
import { authFetch } from "@/lib/auth-fetch";
import { useCachedResource } from "@/lib/surface-cache";
import { kbInstancesCacheKey, kbSourcesCacheKey } from "@/lib/surface-prefetch";
import { useLeasedResource } from "@/lib/offline/surface-content-cache";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

export type Sensitivity = "public" | "internal" | "confidential";

export type KnowledgeSource = {
  id: string;
  workspaceId: string;
  sourceType: "github" | "local";
  repo: string;
  branch: string;
  rootPath: string;
  lastSyncedSha: string | null;
  lastSyncedAt: string | null;
  syncError: string | null;
  writeAccess: boolean | null;
  defaultSensitivity: Sensitivity;
  entryCount: number;
};

export type KbSourcesSnapshot = {
  sources: KnowledgeSource[];
  /** Entries in the `source_id IS NULL` pool (the "Manual entries" pseudo-row). */
  manualCount: number;
};

async function fetchKbSources(workspaceId: string): Promise<KbSourcesSnapshot> {
  const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}/knowledge/sources`);
  if (!res.ok) throw new Error(`knowledge sources ${res.status}`);
  const data = (await res.json()) as {
    sources?: KnowledgeSource[];
    manualCount?: number;
  };
  return { sources: data.sources ?? [], manualCount: data.manualCount ?? 0 };
}

async function fetchKbInstances(workspaceId: string): Promise<ConnectorInstanceOption[]> {
  try {
    const res = await authFetch(
      `${API_URL}/api/workspaces/${workspaceId}/knowledge/github/instances`,
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { instances?: ConnectorInstanceOption[] };
    return data.instances ?? [];
  } catch {
    return [];
  }
}

export function useKnowledgeData(workspaceId: string | null) {
  const sourcesKey = workspaceId ? kbSourcesCacheKey(workspaceId) : null;
  const instancesKey = workspaceId ? kbInstancesCacheKey(workspaceId) : null;
  const sources = useLeasedResource<KbSourcesSnapshot>(sourcesKey, () =>
    fetchKbSources(workspaceId as string),
  );
  const instances = useCachedResource<ConnectorInstanceOption[]>(instancesKey, () =>
    fetchKbInstances(workspaceId as string),
  );
  return {
    /** null until the first list lands (cold) - the skeleton state. */
    sources: sources.data?.sources ?? null,
    manualCount: sources.data?.manualCount ?? 0,
    instances: instances.data ?? [],
    loading: sources.loading,
    revalidating: sources.revalidating,
    error: sources.data === undefined ? sources.error : undefined,
    refreshSources: sources.refresh,
  };
}

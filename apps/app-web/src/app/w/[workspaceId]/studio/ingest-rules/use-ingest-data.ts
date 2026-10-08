"use client";

/**
 * Studio -> Ingest rules data layer (instant-navigation contract N1 / N2 / N7).
 *
 * Two keys in parallel: the generic ingest source list plus the providers
 * still available to connect (`ingestSourcesCacheKey`), and the WhatsApp
 * (BYO number) status that joins the rail as a pseudo-row
 * (`whatsappIngestCacheKey`; `null` = never paired). Neither has a spine
 * primitive today, so both rely on mount revalidation (N3) and on the
 * user's own toggles, which write through `mutateSurfaceCache`.
 *
 * [COMP:app-web/studio-lists-cache]
 */

import { publicRuntimeConfig } from "@/lib/runtime-public-config";
import { useCallback } from "react";
import type { EditableRule } from "@/components/ingest/rule-editor";
import { authFetch } from "@/lib/auth-fetch";
import {
  getWhatsappIngest,
  type WhatsappIngestStatus,
} from "@/lib/api/whatsapp-ingest";
import { mutateSurfaceCache, useCachedResource } from "@/lib/surface-cache";
import { ingestSourcesCacheKey, whatsappIngestCacheKey } from "@/lib/surface-prefetch";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

type IngestRule = EditableRule;

/** Signal-density profile - noisy -> event-rich -> high-signal. */
export type IngestNature = "noisy" | "events" | "signal";

export type IngestSource = {
  instanceId: string;
  provider: string;
  /** Ingest engine source key (`slack` / `github` / `calendar` / `fathom`). */
  source: string;
  /** Ownership scope - drives the detail header's scope badge. */
  scope: "user" | "workspace";
  /** Owning workspace's name for workspace-scoped sources; null for user-scoped. */
  workspaceName: string | null;
  /**
   * Visibility tier - members below this clearance never receive the row
   * (server-side filter), so the header badges it for those who can see it.
   */
  sensitivity: "public" | "internal" | "confidential";
  label: string;
  connectedEmail: string | null;
  connected: boolean;
  ingestionEnabled: boolean;
  /** False when this instance's events cannot reach the brain (see ingestUnavailable). */
  ambientIngestSupported?: boolean;
  nature: IngestNature;
  rules: IngestRule[];
};

/** An ingest-capable provider this workspace has not connected yet. */
export type AvailableProvider = {
  provider: string;
  source: string;
  name: string;
  nature: IngestNature;
};

export type IngestSourcesSnapshot = {
  sources: IngestSource[];
  available: AvailableProvider[];
  /** Whether this workspace is the caller’s owned account default. */
  ownedDefault: boolean | undefined;
};

async function fetchIngestSources(workspaceId: string): Promise<IngestSourcesSnapshot> {
  const res = await authFetch(
    `${API_URL}/api/ingest/sources?workspaceId=${encodeURIComponent(workspaceId)}`,
  );
  if (!res.ok) throw new Error(`ingest sources ${res.status}`);
  const data = (await res.json()) as {
    sources: IngestSource[];
    available?: AvailableProvider[];
    ownedDefault?: boolean;
  };
  return {
    sources: data.sources ?? [],
    available: data.available ?? [],
    ownedDefault: typeof data.ownedDefault === "boolean" ? data.ownedDefault : undefined,
  };
}

/** `null` = never paired (no row) or the probe failed; both mean no rail row. */
async function fetchWhatsappIngest(workspaceId: string): Promise<WhatsappIngestStatus | null> {
  try {
    return await getWhatsappIngest(workspaceId);
  } catch {
    return null;
  }
}

export function useIngestData(workspaceId: string | null) {
  const sourcesKey = workspaceId ? ingestSourcesCacheKey(workspaceId) : null;
  const waKey = workspaceId ? whatsappIngestCacheKey(workspaceId) : null;
  const sources = useCachedResource<IngestSourcesSnapshot>(sourcesKey, () =>
    fetchIngestSources(workspaceId as string),
  );
  const wa = useCachedResource<WhatsappIngestStatus | null>(waKey, () =>
    fetchWhatsappIngest(workspaceId as string),
  );

  const updateSources = useCallback(
    (updater: (prev: IngestSource[]) => IngestSource[]) => {
      mutateSurfaceCache<IngestSourcesSnapshot>(sourcesKey, (prev) => ({
        ...prev,
        sources: updater(prev.sources),
      }));
    },
    [sourcesKey],
  );

  return {
    /** null until the first list lands (cold) - the skeleton state. */
    sources: sources.data?.sources ?? null,
    available: sources.data?.available ?? [],
    ownedDefault: sources.data?.ownedDefault,
    loading: sources.loading,
    revalidating: sources.revalidating,
    error: sources.data === undefined ? sources.error : undefined,
    refresh: sources.refresh,
    updateSources,
    waStatus: wa.data ?? null,
  };
}

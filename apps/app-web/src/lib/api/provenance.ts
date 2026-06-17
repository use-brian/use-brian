/**
 * SDK for the provenance side-sheet (app-web).
 *
 * Ported verbatim from `apps/web/src/lib/api/provenance.ts` as part of the
 * brain surface migration (docs/plans/doc-web-app-consolidation.md
 * §5a). Backed by the retrieval `provenance` tool + episode store (see
 * docs/architecture/brain/retrieval-layer.md). Imports
 * (`@/lib/auth-fetch`, `@/lib/api/brain`) already resolve in app-web.
 *
 * Backend gaps:
 * - `GET /api/episodes/[id]` is not yet mounted; until then,
 *   `getEpisode()` returns null and the sheet renders a partial state
 *   (cited row + authorship only, without the source episode summary).
 */

import { authFetch } from "@/lib/auth-fetch";
import type { Sensitivity } from "@/lib/api/brain";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type ProvenanceSourceKind =
  | "memory"
  | "kb_chunk"
  | "kb_entry"
  | "entity"
  | "task"
  | "file"
  | "deal"
  | "contact"
  | "company";

export type ProvenanceRow = {
  id: string;
  kind: ProvenanceSourceKind;
  title: string;
  body?: string | null;
  sensitivity: Sensitivity;
  authorship: {
    createdByUserId: string | null;
    createdByAssistantId: string | null;
    sourceEpisodeId: string | null;
    createdAt: string;
  };
  validFrom?: string | null;
  validTo?: string | null;
  /**
   * If this row was consolidated from multiple episodes (e.g. a memory
   * synthesized from N email threads), the constituent episode IDs.
   * The sheet renders "Based on N observations" with an inline expander.
   */
  derivedFromEpisodeIds?: string[];
};

export type Episode = {
  id: string;
  sourceKind: string;
  occurredAt: string;
  ingestedAt: string;
  summary: string | null;
  sensitivity: Sensitivity;
};

/**
 * Fetch a derived row by id+kind for the provenance sheet. The sheet
 * calls this when opened from a citation pill or a Brain row.
 *
 * Backend: dispatches to the appropriate per-kind store
 * (memory-store / kb-store / crm-store / etc.) via a future
 * `/api/provenance/[kind]/[id]` route. Until that lands, callers should
 * pass the already-loaded row to the sheet directly to avoid a network
 * round-trip.
 */
export async function getProvenanceRow(
  kind: ProvenanceSourceKind,
  id: string,
  workspaceId: string,
): Promise<ProvenanceRow | null> {
  const q = new URLSearchParams({ workspaceId });
  const res = await authFetch(
    `${API_URL}/api/provenance/${encodeURIComponent(kind)}/${encodeURIComponent(id)}?${q.toString()}`,
  );
  if (!res.ok) return null;
  return (await res.json()) as ProvenanceRow;
}

/**
 * Fetch a single episode for the side-sheet's source-episode card.
 *
 * Backend gap: HTTP route not yet mounted. Returns null until then.
 */
export async function getEpisode(
  episodeId: string,
  workspaceId: string,
): Promise<Episode | null> {
  const q = new URLSearchParams({ workspaceId });
  const res = await authFetch(
    `${API_URL}/api/episodes/${encodeURIComponent(episodeId)}?${q.toString()}`,
  );
  if (!res.ok) return null;
  return (await res.json()) as Episode;
}

/**
 * Retract a derived row. Maps to the corrections flow in
 * docs/architecture/brain/corrections.md.
 *
 * Behaviour depends on row kind: memory/CRM rows set `valid_to=now()`;
 * KB rows from synced sources are read-only and surface as ✗ in the
 * verb-availability matrix.
 */
export async function retractRow(
  kind: ProvenanceSourceKind,
  id: string,
  workspaceId: string,
  reason?: string,
): Promise<{ ok: boolean; blastRadius?: { rollupsAffected: number } }> {
  const res = await authFetch(
    `${API_URL}/api/provenance/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/retract`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, reason }),
    },
  );
  if (!res.ok) return { ok: false };
  return (await res.json()) as { ok: boolean; blastRadius?: { rollupsAffected: number } };
}

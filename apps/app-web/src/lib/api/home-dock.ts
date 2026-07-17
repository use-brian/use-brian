/**
 * Home dock SDK (app-web) — the assistant-curated "Suggested for you" surface.
 *
 *   GET  /api/home-dock?workspaceId=X          → the resolved dock
 *   POST /api/home-dock/refresh?workspaceId=X  → re-curate, then return it
 *
 * The backend already merges the assistant's layout artifact over live signals
 * (mergeHomeDock) and drops dead cards, so the frontend renders `ResolvedDock`
 * directly. The wire type mirrors `ResolvedDock` in `@use-brian/core`
 * (app-web deliberately does not depend on core — same reason the views SDK is
 * duplicated). See docs/architecture/features/home-dock.md.
 */
import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type ResolvedNeed = {
  kind:
    | "brain_review"
    | "approvals"
    | "autopilot"
    | "connector_attention"
    | "workflow_attention";
  count: number;
  caption: string | null;
};

export type ResolvedDock = {
  /** 'assistant' when a curation artifact drove the ordering, else 'default'. */
  source: "assistant" | "default";
  generatedAt: string | null;
  note: string | null;
  needsYou: ResolvedNeed[];
  pickUp: { id: string; name: string; updatedAt: string }[];
  comingUp: { id: string; name: string; nextRunAt: string }[];
  brain: {
    entryCount: number;
    growth7d: number;
    /** Daily new-entry counts, oldest first. Optional: a pre-sparkline API
     *  response simply renders the flat fallback line. */
    sparkline?: number[];
    hasConnector: boolean;
  };
};

/**
 * Total items across the "Needs you" cards — the sidebar badge number (every
 * live needs-you count summed as one inbox-style number). The merge already
 * drops zero-count cards server-side; the clamp just keeps a buggy negative
 * signal from eating the others.
 */
export function needsYouTotal(dock: ResolvedDock | null): number {
  if (!dock) return 0;
  return dock.needsYou.reduce((sum, n) => sum + Math.max(0, n.count), 0);
}

/** The resolved dock, or null on error (the caller renders a quiet fallback). */
export async function fetchHomeDock(workspaceId: string): Promise<ResolvedDock | null> {
  try {
    const res = await authFetch(
      `${API_URL}/api/home-dock?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { dock?: ResolvedDock };
    return data.dock ?? null;
  } catch {
    return null;
  }
}

/** Run the primary assistant once to re-curate, returning the refreshed dock. */
export async function refreshHomeDock(workspaceId: string): Promise<ResolvedDock | null> {
  try {
    const res = await authFetch(
      `${API_URL}/api/home-dock/refresh?workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: "POST" },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { dock?: ResolvedDock };
    return data.dock ?? null;
  } catch {
    return null;
  }
}

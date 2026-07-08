/**
 * SDK for the CL-9 KB-gap candidate surface (app-web).
 *
 * Ported from `apps/web/src/lib/api/kb-gaps.ts` as part of the app
 * consolidation (docs/plans/doc-web-app-consolidation.md §5a). Identical
 * wire contract — wraps `authFetch` with typed signatures matching the routes
 * in `packages/api/src/routes/kb-gaps.ts`. Kept as its own file (not imported
 * from apps/web) per the same convention as `lib/api/views.ts`.
 *
 * Endpoint summary:
 *   GET    /api/kb-gaps?workspaceId=X     — list open candidates
 *   POST   /api/kb-gaps/:id/dismiss       — mark dismissed
 *   POST   /api/kb-gaps/:id/draft         — mark drafted
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type KbGapCandidate = {
  id: string;
  workspaceId: string;
  patternSummary: string;
  evidenceMissIds: string[];
  occurrences: number;
  distinctSessions: number;
  dismissedAt: string | null;
  dismissedByUserId: string | null;
  draftedAt: string | null;
  draftedByUserId: string | null;
  createdAt: string;
};

export type ListKbGapsResult = {
  candidates: KbGapCandidate[];
  count: number;
};

/** List open candidates for the given workspace. Returns an empty result on
 *  any non-200 response — the UI treats "we couldn't fetch" the same as
 *  "nothing pending" (no surface to surface an error). */
export async function listKbGaps(workspaceId: string): Promise<ListKbGapsResult> {
  const res = await authFetch(
    `${API_URL}/api/kb-gaps?workspaceId=${encodeURIComponent(workspaceId)}`,
  );
  if (!res.ok) return { candidates: [], count: 0 };
  const data = (await res.json()) as Partial<ListKbGapsResult>;
  return {
    candidates: Array.isArray(data.candidates) ? data.candidates : [],
    count: typeof data.count === "number" ? data.count : 0,
  };
}

/** Dismiss a candidate. Idempotent — already-dismissed candidates return
 *  `ok: false`. */
export async function dismissKbGap(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await authFetch(
    `${API_URL}/api/kb-gaps/${encodeURIComponent(id)}/dismiss`,
    { method: "POST" },
  );
  if (res.ok) return { ok: true };
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: data.error ?? `Dismiss failed (${res.status})` };
}

/** Mark a candidate as drafted (caller will open the editor next). */
export async function markKbGapDrafted(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await authFetch(
    `${API_URL}/api/kb-gaps/${encodeURIComponent(id)}/draft`,
    { method: "POST" },
  );
  if (res.ok) return { ok: true };
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: data.error ?? `Draft failed (${res.status})` };
}

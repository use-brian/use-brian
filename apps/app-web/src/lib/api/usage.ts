/**
 * Usage SDK (app-web) — workspace credit allowance.
 *
 * Ported from the fetch logic in
 * `apps/web/src/app/(app)/settings/usage/page.tsx` (app consolidation §5a —
 * Settings). app-web's settings live in the SettingsModal, so the page's
 * inline `authFetch` is extracted into this SDK, same convention as
 * `lib/api/studio.ts` / `lib/api/approvals.ts`.
 *
 * Billing is per-workspace (migration 143), so usage is scoped to the active
 * workspace: `GET /api/usage?workspace_id=`. The wire contract matches
 * apps/web — `{ plan, credits: { used, cap, percent, rawPercent, resetsAt } }`.
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type Credits = {
  used: number;
  /** `null` = uncapped (enterprise). */
  cap: number | null;
  percent: number;
  rawPercent: number;
  /** Billing-period END (a date, weeks away) — not an hour countdown. */
  resetsAt: string | null;
};

export type UsageResponse = {
  plan?: string;
  percent?: number;
  rawPercent?: number;
  credits?: Credits;
};

export const EMPTY_CREDITS: Credits = {
  used: 0,
  cap: null,
  percent: 0,
  rawPercent: 0,
  resetsAt: null,
};

/** Fetch the active workspace's usage. Returns `null` on any non-OK response. */
export async function getUsage(workspaceId: string): Promise<UsageResponse | null> {
  const res = await authFetch(
    `${API_URL}/api/usage?workspace_id=${encodeURIComponent(workspaceId)}`,
  );
  if (!res.ok) return null;
  return (await res.json()) as UsageResponse;
}

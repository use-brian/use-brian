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
  /** Prepaid extra-usage pack credits purchased this billing period —
   *  the effective allowance is `cap + extra`. Absent on older servers. */
  extra?: number;
  percent: number;
  rawPercent: number;
  /** Billing-period END (a date, weeks away) — not an hour countdown. */
  resetsAt: string | null;
};

export type UsageResponse = {
  plan?: string;
  /** `plan === 'free'` (no active plan) and the workspace never trialed —
   *  drives the trial CTA on the plan gate and the marketing plans page. */
  trialEligible?: boolean;
  percent?: number;
  rawPercent?: number;
  credits?: Credits;
};

export const EMPTY_CREDITS: Credits = {
  used: 0,
  cap: null,
  extra: 0,
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

/**
 * Start a Stripe Checkout for one prepaid extra-usage pack
 * ($100 / 2,500 credits, current billing cycle only). Owner-only on the
 * server (`POST /api/billing/extra-usage/checkout`); resolves to the
 * checkout URL, or a typed error code the caller maps to dictionary copy.
 */
export async function startExtraUsageCheckout(
  workspaceId: string,
): Promise<{ url: string } | { error: string }> {
  const res = await authFetch(`${API_URL}/api/billing/extra-usage/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace_id: workspaceId }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    url?: string;
    error?: string;
  };
  if (res.ok && data.url) return { url: data.url };
  return { error: data.error ?? `http_${res.status}` };
}

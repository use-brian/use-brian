// [COMP:app-web/plan-gate] — see docs/architecture/platform/cost-and-pricing.md
// → "No free plan: the hosted paid gate (2026-07-10)"
//
// Pure decision logic for the workspace plan gate, split out of the overlay
// component so it is unit-testable without a DOM. The server enforces the
// real block (the closed credit gate rejects every turn for a no-plan
// workspace); this decides when the explanatory overlay shows.

/**
 * The gate applies on the HOSTED edition when the workspace has no active
 * plan. `'free'` stopped being a plan on 2026-07-10 — it is the
 * "no active plan" state (fresh signup before the trial, post-trial,
 * post-cancel). OSS self-host has no plans at all, so the gate never
 * applies there. An unknown / not-yet-loaded plan (`null` / `undefined`)
 * does NOT gate — the overlay must never flash on a paid workspace while
 * the usage fetch is in flight.
 */
export function planGateApplies(
  edition: "oss" | "hosted",
  plan: string | null | undefined,
): boolean {
  return edition === "hosted" && plan === "free";
}

/**
 * Session-storage key for the per-workspace "Continue browsing" dismissal.
 * Session-scoped on purpose: browsing stays reachable, but the gate
 * re-presents on the next visit — compute is still blocked server-side
 * either way.
 */
export function planGateDismissKey(workspaceId: string): string {
  return `plan-gate-dismissed:${workspaceId}`;
}

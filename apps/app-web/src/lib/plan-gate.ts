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

export function modelTierPlanGateApplies(
  edition: "oss" | "hosted",
  plan: string | null | undefined,
  tier: "standard" | "pro" | "max",
): boolean {
  if (edition === "oss" || tier === "standard") return false;
  if (tier === "pro") return plan === "free";
  return plan === "free" || plan === "pro";
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

/**
 * The trial welcome returns through the legacy `/home` entry because the
 * billing service owns the final URL and app-web itself is workspace-scoped.
 * Both the marketing proxy and app-web's legacy resolver understand `/home`,
 * so the Stripe round-trip lands back in the user's workspace instead of the
 * billing modal.
 */
export const PLAN_GATE_TRIAL_RETURN_PATH = "/home";

export function planGateTrialCheckoutBody(workspaceId: string): {
  workspace_id: string;
  plan: "pro";
  returnTo: typeof PLAN_GATE_TRIAL_RETURN_PATH;
} {
  return {
    workspace_id: workspaceId,
    plan: "pro",
    returnTo: PLAN_GATE_TRIAL_RETURN_PATH,
  };
}

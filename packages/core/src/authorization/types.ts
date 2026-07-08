/**
 * Capability grant — policy attached to an assistant that unlocks tools marked
 * with a matching `requiresCapability`. Grants are soft-deleted (revoked) so
 * the history survives. A grant is "active" while `revokedAt` is null.
 *
 * Store impl lives in `packages/api/src/db/capability-store.ts`. Core declares
 * the interface only — no `pg` import here.
 */
export type CapabilityGrant = {
  id: string
  assistantId: string
  capability: string
  grantedByUserId: string
  grantedAt: Date
  revokedAt: Date | null
  revokedByUserId: string | null
  reason: string | null
}

export type ActiveGrantRow = CapabilityGrant & {
  assistantName: string
  ownerEmail: string | null
}

/**
 * The control-plane capability for the agent-facing surfaces (brain MCP /
 * assistant MCP) — see docs/architecture/integrations/agent-capability-surface.md §5.
 * Tier-2 control-plane write tools carry `requiresCapability:
 * CONFIGURE_CAPABILITY`; an agent surface exposes them only when the bound
 * assistant holds an active grant. Off by default, granted by a workspace
 * owner/admin via the assistant-detail capability toggles, and NEVER
 * self-grantable — no tool exists that writes `assistant_capabilities`
 * (the escalation cycle-breaker).
 */
export const CONFIGURE_CAPABILITY = 'configure'

/**
 * The analytics-query capability — unlocks the read-only, parameterized
 * lens over the raw `analytics_events` log (event-name discovery,
 * grouped aggregation, and capped raw drill-down). Tools carry
 * `requiresCapability: ANALYTICS_QUERY_CAPABILITY`; an assistant sees them
 * only when it holds an active grant. Granted by an operator via the admin
 * Capability Grants dashboard, never self-grantable, and never granted to a
 * shared/public-traffic assistant (the sharing hard-lock blocks it). It is
 * orthogonal to `product_sentiment` (the curated cross-table metric lens):
 * grant both to give an assistant the full analytics surface. See
 * docs/architecture/platform/capability-grants.md.
 */
export const ANALYTICS_QUERY_CAPABILITY = 'analytics_query'

export type CapabilityStore = {
  /** Active capability names for one assistant. Used by the per-turn tool-list filter. */
  listActive(assistantId: string): Promise<string[]>
  /** True if the assistant has any active grant. Used by the sharing hard-lock. */
  hasActive(assistantId: string): Promise<boolean>

  /** Admin: all active grants, joined with assistant name + owner email. */
  listAllActive(): Promise<ActiveGrantRow[]>
  /** Admin: full grant+revoke timeline for one assistant. */
  listHistoryForAssistant(assistantId: string): Promise<CapabilityGrant[]>
  /** Admin: create a new grant. Rejects if an active grant for the same (assistant, capability) already exists. */
  grant(params: {
    assistantId: string
    capability: string
    grantedByUserId: string
    reason?: string
  }): Promise<CapabilityGrant>
  /** Admin: revoke by grant id. Returns null if the grant does not exist or is already revoked. */
  revoke(params: {
    grantId: string
    revokedByUserId: string
    reason?: string
  }): Promise<CapabilityGrant | null>
}

/** Thrown by `CapabilityStore.grant()` when an active grant already exists. */
export class DuplicateGrantError extends Error {
  constructor(assistantId: string, capability: string) {
    super(`Assistant ${assistantId} already has an active grant for '${capability}'.`)
    this.name = 'DuplicateGrantError'
  }
}

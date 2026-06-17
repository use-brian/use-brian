/**
 * Billing-party resolver — who pays for a given turn (ownership resolution).
 *
 * This is OPEN: despite the "billing" name it is pure assistant-ownership
 * resolution over `workspaces.owner_user_id` (a core membership column, not a
 * Stripe/credit concern), and it imports only the open DB `query`. It lives
 * here — not under the closed `billing/` folder — so the OPEN consumers
 * (`routes/public-api.ts`, `inter-assistant/executor.ts`) can import it without
 * a leak. The closed `billing/resolve-billing.ts` re-exports it for the closed
 * channel routes. See docs/plans/oss-local-brain-wedge.md §12.5.
 *
 * Single determining rule:
 *
 *   If the turn has a resolved chatter user_id → charge the chatter.
 *   If the turn is inter-assistant inbound → charge the initiator's billing
 *     context (recurse: chatter-if-any from A's side, else A's team owner,
 *     else A's personal owner).
 *   Otherwise (cron, distribution inbound, shadow sender) → charge the
 *     receiving assistant's team owner (team assistant) or personal owner
 *     (personal assistant).
 *
 * After the ownership XOR flip (migration 089), `assistants.owner_user_id`
 * is NULL for team-owned assistants, so the receiving-assistant branch
 * must always consult `workspaces.owner_user_id` when `workspaceId` is set.
 *
 * Component tag: [COMP:billing/resolver].
 */

import { query } from './db/client.js'

export type AssistantBillingIdentity = {
  id: string
  ownerUserId: string | null
  workspaceId: string | null
}

export type BillingContext = {
  /** The human chatter behind this turn, if any. */
  chatterUserId?: string | null
  /** If this turn was triggered by another assistant (ask-assistant), carry the initiator's own billing context. */
  initiatorContext?: BillingContext | null
  /** The assistant whose turn is executing. */
  receivingAssistant: AssistantBillingIdentity
}

/**
 * Resolve which user's account bears the cost of the given assistant's
 * turn. System-level lookup — called inside `recordUsage` /
 * `checkUsageBudget` hot paths.
 */
export async function billingPartyForAssistant(a: AssistantBillingIdentity): Promise<string> {
  if (a.workspaceId) {
    const result = await query<{ owner_user_id: string }>(
      `SELECT owner_user_id FROM workspaces WHERE id = $1`,
      [a.workspaceId],
    )
    const ownerUserId = result.rows[0]?.owner_user_id
    if (!ownerUserId) {
      throw new Error(
        `billingPartyForAssistant: team ${a.workspaceId} on assistant ${a.id} not found`,
      )
    }
    return ownerUserId
  }
  if (a.ownerUserId) return a.ownerUserId
  throw new Error(
    `billingPartyForAssistant: assistant ${a.id} has neither team nor owner`,
  )
}

/**
 * Walk the full billing rule and return the user_id that should be
 * charged. Uses the caller-pays semantics for inter-assistant: the
 * initiator's own billing context bubbles through, so a human-initiated
 * call on A that reaches out to B bills the human, not A's owner.
 */
export async function resolveBillingUserId(ctx: BillingContext): Promise<string> {
  if (ctx.chatterUserId) return ctx.chatterUserId
  if (ctx.initiatorContext) return resolveBillingUserId(ctx.initiatorContext)
  return billingPartyForAssistant(ctx.receivingAssistant)
}

/**
 * Who pays for a turn, and who acted (unified-sessions D2, L18).
 *
 *   - A personal session bills its human: the turn's actor.
 *   - A workspace session (a web room, a draft, an anchored thread, a
 *     provider group) bills the WORKSPACE pool: the workspace billing party
 *     (`billingPartyForAssistant`), with the addresser recorded as the actor.
 *     Several people share the conversation, so no one member's allowance
 *     should carry it.
 *   - A machine lane names its payer explicitly (A2A caller-pays, workflow
 *     owner); the kernel takes it as given.
 *
 * The actor is always recorded, so per-member analytics are unchanged.
 *
 * [COMP:api/turn-kernel]
 */
import { billingPartyForAssistant, type AssistantBillingIdentity } from '../billing-party.js'
import type { SessionPolicy } from '../session-kind.js'

export type TurnBilling = {
  /** The account charged (`usage.user_id`). */
  payerUserId: string
  /** The human who drove the turn (`usage.actor_user_id`), when there is one. */
  actorUserId: string | null
}

export async function resolveTurnBilling(params: {
  policy: Pick<SessionPolicy, 'billing'>
  assistant: AssistantBillingIdentity
  actorUserId: string | null
  /** A machine lane's explicit payer; wins over the policy. */
  explicitPayerUserId?: string
  /** Test seam. */
  resolveWorkspaceParty?: (assistant: AssistantBillingIdentity) => Promise<string>
}): Promise<TurnBilling> {
  if (params.explicitPayerUserId) {
    return { payerUserId: params.explicitPayerUserId, actorUserId: params.actorUserId }
  }
  if (params.policy.billing === 'workspace' && params.assistant.workspaceId) {
    const party = await (params.resolveWorkspaceParty ?? billingPartyForAssistant)(params.assistant)
    return { payerUserId: party, actorUserId: params.actorUserId }
  }
  if (params.actorUserId) return { payerUserId: params.actorUserId, actorUserId: params.actorUserId }
  return {
    payerUserId: await (params.resolveWorkspaceParty ?? billingPartyForAssistant)(params.assistant),
    actorUserId: null,
  }
}

/**
 * Client-principal accrual — what a public-API turn leaves behind about the
 * external client it served.
 *
 * Two outputs, both derived from the resolved shadow user rather than from the
 * request shape:
 *
 * 1. **The compartment stamp.** `client:<externalUserId>`, unioned into the
 *    turn's `assistantDefaultCompartments` so every CRM / memory / task /
 *    knowledge write on the turn inherits it through the existing
 *    `unionCompartments(accumulator, assistantDefaultCompartments)` path. This
 *    is the client-vs-client wall (decision D12): a client's effective read
 *    grant is the empty set, and `[] ⊉ {client:x}`, so a compartmented row is
 *    unreadable by every client including the one it describes, while a team
 *    member on a universe grant reads it normally.
 * 2. **The contact record.** On an identified turn, a `person` entity in the
 *    D11 shape (`user_id` NULL + `internal`) plus a `linked_identities`
 *    pairing row, so the team sees who the client is and what they taught the
 *    brain.
 *
 * A resolved **teammate** accrues neither. A public-API turn whose
 * `claims.email` matches an existing platform account resolves to that real
 * member, and that human is a teammate arriving through an odd door — see
 * `isExternalPrincipal`.
 *
 * Spec: `docs/architecture/features/public-api.md` → "Client accrual".
 * Design note: `docs/plans/client-principal.md` §8, §8.1.
 *
 * Component tag: [COMP:api/client-accrual].
 */

import type { AnalyticsLogger } from '@use-brian/core'
import { clientCompartment, sanitize as sanitizeAnalytics } from '@use-brian/core'
import { getOrCreateClientContactEntity } from '../db/entities-store.js'
import { isExternalPrincipal } from '../db/external-principal.js'
import { createLinkedIdentityStore } from '../db/linked-identity-store.js'

const linkedIdentityStore = createLinkedIdentityStore()

export type ClientAccrualInput = {
  user: { id: string; authProvider: string; authProviderId: string; name: string | null }
  workspaceId: string | null
  assistantId: string
  /** `api:<keyId>` or `chatlink:<linkId>` — the credential that minted the shadow. */
  identityNamespace: string
  externalUserId: string
  externalUserName?: string
  /** Collapsed `claims.email` / `externalUserEmail`. Turn-scoped, never authority. */
  email?: string | null
  orgId?: string | null
  identified: boolean
  analytics?: AnalyticsLogger
  ownerId: string
}

export type ClientAccrual = {
  /**
   * Compartments to union into the turn's write stamp. Empty for a teammate,
   * so a non-client turn is byte-identical to pre-Phase-3 behavior.
   */
  compartments: string[]
  /** The client's contact entity, when one was accrued this turn. */
  contactEntityId: string | null
}

const NONE: ClientAccrual = { compartments: [], contactEntityId: null }

/**
 * Resolve what this turn accrues. Never throws: accrual is bookkeeping beside
 * the turn, so a failure degrades to "no accrual" rather than failing a
 * customer's question. The compartment stamp is computed before any I/O, so a
 * store outage cannot silently drop the isolation stamp while leaving the
 * writes to land uncompartmented.
 */
export async function accrueClientPrincipal(input: ClientAccrualInput): Promise<ClientAccrual> {
  if (!isExternalPrincipal(input.user)) return NONE

  const compartments = [clientCompartment(input.externalUserId)]

  // Tier 2 shadows are anonymous by construction: there is no asserted person
  // to accrue a contact for. They still carry the compartment, so anything
  // they do cause to be written stays walled off from other clients.
  if (!input.identified || !input.workspaceId) return { compartments, contactEntityId: null }

  try {
    const contact = await getOrCreateClientContactEntity({
      userId: input.user.id,
      workspaceId: input.workspaceId,
      displayName: input.externalUserName ?? input.user.name ?? input.email ?? input.externalUserId,
      externalUserId: input.externalUserId,
      email: input.email ?? null,
    })

    await recordPairing(input, contact.id)

    return { compartments, contactEntityId: contact.id }
  } catch (err) {
    // Keep the stamp. Losing the contact row costs the team a CRM record;
    // losing the compartment would cost a client their isolation.
    console.error('[client-accrual] contact accrual failed:', err)
    return { compartments, contactEntityId: null }
  }
}

/**
 * Record (or refresh) the shadow-user ↔ external-identity pairing.
 *
 * The pairing is **identity, never authority** (§2.3): it powers CRM linking
 * and drift detection, and is never read back as a claim. A customer who
 * signed in once in March and browses logged out in June must not have auth
 * power back-filled from this row, which is why nothing on the turn path reads
 * it to decide anything.
 *
 * Steady state is one read and no write: the row is only touched when it is
 * absent or has actually changed.
 */
async function recordPairing(input: ClientAccrualInput, entityId: string): Promise<void> {
  const provider = input.identityNamespace
  const providerId = input.externalUserId
  const existing = await linkedIdentityStore.findByProvider(provider, providerId)

  const priorEmail = typeof existing?.metadata?.email === 'string' ? existing.metadata.email : null
  const email = input.email ?? null

  if (existing) {
    // Drift: one external id resolving to two people means the consumer's own
    // code paths disagree about who they authenticated. Surfaced, not enforced
    // — the wire-level guard (claims.email vs externalUserEmail) already
    // rejects the within-request form, and rejecting the stored form would
    // fail live customer turns on the strength of a historical row.
    const userDrift = existing.userId !== input.user.id
    const emailDrift = !!priorEmail && !!email && priorEmail !== email
    if (userDrift || emailDrift) {
      input.analytics?.logEvent({
        userId: input.ownerId,
        actorUserId: input.user.id,
        assistantId: input.assistantId,
        eventName: 'client_identity_drift',
        channelType: 'api',
        metadata: { provider: sanitizeAnalytics(provider), userDrift, emailDrift },
      })
    }
    const unchanged =
      !userDrift &&
      !emailDrift &&
      priorEmail === email &&
      existing.metadata?.entityId === entityId &&
      (existing.metadata?.orgId ?? null) === (input.orgId ?? null)
    if (unchanged) return
  }

  await linkedIdentityStore.upsert({
    userId: input.user.id,
    provider,
    providerId,
    metadata: {
      entityId,
      ...(email ? { email } : {}),
      ...(input.orgId ? { orgId: input.orgId } : {}),
    },
  })
}

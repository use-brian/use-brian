/** Provider grant authority and period replay. [COMP:crm/entitlement-periods] */
import type { PoolClient } from 'pg'
import type { AssociationActor } from '@use-brian/core/association/domain.js'
import { CrmOperationsError, crmOperationsSha256 } from '@use-brian/core/crm/operations-types.js'

type PeriodInput = {
  contactId: unknown; planId: unknown; status: unknown; startsAt: unknown; endsAt?: unknown;
  renewalMode: unknown; provider?: unknown; providerEntitlementId?: unknown;
  providerPeriodId?: unknown; predecessorId?: unknown;
}

export function requireProviderEntitlementActor(actor: AssociationActor, provider: string, authenticatedProvider?: string): void {
  if (!['brain_key', 'api_key', 'oauth_token', 'integration_key', 'provider', 'system_job'].includes(actor.credentialKind)
    || (actor.credentialKind === 'system_job' && !/^entitlement_reconciliation:[a-f0-9-]{36}$/i.test(actor.credentialId))
    || (actor.credentialKind === 'provider' && authenticatedProvider !== undefined && authenticatedProvider !== provider)) {
    throw new CrmOperationsError('not_authorized', 'Provider-backed entitlement changes require verified backend authority.')
  }
}

/** The object lock also serializes legacy and new period creation. */
export async function prepareProviderEntitlementPeriod(client: PoolClient, workspaceId: string, input: PeriodInput): Promise<{ requestHash: string; existingId?: string } | null> {
  if (!input.provider) return null
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('crm-provider-period:'||$1::uuid::text||':'||$2::text||':'||$3::text,0))", [workspaceId, input.provider, input.providerEntitlementId])
  if (!input.providerPeriodId) return null
  const instants = (await client.query<{ starts: string; ends: string }>(
    `SELECT to_char($1::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') starts,
      to_char($2::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') ends`,
    [input.startsAt, input.endsAt],
  )).rows[0]
  // Transport idempotency keys do not give one provider period two identities.
  const requestHash = crmOperationsSha256({ contactId: input.contactId, planId: input.planId,
    status: input.status, startsAt: instants.starts,
    endsAt: instants.ends,
    renewalMode: input.renewalMode, provider: input.provider, providerEntitlementId: input.providerEntitlementId,
    providerPeriodId: input.providerPeriodId, predecessorId: input.predecessorId ?? null })
  const existing = (await client.query<{ id: string; request_fingerprint: string }>(
    `SELECT id,request_fingerprint FROM association_memberships WHERE workspace_id=$1 AND provider=$2
     AND provider_membership_id=$3 AND provider_period_id=$4`,
    [workspaceId, input.provider, input.providerEntitlementId, input.providerPeriodId],
  )).rows[0]
  if (existing) {
    if (existing.request_fingerprint !== requestHash) throw new CrmOperationsError('idempotency_conflict', 'Provider period already records a different entitlement request.')
    return { requestHash, existingId: existing.id }
  }
  const previous = (await client.query<{ id: string; status: string; contact_id: string; plan_id: string; precedes: boolean }>(
    `SELECT id,status,contact_id,plan_id,starts_at<$4::timestamptz AS precedes FROM association_memberships m
     WHERE workspace_id=$1 AND provider=$2 AND provider_membership_id=$3
       AND NOT EXISTS(SELECT 1 FROM association_memberships child WHERE child.workspace_id=$1 AND child.predecessor_id=m.id)
     ORDER BY id FOR UPDATE`, [workspaceId, input.provider, input.providerEntitlementId, input.startsAt],
  )).rows
  const predecessor = previous[0]
  if (previous.length > 1 || (predecessor && (predecessor.id !== input.predecessorId
    || !['expired', 'cancelled'].includes(predecessor.status) || predecessor.contact_id !== input.contactId
    || predecessor.plan_id !== input.planId || !predecessor.precedes))
    || (!predecessor && input.predecessorId)) {
    throw new CrmOperationsError('conflict', 'A renewed provider period requires the current terminal predecessor; extend active periods in place.', { reason: 'provider_period_predecessor_invalid' })
  }
  return { requestHash }
}

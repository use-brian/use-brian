import { assertAssociationOrderAuthority, assertAssociationSourceAuthority, loadAssociationOrderScope, withAssociationCheckout } from './source-scope.js'
/**
 * Provider entitlement coordination over one caller-owned application transaction.
 *
 * [COMP:crm/provider-entitlement-service]
 */
import type { Pool, PoolClient } from 'pg'
import {
  CrmOperationsError,
  requireCrmIntegrationResources,
  type AssociationActor,
  type CrmOperationsContext,
  type CrmOperationsServicePort,
  type ProviderEntitlementEvent,
  type ProviderInboxEnvelope,
} from '@use-brian/core'
import { lockCrmIntegrationCredential } from '../db/crm-integration-store.js'
import { lockAssociationModule } from './workspace-module.js'
import { requireProviderEntitlementActor } from '../crm-operations/entitlement-periods.js'
import {
  receiveProviderInbox,
  type ProviderInboxHandlers,
  type ProviderInboxResult,
  type ProviderInboxRow,
} from './provider-inbox.js'

type ReceiveProviderInbox = typeof receiveProviderInbox

export type ProviderEntitlementServicePort = {
  submit(workspaceId: string, event: ProviderEntitlementEvent, actor: AssociationActor): Promise<ProviderInboxResult>
  retry(row: ProviderInboxRow): Promise<ProviderInboxResult>
}

export type ProviderEntitlementServiceOptions = {
  pool: Pool
  operationsForTransaction(client: PoolClient): CrmOperationsServicePort
  receive?: ReceiveProviderInbox
}

function eventFor(envelope: ProviderInboxEnvelope): ProviderEntitlementEvent {
  if (envelope.target !== 'entitlement') throw new CrmOperationsError('invalid_input', 'Entitlement evidence is required.')
  return envelope.event
}

function contextFor(
  workspaceId: string,
  actor: AssociationActor,
  event: ProviderEntitlementEvent,
): CrmOperationsContext {
  const identity: CrmOperationsContext['actor'] = actor.credentialKind === 'provider'
    ? { kind: 'provider', provider: event.provider, eventId: event.eventId }
    : actor.credentialKind === 'system_job'
      ? { kind: 'system_job', job: 'entitlement_reconciliation', runId: actor.credentialId.slice('entitlement_reconciliation:'.length) }
      : actor.credentialKind === 'integration_key'
        ? { kind: 'integration_key', credentialId: actor.credentialId }
        : actor.credentialKind === 'oauth_token'
          ? { kind: 'oauth_token', credentialId: actor.credentialId }
          : { kind: 'brain_key', credentialId: actor.credentialId }
  return {
    workspaceId,
    actor: identity,
    authority: {
      role: 'system',
      canWrite: true,
      canConfigure: false,
      trustedIdentitySources: [],
      ...(actor.integration ? { integration: actor.integration } : {}),
    },
  }
}

async function readMembership(
  client: PoolClient,
  workspaceId: string,
  id: string,
  actor: AssociationActor,
): Promise<Record<string, unknown>> {
  await assertAssociationOrderAuthority(client, workspaceId, id, actor, 'membership')
  const row = (await client.query(`SELECT id,contact_id AS "contactId",plan_id AS "planId",status,starts_at AS "startsAt",ends_at AS "endsAt",
    renewal_mode AS "renewalMode",provider,provider_membership_id AS "providerEntitlementId",provider_period_id AS "providerPeriodId",predecessor_id AS "predecessorId"
    FROM association_memberships WHERE workspace_id=$1 AND id=$2`, [workspaceId, id])).rows[0]
  if (!row) throw new CrmOperationsError('not_found', 'Entitlement is unavailable.')
  return row
}

export function createProviderEntitlementService(
  options: ProviderEntitlementServiceOptions,
): ProviderEntitlementServicePort {
  const receive = options.receive ?? receiveProviderInbox
  const handlers = (workspaceId: string): ProviderInboxHandlers => ({
    async authorize(client, envelope, actor, admittedActor) {
      const event = eventFor(envelope)
      const command = event.command
      requireProviderEntitlementActor(actor, event.provider)
      if (actor.credentialKind === 'integration_key' && actor.integration?.credentialId !== actor.credentialId) {
        throw new CrmOperationsError('not_authorized', 'Credential-derived integration authority is required.')
      }
      const current = actor.credentialKind === 'integration_key'
        ? await lockCrmIntegrationCredential(client, workspaceId, actor.credentialId)
        : undefined
      await lockAssociationModule(client, workspaceId)
      const target = command.kind === 'grant_entitlement'
        ? { contactId: command.contactId, planId: command.planId, entitlementId: null }
        : (await client.query<{ contactId: string; planId: string; entitlementId: string }>(
          'SELECT contact_id AS "contactId",plan_id AS "planId",id AS "entitlementId" FROM association_memberships WHERE workspace_id=$1 AND id=$2',
          [workspaceId, command.entitlementId],
        )).rows[0]
      if (!target) throw new CrmOperationsError('not_found', 'Entitlement is unavailable.')
      for (const ceiling of [actor.integration, current, admittedActor?.integration]) {
        if (!ceiling) continue
        requireCrmIntegrationResources(ceiling, 'crm.entitlements.write', { planIds: target.planId })
        requireCrmIntegrationResources(ceiling, 'association.provider_events.write', { providerKeys: event.provider })
      }
      if (!(await client.query(`SELECT 1 FROM entities c JOIN association_membership_plans p ON p.workspace_id=c.workspace_id
        WHERE c.workspace_id=$1 AND c.id=$2 AND c.kind='person' AND c.valid_to IS NULL AND c.retracted_at IS NULL AND p.id=$3`,
      [workspaceId, target.contactId, target.planId])).rowCount) {
        throw new CrmOperationsError('not_found', 'Entitlement contact or plan is unavailable.')
      }
      await assertAssociationSourceAuthority(client, workspaceId, actor,
        await loadAssociationOrderScope(client, workspaceId, [target.contactId]))
      if (target.entitlementId) {
        await assertAssociationOrderAuthority(client, workspaceId, target.entitlementId, actor, 'membership')
      }
      if (event.membershipCheckout) {
        const evidence = event.membershipCheckout
        await assertAssociationOrderAuthority(client, workspaceId, evidence.id, actor, 'checkout')
        const checkout = await client.query(`SELECT 1 FROM association_membership_checkouts
          WHERE workspace_id=$1 AND id=$2 AND contact_id=$3 AND plan_id=$4
            AND provider=$5 AND provider_reference=$6 AND provider_coupon_reference=$7
            AND total_minor=$8 AND currency=$9 AND status IN('provider_bound','paid')
            AND $10::timestamptz<=reservation_expires_at FOR SHARE`,
        [workspaceId, evidence.id, target.contactId, target.planId, event.provider,
          evidence.providerCheckoutReference, evidence.providerCouponReference,
          evidence.amountMinor, evidence.currency, event.occurredAt])
        if (!checkout.rowCount) {
          throw new CrmOperationsError('conflict', 'Membership checkout evidence does not match an unexpired Brian reservation.',
            { reason: 'membership_checkout_evidence_mismatch' })
        }
      }
      return target
    },
    async apply(client, envelope, actor) {
      const event = eventFor(envelope)
      const command = event.command
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('crm-provider-period:'||$1::uuid::text||':'||$2::text||':'||$3::text,0))", [workspaceId, event.provider, event.providerReference])
      if (command.kind !== 'review_entitlement_financial_event') {
        const later = await client.query(`SELECT 1 FROM association_integration_events WHERE workspace_id=$1 AND provider=$2 AND provider_reference=$3
          AND target_kind='entitlement' AND state='applied' AND occurred_at>$4::timestamptz LIMIT 1`, [workspaceId, event.provider, event.providerReference, event.occurredAt])
        if (later.rowCount) throw new CrmOperationsError('conflict', 'Newer verified provider state already exists.', { reason: 'provider_event_out_of_order' })
      }
      if (command.kind !== 'grant_entitlement') {
        const row = (await client.query<{ provider: string; provider_membership_id: string; provider_period_id: string; same: boolean }>(`SELECT provider,provider_membership_id,provider_period_id,
          ($3::text IS NULL OR status=$3) AND (NOT $4::boolean OR ends_at IS NOT DISTINCT FROM $5::timestamptz)
            AND ($6::text IS NULL OR renewal_mode=$6) same
          FROM association_memberships WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
        [workspaceId, command.entitlementId,
          command.kind === 'update_entitlement' ? command.status ?? null : null,
          command.kind === 'update_entitlement' && Object.hasOwn(command, 'endsAt'),
          command.kind === 'update_entitlement' ? command.endsAt ?? null : null,
          command.kind === 'update_entitlement' ? command.renewalMode ?? null : null])).rows[0]
        const periodMismatch = command.kind === 'update_entitlement' && row?.provider_period_id !== event.providerPeriodId
        if (!row || row.provider !== event.provider || row.provider_membership_id !== event.providerReference || periodMismatch) {
          throw new CrmOperationsError('conflict', 'Provider object and period do not match the entitlement.')
        }
        if (command.kind === 'review_entitlement_financial_event') {
          return {
            record: await readMembership(client, workspaceId, command.entitlementId, actor),
            created: false,
            reviewReason: command.adjustmentKind === 'refund'
              ? 'membership_refund_policy_pending' as const
              : 'membership_dispute_policy_pending' as const,
          }
        }
        if (row.same) return { record: await readMembership(client, workspaceId, command.entitlementId, actor), created: false }
      }
      if (event.membershipCheckout && command.kind === 'grant_entitlement') {
        const evidence = event.membershipCheckout
        await assertAssociationOrderAuthority(client, workspaceId, evidence.id, actor, 'checkout')
        const checkout = await client.query(`SELECT 1 FROM association_membership_checkouts
          WHERE workspace_id=$1 AND id=$2 AND contact_id=$3 AND plan_id=$4
            AND provider=$5 AND provider_reference=$6 AND provider_coupon_reference=$7
            AND total_minor=$8 AND currency=$9 AND status IN('provider_bound','paid')
            AND $10::timestamptz<=reservation_expires_at FOR UPDATE`,
        [workspaceId, evidence.id, command.contactId, command.planId, event.provider,
          evidence.providerCheckoutReference, evidence.providerCouponReference,
          evidence.amountMinor, evidence.currency, event.occurredAt])
        if (!checkout.rowCount) {
          throw new CrmOperationsError('conflict', 'Membership checkout evidence changed before entitlement application.',
            { reason: 'membership_checkout_evidence_mismatch' })
        }
      }
      const execute = () => options.operationsForTransaction(client).execute(contextFor(workspaceId, actor, event), command)
      const result = event.membershipCheckout && command.kind === 'grant_entitlement'
        ? await withAssociationCheckout(client, workspaceId, event.membershipCheckout.id, actor, execute)
        : await execute()
      if (event.membershipCheckout) {
        await client.query("UPDATE association_membership_checkouts SET status='paid',updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND status='provider_bound'", [workspaceId, event.membershipCheckout.id])
        await client.query(`UPDATE association_promotion_uses SET state='redeemed',reservation_expires_at=NULL,
            released_reason=NULL,updated_at=clock_timestamp()
          WHERE workspace_id=$1 AND membership_checkout_id=$2 AND state='reserved'`,
        [workspaceId, event.membershipCheckout.id])
      }
      return { record: await readMembership(client, workspaceId, String(result.record.id), actor), created: result.duplicate !== true }
    },
    read: (client, row, actor) => readMembership(client, workspaceId, row.entitlement_id!, actor),
  })

  return {
    submit: (workspaceId, event, actor) => receive(options.pool, { target: 'entitlement', event }, actor, workspaceId, handlers(workspaceId)),
    retry: (row) => receive(options.pool, row.normalized_payload, row.execution_actor, row.workspace_id, handlers(row.workspace_id), 'worker'),
  }
}

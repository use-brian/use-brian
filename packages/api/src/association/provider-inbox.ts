import { beginAssociationCreation, assertAssociationOrderAuthority, assertAssociationSourceAuthority, loadAssociationOrderScope, withAssociationProviderReceipt } from './source-scope.js'
/** Durable provider admission, leases and atomic application. [COMP:crm/provider-inbox] */
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import {
  AssociationActorSchema, AssociationError, CrmOperationsError, CrmIntegrationScopeError, ProviderInboxEnvelopeSchema, crmOperationsSha256, deriveResourceScope,
  type AssociationActor, type ProviderInboxEnvelope, type ProviderReceiptState,
} from '@use-brian/core'
import { crmPageInstant } from '../crm-operations/pagination.js'

export type ProviderInboxRow = {
  id: string; workspace_id: string; provider: string; provider_event_id: string; provider_reference: string;
  target_kind: 'order' | 'entitlement'; order_id: string | null; entitlement_id: string | null; contact_id: string; plan_id: string | null;
  request_fingerprint: string; normalized_payload: ProviderInboxEnvelope; admitted_actor: AssociationActor; execution_actor: AssociationActor;
  state: ProviderReceiptState; attempts: number; cycle_attempts: number; lease_token: string | null; lease_expires_at: Date | null;
  next_attempt_at: Date; last_error_code: string | null; created_at: Date; updated_at: Date; applied_at: Date | null;
}
export type ProviderInboxResult = { record: Record<string, unknown>; created: boolean; receipt: Record<string, unknown> }
export type ProviderInboxHandlers = {
  authorize(client: PoolClient, envelope: ProviderInboxEnvelope, actor: AssociationActor, admittedActor?: AssociationActor): Promise<{ contactId: string; planId: string | null; entitlementId: string | null }>
  apply(client: PoolClient, envelope: ProviderInboxEnvelope, actor: AssociationActor): Promise<{
    record: Record<string, unknown>; created: boolean;
    reviewReason?: 'membership_refund_policy_pending' | 'membership_dispute_policy_pending';
  }>
  read(client: PoolClient, row: ProviderInboxRow, actor: AssociationActor): Promise<Record<string, unknown>>
}
async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result }
  catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
  finally { client.release() }
}
function normalize(raw: ProviderInboxEnvelope): ProviderInboxEnvelope {
  const value = ProviderInboxEnvelopeSchema.parse(raw)
  value.event.occurredAt = crmPageInstant(value.event.occurredAt)
  if (value.target === 'entitlement') {
    const command = value.event.command
    if (command.kind === 'grant_entitlement') command.startsAt = crmPageInstant(command.startsAt)
    if ('endsAt' in command && command.endsAt) command.endsAt = crmPageInstant(command.endsAt)
  }
  return value
}
function publicReceipt(row: ProviderInboxRow): Record<string, unknown> {
  return { id: row.id, provider: row.provider, eventId: row.provider_event_id, target: row.target_kind,
    orderId: row.order_id, entitlementId: row.entitlement_id, state: row.state, attempts: row.attempts,
    nextAttemptAt: row.state === 'retry' ? row.next_attempt_at : null, errorCode: row.last_error_code, appliedAt: row.applied_at }
}
const domainErrors = new Set(['conflict', 'not_available', 'invalid_transition', 'not_authorized', 'credential_revoked',
  'integration_scope_denied', 'not_found', 'idempotency_conflict', 'invalid_input'])
function errorCode(error: unknown): string {
  if ((error instanceof CrmOperationsError || error instanceof AssociationError || error instanceof CrmIntegrationScopeError) && domainErrors.has(error.code)) return error.code
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : ''
  if (/^08[0-9A-Z]{3}$/.test(code) || ['40001', '40P01', '55P03', '57014', '57P01', '57P02', '57P03', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE'].includes(code)) return 'transient_failure'
  return /^23[0-9A-Z]{3}$/.test(code) ? 'conflict' : 'processing_failure'
}
function receiptError(error: unknown, receiptId: string, state: ProviderReceiptState): Error {
  const details = { receiptId, receiptState: state }
  if (error instanceof CrmIntegrationScopeError) return Object.assign(new CrmIntegrationScopeError(error.operation, error.dimension), { details })
  if (error instanceof AssociationError) return new AssociationError(error.code, error.message, { ...error.details, ...details })
  if (error instanceof CrmOperationsError) return new CrmOperationsError(error.code, error.message, { ...error.details, ...details })
  return new CrmOperationsError('conflict', 'Provider processing did not complete. Inspect the receipt before retrying the same event.', details)
}
function unavailable(row: ProviderInboxRow): never {
  throw new CrmOperationsError('conflict', 'The provider receipt is processing or waiting for its retry time.',
    { reason: 'provider_event_processing', receiptId: row.id, receiptState: row.state })
}

/** mode=worker is internal: only a due scan may use it. Explicit backend replay
 * may reauthorize an unchanged frozen event, but cannot replace live lease ownership. */
export async function receiveProviderInbox(pool: Pool, raw: ProviderInboxEnvelope, rawActor: AssociationActor,
  workspaceId: string, handlers: ProviderInboxHandlers, mode: 'explicit' | 'worker' = 'explicit'): Promise<ProviderInboxResult> {
  const envelope = normalize(raw)
  const suppliedWorkspace = (rawActor.integration as { workspaceId?: string } | undefined)?.workspaceId
  if (suppliedWorkspace && suppliedWorkspace !== workspaceId) throw new CrmOperationsError('not_authorized', 'Integration workspace does not match provider admission.')
  const actor = AssociationActorSchema.parse({ ...rawActor, ...(rawActor.integration ? { integration: { credentialId: rawActor.integration.credentialId, grants: rawActor.integration.grants } } : {}) })
  const hash = crmOperationsSha256(envelope)
  const event = envelope.event
  let admitted: ProviderInboxRow
  try {
    admitted = await transaction(pool, async client => {
      await beginAssociationCreation(client, workspaceId)
      const target = await handlers.authorize(client, envelope, actor)
      let evidence = await loadAssociationOrderScope(client, workspaceId, [target.contactId])
      const parents = envelope.target === 'order'
        ? [[envelope.orderId, 'order'] as const]
        : [target.entitlementId ? [target.entitlementId, 'membership'] as const : null,
          envelope.event.membershipCheckout ? [envelope.event.membershipCheckout.id, 'checkout'] as const : null]
      for (const parent of parents) {
        if (!parent) continue
        const inherited = await assertAssociationOrderAuthority(client, workspaceId, parent[0], actor, parent[1])
        if (inherited) evidence = { sources: [...evidence.sources, ...inherited.sources],
          scope: deriveResourceScope({ producer: 'association.provider-receipt', sources: [
            ...evidence.sources, { ...inherited.scope, resourceKind: parent[1], resourceId: parent[0], version: 'saved' },
          ] }, evidence.scope) }
      }
      await assertAssociationSourceAuthority(client, workspaceId, actor, evidence)
      if (mode === 'explicit') await client.query(`INSERT INTO association_integration_events
        (workspace_id,provider,provider_event_id,provider_reference,occurred_at,target_kind,order_id,entitlement_id,contact_id,plan_id,
         request_fingerprint,normalized_payload,admitted_actor,execution_actor,scope_snapshot,scope_sources)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14::jsonb,$15::jsonb) ON CONFLICT(workspace_id,provider,provider_event_id) DO NOTHING`,
        [workspaceId, event.provider, event.eventId, event.providerReference, event.occurredAt, envelope.target,
          envelope.target === 'order' ? envelope.orderId : null, target.entitlementId, target.contactId, target.planId,
          hash, envelope, actor, JSON.stringify(evidence.scope), JSON.stringify(evidence.sources)])
      const row = (await client.query<ProviderInboxRow>(`SELECT * FROM association_integration_events
        WHERE workspace_id=$1 AND provider=$2 AND provider_event_id=$3 FOR UPDATE`, [workspaceId, event.provider, event.eventId])).rows[0]
      if (!row) throw new CrmOperationsError('not_found', 'Provider receipt is unavailable.')
      if (row.request_fingerprint !== hash) throw new CrmOperationsError('idempotency_conflict', 'Provider event identity already records different normalized input.')
      await handlers.authorize(client, envelope, actor, row.admitted_actor)
      await assertAssociationOrderAuthority(client, workspaceId, row.id, actor, 'provider_receipt')
      if (mode === 'worker' && crmOperationsSha256(row.execution_actor) !== crmOperationsSha256(actor)) unavailable(row)
      if (mode === 'explicit' && row.state !== 'applied') {
        const live = row.state === 'processing' && (await client.query<{ live: boolean }>('SELECT $1::timestamptz>clock_timestamp() live', [row.lease_expires_at])).rows[0]?.live
        if (!live) return (await client.query<ProviderInboxRow>(`UPDATE association_integration_events SET execution_actor=$2,state='pending',
          lease_token=NULL,lease_expires_at=NULL,cycle_attempts=0,next_attempt_at=clock_timestamp(),last_error_code=NULL,updated_at=clock_timestamp()
          WHERE id=$1 RETURNING *`, [row.id, actor])).rows[0]
      }
      return row
    })
  } catch (error) {
    // A worker may classify revoked pending work without gaining business authority.
    // A stale actor snapshot cannot terminalize work reauthorized by another backend.
    if (mode === 'worker' && errorCode(error) !== 'transient_failure') await pool.query(`UPDATE association_integration_events
      SET state='needs_reconciliation',last_error_code=$5,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
      WHERE workspace_id=$1 AND provider=$2 AND provider_event_id=$3 AND request_fingerprint=$4
        AND execution_actor=$6::jsonb AND (state IN('pending','retry') OR (state='processing' AND lease_expires_at<=clock_timestamp()))`,
      [workspaceId, event.provider, event.eventId, hash, errorCode(error), actor]).catch(() => {})
    throw error
  }
  const claim = await transaction(pool, async client => {
      await beginAssociationCreation(client, workspaceId)
    await handlers.authorize(client, envelope, actor, admitted.admitted_actor)
    const row = (await client.query<ProviderInboxRow>('SELECT * FROM association_integration_events WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [workspaceId, admitted.id])).rows[0]
    if (!row) throw new CrmOperationsError('not_found', 'Provider receipt is unavailable.')
    await assertAssociationOrderAuthority(client, workspaceId, row.id, actor, 'provider_receipt')
    if (row.state === 'applied') return { row, completed: { record: await handlers.read(client, row, actor), created: false, receipt: publicReceipt(row) } }
    const due = (await client.query<{ due: boolean }>(`SELECT (state IN('pending','retry') AND next_attempt_at<=clock_timestamp())
      OR (state='processing' AND lease_expires_at<=clock_timestamp()) due FROM association_integration_events WHERE id=$1`, [row.id])).rows[0]?.due
    if (!due) unavailable(row)
    if (row.cycle_attempts >= 8) {
      const stopped = (await client.query<ProviderInboxRow>(`UPDATE association_integration_events SET state='needs_reconciliation',last_error_code='attempt_limit',
        lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [row.id])).rows[0]
      return { row: stopped }
    }
    const leased = (await client.query<ProviderInboxRow>(`UPDATE association_integration_events SET state='processing',attempts=attempts+1,cycle_attempts=cycle_attempts+1,
      lease_token=$2,lease_expires_at=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [row.id, randomUUID()])).rows[0]
    return { row: leased }
  })
  if (claim.completed) return claim.completed
  if (claim.row.state !== 'processing') unavailable(claim.row)
  const lease = claim.row.lease_token!
  try {
    return await transaction(pool, async client => {
      await beginAssociationCreation(client, workspaceId)
      await handlers.authorize(client, envelope, actor, admitted.admitted_actor)
      const row = (await client.query<ProviderInboxRow>('SELECT * FROM association_integration_events WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [workspaceId, admitted.id])).rows[0]
      if (!row || row.state !== 'processing' || row.lease_token !== lease) throw new CrmOperationsError('conflict', 'Provider receipt lease changed.', { reason: 'lease_lost' })
      const applied = await withAssociationProviderReceipt(client, workspaceId, row.id, actor,
        () => handlers.apply(client, envelope, actor))
      const saved = applied.reviewReason
        ? (await client.query<ProviderInboxRow>(`UPDATE association_integration_events SET state='needs_reconciliation',applied_at=NULL,
          updated_at=clock_timestamp(),entitlement_id=CASE WHEN target_kind='entitlement' THEN $3::uuid ELSE entitlement_id END,
          lease_token=NULL,lease_expires_at=NULL,last_error_code=$4 WHERE id=$1 AND lease_token=$2 RETURNING *`,
          [row.id, lease, envelope.target === 'entitlement' ? applied.record.id : null, applied.reviewReason])).rows[0]
        : (await client.query<ProviderInboxRow>(`UPDATE association_integration_events SET state='applied',applied_at=clock_timestamp(),updated_at=clock_timestamp(),
          entitlement_id=CASE WHEN target_kind='entitlement' THEN $3::uuid ELSE entitlement_id END,
          lease_token=NULL,lease_expires_at=NULL,last_error_code=NULL WHERE id=$1 AND lease_token=$2 RETURNING *`,
          [row.id, lease, envelope.target === 'entitlement' ? applied.record.id : null])).rows[0]
      return { record: applied.record, created: applied.created, receipt: publicReceipt(saved) }
    })
  } catch (error) {
    const code = errorCode(error)
    const failed = (await pool.query<ProviderInboxRow>(`UPDATE association_integration_events SET
      state=CASE WHEN $3='transient_failure' AND cycle_attempts<8 THEN 'retry' ELSE 'needs_reconciliation' END,
      last_error_code=$3,lease_token=NULL,lease_expires_at=NULL,
      next_attempt_at=clock_timestamp()+least(300,power(2,cycle_attempts))::int*interval '1 second',updated_at=clock_timestamp()
      WHERE workspace_id=$1 AND id=$2 AND state='processing' AND lease_token=$4 RETURNING *`,
      [workspaceId, admitted.id, code, lease])).rows[0]
    const currentState = failed?.state ?? (await pool.query<{ state: ProviderReceiptState }>('SELECT state FROM association_integration_events WHERE workspace_id=$1 AND id=$2', [workspaceId, admitted.id])).rows[0]?.state ?? 'processing'
    throw receiptError(error, admitted.id, currentState)
  }
}

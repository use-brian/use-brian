/** Intake-backed, atomic waitlist promotion. [COMP:crm/association-waitlist] */
import type { Pool, PoolClient } from 'pg'
import { associationOrderReadPredicate, assertAssociationOrderAuthority, withAssociationWaitlistSubmission } from './source-scope.js'
import {
  AssociationOrderCreateSchema, AssociationWaitlistOfferInputSchema, associationWaitlistReferences,
  CrmOperationsError, crmOperationsSha256, requireCrmIntegrationResources,
  type AssociationActor, type AssociationOrderCreateInput, type AssociationWaitlistOfferInput,
} from '@use-brian/core'
import { lockCrmIntegrationCredential } from '../db/crm-integration-store.js'
import { lockAssociationModule, requireAssociationAdmission } from './workspace-module.js'
import { lockAssociationInventory } from './inventory.js'
import { queryCrmPage } from '../crm-operations/pagination.js'
import type { AssociationListInput, AssociationPage, MutationResult } from '../db/association-store.js'

type Submission = { id: string; contact_id: string; definition_id: string; definition_version_id: string | null;
  definition_schema_snapshot: unknown; submitted_data: unknown; status: string }
export type WaitlistListInput = AssociationListInput & { eventId?: string; includeClosed?: boolean;
  allowedEventIds?: readonly string[]; allowedDefinitionIds?: readonly string[] }

export async function listAssociationWaitlist(pool: Pool, workspaceId: string, input: WaitlistListInput, actor: AssociationActor): Promise<AssociationPage> {
  const client = await pool.connect()
  try {
    const submissionScope = await associationOrderReadPredicate(client, workspaceId, actor, 6, 'submission')
    const orderScope = await associationOrderReadPredicate(client, workspaceId, actor, 6 + submissionScope.params.length, 'order')
    return await queryCrmPage((sql, params) => client.query(sql, params), {
      workspaceId, resource: 'association.waitlist', key: 'items', query: { limit: input.limit, cursor: input.cursor ?? undefined, createdAfter: input.createdAfter, createdBefore: input.createdBefore },
      params: [workspaceId, input.eventId ?? null, input.includeClosed ?? false,
        input.allowedEventIds ?? null, input.allowedDefinitionIds ?? null, ...submissionScope.params, ...orderScope.params],
      sql: `SELECT q.id,q.contact_id AS "contactId",c.display_name AS "contactName",
        q.definition_id AS "definitionId",q.definition_version_id AS "definitionVersionId",q.queue_key AS "queueKey",q.status,
        q.submitted_data->>'association_event_id' AS "eventId",q.submitted_data->>'association_ticket_id' AS "ticketId",
        q.created_at AS "createdAt",q.updated_at AS "updatedAt",latest.id AS "offerId",latest.promotion_id AS "promotionId",
        latest.order_id AS "orderId",latest.order_status AS "orderStatus",latest.reservation_expires_at AS "reservationExpiresAt",
        CASE WHEN q.status IN('resolved','spam') THEN 'closed' WHEN latest.order_status='paid' THEN 'converted'
          WHEN latest.order_status='pending' THEN 'offered' ELSE 'waiting' END AS "waitlistState"
        FROM association_enquiries q JOIN entities c ON c.workspace_id=q.workspace_id AND c.id=q.contact_id
        LEFT JOIN LATERAL(SELECT f.id,f.promotion_id,f.order_id,o.status order_status,o.reservation_expires_at
          FROM association_waitlist_offers f JOIN association_orders o ON o.workspace_id=f.workspace_id AND o.id=f.order_id
          WHERE f.workspace_id=q.workspace_id AND f.submission_id=q.id ORDER BY f.created_at DESC,f.id DESC LIMIT 1) latest ON true
        WHERE q.workspace_id=$1 AND q.definition_version_id IS NOT NULL
          AND q.definition_schema_snapshot->>'queueKey'='association_waitlist'
          AND ($2::text IS NULL OR q.submitted_data->>'association_event_id'=$2)
          AND ($3::boolean OR q.status NOT IN('resolved','spam'))
          AND ($4::text[] IS NULL OR q.submitted_data->>'association_event_id'=ANY($4::text[]))
          AND ($5::uuid[] IS NULL OR q.definition_id=ANY($5::uuid[]))
          AND ${submissionScope.sql.replaceAll('association_enquiries.', 'q.')}
          AND NOT EXISTS (SELECT 1 FROM association_waitlist_offers f
            JOIN association_orders o ON o.workspace_id=f.workspace_id AND o.id=f.order_id
            WHERE f.workspace_id=q.workspace_id AND f.submission_id=q.id
              AND NOT ${orderScope.sql.replaceAll('association_orders.', 'o.')})`,
    })
  } finally { client.release() }
}

export async function offerAssociationWaitlist(client: PoolClient, workspaceId: string, raw: AssociationWaitlistOfferInput,
  actor: AssociationActor, createOrder: (input: AssociationOrderCreateInput) => Promise<MutationResult>,
  getOrder: (id: string) => Promise<Record<string, unknown> | null>): Promise<MutationResult> {
  const input = AssociationWaitlistOfferInputSchema.parse(raw)
  if (['intake_key', 'system_job'].includes(actor.credentialKind)) throw new CrmOperationsError('not_authorized', 'Waitlist promotion requires staff or delegated commerce authority.')
  if (actor.credentialKind === 'integration_key' && actor.integration?.credentialId !== actor.credentialId) throw new CrmOperationsError('not_authorized', 'Credential-derived integration authority is required.')
  const current = actor.credentialKind === 'integration_key' ? await lockCrmIntegrationCredential(client, workspaceId, actor.credentialId) : undefined
  const module = await lockAssociationModule(client, workspaceId)
  await assertAssociationOrderAuthority(client, workspaceId, input.submissionId, actor, 'submission')
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('association-promotion:'||$1::uuid::text||':'||$2::uuid::text,0))", [workspaceId, input.promotionId])
  const select = `SELECT id,contact_id,definition_id,definition_version_id,definition_schema_snapshot,submitted_data,status
    FROM association_enquiries WHERE workspace_id=$1 AND id=$2`
  const before = (await client.query<Submission>(select, [workspaceId, input.submissionId])).rows[0]
  const references = before?.definition_version_id ? associationWaitlistReferences(before.definition_schema_snapshot, before.submitted_data) : null
  if (!before || !references) throw new CrmOperationsError('conflict', 'A versioned waitlist submission with fixed event and ticket references is required.', { reason: 'waitlist_definition_required' })
  for (const principal of [actor.integration, current]) if (principal) {
    requireCrmIntegrationResources(principal, 'association.orders.write', { eventIds: references.eventId })
    requireCrmIntegrationResources(principal, 'crm.submissions.write', { definitionIds: before.definition_id })
  }
  const requestHash = crmOperationsSha256(input)
  const replay = async () => (await client.query<{ id: string; submission_id: string; promotion_id: string; order_id: string; request_fingerprint: string }>(
    'SELECT id,submission_id,promotion_id,order_id,request_fingerprint FROM association_waitlist_offers WHERE workspace_id=$1 AND promotion_id=$2',
    [workspaceId, input.promotionId],
  )).rows[0]
  const resultFor = async (offer: NonNullable<Awaited<ReturnType<typeof replay>>>, created: boolean): Promise<MutationResult> => {
    await assertAssociationOrderAuthority(client, workspaceId, offer.order_id, actor)
    if (offer.request_fingerprint !== requestHash) throw new CrmOperationsError('idempotency_conflict', 'Promotion identity was already used for a different waitlist offer.')
    return { record: { id: offer.id, submissionId: offer.submission_id, promotionId: offer.promotion_id,
      orderId: offer.order_id, order: await getOrder(offer.order_id) }, created }
  }
  const existing = await replay()
  if (existing) return resultFor(existing, false)
  requireAssociationAdmission(module)
  await lockAssociationInventory(client, workspaceId, { eventIds: [references.eventId], ticketIds: [references.ticketId] })
  const locked = (await client.query<Submission>(`${select} FOR UPDATE`, [workspaceId, input.submissionId])).rows[0]
  const lockedReferences = locked?.definition_version_id ? associationWaitlistReferences(locked.definition_schema_snapshot, locked.submitted_data) : null
  if (!locked || !lockedReferences || lockedReferences.eventId !== references.eventId || lockedReferences.ticketId !== references.ticketId
    || locked.definition_id !== before.definition_id || !['new', 'in_progress'].includes(locked.status)) {
    throw new CrmOperationsError('conflict', 'Waitlist source changed or closed; reload before offering a place.', { reason: 'waitlist_source_changed' })
  }
  const raced = await replay()
  if (raced) return resultFor(raced, false)
  const ticket = await client.query('SELECT 1 FROM association_ticket_types WHERE workspace_id=$1 AND id=$2 AND event_id=$3', [workspaceId, references.ticketId, references.eventId])
  if (!ticket.rowCount) throw new CrmOperationsError('not_found', 'Waitlist ticket does not belong to its event.')
  const active = await client.query(`SELECT 1 FROM association_waitlist_offers f JOIN association_orders o ON o.workspace_id=f.workspace_id AND o.id=f.order_id
    WHERE f.workspace_id=$1 AND f.submission_id=$2 AND o.status IN('pending','paid') LIMIT 1`, [workspaceId, input.submissionId])
  if (active.rowCount) throw new CrmOperationsError('conflict', 'This waitlist submission already has a pending or paid order.', { reason: 'waitlist_offer_exists' })
  const contact = (await client.query<{ display_name: string; attributes: Record<string, unknown> }>(`SELECT display_name,attributes FROM entities
    WHERE workspace_id=$1 AND id=$2 AND kind='person' AND valid_to IS NULL AND retracted_at IS NULL FOR SHARE`, [workspaceId, locked.contact_id])).rows[0]
  if (!contact) throw new CrmOperationsError('not_found', 'The waitlist contact is unavailable.')
  const order = await withAssociationWaitlistSubmission(client, workspaceId, input.submissionId, actor, () => createOrder(AssociationOrderCreateSchema.parse({
    contactId: locked.contact_id, idempotencyKey: `waitlist:${input.promotionId}`, reservationMinutes: input.reservationMinutes,
    lines: [{ ticketId: references.ticketId, quantity: 1, useMemberPrice: input.useMemberPrice,
      attendees: [{ contactId: locked.contact_id, name: contact.display_name,
        ...(typeof contact.attributes.email === 'string' && contact.attributes.email ? { email: contact.attributes.email } : {}),
        metadata: { waitlistSubmissionId: locked.id } }] }],
    metadata: { waitlistSubmissionId: locked.id, waitlistPromotionId: input.promotionId },
  })))
  if (!order.created) throw new CrmOperationsError('conflict', 'The promotion order identity already exists without a waitlist link.')
  const saved = (await client.query<NonNullable<Awaited<ReturnType<typeof replay>>>>(`INSERT INTO association_waitlist_offers
    (workspace_id,submission_id,ticket_id,promotion_id,order_id,request_fingerprint,actor_kind,actor_credential_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,submission_id,promotion_id,order_id,request_fingerprint`,
    [workspaceId, input.submissionId, references.ticketId, input.promotionId, order.record.id, requestHash, actor.credentialKind, actor.credentialId])).rows[0]
  await client.query(`INSERT INTO association_audit_log(workspace_id,action,subject_kind,subject_id,actor_kind,actor_credential_id,acting_user_id,metadata)
    VALUES($1,'waitlist.offered','order',$2,$3,$4,$5,$6::jsonb)`,
    [workspaceId, order.record.id, actor.credentialKind, actor.credentialId, actor.actingUserId ?? null,
      JSON.stringify({ submissionId: input.submissionId, promotionId: input.promotionId, offerId: saved.id })])
  return resultFor(saved, true)
}

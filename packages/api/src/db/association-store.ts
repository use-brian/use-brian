/**
 * PostgreSQL store for association operations.
 *
 * Every system-pool query repeats `workspace_id` in its predicate. Mutations
 * that create side effects (audit/outbox) and all inventory/payment changes
 * use one transaction, so callers never observe a record without its evidence
 * or a payment state without matching registrations.
 *
 * [COMP:crm/association-store]
 */

import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { getPool } from './client.js'
import {
  AssociationError,
  associationFingerprint,
  encodeAssociationCursor,
  mayTransitionOrder,
  type AssociationActor,
  type ConsentInput,
  type EnquiryCreateInput,
  type EnquiryNoteInput,
  type EnquiryStatus,
  type EnquiryUpdateInput,
  type EventInput,
  type ExternalIdentityInput,
  type MembershipInput,
  type MembershipUpdateInput,
  type OrderCreateInput,
  type OrderStatus,
  type PlanInput,
  type ProviderEventInput,
  mayTransitionRegistration,
  type RegistrationStatus,
  type RegistrationUpdateInput,
  type TicketInput,
} from '../association/domain.js'

export type AssociationRecord = Record<string, unknown>
export type AssociationPage = { items: AssociationRecord[]; nextCursor: string | null }
export type MutationResult = { record: AssociationRecord; created: boolean }

export type AssociationListInput = {
  limit: number
  cursor: { createdAt: string; id: string } | null
}

export type AssociationStore = {
  linkExternalIdentity(workspaceId: string, input: ExternalIdentityInput, actor: AssociationActor): Promise<MutationResult>
  resolveExternalIdentity(workspaceId: string, provider: string, providerSubject: string): Promise<AssociationRecord | null>
  createEnquiry(workspaceId: string, input: EnquiryCreateInput, actor: AssociationActor): Promise<MutationResult>
  listEnquiries(workspaceId: string, input: AssociationListInput & { status?: EnquiryStatus; queueKey?: string; ownerUserId?: string }): Promise<AssociationPage>
  updateEnquiry(workspaceId: string, id: string, input: EnquiryUpdateInput, actor: AssociationActor): Promise<AssociationRecord>
  addEnquiryNote(workspaceId: string, enquiryId: string, input: EnquiryNoteInput, actor: AssociationActor): Promise<AssociationRecord>
  listEnquiryNotes(workspaceId: string, enquiryId: string): Promise<AssociationRecord[]>
  appendConsent(workspaceId: string, input: ConsentInput, actor: AssociationActor): Promise<MutationResult>
  listConsents(workspaceId: string, contactId: string): Promise<{ events: AssociationRecord[]; effective: Record<string, string> }>
  upsertPlan(workspaceId: string, input: PlanInput, actor: AssociationActor): Promise<MutationResult>
  listPlans(workspaceId: string, input: AssociationListInput & { published?: boolean }): Promise<AssociationPage>
  createMembership(workspaceId: string, input: MembershipInput, actor: AssociationActor): Promise<MutationResult>
  listMemberships(workspaceId: string, contactId: string): Promise<AssociationRecord[]>
  updateMembership(workspaceId: string, id: string, input: MembershipUpdateInput, actor: AssociationActor): Promise<AssociationRecord>
  upsertEvent(workspaceId: string, input: EventInput, actor: AssociationActor): Promise<MutationResult>
  listEvents(workspaceId: string, input: AssociationListInput & { status?: string }): Promise<AssociationPage>
  upsertTicket(workspaceId: string, eventId: string, input: TicketInput, actor: AssociationActor): Promise<MutationResult>
  listTickets(workspaceId: string, eventId: string): Promise<AssociationRecord[]>
  createOrder(workspaceId: string, input: OrderCreateInput, actor: AssociationActor): Promise<MutationResult>
  getOrder(workspaceId: string, id: string): Promise<AssociationRecord | null>
  reconcileProviderEvent(workspaceId: string, orderId: string, input: ProviderEventInput, actor: AssociationActor): Promise<MutationResult>
  listEventRegistrations(workspaceId: string, eventId: string, input: AssociationListInput & { status?: RegistrationStatus }): Promise<AssociationPage>
  getRegistrationManagement(workspaceId: string, id: string): Promise<{ sourceKind: string } | null>
  updateRegistration(workspaceId: string, id: string, input: RegistrationUpdateInput, actor: AssociationActor): Promise<AssociationRecord>
  listNotifications(workspaceId: string, input: AssociationListInput & { status?: string }): Promise<AssociationPage>
}

type DbRow = QueryResultRow & Record<string, unknown>

const IDENTITY_SELECT = `
  id, workspace_id AS "workspaceId", contact_id AS "contactId", provider,
  provider_subject AS "providerSubject", created_at AS "createdAt", updated_at AS "updatedAt"`
const ENQUIRY_SELECT = `
  id, workspace_id AS "workspaceId", contact_id AS "contactId", source,
  source_submission_id AS "sourceSubmissionId", subject, message,
  submitted_data AS "submittedData", status, queue_key AS "queueKey",
  owner_user_id AS "ownerUserId", submitted_at AS "submittedAt",
  created_at AS "createdAt", updated_at AS "updatedAt"`
const ENQUIRY_NOTE_SELECT = `
  id, workspace_id AS "workspaceId", enquiry_id AS "enquiryId", body,
  actor_kind AS "actorKind", actor_credential_id AS "actorCredentialId",
  acting_user_id AS "actingUserId", created_at AS "createdAt"`
const CONSENT_SELECT = `
  id, workspace_id AS "workspaceId", contact_id AS "contactId", purpose, action,
  wording_version AS "wordingVersion", source, occurred_at AS "occurredAt",
  provider, provider_event_id AS "providerEventId", metadata,
  created_at AS "createdAt"`
const PLAN_SELECT = `
  id, workspace_id AS "workspaceId", plan_key AS "key", name, currency,
  fee_minor::text AS "feeMinor", billing_period AS "billingPeriod", benefits,
  eligibility_note AS "eligibilityNote", active_from AS "activeFrom",
  active_to AS "activeTo", published, provider, provider_plan_id AS "providerPlanId",
  created_at AS "createdAt", updated_at AS "updatedAt"`
const MEMBERSHIP_SELECT = `
  m.id, m.workspace_id AS "workspaceId", m.contact_id AS "contactId",
  m.plan_id AS "planId", p.plan_key AS "planKey", p.name AS "planName",
  m.idempotency_key AS "idempotencyKey", m.status, m.starts_at AS "startsAt",
  m.ends_at AS "endsAt", m.renewal_mode AS "renewalMode", m.provider,
  m.provider_membership_id AS "providerMembershipId",
  m.created_at AS "createdAt", m.updated_at AS "updatedAt"`
const EVENT_SELECT = `
  id, workspace_id AS "workspaceId", slug, programme_key AS "programmeKey",
  title, description, starts_at AS "startsAt", ends_at AS "endsAt", timezone,
  mode, venue, online_url AS "onlineUrl",
  registration_opens_at AS "registrationOpensAt",
  registration_closes_at AS "registrationClosesAt", capacity, status,
  canonical_url AS "canonicalUrl", metadata,
  created_at AS "createdAt", updated_at AS "updatedAt"`
const TICKET_SELECT = `
  t.id, t.workspace_id AS "workspaceId", t.event_id AS "eventId",
  t.ticket_key AS "key", t.name, t.currency,
  t.price_minor::text AS "priceMinor", t.member_price_minor::text AS "memberPriceMinor",
  t.eligible_plan_keys AS "eligiblePlanKeys", t.capacity,
  t.per_order_limit AS "perOrderLimit", t.sale_starts_at AS "saleStartsAt",
  t.sale_ends_at AS "saleEndsAt", t.status,
  COALESCE(i.reserved_count, 0)::int AS "reservedCount",
  CASE WHEN t.capacity IS NULL THEN NULL
       ELSE GREATEST(t.capacity - COALESCE(i.reserved_count, 0), 0)::int END AS "available",
  t.created_at AS "createdAt", t.updated_at AS "updatedAt"`
const ORDER_SELECT = `
  id, workspace_id AS "workspaceId", contact_id AS "contactId",
  idempotency_key AS "idempotencyKey", status, currency,
  subtotal_minor::text AS "subtotalMinor", discount_minor::text AS "discountMinor",
  total_minor::text AS "totalMinor", reservation_expires_at AS "reservationExpiresAt",
  provider, provider_reference AS "providerReference", metadata,
  created_at AS "createdAt", updated_at AS "updatedAt"`
const REGISTRATION_SELECT = `
  id, workspace_id AS "workspaceId", order_id AS "orderId",
  order_line_id AS "orderLineId", event_id AS "eventId", ticket_id AS "ticketId",
  attendee_contact_id AS "attendeeContactId", attendee_name AS "attendeeName",
  attendee_email AS "attendeeEmail", attendee_metadata AS "attendeeMetadata",
  status, reservation_expires_at AS "reservationExpiresAt",
  checked_in_at AS "checkedInAt", source_kind AS "sourceKind", source_id AS "sourceId",
  created_at AS "createdAt", updated_at AS "updatedAt"`
const NOTIFICATION_SELECT = `
  id, workspace_id AS "workspaceId", source_kind AS "sourceKind",
  source_id AS "sourceId", template_key AS "templateKey",
  recipient_kind AS "recipientKind", recipient_ref AS "recipientRef", payload,
  status, attempts, next_attempt_at AS "nextAttemptAt",
  provider_message_id AS "providerMessageId", last_error AS "lastError",
  created_at AS "createdAt", updated_at AS "updatedAt"`

async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const value = await fn(client)
    await client.query('COMMIT')
    return value
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function requirePerson(client: PoolClient, workspaceId: string, contactId: string): Promise<void> {
  const found = await client.query(
    `SELECT 1 FROM entities
      WHERE workspace_id = $1 AND id = $2 AND kind = 'person' AND valid_to IS NULL`,
    [workspaceId, contactId],
  )
  if (!found.rowCount) {
    throw new AssociationError('contact_required', 'contactId must identify a live CRM person in this workspace')
  }
}

async function requireWorkspaceUser(client: PoolClient, workspaceId: string, userId: string): Promise<void> {
  const found = await client.query(
    `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId],
  )
  if (!found.rowCount) throw new AssociationError('not_found', 'ownerUserId is not a workspace member')
}

async function audit(
  client: PoolClient,
  workspaceId: string,
  action: string,
  subjectKind: string,
  subjectId: string,
  actor: AssociationActor,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await client.query(
    `INSERT INTO association_audit_log
       (workspace_id, action, subject_kind, subject_id, actor_kind,
        actor_credential_id, acting_user_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [workspaceId, action, subjectKind, subjectId, actor.credentialKind,
      actor.credentialId, actor.actingUserId ?? null, metadata],
  )
}

function page(rows: DbRow[], limit: number): AssociationPage {
  const hasNext = rows.length > limit
  const items = (hasNext ? rows.slice(0, limit) : rows) as AssociationRecord[]
  const last = items.at(-1)
  const nextCursor = hasNext && last
    ? encodeAssociationCursor({
        createdAt: new Date(String(last.createdAt)).toISOString(),
        id: String(last.id),
      })
    : null
  return { items, nextCursor }
}

async function getOrderRecord(client: Pick<PoolClient, 'query'>, workspaceId: string, id: string): Promise<AssociationRecord | null> {
  const orderResult = await client.query<DbRow>(
    `SELECT ${ORDER_SELECT} FROM association_orders WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, id],
  )
  const order = orderResult.rows[0]
  if (!order) return null
  const [lines, registrations] = await Promise.all([
    client.query<DbRow>(
      `SELECT l.id, l.order_id AS "orderId", l.ticket_id AS "ticketId",
              t.ticket_key AS "ticketKey", t.name AS "ticketName", l.quantity,
              l.unit_price_minor::text AS "unitPriceMinor",
              l.discount_minor::text AS "discountMinor",
              l.line_total_minor::text AS "lineTotalMinor",
              l.pricing_basis AS "pricingBasis",
              l.eligible_membership_id AS "eligibleMembershipId",
              l.created_at AS "createdAt"
         FROM association_order_lines l
         JOIN association_ticket_types t ON t.workspace_id = l.workspace_id AND t.id = l.ticket_id
        WHERE l.workspace_id = $1 AND l.order_id = $2
        ORDER BY l.created_at, l.id`,
      [workspaceId, id],
    ),
    client.query<DbRow>(
      `SELECT ${REGISTRATION_SELECT}
         FROM association_registrations
        WHERE workspace_id = $1 AND order_id = $2
        ORDER BY created_at, id`,
      [workspaceId, id],
    ),
  ])
  return { ...order, lines: lines.rows, registrations: registrations.rows }
}

export function createAssociationStore(pool: Pool = getPool()): AssociationStore {
  return {
    async linkExternalIdentity(workspaceId, input, actor) {
      return transaction(pool, async (client) => {
        await requirePerson(client, workspaceId, input.contactId)
        const inserted = await client.query<DbRow>(
          `INSERT INTO association_external_identities
             (workspace_id, contact_id, provider, provider_subject)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (workspace_id, provider, provider_subject) DO NOTHING
           RETURNING ${IDENTITY_SELECT}`,
          [workspaceId, input.contactId, input.provider, input.providerSubject],
        )
        if (inserted.rows[0]) {
          await audit(client, workspaceId, 'external_identity.linked', 'external_identity', String(inserted.rows[0].id), actor)
          return { record: inserted.rows[0], created: true }
        }
        const existing = await client.query<DbRow>(
          `SELECT ${IDENTITY_SELECT} FROM association_external_identities
            WHERE workspace_id = $1 AND provider = $2 AND provider_subject = $3`,
          [workspaceId, input.provider, input.providerSubject],
        )
        if (!existing.rows[0]) throw new AssociationError('conflict', 'provider identity could not be resolved after a concurrent link')
        if (existing.rows[0].contactId !== input.contactId) {
          throw new AssociationError('conflict', 'provider identity is already linked to another contact')
        }
        return { record: existing.rows[0], created: false }
      })
    },

    async resolveExternalIdentity(workspaceId, provider, providerSubject) {
      const result = await pool.query<DbRow>(
        `SELECT ${IDENTITY_SELECT} FROM association_external_identities
          WHERE workspace_id = $1 AND provider = $2 AND provider_subject = $3`,
        [workspaceId, provider, providerSubject],
      )
      return result.rows[0] ?? null
    },

    async createEnquiry(workspaceId, input, actor) {
      return transaction(pool, async (client) => {
        const fingerprint = associationFingerprint(input)
        await requirePerson(client, workspaceId, input.contactId)
        const inserted = await client.query<DbRow>(
          `INSERT INTO association_enquiries
             (workspace_id, contact_id, source, source_submission_id,
              request_fingerprint, subject, message, queue_key, submitted_at, submitted_data)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz, now()),$10)
           ON CONFLICT (workspace_id, source, source_submission_id) DO NOTHING
           RETURNING ${ENQUIRY_SELECT}`,
          [workspaceId, input.contactId, input.source, input.sourceSubmissionId,
            fingerprint, input.subject, input.message, input.queueKey,
            input.submittedAt ?? null, input.submittedData],
        )
        if (!inserted.rows[0]) {
          const existing = await client.query<DbRow>(
            `SELECT ${ENQUIRY_SELECT}, request_fingerprint AS "requestFingerprint"
               FROM association_enquiries
              WHERE workspace_id = $1 AND source = $2 AND source_submission_id = $3`,
            [workspaceId, input.source, input.sourceSubmissionId],
          )
          if (!existing.rows[0]) throw new AssociationError('conflict', 'enquiry could not be resolved after a concurrent submission')
          if (existing.rows[0].requestFingerprint !== fingerprint) {
            throw new AssociationError('conflict', 'source submission id was already used for a different enquiry')
          }
          const { requestFingerprint: _ignored, ...record } = existing.rows[0]
          return { record, created: false }
        }
        const enquiry = inserted.rows[0]
        await client.query(
          `INSERT INTO association_notification_outbox
             (workspace_id, source_kind, source_id, template_key,
              recipient_kind, recipient_ref, payload)
           VALUES
             ($1,'enquiry',$2,'enquiry_acknowledgement','contact',$3,$4),
             ($1,'enquiry',$2,'enquiry_staff_alert','queue',$5,$4)`,
          [workspaceId, enquiry.id, input.contactId,
            { enquiryId: enquiry.id, subject: input.subject }, input.queueKey],
        )
        await audit(client, workspaceId, 'enquiry.created', 'enquiry', String(enquiry.id), actor, {
          source: input.source,
          queueKey: input.queueKey,
        })
        return { record: enquiry, created: true }
      })
    },

    async listEnquiries(workspaceId, input) {
      const conditions = ['workspace_id = $1']
      const values: unknown[] = [workspaceId]
      if (input.status) {
        values.push(input.status)
        conditions.push(`status = $${values.length}`)
      }
      if (input.queueKey) {
        values.push(input.queueKey)
        conditions.push(`queue_key = $${values.length}`)
      }
      if (input.ownerUserId) {
        values.push(input.ownerUserId)
        conditions.push(`owner_user_id = $${values.length}`)
      }
      if (input.cursor) {
        values.push(input.cursor.createdAt, input.cursor.id)
        conditions.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`)
      }
      values.push(input.limit + 1)
      const result = await pool.query<DbRow>(
        `SELECT ${ENQUIRY_SELECT} FROM association_enquiries
          WHERE ${conditions.join(' AND ')}
          ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
        values,
      )
      return page(result.rows, input.limit)
    },

    async updateEnquiry(workspaceId, id, input, actor) {
      return transaction(pool, async (client) => {
        if (input.ownerUserId) await requireWorkspaceUser(client, workspaceId, input.ownerUserId)
        const result = await client.query<DbRow>(
          `UPDATE association_enquiries
              SET status = COALESCE($3, status),
                  queue_key = COALESCE($4, queue_key),
                  owner_user_id = CASE WHEN $5::boolean THEN $6::uuid ELSE owner_user_id END
            WHERE workspace_id = $1 AND id = $2
            RETURNING ${ENQUIRY_SELECT}`,
          [workspaceId, id, input.status ?? null, input.queueKey ?? null,
            Object.prototype.hasOwnProperty.call(input, 'ownerUserId'), input.ownerUserId ?? null],
        )
        const enquiry = result.rows[0]
        if (!enquiry) throw new AssociationError('not_found', 'enquiry not found')
        await audit(client, workspaceId, 'enquiry.updated', 'enquiry', id, actor, input)
        return enquiry
      })
    },

    async addEnquiryNote(workspaceId, enquiryId, input, actor) {
      return transaction(pool, async (client) => {
        const enquiry = await client.query(
          `SELECT 1 FROM association_enquiries WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, enquiryId],
        )
        if (!enquiry.rowCount) throw new AssociationError('not_found', 'enquiry not found')
        const result = await client.query<DbRow>(
          `INSERT INTO association_enquiry_notes
             (workspace_id, enquiry_id, body, actor_kind,
              actor_credential_id, acting_user_id)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${ENQUIRY_NOTE_SELECT}`,
          [workspaceId, enquiryId, input.body, actor.credentialKind,
            actor.credentialId, actor.actingUserId ?? null],
        )
        const note = result.rows[0]
        await audit(client, workspaceId, 'enquiry.note_added', 'enquiry', enquiryId, actor, {
          noteId: note.id,
        })
        return note
      })
    },

    async listEnquiryNotes(workspaceId, enquiryId) {
      const result = await pool.query<DbRow>(
        `SELECT ${ENQUIRY_NOTE_SELECT} FROM association_enquiry_notes
          WHERE workspace_id = $1 AND enquiry_id = $2
          ORDER BY created_at, id`,
        [workspaceId, enquiryId],
      )
      return result.rows
    },

    async appendConsent(workspaceId, input, actor) {
      return transaction(pool, async (client) => {
        if (input.provider && input.providerEventId) {
          const existing = await client.query<DbRow>(
            `SELECT ${CONSENT_SELECT} FROM association_consent_events
              WHERE workspace_id = $1 AND provider = $2 AND provider_event_id = $3`,
            [workspaceId, input.provider, input.providerEventId],
          )
          if (existing.rows[0]) {
            const event = existing.rows[0]
            if (event.contactId !== input.contactId || event.purpose !== input.purpose
              || event.action !== input.action || event.wordingVersion !== input.wordingVersion
              || event.source !== input.source) {
              throw new AssociationError('conflict', 'provider event id was already used for different consent evidence')
            }
            return { record: event, created: false }
          }
        }
        await requirePerson(client, workspaceId, input.contactId)
        const result = await client.query<DbRow>(
          `INSERT INTO association_consent_events
             (workspace_id, contact_id, purpose, action, wording_version, source,
              occurred_at, provider, provider_event_id, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz, now()),$8,$9,$10)
           ON CONFLICT (workspace_id, provider, provider_event_id)
             WHERE provider IS NOT NULL DO NOTHING
           RETURNING ${CONSENT_SELECT}`,
          [workspaceId, input.contactId, input.purpose, input.action,
            input.wordingVersion, input.source, input.occurredAt ?? null,
            input.provider ?? null, input.providerEventId ?? null, input.metadata],
        )
        if (!result.rows[0] && input.provider && input.providerEventId) {
          const raced = await client.query<DbRow>(
            `SELECT ${CONSENT_SELECT} FROM association_consent_events
              WHERE workspace_id = $1 AND provider = $2 AND provider_event_id = $3`,
            [workspaceId, input.provider, input.providerEventId],
          )
          const event = raced.rows[0]
          if (!event) throw new AssociationError('conflict', 'consent event could not be resolved after a concurrent submission')
          if (event.contactId !== input.contactId || event.purpose !== input.purpose
            || event.action !== input.action || event.wordingVersion !== input.wordingVersion
            || event.source !== input.source) {
            throw new AssociationError('conflict', 'provider event id was already used for different consent evidence')
          }
          return { record: event, created: false }
        }
        const consent = result.rows[0]
        await audit(client, workspaceId, `consent.${input.action}`, 'consent_event', String(consent.id), actor, {
          contactId: input.contactId,
          purpose: input.purpose,
          wordingVersion: input.wordingVersion,
        })
        return { record: consent, created: true }
      })
    },

    async listConsents(workspaceId, contactId) {
      const result = await pool.query<DbRow>(
        `SELECT ${CONSENT_SELECT} FROM association_consent_events
          WHERE workspace_id = $1 AND contact_id = $2
          ORDER BY occurred_at DESC, id DESC`,
        [workspaceId, contactId],
      )
      const effective: Record<string, string> = {}
      for (const event of result.rows) {
        const purpose = String(event.purpose)
        if (!(purpose in effective)) effective[purpose] = String(event.action)
      }
      return { events: result.rows, effective }
    },

    async upsertPlan(workspaceId, input, actor) {
      return transaction(pool, async (client) => {
        const before = await client.query<{ id: string }>(
          `SELECT id FROM association_membership_plans WHERE workspace_id = $1 AND plan_key = $2`,
          [workspaceId, input.key],
        )
        const result = await client.query<DbRow>(
          `INSERT INTO association_membership_plans
             (workspace_id, plan_key, name, currency, fee_minor, billing_period,
              benefits, eligibility_note, active_from, active_to, published,
              provider, provider_plan_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (workspace_id, plan_key) DO UPDATE SET
             name = EXCLUDED.name, currency = EXCLUDED.currency,
             fee_minor = EXCLUDED.fee_minor, billing_period = EXCLUDED.billing_period,
             benefits = EXCLUDED.benefits, eligibility_note = EXCLUDED.eligibility_note,
             active_from = EXCLUDED.active_from, active_to = EXCLUDED.active_to,
             published = EXCLUDED.published, provider = EXCLUDED.provider,
             provider_plan_id = EXCLUDED.provider_plan_id
           RETURNING ${PLAN_SELECT}`,
          [workspaceId, input.key, input.name, input.currency, input.feeMinor,
            input.billingPeriod, input.benefits, input.eligibilityNote ?? null,
            input.activeFrom ?? null, input.activeTo ?? null, input.published,
            input.provider ?? null, input.providerPlanId ?? null],
        )
        const plan = result.rows[0]
        const created = before.rows.length === 0
        await audit(client, workspaceId, created ? 'plan.created' : 'plan.updated', 'membership_plan', String(plan.id), actor)
        return { record: plan, created }
      })
    },

    async listPlans(workspaceId, input) {
      const conditions = ['workspace_id = $1']
      const values: unknown[] = [workspaceId]
      if (input.published !== undefined) {
        values.push(input.published)
        conditions.push(`published = $${values.length}`)
      }
      if (input.cursor) {
        values.push(input.cursor.createdAt, input.cursor.id)
        conditions.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`)
      }
      values.push(input.limit + 1)
      const result = await pool.query<DbRow>(
        `SELECT ${PLAN_SELECT} FROM association_membership_plans
          WHERE ${conditions.join(' AND ')}
          ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
        values,
      )
      return page(result.rows, input.limit)
    },

    async createMembership(workspaceId, input, actor) {
      return transaction(pool, async (client) => {
        const fingerprint = associationFingerprint(input)
        const existing = await client.query<DbRow>(
          `SELECT ${MEMBERSHIP_SELECT}, m.request_fingerprint AS "requestFingerprint"
             FROM association_memberships m
             JOIN association_membership_plans p
               ON p.workspace_id = m.workspace_id AND p.id = m.plan_id
            WHERE m.workspace_id = $1 AND m.idempotency_key = $2 FOR UPDATE`,
          [workspaceId, input.idempotencyKey],
        )
        if (existing.rows[0]) {
          if (existing.rows[0].requestFingerprint !== fingerprint) {
            throw new AssociationError('conflict', 'idempotency key was already used for a different membership')
          }
          const { requestFingerprint: _ignored, ...record } = existing.rows[0]
          return { record, created: false }
        }
        await requirePerson(client, workspaceId, input.contactId)
        const plan = await client.query(
          `SELECT 1 FROM association_membership_plans WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, input.planId],
        )
        if (!plan.rowCount) throw new AssociationError('not_found', 'membership plan not found')
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO association_memberships
             (workspace_id, contact_id, plan_id, idempotency_key,
              request_fingerprint, status, starts_at, ends_at, renewal_mode,
              provider, provider_membership_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
           RETURNING id`,
          [workspaceId, input.contactId, input.planId, input.idempotencyKey,
            fingerprint, input.status, input.startsAt, input.endsAt ?? null,
            input.renewalMode, input.provider ?? null, input.providerMembershipId ?? null],
        )
        if (!inserted.rows[0]) {
          const raced = await client.query<DbRow>(
            `SELECT ${MEMBERSHIP_SELECT}, m.request_fingerprint AS "requestFingerprint"
               FROM association_memberships m
               JOIN association_membership_plans p
                 ON p.workspace_id = m.workspace_id AND p.id = m.plan_id
              WHERE m.workspace_id = $1 AND m.idempotency_key = $2`,
            [workspaceId, input.idempotencyKey],
          )
          if (!raced.rows[0]) throw new AssociationError('conflict', 'membership could not be resolved after a concurrent submission')
          if (raced.rows[0].requestFingerprint !== fingerprint) {
            throw new AssociationError('conflict', 'idempotency key was already used for a different membership')
          }
          const { requestFingerprint: _ignored, ...record } = raced.rows[0]
          return { record, created: false }
        }
        const membership = await client.query<DbRow>(
          `SELECT ${MEMBERSHIP_SELECT} FROM association_memberships m
             JOIN association_membership_plans p
               ON p.workspace_id = m.workspace_id AND p.id = m.plan_id
            WHERE m.workspace_id = $1 AND m.id = $2`,
          [workspaceId, inserted.rows[0].id],
        )
        await audit(client, workspaceId, 'membership.created', 'membership', inserted.rows[0].id, actor, {
          contactId: input.contactId,
          planId: input.planId,
          status: input.status,
        })
        return { record: membership.rows[0], created: true }
      })
    },

    async listMemberships(workspaceId, contactId) {
      const result = await pool.query<DbRow>(
        `SELECT ${MEMBERSHIP_SELECT} FROM association_memberships m
           JOIN association_membership_plans p
             ON p.workspace_id = m.workspace_id AND p.id = m.plan_id
          WHERE m.workspace_id = $1 AND m.contact_id = $2
          ORDER BY m.created_at DESC, m.id DESC`,
        [workspaceId, contactId],
      )
      return result.rows
    },

    async updateMembership(workspaceId, id, input, actor) {
      return transaction(pool, async (client) => {
        const current = await client.query<{ starts_at: Date }>(
          `SELECT starts_at FROM association_memberships
            WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
          [workspaceId, id],
        )
        if (!current.rows[0]) throw new AssociationError('not_found', 'membership not found')
        if (input.endsAt && new Date(input.endsAt) <= current.rows[0].starts_at) {
          throw new AssociationError('conflict', 'endsAt must be after startsAt')
        }
        await client.query(
          `UPDATE association_memberships
              SET status = COALESCE($3, status),
                  ends_at = CASE WHEN $4::boolean THEN $5::timestamptz ELSE ends_at END,
                  renewal_mode = COALESCE($6, renewal_mode)
            WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, id, input.status ?? null,
            Object.prototype.hasOwnProperty.call(input, 'endsAt'), input.endsAt ?? null,
            input.renewalMode ?? null],
        )
        const result = await client.query<DbRow>(
          `SELECT ${MEMBERSHIP_SELECT} FROM association_memberships m
             JOIN association_membership_plans p
               ON p.workspace_id = m.workspace_id AND p.id = m.plan_id
            WHERE m.workspace_id = $1 AND m.id = $2`,
          [workspaceId, id],
        )
        await audit(client, workspaceId, 'membership.updated', 'membership', id, actor, input)
        return result.rows[0]
      })
    },

    async upsertEvent(workspaceId, input, actor) {
      return transaction(pool, async (client) => {
        const before = await client.query<{ id: string }>(
          `SELECT id FROM association_events WHERE workspace_id = $1 AND slug = $2`,
          [workspaceId, input.slug],
        )
        const result = await client.query<DbRow>(
          `INSERT INTO association_events
             (workspace_id, slug, programme_key, title, description, starts_at,
              ends_at, timezone, mode, venue, online_url, registration_opens_at,
              registration_closes_at, capacity, status, canonical_url, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           ON CONFLICT (workspace_id, slug) DO UPDATE SET
             programme_key = EXCLUDED.programme_key, title = EXCLUDED.title,
             description = EXCLUDED.description, starts_at = EXCLUDED.starts_at,
             ends_at = EXCLUDED.ends_at, timezone = EXCLUDED.timezone,
             mode = EXCLUDED.mode, venue = EXCLUDED.venue,
             online_url = EXCLUDED.online_url,
             registration_opens_at = EXCLUDED.registration_opens_at,
             registration_closes_at = EXCLUDED.registration_closes_at,
             capacity = EXCLUDED.capacity, status = EXCLUDED.status,
             canonical_url = EXCLUDED.canonical_url, metadata = EXCLUDED.metadata
           RETURNING ${EVENT_SELECT}`,
          [workspaceId, input.slug, input.programmeKey ?? null, input.title,
            input.description, input.startsAt, input.endsAt, input.timezone,
            input.mode, input.venue ?? null, input.onlineUrl ?? null,
            input.registrationOpensAt ?? null, input.registrationClosesAt ?? null,
            input.capacity ?? null, input.status, input.canonicalUrl ?? null,
            input.metadata],
        )
        const event = result.rows[0]
        const created = before.rows.length === 0
        await audit(client, workspaceId, created ? 'event.created' : 'event.updated', 'event', String(event.id), actor)
        return { record: event, created }
      })
    },

    async listEvents(workspaceId, input) {
      const conditions = ['workspace_id = $1']
      const values: unknown[] = [workspaceId]
      if (input.status) {
        values.push(input.status)
        conditions.push(`status = $${values.length}`)
      }
      if (input.cursor) {
        values.push(input.cursor.createdAt, input.cursor.id)
        conditions.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`)
      }
      values.push(input.limit + 1)
      const result = await pool.query<DbRow>(
        `SELECT ${EVENT_SELECT} FROM association_events
          WHERE ${conditions.join(' AND ')}
          ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
        values,
      )
      return page(result.rows, input.limit)
    },

    async upsertTicket(workspaceId, eventId, input, actor) {
      return transaction(pool, async (client) => {
        const event = await client.query(
          `SELECT 1 FROM association_events WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, eventId],
        )
        if (!event.rowCount) throw new AssociationError('not_found', 'event not found')
        if (input.eligiblePlanKeys.length > 0) {
          const plans = await client.query<{ plan_key: string }>(
            `SELECT plan_key FROM association_membership_plans
              WHERE workspace_id = $1 AND plan_key = ANY($2::text[])`,
            [workspaceId, input.eligiblePlanKeys],
          )
          const found = new Set(plans.rows.map((plan) => plan.plan_key))
          const missing = input.eligiblePlanKeys.filter((key) => !found.has(key))
          if (missing.length > 0) {
            throw new AssociationError('not_found', 'one or more eligible membership plan keys do not exist', { missing })
          }
        }
        const before = await client.query<{ id: string }>(
          `SELECT id FROM association_ticket_types WHERE workspace_id = $1 AND event_id = $2 AND ticket_key = $3`,
          [workspaceId, eventId, input.key],
        )
        const result = await client.query<DbRow>(
          `INSERT INTO association_ticket_types
             (workspace_id, event_id, ticket_key, name, currency, price_minor,
              member_price_minor, eligible_plan_keys, capacity, per_order_limit,
              sale_starts_at, sale_ends_at, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (event_id, ticket_key) DO UPDATE SET
             name = EXCLUDED.name, currency = EXCLUDED.currency,
             price_minor = EXCLUDED.price_minor,
             member_price_minor = EXCLUDED.member_price_minor,
             eligible_plan_keys = EXCLUDED.eligible_plan_keys,
             capacity = EXCLUDED.capacity, per_order_limit = EXCLUDED.per_order_limit,
             sale_starts_at = EXCLUDED.sale_starts_at,
             sale_ends_at = EXCLUDED.sale_ends_at, status = EXCLUDED.status
           RETURNING id`,
          [workspaceId, eventId, input.key, input.name, input.currency,
            input.priceMinor, input.memberPriceMinor ?? null, input.eligiblePlanKeys,
            input.capacity ?? null, input.perOrderLimit, input.saleStartsAt ?? null,
            input.saleEndsAt ?? null, input.status],
        )
        const tickets = await client.query<DbRow>(
          `SELECT ${TICKET_SELECT}
             FROM association_ticket_types t
             LEFT JOIN LATERAL (
               SELECT count(*)::int AS reserved_count FROM association_registrations r
                WHERE r.workspace_id = t.workspace_id AND r.ticket_id = t.id
                  AND (r.status IN ('confirmed','checked_in')
                    OR (r.status = 'reserved' AND r.reservation_expires_at > now()))
             ) i ON true
            WHERE t.workspace_id = $1 AND t.id = $2`,
          [workspaceId, result.rows[0].id],
        )
        const created = before.rows.length === 0
        await audit(client, workspaceId, created ? 'ticket.created' : 'ticket.updated', 'ticket', String(result.rows[0].id), actor, { eventId })
        return { record: tickets.rows[0], created }
      })
    },

    async listTickets(workspaceId, eventId) {
      const result = await pool.query<DbRow>(
        `SELECT ${TICKET_SELECT}
           FROM association_ticket_types t
           LEFT JOIN LATERAL (
             SELECT count(*)::int AS reserved_count FROM association_registrations r
              WHERE r.workspace_id = t.workspace_id AND r.ticket_id = t.id
                AND (r.status IN ('confirmed','checked_in')
                  OR (r.status = 'reserved' AND r.reservation_expires_at > now()))
           ) i ON true
          WHERE t.workspace_id = $1 AND t.event_id = $2
          ORDER BY t.created_at, t.id`,
        [workspaceId, eventId],
      )
      return result.rows
    },

    async createOrder(workspaceId, input, actor) {
      return transaction(pool, async (client) => {
        const fingerprint = associationFingerprint(input)
        const existing = await client.query<DbRow>(
          `SELECT id, request_fingerprint AS "requestFingerprint"
             FROM association_orders
            WHERE workspace_id = $1 AND idempotency_key = $2 FOR UPDATE`,
          [workspaceId, input.idempotencyKey],
        )
        if (existing.rows[0]) {
          if (existing.rows[0].requestFingerprint !== fingerprint) {
            throw new AssociationError('conflict', 'idempotency key was already used for a different order')
          }
          const record = await getOrderRecord(client, workspaceId, String(existing.rows[0].id))
          return { record: record!, created: false }
        }
        await requirePerson(client, workspaceId, input.contactId)
        const ticketIds = input.lines.map((line) => line.ticketId)
        const ticketsResult = await client.query<{
          id: string
          event_id: string
          currency: string
          price_minor: string
          member_price_minor: string | null
          eligible_plan_keys: string[]
          capacity: number | null
          per_order_limit: number
          sale_starts_at: Date | null
          sale_ends_at: Date | null
          status: string
          event_status: string
          event_capacity: number | null
          registration_opens_at: Date | null
          registration_closes_at: Date | null
        }>(
          `SELECT t.id, t.event_id, t.currency, t.price_minor::text,
                  t.member_price_minor::text, t.eligible_plan_keys, t.capacity,
                  t.per_order_limit, t.sale_starts_at, t.sale_ends_at, t.status,
                  e.status AS event_status, e.capacity AS event_capacity,
                  e.registration_opens_at, e.registration_closes_at
             FROM association_ticket_types t
             JOIN association_events e
               ON e.workspace_id = t.workspace_id AND e.id = t.event_id
            WHERE t.workspace_id = $1 AND t.id = ANY($2::uuid[])
            ORDER BY t.id FOR UPDATE OF t, e`,
          [workspaceId, ticketIds],
        )
        if (ticketsResult.rows.length !== ticketIds.length) {
          throw new AssociationError('not_found', 'one or more ticket types were not found')
        }
        // A concurrent retry with the same request blocks on the same ticket
        // locks. Re-check after acquiring them so the loser returns the
        // winner's order instead of reserving inventory twice or surfacing a
        // unique-index error.
        const racedOrder = await client.query<DbRow>(
          `SELECT id, request_fingerprint AS "requestFingerprint"
             FROM association_orders
            WHERE workspace_id = $1 AND idempotency_key = $2`,
          [workspaceId, input.idempotencyKey],
        )
        if (racedOrder.rows[0]) {
          if (racedOrder.rows[0].requestFingerprint !== fingerprint) {
            throw new AssociationError('conflict', 'idempotency key was already used for a different order')
          }
          return {
            record: (await getOrderRecord(client, workspaceId, String(racedOrder.rows[0].id)))!,
            created: false,
          }
        }
        const tickets = new Map(ticketsResult.rows.map((ticket) => [ticket.id, ticket]))
        const currencies = new Set(ticketsResult.rows.map((ticket) => ticket.currency))
        if (currencies.size !== 1) throw new AssociationError('conflict', 'one order cannot mix currencies')

        const inventory = await client.query<{ ticket_id: string; event_id: string; used: number }>(
          `SELECT ticket_id, event_id, count(*)::int AS used
             FROM association_registrations
            WHERE workspace_id = $1
              AND (status IN ('confirmed','checked_in')
                OR (status = 'reserved' AND reservation_expires_at > now()))
              AND (ticket_id = ANY($2::uuid[]) OR event_id = ANY($3::uuid[]))
            GROUP BY ticket_id, event_id`,
          [workspaceId, ticketIds, [...new Set(ticketsResult.rows.map((ticket) => ticket.event_id))]],
        )
        const ticketUsed = new Map<string, number>()
        const eventUsed = new Map<string, number>()
        for (const row of inventory.rows) {
          ticketUsed.set(row.ticket_id, (ticketUsed.get(row.ticket_id) ?? 0) + row.used)
          eventUsed.set(row.event_id, (eventUsed.get(row.event_id) ?? 0) + row.used)
        }
        const requestedByEvent = new Map<string, number>()
        for (const line of input.lines) {
          const ticket = tickets.get(line.ticketId)!
          requestedByEvent.set(ticket.event_id, (requestedByEvent.get(ticket.event_id) ?? 0) + line.quantity)
        }

        const now = Date.now()
        for (const line of input.lines) {
          const ticket = tickets.get(line.ticketId)!
          const opens = ticket.sale_starts_at ?? ticket.registration_opens_at
          const closes = ticket.sale_ends_at ?? ticket.registration_closes_at
          if (ticket.status !== 'on_sale' || ticket.event_status !== 'published'
            || (opens && opens.getTime() > now) || (closes && closes.getTime() <= now)) {
            throw new AssociationError('not_available', 'ticket is not currently on sale', { ticketId: line.ticketId })
          }
          if (line.quantity > ticket.per_order_limit) {
            throw new AssociationError('not_available', 'ticket quantity exceeds its per-order limit', { ticketId: line.ticketId })
          }
          if (ticket.capacity !== null && (ticketUsed.get(ticket.id) ?? 0) + line.quantity > ticket.capacity) {
            throw new AssociationError('not_available', 'ticket capacity is exhausted', { ticketId: line.ticketId })
          }
          if (ticket.event_capacity !== null
            && (eventUsed.get(ticket.event_id) ?? 0) + (requestedByEvent.get(ticket.event_id) ?? 0) > ticket.event_capacity) {
            throw new AssociationError('not_available', 'event capacity is exhausted', { eventId: ticket.event_id })
          }
        }

        const pricedLines: Array<{
          input: OrderCreateInput['lines'][number]
          ticket: (typeof ticketsResult.rows)[number]
          unitPrice: number
          publicPrice: number
          membershipId: string | null
        }> = []
        for (const line of input.lines) {
          const ticket = tickets.get(line.ticketId)!
          const publicPrice = Number(ticket.price_minor)
          let membershipId: string | null = null
          let unitPrice = publicPrice
          if (line.useMemberPrice) {
            if (ticket.member_price_minor === null) {
              throw new AssociationError('member_price_ineligible', 'ticket has no member price', { ticketId: line.ticketId })
            }
            const eligibility = await client.query<{ id: string }>(
              `SELECT m.id FROM association_memberships m
                 JOIN association_membership_plans p
                   ON p.workspace_id = m.workspace_id AND p.id = m.plan_id
                WHERE m.workspace_id = $1 AND m.contact_id = $2
                  AND m.status = 'active' AND m.starts_at <= now()
                  AND (m.ends_at IS NULL OR m.ends_at > now())
                  AND (cardinality($3::text[]) = 0 OR p.plan_key = ANY($3::text[]))
                ORDER BY m.starts_at DESC LIMIT 1`,
              [workspaceId, input.contactId, ticket.eligible_plan_keys],
            )
            membershipId = eligibility.rows[0]?.id ?? null
            if (!membershipId) {
              throw new AssociationError('member_price_ineligible', 'contact has no eligible active membership', { ticketId: line.ticketId })
            }
            unitPrice = Number(ticket.member_price_minor)
          }
          pricedLines.push({ input: line, ticket, unitPrice, publicPrice, membershipId })
        }
        const subtotal = pricedLines.reduce((sum, line) => sum + line.publicPrice * line.input.quantity, 0)
        const total = pricedLines.reduce((sum, line) => sum + line.unitPrice * line.input.quantity, 0)
        const discount = subtotal - total
        const reservationExpiresAt = new Date(now + input.reservationMinutes * 60_000)
        const orderResult = await client.query<{ id: string }>(
          `INSERT INTO association_orders
             (workspace_id, contact_id, idempotency_key, request_fingerprint,
              status, currency, subtotal_minor, discount_minor, total_minor,
              reservation_expires_at, metadata)
           VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9,$10) RETURNING id`,
          [workspaceId, input.contactId, input.idempotencyKey, fingerprint,
            [...currencies][0], subtotal, discount, total, reservationExpiresAt,
            input.metadata],
        )
        const orderId = orderResult.rows[0].id
        for (const priced of pricedLines) {
          const lineTotal = priced.unitPrice * priced.input.quantity
          const lineDiscount = (priced.publicPrice - priced.unitPrice) * priced.input.quantity
          const lineResult = await client.query<{ id: string }>(
            `INSERT INTO association_order_lines
               (workspace_id, order_id, ticket_id, quantity, unit_price_minor,
                discount_minor, line_total_minor, pricing_basis, eligible_membership_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
            [workspaceId, orderId, priced.ticket.id, priced.input.quantity,
              priced.unitPrice, lineDiscount, lineTotal,
              priced.membershipId ? 'member' : 'public', priced.membershipId],
          )
          for (const attendee of priced.input.attendees) {
            if (attendee.contactId) await requirePerson(client, workspaceId, attendee.contactId)
            await client.query(
              `INSERT INTO association_registrations
                 (workspace_id, order_id, order_line_id, event_id, ticket_id,
                  attendee_contact_id, attendee_name, attendee_email,
                  attendee_metadata, status, reservation_expires_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'reserved',$10)`,
              [workspaceId, orderId, lineResult.rows[0].id, priced.ticket.event_id,
                priced.ticket.id, attendee.contactId ?? null, attendee.name,
                attendee.email ?? null, attendee.metadata, reservationExpiresAt],
            )
          }
        }
        await audit(client, workspaceId, 'order.reserved', 'order', orderId, actor, {
          contactId: input.contactId,
          totalMinor: total,
          currency: [...currencies][0],
        })
        return { record: (await getOrderRecord(client, workspaceId, orderId))!, created: true }
      })
    },

    async getOrder(workspaceId, id) {
      const client = await pool.connect()
      try {
        return await getOrderRecord(client, workspaceId, id)
      } finally {
        client.release()
      }
    },

    async reconcileProviderEvent(workspaceId, orderId, input, actor) {
      return transaction(pool, async (client) => {
        const replay = await client.query<{
          order_id: string
          target_status: OrderStatus
        }>(
          `SELECT order_id, target_status FROM association_provider_events
            WHERE workspace_id = $1 AND provider = $2 AND provider_event_id = $3`,
          [workspaceId, input.provider, input.eventId],
        )
        if (replay.rows[0]) {
          if (replay.rows[0].order_id !== orderId || replay.rows[0].target_status !== input.targetStatus) {
            throw new AssociationError('conflict', 'provider event id was already used for a different transition')
          }
          return { record: (await getOrderRecord(client, workspaceId, orderId))!, created: false }
        }
        const orderResult = await client.query<{
          status: OrderStatus
          reservation_expires_at: Date | null
        }>(
          `SELECT status, reservation_expires_at FROM association_orders
            WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
          [workspaceId, orderId],
        )
        const order = orderResult.rows[0]
        if (!order) throw new AssociationError('not_found', 'order not found')
        const racedEvent = await client.query<{
          order_id: string
          target_status: OrderStatus
        }>(
          `SELECT order_id, target_status FROM association_provider_events
            WHERE workspace_id = $1 AND provider = $2 AND provider_event_id = $3`,
          [workspaceId, input.provider, input.eventId],
        )
        if (racedEvent.rows[0]) {
          if (racedEvent.rows[0].order_id !== orderId || racedEvent.rows[0].target_status !== input.targetStatus) {
            throw new AssociationError('conflict', 'provider event id was already used for a different transition')
          }
          return { record: (await getOrderRecord(client, workspaceId, orderId))!, created: false }
        }
        if (!mayTransitionOrder(order.status, input.targetStatus)) {
          throw new AssociationError('invalid_transition', `order cannot transition from ${order.status} to ${input.targetStatus}`)
        }
        if (order.status === 'pending' && input.targetStatus === 'paid'
          && order.reservation_expires_at && order.reservation_expires_at.getTime() <= Date.now()) {
          throw new AssociationError(
            'not_available',
            'the order reservation expired before payment confirmation; manual reconciliation is required',
          )
        }
        await client.query(
          `INSERT INTO association_provider_events
             (workspace_id, order_id, provider, provider_event_id, target_status,
              provider_reference, occurred_at, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [workspaceId, orderId, input.provider, input.eventId, input.targetStatus,
            input.providerReference ?? null, input.occurredAt, input.metadata],
        )
        await client.query(
          `UPDATE association_orders SET status = $3, provider = $4,
                  provider_reference = COALESCE($5, provider_reference),
                  reservation_expires_at = CASE WHEN $3 = 'pending' THEN reservation_expires_at ELSE NULL END
            WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, orderId, input.targetStatus, input.provider,
            input.providerReference ?? null],
        )
        const registrationStatus = input.targetStatus === 'paid' ? 'confirmed'
          : input.targetStatus === 'refunded' ? 'refunded' : 'cancelled'
        await client.query(
          `UPDATE association_registrations
              SET status = $3,
                  reservation_expires_at = NULL
            WHERE workspace_id = $1 AND order_id = $2
              AND status IN ('reserved','confirmed')`,
          [workspaceId, orderId, registrationStatus],
        )
        if (input.targetStatus === 'paid') {
          const orderContact = await client.query<{ contact_id: string }>(
            `SELECT contact_id FROM association_orders WHERE workspace_id = $1 AND id = $2`,
            [workspaceId, orderId],
          )
          await client.query(
            `INSERT INTO association_notification_outbox
               (workspace_id, source_kind, source_id, template_key,
                recipient_kind, recipient_ref, payload)
             VALUES
               ($1,'order',$2,'order_receipt','contact',$3,$4),
               ($1,'order',$2,'order_paid_staff_alert','queue','registrations',$4)
             ON CONFLICT DO NOTHING`,
            [workspaceId, orderId, orderContact.rows[0].contact_id, { orderId }],
          )
        }
        await audit(client, workspaceId, `order.${input.targetStatus}`, 'order', orderId, actor, {
          provider: input.provider,
          providerEventId: input.eventId,
          from: order.status,
          to: input.targetStatus,
        })
        return { record: (await getOrderRecord(client, workspaceId, orderId))!, created: true }
      })
    },

    async listEventRegistrations(workspaceId, eventId, input) {
      const event = await pool.query(
        `SELECT 1 FROM association_events WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, eventId],
      )
      if (!event.rowCount) throw new AssociationError('not_found', 'event not found')
      const conditions = ['workspace_id = $1', 'event_id = $2']
      const values: unknown[] = [workspaceId, eventId]
      if (input.status) {
        values.push(input.status)
        conditions.push(`status = $${values.length}`)
      }
      if (input.cursor) {
        values.push(input.cursor.createdAt, input.cursor.id)
        conditions.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`)
      }
      values.push(input.limit + 1)
      const result = await pool.query<DbRow>(
        `SELECT ${REGISTRATION_SELECT} FROM association_registrations
          WHERE ${conditions.join(' AND ')}
          ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
        values,
      )
      return page(result.rows, input.limit)
    },

    async getRegistrationManagement(workspaceId, id) {
      const result = await pool.query<{ sourceKind: string }>(
        `SELECT source_kind AS "sourceKind" FROM association_registrations
          WHERE workspace_id=$1 AND id=$2`,
        [workspaceId, id],
      )
      return result.rows[0] ?? null
    },

    async updateRegistration(workspaceId, id, input, actor) {
      return transaction(pool, async (client) => {
        const current = await client.query<{ status: RegistrationStatus }>(
          `SELECT status FROM association_registrations
            WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
          [workspaceId, id],
        )
        const registration = current.rows[0]
        if (!registration) throw new AssociationError('not_found', 'registration not found')
        if (!mayTransitionRegistration(registration.status, input.status)) {
          throw new AssociationError(
            'invalid_transition',
            `registration cannot transition from ${registration.status} to ${input.status}`,
          )
        }
        const result = await client.query<DbRow>(
          `UPDATE association_registrations
              SET status = $3,
                  reservation_expires_at = CASE WHEN $3 = 'cancelled' THEN NULL ELSE reservation_expires_at END,
                  checked_in_at = CASE WHEN $3 = 'checked_in' THEN now() ELSE checked_in_at END
            WHERE workspace_id = $1 AND id = $2
            RETURNING ${REGISTRATION_SELECT}`,
          [workspaceId, id, input.status],
        )
        await audit(client, workspaceId, `registration.${input.status}`, 'registration', id, actor, {
          from: registration.status,
          to: input.status,
        })
        return result.rows[0]
      })
    },

    async listNotifications(workspaceId, input) {
      const conditions = ['workspace_id = $1']
      const values: unknown[] = [workspaceId]
      if (input.status) {
        values.push(input.status)
        conditions.push(`status = $${values.length}`)
      }
      if (input.cursor) {
        values.push(input.cursor.createdAt, input.cursor.id)
        conditions.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`)
      }
      values.push(input.limit + 1)
      const result = await pool.query<DbRow>(
        `SELECT ${NOTIFICATION_SELECT} FROM association_notification_outbox
          WHERE ${conditions.join(' AND ')}
          ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
        values,
      )
      return page(result.rows, input.limit)
    },
  }
}

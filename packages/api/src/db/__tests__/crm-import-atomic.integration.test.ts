import { createHmac, randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import pg from 'pg'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { CrmOperationsCommandSchema, type CrmOperationsCommand, type CrmOperationsContext, type FilesApi, type EntityLinksStore } from '@use-brian/core'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { createCrmProductionImportService, type CrmImportEntityKind } from '../../crm-operations/import-service.js'
import { getPool } from '../client.js'
import { createAssociationService } from '../../association/service.js'
import { createAssociationStore } from '../association-store.js'
import { EventInputSchema, PlanInputSchema, TicketInputSchema } from '../../association/domain.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, application_name: 'crm_atomic_import_fixture' })
const files = new Map<string, Buffer>()
const promotionHmacKey = 'fictional-promotion-key-for-tests-only'
const filesApi = { readBytes: async (_ctx: unknown, id: string) => ({ ok: true, value: { file: { id }, bytes: files.get(id)! } }) } as unknown as FilesApi
const operations = createCrmOperationsService(createDbCrmOperationsStore(pool))
type Hook = (client: pg.PoolClient, command: CrmOperationsCommand) => Promise<void>
function importer(hook?: Hook, entityLinks?: EntityLinksStore) {
  return createCrmProductionImportService({ pool, filesApi, entityLinks, associationForTransaction: (client) => {
    const crmService = createCrmOperationsService(createDbCrmOperationsStore(pool, client))
    return createAssociationService({ store: createAssociationStore(pool, client, { promotionHmacKey }), crmService })
  }, operationsForTransaction: (client) => {
    const service = createCrmOperationsService(createDbCrmOperationsStore(pool, client))
    return {
      importHistoricalSubmission: service.importHistoricalSubmission,
      execute: async (context, command) => {
        const result = await service.execute(context, command)
        await hook?.(client, command)
        return result
      },
    }
  } })
}
async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID()
  await pool.query('INSERT INTO users (id,auth_provider_id) VALUES ($1::uuid,$1::text)', [userId])
  await pool.query(`INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'Atomic import fixture',$2)`, [workspaceId, userId])
  await pool.query(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'owner')`, [workspaceId, userId])
  await pool.query(`UPDATE workspace_modules SET state='enabled',enabled_at=clock_timestamp(),disabled_at=NULL
    WHERE workspace_id=$1 AND module_key='association'`, [workspaceId])
  const context: CrmOperationsContext = { workspaceId, actor: { kind: 'user', userId }, authority: { role: 'owner', canWrite: true, canConfigure: true, trustedIdentitySources: [] } }
  await operations.execute(context, CrmOperationsCommandSchema.parse({ kind: 'save_consent_purpose', purposeKey: 'updates', label: 'Fixture updates', wording: 'Fixture wording', wordingVersion: '1' }))
  async function entity(kind: string, name: string, attributes = {}) {
    const id = randomUUID()
    await pool.query(`INSERT INTO entities (id,workspace_id,kind,display_name,attributes,created_by_user_id,source)
      VALUES ($1,$2,$3,$4,$5,$6,'manual')`, [id, workspaceId, kind, name, attributes, userId])
    return id
  }
  async function job(columns: string[], rows: string[][], kind: CrmImportEntityKind = 'contact', trustedIdentitySource?: string) {
    const csvCell = (value: string) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
    const id = randomUUID(), bytes = Buffer.from([columns.join(','), ...rows.map((row) => row.map(csvCell).join(',')), ''].join('\n'))
    files.set(id, bytes)
    await pool.query(`INSERT INTO workspace_files (id,workspace_id,path,name,storage_uri,created_by_user_id)
      VALUES ($1,$2,$3,'fixture.csv','fixture://local',$4)`, [id, workspaceId, `/fixture/${id}.csv`, userId])
    const input = { stagedFileId: id, entityKind: kind,
      mapping: { columns: Object.fromEntries(columns.map((column, index) => [index, column])), ...(trustedIdentitySource ? { trustedIdentitySource } : {}) } }
    const service = importer(), checked = await service.dryRun(context, input)
    expect(checked.failedRows).toBe(0)
    return service.confirm(context, { ...input, confirmed: true, dryRunHash: checked.dryRunHash })
  }
  async function counts() {
    return (await pool.query(`SELECT
      (SELECT count(*) FROM entities WHERE workspace_id=$1)::int AS entities,
      (SELECT count(*) FROM crm_identity_bindings WHERE workspace_id=$1)::int AS bindings,
      (SELECT count(*) FROM association_consent_events WHERE workspace_id=$1)::int AS consent,
      (SELECT count(*) FROM crm_import_rows WHERE workspace_id=$1)::int AS receipts,
      (SELECT count(*) FROM crm_import_chunks WHERE workspace_id=$1)::int AS chunks,
      (SELECT count(*) FROM crm_import_errors WHERE workspace_id=$1)::int AS errors,
      (SELECT count(*) FROM association_audit_log WHERE workspace_id=$1)::int AS audit,
      (SELECT count(*) FROM crm_domain_event_outbox WHERE workspace_id=$1)::int AS outbox`, [workspaceId])).rows[0]
  }
  return { workspaceId, userId, context, entity, job, counts }
}
const consentColumns = ['name', 'email', 'consentPurposeKey', 'consentAction', 'consentSource']
const row = (index: number) => [`Fixture ${index}`, `fixture${index}@example.com`, 'updates', 'granted', 'fixture_import']

describe('[COMP:crm/production-import] Atomic rows and serialized chunk recovery', () => {
  afterAll(async () => { await Promise.all([pool.end(), getPool().end()]) })
  it('rolls back a failed row including custom fields, stable bindings and evidence, and emits only committed graph projections', async () => {
    const f = await fixture(), companyId = await f.entity('company', 'Fixture company')
    await pool.query(`INSERT INTO crm_field_definitions (workspace_id,entity_kind,field_key,label,field_type)
      VALUES ($1,'person','score','Score','number')`, [f.workspaceId])
    const columns = [...consentColumns, 'custom:score', 'companyId', 'identityProvider', 'identityProviderInstance', 'identitySubject']
    const job = await f.job(columns, [0, 1].map((i) => [...row(i), '7', companyId, 'fixture', 'fixture_instance', `subject_${i}`]), 'contact', 'fixture')
    const create = vi.fn(async () => ({ id: randomUUID() }))
    const links = { create } as unknown as EntityLinksStore
    const service = importer(async (_client, command) => {
      expect(create).not.toHaveBeenCalled()
      if (command.kind === 'record_consent' && command.metadata.importRow === 2) throw new Error('Fixture rejection after evidence write')
    }, links)
    expect(await service.resume(f.context, job.id)).toMatchObject({ status: 'completed', processedRows: 2, succeededRows: 1, failedRows: 1 })
    expect(await f.counts()).toMatchObject({ entities: 2, bindings: 1, consent: 1, receipts: 2, errors: 1, audit: 2, outbox: 1 })
    const person = (await pool.query(`SELECT id,attributes FROM entities WHERE workspace_id=$1 AND kind='person'`, [f.workspaceId])).rows[0]
    expect(person.attributes).toMatchObject({ email: 'fixture1@example.com', custom_fields: { score: 7 }, company_id: companyId })
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ sourceId: person.id, targetId: companyId }))
    const before = await f.counts()
    await service.resume(f.context, job.id)
    expect(await f.counts()).toEqual(before)
    // Emulate the legacy committed chunk whose separate job checkpoint never ran.
    await pool.query(`UPDATE crm_import_jobs SET status='running',processed_rows=0,succeeded_rows=0,failed_rows=0,next_chunk_index=0,completed_at=NULL WHERE id=$1`, [job.id])
    expect(await importer().resume(f.context, job.id)).toMatchObject({ status: 'completed', processedRows: 2, succeededRows: 1, failedRows: 1, nextChunkIndex: 1 })
    expect(await f.counts()).toEqual(before)
    const boundAgain = await f.job(columns, [[...row(1), '8', companyId, 'fixture', 'fixture_instance', 'subject_1']], 'contact', 'fixture')
    expect(await importer().resume(f.context, boundAgain.id)).toMatchObject({ status: 'completed', succeededRows: 1, failedRows: 0 })
    expect(await f.counts()).toMatchObject({ entities: 2, bindings: 1, consent: 2 })
    expect((await pool.query('SELECT attributes FROM entities WHERE id=$1', [person.id])).rows[0].attributes.custom_fields).toEqual({ score: 8 })
  })

  it('survives connection termination after the canonical command and before the row receipt with immediate clean resume', async () => {
    const f = await fixture(), job = await f.job(consentColumns, [row(0)])
    const before = await f.counts()
    await expect(importer(async (client) => {
      client.once('error', () => undefined)
      await client.query('SELECT pg_terminate_backend(pg_backend_pid())')
    }).resume(f.context, job.id)).rejects.toBeDefined()
    expect(await f.counts()).toEqual(before)
    expect(await importer().resume(f.context, job.id)).toMatchObject({ status: 'completed', succeededRows: 1, failedRows: 0 })
    expect(await f.counts()).toMatchObject({ entities: 1, consent: 1, receipts: 1, chunks: 1, errors: 0, outbox: 1 })
  })

  it('imports historical forms silently with original evidence and protects their identity across jobs', async () => {
    const f = await fixture(), contactId = await f.entity('person', 'Historical form person', { email: 'history@example.com' })
    const columns = [
      'contactId', 'historicalSubmissionSource', 'historicalSubmissionSite',
      'historicalSubmissionForm', 'historicalSubmissionId', 'historicalSubmissionOccurredAt',
      'historicalSubmissionStatus', 'historicalSubmissionFieldsJson',
      'historicalSubmissionSubject', 'historicalSubmissionQueueKey',
    ]
    const original = [contactId, 'wix', 'oasahk_org', 'contact_form', 'wix-submission-42',
      '2021-03-04T05:06:07.123456Z', 'resolved', '{"answer":"yes"}', 'Archived contact request', 'general']
    const counts = async () => (await pool.query(`SELECT
      (SELECT count(*) FROM association_enquiries WHERE workspace_id=$1)::int AS submissions,
      (SELECT count(*) FROM association_audit_log WHERE workspace_id=$1 AND action='crm.submission.historical_imported')::int AS audit,
      (SELECT count(*) FROM crm_domain_event_outbox WHERE workspace_id=$1)::int AS domain_outbox,
      (SELECT count(*) FROM association_notification_outbox WHERE workspace_id=$1)::int AS notification_outbox,
      (SELECT count(*) FROM crm_delivery_receipts WHERE workspace_id=$1)::int AS deliveries,
      (SELECT count(*) FROM association_consent_events WHERE workspace_id=$1)::int AS consent,
      (SELECT count(*) FROM tasks WHERE workspace_id=$1)::int AS tasks`, [f.workspaceId])).rows[0]

    const first = await f.job(columns, [original], 'operations')
    expect(await importer().resume(f.context, first.id)).toMatchObject({ status: 'completed', succeededRows: 1, failedRows: 0 })
    expect((await pool.query(`SELECT result_refs FROM crm_import_rows
      WHERE workspace_id=$1 AND job_id=$2 AND row_number=2`, [f.workspaceId, first.id])).rows[0].result_refs).toEqual([
      { kind: 'contact', id: contactId },
      { kind: 'submission', id: expect.stringMatching(/^[0-9a-f-]{36}$/), sourceId: 'wix-submission-42' },
    ])
    const saved = (await pool.query(`SELECT contact_id,source,source_site,source_form,source_submission_id,
      status,queue_key,subject,submitted_data,historical_import,
      to_char(submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS submitted_at
      FROM association_enquiries WHERE workspace_id=$1`, [f.workspaceId])).rows[0]
    expect(saved).toMatchObject({
      contact_id: contactId, source: 'wix', source_site: 'oasahk_org', source_form: 'contact_form',
      source_submission_id: 'wix-submission-42', status: 'resolved', queue_key: 'general',
      subject: 'Archived contact request', historical_import: true,
      submitted_at: '2021-03-04T05:06:07.123456Z',
      submitted_data: {
        historicalSource: { source: 'wix', site: 'oasahk_org', form: 'contact_form', submissionId: 'wix-submission-42' },
        originalData: { answer: 'yes' },
      },
    })
    expect(await counts()).toMatchObject({ submissions: 1, audit: 1, domain_outbox: 0,
      notification_outbox: 0, deliveries: 0, consent: 0, tasks: 0 })

    const exactReplay = await f.job(columns, [original], 'operations')
    expect(await importer().resume(f.context, exactReplay.id)).toMatchObject({ status: 'completed', succeededRows: 1, failedRows: 0 })
    expect(await counts()).toMatchObject({ submissions: 1, audit: 1, domain_outbox: 0,
      notification_outbox: 0, deliveries: 0, consent: 0, tasks: 0 })

    const changed = [...original]
    changed[7] = '{"answer":"no"}'
    const conflict = await f.job(columns, [changed], 'operations')
    expect(await importer().resume(f.context, conflict.id)).toMatchObject({ status: 'completed', succeededRows: 0, failedRows: 1 })
    expect((await pool.query(`SELECT error_code,message FROM crm_import_errors WHERE job_id=$1`, [conflict.id])).rows)
      .toEqual([{ error_code: 'command_failed', message: 'Historical submission identity was already used with different evidence.' }])
    expect(await counts()).toMatchObject({ submissions: 1, audit: 1, domain_outbox: 0,
      notification_outbox: 0, deliveries: 0, consent: 0, tasks: 0 })

    const anotherForm = [...original]
    anotherForm[3] = 'application_form'
    const distinct = await f.job(columns, [anotherForm], 'operations')
    expect(await importer().resume(f.context, distinct.id)).toMatchObject({ status: 'completed', succeededRows: 1, failedRows: 0 })
    expect(await counts()).toMatchObject({ submissions: 2, audit: 2, domain_outbox: 0,
      notification_outbox: 0, deliveries: 0, consent: 0, tasks: 0 })
  })

  it('requires current owner or admin authority for member-file historical submissions', async () => {
    const f = await fixture(), contactId = await f.entity('person', 'Authority fixture')
    const columns = ['contactId', 'historicalSubmissionSource', 'historicalSubmissionSite',
      'historicalSubmissionForm', 'historicalSubmissionId', 'historicalSubmissionOccurredAt',
      'historicalSubmissionStatus', 'historicalSubmissionFieldsJson']
    const values = [contactId, 'wix', 'oasahk_org', 'contact_form', 'authority-row',
      '2020-01-01T00:00:00Z', 'resolved', '{}']
    const job = await f.job(columns, [values], 'operations')
    await pool.query(`UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2`, [f.workspaceId, f.userId])
    expect(await importer().resume(f.context, job.id)).toMatchObject({ status: 'completed', succeededRows: 0, failedRows: 1 })
    expect((await pool.query(`SELECT count(*)::int AS count FROM association_enquiries WHERE workspace_id=$1`, [f.workspaceId])).rows[0].count).toBe(0)
    const member = { ...f.context, authority: { ...f.context.authority, role: 'member' as const, canConfigure: false } }
    const nextId = randomUUID(), bytes = Buffer.from([columns.join(','), values.join(','), ''].join('\n'))
    files.set(nextId, bytes)
    await pool.query(`INSERT INTO workspace_files (id,workspace_id,path,name,storage_uri,created_by_user_id)
      VALUES ($1,$2,$3,'fixture.csv','fixture://local',$4)`, [nextId, f.workspaceId, `/fixture/${nextId}.csv`, f.userId])
    await expect(importer().dryRun(member, { stagedFileId: nextId, entityKind: 'operations',
      mapping: { columns: Object.fromEntries(columns.map((column, index) => [index, column])) } }))
      .rejects.toMatchObject({ code: 'not_authorized' })
  })

  it('imports Wix membership access with immutable source lineage and no provider authority or side effects', async () => {
    const f = await fixture(), contactId = await f.entity('person', 'Source membership person')
    const association = createAssociationStore(pool)
    const actor = { credentialKind: 'user' as const, credentialId: f.userId, actingUserId: f.userId }
    const plan = await association.upsertPlan(f.workspaceId, PlanInputSchema.parse({
      key: `source-plan-${f.workspaceId.slice(0, 8)}`, name: 'Source membership plan',
      currency: 'HKD', feeMinor: 120000, billingPeriod: 'annual', published: true,
    }), actor)
    const columns = [
      'contactId', 'entitlementPlanId', 'entitlementIdempotencyKey', 'entitlementStatus',
      'entitlementStartsAt', 'entitlementEndsAt', 'entitlementRenewalMode',
      'sourceMembershipSource', 'sourceMembershipSite', 'sourceMembershipId',
      'sourceMembershipPlanId', 'sourceMembershipMemberId', 'sourceMembershipOrderId',
      'sourceMembershipSubscriptionId', 'sourceMembershipPaymentProvider',
      'sourceMembershipPaymentReference', 'sourceMembershipStatus',
      'sourceMembershipRenewalStatus', 'sourceMembershipPaymentStatus',
      'sourceMembershipRefundStatus', 'sourceMembershipPurchasedAt',
      'sourceMembershipRelationshipsJson', 'sourceMembershipMetadataJson',
    ]
    const original = [
      contactId, String(plan.record.id), 'wix-membership:wix-membership-42', 'active',
      '2026-08-01T00:00:00Z', '2027-08-01T00:00:00Z', 'none',
      'wix', 'oasahk_org', 'wix-membership-42', 'wix-plan-annual', 'wix-member-42',
      'wix-order-42', 'wix-subscription-42', 'stripe', 'sub_wix_42', 'ACTIVE',
      'AUTO_RENEWING', 'PAID', 'NOT_REFUNDED', '2026-08-01T00:00:00Z',
      JSON.stringify({ companySourceId: 'wix-company-42', namedMemberSourceId: 'wix-member-42' }),
      JSON.stringify({ sourceRevision: 'rev-1' }),
    ]
    const first = await f.job(columns, [original], 'operations')
    expect(await importer().resume(f.context, first.id)).toMatchObject({ status: 'completed', succeededRows: 1, failedRows: 0 })
    const refs = (await pool.query(`SELECT result_refs FROM crm_import_rows
      WHERE workspace_id=$1 AND job_id=$2 AND row_number=2`, [f.workspaceId, first.id])).rows[0].result_refs
    expect(refs).toEqual(expect.arrayContaining([
      { kind: 'contact', id: contactId },
      { kind: 'entitlement', id: expect.stringMatching(/^[0-9a-f-]{36}$/), sourceId: 'wix-membership-42' },
    ]))
    const saved = (await pool.query(`SELECT m.id,m.status,m.renewal_mode,m.provider,m.provider_membership_id,
      m.provider_period_id,m.predecessor_id,s.source_system,s.source_site,s.source_membership_id,
      s.source_plan_id,s.source_member_id,s.source_order_id,s.source_subscription_id,
      s.source_payment_provider,s.source_payment_reference,s.source_status,s.source_renewal_status,
      s.source_payment_status,s.source_refund_status,s.relationships,s.metadata
      FROM association_memberships m JOIN association_membership_source_imports s
        ON s.workspace_id=m.workspace_id AND s.membership_id=m.id
      WHERE m.workspace_id=$1 AND s.source_membership_id='wix-membership-42'`, [f.workspaceId])).rows[0]
    expect(saved).toMatchObject({ status: 'active', renewal_mode: 'none', provider: null,
      provider_membership_id: null, provider_period_id: null, predecessor_id: null,
      source_system: 'wix', source_site: 'oasahk_org', source_membership_id: 'wix-membership-42',
      source_plan_id: 'wix-plan-annual', source_member_id: 'wix-member-42', source_order_id: 'wix-order-42',
      source_subscription_id: 'wix-subscription-42', source_payment_provider: 'stripe',
      source_payment_reference: 'sub_wix_42', source_status: 'ACTIVE',
      source_renewal_status: 'AUTO_RENEWING', source_payment_status: 'PAID',
      source_refund_status: 'NOT_REFUNDED',
      relationships: { companySourceId: 'wix-company-42', namedMemberSourceId: 'wix-member-42' },
      metadata: { sourceRevision: 'rev-1' } })
    expect((await pool.query(`SELECT
      (SELECT count(*) FROM association_notification_outbox WHERE workspace_id=$1)::int notifications,
      (SELECT count(*) FROM association_integration_events WHERE workspace_id=$1)::int provider_events,
      (SELECT count(*) FROM crm_domain_event_outbox WHERE workspace_id=$1)::int domain_events`,
    [f.workspaceId])).rows[0]).toEqual({ notifications: 0, provider_events: 0, domain_events: 0 })
    await expect(pool.query(`UPDATE association_membership_source_imports SET source_status='CHANGED'
      WHERE workspace_id=$1 AND source_membership_id='wix-membership-42'`, [f.workspaceId]))
      .rejects.toMatchObject({ code: '23514' })

    const replay = await f.job(columns, [original], 'operations')
    expect(await importer().resume(f.context, replay.id)).toMatchObject({ succeededRows: 1, failedRows: 0 })
    expect((await pool.query(`SELECT count(*)::int count FROM association_membership_source_imports
      WHERE workspace_id=$1`, [f.workspaceId])).rows[0].count).toBe(1)
    expect((await pool.query(`SELECT count(*)::int count FROM association_audit_log
      WHERE workspace_id=$1 AND action='membership.source_imported'`, [f.workspaceId])).rows[0].count).toBe(1)

    const changed = [...original]
    changed[columns.indexOf('sourceMembershipStatus')] = 'CANCELLED'
    const conflict = await f.job(columns, [changed], 'operations')
    expect(await importer().resume(f.context, conflict.id)).toMatchObject({ succeededRows: 0, failedRows: 1 })
    expect((await pool.query(`SELECT message FROM crm_import_errors WHERE job_id=$1`, [conflict.id])).rows)
      .toEqual([{ message: 'Source membership identity was already used with different evidence.' }])
  })

  it('imports source orders silently, reconciles capacity once, and protects source evidence across jobs', async () => {
    const f = await fixture()
    const buyerId = await f.entity('person', 'Source order buyer', { email: 'buyer@example.com' })
    const attendeeId = await f.entity('person', 'Source order attendee', { email: 'attendee@example.com' })
    const association = createAssociationStore(pool)
    const actor = { credentialKind: 'user' as const, credentialId: f.userId, actingUserId: f.userId }
    const event = await association.upsertEvent(f.workspaceId, EventInputSchema.parse({
      slug: `source-order-${f.workspaceId.slice(0, 8)}`, title: 'Future source booking',
      startsAt: '2099-01-01T12:00:00Z', endsAt: '2099-01-01T14:00:00Z',
      timezone: 'UTC', mode: 'venue', status: 'published', capacity: 2,
    }), actor)
    const ticket = await association.upsertTicket(f.workspaceId, String(event.record.id), TicketInputSchema.parse({
      key: 'standard', name: 'Standard', currency: 'HKD', priceMinor: 1_000,
      capacity: 2, status: 'closed',
    }), actor)
    const columns = [
      'contactId', 'sourceOrderSource', 'sourceOrderSite', 'sourceOrderId',
      'sourceOrderOccurredAt', 'sourceOrderStatus', 'sourceOrderCurrency',
      'sourceOrderSubtotalMinor', 'sourceOrderDiscountMinor', 'sourceOrderTotalMinor',
      'sourceOrderRefundedMinor', 'sourceOrderProvider', 'sourceOrderProviderReference',
      'sourceOrderLinesJson', 'sourceOrderMetadataJson',
    ]
    const lines = JSON.stringify([{ ticketId: ticket.record.id, quantity: 2,
      unitPriceMinor: 1_000, discountMinor: 400, lineTotalMinor: 1_600, attendees: [
        { sourceRegistrationId: 'booking-1', contactId: buyerId, name: 'Source order buyer', status: 'confirmed' },
        { sourceRegistrationId: 'booking-2', contactId: attendeeId, name: 'Source order attendee', email: 'attendee@example.com', status: 'confirmed' },
      ] }])
    const original = [buyerId, 'wix', 'oasahk_org', 'wix-order-42',
      '2026-08-01T10:00:00.123456Z', 'paid', 'HKD', '2000', '400', '1600', '200',
      'stripe', 'pi_wix_order_42', lines, '{"channel":"web"}']
    const counts = async () => (await pool.query(`SELECT
      (SELECT count(*) FROM association_orders WHERE workspace_id=$1 AND source_import)::int orders,
      (SELECT count(*) FROM association_registrations WHERE workspace_id=$1 AND source_kind='source_order')::int registrations,
      (SELECT count(*) FROM association_audit_log WHERE workspace_id=$1 AND action='order.source_imported')::int audit,
      (SELECT count(*) FROM association_notification_outbox WHERE workspace_id=$1)::int notifications,
      (SELECT count(*) FROM association_provider_events WHERE workspace_id=$1)::int provider_events,
      (SELECT count(*) FROM crm_domain_event_outbox WHERE workspace_id=$1)::int domain_events,
      (SELECT count(*) FROM crm_delivery_receipts WHERE workspace_id=$1)::int deliveries,
      (SELECT count(*) FROM association_consent_events WHERE workspace_id=$1)::int consent,
      (SELECT count(*) FROM tasks WHERE workspace_id=$1)::int tasks,
      COALESCE((SELECT used FROM association_inventory_boundaries WHERE workspace_id=$1 AND event_id=$2 AND ticket_id IS NULL),0)::int used`,
      [f.workspaceId, event.record.id])).rows[0]

    const first = await f.job(columns, [original], 'operations')
    expect(await importer().resume(f.context, first.id)).toMatchObject({ status: 'completed', succeededRows: 1, failedRows: 0 })
    const sourceOrderRefs = (await pool.query(`SELECT result_refs FROM crm_import_rows
      WHERE workspace_id=$1 AND job_id=$2 AND row_number=2`, [f.workspaceId, first.id])).rows[0].result_refs
    expect(sourceOrderRefs).toHaveLength(4)
    expect(sourceOrderRefs).toEqual(expect.arrayContaining([
      { kind: 'contact', id: buyerId },
      { kind: 'order', id: expect.stringMatching(/^[0-9a-f-]{36}$/), sourceId: 'wix-order-42' },
      { kind: 'registration', id: expect.stringMatching(/^[0-9a-f-]{36}$/), sourceId: 'booking-1' },
      { kind: 'registration', id: expect.stringMatching(/^[0-9a-f-]{36}$/), sourceId: 'booking-2' },
    ]))
    const saved = (await pool.query(`SELECT source_system,source_site,source_order_id,source_order_status,
      status,currency,subtotal_minor::text,discount_minor::text,total_minor::text,refunded_minor::text,
      refund_state,provider,provider_reference,source_import,
      to_char(source_occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') source_occurred_at
      FROM association_orders WHERE workspace_id=$1 AND source_import`, [f.workspaceId])).rows[0]
    expect(saved).toMatchObject({ source_system: 'wix', source_site: 'oasahk_org', source_order_id: 'wix-order-42',
      source_order_status: 'paid', status: 'paid', currency: 'HKD', subtotal_minor: '2000',
      discount_minor: '400', total_minor: '1600', refunded_minor: '200', refund_state: 'partial',
      provider: 'stripe', provider_reference: 'pi_wix_order_42', source_import: true,
      source_occurred_at: '2026-08-01T10:00:00.123456Z' })
    expect((await pool.query(`SELECT pricing_basis,quantity,unit_price_minor::text,discount_minor::text,line_total_minor::text
      FROM association_order_lines WHERE workspace_id=$1`, [f.workspaceId])).rows)
      .toEqual([{ pricing_basis: 'source', quantity: 2, unit_price_minor: '1000', discount_minor: '400', line_total_minor: '1600' }])
    expect((await pool.query(`SELECT status,source_kind,historical_import FROM association_registrations
      WHERE workspace_id=$1 ORDER BY attendee_name`, [f.workspaceId])).rows)
      .toEqual([{ status: 'confirmed', source_kind: 'source_order', historical_import: false },
        { status: 'confirmed', source_kind: 'source_order', historical_import: false }])
    await expect(pool.query(`UPDATE association_orders SET source_order_id='changed'
      WHERE workspace_id=$1 AND source_order_id='wix-order-42'`, [f.workspaceId]))
      .rejects.toMatchObject({ code: '23514' })
    await expect(pool.query(`INSERT INTO association_registrations(
        workspace_id,order_id,order_line_id,event_id,ticket_id,attendee_name,status,
        source_kind,source_id,request_fingerprint,historical_import)
      SELECT o.workspace_id,o.id,l.id,t.event_id,l.ticket_id,'Spoofed source attendee','confirmed',
        'source_order','spoofed-source-registration',repeat('a',64),false
      FROM association_orders o JOIN association_order_lines l
        ON l.workspace_id=o.workspace_id AND l.order_id=o.id
      JOIN association_ticket_types t
        ON t.workspace_id=l.workspace_id AND t.id=l.ticket_id
      WHERE o.workspace_id=$1 AND o.source_order_id='wix-order-42'`, [f.workspaceId]))
      .rejects.toMatchObject({ code: '23514' })
    expect(await counts()).toMatchObject({ orders: 1, registrations: 2, audit: 1, notifications: 0,
      provider_events: 0, domain_events: 0, deliveries: 0, consent: 0, tasks: 0, used: 2 })

    const replay = await f.job(columns, [original], 'operations')
    expect(await importer().resume(f.context, replay.id)).toMatchObject({ status: 'completed', succeededRows: 1, failedRows: 0 })
    expect(await counts()).toMatchObject({ orders: 1, registrations: 2, audit: 1, used: 2 })

    const changedLines = JSON.stringify([{ ...JSON.parse(lines)[0], discountMinor: 500, lineTotalMinor: 1_500 }])
    const changed = [...original]
    changed[8] = '500'; changed[9] = '1500'; changed[13] = changedLines
    const conflict = await f.job(columns, [changed], 'operations')
    expect(await importer().resume(f.context, conflict.id)).toMatchObject({ status: 'completed', succeededRows: 0, failedRows: 1 })
    expect((await pool.query(`SELECT message FROM crm_import_errors WHERE job_id=$1`, [conflict.id])).rows)
      .toEqual([{ message: 'Source order identity was already used with different evidence.' }])

    const overflowLines = JSON.stringify([{ ticketId: ticket.record.id, quantity: 1,
      unitPriceMinor: 1_000, discountMinor: 0, lineTotalMinor: 1_000,
      attendees: [{ sourceRegistrationId: 'booking-3', name: 'Overflow attendee', status: 'confirmed' }] }])
    const overflow = [...original]
    overflow[3] = 'wix-order-43'; overflow[7] = '1000'; overflow[8] = '0'; overflow[9] = '1000';
    overflow[10] = '0'; overflow[12] = 'pi_wix_order_43'; overflow[13] = overflowLines
    const capacity = await f.job(columns, [overflow], 'operations')
    expect(await importer().resume(f.context, capacity.id)).toMatchObject({ status: 'completed', succeededRows: 0, failedRows: 1 })
    expect((await pool.query(`SELECT message FROM crm_import_errors WHERE job_id=$1`, [capacity.id])).rows[0].message)
      .toBe('Source order exceeds current ticket capacity.')
    expect(await counts()).toMatchObject({ orders: 1, registrations: 2, audit: 1, used: 2 })
  })

  it('imports digest-only Wix promotions with source usage and replay-safe receipts', async () => {
    const f = await fixture(), contactId = await f.entity('person', 'Promotion history contact')
    const association = createAssociationStore(pool, undefined, { promotionHmacKey })
    const actor = { credentialKind: 'user' as const, credentialId: f.userId, actingUserId: f.userId }
    const event = await association.upsertEvent(f.workspaceId, EventInputSchema.parse({
      slug: `promotion-import-${f.workspaceId.slice(0, 8)}`, title: 'Promotion import target',
      startsAt: '2099-01-01T12:00:00Z', endsAt: '2099-01-01T14:00:00Z',
      timezone: 'UTC', mode: 'venue', status: 'published', capacity: 10,
    }), actor)
    const code = 'WIX-HISTORY-10'
    const digest = createHmac('sha256', promotionHmacKey).update(code, 'utf8').digest('hex')
    const columns = [
      'promotionSource', 'promotionSite', 'promotionId', 'promotionKey', 'promotionName',
      'promotionCodeDigest', 'promotionDiscountType', 'promotionPercentageBasisPoints',
      'promotionTargetKind', 'promotionTargetIdsJson', 'promotionMaxUses', 'promotionMaxUsesPerContact',
      'promotionCombinesWithMemberPrice', 'promotionReleaseOnFullRefund', 'promotionStatus',
      'promotionSourceRedeemedUses', 'promotionSourceContactUsesJson',
    ]
    const original = [
      'wix', 'oasahk.org', 'wix-coupon-history-10', 'history-ten', 'Historical 10%', digest,
      'percentage', '1000', 'event', JSON.stringify([event.record.id]), '10', '1', 'false', 'false',
      'active', '1', JSON.stringify([{ contactId, uses: 1 }]),
    ]
    const first = await f.job(columns, [original], 'operations')
    expect(await importer().resume(f.context, first.id)).toMatchObject({
      status: 'completed', succeededRows: 1, failedRows: 0,
    })
    const receipt = (await pool.query(`SELECT result_refs FROM crm_import_rows
      WHERE workspace_id=$1 AND job_id=$2 AND row_number=2`, [f.workspaceId, first.id])).rows[0]
    expect(receipt.result_refs).toEqual([{
      kind: 'promotion', id: expect.stringMatching(/^[0-9a-f-]{36}$/), sourceId: 'wix-coupon-history-10',
    }])
    const saved = (await pool.query(`SELECT id,code_digest,source_system,source_site,source_promotion_id,
      source_redeemed_uses,source_import FROM association_promotions WHERE workspace_id=$1`, [f.workspaceId])).rows[0]
    expect(saved).toMatchObject({ code_digest: digest, source_system: 'wix', source_site: 'oasahk.org',
      source_promotion_id: 'wix-coupon-history-10', source_redeemed_uses: 1,
      source_import: { jobId: first.id, row: 2, fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) } })
    expect(JSON.stringify(saved)).not.toContain(code)

    const replay = await f.job(columns, [original], 'operations')
    expect(await importer().resume(f.context, replay.id)).toMatchObject({ succeededRows: 1, failedRows: 0 })
    expect((await pool.query(`SELECT count(*)::int count FROM association_promotions
      WHERE workspace_id=$1`, [f.workspaceId])).rows[0].count).toBe(1)
    expect((await pool.query(`SELECT count(*)::int count FROM association_audit_log
      WHERE workspace_id=$1 AND action='promotion.source_imported'`, [f.workspaceId])).rows[0].count).toBe(1)

    const changed = [...original]
    changed[4] = 'Changed source evidence'
    const conflict = await f.job(columns, [changed], 'operations')
    expect(await importer().resume(f.context, conflict.id)).toMatchObject({ succeededRows: 0, failedRows: 1 })
    expect((await pool.query(`SELECT message FROM crm_import_errors WHERE job_id=$1`, [conflict.id])).rows)
      .toEqual([{ message: 'Source promotion identity was already used with different evidence.' }])
  })

  it('keeps ended source bookings historical and rechecks owner authority at commit', async () => {
    const f = await fixture(), contactId = await f.entity('person', 'Historical booking person')
    const association = createAssociationStore(pool)
    const actor = { credentialKind: 'user' as const, credentialId: f.userId, actingUserId: f.userId }
    const event = await association.upsertEvent(f.workspaceId, EventInputSchema.parse({
      slug: `past-source-${f.workspaceId.slice(0, 8)}`, title: 'Past source booking',
      startsAt: '2020-01-01T12:00:00Z', endsAt: '2020-01-01T14:00:00Z',
      timezone: 'UTC', mode: 'venue', status: 'completed', capacity: 1,
    }), actor)
    const ticket = await association.upsertTicket(f.workspaceId, String(event.record.id), TicketInputSchema.parse({
      key: 'archive', name: 'Archive', currency: 'HKD', priceMinor: 500, capacity: 1, status: 'closed',
    }), actor)
    const columns = ['contactId', 'sourceOrderSource', 'sourceOrderSite', 'sourceOrderId',
      'sourceOrderOccurredAt', 'sourceOrderStatus', 'sourceOrderCurrency', 'sourceOrderSubtotalMinor',
      'sourceOrderTotalMinor', 'sourceOrderProvider', 'sourceOrderProviderReference', 'sourceOrderLinesJson']
    const row = [contactId, 'wix', 'oasahk_org', 'past-order-1', '2019-12-01T00:00:00Z',
      'paid', 'HKD', '500', '500', 'stripe', 'pi_past_order_1', JSON.stringify([{
        ticketId: ticket.record.id, quantity: 1, unitPriceMinor: 500, lineTotalMinor: 500,
        attendees: [{ sourceRegistrationId: 'past-booking-1', contactId, name: 'Historical booking person',
          status: 'checked_in', checkedInAt: '2020-01-01T12:15:00Z' }],
      }])]
    const historical = await f.job(columns, [row], 'operations')
    expect(await importer().resume(f.context, historical.id)).toMatchObject({ succeededRows: 1, failedRows: 0 })
    expect((await pool.query(`SELECT historical_import,status,checked_in_at IS NOT NULL checked_in
      FROM association_registrations WHERE workspace_id=$1 AND event_id=$2`, [f.workspaceId, event.record.id])).rows)
      .toEqual([{ historical_import: true, status: 'checked_in', checked_in: true }])
    expect((await pool.query(`SELECT used FROM association_inventory_boundaries
      WHERE workspace_id=$1 AND event_id=$2 AND ticket_id IS NULL`, [f.workspaceId, event.record.id])).rows[0].used).toBe(0)

    const pending = [...row]
    pending[3] = 'past-order-2'; pending[10] = 'pi_past_order_2'
    const authority = await f.job(columns, [pending], 'operations')
    await pool.query(`UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2`, [f.workspaceId, f.userId])
    expect(await importer().resume(f.context, authority.id)).toMatchObject({ status: 'completed', succeededRows: 0, failedRows: 1 })
    expect((await pool.query(`SELECT count(*)::int count FROM association_orders WHERE workspace_id=$1 AND source_order_id='past-order-2'`, [f.workspaceId])).rows[0].count).toBe(0)
  })

  it('finishes file I/O before borrowing the only transaction connection', async () => {
    const f = await fixture(), job = await f.job(consentColumns, [row(0)])
    const single = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 1000 })
    const boundedFiles = { readBytes: async (ctx: unknown, id: string) => {
      await single.query('SELECT 1')
      return filesApi.readBytes(ctx as Parameters<FilesApi['readBytes']>[0], id)
    } } as unknown as FilesApi
    try {
      const service = createCrmProductionImportService({ pool: single, filesApi: boundedFiles,
        operationsForTransaction: (client) => createCrmOperationsService(createDbCrmOperationsStore(single, client)) })
      expect(await service.resume(f.context, job.id)).toMatchObject({ status: 'completed', succeededRows: 1 })
    } finally { await single.end() }
  })

  it('serializes concurrent resume and cancellation across a 50-row boundary', async () => {
    const f = await fixture(), job = await f.job(consentColumns, Array.from({ length: 51 }, (_, i) => row(i)))
    let enter!: () => void, release!: () => void
    const ready = new Promise<void>((resolve) => { enter = resolve }), gate = new Promise<void>((resolve) => { release = resolve })
    let held = false
    const first = importer(async () => { if (!held) { held = true; enter(); await gate } }).resume(f.context, job.id)
    let cancellation: ReturnType<ReturnType<typeof importer>['cancel']> | undefined
    try {
      await Promise.race([ready, first.then(() => { throw new Error('Import ended before barrier') })])
      expect(await f.counts()).toMatchObject({ entities: 0, consent: 0, receipts: 0, chunks: 0 })
      await expect(importer().resume(f.context, job.id)).rejects.toMatchObject({ code: 'conflict', details: { reason: 'import_processing' } })
      const other = await fixture(), otherJob = await other.job(consentColumns, [row(0)])
      expect(await importer().resume(other.context, otherJob.id)).toMatchObject({ status: 'completed', succeededRows: 1 })
      cancellation = importer().cancel(f.context, job.id)
      let locked = false
      const until = Date.now() + 5000
      while (Date.now() < until) {
        const r = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE application_name='crm_atomic_import_fixture'
          AND wait_event_type='Lock' AND (query LIKE '%UPDATE crm_import_jobs SET status=%'
            OR query='SELECT id FROM workspaces WHERE id=$1 AND department_read_v2 FOR UPDATE')`)
        if (r.rowCount) { locked = true; break }
        await setTimeout(10)
      }
      expect(locked).toBe(true)
    } finally { release(); await Promise.allSettled([first, ...(cancellation ? [cancellation] : [])]) }
    expect(await first).toMatchObject({ status: 'paused', processedRows: 50, succeededRows: 50 })
    expect(await cancellation).toMatchObject({ status: 'cancelled', processedRows: 50 })
    expect(await importer().resume(f.context, job.id)).toMatchObject({ status: 'cancelled', processedRows: 50 })
    expect(await f.counts()).toMatchObject({ entities: 50, consent: 50, receipts: 50, chunks: 1, outbox: 50 })
  })

  it('rolls back committed row savepoints if the chunk checkpoint fails, then retries without double counters', async () => {
    const f = await fixture(), job = await f.job(consentColumns, [row(0), row(1)])
    const trigger = `crm_import_fixture_${randomUUID().replaceAll('-', '')}`
    await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.workspace_id='${f.workspaceId}'::uuid AND NEW.status='completed' THEN
        RAISE EXCEPTION 'Fixture checkpoint serialization failure' USING ERRCODE='40001';
      END IF; RETURN NEW; END $$`)
    await pool.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON crm_import_chunks FOR EACH ROW EXECUTE FUNCTION ${trigger}()`)
    const before = await f.counts()
    try {
      await expect(importer().resume(f.context, job.id)).rejects.toMatchObject({ code: '40001' })
      expect(await f.counts()).toEqual(before)
    } finally {
      await pool.query(`DROP TRIGGER ${trigger} ON crm_import_chunks`)
      await pool.query(`DROP FUNCTION ${trigger}()`)
    }
    const service = importer()
    expect(await service.resume(f.context, job.id)).toMatchObject({ status: 'completed', processedRows: 2, succeededRows: 2, failedRows: 0 })
    const committed = await f.counts()
    expect(committed).toMatchObject({ entities: 2, consent: 2, receipts: 2, chunks: 1, outbox: 2 })
    await service.resume(f.context, job.id)
    expect(await f.counts()).toEqual(committed)
  })

  it.each(['company', 'deal'] as const)('rolls back %s record changes when a later command rejects the row', async (kind) => {
    const f = await fixture(), company = await f.entity('company', 'Fixture company', { domain: 'original.example', tags: ['original'] })
    const person = await f.entity('person', 'Fixture person', { email: 'fixture@example.com' })
    await pool.query(`INSERT INTO crm_field_definitions (workspace_id,entity_kind,field_key,label,field_type)
      VALUES ($1,$2,'score','Score','number')`, [f.workspaceId, kind])
    const job = await f.job(['name', 'domain', 'contactId', 'companyId', 'custom:score', 'consentPurposeKey', 'consentAction', 'consentSource'],
      [['Fixture company', 'changed.example', person, company, '7', 'updates', 'granted', 'fixture']], kind)
    const before = (await pool.query('SELECT id,display_name,attributes FROM entities WHERE workspace_id=$1 ORDER BY id', [f.workspaceId])).rows
    expect(await importer(async () => { throw new Error('Fixture later command rejected') }).resume(f.context, job.id)).toMatchObject({ status: 'completed', succeededRows: 0, failedRows: 1 })
    expect((await pool.query('SELECT id,display_name,attributes FROM entities WHERE workspace_id=$1 ORDER BY id', [f.workspaceId])).rows).toEqual(before)
    expect(await f.counts()).toMatchObject({ entities: 2, consent: 0, receipts: 1, errors: 1, audit: 1, outbox: 0 })
  })

  it('refuses stale trusted-source authority and ambiguous normalized email without minting another person', async () => {
    const f = await fixture()
    await f.entity('person', 'First fixture', { email: ' fixture@example.com ' })
    await f.entity('person', 'Second fixture', { email: 'FIXTURE@example.com' })
    const job = await f.job(consentColumns, [['Updated fixture', 'fixture@example.com', 'updates', 'granted', 'fixture']], 'contact', 'fixture')
    await pool.query(`UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2`, [f.workspaceId, f.userId])
    await expect(importer().resume(f.context, job.id)).rejects.toMatchObject({ code: 'not_authorized' })
    await pool.query(`UPDATE workspace_members SET role='owner' WHERE workspace_id=$1 AND user_id=$2`, [f.workspaceId, f.userId])
    expect(await importer().resume(f.context, job.id)).toMatchObject({ status: 'completed', succeededRows: 0, failedRows: 1 })
    expect(await f.counts()).toMatchObject({ entities: 2, consent: 0, outbox: 0 })
    expect(await importer().errorsCsv(f.context, job.id)).toContain('Multiple live contacts match this email')
  })
})

/** [COMP:crm/operations-pagination] Effective access and raw lifecycle evidence. */
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { createDbCrmIntakeReadStore } from '../crm-intake-store.js'
import { createDbCrmSegmentStore } from '../crm-segment-store.js'
import { createAssociationStore } from '../association-store.js'
import { EventInputSchema, OrderCreateSchema, TicketInputSchema } from '../../association/domain.js'
import { getPool } from '../client.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const reads = createDbCrmIntakeReadStore()
const commerce = createAssociationStore(pool)
async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID(), planId = randomUUID(), contactId = randomUUID()
  await pool.query('INSERT INTO users (id,auth_provider_id) VALUES ($1::uuid,$1::text)', [userId])
  await pool.query(`INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'Entitlement fixture',$2)`, [workspaceId, userId])
  await pool.query(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'owner')`, [workspaceId,userId])
  await pool.query(`INSERT INTO entities (id,workspace_id,kind,display_name,created_by_user_id,source) VALUES ($1,$2,'person','Fixture person',$3,'manual')`, [contactId, workspaceId, userId])
  await pool.query(`INSERT INTO association_membership_plans (id,workspace_id,plan_key,name,currency,fee_minor,billing_period)
    VALUES ($1,$2,'member','Member','USD',0,'manual')`, [planId, workspaceId])
  const actor = { credentialKind: 'user' as const, credentialId: userId, actingUserId: userId }
  return { workspaceId, userId, contactId, planId, actor }
}

describe('[COMP:crm/operations-pagination] Actual effective entitlement predicate', () => {
  afterAll(async () => { await Promise.all([pool.end(), getPool().end()]) })
  it('uses inclusive starts and exclusive ends, keeping raw state and all filtered pages', async () => {
    const f = await fixture(), at = '2026-01-02T00:00:00.123456Z'
    const predicate = await pool.query(`SELECT
      crm_entitlement_is_effective('active',$1,$2,$1) AS at_start,
      crm_entitlement_is_effective('active',$1,$2,$2) AS at_end,
      crm_entitlement_is_effective('active',$1,NULL,$2) AS open_end,
      crm_entitlement_is_effective('pending',$1,NULL,$2) AS pending,
      crm_entitlement_is_effective('expired',$1,NULL,$2) AS expired,
      crm_entitlement_is_effective('cancelled',$1,NULL,$2) AS cancelled,
      crm_entitlement_is_effective('active',NULL,NULL,$2) AS missing_start,
      crm_entitlement_is_effective('active',$1,NULL,NULL) AS missing_instant`, [at, '2026-01-02T00:00:00.123457Z'])
    expect(predicate.rows[0]).toEqual({ at_start: true, at_end: false, open_end: true, pending: false, expired: false, cancelled: false, missing_start: false, missing_instant: false })
    await pool.query(`INSERT INTO association_memberships (workspace_id,contact_id,plan_id,idempotency_key,request_fingerprint,status,starts_at,ends_at)
      SELECT $1,$2,$3,'fixture-'||n,repeat('a',64),'active',$4,NULL FROM generate_series(1,105) n`, [f.workspaceId, f.contactId, f.planId, at])
    await pool.query(`INSERT INTO association_memberships (workspace_id,contact_id,plan_id,idempotency_key,request_fingerprint,status,starts_at,ends_at)
      VALUES ($1,$2,$3,'future',repeat('a',64),'active','2099-01-01T00:00:00Z',NULL),
             ($1,$2,$3,'past',repeat('a',64),'active','2020-01-01T00:00:00Z',$4)`, [f.workspaceId, f.contactId, f.planId, at])
    const ids: unknown[] = []
    let cursor: string | undefined
    do {
      const page = await reads.listEntitlements(f.workspaceId, { activeOnly: true, effectiveAt: at, limit: 17, cursor })
      expect(page.entitlements.every((row) => row.isEffective === true && row.effectiveAt === at)).toBe(true)
      ids.push(...page.entitlements.map((row) => row.id))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(new Set(ids).size).toBe(105)
    const raw = await commerce.listMemberships(f.workspaceId, f.contactId, { effectiveAt: at })
    expect(raw).toHaveLength(107)
    expect(raw.filter((row) => row.status === 'active' && row.isEffective === false)).toHaveLength(2)
    expect(await commerce.listMemberships(f.workspaceId, f.contactId, { activeOnly: true, effectiveAt: at })).toHaveLength(105)
    const first = await reads.listEntitlements(f.workspaceId, { activeOnly: true, limit: 1 })
    const next = await reads.listEntitlements(f.workspaceId, { activeOnly: true, limit: 2, cursor: first.nextCursor! })
    expect(next.entitlements.every((row) => row.effectiveAt === first.entitlements[0].effectiveAt)).toBe(true)
    const encoded = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8'))
    expect(encoded.evaluatedAt).toBe(first.entitlements[0].effectiveAt)
    await expect(reads.listEntitlements(f.workspaceId, { activeOnly: false, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(reads.listEntitlements(f.workspaceId, { activeOnly: true, effectiveAt: at, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'invalid_input' })
    const historical = await reads.listEntitlements(f.workspaceId, { activeOnly: true, limit: 1, effectiveAt: at })
    await expect(reads.listEntitlements(f.workspaceId, { activeOnly: true, effectiveAt: '2026-01-01T19:00:00.123456-05:00', cursor: historical.nextCursor! })).resolves.toBeDefined()
  })

  it('shares effective access between segment membership and current member pricing', async () => {
    const f = await fixture(), future = randomUUID(), past = randomUUID()
    for (const id of [future, past]) await pool.query(`INSERT INTO entities (id,workspace_id,kind,display_name,created_by_user_id,source)
      VALUES ($1,$2,'person','Fixture person',$3,'manual')`, [id, f.workspaceId, f.userId])
    await pool.query(`INSERT INTO association_memberships (workspace_id,contact_id,plan_id,idempotency_key,request_fingerprint,status,starts_at,ends_at)
      VALUES ($1,$2,$5,'current',repeat('a',64),'active','2020-01-01T00:00:00Z',NULL),
             ($1,$2,$5,'next-period',repeat('a',64),'active','2098-01-01T00:00:00Z',NULL),
             ($1,$3,$5,'future',repeat('a',64),'active','2098-01-01T00:00:00Z',NULL),
             ($1,$4,$5,'past',repeat('a',64),'active','2000-01-01T00:00:00Z','2002-01-01T00:00:00Z')`, [f.workspaceId, f.contactId, future, past, f.planId])
    const segmentId = randomUUID()
    const predicate = { type: 'group', combinator: 'and', items: [
      { type: 'rule', family: 'entitlement', field: 'member', operator: 'eq', value: 'active' },
    ] }
    await pool.query(`INSERT INTO crm_segments (id,workspace_id,segment_key,name,entity_kind,predicate)
      VALUES ($1,$2,'current_members','Current members','person',$3)`, [segmentId, f.workspaceId, JSON.stringify(predicate)])
    const segment = await createDbCrmSegmentStore().previewSegment(f.workspaceId, segmentId)
    expect(segment.snapshotIds).toEqual([f.contactId])
    expect(segment.count).toBe(1)
    await pool.query(`UPDATE workspace_modules SET state='enabled' WHERE workspace_id=$1 AND module_key='association'`, [f.workspaceId])
    const event = await commerce.upsertEvent(f.workspaceId, EventInputSchema.parse({ slug: 'fixture-event', title: 'Fixture event', startsAt: '2099-01-01T12:00:00Z', endsAt: '2099-01-01T14:00:00Z', timezone: 'UTC', mode: 'venue', status: 'published', capacity: 20 }), f.actor)
    const ticket = await commerce.upsertTicket(f.workspaceId, String(event.record.id), TicketInputSchema.parse({ key: 'member', name: 'Member ticket', currency: 'USD', priceMinor: 100, memberPriceMinor: 25, eligiblePlanKeys: ['member'], status: 'on_sale', capacity: 20 }), f.actor)
    const input = (contactId: string) => OrderCreateSchema.parse({ contactId, idempotencyKey: randomUUID(), lines: [{ ticketId: ticket.record.id, quantity: 1, useMemberPrice: true, attendees: [{ name: 'Fixture attendee' }] }] })
    expect((await commerce.createOrder(f.workspaceId, input(f.contactId), f.actor)).record.totalMinor).toBe('25')
    // A successful historical read is not a present-day commerce authorization.
    expect((await reads.listEntitlements(f.workspaceId, { contactId: past, activeOnly: true, effectiveAt: '2001-01-01T00:00:00Z' })).entitlements).toHaveLength(1)
    for (const id of [future, past]) await expect(commerce.createOrder(f.workspaceId, input(id), f.actor)).rejects.toMatchObject({ code: 'member_price_ineligible' })
    await pool.query(`UPDATE association_memberships SET status='cancelled' WHERE workspace_id=$1 AND contact_id=$2 AND idempotency_key='current'`, [f.workspaceId, f.contactId])
    await expect(commerce.createOrder(f.workspaceId, input(f.contactId), f.actor)).rejects.toMatchObject({ code: 'member_price_ineligible' })
    expect((await createDbCrmSegmentStore().previewSegment(f.workspaceId, segmentId)).count).toBe(0)
  })

  it('enforces restricted admission for the buyer and each distinct attendee and retains its evidence', async () => {
    const f = await fixture()
    const attendeeOne = randomUUID(), attendeeTwo = randomUUID(), guest = randomUUID()
    for (const [id, name] of [[attendeeOne, 'First member'], [attendeeTwo, 'Second member'], [guest, 'Guest']]) {
      await pool.query(`INSERT INTO entities (id,workspace_id,kind,display_name,created_by_user_id,source)
        VALUES ($1,$2,'person',$3,$4,'manual')`, [id, f.workspaceId, name, f.userId])
    }
    const memberships = await pool.query<{ id: string; contact_id: string }>(`INSERT INTO association_memberships
      (workspace_id,contact_id,plan_id,idempotency_key,request_fingerprint,status,starts_at,ends_at)
      VALUES ($1,$2,$5,'buyer',repeat('a',64),'active','2020-01-01T00:00:00Z',NULL),
             ($1,$3,$5,'attendee-one',repeat('b',64),'active','2020-01-01T00:00:00Z',NULL),
             ($1,$4,$5,'attendee-two',repeat('c',64),'active','2020-01-01T00:00:00Z',NULL)
      RETURNING id,contact_id`, [f.workspaceId, f.contactId, attendeeOne, attendeeTwo, f.planId])
    await pool.query(`UPDATE workspace_modules SET state='enabled' WHERE workspace_id=$1 AND module_key='association'`, [f.workspaceId])
    const event = await commerce.upsertEvent(f.workspaceId, EventInputSchema.parse({ slug: 'restricted-event', title: 'Restricted event', startsAt: '2099-01-01T12:00:00Z', endsAt: '2099-01-01T14:00:00Z', timezone: 'UTC', mode: 'venue', status: 'published', capacity: 20 }), f.actor)
    const ticket = await commerce.upsertTicket(f.workspaceId, String(event.record.id), TicketInputSchema.parse({
      key: 'member', name: 'Member ticket', currency: 'USD', priceMinor: 100, memberPriceMinor: 25,
      eligiblePlanKeys: ['member'], eligibilityRequired: true, eligibilityScope: 'buyer_and_attendees', status: 'on_sale', capacity: 20,
    }), f.actor)
    expect(ticket.record).toMatchObject({ eligibilityScope: 'buyer_and_attendees' })
    const input = (contacts: Array<string | undefined>, useMemberPrice = true) => OrderCreateSchema.parse({
      contactId: f.contactId, idempotencyKey: randomUUID(), lines: [{ ticketId: ticket.record.id,
        quantity: contacts.length, useMemberPrice, attendees: contacts.map((contactId, index) => ({
          ...(contactId ? { contactId } : {}), name: `Attendee ${index + 1}`,
        })) }],
    })
    const created = await commerce.createOrder(f.workspaceId, input([attendeeOne, attendeeTwo]), f.actor)
    expect(created.record).toMatchObject({
      totalMinor: '50',
      lines: [{ pricingBasis: 'member', eligibleMembershipId: memberships.rows.find(row => row.contact_id === f.contactId)?.id }],
    })
    const registrationEvidence = (created.record.registrations as Array<Record<string, unknown>>)
      .map(row => [row.attendeeContactId, row.eligibleMembershipId])
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
    expect(registrationEvidence).toEqual([
      [attendeeOne, memberships.rows.find(row => row.contact_id === attendeeOne)?.id],
      [attendeeTwo, memberships.rows.find(row => row.contact_id === attendeeTwo)?.id],
    ].sort(([left], [right]) => String(left).localeCompare(String(right))))
    await expect(commerce.createOrder(f.workspaceId, input([attendeeOne, guest]), f.actor))
      .rejects.toMatchObject({ code: 'attendee_membership_ineligible', details: { attendeeIndex: 1 } })
    await expect(commerce.createOrder(f.workspaceId, input([attendeeOne, attendeeOne]), f.actor))
      .rejects.toMatchObject({ code: 'attendee_membership_ineligible', details: { attendeeIndex: 1 } })
    await expect(commerce.createOrder(f.workspaceId, input([attendeeOne], false), f.actor))
      .rejects.toMatchObject({ code: 'member_price_ineligible' })
    await pool.query("UPDATE association_memberships SET status='cancelled' WHERE workspace_id=$1 AND contact_id=$2", [f.workspaceId, attendeeTwo])
    await expect(commerce.createOrder(f.workspaceId, input([attendeeOne, attendeeTwo]), f.actor))
      .rejects.toMatchObject({ code: 'attendee_membership_ineligible', details: { attendeeIndex: 1 } })
  })
})

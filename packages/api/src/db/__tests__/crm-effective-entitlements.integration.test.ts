/** [COMP:crm/operations-pagination] Effective access and raw lifecycle evidence. */
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { createDbCrmIntakeReadStore } from '../crm-intake-store.js'
import { createDbCrmSegmentStore } from '../crm-segment-store.js'
import { getPool } from '../client.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const reads = createDbCrmIntakeReadStore()
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
    const raw = []
    let rawCursor: string | undefined
    do {
      const page = await reads.listEntitlements(f.workspaceId, { contactId: f.contactId, effectiveAt: at, limit: 100, cursor: rawCursor })
      raw.push(...page.entitlements)
      rawCursor = page.nextCursor ?? undefined
    } while (rawCursor)
    expect(raw).toHaveLength(107)
    expect(raw.filter(row => row.status === 'active' && row.isEffective === false)).toHaveLength(2)
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

  it('uses current effective access for segment membership', async () => {
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
    // Historical entitlement reads do not change current segment membership.
    expect((await reads.listEntitlements(f.workspaceId, { contactId: past, activeOnly: true, effectiveAt: '2001-01-01T00:00:00Z' })).entitlements).toHaveLength(1)
    await pool.query(`UPDATE association_memberships SET status='cancelled' WHERE workspace_id=$1 AND contact_id=$2 AND idempotency_key='current'`, [f.workspaceId, f.contactId])
    expect((await createDbCrmSegmentStore().previewSegment(f.workspaceId, segmentId)).count).toBe(0)
  })
})

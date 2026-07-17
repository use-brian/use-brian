import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import pg from 'pg'

/**
 * Integration test for the entity-backed CRM invariants after the
 * CRM→entity unification (docs/architecture/features/crm.md). A
 * contact/company/deal IS an `entities` row: kind ∈ {person,company,deal},
 * name → display_name, email/domain → canonical_id + attributes, remaining
 * typed fields + relationship FKs in `attributes`. (Replaces the old
 * migration-127 entity_id-FK schema test — that column is gone.) Skips
 * silently when the DB is unavailable.
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'Use Brian', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query('SELECT 1 FROM entities LIMIT 1')
    } finally {
      client.release()
    }
    pool = p
    return true
  } catch {
    await p.end().catch(() => {})
    return false
  }
}

const ok = await canConnect()
const describeIf = ok ? describe : describe.skip

afterAll(async () => {
  if (pool) await pool.end()
})

async function makeUser(client: pg.PoolClient): Promise<string> {
  const r = await client.query(
    `INSERT INTO users (id, auth_provider, auth_provider_id)
     VALUES (gen_random_uuid(), 'test', 'crm-inv-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'crm-inv-ws', 'test', $1, true)
     RETURNING id`,
    [ownerId],
  )
  return r.rows[0].id
}

async function addMember(client: pg.PoolClient, workspaceId: string, userId: string): Promise<void> {
  await client.query(
    `INSERT INTO workspace_members (id, workspace_id, user_id, role)
     VALUES (gen_random_uuid(), $1, $2, 'owner')`,
    [workspaceId, userId],
  )
}

type RawEntity = { kind: string; displayName: string; canonicalId: string | null; attributes: Record<string, unknown> }
async function readEntity(id: string): Promise<RawEntity | null> {
  const r = await pool!.query<RawEntity>(
    `SELECT kind, display_name AS "displayName", canonical_id AS "canonicalId", attributes
       FROM entities WHERE id = $1`,
    [id],
  )
  return r.rows[0] ?? null
}

describeIf('[COMP:crm/entity-invariants] CRM records are entities', () => {
  let crm: typeof import('../crm.js')
  let userId: string
  let workspaceId: string

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    crm = await import('../crm.js')
  })

  beforeEach(async () => {
    const client = await pool!.connect()
    try {
      userId = await makeUser(client)
      workspaceId = await makeWorkspace(client, userId)
      await addMember(client, workspaceId, userId)
    } finally {
      client.release()
    }
  })

  it('createCompany writes a kind=company entity with canonical_id=domain', async () => {
    const c = await crm.createCompany(userId, {
      workspaceId, name: 'Acme Corp', domain: 'acme.example', tags: ['vip'],
    })
    const e = await readEntity(c.id)
    expect(e!.kind).toBe('company')
    expect(e!.displayName).toBe('Acme Corp')
    expect(e!.canonicalId).toBe('acme.example')
    expect(e!.attributes.domain).toBe('acme.example')
    expect(e!.attributes.tags).toEqual(['vip'])
  })

  it('createContact writes a kind=person entity with canonical_id=email + attributes', async () => {
    const c = await crm.createContact(userId, {
      workspaceId, name: 'Sam Lee', email: 'sam@acme.example', phone: '+1-555-0100',
    })
    const e = await readEntity(c.id)
    expect(e!.kind).toBe('person')
    expect(e!.canonicalId).toBe('sam@acme.example')
    expect(e!.attributes.email).toBe('sam@acme.example')
    expect(e!.attributes.phone).toBe('+1-555-0100')
  })

  it('createContact without email leaves canonical_id null', async () => {
    const c = await crm.createContact(userId, { workspaceId, name: 'No Email' })
    expect((await readEntity(c.id))!.canonicalId).toBeNull()
  })

  it('createDeal writes a kind=deal entity; typed fields + FKs in attributes', async () => {
    const company = await crm.createCompany(userId, { workspaceId, name: 'Acme' })
    const contact = await crm.createContact(userId, { workspaceId, name: 'Sam' })
    const d = await crm.createDeal(userId, {
      workspaceId, contactId: contact.id, companyId: company.id, stage: 'proposal', amount: 50000,
    })
    const e = await readEntity(d.id)
    expect(e!.kind).toBe('deal')
    expect(e!.displayName).toBe('Deal - Acme')
    expect(e!.attributes.stage).toBe('proposal')
    expect(Number(e!.attributes.amount)).toBe(50000)
    expect(e!.attributes.company_id).toBe(company.id)
    expect(e!.attributes.contact_id).toBe(contact.id)
  })

  it('the relationship FK stores the referenced entity id', async () => {
    const company = await crm.createCompany(userId, { workspaceId, name: 'Acme' })
    const contact = await crm.createContact(userId, { workspaceId, name: 'Sam', companyId: company.id })
    expect((await readEntity(contact.id))!.attributes.company_id).toBe(company.id)
    expect(contact.companyId).toBe(company.id)
  })

  it('createContact dedupes by email into one entity', async () => {
    await crm.createContact(userId, { workspaceId, name: 'A', email: 'team@acme.example' })
    await crm.createContact(userId, { workspaceId, name: 'B', email: 'team@acme.example' })
    const r = await pool!.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM entities
        WHERE workspace_id = $1 AND kind = 'person' AND lower(canonical_id) = 'team@acme.example' AND valid_to IS NULL`,
      [workspaceId],
    )
    expect(Number(r.rows[0].n)).toBe(1)
  })
})

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import pg from 'pg'

/**
 * Integration test for CRM update semantics post CRM→entity unification
 * (docs/plans/crm-entity-unification.md). A contact/company/deal IS an
 * `entities` row; updates are IN PLACE (updateEntity) — the id is stable
 * (so inbound + outbound edges stay valid) and CRM field history is not
 * preserved (decision D5). This replaces the old dual-table
 * supersession-on-write suite. Skips silently when the DB is unavailable.
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000 })
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
     VALUES (gen_random_uuid(), 'test', 'crm-upd-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'crm-upd-ws', 'test', $1, true)
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

type EntityRow = {
  kind: string
  displayName: string
  validTo: Date | null
  attributes: Record<string, unknown>
}

async function readEntity(id: string): Promise<EntityRow | null> {
  const r = await pool!.query<EntityRow>(
    `SELECT kind, display_name AS "displayName", valid_to AS "validTo", attributes
       FROM entities WHERE id = $1`,
    [id],
  )
  return r.rows[0] ?? null
}

async function countActive(kind: string, workspaceId: string): Promise<number> {
  const r = await pool!.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM entities
      WHERE workspace_id = $1 AND kind = $2 AND valid_to IS NULL
        AND NOT COALESCE((attributes->>'self')::boolean, false)`,
    [workspaceId, kind],
  )
  return parseInt(r.rows[0].n, 10)
}

const NIL = '00000000-0000-0000-0000-000000000000'

describeIf('[COMP:crm/update] updateCompany (in-place)', () => {
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

  it('updates in place — same id, name changed, entity stays live', async () => {
    const old = await crm.createCompany(userId, {
      workspaceId, name: 'Acme Corp', domain: 'acme.example', tags: ['vip'],
    })
    const updated = await crm.updateCompany(userId, old.id, { name: 'Acme Inc.' })
    expect(updated).not.toBeNull()
    expect(updated!.id).toBe(old.id)
    expect(updated!.name).toBe('Acme Inc.')

    const raw = await readEntity(old.id)
    expect(raw!.kind).toBe('company')
    expect(raw!.displayName).toBe('Acme Inc.')
    expect(raw!.validTo).toBeNull()
  })

  it('preserves unchanged typed fields', async () => {
    const old = await crm.createCompany(userId, {
      workspaceId, name: 'Acme', domain: 'acme.example', tags: ['vip', 'enterprise'],
      externalRef: { provider: 'attio', id: 'co_1' },
    })
    const updated = await crm.updateCompany(userId, old.id, { name: 'Acme Inc.' })
    expect(updated!.domain).toBe('acme.example')
    expect(updated!.tags).toEqual(['vip', 'enterprise'])
    expect(updated!.externalRef).toEqual({ provider: 'attio', id: 'co_1' })
  })

  it('clears the domain when passed null', async () => {
    const old = await crm.createCompany(userId, { workspaceId, name: 'Acme', domain: 'acme.example' })
    const updated = await crm.updateCompany(userId, old.id, { domain: null })
    expect(updated!.domain).toBeNull()
  })

  it('returns null when the id never existed', async () => {
    expect(await crm.updateCompany(userId, NIL, { name: 'X' })).toBeNull()
  })
})

describeIf('[COMP:crm/update] updateContact (in-place)', () => {
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

  it('updates in place — same id, email changed', async () => {
    const old = await crm.createContact(userId, {
      workspaceId, name: 'Sam Lee', email: 'sam@a.example', tags: ['buyer'],
    })
    const updated = await crm.updateContact(userId, old.id, { email: 'sam@new.example' })
    expect(updated!.id).toBe(old.id)
    expect(updated!.email).toBe('sam@new.example')
    expect(updated!.name).toBe('Sam Lee')
  })

  it('preserves unchanged typed fields including companyId', async () => {
    const company = await crm.createCompany(userId, { workspaceId, name: 'Acme' })
    const old = await crm.createContact(userId, {
      workspaceId, name: 'Sam Lee', email: 'sam@a.example', phone: '+1-555-0100',
      companyId: company.id, tags: ['buyer'],
    })
    const updated = await crm.updateContact(userId, old.id, { email: 'sam@new.example' })
    expect(updated!.phone).toBe('+1-555-0100')
    expect(updated!.companyId).toBe(company.id)
    expect(updated!.tags).toEqual(['buyer'])
  })

  it('can move the company link to another company', async () => {
    const a = await crm.createCompany(userId, { workspaceId, name: 'Acme' })
    const b = await crm.createCompany(userId, { workspaceId, name: 'Beta' })
    const contact = await crm.createContact(userId, { workspaceId, name: 'Sam', companyId: a.id })
    const moved = await crm.updateContact(userId, contact.id, { companyId: b.id })
    expect(moved!.companyId).toBe(b.id)
  })

  it('returns null when the id never existed', async () => {
    expect(await crm.updateContact(userId, NIL, { name: 'X' })).toBeNull()
  })
})

describeIf('[COMP:crm/update] updateDeal + setDealStage (in-place)', () => {
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

  it('updateDeal edits amount in place, preserving stage + contact', async () => {
    const contact = await crm.createContact(userId, { workspaceId, name: 'Sam' })
    const old = await crm.createDeal(userId, {
      workspaceId, contactId: contact.id, stage: 'proposal',
      amount: 50000, closeDate: new Date('2026-09-30'),
    })
    const updated = await crm.updateDeal(userId, old.id, { amount: 75000 })
    expect(updated!.id).toBe(old.id)
    expect(updated!.amount).toBe(75000)
    expect(updated!.stage).toBe('proposal')
    expect(updated!.contactId).toBe(contact.id)
  })

  it('setDealStage moves stage in place, carrying every other field', async () => {
    const company = await crm.createCompany(userId, { workspaceId, name: 'Acme' })
    const contact = await crm.createContact(userId, { workspaceId, name: 'Sam', companyId: company.id })
    const old = await crm.createDeal(userId, {
      workspaceId, contactId: contact.id, companyId: company.id,
      stage: 'lead', amount: 50000, closeDate: new Date('2026-12-15'),
    })
    const moved = await crm.setDealStage(userId, old.id, 'qualified')
    expect(moved!.id).toBe(old.id)
    expect(moved!.stage).toBe('qualified')
    expect(moved!.amount).toBe(50000)
    expect(moved!.contactId).toBe(contact.id)
    expect(moved!.companyId).toBe(company.id)
  })

  it('setDealStage walks the pipeline lead → qualified → proposal → won (one live row)', async () => {
    const contact = await crm.createContact(userId, { workspaceId, name: 'Sam' })
    const lead = await crm.createDeal(userId, { workspaceId, contactId: contact.id, stage: 'lead' })
    await crm.setDealStage(userId, lead.id, 'qualified')
    await crm.setDealStage(userId, lead.id, 'proposal')
    const won = await crm.setDealStage(userId, lead.id, 'won')
    expect(won!.id).toBe(lead.id)
    expect(won!.stage).toBe('won')
    expect(await countActive('deal', workspaceId)).toBe(1)
  })

  it('setDealStage rejects an invalid stage', async () => {
    const contact = await crm.createContact(userId, { workspaceId, name: 'Sam' })
    const deal = await crm.createDeal(userId, { workspaceId, contactId: contact.id, stage: 'lead' })
    await expect(crm.setDealStage(userId, deal.id, 'shipped' as never))
      .rejects.toThrow(/deals_stage_check/)
  })

  it('returns null when the id never existed', async () => {
    expect(await crm.setDealStage(userId, NIL, 'qualified')).toBeNull()
    expect(await crm.updateDeal(userId, NIL, { amount: 100 })).toBeNull()
  })
})

describeIf('[COMP:crm/reads] entity-backed CRM reads', () => {
  let crm: typeof import('../crm.js')
  let userId: string
  let workspaceId: string
  const ctx = () => ({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' as const })

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

  it('getCompanyById reflects an in-place update', async () => {
    const c = await crm.createCompany(userId, { workspaceId, name: 'Acme' })
    await crm.updateCompany(userId, c.id, { name: 'Acme Inc.' })
    expect((await crm.getCompanyById(ctx(), c.id))?.name).toBe('Acme Inc.')
  })

  it('listCompanies count is stable across updates (no tombstone rows)', async () => {
    const a = await crm.createCompany(userId, { workspaceId, name: 'A' })
    await crm.createCompany(userId, { workspaceId, name: 'B' })
    await crm.updateCompany(userId, a.id, { name: 'A2' })
    const rows = await crm.listCompanies(ctx(), {})
    expect(rows.length).toBe(2)
    expect(rows.map((r) => r.name).sort()).toEqual(['A2', 'B'])
  })

  it('getContactById reflects an in-place update', async () => {
    const s = await crm.createContact(userId, { workspaceId, name: 'Sam' })
    await crm.updateContact(userId, s.id, { name: 'Sam Lee' })
    expect((await crm.getContactById(ctx(), s.id))?.name).toBe('Sam Lee')
  })

  it('listContacts reflects updated names', async () => {
    const a = await crm.createContact(userId, { workspaceId, name: 'Sam' })
    await crm.createContact(userId, { workspaceId, name: 'Pat' })
    await crm.updateContact(userId, a.id, { name: 'Sam Lee' })
    const rows = await crm.listContacts(ctx(), {})
    expect(rows.map((r) => r.name).sort()).toEqual(['Pat', 'Sam Lee'])
  })

  it('getDealById reflects a stage move', async () => {
    const contact = await crm.createContact(userId, { workspaceId, name: 'Sam' })
    const d = await crm.createDeal(userId, { workspaceId, contactId: contact.id, stage: 'lead' })
    await crm.setDealStage(userId, d.id, 'qualified')
    expect((await crm.getDealById(ctx(), d.id))?.stage).toBe('qualified')
  })

  it('listDeals stage filter sees the current stage only', async () => {
    const contact = await crm.createContact(userId, { workspaceId, name: 'Sam' })
    const d1 = await crm.createDeal(userId, { workspaceId, contactId: contact.id, stage: 'lead' })
    await crm.createDeal(userId, { workspaceId, contactId: contact.id, stage: 'proposal' })
    await crm.setDealStage(userId, d1.id, 'qualified')

    const all = await crm.listDeals(ctx(), {})
    expect(all.map((r) => r.stage).sort()).toEqual(['proposal', 'qualified'])
    const leads = await crm.listDeals(ctx(), { stage: 'lead' })
    expect(leads.length).toBe(0)
  })
})

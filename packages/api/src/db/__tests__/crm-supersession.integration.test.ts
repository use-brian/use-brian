import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import pg from 'pg'

/**
 * Integration test for WU-2.5 — CRM supersession-on-write and the
 * matching bi-temporal read filters on contacts / companies / deals.
 *
 * Requires a local `sidanclaw` PostgreSQL database with migration 128
 * applied (the universal column set on the CRM tables). Skips silently
 * when the DB is unavailable or the migration hasn't landed.
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      // Probe for mig 127's entity_id + mig 128's universal columns. If
      // either hasn't been applied to this DB the suite skips cleanly.
      await client.query('SELECT entity_id, valid_to, superseded_by FROM companies LIMIT 1')
      await client.query('SELECT entity_id, valid_to, superseded_by FROM contacts LIMIT 1')
      await client.query('SELECT entity_id, valid_to, superseded_by FROM deals LIMIT 1')
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
     VALUES (gen_random_uuid(), 'test', 'crm-sup-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'crm-sup-ws', 'test', $1, true)
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

type RawCrm = {
  valid_to: Date | null
  superseded_by: string | null
  entity_id: string | null
}

async function readRawRow(table: 'companies' | 'contacts' | 'deals', id: string): Promise<RawCrm | null> {
  const r = await pool!.query<RawCrm>(
    `SELECT valid_to, superseded_by, entity_id FROM ${table} WHERE id = $1`,
    [id],
  )
  return r.rows[0] ?? null
}

async function countActive(table: 'companies' | 'contacts' | 'deals', workspaceId: string): Promise<number> {
  const r = await pool!.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table}
     WHERE workspace_id = $1 AND valid_to IS NULL`,
    [workspaceId],
  )
  return parseInt(r.rows[0].n, 10)
}

async function countAll(table: 'companies' | 'contacts' | 'deals', workspaceId: string): Promise<number> {
  const r = await pool!.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table} WHERE workspace_id = $1`,
    [workspaceId],
  )
  return parseInt(r.rows[0].n, 10)
}

async function readAuthorship(table: 'companies' | 'contacts' | 'deals', id: string): Promise<{
  workspaceId: string
  createdByUserId: string | null
  source: string
  sensitivity: string
} | null> {
  const r = await pool!.query<{
    workspaceId: string
    createdByUserId: string | null
    source: string
    sensitivity: string
  }>(
    `SELECT workspace_id        AS "workspaceId",
            created_by_user_id  AS "createdByUserId",
            source, sensitivity
     FROM ${table} WHERE id = $1`,
    [id],
  )
  return r.rows[0] ?? null
}

describeIf('[COMP:crm/supersession] updateCompany (transactional supersession)', () => {
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

  it('inserts a new row, tombstones the old, points superseded_by OLD→NEW', async () => {
    const old = await crm.createCompany(userId, {
      workspaceId, name: 'Acme Corp', domain: 'acme.example', tags: ['vip'],
    })

    const updated = await crm.updateCompany(userId, old.id, { name: 'Acme Inc.' })
    expect(updated).not.toBeNull()
    expect(updated!.id).not.toBe(old.id)
    expect(updated!.name).toBe('Acme Inc.')

    const rawOld = await readRawRow('companies', old.id)
    const rawNew = await readRawRow('companies', updated!.id)
    expect(rawOld!.valid_to).not.toBeNull()
    expect(rawOld!.superseded_by).toBe(updated!.id)
    expect(rawNew!.valid_to).toBeNull()
    expect(rawNew!.superseded_by).toBeNull()
  })

  it('moves entity_id from the tombstoned row to the new active row', async () => {
    const old = await crm.createCompany(userId, { workspaceId, name: 'Acme' })
    const originalEntityId = (await readRawRow('companies', old.id))!.entity_id
    expect(originalEntityId).not.toBeNull()

    const updated = await crm.updateCompany(userId, old.id, { name: 'Acme 2' })
    const rawOld = await readRawRow('companies', old.id)
    const rawNew = await readRawRow('companies', updated!.id)

    expect(rawOld!.entity_id).toBeNull()
    expect(rawNew!.entity_id).toBe(originalEntityId)
  })

  it('preserves unchanged typed fields from the old row', async () => {
    const old = await crm.createCompany(userId, {
      workspaceId, name: 'Acme', domain: 'acme.example', tags: ['vip', 'enterprise'],
      externalRef: { provider: 'attio', id: 'co_1' },
    })

    const updated = await crm.updateCompany(userId, old.id, { name: 'Acme Inc.' })
    expect(updated!.domain).toBe('acme.example')
    expect(updated!.tags).toEqual(['vip', 'enterprise'])
    expect(updated!.externalRef).toEqual({ provider: 'attio', id: 'co_1' })
  })

  it('carries authorship, workspace, and trust columns forward to the new row', async () => {
    const old = await crm.createCompany(userId, { workspaceId, name: 'Acme' })

    // createCompany doesn't stamp universal authorship yet (a future WU);
    // backfill the columns directly so the supersession carry-forward is
    // exercised against non-null values.
    await pool!.query(
      `UPDATE companies
          SET created_by_user_id = $2,
              source = 'extracted',
              sensitivity = 'confidential'
        WHERE id = $1`,
      [old.id, userId],
    )

    const updated = await crm.updateCompany(userId, old.id, { name: 'Acme 2' })
    const newAuth = await readAuthorship('companies', updated!.id)
    expect(newAuth!.workspaceId).toBe(workspaceId)
    expect(newAuth!.createdByUserId).toBe(userId)
    expect(newAuth!.source).toBe('extracted')
    expect(newAuth!.sensitivity).toBe('confidential')
  })

  it('returns null and inserts no row when the id is already tombstoned', async () => {
    const old = await crm.createCompany(userId, { workspaceId, name: 'A' })
    const v2 = await crm.updateCompany(userId, old.id, { name: 'A2' })
    expect(v2).not.toBeNull()

    const rejected = await crm.updateCompany(userId, old.id, { name: 'A3' })
    expect(rejected).toBeNull()

    // Total versions in this workspace = old + v2 (no third row).
    expect(await countAll('companies', workspaceId)).toBe(2)
    expect(await countActive('companies', workspaceId)).toBe(1)
  })

  it('returns null when the id never existed', async () => {
    const missing = await crm.updateCompany(userId, '00000000-0000-0000-0000-000000000000', { name: 'X' })
    expect(missing).toBeNull()
  })
})

describeIf('[COMP:crm/supersession] updateContact (transactional supersession)', () => {
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

  it('inserts a new row, tombstones the old, points superseded_by OLD→NEW', async () => {
    const old = await crm.createContact(userId, {
      workspaceId, name: 'Sam Lee', email: 'sam@a.example', tags: ['buyer'],
    })

    const updated = await crm.updateContact(userId, old.id, { email: 'sam@new.example' })
    expect(updated!.id).not.toBe(old.id)
    expect(updated!.email).toBe('sam@new.example')

    const rawOld = await readRawRow('contacts', old.id)
    expect(rawOld!.valid_to).not.toBeNull()
    expect(rawOld!.superseded_by).toBe(updated!.id)
  })

  it('moves entity_id from the tombstoned row to the new active row', async () => {
    const old = await crm.createContact(userId, { workspaceId, name: 'Sam' })
    const originalEntityId = (await readRawRow('contacts', old.id))!.entity_id

    const updated = await crm.updateContact(userId, old.id, { name: 'Sam Lee' })
    const rawOld = await readRawRow('contacts', old.id)
    const rawNew = await readRawRow('contacts', updated!.id)

    expect(rawOld!.entity_id).toBeNull()
    expect(rawNew!.entity_id).toBe(originalEntityId)
  })

  it('preserves unchanged typed fields including company_id', async () => {
    const company = await crm.createCompany(userId, { workspaceId, name: 'Acme' })
    const old = await crm.createContact(userId, {
      workspaceId, name: 'Sam Lee', email: 'sam@a.example', phone: '+1-555-0100',
      companyId: company.id, tags: ['buyer'],
    })

    const updated = await crm.updateContact(userId, old.id, { email: 'sam@new.example' })
    expect(updated!.name).toBe('Sam Lee')
    expect(updated!.phone).toBe('+1-555-0100')
    expect(updated!.companyId).toBe(company.id)
    expect(updated!.tags).toEqual(['buyer'])
  })

  it('returns null when the id is already tombstoned', async () => {
    const old = await crm.createContact(userId, { workspaceId, name: 'Sam' })
    await crm.updateContact(userId, old.id, { email: 'sam@a.example' })
    const rejected = await crm.updateContact(userId, old.id, { email: 'sam@b.example' })
    expect(rejected).toBeNull()
  })

  it('returns null when the id never existed', async () => {
    const missing = await crm.updateContact(userId, '00000000-0000-0000-0000-000000000000', { name: 'X' })
    expect(missing).toBeNull()
  })
})

describeIf('[COMP:crm/supersession] updateDeal + setDealStage (transactional supersession)', () => {
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

  it('updateDeal supersedes on amount/closeDate edit', async () => {
    const contact = await crm.createContact(userId, { workspaceId, name: 'Sam' })
    const old = await crm.createDeal(userId, {
      workspaceId, contactId: contact.id, stage: 'proposal',
      amount: 50000, closeDate: new Date('2026-09-30'),
    })

    const updated = await crm.updateDeal(userId, old.id, { amount: 75000 })
    expect(updated!.id).not.toBe(old.id)
    expect(updated!.amount).toBe(75000)
    expect(updated!.stage).toBe('proposal') // unchanged
    expect(updated!.contactId).toBe(contact.id) // unchanged

    const rawOld = await readRawRow('deals', old.id)
    expect(rawOld!.valid_to).not.toBeNull()
    expect(rawOld!.superseded_by).toBe(updated!.id)
    expect(rawOld!.entity_id).toBeNull()
  })

  it('setDealStage supersedes lead → qualified, carrying every other field', async () => {
    const company = await crm.createCompany(userId, { workspaceId, name: 'Acme' })
    const contact = await crm.createContact(userId, { workspaceId, name: 'Sam', companyId: company.id })
    const old = await crm.createDeal(userId, {
      workspaceId, contactId: contact.id, companyId: company.id,
      stage: 'lead', amount: 50000, closeDate: new Date('2026-12-15'),
    })
    const originalEntityId = (await readRawRow('deals', old.id))!.entity_id
    const originalCloseDate = old.closeDate

    const moved = await crm.setDealStage(userId, old.id, 'qualified')
    expect(moved).not.toBeNull()
    expect(moved!.id).not.toBe(old.id)
    expect(moved!.stage).toBe('qualified')
    expect(moved!.amount).toBe(50000)
    expect(moved!.contactId).toBe(contact.id)
    expect(moved!.companyId).toBe(company.id)
    // pg's DATE → Date conversion can shift by timezone; the
    // round-trip-preserved value is what matters for supersession.
    expect(moved!.closeDate?.getTime()).toBe(originalCloseDate?.getTime())

    const rawOld = await readRawRow('deals', old.id)
    const rawNew = await readRawRow('deals', moved!.id)
    expect(rawOld!.valid_to).not.toBeNull()
    expect(rawOld!.superseded_by).toBe(moved!.id)
    expect(rawOld!.entity_id).toBeNull()
    expect(rawNew!.entity_id).toBe(originalEntityId)
  })

  it('setDealStage walks the standard pipeline (lead → qualified → proposal → won)', async () => {
    const contact = await crm.createContact(userId, { workspaceId, name: 'Sam' })
    const lead = await crm.createDeal(userId, { workspaceId, contactId: contact.id, stage: 'lead' })
    const qual = await crm.setDealStage(userId, lead.id, 'qualified')
    const prop = await crm.setDealStage(userId, qual!.id, 'proposal')
    const won = await crm.setDealStage(userId, prop!.id, 'won')

    expect(won!.stage).toBe('won')
    // 4 rows in the chain; only the last is active.
    expect(await countAll('deals', workspaceId)).toBe(4)
    expect(await countActive('deals', workspaceId)).toBe(1)
  })

  it('returns null when the id is already tombstoned', async () => {
    const contact = await crm.createContact(userId, { workspaceId, name: 'Sam' })
    const old = await crm.createDeal(userId, { workspaceId, contactId: contact.id, stage: 'lead' })
    await crm.setDealStage(userId, old.id, 'qualified')

    const rejectedStage = await crm.setDealStage(userId, old.id, 'proposal')
    expect(rejectedStage).toBeNull()
    const rejectedUpdate = await crm.updateDeal(userId, old.id, { amount: 100 })
    expect(rejectedUpdate).toBeNull()
  })

  it('returns null when the id never existed', async () => {
    const missing = await crm.setDealStage(userId, '00000000-0000-0000-0000-000000000000', 'qualified')
    expect(missing).toBeNull()
  })
})

describeIf('[COMP:crm/bi-temporal-reads] CRM reads filter valid_to IS NULL', () => {
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

  it('getCompanyById returns null for tombstoned ids, the new row for active ids', async () => {
    const old = await crm.createCompany(userId, { workspaceId, name: 'Acme' })
    const updated = await crm.updateCompany(userId, old.id, { name: 'Acme Inc.' })
    expect(await crm.getCompanyById({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, old.id)).toBeNull()
    const refreshed = await crm.getCompanyById({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, updated!.id)
    expect(refreshed?.name).toBe('Acme Inc.')
  })

  it('listCompanies excludes tombstoned rows', async () => {
    const a = await crm.createCompany(userId, { workspaceId, name: 'A' })
    await crm.createCompany(userId, { workspaceId, name: 'B' })
    expect((await crm.listCompanies({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, {})).length).toBe(2)

    await crm.updateCompany(userId, a.id, { name: 'A2' })
    const rows = await crm.listCompanies({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, {})
    expect(rows.length).toBe(2) // still 2 — the tombstoned A is hidden, A2 takes its slot
    expect(rows.map((r) => r.name).sort()).toEqual(['A2', 'B'])
  })

  it('getContactById returns null for tombstoned ids', async () => {
    const old = await crm.createContact(userId, { workspaceId, name: 'Sam' })
    const updated = await crm.updateContact(userId, old.id, { name: 'Sam Lee' })
    expect(await crm.getContactById({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, old.id)).toBeNull()
    expect((await crm.getContactById({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, updated!.id))?.name).toBe('Sam Lee')
  })

  it('listContacts excludes tombstoned rows', async () => {
    const a = await crm.createContact(userId, { workspaceId, name: 'Sam' })
    await crm.createContact(userId, { workspaceId, name: 'Pat' })
    await crm.updateContact(userId, a.id, { name: 'Sam Lee' })

    const rows = await crm.listContacts({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, {})
    expect(rows.length).toBe(2)
    expect(rows.map((r) => r.name).sort()).toEqual(['Pat', 'Sam Lee'])
  })

  it('getDealById returns null for tombstoned ids', async () => {
    const contact = await crm.createContact(userId, { workspaceId, name: 'Sam' })
    const old = await crm.createDeal(userId, { workspaceId, contactId: contact.id, stage: 'lead' })
    const moved = await crm.setDealStage(userId, old.id, 'qualified')
    expect(await crm.getDealById({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, old.id)).toBeNull()
    expect((await crm.getDealById({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, moved!.id))?.stage).toBe('qualified')
  })

  it('listDeals excludes tombstoned rows and stage filter sees the new stage only', async () => {
    const contact = await crm.createContact(userId, { workspaceId, name: 'Sam' })
    const d1 = await crm.createDeal(userId, { workspaceId, contactId: contact.id, stage: 'lead' })
    await crm.createDeal(userId, { workspaceId, contactId: contact.id, stage: 'proposal' })
    await crm.setDealStage(userId, d1.id, 'qualified')

    const all = await crm.listDeals({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, {})
    expect(all.length).toBe(2)
    expect(all.map((r) => r.stage).sort()).toEqual(['proposal', 'qualified'])

    const leads = await crm.listDeals({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, { stage: 'lead' })
    expect(leads.length).toBe(0) // the lead row is tombstoned
  })
})

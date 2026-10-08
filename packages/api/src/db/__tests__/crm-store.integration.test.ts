import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import pg from 'pg'

/**
 * Integration test for createDbCrmStore + the CRM RLS / trigger surface
 * defined in migration 114. Runs only through the maintained disposable PostgreSQL fixture.
 */

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

afterAll(async () => {
  const { getPool, getAppPool } = await import('../client.js')
  await Promise.all([pool.end(), getPool().end(), getAppPool().end()])
})

async function makeUser(client: pg.PoolClient): Promise<string> {
  const r = await client.query(
    `INSERT INTO users (id, auth_provider, auth_provider_id)
     VALUES (gen_random_uuid(), 'test', 'crm-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'crm-test-ws', 'test', $1, true)
     RETURNING id`,
    [ownerId],
  )
  return r.rows[0].id
}

async function addMember(client: pg.PoolClient, workspaceId: string, userId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspace_members (id, workspace_id, user_id, role)
     VALUES (gen_random_uuid(), $1, $2, 'owner')
     RETURNING id`,
    [workspaceId, userId],
  )
  return r.rows[0].id
}

describe('[COMP:api/crm-store] CRM store + RLS (integration)', () => {
  let store: typeof import('../crm-store.js') extends { createDbCrmStore: infer T }
    ? T extends () => infer R ? R : never
    : never

  beforeAll(async () => {
    const mod = await import('../crm-store.js')
    store = mod.createDbCrmStore()
  })

  describe('CRUD round-trip', () => {
    let userId: string
    let workspaceId: string

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

    it('createCompany + getCompanyById round trip', async () => {
      const company = await store.createCompany({
        userId, workspaceId,
        name: 'Acme Corp', domain: 'acme.example', tags: ['vip'],
        externalRef: { provider: 'attio', id: 'co_1' },
      })
      expect(company.name).toBe('Acme Corp')
      expect(company.domain).toBe('acme.example')
      expect(company.externalRef).toEqual({ provider: 'attio', id: 'co_1' })

      const fetched = await store.getCompanyById({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, company.id)
      expect(fetched?.id).toBe(company.id)
      expect(fetched?.tags).toEqual(['vip'])
    })

    it('createContact + getContactById round trip with company link', async () => {
      const company = await store.createCompany({ userId, workspaceId, name: 'Acme' })
      const contact = await store.createContact({
        userId, workspaceId,
        name: 'Sam Lee', email: 'sam@acme.example',
        companyId: company.id, tags: ['buyer'],
      })
      expect(contact.email).toBe('sam@acme.example')
      expect(contact.companyId).toBe(company.id)

      const fetched = await store.getContactById({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, contact.id)
      expect(fetched?.companyId).toBe(company.id)
    })

    it('createDeal + getDealById round trip with both links', async () => {
      const company = await store.createCompany({ userId, workspaceId, name: 'Acme' })
      const contact = await store.createContact({ userId, workspaceId, name: 'Sam' })
      const deal = await store.createDeal({
        userId, workspaceId,
        contactId: contact.id, companyId: company.id,
        stage: 'proposal', amount: 50000, closeDate: new Date('2026-09-30'),
      })
      expect(deal.stage).toBe('proposal')
      expect(deal.amount).toBe(50000)
      expect(deal.contactId).toBe(contact.id)
      expect(deal.companyId).toBe(company.id)

      const fetched = await store.getDealById({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, deal.id)
      expect(fetched?.amount).toBe(50000)
    })

    it('listContacts filters by query (ILIKE on name+email)', async () => {
      await store.createContact({ userId, workspaceId, name: 'Sam Lee', email: 'sam@a.example' })
      await store.createContact({ userId, workspaceId, name: 'Pat Wong', email: 'pat@a.example' })

      const sam = await store.listContacts({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, { query: 'sam' })
      expect(sam.map((r) => r.name)).toEqual(['Sam Lee'])

      const byEmail = await store.listContacts({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, { query: 'pat@' })
      expect(byEmail.map((r) => r.name)).toEqual(['Pat Wong'])
    })

    it('listDeals filters by stage array', async () => {
      const contact = await store.createContact({ userId, workspaceId, name: 'Sam' })
      await store.createDeal({ userId, workspaceId, contactId: contact.id, stage: 'lead' })
      await store.createDeal({ userId, workspaceId, contactId: contact.id, stage: 'proposal' })
      await store.createDeal({ userId, workspaceId, contactId: contact.id, stage: 'negotiation' })

      const focused = await store.listDeals({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, { stage: ['proposal', 'negotiation'] })
      expect(focused.map((r) => r.stage).sort()).toEqual(['negotiation', 'proposal'])
    })

    it('updateContact patches selectively', async () => {
      const c = await store.createContact({ userId, workspaceId, name: 'Sam', email: 'sam@a.example' })
      const updated = await store.updateContact(userId, c.id, { email: 'sam@new.example' })
      expect(updated?.email).toBe('sam@new.example')
      expect(updated?.name).toBe('Sam')
    })

    it('setDealStage moves deal to new stage', async () => {
      const contact = await store.createContact({ userId, workspaceId, name: 'Sam' })
      const deal = await store.createDeal({ userId, workspaceId, contactId: contact.id, stage: 'lead' })
      const moved = await store.setDealStage(userId, deal.id, 'won')
      expect(moved?.stage).toBe('won')
    })
  })

  describe('Constraints + triggers', () => {
    let userId: string
    let workspaceId: string

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

    it('stage CHECK rejects invalid value', async () => {
      const contact = await store.createContact({ userId, workspaceId, name: 'Sam' })
      await expect(
        store.createDeal({ userId, workspaceId, contactId: contact.id, stage: 'shipped' as never }),
      ).rejects.toThrow(/check constraint|deals_stage_check/)
    })

    it('amount CHECK rejects negative', async () => {
      const contact = await store.createContact({ userId, workspaceId, name: 'Sam' })
      await expect(
        store.createDeal({ userId, workspaceId, contactId: contact.id, amount: -100 }),
      ).rejects.toThrow(/check constraint|deals_amount_check/)
    })

    it('cross-workspace company reference is refused before contact creation', async () => {
      // Build a second workspace + put a company there
      const client = await pool!.connect()
      let otherWorkspace: string
      let otherCompanyId: string
      try {
        const otherUser = await makeUser(client)
        otherWorkspace = await makeWorkspace(client, otherUser)
        await addMember(client, otherWorkspace, otherUser)
        const otherCompany = await store.createCompany({
          userId: otherUser, workspaceId: otherWorkspace, name: 'Other Co',
        })
        otherCompanyId = otherCompany.id
      } finally {
        client.release()
      }

      await expect(
        store.createContact({
          userId, workspaceId, name: 'X', companyId: otherCompanyId,
        }),
      ).rejects.toMatchObject({ code: 'scope_operation_denied' })
    })

    it('cross-workspace contact reference is refused before deal creation', async () => {
      const client = await pool!.connect()
      let otherContactId: string
      try {
        const otherUser = await makeUser(client)
        const otherWs = await makeWorkspace(client, otherUser)
        await addMember(client, otherWs, otherUser)
        const otherContact = await store.createContact({ userId: otherUser, workspaceId: otherWs, name: 'X' })
        otherContactId = otherContact.id
      } finally {
        client.release()
      }

      await expect(
        store.createDeal({ userId, workspaceId, contactId: otherContactId }),
      ).rejects.toMatchObject({ code: 'scope_operation_denied' })
    })

    it('shared email is retrieval evidence and does not merge distinct people', async () => {
      const a = await store.createContact({ userId, workspaceId, name: 'A', email: 'team@acme.example' })
      const b = await store.createContact({ userId, workspaceId, name: 'B', email: 'team@acme.example' })
      expect(b.id).not.toBe(a.id)
      const rows = await pool.query(`SELECT id,display_name FROM entities
        WHERE workspace_id=$1 AND kind='person' AND lower(canonical_id)=$2 AND valid_to IS NULL`,
        [workspaceId,'team@acme.example'])
      expect(rows.rows).toEqual(expect.arrayContaining([{id:a.id,display_name:'A'},{id:b.id,display_name:'B'}]))
      expect(rows.rows).toHaveLength(2)
    })
  })

  describe('relationship links + cascade', () => {
    let userId: string
    let workspaceId: string

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

    // Post CRM→entity unification: relationships are `attributes` FKs +
    // graph edges, not table FK columns, so ON DELETE SET NULL is gone.
    // The supported way to drop a link is to clear it through updateX.
    it('updateContact can clear the company link', async () => {
      const company = await store.createCompany({ userId, workspaceId, name: 'Acme' })
      const contact = await store.createContact({ userId, workspaceId, name: 'Sam', companyId: company.id })
      expect(contact.companyId).toBe(company.id)
      const cleared = await store.updateContact(userId, contact.id, { companyId: null })
      expect(cleared!.companyId).toBeNull()
    })

    it('updateDeal can clear the contact + company links (deal survives)', async () => {
      const contact = await store.createContact({ userId, workspaceId, name: 'Sam' })
      const company = await store.createCompany({ userId, workspaceId, name: 'Acme' })
      const deal = await store.createDeal({
        userId, workspaceId, contactId: contact.id, companyId: company.id, stage: 'proposal',
      })
      const cleared = await store.updateDeal(userId, deal.id, { contactId: null, companyId: null })
      expect(cleared!.contactId).toBeNull()
      expect(cleared!.companyId).toBeNull()
      expect(cleared!.stage).toBe('proposal')
    })

    it('workspace delete cascades to CRM entities', async () => {
      const company = await store.createCompany({ userId, workspaceId, name: 'Acme' })
      const contact = await store.createContact({ userId, workspaceId, name: 'Sam', companyId: company.id })
      await store.createDeal({ userId, workspaceId, contactId: contact.id, companyId: company.id })

      const client = await pool!.connect()
      try {
        await client.query('DELETE FROM workspaces WHERE id = $1', [workspaceId])
        const r = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM entities
            WHERE workspace_id = $1 AND kind IN ('person', 'company', 'deal')`,
          [workspaceId],
        )
        expect(r.rows[0].n).toBe(0)
      } finally {
        client.release()
      }
    })
  })

  describe('RLS isolation', () => {
    // The maintained fixture supplies the non-superuser application pool.
    it('member of workspace A cannot see workspace B rows', async () => {
      const client = await pool!.connect()
      let aUser: string, aWs: string, bUser: string, bWs: string
      try {
        aUser = await makeUser(client)
        aWs = await makeWorkspace(client, aUser)
        await addMember(client, aWs, aUser)
        bUser = await makeUser(client)
        bWs = await makeWorkspace(client, bUser)
        await addMember(client, bWs, bUser)
      } finally {
        client.release()
      }

      // A creates a company in their own workspace
      await store.createCompany({ userId: aUser, workspaceId: aWs, name: 'A Co' })

      // B queries with their own RLS — should see ZERO rows from A's workspace
      const bSeesA = await store.listCompanies({ workspaceId: aWs, userId: bUser, assistantId: bUser, assistantKind: 'standard' }, {})
      expect(bSeesA).toHaveLength(0)

      // A queries their own workspace — should see the row
      const aSeesA = await store.listCompanies({ workspaceId: aWs, userId: aUser, assistantId: aUser, assistantKind: 'standard' }, {})
      expect(aSeesA).toHaveLength(1)
    })
  })

  describe('Dedupe access scoping', () => {
    // Regression for the 2026-07-05 incident: saveContact's upsert-dedupe
    // matched a same-name person entity owned by ANOTHER user in the same
    // workspace, merged into it, and reported success — but every read
    // path (access predicate: user_id IS NULL OR user_id = viewer) hid the
    // row from the caller. The dedupe scan must only select rows the
    // writer can read back.
    let aUser: string
    let bUser: string
    let workspaceId: string

    beforeEach(async () => {
      const client = await pool!.connect()
      try {
        aUser = await makeUser(client)
        bUser = await makeUser(client)
        workspaceId = await makeWorkspace(client, aUser)
        await addMember(client, workspaceId, aUser)
        await addMember(client, workspaceId, bUser)
      } finally {
        client.release()
      }
    })

    it('contact upsert does not merge into another user\'s private same-name row', async () => {
      const theirs = await store.createContact({ userId: bUser, workspaceId, name: 'Ken Lau' })
      await pool.query('UPDATE entities SET user_id=$2 WHERE id=$1', [theirs.id,bUser])
      const mine = await store.createContact({
        userId: aUser, workspaceId, name: 'Ken Lau', tags: ['engineer'],
        access: { workspaceId, userId: aUser, assistantId: aUser, assistantKind: 'primary' },
      })

      // Fresh caller-owned row, not a merge into the invisible one.
      expect(mine.id).not.toBe(theirs.id)

      // Read-your-write: the caller's list shows the row it just wrote.
      const visible = await store.listContacts(
        { workspaceId, userId: aUser, assistantId: aUser, assistantKind: 'primary' },
        { query: 'Ken' },
      )
      expect(visible.map((r) => r.id)).toContain(mine.id)
      expect(visible.map((r) => r.id)).not.toContain(theirs.id)

      // The other user's private row was not mutated.
      const theirsAfter = await store.getContactById(
        { workspaceId, userId: bUser, assistantId: bUser, assistantKind: 'standard' },
        theirs.id,
      )
      expect(theirsAfter?.tags).toEqual([])
    })

    it('same-name person creation preserves separate identities and attributes', async () => {
      const first = await store.createContact({
        userId: aUser, workspaceId, name: 'Ken Lau', tags: ['engineer'],
        access: { workspaceId, userId: aUser, assistantId: aUser, assistantKind: 'primary' },
      })
      const second = await store.createContact({
        userId: aUser, workspaceId, name: 'ken lau', tags: ['oss'],
        access: { workspaceId, userId: aUser, assistantId: aUser, assistantKind: 'primary' },
      })
      expect(second.id).not.toBe(first.id)
      expect(second.tags).toEqual(['oss'])
      expect((await store.getContactById({ workspaceId, userId: aUser, assistantId: aUser, assistantKind: 'primary' }, first.id))?.tags).toEqual(['engineer'])
    })

    it('contact upsert without access falls back to the user axis (no cross-user merge)', async () => {
      const theirs = await store.createContact({ userId: bUser, workspaceId, name: 'Ken Lau' })
      await pool.query('UPDATE entities SET user_id=$2 WHERE id=$1', [theirs.id,bUser])
      const mine = await store.createContact({ userId: aUser, workspaceId, name: 'Ken Lau' })
      expect(mine.id).not.toBe(theirs.id)
    })

    it('company upsert does not merge into another user\'s private same-name row', async () => {
      const theirs = await store.createCompany({ userId: bUser, workspaceId, name: 'Acme' })
      await pool.query('UPDATE entities SET user_id=$2 WHERE id=$1', [theirs.id,bUser])
      const mine = await store.createCompany({
        userId: aUser, workspaceId, name: 'Acme', tags: ['vendor'],
        access: { workspaceId, userId: aUser, assistantId: aUser, assistantKind: 'primary' },
      })
      expect(mine.id).not.toBe(theirs.id)

      const theirsAfter = await store.getCompanyById(
        { workspaceId, userId: bUser, assistantId: bUser, assistantKind: 'standard' },
        theirs.id,
      )
      expect(theirsAfter?.tags).toEqual([])
    })
  })
})

describe('[COMP:brain/crm-write-wrapper] CRM write wrapper (Q24)', () => {
  let store: typeof import('../crm-store.js') extends { createDbCrmStore: infer T }
    ? T extends () => infer R ? R : never
    : never

  beforeAll(async () => {
    const mod = await import('../crm-store.js')
    store = mod.createDbCrmStore()
  })

  let userId: string
  let workspaceId: string

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

  async function readEntity(id: string): Promise<{
    id: string
    kind: string
    displayName: string
    canonicalId: string | null
    workspaceId: string
    createdByUserId: string
    source: string
  } | null> {
    const client = await pool!.connect()
    try {
      const r = await client.query(
        `SELECT id, kind, display_name AS "displayName",
                canonical_id AS "canonicalId", workspace_id AS "workspaceId",
                created_by_user_id AS "createdByUserId", source
         FROM entities WHERE id = $1`,
        [id],
      )
      return r.rows[0] ?? null
    } finally {
      client.release()
    }
  }

  // Post CRM→entity unification the record id IS the entity id — there is
  // no separate specialization row to resolve through.
  async function readContactEntityId(id: string): Promise<string | null> { return id }
  async function readCompanyEntityId(id: string): Promise<string | null> { return id }
  async function readDealEntityId(id: string): Promise<string | null> { return id }

  it('createContact creates entity + contact atomically with matching entity_id', async () => {
    const contact = await store.createContact({
      userId, workspaceId, name: 'Sam Lee', email: 'sam@acme.example',
    })
    const entityId = await readContactEntityId(contact.id)
    expect(entityId).not.toBeNull()
    const entity = await readEntity(entityId!)
    expect(entity).not.toBeNull()
    expect(entity!.kind).toBe('person')
    expect(entity!.displayName).toBe('Sam Lee')
    expect(entity!.canonicalId).toBe('sam@acme.example')
    expect(entity!.workspaceId).toBe(workspaceId)
    expect(entity!.createdByUserId).toBe(userId)
    expect(entity!.source).toBe('user')
  })

  it('createContact without email — canonical_id NULL', async () => {
    const contact = await store.createContact({ userId, workspaceId, name: 'No-Email' })
    const entityId = await readContactEntityId(contact.id)
    const entity = await readEntity(entityId!)
    expect(entity!.canonicalId).toBeNull()
  })

  it('createCompany — entity.kind=company, canonical_id=domain', async () => {
    const company = await store.createCompany({
      userId, workspaceId, name: 'Acme Corp', domain: 'acme.example',
    })
    const entityId = await readCompanyEntityId(company.id)
    expect(entityId).not.toBeNull()
    const entity = await readEntity(entityId!)
    expect(entity!.kind).toBe('company')
    expect(entity!.displayName).toBe('Acme Corp')
    expect(entity!.canonicalId).toBe('acme.example')
  })

  it('createDeal with companyId — display_name="Deal - {company.name}"', async () => {
    const company = await store.createCompany({ userId, workspaceId, name: 'Acme' })
    const deal = await store.createDeal({
      userId, workspaceId, companyId: company.id, stage: 'proposal',
    })
    const entityId = await readDealEntityId(deal.id)
    const entity = await readEntity(entityId!)
    expect(entity!.kind).toBe('deal')
    expect(entity!.displayName).toBe('Deal - Acme')
    expect(entity!.canonicalId).toBeNull()
  })

  it('createDeal without companyId — display_name="Deal"', async () => {
    const contact = await store.createContact({ userId, workspaceId, name: 'Sam' })
    const deal = await store.createDeal({
      userId, workspaceId, contactId: contact.id, stage: 'lead',
    })
    const entityId = await readDealEntityId(deal.id)
    const entity = await readEntity(entityId!)
    expect(entity!.displayName).toBe('Deal')
  })

  it('rollback: failing CRM insert leaves no orphan entity', async () => {
    // A foreign relationship is refused before any contact or graph effect.
    const client = await pool!.connect()
    let foreignCompanyId: string
    try {
      const otherUser = await makeUser(client)
      const otherWs = await makeWorkspace(client, otherUser)
      await addMember(client, otherWs, otherUser)
      const otherCompany = await store.createCompany({
        userId: otherUser, workspaceId: otherWs, name: 'Other Co',
      })
      foreignCompanyId = otherCompany.id
    } finally {
      client.release()
    }

    const before = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM entities WHERE workspace_id = $1`,
      [workspaceId],
    )

    await expect(
      store.createContact({
        userId, workspaceId, name: 'Will-Fail', companyId: foreignCompanyId,
      }),
    ).rejects.toMatchObject({ code: 'scope_operation_denied' })

    const after = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM entities WHERE workspace_id = $1`,
      [workspaceId],
    )
    expect(after.rows[0].n).toBe(before.rows[0].n)
  })
})

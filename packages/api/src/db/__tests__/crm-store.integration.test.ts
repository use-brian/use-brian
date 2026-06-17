import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import pg from 'pg'

/**
 * Integration test for createDbCrmStore + the CRM RLS / trigger surface
 * defined in migration 114. Requires a local PostgreSQL database named
 * `sidanclaw` with that migration applied. Skips silently when the DB is
 * unavailable.
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query('SELECT 1 FROM deals LIMIT 1')
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

describeIf('[COMP:api/crm-store] CRM store + RLS (integration)', () => {
  let store: typeof import('../crm-store.js') extends { createDbCrmStore: infer T }
    ? T extends () => infer R ? R : never
    : never

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
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

    it('cross-workspace company_id rejected by trigger on contacts', async () => {
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
      ).rejects.toThrow(/same workspace/)
    })

    it('cross-workspace contact_id rejected by trigger on deals', async () => {
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
      ).rejects.toThrow(/same workspace/)
    })

    it('createContact dedupes by email — same address upserts into the existing row', async () => {
      const a = await store.createContact({ userId, workspaceId, name: 'A', email: 'team@acme.example' })
      // Second call with same email + different name should land on the
      // existing row (email is the higher-priority dedupe key) via the
      // supersession path. The returned id is the newest live id, not
      // necessarily `a.id` — but the chain head is `a`.
      const b = await store.createContact({ userId, workspaceId, name: 'B', email: 'team@acme.example' })
      // No new (entity, contact) pair: assert by counting active rows
      // with that email.
      const client = await pool!.connect()
      try {
        const result = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM contacts
            WHERE workspace_id = $1 AND lower(email) = lower($2) AND valid_to IS NULL`,
          [workspaceId, 'team@acme.example'],
        )
        expect(Number(result.rows[0]?.n)).toBe(1)
      } finally {
        client.release()
      }
      // The live row's id matches the supersession-merge return value.
      expect(b.email).toBe('team@acme.example')
    })
  })

  describe('FK SET NULL behavior', () => {
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

    it('deleting a contact sets deals.contact_id to NULL (deal survives)', async () => {
      const contact = await store.createContact({ userId, workspaceId, name: 'Sam' })
      const deal = await store.createDeal({ userId, workspaceId, contactId: contact.id, stage: 'proposal' })

      // Delete via raw SQL (no deleteContact tool in v1)
      const client = await pool!.connect()
      try {
        await client.query("SET app.system_bypass = ''")
        await client.query(`SET app.current_user_id = '${userId}'`)
        await client.query('DELETE FROM contacts WHERE id = $1', [contact.id])
        await client.query("SET app.system_bypass = 'true'")
      } finally {
        client.release()
      }

      const fetched = await store.getDealById({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, deal.id)
      expect(fetched).not.toBeNull()
      expect(fetched!.contactId).toBeNull()
      expect(fetched!.stage).toBe('proposal')
    })

    it('deleting a company sets contacts.company_id and deals.company_id to NULL', async () => {
      const company = await store.createCompany({ userId, workspaceId, name: 'Acme' })
      const contact = await store.createContact({ userId, workspaceId, name: 'Sam', companyId: company.id })
      const deal = await store.createDeal({ userId, workspaceId, contactId: contact.id, companyId: company.id })

      const client = await pool!.connect()
      try {
        await client.query("SET app.system_bypass = ''")
        await client.query(`SET app.current_user_id = '${userId}'`)
        await client.query('DELETE FROM companies WHERE id = $1', [company.id])
        await client.query("SET app.system_bypass = 'true'")
      } finally {
        client.release()
      }

      const c = await store.getContactById({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, contact.id)
      const d = await store.getDealById({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, deal.id)
      expect(c?.companyId).toBeNull()
      expect(d?.companyId).toBeNull()
      expect(d?.contactId).toBe(contact.id)
    })

    it('workspace delete cascades to all 3 entity tables', async () => {
      const company = await store.createCompany({ userId, workspaceId, name: 'Acme' })
      const contact = await store.createContact({ userId, workspaceId, name: 'Sam', companyId: company.id })
      await store.createDeal({ userId, workspaceId, contactId: contact.id, companyId: company.id })

      const client = await pool!.connect()
      try {
        await client.query('DELETE FROM workspaces WHERE id = $1', [workspaceId])
        const r1 = await client.query('SELECT count(*)::int AS n FROM contacts WHERE workspace_id = $1', [workspaceId])
        const r2 = await client.query('SELECT count(*)::int AS n FROM companies WHERE workspace_id = $1', [workspaceId])
        const r3 = await client.query('SELECT count(*)::int AS n FROM deals WHERE workspace_id = $1', [workspaceId])
        expect(r1.rows[0].n).toBe(0)
        expect(r2.rows[0].n).toBe(0)
        expect(r3.rows[0].n).toBe(0)
      } finally {
        client.release()
      }
    })
  })

  describe('RLS isolation', () => {
    // RLS isolation cannot be exercised when the test connects as a Postgres
    // SUPERUSER (the typical local-dev role). Superusers bypass RLS even with
    // FORCE ROW LEVEL SECURITY enabled. Production runs as a non-superuser, so
    // the policy does enforce — verified manually with `SET ROLE` in psql. The
    // tasks-store integration suite has the same limitation. To run this test
    // against a real RLS gate, connect as a role without rolsuper or rolbypassrls.
    it.skip('member of workspace A cannot see workspace B rows (skipped under superuser)', async () => {
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
})

describeIf('[COMP:brain/crm-write-wrapper] CRM write wrapper (Q24)', () => {
  let store: typeof import('../crm-store.js') extends { createDbCrmStore: infer T }
    ? T extends () => infer R ? R : never
    : never

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
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

  async function readContactEntityId(id: string): Promise<string | null> {
    const client = await pool!.connect()
    try {
      const r = await client.query<{ entityId: string | null }>(
        `SELECT entity_id AS "entityId" FROM contacts WHERE id = $1`,
        [id],
      )
      return r.rows[0]?.entityId ?? null
    } finally {
      client.release()
    }
  }

  async function readCompanyEntityId(id: string): Promise<string | null> {
    const client = await pool!.connect()
    try {
      const r = await client.query<{ entityId: string | null }>(
        `SELECT entity_id AS "entityId" FROM companies WHERE id = $1`,
        [id],
      )
      return r.rows[0]?.entityId ?? null
    } finally {
      client.release()
    }
  }

  async function readDealEntityId(id: string): Promise<string | null> {
    const client = await pool!.connect()
    try {
      const r = await client.query<{ entityId: string | null }>(
        `SELECT entity_id AS "entityId" FROM deals WHERE id = $1`,
        [id],
      )
      return r.rows[0]?.entityId ?? null
    } finally {
      client.release()
    }
  }

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

  it('createDeal with companyId — display_name="Deal — {company.name}"', async () => {
    const company = await store.createCompany({ userId, workspaceId, name: 'Acme' })
    const deal = await store.createDeal({
      userId, workspaceId, companyId: company.id, stage: 'proposal',
    })
    const entityId = await readDealEntityId(deal.id)
    const entity = await readEntity(entityId!)
    expect(entity!.kind).toBe('deal')
    expect(entity!.displayName).toBe('Deal — Acme')
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
    // Stage a company in a *different* workspace so the same-workspace
    // trigger on contacts will fire after the entity insert succeeds.
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
    ).rejects.toThrow(/same workspace/)

    const after = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM entities WHERE workspace_id = $1`,
      [workspaceId],
    )
    expect(after.rows[0].n).toBe(before.rows[0].n)
  })
})

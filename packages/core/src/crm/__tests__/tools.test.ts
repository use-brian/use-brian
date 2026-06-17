import { describe, it, expect } from 'vitest'
import { createCrmTools, type CrmToolEvent } from '../tools.js'
import type {
  CompanyRecord, ContactRecord, CrmStore, DealRecord, DealStage,
} from '../types.js'

// ── Fake in-memory store ────────────────────────────────────────────

type FakeData = {
  companies: CompanyRecord[]
  contacts: ContactRecord[]
  deals: DealRecord[]
}

function makeFakeStore(): CrmStore & { data: FakeData } {
  const data: FakeData = { companies: [], contacts: [], deals: [] }
  let next = 100
  const newId = (prefix: string) => `${prefix}-${String(next++).padStart(8, '0')}-0000-0000-0000-000000000000`.slice(0, 36)

  const store: CrmStore & { data: FakeData } = {
    data,

    // Companies
    async createCompany(params) {
      const now = new Date()
      const row: CompanyRecord = {
        id: newId('11111111'),
        workspaceId: params.workspaceId,
        entityId: newId('e1111111'),
        name: params.name,
        domain: params.domain ?? null,
        tags: params.tags ?? [],
        externalRef: params.externalRef ?? {},
        createdAt: now,
        updatedAt: now,
      }
      data.companies.push(row)
      return { ...row }
    },
    async getCompanyById(_ctx, id) {
      const row = data.companies.find((r) => r.id === id)
      return row ? { ...row } : null
    },
    async listCompanies(ctx, filters) {
      let rows = data.companies.filter((r) => r.workspaceId === ctx.workspaceId)
      if (filters.query) {
        const q = filters.query.toLowerCase()
        rows = rows.filter((r) => r.name.toLowerCase().includes(q) || (r.domain ?? '').toLowerCase().includes(q))
      }
      if (filters.tag) rows = rows.filter((r) => r.tags.includes(filters.tag!))
      return rows.slice(0, filters.limit ?? 25).map((r) => ({
        id: r.id, workspaceId: r.workspaceId, entityId: r.entityId, name: r.name, domain: r.domain,
        tags: r.tags, updatedAt: r.updatedAt,
      }))
    },
    async updateCompany(_userId, id, fields) {
      const row = data.companies.find((r) => r.id === id)
      if (!row) return null
      if (fields.name !== undefined) row.name = fields.name
      if (fields.domain !== undefined) row.domain = fields.domain
      if (fields.tags !== undefined) row.tags = fields.tags
      if (fields.externalRef !== undefined) row.externalRef = fields.externalRef
      row.updatedAt = new Date()
      return { ...row }
    },

    // Contacts
    async createContact(params) {
      // Mirror DB trigger semantics — reject cross-workspace company.
      if (params.companyId) {
        const company = data.companies.find((c) => c.id === params.companyId)
        if (!company || company.workspaceId !== params.workspaceId) {
          throw new Error('company_id must reference a company in the same workspace')
        }
      }
      const now = new Date()
      const row: ContactRecord = {
        id: newId('22222222'),
        workspaceId: params.workspaceId,
        entityId: newId('e2222222'),
        name: params.name,
        email: params.email ?? null,
        phone: params.phone ?? null,
        companyId: params.companyId ?? null,
        tags: params.tags ?? [],
        externalRef: params.externalRef ?? {},
        createdAt: now,
        updatedAt: now,
      }
      data.contacts.push(row)
      return { ...row }
    },
    async getContactById(_ctx, id) {
      const row = data.contacts.find((r) => r.id === id)
      return row ? { ...row } : null
    },
    async listContacts(ctx, filters) {
      let rows = data.contacts.filter((r) => r.workspaceId === ctx.workspaceId)
      if (filters.query) {
        const q = filters.query.toLowerCase()
        rows = rows.filter((r) => r.name.toLowerCase().includes(q) || (r.email ?? '').toLowerCase().includes(q))
      }
      if (filters.tag) rows = rows.filter((r) => r.tags.includes(filters.tag!))
      if (filters.companyId) rows = rows.filter((r) => r.companyId === filters.companyId)
      return rows.slice(0, filters.limit ?? 25).map((r) => ({
        id: r.id, workspaceId: r.workspaceId, entityId: r.entityId, name: r.name, email: r.email,
        companyId: r.companyId, tags: r.tags, updatedAt: r.updatedAt,
      }))
    },
    async updateContact(_userId, id, fields) {
      const row = data.contacts.find((r) => r.id === id)
      if (!row) return null
      if (fields.companyId !== undefined && fields.companyId !== null) {
        const company = data.companies.find((c) => c.id === fields.companyId)
        if (!company || company.workspaceId !== row.workspaceId) {
          throw new Error('company_id must reference a company in the same workspace')
        }
      }
      if (fields.name !== undefined) row.name = fields.name
      if (fields.email !== undefined) row.email = fields.email
      if (fields.phone !== undefined) row.phone = fields.phone
      if (fields.companyId !== undefined) row.companyId = fields.companyId
      if (fields.tags !== undefined) row.tags = fields.tags
      if (fields.externalRef !== undefined) row.externalRef = fields.externalRef
      row.updatedAt = new Date()
      return { ...row }
    },

    // Deals
    async createDeal(params) {
      if (params.contactId) {
        const c = data.contacts.find((x) => x.id === params.contactId)
        if (!c || c.workspaceId !== params.workspaceId) {
          throw new Error('contact_id must reference a contact in the same workspace')
        }
      }
      if (params.companyId) {
        const c = data.companies.find((x) => x.id === params.companyId)
        if (!c || c.workspaceId !== params.workspaceId) {
          throw new Error('company_id must reference a company in the same workspace')
        }
      }
      const now = new Date()
      const row: DealRecord = {
        id: newId('33333333'),
        workspaceId: params.workspaceId,
        entityId: newId('e3333333'),
        contactId: params.contactId ?? null,
        companyId: params.companyId ?? null,
        stage: params.stage ?? 'lead',
        amount: params.amount ?? null,
        closeDate: params.closeDate ?? null,
        externalRef: params.externalRef ?? {},
        createdAt: now,
        updatedAt: now,
      }
      data.deals.push(row)
      return { ...row }
    },
    async getDealById(_ctx, id) {
      const row = data.deals.find((r) => r.id === id)
      return row ? { ...row } : null
    },
    async listDeals(ctx, filters) {
      let rows = data.deals.filter((r) => r.workspaceId === ctx.workspaceId)
      if (filters.stage) {
        const set = Array.isArray(filters.stage) ? filters.stage : [filters.stage]
        rows = rows.filter((r) => set.includes(r.stage))
      }
      if (filters.contactId) rows = rows.filter((r) => r.contactId === filters.contactId)
      if (filters.companyId) rows = rows.filter((r) => r.companyId === filters.companyId)
      return rows.slice(0, filters.limit ?? 25).map((r) => ({
        id: r.id, workspaceId: r.workspaceId, entityId: r.entityId, contactId: r.contactId, companyId: r.companyId,
        stage: r.stage, amount: r.amount, closeDate: r.closeDate, updatedAt: r.updatedAt,
      }))
    },
    async updateDeal(_userId, id, fields) {
      const row = data.deals.find((r) => r.id === id)
      if (!row) return null
      if (fields.contactId !== undefined) row.contactId = fields.contactId
      if (fields.companyId !== undefined) row.companyId = fields.companyId
      if (fields.amount !== undefined) row.amount = fields.amount
      if (fields.closeDate !== undefined) row.closeDate = fields.closeDate
      if (fields.externalRef !== undefined) row.externalRef = fields.externalRef
      row.updatedAt = new Date()
      return { ...row }
    },
    async setDealStage(_userId, id, stage) {
      const row = data.deals.find((r) => r.id === id)
      if (!row) return null
      row.stage = stage
      row.updatedAt = new Date()
      return { ...row }
    },
    async batchLabels(_ctx, requests) {
      const out = new Map<string, string>()
      for (const req of requests) {
        for (const id of req.ids) {
          if (req.entity === 'company') {
            const c = data.companies.find((r) => r.id === id)
            if (c) out.set(`company:${id}`, c.name)
          } else if (req.entity === 'contact') {
            const c = data.contacts.find((r) => r.id === id)
            if (c) out.set(`contact:${id}`, c.name)
          } else {
            const d = data.deals.find((r) => r.id === id)
            if (d) out.set(`deal:${id}`, `Deal #${id.slice(0, 8)}`)
          }
        }
      }
      return out
    },
  }
  return store
}

// ── Test context ────────────────────────────────────────────────────

const WS_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

const ctx = {
  assistantId: 'assistant_1',
  userId: 'user_1',
  sessionId: 'session_1',
  appId: 'sidanclaw',
  channelType: 'web',
  channelId: 'c_1',
  workspaceId: WS_A,
  abortSignal: new AbortController().signal,
}

const ctxNoWorkspace = { ...ctx, workspaceId: null }

// ────────────────────────────────────────────────────────────────────

describe('[COMP:tools/crm-contacts] saveContact / getContact / listContacts / updateContact', () => {
  it('saveContact creates a contact and emits contact_created', async () => {
    const store = makeFakeStore()
    const events: CrmToolEvent[] = []
    const tools = createCrmTools(store, { onEvent: (e) => events.push(e) })

    const res = await tools.saveContact.execute({ name: 'Sam Lee', email: 'sam@acme.example' }, ctx)
    expect(res.isError).toBeFalsy()
    expect(typeof res.data).toBe('string')
    expect(res.data as string).toContain('Created contact')
    expect(res.data as string).toContain('Sam Lee')
    expect(store.data.contacts).toHaveLength(1)
    expect(store.data.contacts[0].email).toBe('sam@acme.example')
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('contact_created')
  })

  it('saveContact requires a workspace', async () => {
    const tools = createCrmTools(makeFakeStore())
    const res = await tools.saveContact.execute({ name: 'Sam' }, ctxNoWorkspace)
    expect(res.isError).toBe(true)
    expect(res.data as string).toContain('require a workspace')
  })

  it('saveContact translates cross-workspace company_id error', async () => {
    const store = makeFakeStore()
    // Company in different workspace
    await store.createCompany({ userId: 'user_1', workspaceId: 'other-ws', name: 'Other Inc' })
    const otherCompanyId = store.data.companies[0].id

    const tools = createCrmTools(store)
    const res = await tools.saveContact.execute({ name: 'Sam', company_id: otherCompanyId }, ctx)
    expect(res.isError).toBe(true)
    expect(res.data as string).toContain('same workspace')
  })

  it('saveContact email schema rejects invalid email', async () => {
    const tools = createCrmTools(makeFakeStore())
    const parsed = tools.saveContact.inputSchema.safeParse({ name: 'Sam', email: 'not-an-email' })
    expect(parsed.success).toBe(false)
  })

  it('saveContact rejects no-reply@ via classifier (system mailbox negative rule)', async () => {
    const { createEntityKindClassifier } = await import('../../classification/rules/entity-kind/index.js')
    const tools = createCrmTools(makeFakeStore(), {
      entityKindClassifier: createEntityKindClassifier(),
    })
    const res = await tools.saveContact.execute(
      { name: 'No-Reply Mailer', email: 'no-reply@github.com' },
      ctx,
    )
    expect(res.isError).toBe(true)
    const body = JSON.parse(res.data as string)
    expect(body.ok).toBe(false)
    expect(body.reason).toBe('reclassified')
    expect(body.blocking_rule_id).toBe('not-person-system-mailbox')
  })

  it('saveCompany rejects personal email domain via classifier', async () => {
    const { createEntityKindClassifier } = await import('../../classification/rules/entity-kind/index.js')
    const tools = createCrmTools(makeFakeStore(), {
      entityKindClassifier: createEntityKindClassifier(),
    })
    const res = await tools.saveCompany.execute(
      { name: 'gmail.com', domain: 'gmail.com' },
      ctx,
    )
    expect(res.isError).toBe(true)
    const body = JSON.parse(res.data as string)
    expect(body.ok).toBe(false)
    expect(body.blocking_rule_id).toBe('not-company-personal-domain')
  })

  it('saveContact passes through cleanly when classifier agrees', async () => {
    const { createEntityKindClassifier } = await import('../../classification/rules/entity-kind/index.js')
    const store = makeFakeStore()
    const tools = createCrmTools(store, {
      entityKindClassifier: createEntityKindClassifier(),
    })
    const res = await tools.saveContact.execute(
      { name: 'Alice Chen', email: 'alice@acme.com' },
      ctx,
    )
    expect(res.isError).toBeFalsy()
    expect(store.data.contacts).toHaveLength(1)
  })

  it('getContact returns full record', async () => {
    const store = makeFakeStore()
    const tools = createCrmTools(store)
    await tools.saveContact.execute({ name: 'Sam', phone: '+852 1234' }, ctx)
    const id = store.data.contacts[0].id
    const res = await tools.getContact.execute({ id }, ctx)
    expect(res.isError).toBeFalsy()
    expect((res.data as { phone: string }).phone).toBe('+852 1234')
  })

  it('getContact returns isError when not found', async () => {
    const tools = createCrmTools(makeFakeStore())
    const res = await tools.getContact.execute({ id: '99999999-9999-9999-9999-999999999999' }, ctx)
    expect(res.isError).toBe(true)
  })

  it('listContacts returns compact projection and emits contact_listed', async () => {
    const store = makeFakeStore()
    const events: CrmToolEvent[] = []
    const tools = createCrmTools(store, { onEvent: (e) => events.push(e) })
    await tools.saveContact.execute({ name: 'Sam', email: 'sam@acme.example' }, ctx)
    await tools.saveContact.execute({ name: 'Pat', email: 'pat@acme.example' }, ctx)

    const res = await tools.listContacts.execute({ query: 'sam' }, ctx)
    expect(res.isError).toBeFalsy()
    const rows = res.data as Array<{ name: string; email: string | null }>
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('Sam')
    expect(events.find((e) => e.type === 'contact_listed')).toBeTruthy()
  })

  it('updateContact patches selectively and rejects empty', async () => {
    const store = makeFakeStore()
    const tools = createCrmTools(store)
    await tools.saveContact.execute({ name: 'Sam' }, ctx)
    const id = store.data.contacts[0].id

    const empty = await tools.updateContact.execute({ id }, ctx)
    expect(empty.isError).toBe(true)

    const ok = await tools.updateContact.execute({ id, email: 'sam@new.example' }, ctx)
    expect(ok.isError).toBeFalsy()
    expect(store.data.contacts[0].email).toBe('sam@new.example')
    expect(store.data.contacts[0].name).toBe('Sam')
  })

  it('updateContact null-clears nullable fields', async () => {
    const store = makeFakeStore()
    const tools = createCrmTools(store)
    await tools.saveContact.execute({ name: 'Sam', email: 'sam@a.example' }, ctx)
    const id = store.data.contacts[0].id
    const res = await tools.updateContact.execute({ id, email: null }, ctx)
    expect(res.isError).toBeFalsy()
    expect(store.data.contacts[0].email).toBeNull()
  })

  it('updateContact returns not-found message for missing id', async () => {
    const tools = createCrmTools(makeFakeStore())
    const res = await tools.updateContact.execute(
      { id: '99999999-9999-9999-9999-999999999999', name: 'X' },
      ctx,
    )
    expect(res.isError).toBe(true)
    expect(res.data as string).toContain('not found')
  })
})

describe('[COMP:tools/crm-companies] saveCompany / getCompany / listCompanies / updateCompany', () => {
  it('saveCompany creates a company and emits company_created', async () => {
    const store = makeFakeStore()
    const events: CrmToolEvent[] = []
    const tools = createCrmTools(store, { onEvent: (e) => events.push(e) })
    const res = await tools.saveCompany.execute({ name: 'Acme', domain: 'acme.example' }, ctx)
    expect(res.isError).toBeFalsy()
    expect(res.data as string).toContain('Created company')
    expect(store.data.companies).toHaveLength(1)
    expect(store.data.companies[0].domain).toBe('acme.example')
    expect(events[0].type).toBe('company_created')
  })

  it('listCompanies filters by query', async () => {
    const store = makeFakeStore()
    const tools = createCrmTools(store)
    await tools.saveCompany.execute({ name: 'Acme', domain: 'acme.example' }, ctx)
    await tools.saveCompany.execute({ name: 'Globex', domain: 'globex.example' }, ctx)

    const res = await tools.listCompanies.execute({ query: 'acme' }, ctx)
    const rows = res.data as Array<{ name: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('Acme')
  })

  it('updateCompany null-clears domain', async () => {
    const store = makeFakeStore()
    const tools = createCrmTools(store)
    await tools.saveCompany.execute({ name: 'Acme', domain: 'acme.example' }, ctx)
    const id = store.data.companies[0].id
    const res = await tools.updateCompany.execute({ id, domain: null }, ctx)
    expect(res.isError).toBeFalsy()
    expect(store.data.companies[0].domain).toBeNull()
  })
})

describe('[COMP:tools/crm-deals] saveDeal / getDeal / listDeals / updateDeal / advanceDealStage', () => {
  async function seed() {
    const store = makeFakeStore()
    const events: CrmToolEvent[] = []
    const tools = createCrmTools(store, { onEvent: (e) => events.push(e) })
    await tools.saveCompany.execute({ name: 'Acme' }, ctx)
    await tools.saveContact.execute({ name: 'Sam' }, ctx)
    return {
      store, events, tools,
      companyId: store.data.companies[0].id,
      contactId: store.data.contacts[0].id,
    }
  }

  it('saveDeal requires contact_id or company_id (refine guard)', async () => {
    const { tools } = await seed()
    const parsed = tools.saveDeal.inputSchema.safeParse({ stage: 'lead' })
    expect(parsed.success).toBe(false)
  })

  it('saveDeal defaults stage to lead and accepts amount + close_date', async () => {
    const { tools, store, contactId, companyId } = await seed()
    const res = await tools.saveDeal.execute(
      { contact_id: contactId, company_id: companyId, amount: 50000, close_date: '2026-09-30' },
      ctx,
    )
    expect(res.isError).toBeFalsy()
    expect(store.data.deals[0].stage).toBe('lead')
    expect(store.data.deals[0].amount).toBe(50000)
    expect(store.data.deals[0].closeDate?.toISOString().slice(0, 10)).toBe('2026-09-30')
  })

  it('saveDeal rejects negative amount via Zod', async () => {
    const { tools } = await seed()
    const parsed = tools.saveDeal.inputSchema.safeParse({ contact_id: 'x', amount: -10 })
    expect(parsed.success).toBe(false)
  })

  it('saveDeal rejects malformed close_date via Zod', async () => {
    const { tools } = await seed()
    const parsed = tools.saveDeal.inputSchema.safeParse({
      contact_id: '11111111-1111-1111-1111-111111111111', close_date: '2026/09/30',
    })
    expect(parsed.success).toBe(false)
  })

  it('listDeals filters by stage array', async () => {
    const { tools, store, contactId } = await seed()
    await tools.saveDeal.execute({ contact_id: contactId, stage: 'proposal' }, ctx)
    await tools.saveDeal.execute({ contact_id: contactId, stage: 'negotiation' }, ctx)
    await tools.saveDeal.execute({ contact_id: contactId, stage: 'won' }, ctx)
    expect(store.data.deals).toHaveLength(3)

    const res = await tools.listDeals.execute({ stage: ['proposal', 'negotiation'] }, ctx)
    const rows = res.data as Array<{ stage: DealStage }>
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.stage === 'proposal' || r.stage === 'negotiation')).toBe(true)
  })

  it('updateDeal does NOT accept stage (must use advanceDealStage)', async () => {
    const { tools } = await seed()
    const parsed = tools.updateDeal.inputSchema.safeParse({
      id: '11111111-1111-1111-1111-111111111111',
      stage: 'won',
    } as unknown)
    // Zod with no explicit `.strict()` is non-strict by default — extra keys are stripped.
    // The proof of "no stage" is that the executed update path does not change stage:
    expect(parsed.success).toBe(true)
    // Belt-and-braces: assert the schema's known keys do NOT include stage.
    const shape = (tools.updateDeal.inputSchema as unknown as { _def: { schema: { shape: Record<string, unknown> } } })._def.schema?.shape
      ?? (tools.updateDeal.inputSchema as unknown as { shape: Record<string, unknown> }).shape
    if (shape) expect(Object.keys(shape)).not.toContain('stage')
  })

  it('updateDeal stage change has no effect (stage stripped or absent)', async () => {
    const { tools, store, contactId } = await seed()
    await tools.saveDeal.execute({ contact_id: contactId, stage: 'lead' }, ctx)
    const id = store.data.deals[0].id
    // Pass an extra `stage` field; Zod strips it. The deal stays in 'lead'.
    await tools.updateDeal.execute({ id, amount: 1234, stage: 'won' } as unknown as { id: string; amount: number }, ctx)
    expect(store.data.deals[0].stage).toBe('lead')
    expect(store.data.deals[0].amount).toBe(1234)
  })

  it('advanceDealStage updates stage and emits deal_stage_advanced', async () => {
    const { tools, store, events, contactId } = await seed()
    await tools.saveDeal.execute({ contact_id: contactId, stage: 'lead' }, ctx)
    const id = store.data.deals[0].id

    const res = await tools.advanceDealStage.execute({ id, stage: 'negotiation' }, ctx)
    expect(res.isError).toBeFalsy()
    expect(res.data as string).toContain('Moved deal')
    expect(res.data as string).toContain('negotiation')
    expect(store.data.deals[0].stage).toBe('negotiation')
    expect(events.find((e) => e.type === 'deal_stage_advanced')).toBeTruthy()
  })

  it('advanceDealStage Zod-rejects an invalid stage', async () => {
    const { tools } = await seed()
    const parsed = tools.advanceDealStage.inputSchema.safeParse({
      id: '11111111-1111-1111-1111-111111111111', stage: 'shipped',
    })
    expect(parsed.success).toBe(false)
  })

  it('advanceDealStage returns isError for missing deal', async () => {
    const { tools } = await seed()
    const res = await tools.advanceDealStage.execute(
      { id: '99999999-9999-9999-9999-999999999999', stage: 'won' },
      ctx,
    )
    expect(res.isError).toBe(true)
    expect(res.data as string).toContain('not found')
  })

  it('saveDeal translates cross-workspace contact_id error', async () => {
    const store = makeFakeStore()
    await store.createContact({ userId: 'u', workspaceId: 'other-ws', name: 'Other Sam' })
    const tools = createCrmTools(store)
    const res = await tools.saveDeal.execute({ contact_id: store.data.contacts[0].id }, ctx)
    expect(res.isError).toBe(true)
    expect(res.data as string).toContain('same workspace')
  })
})

describe('[COMP:crm/cross-entity] cross-entity filters', () => {
  it('listContacts({company_id}) returns only contacts at that company', async () => {
    const store = makeFakeStore()
    const tools = createCrmTools(store)
    await tools.saveCompany.execute({ name: 'Acme' }, ctx)
    const acmeId = store.data.companies[0].id
    await tools.saveCompany.execute({ name: 'Globex' }, ctx)
    const globexId = store.data.companies[1].id

    await tools.saveContact.execute({ name: 'Sam', company_id: acmeId }, ctx)
    await tools.saveContact.execute({ name: 'Pat', company_id: globexId }, ctx)
    await tools.saveContact.execute({ name: 'Lou' }, ctx)

    const res = await tools.listContacts.execute({ company_id: acmeId }, ctx)
    const rows = res.data as Array<{ name: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('Sam')
  })

  it('listDeals({contact_id}) returns only deals for that contact', async () => {
    const store = makeFakeStore()
    const tools = createCrmTools(store)
    await tools.saveContact.execute({ name: 'Sam' }, ctx)
    await tools.saveContact.execute({ name: 'Pat' }, ctx)
    const samId = store.data.contacts[0].id
    const patId = store.data.contacts[1].id

    await tools.saveDeal.execute({ contact_id: samId, stage: 'proposal' }, ctx)
    await tools.saveDeal.execute({ contact_id: patId, stage: 'lead' }, ctx)

    const res = await tools.listDeals.execute({ contact_id: samId }, ctx)
    const rows = res.data as Array<{ stage: DealStage }>
    expect(rows).toHaveLength(1)
    expect(rows[0].stage).toBe('proposal')
  })

  // §17 — every CRM tool must declare requiresCapability='crm' so the
  // per-turn filterToolsByCapabilities gate hides the tool from assistants
  // without an active 'crm' grant. See docs/plans/company-brain.md §17.
  it('all 13 CRM tools declare requiresCapability="crm"', () => {
    const tools = createCrmTools(makeFakeStore())
    const surface = [
      tools.saveContact, tools.getContact, tools.listContacts, tools.updateContact,
      tools.saveCompany, tools.getCompany, tools.listCompanies, tools.updateCompany,
      tools.saveDeal, tools.getDeal, tools.listDeals, tools.updateDeal, tools.advanceDealStage,
    ]
    expect(surface).toHaveLength(13)
    for (const tool of surface) {
      expect(tool.requiresCapability).toBe('crm')
    }
  })
})

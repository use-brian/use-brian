import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { createCrmTools, createEntityAliasTools, type AccessContext, type ToolContext } from '@use-brian/core'
import { createDbCrmStore } from '../crm-store.js'
import { addEntityAlias, removeEntityAlias } from '../entities-store.js'
import { getPool, getAppPool } from '../client.js'
import { listCrmRecordPage, lookupCrmRecords } from '../crm-r2.js'

const fixtureScript = new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href
const { assertLocalFixture } = await import(fixtureScript)
await assertLocalFixture()
const pool = getPool()
const store = createDbCrmStore()
const crm = createCrmTools(store)
const aliases = Object.fromEntries(createEntityAliasTools({
  addAlias: addEntityAlias, removeAlias: removeEntityAlias,
}).map((tool) => [tool.name, tool]))

async function workspace() {
  const userId = randomUUID()
  const workspaceId = randomUUID()
  await pool.query(`INSERT INTO users (id, auth_provider_id) VALUES ($1::uuid, $1::text)`, [userId])
  await pool.query(`INSERT INTO workspaces (id, name, owner_user_id) VALUES ($1, 'Alias fixture', $2)`, [workspaceId, userId])
  await pool.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [workspaceId, userId])
  const access: AccessContext = { workspaceId, userId, assistantId: randomUUID(), assistantKind: 'standard', clearance: 'internal', compartments: [], projectIds: [] }
  const context: ToolContext = { ...access, appId: 'test-app', sessionId: randomUUID(), channelType: 'web', channelId: 'fixture-chat', abortSignal: new AbortController().signal }
  return { userId, workspaceId, access, context }
}

describe('[COMP:crm/native-aliases] real native storage and CRM retrieval', () => {
  afterAll(async () => { await Promise.all([getAppPool().end(), pool.end()]) })

  it('teaches, retries, searches, edits, and removes an alias on one stable contact', async () => {
    const f = await workspace()
    const company = await store.createCompany({ userId:f.userId,workspaceId:f.workspaceId,access:f.access, name: 'Example Works' })
    const contact = await store.createContact({ userId:f.userId,workspaceId:f.workspaceId,access:f.access, name: 'Morgan Vale', email: 'morgan@example.com', phone: '+1 202 555 0142', companyId: company.id, tags: ['partner'] })
    const deal = await store.createDeal({ userId:f.userId,workspaceId:f.workspaceId,access:f.access, contactId: contact.id, companyId: company.id })
    for (const alias of ['  Momo  ', 'MOMO']) {
      const result = await aliases.noteAlias!.execute({ entity_id: contact.id, alias }, f.context)
      expect(result.isError).not.toBe(true)
      expect(result.data).toEqual({ entityId: contact.id, displayName: 'Morgan Vale', aliases: ['momo'] })
    }
    const expected = { id: contact.id, entity_id: contact.id, name: 'Morgan Vale', aliases: ['momo'], email: 'morgan@example.com', phone: '+1 202 555 0142', company_id: company.id, tags: ['partner'] }
    expect((await crm.getContact.execute({ id: contact.id }, f.context)).data).toMatchObject(expected)
    for (const query of ['Morgan Vale', 'MOMO', 'mom', '12025550142']) {
      expect((await crm.listContacts.execute({ query }, f.context)).data).toEqual([expect.objectContaining(expected)])
    }
    expect((await listCrmRecordPage(f.access, { kind: 'person', search: 'MOMO', sort: 'name', direction: 'asc', limit: 20 })).items).toEqual([expect.objectContaining({ id: contact.id, name: 'Morgan Vale', aliases: ['momo'] })])
    expect(await lookupCrmRecords({ ctx: f.access, kind: 'person', query: 'MOMO', limit: 20 })).toEqual([expect.objectContaining({ id: contact.id, name: 'Morgan Vale' })])
    const updated = await store.updateContact(f.userId, contact.id, { phone: '+1 202 555 0143' }, f.access)
    expect(updated).toMatchObject({ id: contact.id, name: 'Morgan Vale', aliases: ['momo'] })
    expect(await store.getDealById(f.access, deal.id)).toMatchObject({ contactId: contact.id, companyId: company.id })
    expect((await aliases.splitAlias!.execute({ entity_id: contact.id, alias: 'MOMO' }, f.context)).data).toEqual({ entityId: contact.id, displayName: 'Morgan Vale', aliases: [] })
    expect(await store.listContacts(f.access, { query: 'momo' })).toEqual([])
    expect(await store.listContacts(f.access, { query: 'Morgan Vale' })).toHaveLength(1)
  })

  it('round-trips company and deal aliases through canonical CRM projections', async () => {
    const f = await workspace()
    const company = await store.createCompany({ userId:f.userId,workspaceId:f.workspaceId,access:f.access, name: 'Example Industries' })
    const deal = await store.createDeal({ userId:f.userId,workspaceId:f.workspaceId,access:f.access, companyId: company.id })
    await addEntityAlias(f.userId, company.id, 'EI', f.access)
    await addEntityAlias(f.userId, deal.id, 'Renewal project', f.access)
    expect(await store.getCompanyById(f.access, company.id)).toMatchObject({ name: 'Example Industries', aliases: ['ei'] })
    expect(await store.listCompanies(f.access, { query: 'EI' })).toEqual([expect.objectContaining({ id: company.id, aliases: ['ei'] })])
    expect(await store.getDealById(f.access, deal.id)).toMatchObject({ id: deal.id, aliases: ['renewal project'] })
    for (const [kind, query, id] of [['company', 'EI', company.id], ['deal', 'Renewal project', deal.id]] as const) {
      expect((await listCrmRecordPage(f.access, { kind, search: query, sort: 'name', direction: 'asc', limit: 20 })).items).toEqual([expect.objectContaining({ id })])
    }
  })

  it('refuses visible identity conflicts without merging or renaming records', async () => {
    const f = await workspace()
    const first = await store.createContact({ userId:f.userId,workspaceId:f.workspaceId,access:f.access, name: 'Morgan Vale' })
    const second = await store.createContact({ userId:f.userId,workspaceId:f.workspaceId,access:f.access, name: 'Momo' })
    expect(await addEntityAlias(f.userId, first.id, 'Momo', f.access)).toEqual({ kind: 'conflict', conflictingEntityId: second.id })
    expect(await store.getContactById(f.access, first.id)).toMatchObject({ name: 'Morgan Vale', aliases: [] })
    expect(await store.listContacts(f.access, {})).toHaveLength(2)
  })

  it('enforces current workspace and clearance for both writes and alias searches', async () => {
    const f = await workspace()
    const other = await workspace()
    await pool.query(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'member')`, [other.workspaceId, f.userId])
    const outside = await store.createContact({ userId: f.userId, workspaceId: other.workspaceId, name: 'Outside Record' })
    const secret = await store.createContact({ userId:f.userId,workspaceId:f.workspaceId,access:f.access, name: 'Private Record', sensitivity: 'confidential' })
    for (const id of [outside.id, secret.id]) {
      expect(await addEntityAlias(f.userId, id, 'Blocked', f.access)).toEqual({ kind: 'not_found' })
      expect(await removeEntityAlias(f.userId, id, 'Blocked', f.access)).toBeNull()
    }
    // Hidden name conflicts must not disclose the hidden record's id.
    const visible = await store.createContact({ userId:f.userId,workspaceId:f.workspaceId,access:f.access, name: 'Visible Record' })
    expect(await addEntityAlias(f.userId, visible.id, 'Private Record', f.access)).toMatchObject({ kind: 'ok' })
    expect(await store.listContacts(f.access, { query: 'Private Record' })).toEqual([expect.objectContaining({ id: visible.id })])
    expect(await pool.query('SELECT id FROM entities WHERE id = ANY($1::uuid[]) AND cardinality(aliases) > 0', [[outside.id, secret.id]])).toMatchObject({ rowCount: 0 })
  })
})

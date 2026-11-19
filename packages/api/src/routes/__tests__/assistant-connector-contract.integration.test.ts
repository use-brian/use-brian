/**
 * HTTP -> membership -> real grant/settings stores -> fresh runtime readback.
 * Authentication middleware and provider transport have separate owners; these
 * requests carry authenticated identities. No internal implementation is mocked.
 * Required by operation-stores; only an owned disposable fixture is accepted.
 */
import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { assistantConnectorGrantsRoutes } from '../assistant-connector-grants.js'
import { createDbAssistantConnectorGrantsStore } from '../../db/assistant-connector-grants-store.js'
import { createDbAssistantConnectorStore } from '../../db/assistant-connector-store.js'
import { getAppPool, getPool, query } from '../../db/client.js'
import { assertActionAllowed } from '../../safety/assert-action-allowed.js'
import { bootCompositionSource } from '../../boot/__tests__/composition-source.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
afterAll(async () => { await getAppPool().end(); await getPool().end() })

let owner: string, member: string, outsider: string, assistant: string, otherAssistant: string
const grantStore = () => createDbAssistantConnectorGrantsStore()
const settings = () => createDbAssistantConnectorStore()
const path = (connector?: string) => `/api/assistant-connector-grants/${assistant}${connector ? `/${encodeURIComponent(connector)}` : ''}`
function app(userId: string | undefined = owner) {
  const server = express()
  server.use(express.json())
  server.use((req, _res, next) => { req.userId = userId; next() })
  server.use('/api/assistant-connector-grants', assistantConnectorGrantsRoutes({ store: grantStore() }))
  return request(server)
}
const patch = (connector: string, allowedActions: string[], userId = owner, readAllowed = true) =>
  app(userId).patch(path(connector)).send({ allowedActions, readAllowed }).expect(200)

beforeEach(async () => {
  owner = randomUUID(); member = randomUUID(); outsider = randomUUID()
  assistant = randomUUID(); otherAssistant = randomUUID()
  const workspace = randomUUID()
  for (const id of [owner, member, outsider]) {
    await query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)", [id])
  }
  await query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Connector contract',$2)", [workspace, owner])
  await query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [workspace, owner, member])
  for (const id of [assistant, otherAssistant]) {
    await query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind) VALUES($1,$2,$3,'Fixture assistant','standard')", [id, workspace, owner])
    await query("INSERT INTO assistant_members(assistant_id,user_id,role) VALUES($1,$2,'owner')", [id, owner])
  }
})

describe('[COMP:api/assistant-connector-grants-route] [COMP:brain/assistant-connector-grants-store] persisted grant contract', () => {
  it('persists edits, records the changing actor, revokes runtime access and resets to registry defaults on deletion', async () => {
    expect((await app().get(path()).expect(200)).body.grants).toEqual([])
    const initial = await grantStore().getForAssistantSystem(assistant, 'gcal')
    expect(initial).toMatchObject({ isDefault: true, readAllowed: true })
    expect(initial.allowedActions).toEqual(expect.arrayContaining(['googleCalendarCreateEvent', 'googleCalendarUpdateEvent']))
    expect(initial.allowedActions).not.toContain('googleCalendarDeleteEvent')
    expect(initial.allowedActions).not.toContain('googleCalendarListEvents')

    const created = (await patch('gcal', ['googleCalendarDeleteEvent'])).body.grant
    expect(created).toMatchObject({ assistantId: assistant, connectorId: 'gcal', grantedByUserId: owner })
    expect(await grantStore().getForAssistantSystem(assistant, 'gcal')).toMatchObject({ id: created.id, allowedActions: ['googleCalendarDeleteEvent'] })
    expect(await assertActionAllowed(grantStore(), assistant, 'gcal', 'googleCalendarDeleteEvent')).toEqual({ ok: true })

    // A fixed old timestamp makes this a causal update check, without sleeping.
    await query("UPDATE assistant_connector_grants SET updated_at='2000-01-01' WHERE id=$1", [created.id])
    const updated = (await patch('gcal', [], member, false)).body.grant
    expect(updated).toMatchObject({ id: created.id, grantedByUserId: member, readAllowed: false, allowedActions: [], grantedAt: created.grantedAt })
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(Date.parse('2000-01-01'))
    const listed = (await app(member).get(path()).expect(200)).body.grants
    expect(listed).toHaveLength(1)
    expect(listed[0]).toEqual(updated)
    expect(await grantStore().getForAssistantSystem(assistant, 'gcal')).not.toHaveProperty('isDefault')
    expect(await assertActionAllowed(grantStore(), assistant, 'gcal', 'googleCalendarDeleteEvent')).toMatchObject({ ok: false, reason: 'action_not_granted' })

    expect((await app().delete(path('gcal')).expect(200)).body).toEqual({ ok: true, removed: true })
    expect((await app().delete(path('gcal')).expect(200)).body).toEqual({ ok: true, removed: false })
    expect((await app().get(path()).expect(200)).body.grants).toEqual([])
    expect(await grantStore().getForAssistantSystem(assistant, 'gcal')).toEqual(initial)
  })

  it('binds grants to the exact assistant and account, with provider-derived defaults but no provider-row fallback', async () => {
    await patch('shopify', ['shopifyRefundOrder'])
    const account = 'shopify:fixture-account'
    const initial = await grantStore().getForAssistantSystem(assistant, account)
    expect(initial).toMatchObject({ connectorId: account, isDefault: true })
    expect(initial.allowedActions).toContain('shopifyCreateProduct')
    expect(initial.allowedActions).not.toContain('shopifyRefundOrder')
    await patch(account, [])
    expect(await grantStore().getForAssistantSystem(assistant, account)).toMatchObject({ allowedActions: [] })
    expect(await grantStore().getForAssistantSystem(otherAssistant, account)).toMatchObject({ isDefault: true })
    expect((await grantStore().listForAssistant(owner, assistant)).map(row => row.connectorId)).toEqual(['shopify', account])
    await app().delete(path(account)).expect(200)
    expect((await grantStore().getForAssistantSystem(assistant, 'shopify')).allowedActions).toEqual(['shopifyRefundOrder'])
  })

  it('rejects an invalid update without changing the persisted grant', async () => {
    await patch('imap', ['imapSendMessage'])
    const before = await grantStore().getForAssistantSystem(assistant, 'imap')
    await app().patch(path('imap')).send({ allowedActions: 'imapSendMessage' }).expect(400)
    expect(await grantStore().getForAssistantSystem(assistant, 'imap')).toEqual(before)
  })

  it.each(['get', 'patch', 'delete'] as const)('refuses anonymous %s before any grant can change', async method => {
    await patch('imap', ['imapSendMessage'])
    const before = await grantStore().getForAssistantSystem(assistant, 'imap')
    await app('')[method](method === 'get' ? path() : path('imap')).send({ allowedActions: [] }).expect(401)
    expect(await grantStore().getForAssistantSystem(assistant, 'imap')).toEqual(before)
  })

  it.each(['get', 'patch', 'delete'] as const)('refuses nonmember %s using the real membership lookup', async method => {
    await patch('imap', ['imapSendMessage'])
    const before = await grantStore().getForAssistantSystem(assistant, 'imap')
    await app(outsider)[method](method === 'get' ? path() : path('imap')).send({ allowedActions: [] }).expect(403)
    expect(await grantStore().getForAssistantSystem(assistant, 'imap')).toEqual(before)
  })

  it('also isolates direct store reads and writes through the ordinary RLS role', async () => {
    const role = (await getAppPool().query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false })
    await patch('imap', ['imapSendMessage'])
    const before = await grantStore().getForAssistantSystem(assistant, 'imap')
    expect(await grantStore().listForAssistant(outsider, assistant)).toEqual([])
    expect(await grantStore().delete(outsider, assistant, 'imap')).toBe(false)
    await expect(grantStore().upsert(outsider, { assistantId: assistant, connectorId: 'imap', readAllowed: true, allowedActions: [] })).rejects.toThrow()
    expect(await grantStore().getForAssistantSystem(assistant, 'imap')).toEqual(before)
  })

  it('keeps the shared OSS/hosted boot mount wired to the grant route', () => {
    const boot = bootCompositionSource()
    expect(boot).toContain("'/api/assistant-connector-grants',")
    expect(boot).toContain('assistantConnectorGrantsRoutes({ store: assistantConnectorGrantsStore })')
  })
})

describe('[COMP:api/assistant-connector-store] persisted read settings contract', () => {
  it('defaults on, falls back to the provider, lets the exact account override it, and isolates assistants', async () => {
    const account = 'imap:fixture-account'
    expect(await settings().isEnabled(assistant, account, 'imap')).toBe(true)
    expect(await settings().listForAssistant(assistant)).toEqual([])
    await settings().setEnabled(assistant, 'imap', false)
    expect(await settings().isEnabled(assistant, 'imap')).toBe(false)
    expect(await settings().isEnabled(assistant, account, 'imap')).toBe(false)
    await settings().setEnabled(assistant, account, true)
    expect(await settings().isEnabled(assistant, account, 'imap')).toBe(true)
    await settings().setEnabled(assistant, account, false)
    expect(await settings().isEnabled(assistant, account, 'imap')).toBe(false)
    expect((await settings().listForAssistant(assistant)).sort((a, b) => a.connectorId.localeCompare(b.connectorId))).toEqual([
      { connectorId: 'imap', enabled: false }, { connectorId: account, enabled: false },
    ])
    expect(await settings().isEnabled(otherAssistant, account, 'imap')).toBe(true)
    expect(await settings().listForAssistant(otherAssistant)).toEqual([])
  })
})

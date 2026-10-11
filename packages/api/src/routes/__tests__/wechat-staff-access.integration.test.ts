/**
 * WeChat staff access against a migration-replayed PostgreSQL 18
 * (scripts/crm/local-fixture.mjs), through the NOBYPASSRLS application role.
 * Staff connect through the real binding store, then their turns resolve
 * through the SAME kernel call the channel pipeline makes for a WeChat DM
 * (receipt-keyed session, `credentialCurrent` = the durable receipt), read
 * through the real retrieval predicate, and deliver through the real
 * recipient authorizer. Only the Tencent transport and the model are absent.
 * Spec: docs/architecture/channels/wechat.md → "Staff identity";
 * docs/plans/wechat-staff-access.md §7 (A6, A7, A8, A11).
 */
import { randomBytes, randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it } from 'vitest'
import { getAppPool, getPool, query } from '../../db/client.js'
import { createMemory, searchMemories } from '../../db/memories.js'
import { runWithAgentAccess } from '../../db/agent-access-context.js'
import { findAssistantById } from '../../db/users.js'
import { findOrCreateSession, findSessionAuthorityById } from '../../db/sessions.js'
import { getWorkspaceRoleSystem } from '../../db/workspace-store.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { connectorExposureAllowed } from '../../context-scope/connector-exposure.js'
import { createDeliveryAudienceAuthorizer } from '../../context-scope/delivery-authority.js'
import { billingPartyForAssistant } from '../../billing-party.js'
import {
  createChannelIdentityBindingStore,
  isWechatReceiptCurrentSystem,
  wechatSessionChannelId,
  type WechatIdentityReceipt,
} from '../../db/channel-identity-bindings.js'
import { accountRoutes } from '../account.js'
import { channelsRoutes } from '../channels.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
const store = createChannelIdentityBindingStore(randomBytes(32))
const id = () => randomUUID()

async function world() {
  const w = id(), owner = id(), alice = id(), carol = id(), bob = id(), admin = id()
  const assistant = id(), narrow = id(), sales = id(), finance = id()
  const secret = {
    general: `GENERAL_INTERNAL_${w.slice(0, 8)}`,
    salesInternal: `SALES_INTERNAL_${w.slice(0, 8)}`,
    salesConfidential: `SALES_CONFIDENTIAL_${w.slice(0, 8)}`,
    financeInternal: `FINANCE_INTERNAL_${w.slice(0, 8)}`,
  }
  for (const [u, name] of [[owner, 'Fixture owner'], [alice, 'Alice'], [carol, 'Carol'], [bob, 'Bob'], [admin, 'Admin']]) {
    await query(`INSERT INTO users(id, auth_provider, auth_provider_id, name, email) VALUES ($1::uuid, 'test', $1::text, $2, $1::text || '@example.com')`, [u, name])
  }
  await query(`INSERT INTO workspaces(id, name, purpose, owner_user_id, department_read_v2) VALUES ($1, 'WeChat staff fixture', 'Staff access verification', $2, true)`, [w, owner])
  for (const [u, role, clearance] of [[owner, 'owner', 'confidential'], [alice, 'member', 'internal'], [carol, 'member', 'confidential'], [bob, 'member', 'confidential'], [admin, 'admin', 'confidential']]) {
    await query(`INSERT INTO workspace_members(workspace_id, user_id, role, clearance) VALUES ($1, $2, $3, $4)`, [w, u, role, clearance])
  }
  await query(`INSERT INTO assistants(id, name, workspace_id, owner_user_id, kind, clearance, compartments) VALUES ($1, 'Shared staff assistant', $2, $3, 'standard', 'confidential', NULL)`, [assistant, w, owner])
  await query(`INSERT INTO assistants(id, name, workspace_id, owner_user_id, kind, clearance, compartments) VALUES ($1, 'Internal-only assistant', $2, $3, 'standard', 'internal', NULL)`, [narrow, w, owner])
  for (const [d, name] of [[sales, 'Sales'], [finance, 'Finance']]) {
    await query(`INSERT INTO workspace_groups(id, workspace_id, name, created_by, kind, key, compartment_key) VALUES ($1::uuid, $2, $3, $4, 'team', $1::text, $5)`, [d, w, name, owner, `team:${d}`])
    await query(`INSERT INTO workspace_compartments(workspace_id, key, label, created_by, managed_by, managed_ref_id) VALUES ($1, $2, $3, $4, 'team', $5)`, [w, `team:${d}`, name, owner, d])
    // The narrow assistant's department grants stop at internal: its ceiling,
    // not the member's, decides what a confidential member reads through it.
    for (const [a, clearance] of [[assistant, 'confidential'], [narrow, 'internal']]) {
      await query(`INSERT INTO department_edges(workspace_id, department_id, principal_kind, assistant_id, clearance, origin) VALUES ($1, $2, 'assistant', $3, $4, 'store') ON CONFLICT DO NOTHING`, [w, d, a, clearance])
    }
  }
  for (const [u, d, clearance] of [[alice, sales, 'internal'], [carol, sales, 'confidential'], [bob, finance, 'confidential']]) {
    await query(`INSERT INTO department_edges(workspace_id, department_id, principal_kind, user_id, clearance, origin) VALUES ($1, $2, 'user', $3, $4, 'store') ON CONFLICT DO NOTHING`, [w, d, u, clearance])
  }
  for (const [summary, sensitivity, compartments] of [
    [secret.general, 'internal', []],
    [secret.salesInternal, 'internal', [`team:${sales}`]],
    [secret.salesConfidential, 'confidential', [`team:${sales}`]],
    [secret.financeInternal, 'internal', [`team:${finance}`]],
  ] as const) {
    await createMemory({ workspaceId: w, assistantId: assistant, userId: null, createdByUserId: owner, summary, sensitivity, compartments: [...compartments] })
  }
  return { w, owner, alice, carol, bob, admin, assistant, narrow, sales, finance, secret }
}

type World = Awaited<ReturnType<typeof world>>

/** A staff member pairs their own WeChat (self mode): the real store transaction. */
async function connectSelf(f: World, accountId: string): Promise<WechatIdentityReceipt> {
  const botId = `${id().slice(0, 12)}@im.bot`, sender = `${id().slice(0, 16)}@im.wechat`
  const result = await store.provisionWechatTransport({
    workspaceId: f.w, actorUserId: accountId, mode: 'self', pairingId: id(), defaultAssistantId: f.assistant,
    credentials: { botToken: `t-${id()}`, baseUrl: 'https://ilink.example', ilinkBotId: botId, boundUserId: sender },
  })
  if (!result.ok || !result.binding) throw new Error(`pairing failed: ${JSON.stringify(result)}`)
  return result.binding
}

/**
 * One WeChat DM turn's authority, exactly as routes/wechat.ts + the channel
 * pipeline build it: resolve the sender through the store, open the
 * receipt-keyed session, and resolve the execution context with the live
 * receipt check.
 */
async function turn(f: World, receipt: WechatIdentityReceipt, assistantId = f.assistant) {
  const resolved = await store.resolveWechatSender({ channelId: receipt.channelId, botId: receipt.botId, senderId: receipt.senderId })
  if (resolved.kind !== 'bound') throw new Error(`not bound: ${resolved.kind}`)
  const r = resolved.receipt
  const assistant = (await findAssistantById(assistantId))!
  const sessionChannelId = wechatSessionChannelId(r)
  const session = await findOrCreateSession({ assistantId, userId: r.accountId, channelType: 'wechat', channelId: sessionChannelId })
  const authority = (await findSessionAuthorityById(session.id))!
  const billingUserId = await billingPartyForAssistant({ id: assistant.id, ownerUserId: null, workspaceId: f.w })
  const ctx = await resolveExecutionContextSystem({
    userId: r.accountId,
    assistant: { ...assistant, compartments: assistant.compartments ?? null },
    workspaceId: f.w,
    session: authority,
    memberMode: 'member',
    ignoreSessionBinding: false,
    sharedAudience: false,
    identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: r.accountId } },
    ownership: { kind: 'workspace', workspaceId: f.w },
    lifecycle: { abortSignal: new AbortController().signal, sessionId: session.id, channelType: 'wechat', channelId: r.senderId },
    attribution: { billingUserId },
    sessionAuthority: authority,
    credentialCurrent: () => isWechatReceiptCurrentSystem(r),
  })
  const access = ctx.executionContext.security.access
  const memories = async () => JSON.stringify(await runWithAgentAccess(access, () => searchMemories(access, { searchQuery: f.w.slice(0, 8), limit: 100 })))
  const deliver = () => createDeliveryAudienceAuthorizer()({
    workspaceId: f.w, assistantId, userId: r.accountId, channelType: 'wechat', channelId: r.senderId,
    sessionChannelId, recipientType: 'individual', scopeEvidence: {},
  })
  return { receipt: r, ctx, access, memories, deliver, billingUserId, lease: ctx.executionContext.security.authority }
}

describe('[COMP:api/wechat-inbound] WeChat staff access on PostgreSQL (A6, A7, A8, A11)', () => {
  afterAll(async () => { await getAppPool().end(); await pool.end() })

  it('A6: each staff WeChat turn reads exactly what that account may read; the assistant ceiling still wins', async () => {
    const f = await world()
    const role = (await getAppPool().query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0]
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false })
    const [alice, carol, bob] = await Promise.all([connectSelf(f, f.alice), connectSelf(f, f.carol), connectSelf(f, f.bob)])

    const at = await turn(f, alice)
    const a = await at.memories()
    expect(a).toContain(f.secret.general)
    expect(a).toContain(f.secret.salesInternal)
    expect(a).not.toContain(f.secret.salesConfidential) // internal-only staff
    expect(a).not.toContain(f.secret.financeInternal) // outside the department

    const c = await (await turn(f, carol)).memories()
    expect(c).toContain(f.secret.salesConfidential) // a permitted department member
    expect(c).not.toContain(f.secret.financeInternal)

    const b = await (await turn(f, bob)).memories()
    expect(b).toContain(f.secret.financeInternal)
    expect(b).not.toContain(f.secret.salesInternal)
    expect(b).not.toContain(f.secret.salesConfidential)

    // The narrower assistant still caps a permitted member.
    const nt = await turn(f, carol, f.narrow)
    const narrowed = await nt.memories()
    expect(narrowed).toContain(f.secret.salesInternal)
    expect(narrowed).not.toContain(f.secret.salesConfidential)

    // Persistence scope: a turn never writes into a department its actor lacks.
    const aliceTurn = await turn(f, alice)
    for (const compartment of aliceTurn.ctx.turnScope.writeCompartments) expect(compartment).not.toBe(`team:${f.finance}`)
    expect(aliceTurn.access.userId).toBe(f.alice)
  })

  it('A7: an admin-prepared bot linked by staff exposes only connectors the staff member may use; billing stays with the workspace', async () => {
    const f = await world()
    const botId = `${id().slice(0, 12)}@im.bot`, sender = `${id().slice(0, 16)}@im.wechat`
    const prepared = await store.provisionWechatTransport({
      workspaceId: f.w, actorUserId: f.admin, mode: 'admin_prepare', pairingId: id(), defaultAssistantId: f.assistant,
      credentials: { botToken: `t-${id()}`, baseUrl: 'https://ilink.example', ilinkBotId: botId, boundUserId: sender },
    })
    if (!prepared.ok) throw new Error('prepare')
    expect(prepared.binding).toBeNull()
    expect(await store.resolveWechatSender({ channelId: prepared.channelId, botId, senderId: sender })).toEqual({ kind: 'unbound' })
    const code = await store.mintWechatLinkCode({ accountId: f.alice, workspaceId: f.w, channelId: prepared.channelId })
    if (!code.ok) throw new Error('mint')
    const claimed = await store.claimWechatLinkCode({ channelId: prepared.channelId, botId, senderId: sender, code: code.code })
    if (!claimed.ok) throw new Error('claim')

    const t = await turn(f, claimed.receipt)
    expect(t.access.userId).toBe(f.alice) // the actor: never the admin who prepared it
    expect(t.billingUserId).toBe(f.owner) // the workspace billing party pays
    expect(t.ctx.executionContext.identity).toMatchObject({ principal: { userId: f.alice } })
    // The confidential, department-wide assistant cannot lend Alice a Finance connector.
    expect(connectorExposureAllowed(t.ctx.turnScope, { compartments: [`team:${f.finance}`], projectIds: [] })).toBe(false)
    expect(connectorExposureAllowed(t.ctx.turnScope, { compartments: [`team:${f.sales}`], projectIds: [] })).toBe(true)
  })

  it('A8: downgrade, removal, unlink, disconnect or re-pair stops a delayed turn for good; a cursor advance does not', async () => {
    const f = await world()
    const cases: Array<[string, (r: WechatIdentityReceipt) => Promise<unknown>, () => Promise<unknown>]> = [
      ['department downgrade', () => query(`DELETE FROM department_edges WHERE workspace_id = $1 AND user_id = $2`, [f.w, f.alice]),
        () => query(`INSERT INTO department_edges(workspace_id, department_id, principal_kind, user_id, clearance, origin) VALUES ($1, $2, 'user', $3, 'internal', 'store') ON CONFLICT DO NOTHING`, [f.w, f.sales, f.alice])],
      ['unlink', (r) => store.revokeOwnWechatBinding(f.alice, r.bindingId), async () => undefined],
      ['admin revoke', (r) => store.revokeWechatChannelBinding(f.w, r.channelId), async () => undefined],
      ['disconnect', (r) => store.invalidateWechatTransport(r.channelId), async () => undefined],
      ['re-pair', (r) => store.provisionWechatTransport({ workspaceId: f.w, actorUserId: f.alice, mode: 'self', pairingId: id(), defaultAssistantId: null,
        credentials: { botToken: `t-${id()}`, baseUrl: 'https://ilink.example', ilinkBotId: r.botId, boundUserId: r.senderId } }), async () => undefined],
    ]
    for (const [label, revoke, regrant] of cases) {
      const receipt = await connectSelf(f, f.alice)
      const t = await turn(f, receipt)
      await t.lease.assertCurrent()
      await expect(t.deliver()).resolves.toMatchObject({ allowed: true })
      // A cursor advance is not a credential change.
      expect(await store.persistWechatCursor(receipt.channelId, receipt.transportGeneration, `cursor-${label}`)).toBe(true)
      await t.lease.assertCurrent()

      await revoke(receipt)
      let toolRan = false
      await expect(t.lease.execute(async () => { toolRan = true })).rejects.toMatchObject({ reason: 'authority_changed' })
      expect(toolRan, label).toBe(false)
      if (label !== 'department downgrade') {
        await expect(t.deliver(), label).resolves.toMatchObject({ allowed: false, diagnostic: 'wechat_recipient_unbound' })
      }
      await regrant()
      await expect(t.lease.assertCurrent(), `${label}: regrant must not revive`).rejects.toMatchObject({ reason: 'authority_changed' })
    }

    const receipt = await connectSelf(f, f.bob)
    const t = await turn(f, receipt)
    await query(`DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [f.w, f.bob])
    await expect(t.lease.assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
    await expect(store.resolveWechatSender({ channelId: receipt.channelId, botId: receipt.botId, senderId: receipt.senderId }))
      .resolves.toMatchObject({ kind: 'bound' })
    expect(await getWorkspaceRoleSystem(f.bob, f.w)).toBeNull() // the inbound route's access-removed gate
  })

  it('A11: account and admin routes project and revoke only what the caller may, across workspaces', async () => {
    const f = await world(), other = await world()
    const alice = await connectSelf(f, f.alice)
    await connectSelf(f, f.bob)
    const foreign = await connectSelf(other, other.alice)
    const app = (userId: string) => {
      const a = express()
      a.use(express.json())
      a.use((req, _res, next) => { (req as { userId?: string }).userId = userId; next() })
      a.use('/api/account', accountRoutes({ wechatIdentityStore: store }))
      a.use('/api', channelsRoutes({
        workspaceStore: { getRole: (u: string, ws: string) => getWorkspaceRoleSystem(u, ws) } as never,
        identityStore: store,
      }))
      return request(a)
    }
    const mine = await app(f.alice).get(`/api/account/channel-identities?workspaceId=${f.w}`)
    expect(mine.body.wechatBindings.map((b: { bindingId: string }) => b.bindingId)).toEqual([alice.bindingId])
    expect(mine.body.wechatChannels).toEqual([])
    const adminView = await app(f.admin).get(`/api/account/channel-identities?workspaceId=${f.w}`)
    expect(adminView.body.wechatBindings).toEqual([])
    expect(adminView.body.wechatChannels.map((c: { state: string }) => c.state)).toEqual(['linked', 'linked'])
    const foreignAdmin = await app(other.owner).get(`/api/account/channel-identities?workspaceId=${f.w}`)
    expect(foreignAdmin.body.wechatChannels).toEqual([])

    // Bob cannot revoke Alice's binding, nor mint for a channel in another workspace.
    expect((await app(f.bob).delete(`/api/account/wechat/bindings/${alice.bindingId}`)).status).toBe(404)
    expect(await isWechatReceiptCurrentSystem(alice)).toBe(true)
    expect((await app(f.bob).post('/api/account/wechat/link-code').send({ workspaceId: other.w, channelId: foreign.channelId })).status).toBe(404)
    expect((await app(f.bob).post('/api/account/wechat/link-code').send({ workspaceId: f.w, channelId: foreign.channelId })).status).toBe(404)
    // A member cannot use the admin revocation; a foreign admin cannot reach this workspace's channel.
    expect((await app(f.bob).delete(`/api/workspaces/${f.w}/channels/${alice.channelId}/wechat/binding`)).status).toBe(403)
    expect((await app(other.owner).delete(`/api/workspaces/${other.w}/channels/${alice.channelId}/wechat/binding`)).status).toBe(404)
    expect(await isWechatReceiptCurrentSystem(alice)).toBe(true)
    // Self and admin revocation work, and assign nobody.
    expect((await app(f.admin).delete(`/api/workspaces/${f.w}/channels/${alice.channelId}/wechat/binding`)).body).toEqual({ ok: true, revoked: 1 })
    expect(await isWechatReceiptCurrentSystem(alice)).toBe(false)
    const active = await query(`SELECT 1 FROM identity_bindings WHERE channel_id = $1 AND revoked_at IS NULL`, [alice.channelId])
    expect(active.rowCount).toBe(0)
    expect((await app(f.alice).delete(`/api/account/wechat/bindings/${alice.bindingId}`)).status).toBe(200)
  })
})

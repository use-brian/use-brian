/**
 * WeChat staff access - route contracts with the Tencent transport mocked.
 * Pairing: creator-only polling and verification, explicit finalize, mode
 * authorization and retry idempotency (A2/A3). The real-database and
 * real-kernel cases live in wechat-staff-access.integration.test.ts.
 * Spec: docs/architecture/channels/wechat.md → "Connect flow", "Staff identity".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'

vi.mock('../../db/users.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/users.js')>()),
  findAssistantById: vi.fn(),
}))
vi.mock('../../context-scope/resolve-turn-scope.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../context-scope/resolve-turn-scope.js')>()),
  resolveLiveAccessCeilingSystem: vi.fn(),
}))

vi.mock('../../db/channels-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/channels-store.js')>()),
  getChannelForWebhook: vi.fn(),
  resolveRoutingForSurface: vi.fn(),
}))
vi.mock('../channel-pipeline.js', () => ({ processChannelMessage: vi.fn(async () => {}) }))
vi.mock('../../message-events.js', () => ({ dispatchIncomingMessageEvent: vi.fn(async () => {}) }))
vi.mock('../../billing-party.js', () => ({ billingPartyForAssistant: vi.fn(async () => 'billing-owner') }))
vi.mock('../../db/wechat-context-tokens.js', () => ({
  upsertWechatContextToken: vi.fn(async () => {}),
  getWechatContextToken: vi.fn(async () => 'ctx'),
}))
vi.mock('../../db/workspace-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/workspace-store.js')>()),
  getWorkspaceRoleSystem: vi.fn(),
}))
vi.mock('../../db/chat-lock.js', () => ({ withChatLock: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) }))
vi.mock('../../chat-archive/live-writer.js', () => ({
  archiveUnroutedInbound: vi.fn(async () => {}),
  resolveChatArchiveInstanceId: vi.fn(async () => null),
}))
vi.mock('@use-brian/channels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@use-brian/channels')>()),
  createWechatAdapter: vi.fn(),
  createIlinkClient: vi.fn(() => ({ getConfig: vi.fn(async () => ({})), sendTyping: vi.fn(async () => ({})) })),
}))

import { channelsRoutes } from '../channels.js'
import { wechatRoutes, WECHAT_IDENTITY_NOTICES, WECHAT_LINK_REPLIES } from '../wechat.js'
import { processChannelMessage } from '../channel-pipeline.js'
import { dispatchIncomingMessageEvent } from '../../message-events.js'
import { getChannelForWebhook, resolveRoutingForSurface } from '../../db/channels-store.js'
import { getWorkspaceRoleSystem } from '../../db/workspace-store.js'
import { upsertWechatContextToken } from '../../db/wechat-context-tokens.js'
import { archiveUnroutedInbound } from '../../chat-archive/live-writer.js'
import { createWechatAdapter } from '@use-brian/channels'
import { createDeliveryAudienceAuthorizer } from '../../context-scope/delivery-authority.js'
import { WorkflowStepSchema } from '@use-brian/core'
import { wechatSessionChannelId, type WechatIdentityReceipt } from '../../db/channel-identity-bindings.js'
import { findAssistantById } from '../../db/users.js'
import { resolveLiveAccessCeilingSystem } from '../../context-scope/resolve-turn-scope.js'
import type { ChannelIdentityBindingStore } from '../../db/channel-identity-bindings.js'
import type { WechatConnectorClient } from '../../wechat/connector-client.js'
import type { WorkspaceStore } from '../../db/workspace-store.js'
import type { ChannelIntegrationStore } from '../../db/channel-integrations.js'

const WS = '00000000-0000-4000-a000-0000000000aa'
const CHANNEL = '00000000-0000-4000-a000-0000000000cc'
const ASSISTANT = '00000000-0000-4000-a000-0000000000dd'
const confirmed = {
  pairingId: 'p1', status: 'confirmed' as const,
  result: { botToken: 'secret-token', baseUrl: 'https://ilink.example', ilinkBotId: 'b1@im.bot', boundUserId: 's1@im.wechat' },
}

function setup(roles: Record<string, 'owner' | 'admin' | 'member' | null>) {
  const workspaceStore = { getRole: vi.fn(async (userId: string) => roles[userId] ?? null) } as unknown as WorkspaceStore
  const connector = {
    startPairing: vi.fn().mockResolvedValue({ pairingId: 'p1', qrcodeUrl: 'https://qr.example/p1' }),
    pairingStatus: vi.fn().mockResolvedValue(confirmed),
    submitVerifyCode: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue({ channelId: CHANNEL, status: 'polling' }),
    disconnect: vi.fn(),
    status: vi.fn(),
  } satisfies WechatConnectorClient
  const identityStore = {
    provisionWechatTransport: vi.fn(),
    revokeWechatChannelBinding: vi.fn(),
    invalidateWechatTransport: vi.fn(),
    listWorkspaceWechatIdentitySummary: vi.fn(async () => [{ channelId: CHANNEL }]),
  } as unknown as ChannelIdentityBindingStore & {
    provisionWechatTransport: ReturnType<typeof vi.fn>
    revokeWechatChannelBinding: ReturnType<typeof vi.fn>
  }
  const analytics = { logEvent: vi.fn() }
  const router = channelsRoutes({
    workspaceStore,
    integrationStore: {} as ChannelIntegrationStore,
    wechatConnector: connector,
    identityStore,
    analytics: analytics as never,
  })
  const as = (userId: string) => {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => { (req as { userId?: string }).userId = userId; next() })
    app.use('/api', router)
    return request(app)
  }
  return { as, connector, identityStore, analytics }
}

const base = `/api/workspaces/${WS}/channels/wechat/pairing`

describe('[COMP:api/wechat-inbound] WeChat pairing: creator-only, explicit finalize', () => {
  beforeEach(() => {
    vi.mocked(findAssistantById).mockReset()
    vi.mocked(resolveLiveAccessCeilingSystem).mockReset()
  })

  it('A2: self pairing is creator-only for poll, verify-code and finalize; polling never persists', async () => {
    const t = setup({ alice: 'member', bob: 'member' })
    const start = await t.as('alice').post(base).send({ mode: 'self' })
    expect(start.status).toBe(201)
    expect(start.body).toEqual({ pairingId: 'p1', qrcodeUrl: 'https://qr.example/p1', status: 'qr', mode: 'self' })

    const poll = await t.as('alice').get(`${base}/p1`)
    expect(poll.body).toMatchObject({ status: 'confirmed', mode: 'self' })
    expect(JSON.stringify(poll.body)).not.toContain('secret-token')
    expect(t.identityStore.provisionWechatTransport).not.toHaveBeenCalled()

    for (const call of [
      t.as('bob').get(`${base}/p1`),
      t.as('bob').post(`${base}/p1/verify-code`).send({ code: '123456' }),
      t.as('bob').post(`${base}/p1/finalize`),
    ]) expect((await call).status).toBe(404)
    expect(t.connector.submitVerifyCode).not.toHaveBeenCalled()
    expect(t.identityStore.provisionWechatTransport).not.toHaveBeenCalled()
  })

  it('A2: finalize binds through the store as the creator, connects after commit, and retries idempotently', async () => {
    const t = setup({ alice: 'member' })
    let release!: () => void
    t.identityStore.provisionWechatTransport.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve({ ok: true, channelId: CHANNEL, reused: false, idempotent: false, generation: 3,
        binding: { bindingId: 'b', version: 1, accountId: 'alice', workspaceId: WS, channelId: CHANNEL, botId: 'b1@im.bot', senderId: 's1@im.wechat', transportGeneration: 3 } })
    }))
    await t.as('alice').post(base).send({ mode: 'self' })
    const first = t.as('alice').post(`${base}/p1/finalize`).then((r) => r)
    const second = t.as('alice').post(`${base}/p1/finalize`).then((r) => r)
    await vi.waitFor(() => expect(t.identityStore.provisionWechatTransport).toHaveBeenCalled())
    expect(t.connector.connect).not.toHaveBeenCalled()
    release()
    const [a, b] = await Promise.all([first, second])
    expect(a.body).toEqual({ status: 'connected', mode: 'self', channelId: CHANNEL, reused: false, identity: 'linked', connectorError: null })
    expect(b.body).toEqual(a.body)
    expect(t.identityStore.provisionWechatTransport).toHaveBeenCalledTimes(1)
    expect(t.identityStore.provisionWechatTransport).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WS, actorUserId: 'alice', mode: 'self', pairingId: 'p1', credentials: confirmed.result,
    }))
    expect(t.connector.connect).toHaveBeenCalledWith(CHANNEL, {
      botToken: 'secret-token', baseUrl: 'https://ilink.example', botId: 'b1@im.bot', generation: 3,
    })
    // Later polls return the committed result without touching the store.
    expect((await t.as('alice').get(`${base}/p1`)).body).toEqual(a.body)
    expect(t.identityStore.provisionWechatTransport).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(a.body)).not.toContain('secret-token')
  })

  it('A2: a removed member cannot finalize, and a failed connector start is retried without a second rotation', async () => {
    const roles: Record<string, 'member' | null> = { alice: 'member' }
    const t = setup(roles)
    await t.as('alice').post(base).send({ mode: 'self' })
    roles.alice = null
    expect((await t.as('alice').post(`${base}/p1/finalize`)).status).toBe(404)
    expect(t.identityStore.provisionWechatTransport).not.toHaveBeenCalled()

    roles.alice = 'member'
    t.identityStore.provisionWechatTransport
      .mockResolvedValueOnce({ ok: true, channelId: CHANNEL, reused: false, idempotent: false, generation: 1, binding: null })
      .mockResolvedValueOnce({ ok: true, channelId: CHANNEL, reused: true, idempotent: true, generation: 1, binding: null })
    t.connector.connect.mockRejectedValueOnce(new Error('connector down: secret-token'))
    const failed = await t.as('alice').post(`${base}/p1/finalize`)
    expect(failed.body).toMatchObject({ status: 'connected', connectorError: 'connector_unavailable' })
    expect(JSON.stringify(failed.body)).not.toContain('secret-token')
    const retried = await t.as('alice').post(`${base}/p1/finalize`)
    expect(retried.body).toMatchObject({ status: 'connected', connectorError: null })
    // The retry hit the store's idempotent path with the SAME pairing id.
    expect(t.identityStore.provisionWechatTransport.mock.calls.map((c) => c[0].pairingId)).toEqual(['p1', 'p1'])
  })

  it('A3: admin preparation needs owner/admin; an old client without mode is treated as preparation', async () => {
    const t = setup({ alice: 'member', admin: 'admin' })
    expect((await t.as('alice').post(base).send({ mode: 'admin_prepare' })).status).toBe(403)
    expect((await t.as('alice').post(base).send({})).status).toBe(403)
    expect(t.connector.startPairing).not.toHaveBeenCalled()
    const prepared = await t.as('admin').post(base).send({})
    expect(prepared.body.mode).toBe('admin_prepare')
    t.identityStore.provisionWechatTransport.mockResolvedValueOnce({ ok: true, channelId: CHANNEL, reused: false, idempotent: false, generation: 1, binding: null })
    const result = await t.as('admin').post(`${base}/p1/finalize`)
    expect(result.body).toMatchObject({ mode: 'admin_prepare', identity: 'unlinked' })
    expect(t.identityStore.provisionWechatTransport).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: 'admin', mode: 'admin_prepare' }))
  })

  it('maps store refusals to typed errors and never infers an owner', async () => {
    const t = setup({ alice: 'member' })
    await t.as('alice').post(base).send({ mode: 'self' })
    const cases: Array<[string, number]> = [
      ['missing_sender', 422], ['other_workspace', 409], ['binding_conflict', 409], ['duplicate_transport', 409], ['forbidden', 403],
    ]
    for (const [reason, status] of cases) {
      t.identityStore.provisionWechatTransport.mockResolvedValueOnce({ ok: false, reason })
      const res = await t.as('alice').post(`${base}/p1/finalize`)
      expect([res.status, res.body.error]).toEqual([status, reason])
    }
    expect(t.connector.connect).not.toHaveBeenCalled()
  })

  it('self pairing refuses an assistant the creator cannot use', async () => {
    const t = setup({ alice: 'member' })
    vi.mocked(findAssistantById).mockResolvedValue({ id: ASSISTANT, workspaceId: WS } as never)
    vi.mocked(resolveLiveAccessCeilingSystem).mockRejectedValueOnce(Object.assign(new Error('no'), { code: 'context_not_available' }))
    const res = await t.as('alice').post(base).send({ mode: 'self', defaultAssistantId: ASSISTANT })
    expect([res.status, res.body.code]).toEqual([403, 'assistant_unavailable'])
    vi.mocked(findAssistantById).mockResolvedValue({ id: ASSISTANT, workspaceId: 'other' } as never)
    expect((await t.as('alice').post(base).send({ mode: 'self', defaultAssistantId: ASSISTANT })).status).toBe(400)
    expect(t.connector.startPairing).not.toHaveBeenCalled()
  })

  it('A12: owners/admins read a WeChat connector state (paused, not running); members and foreign channels do not', async () => {
    const t = setup({ alice: 'member', admin: 'admin' })
    const path = `/api/workspaces/${WS}/channels/${CHANNEL}/wechat/transport`
    expect((await t.as('alice').get(path)).status).toBe(403)
    t.connector.status.mockResolvedValueOnce({ channelId: CHANNEL, status: 'paused' })
    expect((await t.as('admin').get(path)).body).toEqual({ status: 'paused' })
    t.connector.status.mockResolvedValueOnce(null)
    expect((await t.as('admin').get(path)).body).toEqual({ status: 'not_running' })
    t.connector.status.mockRejectedValueOnce(new Error('down'))
    expect((await t.as('admin').get(path)).body).toEqual({ status: 'unavailable' })
    const other = '00000000-0000-4000-a000-0000000000ee'
    expect((await t.as('admin').get(`/api/workspaces/${WS}/channels/${other}/wechat/transport`)).status).toBe(404)
  })

  it('A3/D9: only owners and admins revoke a connection binding, with an audit event', async () => {
    const t = setup({ alice: 'member', admin: 'admin' })
    t.identityStore.revokeWechatChannelBinding.mockResolvedValue({ found: true, revokedAccountIds: ['alice'] })
    const path = `/api/workspaces/${WS}/channels/${CHANNEL}/wechat/binding`
    expect((await t.as('alice').delete(path)).status).toBe(403)
    expect(t.identityStore.revokeWechatChannelBinding).not.toHaveBeenCalled()
    const res = await t.as('admin').delete(path)
    expect(res.body).toEqual({ ok: true, revoked: 1 })
    expect(t.identityStore.revokeWechatChannelBinding).toHaveBeenCalledWith(WS, CHANNEL)
    expect(t.analytics.logEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: 'wechat_binding_revoked', userId: 'admin' }))
  })
})

// ── Inbound: sender execution and session isolation ──────────────────

const SECRET = 'connector-secret'
type Bot = { channelId: string; botId: string; sender: string; account: string; integrationId: string; generation: number }

function bots(n: number): Bot[] {
  return Array.from({ length: n }, (_, i) => {
    const id = String(i + 1).padStart(12, '0')
    return {
      channelId: `00000000-0000-4000-a000-${id}`,
      botId: `bot${i + 1}@im.bot`,
      sender: `staff${i + 1}@im.wechat`,
      account: `00000000-0000-4000-b000-${id}`,
      integrationId: `00000000-0000-4000-c000-${id}`,
      generation: 1,
    }
  })
}

function receiptFor(b: Bot, version = 1): WechatIdentityReceipt {
  return {
    bindingId: `00000000-0000-4000-d000-${b.channelId.slice(-12)}`, version, accountId: b.account,
    workspaceId: WS, channelId: b.channelId, botId: b.botId, senderId: b.sender, transportGeneration: b.generation,
  }
}

function inboundWorld(fleet: Bot[], opts: { bindings?: Map<string, WechatIdentityReceipt | 'conflict' | 'error'> } = {}) {
  const byChannel = new Map(fleet.map((b) => [b.channelId, b]))
  const sent: Array<{ channelId: string; peer: string; text: string }> = []
  vi.mocked(createWechatAdapter).mockImplementation(((config: { botToken: string }) => ({
    sendMessage: vi.fn(async (peer: string, msg: { text: string }) => {
      sent.push({ channelId: config.botToken.replace('token-', ''), peer, text: msg.text })
      return 'mid'
    }),
  })) as never)
  vi.mocked(getChannelForWebhook).mockImplementation(async (id: string) => (byChannel.has(id)
    ? { id, workspaceId: WS, channelType: 'wechat', status: 'active', enabledCapabilities: ['chat'] } : null) as never)
  vi.mocked(resolveRoutingForSurface).mockResolvedValue({ assistantId: ASSISTANT, modelAlias: 'pro' } as never)
  vi.mocked(findAssistantById).mockResolvedValue({
    id: ASSISTANT, name: 'Brian', workspaceId: WS, ownerUserId: null, clearance: 'internal', kind: 'standard',
    compartments: ['ops'], defaultCompartments: [], teamScopeMode: 'assigned', systemPrompt: null,
  } as never)
  vi.mocked(getWorkspaceRoleSystem).mockResolvedValue('member')
  const bindings = opts.bindings ?? new Map(fleet.map((b) => [b.channelId, receiptFor(b)]))
  const integrationStore = {
    getByChannelForWebhook: vi.fn(async (channelId: string) => {
      const b = byChannel.get(channelId)
      return b ? {
        id: b.integrationId, channelId, config: {}, connectorInstanceId: null,
        credentials: { bot_token: `token-${channelId}`, base_url: 'https://ilink.example', ilink_bot_id: b.botId, bound_user_id: b.sender } as Record<string, string>,
      } : null
    }),
  }
  const identityStore = {
    getWechatTransportGeneration: vi.fn(async (channelId: string) => byChannel.get(channelId)?.generation ?? null),
    resolveWechatSender: vi.fn(async ({ channelId }: { channelId: string }) => {
      const r = bindings.get(channelId)
      if (r === 'error') throw new Error('store down')
      if (r === 'conflict') return { kind: 'conflict' }
      return r ? { kind: 'bound', receipt: r } : { kind: 'unbound' }
    }),
    isWechatReceiptCurrent: vi.fn(async () => true),
    claimWechatLinkCode: vi.fn(),
  }
  const app = express()
  app.use(express.json())
  app.use('/internal/wechat', wechatRoutes({
    connectorSecret: SECRET, integrationStore, identityStore, provider: {}, systemPrompt: '',
    tools: new Map(), memoryStore: {}, capabilityStore: {},
  } as never))
  const send = (b: Bot, text: string, over: Record<string, unknown> = {}) => request(app)
    .post('/internal/wechat/inbound').set('x-connector-secret', SECRET)
    .send({ channelId: b.channelId, generation: b.generation, message: { userId: b.sender, channelId: b.sender, messageId: `m-${Math.random()}`, text, raw: { context_token: 'ctx-1' }, ...over } })
  return { app, send, sent, identityStore, integrationStore }
}

const pipelineCalls = () => vi.mocked(processChannelMessage).mock.calls.map((c) => c[0])
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('[COMP:api/wechat-inbound] staff execution, isolation and fixed refusals', () => {
  beforeEach(() => {
    vi.mocked(processChannelMessage).mockClear()
    vi.mocked(dispatchIncomingMessageEvent).mockClear()
    vi.mocked(archiveUnroutedInbound).mockClear()
    vi.mocked(upsertWechatContextToken).mockClear()
  })

  it('A1: twelve bots in one workspace each run as their own staff account, never the billing owner', async () => {
    const fleet = bots(12)
    const w = inboundWorld(fleet)
    await Promise.all(fleet.map((b) => w.send(b, `hello from ${b.sender}`)))
    await vi.waitFor(() => expect(processChannelMessage).toHaveBeenCalledTimes(12))
    const calls = pipelineCalls()
    for (const b of fleet) {
      const call = calls.find((c) => c.channelId === b.sender)!
      expect(call).toMatchObject({
        userId: b.account, ownerId: 'billing-owner', isIdentified: true, senderLinkedIdentity: true,
        connectorAuthority: 'sender', actorChannelId: b.sender, channelId: b.sender,
        channelIntegrationId: b.integrationId,
        sessionChannelId: wechatSessionChannelId(receiptFor(b)),
      })
      expect(call.interactionScope).toMatchObject({ integrationId: b.channelId, sessionId: wechatSessionChannelId(receiptFor(b)) })
      expect(call.assistant).toMatchObject({ compartments: ['ops'], teamScopeMode: 'assigned' })
    }
    expect(new Set(calls.map((c) => c.userId)).size).toBe(12)
    expect(calls.some((c) => c.userId === 'billing-owner')).toBe(false)
    // Each turn's live credential check reads ITS OWN receipt.
    await calls[0].credentialCurrent!()
    expect(w.identityStore.isWechatReceiptCurrent).toHaveBeenCalledWith(
      receiptFor(fleet.find((b) => b.sender === calls[0].channelId)!))
  })

  it('A5: legacy/unbound bots, unknown or missing senders, store failure and duplicates make zero model calls', async () => {
    const fleet = bots(5)
    const [legacy, conflicted, broken, ok, missingSender] = fleet
    const w = inboundWorld(fleet, { bindings: new Map<string, WechatIdentityReceipt | 'conflict' | 'error'>([
      [conflicted.channelId, 'conflict'], [broken.channelId, 'error'], [ok.channelId, receiptFor(ok)],
      [missingSender.channelId, receiptFor(missingSender)],
    ]) })
    w.integrationStore.getByChannelForWebhook.mockImplementation(async (channelId: string) => {
      const b = fleet.find((x) => x.channelId === channelId)!
      return {
        id: b.integrationId, channelId, config: {}, connectorInstanceId: null,
        credentials: { bot_token: `token-${channelId}`, base_url: 'https://ilink.example', ilink_bot_id: b.botId,
          ...(b === missingSender ? {} : { bound_user_id: b.sender }) } as Record<string, string>,
      }
    })
    await w.send(legacy, 'hi')
    await w.send(conflicted, 'hi')
    await w.send(broken, 'hi')
    await w.send(missingSender, 'hi')
    await w.send(ok, 'hi', { userId: 'stranger@im.wechat', channelId: 'stranger@im.wechat' })
    await vi.waitFor(() => expect(w.sent).toHaveLength(5))
    expect(processChannelMessage).not.toHaveBeenCalled()
    expect(w.sent.map((m) => m.text).sort()).toEqual([
      WECHAT_IDENTITY_NOTICES.unlinked, WECHAT_IDENTITY_NOTICES.conflict, WECHAT_IDENTITY_NOTICES.unverified,
      WECHAT_IDENTITY_NOTICES.notOwner, WECHAT_IDENTITY_NOTICES.notOwner,
    ].sort())
    for (const text of Object.values(WECHAT_IDENTITY_NOTICES)) expect(text).not.toContain('\u2014')
  })

  it('A5: a removed member and a missing identity store get fixed notices, never a turn', async () => {
    const [b] = bots(1)
    const w = inboundWorld([b])
    vi.mocked(getWorkspaceRoleSystem).mockResolvedValueOnce(null)
    await w.send(b, 'hi')
    await vi.waitFor(() => expect(w.sent).toHaveLength(1))
    expect(w.sent[0].text).toBe(WECHAT_IDENTITY_NOTICES.accessRemoved)
    expect(processChannelMessage).not.toHaveBeenCalled()
  })

  it('LINK <code> is claimed before any event, archive, session or model sees the text', async () => {
    const [b] = bots(1)
    const w = inboundWorld([b], { bindings: new Map() })
    w.identityStore.claimWechatLinkCode
      .mockResolvedValueOnce({ ok: true, idempotent: false, receipt: receiptFor(b) })
      .mockResolvedValueOnce({ ok: false, reason: 'invalid' })
    const logs = vi.spyOn(console, 'log')
    await w.send(b, 'LINK abcd-efgh')
    await w.send(b, 'link wrongcode')
    await vi.waitFor(() => expect(w.sent).toHaveLength(2))
    expect(w.identityStore.claimWechatLinkCode).toHaveBeenNthCalledWith(1, expect.objectContaining({
      channelId: b.channelId, botId: b.botId, senderId: b.sender, code: 'ABCDEFGH',
    }))
    expect(w.identityStore.claimWechatLinkCode).toHaveBeenNthCalledWith(2, expect.objectContaining({ code: null }))
    expect(w.sent.map((m) => m.text)).toEqual([WECHAT_LINK_REPLIES.linked, WECHAT_LINK_REPLIES.invalid])
    expect(dispatchIncomingMessageEvent).not.toHaveBeenCalled()
    expect(archiveUnroutedInbound).not.toHaveBeenCalled()
    expect(processChannelMessage).not.toHaveBeenCalled()
    expect(upsertWechatContextToken).toHaveBeenCalled()
    expect(logs.mock.calls.flat().join(' ')).not.toContain('ABCDEFGH')
    logs.mockRestore()
  })

  it('A9: the same peer id on two bots, and a rebind on one bot, never share a session or scope', async () => {
    const [a, b] = bots(2)
    const shared = { ...b, sender: a.sender }
    const w = inboundWorld([a, shared])
    await w.send(a, 'one')
    await w.send(shared, 'two')
    await vi.waitFor(() => expect(processChannelMessage).toHaveBeenCalledTimes(2))
    const [first, second] = pipelineCalls()
    expect(first.channelId).toBe(second.channelId)
    expect(first.sessionChannelId).not.toBe(second.sessionChannelId)
    expect(first.interactionScope).not.toEqual(second.interactionScope)
    // Rebinding the first bot (new binding version) opens a new session key.
    w.identityStore.resolveWechatSender.mockResolvedValueOnce({ kind: 'bound', receipt: receiptFor(a, 2) })
    await w.send(a, 'three')
    await vi.waitFor(() => expect(processChannelMessage).toHaveBeenCalledTimes(3))
    expect(pipelineCalls()[2].sessionChannelId).not.toBe(first.sessionChannelId)
  })

  it('A10 (API side): an inbound from a replaced loop generation is ignored', async () => {
    const [b] = bots(1)
    const w = inboundWorld([b])
    await w.send({ ...b, generation: 99 }, 'from a stale loop')
    await settle()
    expect(processChannelMessage).not.toHaveBeenCalled()
    expect(dispatchIncomingMessageEvent).not.toHaveBeenCalled()
    expect(w.sent).toEqual([])
  })

  it('A9: workflow WeChat sends stay unsupported and an old owner session cannot authorize them', async () => {
    const [b] = bots(1)
    const step = (channelType: string) => WorkflowStepSchema.safeParse({
      id: 'notify', type: 'assistant_call', target: { assistantId: 'primary' }, prompt: 'Summarize',
      deliver: { channelType, channelId: b.sender },
    })
    expect(step('telegram').success).toBe(true)
    expect(step('wechat').success).toBe(false)
    // Independently, the recipient rule refuses an old raw-peer owner session.
    const authorize = createDeliveryAudienceAuthorizer({
      findAssistant: vi.fn(async () => ({ id: ASSISTANT, workspaceId: WS })) as never,
      findSession: vi.fn(async () => null),
      findChannelSession: vi.fn(async () => ({ id: 'old', assistantId: ASSISTANT, userId: 'billing-owner',
        channelType: 'wechat', channelId: b.sender, visibility: 'owner', anchorKind: 'none' })) as never,
      resolveLiveAccess: vi.fn(async () => ({ workspaceId: WS, userId: 'billing-owner', clearance: 'confidential' as const,
        compartments: null, mutationCompartments: null, projectIds: null, visibilityAssistantIds: null })),
      isWechatRecipientCurrent: vi.fn(async () => false),
    })
    await expect(authorize({ workspaceId: WS, assistantId: ASSISTANT, userId: 'billing-owner', channelType: 'wechat',
      channelId: b.sender, sessionChannelId: b.sender, recipientType: 'individual', scopeEvidence: {} }))
      .resolves.toMatchObject({ allowed: false, diagnostic: 'wechat_recipient_unbound' })
  })
})

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

import { channelsRoutes } from '../channels.js'
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

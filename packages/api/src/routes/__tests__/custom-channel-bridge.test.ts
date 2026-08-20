/**
 * [COMP:api/custom-channel-bridge] — bridge protocol v1 on
 * /bridge/v1/channels/:channelId.
 *
 * Pins: the bearer-token guard (constant-time hash compare, bare 401, 404 for
 * an unknown / inactive channel), the /hello shape, state persistence, the
 * inbound processing order (isSelf → archived as outbound, unaddressed group
 * → archived, answered DM → processChannelMessage with channelType 'custom'
 * and the reply enqueued as a `message` outbox item), and the outbox
 * long-poll + ack round trip. The pipeline and DB modules are mocked; the
 * store is an in-memory fake of `CustomChannelStore`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

vi.mock('../channel-pipeline.js', () => ({ processChannelMessage: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../db/users.js', () => ({ findAssistantById: vi.fn() }))
vi.mock('../../db/channels-store.js', () => ({
  getChannelForWebhook: vi.fn(),
  resolveRoutingForSurface: vi.fn(),
}))
vi.mock('../../db/channel-user-store.js', () => ({ resolveChannelUser: vi.fn() }))
vi.mock('../../db/chat-lock.js', () => ({ withChatLock: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) }))
vi.mock('../../billing-party.js', () => ({ billingPartyForAssistant: vi.fn(async () => 'owner') }))
vi.mock('../../db/client.js', () => ({
  query: vi.fn(async () => ({ rows: [{ owner_user_id: 'owner' }], rowCount: 1 })),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))
vi.mock('../../chat-archive/live-writer.js', () => ({
  archiveUnroutedInbound: vi.fn(async () => {}),
  appendOutboundChatArchive: vi.fn(async () => {}),
  resolveChatArchiveInstanceId: vi.fn(async () => null),
}))
vi.mock('../channel-file-cache.js', () => ({ cacheInboundImageTag: vi.fn(async () => '') }))
vi.mock('@use-brian/core', () => ({
  parseFileContent: vi.fn(async () => ({ text: '' })),
  sanitize: (v: string) => v,
}))
vi.mock('@use-brian/shared', () => ({
  getToolDisplayName: vi.fn(() => 'Tool'),
  formatConfirmationInput: vi.fn(() => []),
}))

import { customChannelBridgeRoutes } from '../custom-channel-bridge.js'
import { processChannelMessage } from '../channel-pipeline.js'
import { getChannelForWebhook, resolveRoutingForSurface } from '../../db/channels-store.js'
import { findAssistantById } from '../../db/users.js'
import { resolveChannelUser } from '../../db/channel-user-store.js'
import { archiveUnroutedInbound, appendOutboundChatArchive, resolveChatArchiveInstanceId } from '../../chat-archive/live-writer.js'
import { hashBridgeToken } from '../../db/custom-channel-token.js'
import type { CustomChannelStore, ClaimedOutboxItem, CustomChannelBridgeState } from '../../db/custom-channel-store.js'

const TOKEN = 'ubc_test-token-value'
const CHANNEL_ID = 'chan-1'
const BASE = `/bridge/v1/channels/${CHANNEL_ID}`

async function flush() {
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
}

/** In-memory CustomChannelStore fake — enough to drive the route end to end. */
function makeStore() {
  let seq = 0
  const items: Array<ClaimedOutboxItem & { leasedUntil: number; acked: boolean; ok?: boolean; providerMessageId?: string | null }> = []
  const states = new Map<string, CustomChannelBridgeState & { lastSeenAt: string }>()
  const store: CustomChannelStore = {
    putState: vi.fn(async (channelId, state) => {
      states.set(channelId, { ...state, lastSeenAt: new Date().toISOString() })
    }),
    getState: vi.fn(async (channelId) => {
      const s = states.get(channelId)
      if (!s) return null
      return { ...s, channelId, updatedAt: s.lastSeenAt, online: true, outboxDepth: items.filter((i) => !i.acked).length }
    }),
    touchSeen: vi.fn(async () => {}),
    enqueue: vi.fn(async (_channelId, item) => {
      seq += 1
      const id = `00000000-0000-0000-0000-${String(seq).padStart(12, '0')}`
      items.push({ id, type: item.type, peerId: item.peerId, payload: item.payload, createdAt: new Date().toISOString(), leasedUntil: 0, acked: false })
      return id
    }),
    claim: vi.fn(async (_channelId, limit) => {
      const now = Date.now()
      const out = items.filter((i) => !i.acked && i.leasedUntil < now).slice(0, limit)
      for (const i of out) i.leasedUntil = now + 60_000
      return out.map(({ id, type, peerId, payload, createdAt }) => ({ id, type, peerId, payload, createdAt }))
    }),
    ack: vi.fn(async (_channelId, results) => {
      let n = 0
      for (const r of results) {
        const item = items.find((i) => i.id === r.id && !i.acked)
        if (!item) continue
        item.acked = true; item.ok = r.ok; item.providerMessageId = r.providerMessageId ?? null
        n += 1
      }
      return n
    }),
    expireStale: vi.fn(async () => []),
  }
  return { store, items, states }
}

function makeIntegrationStore(over: { config?: Record<string, unknown>; credentials?: Record<string, unknown> } = {}) {
  return {
    getByChannelForWebhook: vi.fn().mockResolvedValue({
      id: 'int-1',
      channelId: CHANNEL_ID,
      config: over.config ?? {},
      credentials: over.credentials ?? { bridge_token_hash: hashBridgeToken(TOKEN), kind: 'wechat-desktop' },
      connectorInstanceId: null,
    }),
  }
}

function buildApp(opts: {
  integrationStore?: ReturnType<typeof makeIntegrationStore>
  store?: CustomChannelStore
  archiveMedia?: { storeBuffer: ReturnType<typeof vi.fn>; uploadTarget: ReturnType<typeof vi.fn> }
} = {}) {
  const { store } = opts.store ? { store: opts.store } : makeStore()
  const integrationStore = opts.integrationStore ?? makeIntegrationStore()
  const app = createTestApp('/bridge/v1/channels', customChannelBridgeRoutes({
    integrationStore: integrationStore as never,
    customChannelStore: store,
    channelUserStore: {} as never,
    provider: {} as never,
    systemPrompt: '',
    tools: new Map(),
    memoryStore: {} as never,
    capabilityStore: {} as never,
    sleep: async () => {},
    archiveMedia: opts.archiveMedia as never,
  }))
  return { app, store, integrationStore }
}

const activeChannel = {
  id: CHANNEL_ID,
  workspaceId: 'ws-1',
  channelType: 'custom',
  status: 'active',
  enabledCapabilities: ['chat'],
  displayName: 'My bridge',
}

function inbound(over: Record<string, unknown> = {}) {
  return {
    message: {
      peerId: 'peer-1',
      senderId: 'peer-1',
      messageId: 'm-1',
      text: 'hi',
      timestamp: 1_700_000_000_000,
      isGroupChat: false,
      ...over,
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getChannelForWebhook).mockResolvedValue(activeChannel as never)
  vi.mocked(resolveRoutingForSurface).mockResolvedValue({ assistantId: 'a-1', modelAlias: 'pro' } as never)
  vi.mocked(findAssistantById).mockResolvedValue({ id: 'a-1', name: 'Brian', ownerUserId: 'owner', workspaceId: 'ws-1' } as never)
  vi.mocked(resolveChannelUser).mockResolvedValue({ user: { id: 'cu-1' }, isIdentified: false } as never)
})

describe('[COMP:api/custom-channel-bridge] token guard', () => {
  it('401s with no body on a missing or wrong token', async () => {
    const { app, integrationStore } = buildApp()
    const none = await request(app).get(`${BASE}/hello`)
    expect(none.status).toBe(401)
    expect(none.text).toBe('')
    const wrong = await request(app).get(`${BASE}/hello`).set('Authorization', 'Bearer ubc_wrong')
    expect(wrong.status).toBe(401)
    expect(wrong.text).toBe('')
    // The lookup ran (the guard compares against the stored hash), but nothing
    // downstream did.
    expect(integrationStore.getByChannelForWebhook).toHaveBeenCalled()
  })

  it('404s an unknown, non-custom, or inactive channel', async () => {
    const { app } = buildApp()
    vi.mocked(getChannelForWebhook).mockResolvedValueOnce(null)
    expect((await request(app).get(`${BASE}/hello`).set('Authorization', `Bearer ${TOKEN}`)).status).toBe(404)
    vi.mocked(getChannelForWebhook).mockResolvedValueOnce({ ...activeChannel, status: 'revoked' } as never)
    expect((await request(app).get(`${BASE}/hello`).set('Authorization', `Bearer ${TOKEN}`)).status).toBe(404)
    vi.mocked(getChannelForWebhook).mockResolvedValueOnce({ ...activeChannel, channelType: 'telegram' } as never)
    expect((await request(app).get(`${BASE}/hello`).set('Authorization', `Bearer ${TOKEN}`)).status).toBe(404)
  })

  it('404s when the channel has no custom integration row', async () => {
    const integrationStore = makeIntegrationStore()
    integrationStore.getByChannelForWebhook.mockResolvedValue(null)
    const { app } = buildApp({ integrationStore })
    expect((await request(app).get(`${BASE}/hello`).set('Authorization', `Bearer ${TOKEN}`)).status).toBe(404)
  })
})

describe('[COMP:api/custom-channel-bridge] hello + state + heartbeat', () => {
  it('GET /hello returns the channel facts + protocol version and bumps last_seen_at', async () => {
    const { app, store } = buildApp({ integrationStore: makeIntegrationStore({ config: { requireMention: false, userAccessMode: 'allowlist' } }) })
    const res = await request(app).get(`${BASE}/hello`).set('Authorization', `Bearer ${TOKEN}`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      channelId: CHANNEL_ID,
      workspaceId: 'ws-1',
      displayName: 'My bridge',
      kind: 'wechat-desktop',
      config: { requireMention: false, userAccessMode: 'allowlist' },
      protocol: 1,
    })
    expect(typeof res.body.serverTime).toBe('string')
    expect(store.touchSeen).toHaveBeenCalledWith(CHANNEL_ID)
  })

  it('defaults requireMention to true and userAccessMode to allow_all', async () => {
    const { app } = buildApp()
    const res = await request(app).get(`${BASE}/hello`).set('Authorization', `Bearer ${TOKEN}`)
    expect(res.body.config).toEqual({ requireMention: true, userAccessMode: 'allow_all' })
  })

  it('PUT /state persists the published state; a bad payload is 400', async () => {
    const { app, store } = buildApp()
    const res = await request(app)
      .put(`${BASE}/state`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ status: 'needs_action', message: 'Scan', action: { kind: 'qr', text: 'hello' }, bridgeVersion: 'abc123' })
    expect(res.status).toBe(200)
    expect(store.putState).toHaveBeenCalledWith(CHANNEL_ID, {
      status: 'needs_action', message: 'Scan', action: { kind: 'qr', text: 'hello' }, bridgeVersion: 'abc123',
    })
    const bad = await request(app).put(`${BASE}/state`).set('Authorization', `Bearer ${TOKEN}`).send({ status: 'nope' })
    expect(bad.status).toBe(400)
  })

  it('POST /heartbeat bumps last_seen_at', async () => {
    const { app, store } = buildApp()
    const res = await request(app).post(`${BASE}/heartbeat`).set('Authorization', `Bearer ${TOKEN}`).send({})
    expect(res.status).toBe(200)
    expect(store.touchSeen).toHaveBeenCalledWith(CHANNEL_ID)
  })
})

describe('[COMP:api/custom-channel-bridge] inbound', () => {
  it('rejects a malformed payload with 400 and an oversize one with 413', async () => {
    const { app } = buildApp()
    expect((await request(app).post(`${BASE}/inbound`).set('Authorization', `Bearer ${TOKEN}`).send({ message: { peerId: 'p' } })).status).toBe(400)
    const big = await request(app)
      .post(`${BASE}/inbound`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(inbound({ media: [{ kind: 'document', mime: 'application/pdf', name: 'big.pdf', url: 'https://example.com/big.pdf', sizeBytes: 26 * 1024 * 1024 }] }))
    expect(big.status).toBe(413)
    await flush()
    expect(processChannelMessage).not.toHaveBeenCalled()
  })

  it('isSelf → archived as outbound on the conversation, 202, never a turn', async () => {
    const { app } = buildApp()
    const res = await request(app)
      .post(`${BASE}/inbound`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(inbound({ senderId: 'me', senderName: 'Ken', isSelf: true, text: 'replying from my phone' }))
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ ok: true, archivedOnly: true })
    await flush()
    expect(appendOutboundChatArchive).toHaveBeenCalledTimes(1)
    expect(vi.mocked(appendOutboundChatArchive).mock.calls[0][0]).toMatchObject({
      source: 'custom',
      ownerUserId: 'owner',
      workspaceId: 'ws-1',
      conversationId: 'peer-1',
      assistantId: 'me',
      assistantName: 'Ken',
      providerMessageId: 'm-1',
      text: 'replying from my phone',
    })
    expect(processChannelMessage).not.toHaveBeenCalled()
    expect(resolveRoutingForSurface).not.toHaveBeenCalled()
  })

  it('unaddressed group message → archived (never dropped), 202, no turn', async () => {
    const { app } = buildApp()
    const res = await request(app)
      .post(`${BASE}/inbound`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(inbound({ peerId: 'group-1', senderId: 'u-9', isGroupChat: true, isMentioned: false }))
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ ok: true, archivedOnly: true })
    await flush()
    expect(archiveUnroutedInbound).toHaveBeenCalledTimes(1)
    expect(vi.mocked(archiveUnroutedInbound).mock.calls[0][0]).toMatchObject({
      source: 'custom', workspaceId: 'ws-1', conversationId: 'group-1',
    })
    expect(processChannelMessage).not.toHaveBeenCalled()
  })

  it('a blocked sender is archived, not ignored', async () => {
    const { app } = buildApp({ integrationStore: makeIntegrationStore({ config: { userAccessMode: 'blocklist', blockedUserIds: ['peer-1'] } }) })
    const res = await request(app).post(`${BASE}/inbound`).set('Authorization', `Bearer ${TOKEN}`).send(inbound())
    expect(res.status).toBe(202)
    await flush()
    expect(archiveUnroutedInbound).toHaveBeenCalledTimes(1)
    expect(processChannelMessage).not.toHaveBeenCalled()
  })

  it('no routing → archived, 202', async () => {
    vi.mocked(resolveRoutingForSurface).mockResolvedValueOnce(null)
    const { app } = buildApp()
    const res = await request(app).post(`${BASE}/inbound`).set('Authorization', `Bearer ${TOKEN}`).send(inbound())
    expect(res.status).toBe(202)
    await flush()
    expect(archiveUnroutedInbound).toHaveBeenCalledTimes(1)
    expect(processChannelMessage).not.toHaveBeenCalled()
  })

  it('an answered DM acks 200, resolves a channel-namespaced tier-2 user, runs the turn as custom, and enqueues the reply', async () => {
    vi.mocked(processChannelMessage).mockImplementationOnce(async (params) => {
      await params.hooks.onProcessingStart?.()
      const out = await params.hooks.sendResponse('Hello back')
      expect(out).toEqual({ channelMessageId: expect.stringMatching(/^00000000-/) })
      await params.hooks.onCleanup?.()
    })
    const { app, store } = buildApp()
    const res = await request(app).post(`${BASE}/inbound`).set('Authorization', `Bearer ${TOKEN}`).send(inbound({ senderName: 'Peer One' }))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    await flush()

    expect(resolveChannelUser).toHaveBeenCalledTimes(1)
    const [, provider, providerUserId, assistantId] = vi.mocked(resolveChannelUser).mock.calls[0]
    expect(provider).toBe('custom')
    expect(providerUserId).toBe(`${CHANNEL_ID}:peer-1`)
    expect(assistantId).toBe('a-1')

    expect(processChannelMessage).toHaveBeenCalledTimes(1)
    const arg = vi.mocked(processChannelMessage).mock.calls[0][0]
    expect(arg.channelType).toBe('custom')
    expect(arg.channelId).toBe('peer-1')
    expect(arg.userId).toBe('cu-1')
    expect(arg.isIdentified).toBe(false)
    expect(arg.messageText).toBe('hi')
    expect(arg.incomingChannelMessageId).toBe('m-1')

    const enqueued = vi.mocked(store.enqueue).mock.calls.map((c) => c[1])
    expect(enqueued).toContainEqual({ type: 'typing', peerId: 'peer-1', payload: { on: true } })
    expect(enqueued).toContainEqual({ type: 'message', peerId: 'peer-1', payload: { text: 'Hello back', format: 'markdown' } })
    expect(enqueued).toContainEqual({ type: 'typing', peerId: 'peer-1', payload: { on: false } })
  })

  it('a pending text confirmation is resolved by the next message instead of starting a turn', async () => {
    const resolver = { resolve: vi.fn() }
    vi.mocked(processChannelMessage).mockImplementationOnce(async (params) => {
      await params.hooks.onConfirmationRequired?.(
        { toolCallId: 'tc-1', toolName: 'sendEmail', input: {}, allowPersistentApproval: true } as never,
        resolver as never,
      )
    })
    const { app, store } = buildApp()
    await request(app).post(`${BASE}/inbound`).set('Authorization', `Bearer ${TOKEN}`).send(inbound())
    await flush()
    const prompt = vi.mocked(store.enqueue).mock.calls.map((c) => c[1]).find((i) => i.type === 'message')
    expect(String(prompt?.payload.text)).toContain('Reply: yes / no / always / never')

    await request(app).post(`${BASE}/inbound`).set('Authorization', `Bearer ${TOKEN}`).send(inbound({ messageId: 'm-2', text: 'yes' }))
    await flush()
    expect(resolver.resolve).toHaveBeenCalledWith('tc-1', 'allow')
    expect(processChannelMessage).toHaveBeenCalledTimes(1)
  })
})

describe('[COMP:api/custom-channel-bridge] outbox', () => {
  it('long-poll returns leased items, ack settles them, and settled items do not reappear', async () => {
    const { app, store } = buildApp()
    const id = await store.enqueue(CHANNEL_ID, { type: 'message', peerId: 'peer-1', payload: { text: 'hi', format: 'markdown' } })

    const poll = await request(app).get(`${BASE}/outbox?wait=0&limit=20`).set('Authorization', `Bearer ${TOKEN}`)
    expect(poll.status).toBe(200)
    expect(poll.body.items).toHaveLength(1)
    expect(poll.body.items[0]).toMatchObject({ id, type: 'message', peerId: 'peer-1', payload: { text: 'hi', format: 'markdown' } })
    expect(store.touchSeen).toHaveBeenCalledWith(CHANNEL_ID)

    // Leased: a second poll inside the lease sees nothing.
    const again = await request(app).get(`${BASE}/outbox?wait=0`).set('Authorization', `Bearer ${TOKEN}`)
    expect(again.body.items).toEqual([])

    const ack = await request(app)
      .post(`${BASE}/outbox/ack`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ results: [{ id, ok: true, providerMessageId: 'wx-42' }] })
    expect(ack.status).toBe(200)
    expect(ack.body).toEqual({ ok: true, settled: 1 })
    expect(store.ack).toHaveBeenCalledWith(CHANNEL_ID, [{ id, ok: true, providerMessageId: 'wx-42' }])
  })

  it('keeps polling until the wait elapses, then returns an empty list', async () => {
    const { app, store } = buildApp()
    const res = await request(app).get(`${BASE}/outbox?wait=50`).set('Authorization', `Bearer ${TOKEN}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ items: [] })
    // Instant sleep (injected) over a 50 ms window: several claims before the deadline.
    expect(vi.mocked(store.claim).mock.calls.length).toBeGreaterThan(1)
  })

  it('rejects a malformed ack with 400', async () => {
    const { app } = buildApp()
    const res = await request(app).post(`${BASE}/outbox/ack`).set('Authorization', `Bearer ${TOKEN}`).send({ results: [{ id: 'nope' }] })
    expect(res.status).toBe(400)
  })
})

// A 1x1 PNG's worth of stand-in bytes, inline like the wechat bridge sends them.
const PNG_B64 = Buffer.from('fake-image-bytes').toString('base64')

function makeArchiveMedia() {
  return {
    storeBuffer: vi.fn(async (input: { filename: string; mime: string; bytes: Buffer }) => ({
      assetId: '11111111-1111-1111-1111-111111111111',
      sha256: 'a'.repeat(64),
      filename: input.filename,
      mime: input.mime,
      sizeBytes: input.bytes.length,
    })),
    uploadTarget: vi.fn(),
  }
}

describe('[COMP:api/custom-channel-bridge] archive-only exits stage media first', () => {
  it('an unaddressed group image is staged and archived with a stored ref, not filename hints', async () => {
    const archiveMedia = makeArchiveMedia()
    vi.mocked(resolveChatArchiveInstanceId).mockResolvedValue('inst-1')
    const { app } = buildApp({ archiveMedia })
    const res = await request(app)
      .post(`${BASE}/inbound`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(inbound({
        peerId: 'group-1', senderId: 'u-9', isGroupChat: true, isMentioned: false, text: '',
        media: [{ kind: 'image', mime: 'image/jpeg', name: 'msg_6.jpg', dataBase64: PNG_B64 }],
      }))
    expect(res.status).toBe(202)
    await flush()
    expect(archiveMedia.storeBuffer).toHaveBeenCalledTimes(1)
    expect(archiveMedia.storeBuffer.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws-1',
      instanceId: 'inst-1',
      ownerUserId: 'owner',
      source: 'custom',
      providerMessageId: 'm-1',
      kind: 'image',
      filename: 'msg_6.jpg',
    })
    expect(archiveUnroutedInbound).toHaveBeenCalledTimes(1)
    const appended = vi.mocked(archiveUnroutedInbound).mock.calls[0][0]
    expect(appended.message.archiveMediaRef).toMatchObject({
      assetId: '11111111-1111-1111-1111-111111111111',
      sha256: 'a'.repeat(64),
      filename: 'msg_6.jpg',
    })
    expect(appended.message.archiveMediaAvailability).toBeUndefined()
    expect(processChannelMessage).not.toHaveBeenCalled()
  })

  it('threads the integration connector instance into staging AND the unrouted append', async () => {
    const archiveMedia = makeArchiveMedia()
    const integrationStore = makeIntegrationStore()
    integrationStore.getByChannelForWebhook.mockResolvedValue({
      id: 'int-1', channelId: CHANNEL_ID, config: {},
      credentials: { bridge_token_hash: hashBridgeToken(TOKEN), kind: 'wechat-desktop' },
      connectorInstanceId: 'inst-from-integration',
    })
    const { app } = buildApp({ archiveMedia, integrationStore })
    await request(app)
      .post(`${BASE}/inbound`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(inbound({
        peerId: 'group-1', senderId: 'u-9', isGroupChat: true, isMentioned: false, text: '',
        media: [{ kind: 'image', mime: 'image/jpeg', name: 'p.jpg', dataBase64: PNG_B64 }],
      }))
    await flush()
    // The store links assets by exact (instance, provider message id); a
    // split here orphans the bytes and fails the append.
    expect(archiveMedia.storeBuffer.mock.calls[0][0]).toMatchObject({ instanceId: 'inst-from-integration' })
    expect(vi.mocked(archiveUnroutedInbound).mock.calls[0][0]).toMatchObject({ connectorInstanceId: 'inst-from-integration' })
    expect(resolveChatArchiveInstanceId).not.toHaveBeenCalled()
  })

  it('a staging failure archives availability=failed, never drops the message', async () => {
    const archiveMedia = makeArchiveMedia()
    archiveMedia.storeBuffer.mockRejectedValue(new Error('store is down'))
    vi.mocked(resolveChatArchiveInstanceId).mockResolvedValue('inst-1')
    const { app } = buildApp({ archiveMedia })
    await request(app)
      .post(`${BASE}/inbound`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(inbound({
        peerId: 'group-1', senderId: 'u-9', isGroupChat: true, isMentioned: false, text: '',
        media: [{ kind: 'image', mime: 'image/jpeg', name: 'p.jpg', dataBase64: PNG_B64 }],
      }))
    await flush()
    expect(archiveUnroutedInbound).toHaveBeenCalledTimes(1)
    expect(vi.mocked(archiveUnroutedInbound).mock.calls[0][0].message.archiveMediaAvailability).toBe('failed')
  })

  it("the owner's own media message (isSelf) is staged and archived as outbound with a stored ref", async () => {
    const archiveMedia = makeArchiveMedia()
    vi.mocked(resolveChatArchiveInstanceId).mockResolvedValue('inst-1')
    const { app } = buildApp({ archiveMedia })
    const res = await request(app)
      .post(`${BASE}/inbound`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(inbound({
        senderId: 'me', senderName: 'Ken', isSelf: true, text: '',
        media: [{ kind: 'image', mime: 'image/jpeg', name: 'sent.jpg', dataBase64: PNG_B64 }],
      }))
    expect(res.status).toBe(202)
    await flush()
    expect(archiveMedia.storeBuffer).toHaveBeenCalledTimes(1)
    expect(appendOutboundChatArchive).toHaveBeenCalledTimes(1)
    expect(vi.mocked(appendOutboundChatArchive).mock.calls[0][0]).toMatchObject({
      source: 'custom',
      archiveMedia: {
        kind: 'image',
        ref: { assetId: '11111111-1111-1111-1111-111111111111', filename: 'sent.jpg' },
      },
    })
  })
})

describe('[COMP:api/custom-channel-bridge] outbound documents', () => {
  async function runTurnAndGetParams(app: ReturnType<typeof buildApp>['app']) {
    const res = await request(app).post(`${BASE}/inbound`).set('Authorization', `Bearer ${TOKEN}`).send(inbound())
    expect(res.status).toBe(200)
    await flush()
    expect(processChannelMessage).toHaveBeenCalledTimes(1)
    return vi.mocked(processChannelMessage).mock.calls[0][0] as unknown as {
      channelDocumentsSupported?: boolean
      hooks: { sendResponse: (text: string, documents?: Array<{ filename: string; mime: string; data: Uint8Array; caption?: string }>) => Promise<unknown> }
    }
  }

  it('threads channelDocumentsSupported=true only when the bridge declared documents in its state', async () => {
    const made = makeStore()
    await made.store.putState(CHANNEL_ID, { status: 'connected', capabilities: { documents: true } })
    const { app } = buildApp({ store: made.store })
    const params = await runTurnAndGetParams(app)
    expect(params.channelDocumentsSupported).toBe(true)
  })

  it('threads channelDocumentsSupported=false for a bridge that never declared it', async () => {
    const { app } = buildApp()
    const params = await runTurnAndGetParams(app)
    expect(params.channelDocumentsSupported).toBe(false)
  })

  it('sendResponse forwards documents into the outbox item as base64', async () => {
    const made = makeStore()
    await made.store.putState(CHANNEL_ID, { status: 'connected', capabilities: { documents: true } })
    const { app } = buildApp({ store: made.store })
    const params = await runTurnAndGetParams(app)
    await params.hooks.sendResponse('here is the file', [
      { filename: 'sushi.jpg', mime: 'image/jpeg', data: new Uint8Array([1, 2, 3]), caption: 'from Jack' },
    ])
    const messages = made.items.filter((i) => i.type === 'message')
    expect(messages).toHaveLength(1)
    const payload = messages[0].payload as { text: string; documents?: Array<{ filename: string; mime: string; dataBase64: string; caption?: string }> }
    expect(payload.text).toBe('here is the file')
    expect(payload.documents).toHaveLength(1)
    expect(payload.documents![0]).toMatchObject({ filename: 'sushi.jpg', mime: 'image/jpeg', caption: 'from Jack' })
    expect(Buffer.from(payload.documents![0].dataBase64, 'base64')).toEqual(Buffer.from([1, 2, 3]))
  })
})

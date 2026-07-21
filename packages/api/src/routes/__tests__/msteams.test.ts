import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

// ── Mock @use-brian/channels (adapter + verifier) ──────────────
vi.mock('@use-brian/channels', () => {
  const parseIncoming = vi.fn()
  const sendMessage = vi.fn().mockResolvedValue('act-out')
  const sendStatus = vi.fn().mockResolvedValue('status-1')
  const editMessage = vi.fn().mockResolvedValue(undefined)
  const verifyAuthHeader = vi.fn()
  return {
    createMsTeamsAdapter: vi.fn(() => ({ parseIncoming, sendMessage, sendStatus, editMessage, maxMessageLength: 17000 })),
    createMsTeamsVerifier: vi.fn(() => ({ verifyAuthHeader, verifyToken: vi.fn() })),
    __mocks: { parseIncoming, sendMessage, sendStatus, editMessage, verifyAuthHeader },
  }
})

// ── Mock the heavy pipeline + DB modules the route imports ─────
vi.mock('../channel-pipeline.js', () => ({ processChannelMessage: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../db/users.js', () => ({ findAssistantById: vi.fn() }))
vi.mock('../../db/channels-store.js', () => ({
  getChannelForWebhook: vi.fn(),
  resolveRoutingForSurface: vi.fn(),
  resolveAssistantForSurface: vi.fn(),
}))
vi.mock('../../db/channel-user-store.js', () => ({ resolveChannelUser: vi.fn() }))
vi.mock('../../db/chat-lock.js', () => ({ withChatLock: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) }))
vi.mock('../../billing-party.js', () => ({ billingPartyForAssistant: vi.fn(async () => 'owner') }))
vi.mock('@use-brian/core', () => ({ parseFileContent: vi.fn(async () => ({ text: '' })) }))
vi.mock('@use-brian/shared', () => ({
  getToolDisplayName: vi.fn(() => 'Tool'),
  humanizeToolName: vi.fn(() => 'Tool'),
  describeToolInput: vi.fn(() => null),
  formatConfirmationInput: vi.fn(() => []),
}))

import { msteamsRoutes, msteamsUserAllowed } from '../msteams.js'
import * as channels from '@use-brian/channels'
import { processChannelMessage } from '../channel-pipeline.js'
import { getChannelForWebhook, resolveRoutingForSurface, resolveAssistantForSurface } from '../../db/channels-store.js'
import { findAssistantById } from '../../db/users.js'
import { resolveChannelUser } from '../../db/channel-user-store.js'

const mocks = (channels as unknown as { __mocks: Record<string, ReturnType<typeof vi.fn>> }).__mocks

/** Let the fire-and-forget post-ack processing resolve before asserting. */
async function flush() {
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
}

const CREDS = { app_id: 'app', app_password: 'sec', tenant_id: 'tid' }

function makeIntegrationStore(config: Record<string, unknown> = {}) {
  return {
    getByChannelForWebhook: vi.fn().mockResolvedValue({
      id: 'int-1', channelId: 'ch-1', config, credentials: CREDS, botUserId: '28:app',
    }),
    touchLastEventAt: vi.fn().mockResolvedValue(undefined),
    mergeConfigSystem: vi.fn().mockResolvedValue(undefined),
  }
}

function baseOptions(integrationStore: unknown) {
  return {
    provider: {} as never,
    systemPrompt: '',
    tools: new Map(),
    memoryStore: {} as never,
    capabilityStore: {} as never,
    integrationStore: integrationStore as never,
    channelUserStore: {} as never,
  }
}

const ACTIVITY = {
  type: 'message',
  id: 'a1',
  serviceUrl: 'https://smba.trafficmanager.net/emea/',
  from: { id: '29:user', name: 'User' },
  recipient: { id: '28:app' },
  conversation: { id: 'conv-1', conversationType: 'personal' },
  text: 'hello',
}

describe('[COMP:api/msteams-route] webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.verifyAuthHeader.mockResolvedValue({ valid: true })
    mocks.parseIncoming.mockReturnValue({
      userId: '29:user', channelId: 'conv-1', text: 'hello',
      isGroupChat: false, isMentioned: false, messageId: 'a1',
    })
    vi.mocked(getChannelForWebhook).mockResolvedValue({ status: 'active', enabledCapabilities: ['chat'] } as never)
    vi.mocked(resolveRoutingForSurface).mockResolvedValue({ assistantId: 'a-1', modelAlias: 'pro' } as never)
    vi.mocked(findAssistantById).mockResolvedValue({ id: 'a-1', ownerUserId: 'owner', workspaceId: 'ws-1' } as never)
    vi.mocked(resolveChannelUser).mockResolvedValue({ user: { id: 'cu-1' }, isIdentified: false } as never)
  })

  it('drives processChannelMessage on a verified message Activity', async () => {
    const app = createTestApp('/webhook/msteams', msteamsRoutes(baseOptions(makeIntegrationStore())))
    const res = await request(app)
      .post('/webhook/msteams/ch-1')
      .set('Authorization', 'Bearer good.jwt.token')
      .send(ACTIVITY)

    expect(res.status).toBe(200)
    await flush()
    expect(processChannelMessage).toHaveBeenCalledTimes(1)
    const arg = vi.mocked(processChannelMessage).mock.calls[0][0]
    expect(arg.channelType).toBe('msteams')
    expect(arg.channelId).toBe('conv-1')
  })

  it('rejects an invalid JWT with 401 and never processes', async () => {
    mocks.verifyAuthHeader.mockResolvedValue({ valid: false, reason: 'bad audience' })
    const app = createTestApp('/webhook/msteams', msteamsRoutes(baseOptions(makeIntegrationStore())))
    const res = await request(app)
      .post('/webhook/msteams/ch-1')
      .set('Authorization', 'Bearer bad.jwt')
      .send(ACTIVITY)

    expect(res.status).toBe(401)
    await flush()
    expect(processChannelMessage).not.toHaveBeenCalled()
  })

  it('returns 404 when the channel has no integration', async () => {
    const store = makeIntegrationStore()
    store.getByChannelForWebhook.mockResolvedValue(null)
    const app = createTestApp('/webhook/msteams', msteamsRoutes(baseOptions(store)))
    const res = await request(app)
      .post('/webhook/msteams/ch-1')
      .set('Authorization', 'Bearer good')
      .send(ACTIVITY)

    expect(res.status).toBe(404)
    await flush()
    expect(processChannelMessage).not.toHaveBeenCalled()
  })

  it('silently ignores a blocklisted sender (200 ack, no processing)', async () => {
    const store = makeIntegrationStore({ userAccessMode: 'blocklist', blockedUserIds: ['29:user'] })
    const app = createTestApp('/webhook/msteams', msteamsRoutes(baseOptions(store)))
    const res = await request(app)
      .post('/webhook/msteams/ch-1')
      .set('Authorization', 'Bearer good')
      .send(ACTIVITY)

    expect(res.status).toBe(200)
    await flush()
    expect(processChannelMessage).not.toHaveBeenCalled()
  })

  it('does not process when the adapter drops the message (requireMention / non-message)', async () => {
    mocks.parseIncoming.mockReturnValue(null)
    const app = createTestApp('/webhook/msteams', msteamsRoutes(baseOptions(makeIntegrationStore())))
    const res = await request(app)
      .post('/webhook/msteams/ch-1')
      .set('Authorization', 'Bearer good')
      .send({ ...ACTIVITY, conversation: { id: 'conv-1', conversationType: 'channel' }, text: 'no mention' })

    expect(res.status).toBe(200)
    await flush()
    expect(processChannelMessage).not.toHaveBeenCalled()
  })

  it('dispatches passive ingest for a non-addressed channel message (independent of the chat gate)', async () => {
    // A group message with no @mention: the chat path drops it (parseIncoming
    // returns null), but passive ingest must still fire on the raw Activity.
    mocks.parseIncoming.mockReturnValue(null)
    vi.mocked(getChannelForWebhook).mockResolvedValue({
      status: 'active', enabledCapabilities: ['chat', 'ingest'], workspaceId: 'ws-1',
    } as never)
    vi.mocked(resolveAssistantForSurface).mockResolvedValue('a-1' as never)
    const ingest = vi.fn().mockResolvedValue({ episodeId: 'ep-1' })
    const store = makeIntegrationStore()
    store.getByChannelForWebhook.mockResolvedValue({
      id: 'int-1', channelId: 'ch-1', config: {}, credentials: CREDS, botUserId: '28:app',
      connectorInstanceId: 'ci-1',
    })
    const app = createTestApp(
      '/webhook/msteams',
      msteamsRoutes({ ...baseOptions(store), msteamsWebhookIngestor: { ingest } } as never),
    )
    await request(app)
      .post('/webhook/msteams/ch-1')
      .set('Authorization', 'Bearer good')
      .send({
        type: 'message', id: 'a1', serviceUrl: 'https://smba.test/',
        from: { id: '29:user', name: 'User' }, recipient: { id: '28:app' },
        conversation: { id: 'conv-1', conversationType: 'channel', tenantId: 'tid-1' },
        text: 'team update: shipped the release',
      })
    await flush()
    expect(processChannelMessage).not.toHaveBeenCalled() // chat gate dropped it
    expect(ingest).toHaveBeenCalledTimes(1)
    expect(ingest.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws-1', assistantId: 'a-1', connectorInstanceId: 'ci-1',
      conversationId: 'conv-1', senderId: '29:user', text: 'team update: shipped the release',
    })
  })

  it('persists the serviceUrl for proactive delivery on first inbound', async () => {
    const store = makeIntegrationStore()
    const app = createTestApp('/webhook/msteams', msteamsRoutes(baseOptions(store)))
    await request(app).post('/webhook/msteams/ch-1').set('Authorization', 'Bearer good').send(ACTIVITY)
    await flush()
    expect(store.touchLastEventAt).toHaveBeenCalledWith('int-1')
    expect(store.mergeConfigSystem).toHaveBeenCalledTimes(1)
  })
})

describe('[COMP:api/msteams-route] msteamsUserAllowed', () => {
  it('allows everyone in allow_all', () => {
    expect(msteamsUserAllowed({}, '29:x')).toBe(true)
    expect(msteamsUserAllowed({ userAccessMode: 'allow_all' }, '29:x')).toBe(true)
  })
  it('allowlist admits only listed ids (empty list = open)', () => {
    expect(msteamsUserAllowed({ userAccessMode: 'allowlist', allowedUserIds: ['29:a'] }, '29:a')).toBe(true)
    expect(msteamsUserAllowed({ userAccessMode: 'allowlist', allowedUserIds: ['29:a'] }, '29:b')).toBe(false)
    expect(msteamsUserAllowed({ userAccessMode: 'allowlist', allowedUserIds: [] }, '29:b')).toBe(true)
  })
  it('blocklist rejects listed ids', () => {
    expect(msteamsUserAllowed({ userAccessMode: 'blocklist', blockedUserIds: ['29:a'] }, '29:a')).toBe(false)
    expect(msteamsUserAllowed({ userAccessMode: 'blocklist', blockedUserIds: ['29:a'] }, '29:b')).toBe(true)
  })
})

/**
 * [COMP:api/wechat-inbound] — connector-secret guard + connector seam on
 * /internal/wechat.
 *
 * The router fronts GET /channels, which returns every active WeChat bot
 * token + base URL (the connector's restoreAll source) — so the guard must be
 * constant-time and fail closed: an empty configured secret matches nothing,
 * rather than comparing `undefined !== undefined` and waving an
 * unauthenticated caller through to the token list. Also covers the cursor
 * persistence endpoint (get_updates_buf merge into credentials).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { isBoundWechatOwner, wechatRoutes } from '../wechat.js'

vi.mock('../../message-events.js', () => ({ dispatchIncomingMessageEvent: vi.fn(async () => {}) }))
vi.mock('../../db/channels-store.js', () => ({ getChannelForWebhook: vi.fn(), resolveRoutingForSurface: vi.fn(async () => null) }))
vi.mock('../../chat-archive/live-writer.js', () => ({ archiveUnroutedInbound: vi.fn(async () => {}) }))
vi.mock('../../db/client.js', () => ({ query: vi.fn(async () => ({ rows: [] })), getPool: vi.fn() }))
import { dispatchIncomingMessageEvent } from '../../message-events.js'
import { getChannelForWebhook } from '../../db/channels-store.js'

describe('[COMP:api/wechat-inbound] QR-bound owner identity', () => {
  const credentials = {
    bot_token: 'token',
    base_url: 'https://ilink.example',
    ilink_bot_id: 'bot@im.bot',
    bound_user_id: 'owner@im.wechat',
  }

  it('recognizes only the WeChat account that performed the QR binding', () => {
    expect(isBoundWechatOwner('owner@im.wechat', credentials)).toBe(true)
    expect(isBoundWechatOwner('another-contact@im.wechat', credentials)).toBe(false)
  })

  it('fails closed for legacy credentials without a bound user', () => {
    expect(isBoundWechatOwner('owner@im.wechat', { ...credentials, bound_user_id: undefined })).toBe(false)
  })
})

function buildApp(connectorSecret: string) {
  const integrationStore = {
    listActiveWithCredentialsSystem: vi.fn(async () => [
      {
        channelId: 'chan-1',
        botUserId: 'bot123@im.bot',
        credentials: {
          bot_token: 'wechat-bot-token-1',
          base_url: 'https://shdx.ilink.example',
          ilink_bot_id: 'bot123@im.bot',
          get_updates_buf: 'cursor-abc',
        },
      },
    ]),
    getByChannelForWebhook: vi.fn(async () => ({ id: 'int-1', credentials: { ilink_bot_id: 'bot' }, config: {} })),
    mergeCredentialsSystem: vi.fn(async () => {}),
  }
  const app = express()
  app.use(express.json())
  app.use(
    '/internal/wechat',
    wechatRoutes({
      connectorSecret,
      integrationStore,
      provider: {},
      systemPrompt: '',
      tools: new Map(),
      memoryStore: {},
      capabilityStore: {},
    } as never),
  )
  return { app, integrationStore }
}

describe('[COMP:api/wechat-inbound] connector-secret guard', () => {
  it('401s /channels without the secret header — no token rows leave', async () => {
    const { app, integrationStore } = buildApp('s3cret')
    const res = await request(app).get('/internal/wechat/channels')
    expect(res.status).toBe(401)
    expect(integrationStore.listActiveWithCredentialsSystem).not.toHaveBeenCalled()
  })

  it('401s a wrong secret', async () => {
    const { app } = buildApp('s3cret')
    const res = await request(app)
      .get('/internal/wechat/channels')
      .set('x-connector-secret', 'wrong')
    expect(res.status).toBe(401)
  })

  it('fails closed when the configured secret is empty — even an empty header loses', async () => {
    const { app, integrationStore } = buildApp('')
    const res = await request(app)
      .get('/internal/wechat/channels')
      .set('x-connector-secret', '')
    expect(res.status).toBe(401)
    expect(integrationStore.listActiveWithCredentialsSystem).not.toHaveBeenCalled()
  })

  it('serves the credential list to the correct secret', async () => {
    const { app } = buildApp('s3cret')
    const res = await request(app)
      .get('/internal/wechat/channels')
      .set('x-connector-secret', 's3cret')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([
      {
        channelId: 'chan-1',
        botToken: 'wechat-bot-token-1',
        baseUrl: 'https://shdx.ilink.example',
        getUpdatesBuf: 'cursor-abc',
      },
    ])
  })
})

describe('[COMP:api/wechat-inbound] cursor persistence', () => {
  it('merges the new get_updates_buf into the channel credentials', async () => {
    const { app, integrationStore } = buildApp('s3cret')
    const res = await request(app)
      .post('/internal/wechat/cursor')
      .set('x-connector-secret', 's3cret')
      .send({ channelId: 'chan-1', getUpdatesBuf: 'cursor-next' })
    expect(res.status).toBe(200)
    expect(integrationStore.mergeCredentialsSystem).toHaveBeenCalledTimes(1)
    const calls = integrationStore.mergeCredentialsSystem.mock.calls as unknown as Array<
      [string, string, (c: Record<string, unknown>) => Record<string, unknown>]
    >
    const [channelId, channelType, mutate] = calls[0]
    expect(channelId).toBe('chan-1')
    expect(channelType).toBe('wechat')
    expect(
      mutate({
        bot_token: 't',
        base_url: 'u',
        ilink_bot_id: 'b',
        get_updates_buf: 'old',
      }),
    ).toEqual({ bot_token: 't', base_url: 'u', ilink_bot_id: 'b', get_updates_buf: 'cursor-next' })
  })

  it('400s a payload without a cursor string', async () => {
    const { app } = buildApp('s3cret')
    const res = await request(app)
      .post('/internal/wechat/cursor')
      .set('x-connector-secret', 's3cret')
      .send({ channelId: 'chan-1' })
    expect(res.status).toBe(400)
  })
})


describe('wechat workflow message ingress', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getChannelForWebhook).mockResolvedValue({ workspaceId: 'ws-1', channelType: 'wechat', status: 'active', enabledCapabilities: [] } as never)
  })
  const message = { userId: 'peer', channelId: 'peer', messageId: 'm1', text: 'hello', timestamp: 1700000000000 }
  it.each([false, true])('emits without routing, chat enabled=%s', async (chat) => {
    vi.mocked(getChannelForWebhook).mockResolvedValue({ workspaceId: 'ws-1', channelType: 'wechat', status: 'active', enabledCapabilities: chat ? ['chat'] : [] } as never)
    const { app } = buildApp('secret')
    await request(app).post('/internal/wechat/inbound').set('X-Connector-Secret', 'secret').send({ channelId: 'chan-1', message })
    await vi.waitFor(() => expect(dispatchIncomingMessageEvent).toHaveBeenCalledOnce())
    expect(dispatchIncomingMessageEvent).toHaveBeenCalledWith({ workspaceId: 'ws-1', integrationId: 'int-1', providerAccountId: 'bot', incoming: { ...message, channelType: 'wechat', timestamp: 1700000000 } })
  })
  it('emits media-only messages without downloading the attachment', async () => {
    const { app } = buildApp('secret')
    await request(app).post('/internal/wechat/inbound').set('X-Connector-Secret', 'secret')
      .send({ channelId: 'chan-1', message: { ...message, text: '', mediaType: 'photo' } })
    await vi.waitFor(() => expect(dispatchIncomingMessageEvent).toHaveBeenCalledOnce())
    expect(dispatchIncomingMessageEvent).toHaveBeenCalledWith(expect.objectContaining({
      incoming: expect.objectContaining({ channelType: 'wechat', text: '', mediaType: 'photo' }),
    }))
  })
  it.each(['auth', 'blocked', 'self', 'streaming', 'inactive', 'missing integration', 'empty', 'cursor'])('excludes %s', async (mode) => {
    const { app, integrationStore } = buildApp('secret')
    if (mode === 'inactive') vi.mocked(getChannelForWebhook).mockResolvedValue(null)
    if (mode === 'missing integration') integrationStore.getByChannelForWebhook.mockResolvedValue(null as never)
    if (mode === 'blocked') integrationStore.getByChannelForWebhook.mockResolvedValue({ id: 'int-1', credentials: { ilink_bot_id: 'bot' }, config: { userAccessMode: 'blocklist', blockedUserIds: ['peer'] } })
    await request(app).post(`/internal/wechat/${mode === 'cursor' ? 'cursor' : 'inbound'}`).set('X-Connector-Secret', mode === 'auth' ? 'wrong' : 'secret').send(mode === 'cursor' ? { channelId: 'chan-1', getUpdatesBuf: 'next' } : { channelId: 'chan-1', message: { ...message, ...(mode === 'empty' ? { text: '' } : {}), ...(mode === 'self' ? { raw: { message_type: 2 } } : {}), ...(mode === 'streaming' ? { raw: { message_type: 1, message_state: 1 } } : {}) } })
    await new Promise((resolve) => setImmediate(resolve))
    expect(dispatchIncomingMessageEvent).not.toHaveBeenCalled()
  })
})

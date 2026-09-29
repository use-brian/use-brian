import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ pipeline: vi.fn(), resolveUser: vi.fn() }))
vi.mock('../channel-pipeline.js', () => ({ processChannelMessage: mocks.pipeline }))
vi.mock('../../db/channels-store.js', () => ({
  getChannelForWebhook: async () => ({ status: 'active', enabledCapabilities: ['chat'], workspaceId: 'workspace' }),
  resolveRoutingForSurface: async () => ({ assistantId: 'assistant', modelAlias: 'pro' }),
}))
vi.mock('../../db/users.js', () => ({ findAssistantById: async () => ({ id: 'assistant', ownerUserId: 'owner', workspaceId: 'workspace' }) }))
vi.mock('../../db/channel-user-store.js', () => ({ resolveChannelUser: mocks.resolveUser }))
vi.mock('../../billing-party.js', () => ({ billingPartyForAssistant: async () => 'owner' }))
vi.mock('../../db/chat-lock.js', () => ({ withChatLock: (_key: string, fn: () => unknown) => fn() }))
vi.mock('../../db/channel-event-dedup.js', () => ({ claimChannelEvent: async () => true }))
vi.mock('../../feishu/client.js', () => ({ createFeishuApi: () => ({}) }))
vi.mock('../../db/client.js', () => ({ query: async () => ({ rows: [{ id: 'abcdef12' }] }) }))
import { wechatRoutes } from '../wechat.js'
import { feishuRoutes } from '../feishu.js'
import { channelQuestions } from '../channel-questions.js'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.pipeline.mockResolvedValue(undefined)
  mocks.resolveUser.mockResolvedValue({ user: { id: 'actor' }, isIdentified: true })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  channelQuestions.invalidate('11111111-1111-4111-8111-111111111111', { channelId: 'chat', userId: 'sender' } as never)
})
const integrationStore = (credentials: object) => ({
  getByChannelForWebhook: async () => ({ id: 'integration', channelId: 'channel', credentials, config: {}, connectorInstanceId: 'connector' }),
  touchLastEventAt: async () => {}, mergeConfigSystem: async () => {},
})
it.each(['bound', 'shadow', 'resolver failure', 'no resolver'])('WeChat identity: %s', async mode => {
  if (mode === 'shadow') mocks.resolveUser.mockResolvedValue({ user: { id: 'shadow' }, isIdentified: false })
  if (mode === 'resolver failure') {
    mocks.resolveUser.mockRejectedValue(new Error('resolution failed'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
  }
  const app = express(); app.use(express.json())
  app.use('/wechat', wechatRoutes({ connectorSecret: 'secret', tools: new Map(), channelUserStore: mode === 'no resolver' ? undefined : {},
    integrationStore: integrationStore({ bot_token: 'token', base_url: 'https://example.com', bound_user_id: 'owner-wechat' }),
  } as never))
  await request(app).post('/wechat/inbound').set('X-Connector-Secret', 'secret').send({ channelId: 'channel', message: {
    userId: mode === 'bound' ? 'owner-wechat' : 'other-wechat', channelId: 'peer', messageId: 'message', text: 'hello', isGroupChat: false, timestamp: 1, raw: {},
  } }).expect(200)
  await vi.waitFor(() => expect(mocks.pipeline).toHaveBeenCalledOnce())
  expect(mocks.resolveUser).toHaveBeenCalledTimes(mode === 'bound' || mode === 'no resolver' ? 0 : 1)
  expect(mocks.pipeline.mock.calls[0][0]).toMatchObject({
    userId: mode === 'shadow' ? 'shadow' : 'owner', isIdentified: mode === 'bound',
  })
})
it.each([true, false])('successive Feishu choices preserve the session (initial binding session: %s)', async initialSession => {
  const app = express(); app.use(express.json())
  app.use('/feishu', feishuRoutes({ connectorSecret: 'secret', tools: new Map(), channelUserStore: {},
    integrationStore: integrationStore({ app_id: 'app', app_secret: 'secret', brand: 'feishu' }),
  } as never))
  const channelId = '11111111-1111-4111-8111-111111111111'
  let action = ''
  mocks.pipeline.mockImplementation(async p => {
    // Use precisely the binding constructed by the production pipeline.
    action = channelQuestions.create({ integrationId: p.interactionScope.integrationId,
      assistantId: p.assistant.id, userId: p.userId, incoming: p.incomingMessage,
      sessionId: initialSession || mocks.pipeline.mock.calls.length > 1 ? p.interactionScope.sessionId : undefined }, ['Next'])[0].data
  })
  await request(app).post('/feishu/inbound').set('X-Connector-Secret', 'secret').send({ channelId, message: {
    messageId: 'om_original', chatId: 'chat', chatType: 'p2p', senderId: 'sender', senderType: 'user', senderIsBot: false,
    content: 'hello', rawContentType: 'text', resources: [], mentions: [], mentionAll: false, mentionedBot: false, createTime: Date.now(),
  } }).expect(202)
  await vi.waitFor(() => expect(mocks.pipeline).toHaveBeenCalledTimes(1))
  const click = (messageId: string) => request(app).post('/feishu/interaction').set('X-Connector-Secret', 'secret').send({
    channelId, interaction: { messageId, chatId: 'chat', operator: { openId: 'sender' }, action: { value: { data: action } } },
  })
  await click('om_card1')
  await vi.waitFor(() => expect(mocks.pipeline).toHaveBeenCalledTimes(2))
  await click('om_card2')
  await vi.waitFor(() => expect(mocks.pipeline).toHaveBeenCalledTimes(3))
  expect(mocks.pipeline.mock.calls.map(([p]) => p.sessionChannelId)).toEqual([
    'chat:thread:om_original', 'chat:thread:om_original', 'chat:thread:om_original',
  ])
  expect(mocks.pipeline.mock.calls.map(([p]) => p.interactionScope.sessionId)).toEqual([
    'chat:thread:om_original', 'chat:thread:om_original', 'chat:thread:om_original',
  ])
})

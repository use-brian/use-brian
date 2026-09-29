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
vi.mock('../../db/client.js', () => ({ query: async () => ({ rows: [{ id: 'abcdef12' }] }) }))
import { wechatRoutes } from '../wechat.js'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.pipeline.mockResolvedValue(undefined)
  mocks.resolveUser.mockResolvedValue({ user: { id: 'actor' }, isIdentified: true })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
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

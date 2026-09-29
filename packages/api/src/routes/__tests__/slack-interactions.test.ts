import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { channelConfirmations } from '../channel-interactions.js'

const mocks = vi.hoisted(() => ({
  incoming: { userId: 'actor', channelId: 'C1', messageId: '2', replyToMessageId: '1', text: 'yes', isGroupChat: false, timestamp: 1, raw: {} },
  lock: vi.fn(async (_key: string, _fn: () => Promise<unknown>) => {}),
  send: vi.fn(async () => '3'),
}))
vi.mock('@use-brian/channels', async (original) => ({
  ...await original<typeof import('@use-brian/channels')>(),
  verifySlackSignature: () => true,
  createSlackAdapter: (opts: { onMessage: (incoming: unknown) => void }) => ({
    handleEvent: () => opts.onMessage(mocks.incoming), sendMessage: mocks.send,
  }),
}))
vi.mock('../../db/chat-lock.js', () => ({ withChatLock: mocks.lock }))
vi.mock('../../db/channels-store.js', () => ({
  getChannelForWebhook: async () => ({ status: 'active', enabledCapabilities: ['chat'] }),
  resolveRoutingForSurface: async () => ({ assistantId: 'assistant', modelAlias: 'standard' }),
}))
vi.mock('../../db/users.js', () => ({ findUserById: async () => null, findAssistantById: async () => ({ id: 'assistant', ownerUserId: 'owner', workspaceId: null }) }))
vi.mock('../../billing-party.js', () => ({ billingPartyForAssistant: async () => 'owner' }))
import { slackRoutes } from '../slack.js'

afterEach(() => { vi.clearAllMocks() })

describe('Slack shared confirmation admission', () => {
  it('uses the exact channel integration, sender and thread scope before the lock', async () => {
    const app = express()
    app.use(express.json())
    app.use('/slack', slackRoutes({ integrationStore: {
      getByChannelForWebhook: async () => ({ id: 'integration-uuid', channelId: 'channel-row',
        credentials: { bot_token: 'token', signing_secret: 'secret' }, config: { replyInThread: true } }),
      touchLastEventAt: async () => {},
    }, tools: new Map() } as never))
    const resolve = vi.fn()
    const dispose = channelConfirmations.register({
      channelType: 'slack', integrationId: 'channel-row', conversationId: 'C1', senderId: 'actor', sessionId: 'C1:thread:1',
    }, { toolCallId: 'call', toolName: 'tool', serverName: 'server', input: {}, classification: null, description: '' }, { resolve } as never)
    const post = async () => {
      await request(app).post('/slack/channel-row').set('x-slack-signature', 'signature')
        .set('x-slack-request-timestamp', '1').send({ type: 'event_callback', event: { type: 'message', text: 'yes' } }).expect(200)
      await new Promise(r => setImmediate(r))
    }
    try {
      mocks.incoming.userId = 'other'
      await post()
      expect(resolve).not.toHaveBeenCalled()
      expect(mocks.lock).toHaveBeenCalledOnce()
      mocks.incoming.userId = 'actor'
      mocks.incoming.replyToMessageId = 'other-thread'
      await post()
      expect(resolve).not.toHaveBeenCalled()
      expect(mocks.lock).toHaveBeenCalledTimes(2)
      mocks.lock.mockClear()
      mocks.incoming.replyToMessageId = '1'
      await post()
      await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce())
      expect(mocks.lock).not.toHaveBeenCalled()
    } finally { dispose() }
  })
})

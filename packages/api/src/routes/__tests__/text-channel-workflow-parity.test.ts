import { createHmac } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ pipeline: vi.fn(), resolveUser: vi.fn() }))
vi.mock('../channel-pipeline.js', () => ({ processChannelMessage: mocks.pipeline }))
vi.mock('../../db/channels-store.js', () => ({
  getChannelForWebhook: vi.fn(async () => ({ status: 'active', enabledCapabilities: ['chat'], workspaceId: 'workspace' })),
  resolveRoutingForSurface: vi.fn(async () => ({ assistantId: 'assistant', modelAlias: 'pro' })),
}))
vi.mock('../../db/users.js', () => ({ findAssistantById: vi.fn(async () => ({ id: 'assistant', ownerUserId: 'owner', workspaceId: 'workspace' })) }))
vi.mock('../../billing-party.js', () => ({ billingPartyForAssistant: vi.fn(async () => 'owner') }))
vi.mock('../../db/channel-user-store.js', () => ({ resolveChannelUser: mocks.resolveUser }))
vi.mock('../../db/chat-lock.js', () => ({ withChatLock: (_key: string, fn: () => unknown) => fn() }))

import { wechatRoutes } from '../wechat.js'
import { whatsappCloudRoutes } from '../whatsapp-cloud.js'

const cloudCredentials = {
  provider: 'cloud_api', access_token: 'token', app_secret: 'app-secret', verify_token: 'verify-token',
  phone_number_id: 'phone-1', waba_id: 'waba-1', display_phone_number: '+15551234567', graph_api_version: 'v26.0',
}

function setup(provider: 'wechat' | 'whatsapp', identified: boolean) {
  const app = express()
  app.use(express.json({ verify(req, _res, buf) { (req as express.Request & { rawBody?: string }).rawBody = buf.toString() } }))
  const questionStore = { isQuestionMessage: vi.fn() }
  const options = {
    connectorSecret: 'secret', tools: new Map(), questionStore,
    channelUserStore: identified ? {} : undefined,
    integrationStore: {
      getByChannelForWebhook: vi.fn(async () => ({
        id: 'integration-uuid', channelId: 'platform-channel', config: { userAccessMode: 'allow_all' },
        credentials: provider === 'whatsapp' ? cloudCredentials : { bot_token: 'token', base_url: 'https://example.com' },
      })),
      touchLastEventAt: vi.fn(async () => {}),
    },
  }
  app.use('/channel', provider === 'wechat' ? wechatRoutes(options as never) : whatsappCloudRoutes(options as never))
  const send = async (sender: string) => {
    if (provider === 'wechat') return request(app).post('/channel/inbound').set('X-Connector-Secret', 'secret').send({
      channelId: 'platform-channel', message: { userId: sender, channelId: 'conversation', messageId: `answer:${sender}`,
        replyToMessageId: 'question-message', text: '1', isGroupChat: false, timestamp: 1, raw: {} },
    })
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: 'phone-1' }, messages: [{ id: `answer:${sender}`, from: sender,
        timestamp: '1', type: 'text', text: { body: '1' }, context: { id: 'question-message' } }],
    } }] }] })
    return request(app).post('/channel/platform-channel').set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', `sha256=${createHmac('sha256', cloudCredentials.app_secret).update(body).digest('hex')}`).send(body)
  }
  return { send, questionStore }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.pipeline.mockResolvedValue(undefined)
  mocks.resolveUser.mockImplementation(async (_store, _provider, sender) => ({ user: { id: `resolved:${sender}` }, isIdentified: true }))
})

describe.each(['wechat', 'whatsapp'] as const)('%s workflow input parity', provider => {
  it('preserves reply metadata and separates integration UUID from platform channel identity', async () => {
    const { send, questionStore } = setup(provider, true)
    for (const sender of ['15550000001', '15550000002']) {
      expect((await send(sender)).status).toBe(200)
      await vi.waitFor(() => expect(mocks.pipeline).toHaveBeenCalledWith(expect.objectContaining({
        questionIntegrationId: 'integration-uuid', questionStore, userId: `resolved:${sender}`, isIdentified: true,
        incomingMessage: expect.objectContaining({ userId: sender, text: '1', messageId: `answer:${sender}`, replyToMessageId: 'question-message' }),
        interactionScope: expect.objectContaining({ integrationId: 'platform-channel', senderId: sender }),
      })))
    }
  })

  it('never identifies an owner fallback when sender resolution is unavailable', async () => {
    const { send } = setup(provider, false)
    expect((await send('15550000001')).status).toBe(200)
    await vi.waitFor(() => expect(mocks.pipeline).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner', isIdentified: false })))
  })
})

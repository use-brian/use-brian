import { createHmac } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ pipeline: vi.fn(), resolveUser: vi.fn(), sendMessage: vi.fn(), channelType: 'wechat' }))
vi.mock('../channel-pipeline.js', () => ({ processChannelMessage: mocks.pipeline }))
vi.mock('../../db/channels-store.js', () => ({
  getChannelForWebhook: vi.fn(async () => ({ channelType: mocks.channelType, status: 'active', enabledCapabilities: ['chat'], workspaceId: 'workspace' })),
  resolveRoutingForSurface: vi.fn(async () => ({ assistantId: 'assistant', modelAlias: 'pro' })),
}))
vi.mock('../../db/users.js', () => ({ findAssistantById: vi.fn(async () => ({ id: 'assistant', ownerUserId: 'owner', workspaceId: 'workspace' })) }))
vi.mock('../../billing-party.js', () => ({ billingPartyForAssistant: vi.fn(async () => 'owner') }))
vi.mock('../../db/channel-user-store.js', () => ({ resolveChannelUser: mocks.resolveUser }))
vi.mock('../../db/chat-lock.js', () => ({ withChatLock: (_key: string, fn: () => unknown) => fn() }))
vi.mock('../../db/wechat-context-tokens.js', () => ({
  upsertWechatContextToken: vi.fn(async () => {}),
  getWechatContextToken: vi.fn(async () => 'ctx'),
}))
vi.mock('@use-brian/channels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@use-brian/channels')>()),
  createWechatAdapter: vi.fn(() => ({ sendMessage: mocks.sendMessage })),
}))
vi.mock('../../db/workspace-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/workspace-store.js')>()),
  getWorkspaceRoleSystem: vi.fn(async () => 'member'),
}))

import { wechatRoutes, WECHAT_IDENTITY_NOTICES } from '../wechat.js'
import { whatsappCloudRoutes } from '../whatsapp-cloud.js'

const WECHAT_SENDER = '15550000001'

// WeChat acts only as the QR-bound sender's linked Brian account (no shadow
// users, no owner fallback - see wechat-staff-access.test.ts), so its parity
// fixture is a bound identity; WhatsApp still resolves through channel users.
function wechatIdentityStore(sender: string) {
  return {
    resolveWechatSender: vi.fn(async () => ({ kind: 'bound', receipt: {
      bindingId: 'binding-1', version: 1, accountId: `resolved:${sender}`, workspaceId: 'workspace',
      channelId: 'platform-channel', botId: 'bot@im.bot', senderId: sender, transportGeneration: 1,
    } })),
    isWechatReceiptCurrent: vi.fn(async () => true),
  }
}

const cloudCredentials = {
  provider: 'cloud_api', access_token: 'token', app_secret: 'app-secret', verify_token: 'verify-token',
  phone_number_id: 'phone-1', waba_id: 'waba-1', display_phone_number: '+15551234567', graph_api_version: 'v26.0',
}

function setup(provider: 'wechat' | 'whatsapp', identified: boolean) {
  mocks.channelType = provider
  const app = express()
  app.use(express.json({ verify(req, _res, buf) { (req as express.Request & { rawBody?: string }).rawBody = buf.toString() } }))
  const questionStore = { isQuestionMessage: vi.fn() }
  const options = {
    connectorSecret: 'secret', tools: new Map(), questionStore,
    channelUserStore: identified ? {} : undefined,
    identityStore: provider === 'wechat' && identified ? wechatIdentityStore(WECHAT_SENDER) : undefined,
    integrationStore: {
      getByChannelForWebhook: vi.fn(async () => ({
        id: 'integration-uuid', channelId: 'platform-channel', config: { userAccessMode: 'allow_all' },
        credentials: provider === 'whatsapp' ? cloudCredentials
          : { bot_token: 'token', base_url: 'https://example.com', ilink_bot_id: 'bot@im.bot', bound_user_id: WECHAT_SENDER },
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
  mocks.sendMessage.mockResolvedValue({ messageId: 'notice' })
  mocks.resolveUser.mockImplementation(async (_store, _provider, sender) => ({ user: { id: `resolved:${sender}` }, isIdentified: true }))
})

describe.each(['wechat', 'whatsapp'] as const)('%s workflow input parity', provider => {
  it('preserves reply metadata and separates integration UUID from platform channel identity', async () => {
    const { send, questionStore } = setup(provider, true)
    const senders = provider === 'wechat' ? [WECHAT_SENDER] : ['15550000001', '15550000002']
    for (const sender of senders) {
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
    if (provider === 'wechat') {
      // No identity store: a fixed refusal, never a turn as the owner.
      await vi.waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledWith('conversation', { text: WECHAT_IDENTITY_NOTICES.unverified }))
      expect(mocks.pipeline).not.toHaveBeenCalled()
      return
    }
    await vi.waitFor(() => expect(mocks.pipeline).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner', isIdentified: false })))
  })
})

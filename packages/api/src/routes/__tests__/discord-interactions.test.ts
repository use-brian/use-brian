import { dispatchIncomingMessageEvent } from '../../message-events.js'
vi.mock('../../message-events.js', () => ({ dispatchIncomingMessageEvent: vi.fn(async () => {}) }))
import { channelQuestions } from '../channel-questions.js'
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { channelConfirmations } from '../channel-interactions.js'

const mocks = vi.hoisted(() => ({
  getChannelForWebhook: vi.fn(async () => ({ status: 'active', enabledCapabilities: ['chat'] })),
  resolveRoutingForSurface: vi.fn(async () => ({ assistantId: 'assistant', modelAlias: 'pro' })),
  processChannelMessage: vi.fn(async () => {}),
  resolveChannelUser: vi.fn(),
}))
vi.mock('../../db/channels-store.js', () => mocks)
vi.mock('../channel-pipeline.js', () => ({ processChannelMessage: mocks.processChannelMessage }))
vi.mock('../../db/users.js', () => ({ findAssistantById: vi.fn(async () => ({ id: 'assistant', ownerUserId: 'owner', workspaceId: 'workspace' })) }))
vi.mock('../../billing-party.js', () => ({ billingPartyForAssistant: vi.fn(async () => 'owner') }))
vi.mock('../../db/channel-user-store.js', () => ({ resolveChannelUser: mocks.resolveChannelUser }))
vi.mock('../../db/chat-lock.js', () => ({ withChatLock: (_key: string, fn: () => unknown) => fn() }))
import { discordRoutes } from '../discord.js'

function setup(withUserStore = false) {
  vi.mocked(dispatchIncomingMessageEvent).mockClear()
  mocks.processChannelMessage.mockClear()
  const app = express()
  app.use(express.json())
  app.use('/discord', discordRoutes({
    connectorSecret: 'secret',
    integrationStore: { getByChannelForWebhook: vi.fn(async () => ({ id: 'integration-uuid', credentials: { bot_token: 'token' }, config: {} })) },
    tools: new Map(), channelUserStore: withUserStore ? {} : undefined,
  } as never))
  const resolve = vi.fn()
  const dispose = channelConfirmations.register({
    channelType: 'discord', integrationId: 'channel-row', conversationId: 'room', senderId: 'actor',
  }, { toolCallId: 'call', toolName: 'tool', serverName: 'server', input: {}, classification: null, description: '' }, { resolve } as never)
  const click = (userId?: string, channelId = 'channel-row', secret = 'secret') => request(app)
    .post('/discord/interaction').set('X-Connector-Secret', secret).send({ channelId, interaction: {
      id: 'interaction', token: 'interaction-token', channelId: 'room', userId, customId: 'mcp_confirm:call:allow',
    } })
  return { app, resolve, dispose, click }
}

afterEach(() => vi.unstubAllGlobals())

describe('Discord common confirmations', () => {
  it('completes provider ACK before resuming the parked turn', async () => {
    const { resolve, dispose, click } = setup()
    let release!: (response: Response) => void
    const fetchMock = vi.fn((_url: unknown, _init?: RequestInit) => new Promise<Response>(r => { release = r }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await click().expect(200) // No actor still ACKs but cannot resolve.
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
      expect(resolve).not.toHaveBeenCalled()
      release(new Response(null, { status: 204 }))
      await click('actor').expect(200)
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
      expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ type: 6 })
      expect(resolve).not.toHaveBeenCalled()
      release(new Response(null, { status: 204 }))
      await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce())
    } finally { dispose() }
  })

  it('marks approval-shaped native choices as conversation, not workflow commands', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    const { app, dispose } = setup()
    const [action] = channelQuestions.create({ integrationId: 'channel-row', assistantId: 'assistant', userId: 'owner',
      incoming: { userId: 'actor', channelId: 'room', text: '', isGroupChat: true, timestamp: 1, raw: {} },
    }, ['approve abc123'])
    try {
      await request(app).post('/discord/interaction').set('X-Connector-Secret', 'secret').send({
        channelId: 'channel-row', interaction: { id: 'choice', token: 'token', channelId: 'room', userId: 'actor', customId: action.data },
      }).expect(200)
      await vi.waitFor(() => expect(mocks.processChannelMessage).toHaveBeenCalledWith(expect.objectContaining({
        messageText: 'approve abc123', conversationalAnswer: true,
      })))
      expect(dispatchIncomingMessageEvent).not.toHaveBeenCalled()
    } finally { dispose() }
  })

  it('rejects other actors/integrations and replay without consuming the authorized choice', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    const { resolve, dispose, click } = setup()
    try {
      await click('actor', 'channel-row', 'bad').expect(401)
      await click('other').expect(200)
      await click('actor', 'other-integration').expect(200)
      expect(resolve).not.toHaveBeenCalled()
      await click('actor').expect(200)
      await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce())
      await click('actor').expect(200)
      expect(resolve).toHaveBeenCalledTimes(1)
    } finally { dispose() }
  })
  it.each(['wq:abcdefghijklmnopqrstuvwx:0', 'mcp_confirm:deferred:allow'])(
    'preserves workflow callback %s and resolves the actual sender, not the owner', async data => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
      mocks.resolveChannelUser.mockImplementation(async (_store, _provider, sender) => ({ user: { id: `resolved:${sender}` }, isIdentified: true }))
      const { app, resolve, dispose } = setup(true)
      try {
        for (const sender of ['intruder', 'actor']) {
          await request(app).post('/discord/interaction').set('X-Connector-Secret', 'secret').send({
            channelId: 'channel-row', interaction: { id: `click:${sender}`, token: 'token', channelId: 'room',
              messageId: 'question-message', userId: sender, customId: data },
          }).expect(200)
          await vi.waitFor(() => expect(mocks.processChannelMessage).toHaveBeenCalledWith(expect.objectContaining({
            questionIntegrationId: 'integration-uuid', userId: `resolved:${sender}`, isIdentified: true,
            workflowCallback: { data, messageId: 'question-message' },
            incomingMessage: expect.objectContaining({ userId: sender, messageId: `click:${sender}`, text: '' }),
            interactionScope: { channelType: 'discord', integrationId: 'channel-row', conversationId: 'room', senderId: sender },
          })))
        }
        expect(resolve).not.toHaveBeenCalled()
      } finally { dispose() }
    },
  )

  it('keeps a callback sender unidentified when only owner fallback is available', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    const { app, dispose } = setup()
    try {
      await request(app).post('/discord/interaction').set('X-Connector-Secret', 'secret').send({
        channelId: 'channel-row', interaction: { id: 'click', token: 'token', channelId: 'room',
          messageId: 'question-message', userId: 'intruder', customId: 'wq:abcdefghijklmnopqrstuvwx:0' },
      }).expect(200)
      await vi.waitFor(() => expect(mocks.processChannelMessage).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'owner', isIdentified: false, workflowCallback: expect.any(Object),
      })))
      expect(dispatchIncomingMessageEvent).not.toHaveBeenCalled()
    } finally { dispose() }
  })

})

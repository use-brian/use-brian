import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { channelConfirmations, roomInteractionScope } from '../channel-interactions.js'

const mocks = vi.hoisted(() => ({
  incoming: { userId: 'actor', channelId: 'C1', messageId: '2', replyToMessageId: '1', text: 'yes', isGroupChat: false, isMentioned: false, isEdit: false, timestamp: 1, raw: {} },
  lock: vi.fn(async (_key: string, _fn: () => Promise<unknown>) => {}),
  send: vi.fn(async () => '3'),
  resolveSender: vi.fn(async (_store: unknown, _provider: string, sender: string) => ({ user: { id: `resolved:${sender}` }, isIdentified: false })),
  resolveRoom: vi.fn(async () => null),
  passivePost: vi.fn(async () => {}),
  reaction: vi.fn(async (_input: unknown) => ({ status: 'ignored' })),
}))
vi.mock('@use-brian/channels', async (original) => ({
  ...await original<typeof import('@use-brian/channels')>(),
  verifySlackSignature: () => true,
  createSlackAdapter: (opts: { onMessage: (incoming: unknown) => void }) => ({
    handleEvent: () => opts.onMessage(mocks.incoming), sendMessage: mocks.send,
  }),
}))
vi.mock('../../db/chat-lock.js', () => ({ withChatLock: mocks.lock }))
vi.mock('../../db/channel-user-store.js', () => ({ resolveChannelUser: mocks.resolveSender, channelLinkBindsHere: vi.fn(), ensureAssistantMember: vi.fn() }))
vi.mock('../../channel-room/room.js', () => ({ resolveRoomBinding: mocks.resolveRoom, postPassiveChannelMessage: mocks.passivePost, isWorkspaceAdmin: vi.fn(async () => false) }))
vi.mock('../../feedback/reaction-dispatch.js', () => ({ dispatchReactionFeedback: mocks.reaction }))
vi.mock('../../db/channels-store.js', () => ({
  getChannelForWebhook: async () => ({ status: 'active', enabledCapabilities: ['chat'] }),
  resolveRoutingForSurface: async () => ({ assistantId: 'assistant', modelAlias: 'standard' }),
}))
vi.mock('../../db/users.js', () => ({ findUserById: async () => null, findAssistantById: async () => ({ id: 'assistant', ownerUserId: 'owner', workspaceId: 'workspace' }) }))
vi.mock('../../billing-party.js', () => ({ billingPartyForAssistant: async () => 'owner' }))
import { slackRoutes } from '../slack.js'

afterEach(() => { vi.clearAllMocks(); mocks.resolveRoom.mockResolvedValue(null); mocks.incoming.userId = 'actor'; mocks.incoming.text = 'yes'; mocks.incoming.isGroupChat = false; mocks.incoming.replyToMessageId = '1'; mocks.incoming.messageId = '2'; mocks.incoming.isEdit = false; mocks.incoming.isMentioned = false; mocks.resolveSender.mockReset(); mocks.resolveSender.mockImplementation(async (_store, _provider, sender) => ({ user: { id: `resolved:${sender}` }, isIdentified: false })) })

describe('Slack shared confirmation admission', () => {
  it('uses the exact channel integration, sender and thread scope before the lock', async () => {
    const app = express()
    app.use(express.json())
    app.use('/slack', slackRoutes({ integrationStore: {
      getByChannelForWebhook: async () => ({ id: 'integration-uuid', channelId: '00000000-0000-4000-a000-000000000001',
        credentials: { bot_token: 'token', signing_secret: 'secret' }, config: { replyInThread: true } }),
      touchLastEventAt: async () => {},
    }, tools: new Map(), channelUserStore: {} } as never))
    const resolve = vi.fn()
    const dispose = channelConfirmations.register({
      channelType: 'slack', integrationId: '00000000-0000-4000-a000-000000000001', conversationId: 'C1', senderId: 'actor', sessionId: 'C1:thread:1',
    }, { toolCallId: 'call', toolName: 'tool', serverName: 'server', input: {}, classification: null, description: '' }, { resolve } as never)
    const post = async () => {
      await request(app).post('/slack/00000000-0000-4000-a000-000000000001').set('x-slack-signature', 'signature')
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

  function setupIdentityRoute(available: boolean, extra: Record<string, unknown> = {}) {
    const app = express()
    app.use(express.json())
    app.use('/slack', slackRoutes({ integrationStore: {
      getByChannelForWebhook: async () => ({ id: 'integration-uuid', channelId: '00000000-0000-4000-a000-000000000001', botUserId: 'BOT',
        credentials: { bot_token: 'token', signing_secret: 'secret' }, config: { replyInThread: true } }),
      touchLastEventAt: async () => {},
    }, tools: new Map(), channelUserStore: available ? {} : undefined, ...extra } as never))
    return (event: Record<string, unknown> = { type: 'message', text: 'yes' }) => request(app).post('/slack/00000000-0000-4000-a000-000000000001')
      .set('x-slack-signature', 'signature').set('x-slack-request-timestamp', '1')
      .send({ type: 'event_callback', event })
  }

  it.each(['missing', 'failed'])('refuses an active sender when resolution is %s before taking the turn lock', async mode => {
    if (mode === 'failed') mocks.resolveSender.mockRejectedValueOnce(new Error('identity lookup unavailable'))
    const post = setupIdentityRoute(mode !== 'missing')
    await post().expect(200)
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalled())
    expect(mocks.lock).not.toHaveBeenCalled()
    expect(mocks.send).toHaveBeenCalledWith('C1', { text: 'Your identity could not be verified. Please try again shortly.' }, { threadTs: '1' })
  })

  it.each(['missing', 'failed'])('skips unresolved passive attribution when resolution is %s without a notice', async mode => {
    if (mode === 'failed') mocks.resolveSender.mockRejectedValueOnce(new Error('identity lookup unavailable'))
    mocks.resolveRoom.mockResolvedValue({ workspaceId: 'workspace', channelIntegrationId: 'integration-uuid' } as never)
    mocks.incoming.isGroupChat = true
    const post = setupIdentityRoute(mode !== 'missing')
    await post().expect(200)
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    expect(mocks.passivePost).not.toHaveBeenCalled()
    expect(mocks.lock).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it.each(['missing', 'failed'])('does not attribute a reaction to the owner when resolution is %s', async mode => {
    const post = setupIdentityRoute(mode !== 'missing')
    await post({ type: 'reaction_added', user: 'other', reaction: 'thumbsup', item_user: 'BOT', item: { type: 'message', channel: 'C1', ts: '2' } }).expect(200)
    if (mode === 'missing') {
      await new Promise(resolve => setImmediate(resolve))
      expect(mocks.reaction).not.toHaveBeenCalled()
      return
    }
    await vi.waitFor(() => expect(mocks.reaction).toHaveBeenCalled())
    if (mode === 'failed') mocks.resolveSender.mockRejectedValueOnce(new Error('identity lookup unavailable'))
    const input = mocks.reaction.mock.calls[0]![0] as unknown as { resolveUserId(assistantId: string): Promise<string | null> }
    await expect(input.resolveUserId('assistant')).resolves.toBeNull()
  })


  it.each(['missing', 'failed'])('keeps scoped room cancel available when identity resolution is %s', async mode => {
    if (mode === 'failed') mocks.resolveSender.mockRejectedValue(new Error('identity lookup unavailable'))
    mocks.resolveRoom.mockResolvedValue({ workspaceId: 'workspace', channelIntegrationId: 'integration-uuid' } as never)
    mocks.incoming.isGroupChat = true
    mocks.incoming.text = 'cancel'
    mocks.incoming.isMentioned = true
    const findValidCode = vi.fn(async () => null)
    const post = setupIdentityRoute(mode !== 'missing', { linkCodeStore: { findValidCode }, linkedAccountStore: { findByProvider: vi.fn(async () => null) } })
    const scope = roomInteractionScope({ channelType: 'slack', integrationId: '00000000-0000-4000-a000-000000000001', conversationId: 'C1', senderId: 'original', sessionId: 'C1:thread:1' })
    const controller = new AbortController()
    const resolve = vi.fn()
    const onAbort = vi.fn()
    const disposeTurn = channelConfirmations.registerTurn(scope, controller, { addresserId: 'original', onAbort })
    const disposeConfirmation = channelConfirmations.register(scope,
      { toolCallId: 'scoped-cancel', toolName: 'sendEmail', input: {}, allowPersistentApproval: false } as never, { resolve } as never)
    try {
      await post().expect(200)
      await new Promise(r => setImmediate(r))
      await new Promise(r => setImmediate(r))
      expect(controller.signal.aborted).toBe(true)
      expect(resolve).toHaveBeenCalledExactlyOnceWith('scoped-cancel', 'deny')
      expect(onAbort).toHaveBeenCalledOnce()
      expect(findValidCode).not.toHaveBeenCalled()
      expect(mocks.resolveSender).not.toHaveBeenCalled()
      expect(mocks.lock).not.toHaveBeenCalled()
    } finally { disposeConfirmation(); disposeTurn() }
  })

  it('keeps exact original-message edit abort available during a sender lookup failure', async () => {
    mocks.resolveSender.mockRejectedValue(new Error('identity lookup unavailable'))
    mocks.incoming.isEdit = true
    mocks.incoming.text = 'changed message'
    const post = setupIdentityRoute(true)
    const scope = { channelType: 'slack', integrationId: '00000000-0000-4000-a000-000000000001', conversationId: 'C1', senderId: 'actor', sessionId: 'C1:thread:1' }
    const controller = new AbortController()
    const onAbort = vi.fn()
    const dispose = channelConfirmations.registerTurn(scope, controller, { messageId: '2', onAbort })
    try {
      mocks.incoming.messageId = 'other-message'
      await post().expect(200)
      await new Promise(r => setImmediate(r))
      expect(controller.signal.aborted).toBe(false)
      mocks.incoming.messageId = '2'
      await post().expect(200)
      await new Promise(r => setImmediate(r))
      expect(controller.signal.aborted).toBe(true)
      expect(onAbort).not.toHaveBeenCalled()
      expect(mocks.lock).not.toHaveBeenCalled()
    } finally { dispose() }
  })

})

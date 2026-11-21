import { expectMentionMatches } from './incoming-event-assertions.js'
import { dispatchIncomingMessageEvent } from '../../message-events.js'
vi.mock('../../message-events.js', () => ({ dispatchIncomingMessageEvent: vi.fn(async () => {}) }))
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

// ── Mock @use-brian/channels (adapter + verifier) ──────────────
vi.mock('@use-brian/channels', async (original) => {
  const parseIncoming = vi.fn()
  const sendMessage = vi.fn().mockResolvedValue('act-out')
  const sendStatus = vi.fn().mockResolvedValue('status-1')
  const editMessage = vi.fn().mockResolvedValue(undefined)
  const verifyAuthHeader = vi.fn()
  return {
    ...(await original<typeof import('@use-brian/channels')>()),
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
vi.mock('../../channel-room/room.js', () => ({
  resolveRoomBinding: vi.fn(async () => null),
  isWorkspaceAdmin: vi.fn(async (userId: string) => userId === 'owner'),
  postPassiveChannelMessage: vi.fn(async () => {}),
}))
vi.mock('../../db/sessions.js', async (original) => ({
  ...(await original<typeof import('../../db/sessions.js')>()),
  findOrCreateSession: vi.fn(async () => ({ id: 'attachment-session' })),
}))
vi.mock('@use-brian/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@use-brian/shared')>()),
  getToolDisplayName: vi.fn(() => 'Tool'),
  formatConfirmationInput: vi.fn(() => []),
}))

import { msteamsRoutes, msteamsUserAllowed } from '../msteams.js'
import { discordRoutes } from '../discord.js'
import * as channels from '@use-brian/channels'
import { processChannelMessage } from '../channel-pipeline.js'
import { channelConfirmations, roomInteractionScope } from '../channel-interactions.js'
import { isWorkspaceAdmin, postPassiveChannelMessage, resolveRoomBinding } from '../../channel-room/room.js'
import { withChatLock } from '../../db/chat-lock.js'
import { getChannelForWebhook, resolveRoutingForSurface, resolveAssistantForSurface } from '../../db/channels-store.js'
import { findAssistantById } from '../../db/users.js'
import { resolveChannelUser } from '../../db/channel-user-store.js'
import { findOrCreateSession } from '../../db/sessions.js'

const mocks = (channels as unknown as { __mocks: Record<string, ReturnType<typeof vi.fn>> }).__mocks
const realChannels = await vi.importActual<typeof import('@use-brian/channels')>('@use-brian/channels')

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

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(channels.createMsTeamsAdapter).mockReset()
  vi.mocked(resolveRoomBinding).mockResolvedValue(null)
  mocks.verifyAuthHeader.mockResolvedValue({ valid: true })
  mocks.parseIncoming.mockReturnValue({
    userId: '29:user', channelId: 'conv-1', text: 'hello',
    isGroupChat: false, isMentioned: false, messageId: 'a1', timestamp: 1700000000000,
  })
  vi.mocked(getChannelForWebhook).mockResolvedValue({ status: 'active', enabledCapabilities: ['chat'] } as never)
  vi.mocked(resolveRoutingForSurface).mockResolvedValue({ assistantId: 'a-1', modelAlias: 'pro' } as never)
  vi.mocked(findAssistantById).mockResolvedValue({ id: 'a-1', ownerUserId: 'owner', workspaceId: 'ws-1' } as never)
  vi.mocked(resolveChannelUser).mockResolvedValue({ user: { id: 'cu-1' }, isIdentified: false } as never)
})

describe('[COMP:api/channel-editable-status] Discord and Teams attachment turns', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    for (const spy of [Date.now, console.error]) {
      if (vi.isMockFunction(spy)) spy.mockRestore()
    }
  })

  it.each(['discord', 'msteams'] as const)('converts mixed %s downloads and delivers progress and replies', async (channelType) => {
    const discord = channelType === 'discord'
    const store = makeIntegrationStore()
    if (discord) store.getByChannelForWebhook.mockResolvedValue({
      id: 'int-1', config: {}, credentials: { bot_token: 'token' }, botUserId: 'bot',
    })
    else vi.mocked(channels.createMsTeamsAdapter).mockImplementation(realChannels.createMsTeamsAdapter)
    const cache = vi.fn(async () => ({ id: 'cached-image' }))
    const ingestChannelMediaRef = vi.fn(async () => ({ status: 'skipped' }))
    const options = { ...baseOptions(store), fileStore: { cache } as never }
    const router = discord
      ? discordRoutes({ ...options, connectorSecret: 'secret', ingestChannelMediaRef: ingestChannelMediaRef as never })
      : msteamsRoutes(options)
    const files = [
      { name: 'photo.png', mime: 'image/png', extension: 'png', body: 'pixels' },
      { name: 'denied.txt', mime: 'text/plain', extension: 'txt' },
      { name: 'note.txt', mime: 'text/plain', extension: 'txt', body: 'Document text' },
      { name: 'offline.txt', mime: 'text/plain', extension: 'txt' },
      { name: 'scan.pdf', mime: 'application/octet-stream', extension: 'bin', body: '%PDF-1.7' },
      { name: 'voice.mp3', mime: 'audio/mpeg', extension: 'mp3', body: 'voice' },
    ].map((file) => ({ ...file, url: `https://files.example.test/${file.name}` }))
    const delivery: Array<{ method?: string; url: string; body: Record<string, unknown>; upload?: FormData }> = []
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      const file = files.find((entry) => entry.url === url)
      if (file?.name === 'offline.txt') throw new Error('download unavailable')
      if (file?.name === 'photo.png') await new Promise((resolve) => setImmediate(resolve))
      if (file) return file.body ? new Response(file.body) : new Response(null, { status: 403 })
      if (url.startsWith('https://login.microsoftonline.com/')) return Response.json({ access_token: 'teams-token' })
      expect(new Headers(init?.headers).get('authorization')).toBe(discord ? 'Bot token' : 'Bearer teams-token')
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
      const upload = init?.body instanceof FormData ? init.body : undefined
      if (body.type !== 'typing') delivery.push({ method: init?.method, url, body, upload })
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      return Response.json({ id: 'progress-id' })
    })
    vi.stubGlobal('fetch', fetcher)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = request(createTestApp('/', router))
    if (discord) {
      const message = realChannels.createDiscordAdapter({ token: 'token', botUserId: 'bot' }).parseIncoming({
        id: 'a1', channel_id: 'conv-1', author: { id: 'user', username: 'User' },
        timestamp: '2026-01-01T00:00:00Z', content: ACTIVITY.text,
        attachments: files.map(({ url, name, mime }) => ({ url, filename: name, content_type: mime })),
      })
      await app.post('/inbound').set('X-Connector-Secret', 'secret').send({ channelId: 'ch-1', message }).expect(200)
    } else {
      await app.post('/ch-1').set('Authorization', 'Bearer good.jwt.token').send({ ...ACTIVITY,
        attachments: files.map(({ name, url, extension }) => ({
          name, contentType: 'application/vnd.microsoft.teams.file.download.info',
          content: { downloadUrl: url, fileType: extension },
        })),
      }).expect(200)
    }
    await vi.waitFor(() => expect(processChannelMessage).toHaveBeenCalledOnce())
    for (const file of files.filter(({ name }) => !discord || name !== 'voice.mp3')) {
      expect(fetcher).toHaveBeenCalledWith(file.url)
    }
    if (discord) {
      expect(fetcher).not.toHaveBeenCalledWith(files.at(-1)!.url)
      expect(ingestChannelMediaRef).toHaveBeenCalledWith(expect.objectContaining({ mime: 'audio/mpeg', conversationId: 'conv-1' }))
    }
    const { userContentBlocks, hooks } = vi.mocked(processChannelMessage).mock.calls[0][0]
    expect(findOrCreateSession).toHaveBeenCalledExactlyOnceWith({ assistantId: 'a-1', userId: 'cu-1', channelType, channelId: 'conv-1' })
    expect(cache).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: 'attachment-session', workspaceId: 'ws-1' }))
    expect(userContentBlocks).toEqual([
      { type: 'text', text: ACTIVITY.text },
      { type: 'image', mimeType: 'image/png', data: Buffer.from('pixels').toString('base64') },
      { type: 'text', text: '<attached_file id="cached-image" name="photo.png" type="image/png">[image]</attached_file>' },
      { type: 'text', text: '<attached_file name="note.txt" type="text/plain">\nDocument text\n</attached_file>' },
      { type: 'image', mimeType: 'application/pdf', data: Buffer.from('%PDF-1.7').toString('base64') },
      ...(discord ? [] : [{ type: 'text', text: '<attached_file name="voice.mp3" type="audio/mpeg">\n\n</attached_file>' }]),
    ])
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    await hooks.onProcessingStart!()
    await hooks.onToolStart!('search', 'webSearch')
    await hooks.onStatus!('Researching...')
    now += 1200
    await hooks.onToolInput!('search', 'webSearch', { query: 'project notes' })
    now += 1200
    await hooks.onToolResult!([{ type: 'tool_result', toolUseId: 'search', name: 'webSearch', content: 'Found' }])
    expect(await hooks.sendResponse('Ready')).toEqual({ channelMessageId: 'progress-id' })
    const edit = discord ? 'PATCH' : 'PUT'
    expect(delivery.map(({ method, body }) => [method, body.content ?? body.text])).toEqual([
      ['POST', 'Thinking...'], [edit, 'Researching...'], [edit, 'Searching "project notes"'],
      [edit, 'Done: Searching "project notes"'], [edit, 'Ready'],
    ])
    expect(delivery.slice(1).every(({ url }) => url.endsWith('/progress-id'))).toBe(true)
    await hooks.onProcessingStart!()
    delivery.length = 0
    const documents = [{ filename: 'reply.txt', mime: 'text/plain', data: new Uint8Array([65]) }]
    const actions = [{ id: '0', label: 'Choose', data: 'ask:token:0', replyText: 'Alpha' }]
    await hooks.sendResponse('With file', documents, undefined, actions)
    if (discord) {
      expect(delivery.map(({ method }) => method)).toEqual(['DELETE', 'POST', 'POST'])
      expect(delivery[1].body.message_reference).toMatchObject({ message_id: 'a1' })
      expect(delivery[1].body.components).toMatchObject([{ components: [{ custom_id: 'ask:token:0' }] }])
      const upload = delivery[2].upload?.get('files[0]')
      expect(upload).toBeInstanceOf(File)
      expect((upload as File).name).toBe('reply.txt')
      expect(await (upload as File).text()).toBe('A')
    } else {
      expect(delivery.map(({ method, body }) => [method, body.text])).toEqual([
        ['POST', 'With file\n\nChoose — reply: Alpha'],
        ['POST', 'Could not attach reply.txt here - open it in the web app.'], ['PUT', '…'],
      ])
    }
  })
})

describe('[COMP:api/msteams-route] webhook', () => {
  it.each([false, true])('dispatches passive/media messages with chat disabled (blocked=%s)', async blocked => {
    vi.mocked(getChannelForWebhook).mockResolvedValue({ workspaceId: 'ws', status: 'active', enabledCapabilities: [] } as never)
    mocks.parseIncoming.mockReturnValue({ userId: '29:user', channelId: 'conv-1', messageId: 'a1', text: '', files: [{ url: 'https://example.com/file', name: 'f', mimeType: 'audio/mpeg' }] })
    const app = createTestApp('/webhook/msteams', msteamsRoutes(baseOptions(makeIntegrationStore(
      blocked ? { userAccessMode: 'blocklist', blockedUserIds: ['29:user'] } : {},
    ))))
    await request(app).post('/webhook/msteams/ch-1').send(ACTIVITY)
    await flush()
    expect(dispatchIncomingMessageEvent).toHaveBeenCalledTimes(blocked ? 0 : 1)
    expect(processChannelMessage).not.toHaveBeenCalled()
    expect(channels.createMsTeamsAdapter).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ requireMention: false }) }))
  })

  it.each([
    { ...ACTIVITY, from: { id: '28:app' } },
    { ...ACTIVITY, type: 'invoke' },
    { ...ACTIVITY, from: {} },
  ])('rejects self, callbacks, and missing senders', async activity => {
    vi.mocked(channels.createMsTeamsAdapter).mockImplementation(realChannels.createMsTeamsAdapter)
    const app = createTestApp('/webhook/msteams', msteamsRoutes(baseOptions(makeIntegrationStore())))
    await request(app).post('/webhook/msteams/ch-1').send(activity)
    await flush()
    expect(dispatchIncomingMessageEvent).not.toHaveBeenCalled()
    expect(processChannelMessage).not.toHaveBeenCalled()
  })

  it.each([
    { text: 'hello', entities: [], mentions: [], normalizedText: 'hello' },
    {
      text: '<at>Human</at> hello',
      entities: [
        { type: 'mention', mentioned: { id: '29:human', name: 'Human' } },
        { type: 'mention', mentioned: { id: '29:human' } },
        { type: 'other', mentioned: { id: 'not-mentioned' } },
      ],
      mentions: ['29:human'],
      normalizedText: 'hello',
    },
    ...['28:app', '29:human'].map((id) => ({
      text: `<at>${id}</at>`,
      entities: [{ type: 'mention', mentioned: { id } }],
      mentions: [id],
      normalizedText: '',
    })),
  ])('dispatches passive or mention-only Teams activity ($text) without replying', async ({ text, entities, mentions, normalizedText }) => {
    vi.mocked(channels.createMsTeamsAdapter).mockImplementation(realChannels.createMsTeamsAdapter)
    const app = createTestApp('/webhook/msteams', msteamsRoutes(baseOptions(makeIntegrationStore())))
    await request(app).post('/webhook/msteams/ch-1').send({
      ...ACTIVITY, conversation: { id: 'conv-1', conversationType: 'channel' }, text, entities,
    })
    await flush()
    expect(dispatchIncomingMessageEvent).toHaveBeenCalledOnce()
    const [event] = vi.mocked(dispatchIncomingMessageEvent).mock.calls[0]
    expect(event.incoming.text).toBe(normalizedText)
    await expectMentionMatches(event, mentions)
    expect(processChannelMessage).not.toHaveBeenCalled()
    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })

  it('drives processChannelMessage on a verified message Activity', async () => {
    const app = createTestApp('/webhook/msteams', msteamsRoutes(baseOptions(makeIntegrationStore())))
    const res = await request(app)
      .post('/webhook/msteams/ch-1')
      .set('Authorization', 'Bearer good.jwt.token')
      .send(ACTIVITY)

    expect(res.status).toBe(200)
    await flush()
    expect(dispatchIncomingMessageEvent).toHaveBeenCalledTimes(1)
    expect(dispatchIncomingMessageEvent).toHaveBeenCalledWith(expect.objectContaining({ incoming: expect.objectContaining({ channelType: 'msteams', timestamp: 1700000000 }) }))
    expect(processChannelMessage).toHaveBeenCalledTimes(1)
    const arg = vi.mocked(processChannelMessage).mock.calls[0][0]
    expect(arg).toMatchObject({ userId: 'cu-1', isIdentified: false, ownerId: 'owner' })
    expect(arg.channelType).toBe('msteams')
    expect(arg.channelId).toBe('conv-1')
    expect(arg.questionIntegrationId).toBe('int-1')
    expect(arg.incomingMessage).toMatchObject({ userId: '29:user', channelId: 'conv-1', messageId: 'a1', text: 'hello' })
    expect(arg.interactionScope).toEqual({ channelType: 'msteams', integrationId: 'ch-1', conversationId: 'conv-1', senderId: '29:user' })
  })

  it('does not use a failed sender lookup as room-admin confirmation authority', async () => {
    vi.mocked(resolveRoomBinding).mockResolvedValue({ workspaceId: 'ws-1', channelIntegrationId: 'int-1' })
    vi.mocked(resolveChannelUser).mockRejectedValueOnce(new Error('identity lookup unavailable'))
    mocks.parseIncoming.mockReturnValue({
      userId: '29:other', channelId: 'conv-1', text: 'approve', isGroupChat: true,
      isMentioned: true, messageId: 'unverified-approval', timestamp: 1700000000000,
    })
    const scope = roomInteractionScope({ channelType: 'msteams', integrationId: 'ch-1', conversationId: 'conv-1', senderId: '29:addresser' })
    const resolve = vi.fn()
    const disposeTurn = channelConfirmations.registerTurn(scope, new AbortController(), { addresserId: '29:addresser', onAbort: () => {} })
    const disposeConfirmation = channelConfirmations.register(scope,
      { toolCallId: 'room-confirm', toolName: 'sendEmail', input: {}, allowPersistentApproval: false } as never, { resolve } as never)
    try {
      const app = createTestApp('/webhook/msteams', msteamsRoutes(baseOptions(makeIntegrationStore())))
      await request(app).post('/webhook/msteams/ch-1').set('Authorization', 'Bearer good.jwt.token').send(ACTIVITY)
      await flush()
      expect(resolve).not.toHaveBeenCalled()
      expect(isWorkspaceAdmin).not.toHaveBeenCalled()
      expect(processChannelMessage).not.toHaveBeenCalled()
      expect(mocks.sendMessage).toHaveBeenCalledWith('conv-1', { text: 'Your identity could not be verified. Please try again shortly.' })
    } finally { disposeConfirmation(); disposeTurn() }
  })

  it.each(['missing', 'failed'])('keeps room Stop available when identity resolution is %s', async mode => {
    vi.mocked(resolveRoomBinding).mockResolvedValue({ workspaceId: 'ws-1', channelIntegrationId: 'int-1' })
    const options = baseOptions(makeIntegrationStore())
    if (mode === 'missing') options.channelUserStore = undefined as never
    else vi.mocked(resolveChannelUser).mockRejectedValue(new Error('identity lookup unavailable'))
    mocks.parseIncoming.mockReturnValue({ userId: '29:other', channelId: 'conv-1', text: '/STOP', isGroupChat: true, isMentioned: true, messageId: 'stop', timestamp: 1700000000000 })
    const scope = roomInteractionScope({ channelType: 'msteams', integrationId: 'ch-1', conversationId: 'conv-1', senderId: '29:addresser' })
    const controller = new AbortController()
    const onAbort = vi.fn()
    const resolve = vi.fn()
    const dispose = channelConfirmations.registerTurn(scope, controller, { addresserId: '29:addresser', onAbort })
    const disposeConfirmation = channelConfirmations.register(scope,
      { toolCallId: 'teams-stop', toolName: 'sendEmail', input: {}, allowPersistentApproval: false } as never, { resolve } as never)
    try {
      const app = createTestApp('/webhook/msteams', msteamsRoutes(options))
      await request(app).post('/webhook/msteams/ch-1').set('Authorization', 'Bearer good.jwt.token').send(ACTIVITY)
      await flush()
      expect(controller.signal.aborted).toBe(true)
      expect(resolve).toHaveBeenCalledExactlyOnceWith('teams-stop', 'deny')
      expect(onAbort).toHaveBeenCalledOnce()
      expect(processChannelMessage).not.toHaveBeenCalled()
      expect(isWorkspaceAdmin).not.toHaveBeenCalled()
    } finally { disposeConfirmation(); dispose() }
  })

  it.each(['missing', 'failed'])('refuses an unresolved sender when resolution is %s', async mode => {
    const options = baseOptions(makeIntegrationStore())
    if (mode === 'missing') options.channelUserStore = undefined as never
    else vi.mocked(resolveChannelUser).mockRejectedValueOnce(new Error('resolution failed'))
    const app = createTestApp('/webhook/msteams', msteamsRoutes(options))
    await request(app).post('/webhook/msteams/ch-1').set('Authorization', 'Bearer good.jwt.token').send(ACTIVITY)
    await flush()
    expect(processChannelMessage).not.toHaveBeenCalled()
    expect(mocks.sendMessage).toHaveBeenCalledWith('conv-1', { text: 'Your identity could not be verified. Please try again shortly.' })
  })

  it.each(['missing', 'failed'])('does not attribute a passive room post when resolution is %s', async mode => {
    vi.mocked(resolveRoomBinding).mockResolvedValue({ workspaceId: 'ws-1', channelIntegrationId: 'int-1' })
    const options = baseOptions(makeIntegrationStore())
    if (mode === 'missing') options.channelUserStore = undefined as never
    else vi.mocked(resolveChannelUser).mockRejectedValueOnce(new Error('identity lookup unavailable'))
    const passive = { userId: '29:user', channelId: 'conv-1', messageId: 'passive', text: 'hello', isGroupChat: true }
    mocks.parseIncoming.mockReturnValueOnce(passive).mockReturnValueOnce(null)
    const app = createTestApp('/webhook/msteams', msteamsRoutes(options))
    await request(app).post('/webhook/msteams/ch-1').set('Authorization', 'Bearer good.jwt.token').send(ACTIVITY)
    await flush()
    expect(postPassiveChannelMessage).not.toHaveBeenCalled()
    expect(processChannelMessage).not.toHaveBeenCalled()
    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })

  it('resolves only the bound sender before acquiring the conversation lock', async () => {
    const resolver = { resolve: vi.fn() }
    const dispose = channelConfirmations.register({
      channelType: 'msteams', integrationId: 'ch-1', conversationId: 'conv-1', senderId: '29:user',
    }, { toolCallId: 'teams-confirm', toolName: 'sendEmail', input: {}, allowPersistentApproval: false } as never, resolver as never)
    const app = createTestApp('/webhook/msteams', msteamsRoutes(baseOptions(makeIntegrationStore())))
    try {
      mocks.parseIncoming.mockReturnValue({ userId: 'wrong', channelId: 'conv-1', text: 'approve', isGroupChat: false })
      await request(app).post('/webhook/msteams/ch-1').set('Authorization', 'Bearer good.jwt.token').send(ACTIVITY)
      await flush()
      expect(resolver.resolve).not.toHaveBeenCalled()
      vi.mocked(withChatLock).mockClear()
      vi.mocked(processChannelMessage).mockClear()
      mocks.parseIncoming.mockReturnValue({ userId: '29:user', channelId: 'conv-1', text: 'approve', isGroupChat: false })
      await request(app).post('/webhook/msteams/ch-1').set('Authorization', 'Bearer good.jwt.token').send(ACTIVITY)
      await flush()
      expect(resolver.resolve).toHaveBeenCalledWith('teams-confirm', 'allow', undefined)
      expect(withChatLock).not.toHaveBeenCalled()
      expect(processChannelMessage).not.toHaveBeenCalled()
    } finally { dispose() }
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
    expect(dispatchIncomingMessageEvent).not.toHaveBeenCalled()
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

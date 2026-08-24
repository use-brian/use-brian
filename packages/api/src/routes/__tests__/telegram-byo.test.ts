import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'
import { TelegramApiError } from '@use-brian/channels'
import { CUSTOM_MODEL_IMAGE_REJECTION } from '../_channel-error-text.js'

/**
 * [COMP:api/telegram-byo-route]
 *
 * Focused coverage for the BYO Telegram webhook route. These tests exercise
 * the end-to-end path from an inbound Telegram `update` object to the
 * channel-pipeline call, asserting the forum-topic behaviour documented in
 * docs/architecture/channels/adapter-pattern.md → "Telegram forum topics":
 *
 *   - Forum supergroup messages carry `chat.id:topic:<thread_id>` in
 *     `incoming.channelId`, so sessions, chat locks and group-chat context
 *     partition per topic.
 *   - Non-forum supergroups keep the bare chat id even when the Telegram
 *     update happens to include `message_thread_id` (reply chains aren't
 *     real topics).
 *   - The adapter callback on `hooks.sendResponse` targets the same
 *     topic-qualified channel id, which is what makes the Telegram API call
 *     include `message_thread_id` on the outbound reply.
 */

// ── Mocks ───────────────────────────────────────────────────────

// Capture adapter.leaveChat calls for the group add-protection tests.
const leaveChatCalls: string[] = []

// Capture createTelegramApi().setWebhook calls so the legacy-URL self-heal
// path can be asserted without touching api.telegram.org.
const setWebhookCalls: Array<{ url: string; secret: string }> = []

// Overridable so a test can fail the DOWNLOAD leg the way Telegram actually
// does (a 5xx from its own file service) and assert the turn blames Telegram
// rather than the transcriber. Reset in beforeEach.
const DEFAULT_DOWNLOAD_VOICE = async () => ({
  buffer: Buffer.from('voice'),
  mime: 'audio/ogg; codecs=opus',
})
let downloadVoiceImpl: () => Promise<{ buffer: Buffer; mime: string }> = DEFAULT_DOWNLOAD_VOICE

const { mergeShadowUser } = vi.hoisted(() => ({
  mergeShadowUser: vi.fn(async () => ({ merged: false })),
}))

vi.mock('../../db/linked-accounts.js', () => ({ mergeShadowUser }))

// Use the real Telegram adapter so parseIncoming runs the real topic-encoding
// logic (we want to assert the route's behaviour on real parse output), but
// stub out the network-touching bits.
vi.mock('@use-brian/channels', async () => {
  const actual = await vi.importActual<typeof import('@use-brian/channels')>('@use-brian/channels')
  return {
    ...actual,
    verifyTelegramWebhook: vi.fn(() => true),
    validateTelegramCredentials: vi.fn(async () => ({
      botId: 1,
      botUsername: 'testbot',
      botFirstName: 'Test Bot',
    })),
    // Stub the bare Telegram API client — used by the route's legacy-URL
    // self-heal to re-register the webhook. The real impl hits
    // api.telegram.org which fails in unit tests; capture the calls so
    // tests can assert the new URL was issued.
    createTelegramApi: vi.fn(() => ({
      setWebhook: vi.fn(async (url: string, secret: string) => {
        setWebhookCalls.push({ url, secret })
      }),
    })),
    // Wrap the real factory so parseMessage logic stays real, but every
    // network-touching method is stubbed. `leaveChat` records calls for
    // the add-protection assertions.
    createTelegramAdapter: (opts: Parameters<typeof actual.createTelegramAdapter>[0]) => {
      const real = actual.createTelegramAdapter(opts)
      return Object.assign(real, {
        sendMessage: vi.fn(async (channelId: string, message: { text: string; documents?: OutgoingTestDocument[] }) => {
          adapterSendCalls.push({ channelId, text: message.text, documents: message.documents })
          return 'msg_stub'
        }),
        sendStatus: vi.fn(async () => 'status_stub'),
        sendTypingIndicator: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
        deleteMessage: vi.fn(async () => {}),
        reactToMessage: vi.fn(async () => {}),
        leaveChat: vi.fn(async (chatId: string) => { leaveChatCalls.push(chatId) }),
        // Stub the network-touching media helpers — the real impl calls
        // api.telegram.org which fails fast in unit tests but adds noise.
        // `downloadMedia` echoes the file_id into the buffer so tests can
        // assert each photo of a media group flowed through independently.
        downloadVoice: vi.fn(() => downloadVoiceImpl()),
        downloadMedia: vi.fn(async (fileId: string) => ({
          buffer: Buffer.from(`bytes-of-${fileId}`),
          mime: 'image/jpeg',
          name: `${fileId}.jpg`,
        })),
      })
    },
  }
})

// Team-store helper mock — the route calls this when checking if the adder
// is a team owner/admin for team-scoped assistants.
const teamRoleCalls: Array<{ userId: string; workspaceId: string }> = []
let teamRoleResponse: 'owner' | 'admin' | 'member' | null = null
vi.mock('../../db/workspace-store.js', () => ({
  getWorkspaceRoleSystem: vi.fn(async (userId: string, workspaceId: string) => {
    teamRoleCalls.push({ userId, workspaceId })
    return teamRoleResponse
  }),
}))

// billingPartyForAssistant performs a DB query against `teams` to resolve
// the team owner post-089. Route-level tests don't exercise that lookup;
// returning a stable stub keeps the test focused on routing/auth logic.
vi.mock('../../billing-party.js', () => ({
  billingPartyForAssistant: vi.fn(async (a: { ownerUserId: string | null; workspaceId: string | null }) => {
    return a.ownerUserId ?? `team-owner-of-${a.workspaceId}`
  }),
}))

// Capture chat-lock keys for per-topic assertions.
const chatLockCalls: string[] = []
vi.mock('../../db/chat-lock.js', () => ({
  withChatLock: vi.fn(async (key: string, fn: () => Promise<unknown>) => {
    chatLockCalls.push(key)
    return await fn()
  }),
}))

// Capture processChannelMessage calls and invoke sendResponse so we can
// verify the adapter is called with a topic-qualified channel id on reply.
const pipelineCalls: Array<{
  channelId: string
  userId: string
  isIdentified: boolean
  externalGuest: boolean
  externalGuestConnectorTools: boolean
  isGroupChat: boolean
  messageText?: string
  userContentBlocks?: Array<{ type: string; mimeType?: string }>
}> = []
let pipelineError: Error | undefined
vi.mock('../channel-pipeline.js', () => ({
  processChannelMessage: vi.fn(async (params: {
    channelId: string
    userId: string
    isIdentified: boolean
    externalGuest?: boolean
    externalGuestConnectorTools?: boolean
    isGroupChat: boolean
    messageText?: string
    userContentBlocks?: Array<{ type: string; mimeType?: string }>
    hooks: {
      sendResponse: (text: string, documents?: OutgoingTestDocument[]) => Promise<void>
      sendError?: (err: Error) => Promise<void>
    }
  }) => {
    pipelineCalls.push({
      channelId: params.channelId,
      userId: params.userId,
      isIdentified: params.isIdentified,
      externalGuest: params.externalGuest === true,
      externalGuestConnectorTools: params.externalGuestConnectorTools === true,
      isGroupChat: params.isGroupChat,
      messageText: params.messageText,
      userContentBlocks: params.userContentBlocks,
    })
    if (pipelineError) {
      await params.hooks.sendError?.(pipelineError)
    } else {
      await params.hooks.sendResponse('ok', pipelineDocuments)
    }
  }),
}))

vi.mock('../../db/users.js', () => ({
  findAssistantById: vi.fn(async () => ({
    id: 'assistant_1',
    name: 'Test Assistant',
    ownerUserId: 'owner_1',
    workspaceId: null,
    defaultModelAlias: 'gemini-flash',
    systemPrompt: null,
  })),
  findUserById: vi.fn(async () => ({
    id: 'owner_1',
    plan: 'free',
    timezone: 'UTC',
  })),
}))

// Webhook routing resolution — channel-keyed since the channel_integrations
// split. The route resolves the answering assistant via the channel: an
// active chat-capable channel, with `channel_assistants` routing to
// `assistant_1` as the default.
vi.mock('../../db/channels-store.js', () => ({
  getChannelForWebhook: vi.fn(async () => ({
    id: 'channel_1',
    workspaceId: 'ws_1',
    channelType: 'telegram',
    status: 'active',
    enabledCapabilities: ['chat', 'broadcast'],
    displayName: 'Test Telegram',
  })),
  resolveAssistantForSurface: vi.fn(async () => 'assistant_1'),
  resolveRoutingForSurface: vi.fn(async () => ({
    id: 'ca_1',
    channelId: 'channel_1',
    assistantId: 'assistant_1',
    externalSurfaceId: null,
    modelAlias: 'standard',
    createdAt: new Date('2026-05-18T00:00:00Z'),
  })),
  resolveTelegramRoutingForSurface: vi.fn(async () => ({
    id: 'ca_1',
    channelId: 'channel_1',
    assistantId: 'assistant_1',
    externalSurfaceId: null,
    modelAlias: 'standard',
    createdAt: new Date('2026-05-18T00:00:00Z'),
  })),
  resolveAnyRoutingForChannel: vi.fn(async () => ({
    id: 'ca_1',
    channelId: 'channel_1',
    assistantId: 'assistant_1',
    externalSurfaceId: null,
    modelAlias: 'standard',
    createdAt: new Date('2026-05-18T00:00:00Z'),
  })),
}))

vi.mock('../../db/channel-user-store.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/channel-user-store.js')>(
    '../../db/channel-user-store.js',
  )
  return {
    ...actual,
    resolveChannelUser: vi.fn(async () => ({
      user: { id: 'owner_1' },
      isIdentified: true,
    })),
    ensureTrustedChannelWorkspaceMembership: vi.fn(async () => {}),
    fetchTelegramProfile: vi.fn(async () => null),
  }
})

// Capture outbound sendMessage invocations so we can assert the channel id.
type OutgoingTestDocument = { filename: string; mime: string; data: Buffer; caption?: string }
const adapterSendCalls: Array<{ channelId: string; text: string; documents?: OutgoingTestDocument[] }> = []
// Set by a test to make the mocked pipeline hand documents to `sendResponse`
// (the second argument the real pipeline passes at turn_complete).
let pipelineDocuments: OutgoingTestDocument[] | undefined
vi.mock('../../db/chat-lock.js', () => ({
  withChatLock: vi.fn(async (key: string, fn: () => Promise<unknown>) => {
    chatLockCalls.push(key)
    return await fn()
  }),
}))

// Only the save-on-request photo cache (`channel-file-cache.ts`) resolves a
// session in this route's import graph — the pipeline itself is mocked above.
vi.mock('../../db/sessions.js', () => ({
  findOrCreateSession: vi.fn(async () => ({ id: 'byo_sess_1' })),
}))

// ── Route import (must come after vi.mock calls) ───────────────

import {
  telegramByoRoutes,
  persistSeenChat,
  telegramLinkBindsHere,
  shouldUseUniversalTelegramIntake,
} from '../telegram-byo.js'
import { findOrCreateSession } from '../../db/sessions.js'
import {
  resolveAnyRoutingForChannel,
  resolveTelegramRoutingForSurface,
} from '../../db/channels-store.js'

const mockFindOrCreateSession = vi.mocked(findOrCreateSession)
const mockResolveAnyRouting = vi.mocked(resolveAnyRoutingForChannel)
const mockResolveTelegramRouting = vi.mocked(resolveTelegramRoutingForSurface)

// ── Test setup ──────────────────────────────────────────────────

function makeIntegrationStore(
  config: Record<string, unknown> = { requireMention: true },
  pinTrustedUsername = true,
) {
  return {
    getByChannelForWebhook: vi.fn(async () => ({
      id: 'integ_1',
      channelId: 'channel_1',
      channelType: 'telegram',
      botUsername: 'testbot',
      botUserId: '999999',
      config,
      credentials: {
        bot_token: 'fake-token',
        webhook_secret: 'webhook-secret',
      },
    })),
    touchLastEventAt: vi.fn(async () => undefined),
    setBotUsername: vi.fn(async () => undefined),
    pinTrustedTelegramUsernameSystem: vi.fn(async () => pinTrustedUsername),
    mergeConfigSystem: vi.fn(async () => undefined),
  }
}

async function postUpdate(
  app: Parameters<typeof request>[0],
  update: Record<string, unknown>,
): Promise<void> {
  // The webhook is mounted at `/:channelId` since the channel_integrations
  // split — the workspace `channels` id, not the assistant id.
  await request(app)
    .post('/webhook/telegram-byo/channel_1')
    .set('x-telegram-bot-api-secret-token', 'webhook-secret')
    .send(update)
}

function flushMicrotasks(): Promise<void> {
  // Route ACKs 200 immediately then processes async — two microtask flushes
  // give findOrCreateSession / processChannelMessage time to complete.
  return new Promise((r) => setImmediate(r))
}

beforeEach(() => {
  chatLockCalls.length = 0
  pipelineCalls.length = 0
  adapterSendCalls.length = 0
  pipelineDocuments = undefined
  pipelineError = undefined
  leaveChatCalls.length = 0
  teamRoleCalls.length = 0
  teamRoleResponse = null
  setWebhookCalls.length = 0
  downloadVoiceImpl = DEFAULT_DOWNLOAD_VOICE
  mergeShadowUser.mockClear()
})

describe('[COMP:api/telegram-byo-route] safe error delivery', () => {
  function makeApp() {
    return createTestApp(
      '/webhook/telegram-byo',
      telegramByoRoutes({
        provider: {} as never,
        systemPrompt: '',
        tools: new Map(),
        memoryStore: {} as never,
        integrationStore: makeIntegrationStore() as never,
        capabilityStore: {} as never,
        apiUrl: 'http://test',
      }),
    )
  }

  it('explains that a custom text-only model cannot inspect an inbound image', async () => {
    // The one shared copy of this sentence — matched by identity in
    // `channelUserErrorText`, so a literal here would drift out of the
    // whitelist the moment the copy is corrected (it was, on 2026-08-19).
    pipelineError = new Error(CUSTOM_MODEL_IMAGE_REJECTION)

    await postUpdate(makeApp(), {
      update_id: 700,
      message: {
        message_id: 700,
        from: { id: 42, first_name: 'Casey', username: 'casey' },
        chat: { id: 42, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        caption: 'Summarize this customer feedback.',
        photo: [{ file_id: 'feedback_screenshot' }],
      },
    })
    await flushMicrotasks()
    await flushMicrotasks()

    expect(pipelineCalls).toHaveLength(1)
    expect(pipelineCalls[0].userContentBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'image', mimeType: 'image/jpeg' }),
    ]))
    expect(adapterSendCalls.at(-1)?.text).toBe(pipelineError.message)
  })

  it('keeps arbitrary provider errors out of the Telegram reply', async () => {
    pipelineError = new Error(
      'Custom model endpoints currently support text and tools only. Upstream vendor detail that must stay private.',
    )

    await postUpdate(makeApp(), {
      update_id: 701,
      message: {
        message_id: 701,
        from: { id: 42, first_name: 'Casey', username: 'casey' },
        chat: { id: 42, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: 'hello',
      },
    })
    await flushMicrotasks()
    await flushMicrotasks()

    expect(adapterSendCalls.at(-1)?.text).toBe('Something went wrong. Please try again.')
  })
})

describe('[COMP:api/telegram-byo-route] OSS owner pairing', () => {
  it('claims a setup code once and links the Telegram sender to the local owner', async () => {
    const code = {
      id: 'code-1',
      userId: 'owner_1',
      assistantId: 'assistant_1',
      code: 'ABC234',
      expiresAt: new Date(Date.now() + 60_000),
      claimedAt: null,
      claimedByProviderId: null,
      createdAt: new Date(),
    }
    const linkCodeStore = {
      findValidCode: vi.fn().mockResolvedValue(code),
      claim: vi.fn().mockResolvedValue(code),
    }
    const linkedAccountStore = {
      upsert: vi.fn().mockResolvedValue({}),
      findByProvider: vi.fn().mockResolvedValue(null),
    }
    const app = createTestApp(
      '/webhook/telegram-byo',
      telegramByoRoutes({
        provider: {} as never,
        systemPrompt: '',
        tools: new Map(),
        memoryStore: {} as never,
        integrationStore: makeIntegrationStore() as never,
        linkedAccountStore: linkedAccountStore as never,
        ownerPairing: { enabled: true, linkCodeStore: linkCodeStore as never },
        capabilityStore: {} as never,
        apiUrl: 'http://test',
      }),
    )

    await postUpdate(app, {
      update_id: 1,
      message: {
        message_id: 10,
        from: { id: 42, first_name: 'Owner', username: 'localowner' },
        chat: { id: 42, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: '/start ABC234',
      },
    })
    await flushMicrotasks()
    await flushMicrotasks()

    expect(linkCodeStore.claim).toHaveBeenCalledWith('ABC234', '42')
    expect(linkedAccountStore.upsert).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'owner_1',
      assistantId: 'assistant_1',
      provider: 'telegram',
      providerId: '42',
    }))
    expect(mergeShadowUser).toHaveBeenCalledWith(
      'owner_1',
      '42',
      'telegram',
      expect.objectContaining({ reason: 'link-code' }),
    )
    expect(adapterSendCalls.at(-1)?.text).toContain('linked to your Brian account')
    expect(pipelineCalls).toHaveLength(0)
  })

  it('does not link when the atomic claim has already been won', async () => {
    const candidate = {
      id: 'code-1', userId: 'owner_1', assistantId: 'assistant_1', code: 'ABC234',
    }
    const linkCodeStore = {
      findValidCode: vi.fn().mockResolvedValue(candidate),
      claim: vi.fn().mockResolvedValue(null),
    }
    const linkedAccountStore = {
      upsert: vi.fn(),
      findByProvider: vi.fn().mockResolvedValue(null),
    }
    const app = createTestApp(
      '/webhook/telegram-byo',
      telegramByoRoutes({
        provider: {} as never,
        systemPrompt: '',
        tools: new Map(),
        memoryStore: {} as never,
        integrationStore: makeIntegrationStore() as never,
        linkedAccountStore: linkedAccountStore as never,
        ownerPairing: { enabled: true, linkCodeStore: linkCodeStore as never },
        capabilityStore: {} as never,
        apiUrl: 'http://test',
      }),
    )

    await postUpdate(app, {
      update_id: 2,
      message: {
        message_id: 11,
        from: { id: 43, first_name: 'Imposter' },
        chat: { id: 43, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: 'ABC234',
      },
    })
    await flushMicrotasks()
    await flushMicrotasks()

    expect(linkedAccountStore.upsert).not.toHaveBeenCalled()
  })
})

describe('[COMP:api/telegram-byo-route] OSS audio intake fallback', () => {
  it('routes audio to universal intake only when hosted recordingIngest is absent', () => {
    expect(shouldUseUniversalTelegramIntake('audio', false)).toBe(true)
    expect(shouldUseUniversalTelegramIntake('audio', true)).toBe(false)
    expect(shouldUseUniversalTelegramIntake('document', true)).toBe(true)
  })

  // `voice` is the gap this describe's sibling above does not cover: it is
  // excluded from universal intake AND from the non-voice content-block
  // branch, so the voice-transcription preflight is its ONLY path. On OSS,
  // where the kill switch defaulted off until 2026-07-29, that path was shut
  // and the turn reached the model with nothing in it — so it answered "I
  // don't see a recording attachment" and asked for a re-upload that failed
  // the same way (2026-07-28, live Telegram bot).
  it('never routes a voice note to universal intake', () => {
    expect(shouldUseUniversalTelegramIntake('voice', false)).toBe(false)
    expect(shouldUseUniversalTelegramIntake('voice', true)).toBe(false)
  })
})

describe('[COMP:api/telegram-byo-route] voice note without a transcript', () => {
  function buildVoiceUpdate(caption?: string): Record<string, unknown> {
    return {
      update_id: 900,
      message: {
        message_id: 900,
        from: { id: 42, first_name: 'Hinson', username: 'hinson' },
        chat: { id: 42, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        voice: { file_id: 'voice_file_1', duration: 5, file_size: 4096 },
        ...(caption ? { caption } : {}),
      },
    }
  }

  function appWith(voiceTranscription?: { enabled: boolean; apiKey: string; model?: string }) {
    return createTestApp(
      '/webhook/telegram-byo',
      telegramByoRoutes({
        provider: {} as never,
        systemPrompt: '',
        tools: new Map(),
        memoryStore: {} as never,
        integrationStore: makeIntegrationStore() as never,
        capabilityStore: {} as never,
        apiUrl: 'http://test',
        ...(voiceTranscription ? { voiceTranscription } : {}),
      }),
    )
  }

  it('tells the model the voice note arrived when the kill switch is off', async () => {
    await postUpdate(appWith({ enabled: false, apiKey: 'k' }), buildVoiceUpdate())
    await flushMicrotasks()
    await flushMicrotasks()

    expect(pipelineCalls).toHaveLength(1)
    // The turn must not be empty — an empty turn is what the model reads as
    // "the user sent nothing".
    expect(pipelineCalls[0].messageText).toMatch(/voice note received/i)
    expect(pipelineCalls[0].messageText).toContain('VOICE_TRANSCRIPTION_ENABLED')
    expect(pipelineCalls[0].messageText).toMatch(/no attachment/i)
  })

  it('preserves the caption alongside the unavailable note', async () => {
    await postUpdate(appWith({ enabled: false, apiKey: 'k' }), buildVoiceUpdate('listen to this'))
    await flushMicrotasks()
    await flushMicrotasks()

    expect(pipelineCalls).toHaveLength(1)
    expect(pipelineCalls[0].messageText).toMatch(/voice note received/i)
    expect(pipelineCalls[0].messageText).toContain('listen to this')
  })

  it('reports the same way when transcription is wired but unavailable at boot', async () => {
    // No voiceTranscription option at all — the shape an incompletely wired
    // deployment produces. Still a voice note, still must be named.
    await postUpdate(appWith(undefined), buildVoiceUpdate())
    await flushMicrotasks()
    await flushMicrotasks()

    expect(pipelineCalls).toHaveLength(1)
    expect(pipelineCalls[0].messageText).toMatch(/voice note received/i)
  })

  it('blames Telegram, with its status code, when the download leg 5xxs', async () => {
    // The 2026-08-17 regression: `getFile` returned 504, the shared catch ran
    // the error through `describeTranscriptionFailure`, its /timeout|abort/i
    // branch matched "Gateway Timeout", and the assistant told the user their
    // voice note was too long for the transcriber — about audio the
    // transcriber had never been handed.
    downloadVoiceImpl = async () => {
      throw new TelegramApiError('getFile', 'Gateway Timeout', 504)
    }
    await postUpdate(appWith({ enabled: true, apiKey: 'k' }), buildVoiceUpdate())
    await flushMicrotasks()
    await flushMicrotasks()

    expect(pipelineCalls).toHaveLength(1)
    const text = pipelineCalls[0].messageText
    // Still arrives AS a voice note — an empty turn reads as "user sent nothing".
    expect(text).toMatch(/voice note received/i)
    // Names the real culprit and its code.
    expect(text).toContain('504')
    expect(text).toMatch(/Telegram/)
    // And never re-describes a Telegram fault in the transcriber's vocabulary.
    expect(text).not.toMatch(/transcription (timed out|failed)/i)
  })

  it('keeps the caption when the download leg fails', async () => {
    downloadVoiceImpl = async () => {
      throw new TelegramApiError('downloadFile', 'Bad Gateway', 502)
    }
    await postUpdate(appWith({ enabled: true, apiKey: 'k' }), buildVoiceUpdate('listen to this'))
    await flushMicrotasks()
    await flushMicrotasks()

    expect(pipelineCalls).toHaveLength(1)
    expect(pipelineCalls[0].messageText).toContain('listen to this')
    expect(pipelineCalls[0].messageText).toContain('502')
  })
})

describe('[COMP:api/telegram-byo-route] forum-topic routing', () => {
  function buildForumUpdate(params: {
    updateId: number
    messageId: number
    threadId: number
    chatId?: number
    text?: string
  }): Record<string, unknown> {
    return {
      update_id: params.updateId,
      message: {
        message_id: params.messageId,
        from: { id: 42, first_name: 'Hinson', username: 'hinson' },
        chat: { id: params.chatId ?? -1001234567890, type: 'supergroup', is_forum: true },
        date: Math.floor(Date.now() / 1000),
        text: params.text ?? '@testbot hello',
        entities: [{ type: 'mention', offset: 0, length: 8 }],
        message_thread_id: params.threadId,
      },
    }
  }

  it('drives the chat lock with a topic-qualified key per forum topic', async () => {
    const app = createTestApp(
      '/webhook/telegram-byo',
      telegramByoRoutes({
        provider: {} as never,
        systemPrompt: '',
        tools: new Map(),
        memoryStore: {} as never,
        integrationStore: makeIntegrationStore() as never,
        capabilityStore: {} as never,
        apiUrl: 'http://test',
      }),
    )

    await postUpdate(app, buildForumUpdate({ updateId: 1, messageId: 100, threadId: 42 }))
    await postUpdate(app, buildForumUpdate({ updateId: 2, messageId: 101, threadId: 99 }))
    await flushMicrotasks()
    await flushMicrotasks()

    // One lock key per topic — parallel topics do not serialize against each other.
    expect(chatLockCalls).toContain('tg-byo:-1001234567890:topic:42')
    expect(chatLockCalls).toContain('tg-byo:-1001234567890:topic:99')
  })

  it('passes topic-qualified channelId to the channel pipeline', async () => {
    const app = createTestApp(
      '/webhook/telegram-byo',
      telegramByoRoutes({
        provider: {} as never,
        systemPrompt: '',
        tools: new Map(),
        memoryStore: {} as never,
        integrationStore: makeIntegrationStore() as never,
        capabilityStore: {} as never,
        apiUrl: 'http://test',
      }),
    )

    await postUpdate(app, buildForumUpdate({ updateId: 10, messageId: 200, threadId: 7 }))
    await flushMicrotasks()
    await flushMicrotasks()

    expect(pipelineCalls).toHaveLength(1)
    expect(pipelineCalls[0]).toMatchObject({ channelId: '-1001234567890:topic:7', isGroupChat: true })
  })

  it('routes a privacy-mode /ask command without an @mention', async () => {
    const app = createTestApp(
      '/webhook/telegram-byo',
      telegramByoRoutes({
        provider: {} as never,
        systemPrompt: '',
        tools: new Map(),
        memoryStore: {} as never,
        integrationStore: makeIntegrationStore() as never,
        capabilityStore: {} as never,
        apiUrl: 'http://test',
      }),
    )

    const update = buildForumUpdate({
      updateId: 11,
      messageId: 201,
      threadId: 7,
      text: '/ask summarize this thread',
    }) as { message: { entities: Array<{ type: string; offset: number; length: number }> } }
    update.message.entities = [{ type: 'bot_command', offset: 0, length: 4 }]
    await postUpdate(app, update)
    await flushMicrotasks()
    await flushMicrotasks()

    expect(pipelineCalls).toHaveLength(1)
    expect(pipelineCalls[0]).toMatchObject({
      channelId: '-1001234567890:topic:7',
      messageText: 'summarize this thread',
      isGroupChat: true,
    })
  })

  it('keeps the bare chat id when the supergroup is not a forum', async () => {
    const app = createTestApp(
      '/webhook/telegram-byo',
      telegramByoRoutes({
        provider: {} as never,
        systemPrompt: '',
        tools: new Map(),
        memoryStore: {} as never,
        integrationStore: makeIntegrationStore() as never,
        capabilityStore: {} as never,
        apiUrl: 'http://test',
      }),
    )

    // Same update shape, but chat.is_forum is not set → Telegram reply chain
    // in a regular supergroup, which we treat as a single conversation.
    await postUpdate(app, {
      update_id: 50,
      message: {
        message_id: 500,
        from: { id: 42, first_name: 'Hinson', username: 'hinson' },
        chat: { id: -1001234567890, type: 'supergroup' },
        date: Math.floor(Date.now() / 1000),
        text: '@testbot hi',
        entities: [{ type: 'mention', offset: 0, length: 8 }],
        message_thread_id: 7,
      },
    })
    await flushMicrotasks()
    await flushMicrotasks()

    expect(chatLockCalls).toEqual(['tg-byo:-1001234567890'])
    expect(pipelineCalls).toHaveLength(1)
    expect(pipelineCalls[0]).toMatchObject({ channelId: '-1001234567890', isGroupChat: true })
  })

  it('boots from a surface route when the channel has no default assistant', async () => {
    const app = createTestApp(
      '/webhook/telegram-byo',
      telegramByoRoutes({
        provider: {} as never,
        systemPrompt: '',
        tools: new Map(),
        memoryStore: {} as never,
        integrationStore: makeIntegrationStore() as never,
        capabilityStore: {} as never,
        apiUrl: 'http://test',
      }),
    )
    mockResolveTelegramRouting.mockResolvedValueOnce(null)

    await postUpdate(app, buildForumUpdate({ updateId: 51, messageId: 501, threadId: 42 }))
    await flushMicrotasks()
    await flushMicrotasks()

    expect(mockResolveAnyRouting).toHaveBeenCalledWith('channel_1')
    expect(pipelineCalls).toHaveLength(1)
    expect(pipelineCalls[0]).toMatchObject({ channelId: '-1001234567890:topic:42' })
  })

  it('drops an unmatched topic when a surface-only channel has no default', async () => {
    const app = createTestApp(
      '/webhook/telegram-byo',
      telegramByoRoutes({
        provider: {} as never,
        systemPrompt: '',
        tools: new Map(),
        memoryStore: {} as never,
        integrationStore: makeIntegrationStore() as never,
        capabilityStore: {} as never,
        apiUrl: 'http://test',
      }),
    )
    mockResolveTelegramRouting
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)

    await postUpdate(app, buildForumUpdate({ updateId: 52, messageId: 502, threadId: 99 }))
    await flushMicrotasks()
    await flushMicrotasks()

    expect(mockResolveAnyRouting).toHaveBeenCalledWith('channel_1')
    expect(pipelineCalls).toHaveLength(0)
  })
})

describe('[COMP:api/telegram-byo-route] media-group buffering', () => {
  // Regression: pre-refactor the BYO route captured the parsed message into a
  // closure variable (`extractedMessage = msg`) and then ran the post-extract
  // pipeline inline in the request handler. Media groups arrive as N webhook
  // updates with the same `media_group_id`; the adapter buffers them for
  // 500ms and only then fires `onMessage`. By then the request handler had
  // already returned, so the closure was dead and the message was silently
  // dropped (zero `session_messages` rows). See the GM Bro 5:33 PM business
  // cards in prod — both photos vanished.
  //
  // Fix has two layers:
  //   1. `onMessage` routes through `handleIncoming` (an async function whose
  //      closure outlives the request).
  //   2. Cross-webhook merge buffer at the route factory scope (BYO builds a
  //      fresh adapter per request, so the adapter's own buffer can't merge).
  //      Photos accumulate by `(assistantId, media_group_id)`, then flush as
  //      ONE `IncomingMessage` carrying `files[]` so the model sees both
  //      cards in a single turn (one reply, downloads parallelised).

  function buildMediaGroupPhoto(params: {
    updateId: number
    messageId: number
    fileId: string
    mediaGroupId: string
    chatId?: number
    fromId?: number
    caption?: string
  }): Record<string, unknown> {
    return {
      update_id: params.updateId,
      message: {
        message_id: params.messageId,
        from: { id: params.fromId ?? 42, first_name: 'Hinson', username: 'hinson' },
        chat: { id: params.chatId ?? 9001, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        photo: [
          { file_id: `${params.fileId}_small` },
          { file_id: params.fileId },
        ],
        media_group_id: params.mediaGroupId,
        caption: params.caption,
      },
    }
  }

  it('routes a buffered media-group photo through to the pipeline (regression)', async () => {
    const app = createTestApp(
      '/webhook/telegram-byo',
      telegramByoRoutes({
        provider: {} as never,
        systemPrompt: '',
        tools: new Map(),
        memoryStore: {} as never,
        integrationStore: makeIntegrationStore() as never,
        capabilityStore: {} as never,
        apiUrl: 'http://test',
      }),
    )

    // Two photos sent as one media group — Telegram delivers them as two
    // webhook updates that the adapter merges via a 500ms buffer (see
    // packages/channels/src/telegram/adapter.ts MEDIA_GROUP_TIMEOUT_MS).
    await postUpdate(app, buildMediaGroupPhoto({
      updateId: 501,
      messageId: 419,
      fileId: 'card_1_id',
      mediaGroupId: 'mg_business_cards',
    }))
    await postUpdate(app, buildMediaGroupPhoto({
      updateId: 502,
      messageId: 420,
      fileId: 'card_2_id',
      mediaGroupId: 'mg_business_cards',
    }))

    // Pre-refactor the request handler had already returned by now and the
    // closure that was meant to receive `onMessage` was dead — verify the
    // pipeline has not been called yet (the 500ms timer hasn't fired).
    expect(pipelineCalls).toHaveLength(0)

    // Wait past the 500ms media-group buffer + microtask drain so the
    // buffered `onMessage` fires and `handleIncoming` runs to completion.
    await new Promise((r) => setTimeout(r, 700))
    await flushMicrotasks()

    // The two webhooks merge into ONE pipeline call carrying both image
    // blocks. This is the product-correct behaviour: one user-intent moment
    // (drop two cards) → one model turn → one reply.
    expect(pipelineCalls).toHaveLength(1)
    const call = pipelineCalls[0]
    expect(call.channelId).toBe('9001')
    const imageBlocks = (call.userContentBlocks ?? []).filter((b) => b.type === 'image')
    expect(imageBlocks).toHaveLength(2)
    expect(imageBlocks.every((b) => b.mimeType === 'image/jpeg')).toBe(true)
  })

  it('caches media-group photos into file_cache and stamps <attached_file id> tags (save-on-request)', async () => {
    // With a fileStore wired and a workspace assistant, each photo of the
    // merged group is cached (data-URL row) BEFORE block-building, so the one
    // merged turn carries a promotable `<attached_file id>` tag per photo —
    // that id is what `saveFileToBrain` promotes when the user asks. See
    // docs/architecture/engine/file-handling.md → "Save-on-request".
    const { findAssistantById } = await import('../../db/users.js')
    const prevImpl = vi.mocked(findAssistantById).getMockImplementation()
    vi.mocked(findAssistantById).mockResolvedValue({
      id: 'assistant_1',
      name: 'Test Assistant',
      ownerUserId: 'owner_1',
      workspaceId: 'ws_1', // the cache gate requires a workspace
      defaultModelAlias: 'gemini-flash',
      systemPrompt: null,
    } as never)
    let cacheN = 0
    const fileStore = { cache: vi.fn(async () => ({ id: `fc_${++cacheN}` })) }
    try {
      const app = createTestApp(
        '/webhook/telegram-byo',
        telegramByoRoutes({
          provider: {} as never,
          systemPrompt: '',
          tools: new Map(),
          memoryStore: {} as never,
          integrationStore: makeIntegrationStore() as never,
          capabilityStore: {} as never,
          apiUrl: 'http://test',
          fileStore: fileStore as never,
        }),
      )

      await postUpdate(app, buildMediaGroupPhoto({
        updateId: 601,
        messageId: 519,
        fileId: 'save_1_id',
        mediaGroupId: 'mg_save_on_request',
      }))
      await postUpdate(app, buildMediaGroupPhoto({
        updateId: 602,
        messageId: 520,
        fileId: 'save_2_id',
        mediaGroupId: 'mg_save_on_request',
      }))
      await new Promise((r) => setTimeout(r, 700))
      await flushMicrotasks()

      expect(pipelineCalls).toHaveLength(1)
      // Both photos cached, keyed to this route's own pipeline session key
      // (userId = the CHANNEL user, not the owner-as-such — same value the
      // pipeline passes) and stamped workspace-shared.
      expect(mockFindOrCreateSession).toHaveBeenCalledWith({
        assistantId: 'assistant_1',
        userId: 'owner_1',
        channelType: 'telegram',
        channelId: '9001',
      })
      expect(fileStore.cache).toHaveBeenCalledTimes(2)
      expect(fileStore.cache).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'byo_sess_1',
        mimeType: 'image/jpeg',
        workspaceId: 'ws_1',
      }))
      // The merged turn carries one promotable tag per photo.
      const textBlock = (pipelineCalls[0].userContentBlocks ?? []).find(
        (b) => b.type === 'text',
      ) as { text?: string } | undefined
      expect(textBlock?.text).toContain('<attached_file id="fc_1"')
      expect(textBlock?.text).toContain('<attached_file id="fc_2"')
    } finally {
      // Restore the file-level default (workspaceId: null) — later tests'
      // add-protection / routing behavior depends on it.
      vi.mocked(findAssistantById).mockImplementation(prevImpl!)
    }
  })

  it('downloads media-group photos in parallel (Promise.all)', async () => {
    // Records start/end events on a single timeline. Parallel execution
    // interleaves them (start_a, start_b, end_a, end_b); a serial
    // `for await` loop would give (start_a, end_a, start_b, end_b).
    const timeline: string[] = []
    const channels = await import('@use-brian/channels')
    const adapterFactory = channels.createTelegramAdapter
    const originalCreate = adapterFactory
    ;(channels as unknown as { createTelegramAdapter: typeof adapterFactory }).createTelegramAdapter =
      ((opts: Parameters<typeof adapterFactory>[0]) => {
        const inst = originalCreate(opts) as ReturnType<typeof originalCreate> & {
          downloadMedia: (fileId: string) => Promise<{ buffer: Buffer; mime: string; name: string }>
        }
        inst.downloadMedia = async (fileId: string) => {
          timeline.push(`start:${fileId}`)
          await new Promise((r) => setTimeout(r, 50))
          timeline.push(`end:${fileId}`)
          return { buffer: Buffer.from(`bytes-of-${fileId}`), mime: 'image/jpeg', name: `${fileId}.jpg` }
        }
        return inst
      }) as typeof adapterFactory
    try {
      const app = createTestApp(
        '/webhook/telegram-byo',
        telegramByoRoutes({
          provider: {} as never,
          systemPrompt: '',
          tools: new Map(),
          memoryStore: {} as never,
          integrationStore: makeIntegrationStore() as never,
          capabilityStore: {} as never,
          apiUrl: 'http://test',
        }),
      )

      await postUpdate(app, buildMediaGroupPhoto({
        updateId: 601,
        messageId: 519,
        fileId: 'par_a',
        mediaGroupId: 'mg_parallel',
      }))
      await postUpdate(app, buildMediaGroupPhoto({
        updateId: 602,
        messageId: 520,
        fileId: 'par_b',
        mediaGroupId: 'mg_parallel',
      }))

      await new Promise((r) => setTimeout(r, 800))
      await flushMicrotasks()

      // Parallel: both starts precede both ends.
      expect(timeline).toEqual(['start:par_a', 'start:par_b', 'end:par_a', 'end:par_b'])
    } finally {
      ;(channels as unknown as { createTelegramAdapter: typeof adapterFactory }).createTelegramAdapter = originalCreate
    }
  })
})

describe('[COMP:api/telegram-byo-route] cross-assistant identity bleed', () => {
  function buildPrivateDm(fromId: number, text: string): Record<string, unknown> {
    return {
      update_id: fromId * 10,
      message: {
        message_id: fromId,
        from: { id: fromId, first_name: 'Sender', username: `sender${fromId}` },
        chat: { id: fromId, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text,
      },
    }
  }

  function makeLinkedAccountStore(row: { userId: string; assistantId: string | null } | null) {
    return {
      findByProvider: vi.fn(async () =>
        row
          ? {
              id: 'la_1',
              userId: row.userId,
              assistantId: row.assistantId,
              provider: 'telegram',
              providerId: '42',
              providerMetadata: null,
              linkedAt: new Date(),
            }
          : null,
      ),
      upsert: vi.fn(),
      findByAssistant: vi.fn(),
      listForUser: vi.fn(),
      deleteForUser: vi.fn(),
    }
  }

  // Minimal channel-user-store mock — enough to satisfy the store-present
  // branch. The module-level `vi.mock('../../db/channel-user-store.js', ...)`
  // stubs `resolveChannelUser` directly, so this object just has to be truthy.
  const channelUserStoreStub = {
    resolve: vi.fn(),
    cache: vi.fn(),
    invalidateForAssistant: vi.fn(),
  }

  it('does not run pipeline when the TG sender is linked to a different assistant (private DM redirect)', async () => {
    // Step 1 returns a link scoped to 'other_assistant' — our route should
    // reject it and fall through to Step 2. The module-level stub makes
    // resolveChannelUser return { user: owner_1, isIdentified: true }, but
    // we override it here to simulate a Tier-2 anonymous shadow, which is
    // what a real unlinked Telegram user produces in a private DM → redirect.
    const { resolveChannelUser } = await import('../../db/channel-user-store.js')
    vi.mocked(resolveChannelUser).mockResolvedValueOnce({
      user: { id: 'shadow_1' } as never,
      isIdentified: false,
    })

    const linkedAccountStore = makeLinkedAccountStore({
      userId: 'stranger',
      assistantId: 'other_assistant',
    })

    const app = createTestApp(
      '/webhook/telegram-byo',
      telegramByoRoutes({
        provider: {} as never,
        systemPrompt: '',
        tools: new Map(),
        memoryStore: {} as never,
        integrationStore: makeIntegrationStore() as never,
        linkedAccountStore: linkedAccountStore as never,
        channelUserStore: channelUserStoreStub as never,
        capabilityStore: {} as never,
        apiUrl: 'http://test',
      }),
    )

    await postUpdate(app, buildPrivateDm(42, 'hello'))
    await flushMicrotasks()
    await flushMicrotasks()

    expect(linkedAccountStore.findByProvider).toHaveBeenCalledWith('telegram', '42')
    expect(pipelineCalls).toEqual([])
  })

  it('accepts the owner even if their TG link is scoped to a different assistant they also own', async () => {
    // Owner exception: linked.userId === ownerId matches even though
    // linked.assistantId points at another assistant the owner also owns.
    const linkedAccountStore = makeLinkedAccountStore({
      userId: 'owner_1',
      assistantId: 'other_assistant_of_owner',
    })

    const app = createTestApp(
      '/webhook/telegram-byo',
      telegramByoRoutes({
        provider: {} as never,
        systemPrompt: '',
        tools: new Map(),
        memoryStore: {} as never,
        integrationStore: makeIntegrationStore() as never,
        linkedAccountStore: linkedAccountStore as never,
        channelUserStore: channelUserStoreStub as never,
        capabilityStore: {} as never,
        apiUrl: 'http://test',
      }),
    )

    await postUpdate(app, buildPrivateDm(42, 'hello'))
    await flushMicrotasks()
    await flushMicrotasks()

    expect(pipelineCalls).toHaveLength(1)
    expect(pipelineCalls[0].channelId).toBe('42')
  })

  it('serves a workspace member as their real identity even when their TG link is scoped to another assistant', async () => {
    // Regression — incident 2026-06-02 ("the bot keeps saying there are no
    // tasks"). A workspace-owned assistant has `owner_user_id` NULL, so its
    // admin/member is NOT the billing-party owner, and their verified TG link
    // (made against a *different* assistant) does not match `=== ownerId`.
    // Before the fix they were dropped to an anonymous channel shadow that is
    // an `assistant_members` row but not a `workspace_members` row, so the
    // `tasks_workspace_member` RLS policy blanked every task. They must be
    // served as their real account because they ARE a member of this
    // assistant's workspace.
    const users = await import('../../db/users.js')
    vi.mocked(users.findAssistantById).mockResolvedValueOnce({
      id: 'assistant_1',
      name: 'Test Assistant',
      ownerUserId: 'owner_1',
      workspaceId: 'ws_1',
      defaultModelAlias: 'gemini-flash',
      systemPrompt: null,
    } as never)
    vi.mocked(users.findUserById).mockResolvedValueOnce({
      id: 'member_user',
      plan: 'free',
      timezone: 'UTC',
    } as never)
    teamRoleResponse = 'admin' // member_user is a workspace admin of ws_1

    const linkedAccountStore = makeLinkedAccountStore({
      userId: 'member_user',
      assistantId: 'other_assistant', // link routes elsewhere — not this bot
    })

    const app = createTestApp(
      '/webhook/telegram-byo',
      telegramByoRoutes({
        provider: {} as never,
        systemPrompt: '',
        tools: new Map(),
        memoryStore: {} as never,
        integrationStore: makeIntegrationStore() as never,
        linkedAccountStore: linkedAccountStore as never,
        channelUserStore: channelUserStoreStub as never,
        capabilityStore: {} as never,
        apiUrl: 'http://test',
      }),
    )

    await postUpdate(app, buildPrivateDm(42, 'what are all the tasks?'))
    await flushMicrotasks()
    await flushMicrotasks()

    // Membership was checked for the linked user against this workspace, and
    // the turn ran as that real member — not redirected, not a shadow.
    expect(teamRoleCalls).toContainEqual({ userId: 'member_user', workspaceId: 'ws_1' })
    expect(pipelineCalls).toHaveLength(1)
    expect(pipelineCalls[0].userId).toBe('member_user')
  })
})

describe('[COMP:api/telegram-byo-route] allowlisted Telegram guests', () => {
  function buildPrivateDm(
    fromId: number,
    text: string,
    username?: string,
  ): Record<string, unknown> {
    return {
      update_id: fromId * 10,
      message: {
        message_id: fromId,
        from: {
          id: fromId,
          first_name: 'Guest',
          ...(username ? { username } : {}),
        },
        chat: { id: fromId, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text,
      },
    }
  }

  function buildGroupMessage(
    fromId: number,
    text: string,
    username?: string,
  ): Record<string, unknown> {
    return {
      update_id: fromId * 10,
      message: {
        message_id: fromId,
        from: {
          id: fromId,
          first_name: 'Guest',
          ...(username ? { username } : {}),
        },
        chat: { id: -1001234567890, type: 'supergroup' },
        date: Math.floor(Date.now() / 1000),
        text: `@testbot ${text}`,
        entities: [{ type: 'mention', offset: 0, length: 8 }],
      },
    }
  }

  function makeLinkedAccountStore(
    row: { userId: string; assistantId: string | null } | null,
  ) {
    return {
      findByProvider: vi.fn(async () => row
        ? {
            id: 'la_guest',
            userId: row.userId,
            assistantId: row.assistantId,
            provider: 'telegram',
            providerId: '42',
            providerMetadata: null,
            linkedAt: new Date(),
          }
        : null),
      upsert: vi.fn(),
      findByAssistant: vi.fn(),
      listForUser: vi.fn(),
      deleteForUser: vi.fn(),
    }
  }

  const channelUserStoreStub = {
    resolve: vi.fn(),
    cache: vi.fn(),
    invalidateForAssistant: vi.fn(),
  }

  function makeGuestApp(
    allowedUserIds: string[],
    linked: { userId: string; assistantId: string | null } | null = null,
    allowGuestConnectorTools = false,
    userAccessMode: 'allowlist' | 'allow_all' = 'allowlist',
    allowTrustedGuestFullAccess = false,
    pinTrustedUsername = true,
  ) {
    return createTestApp(
      '/webhook/telegram-byo',
      telegramByoRoutes({
        provider: {} as never,
        systemPrompt: '',
        tools: new Map(),
        memoryStore: {} as never,
        integrationStore: makeIntegrationStore({
          requireMention: true,
          userAccessMode,
          allowedUserIds,
          allowGuestConnectorTools,
          allowTrustedGuestFullAccess,
        }, pinTrustedUsername) as never,
        linkedAccountStore: makeLinkedAccountStore(linked) as never,
        channelUserStore: channelUserStoreStub as never,
        capabilityStore: {} as never,
        apiUrl: 'http://test',
      }),
    )
  }

  it('treats a case-insensitive @handle match as an isolated guest grant', async () => {
    const { resolveChannelUser } = await import('../../db/channel-user-store.js')
    vi.mocked(resolveChannelUser).mockResolvedValueOnce({
      user: { id: 'shadow_friend' } as never,
      isIdentified: false,
    })

    const app = makeGuestApp(['@FrIeNd'])
    await postUpdate(app, buildPrivateDm(42, 'hello', 'friend'))
    await flushMicrotasks()
    await flushMicrotasks()

    expect(pipelineCalls).toHaveLength(1)
    expect(pipelineCalls[0]).toMatchObject({
      channelId: '42',
      userId: 'shadow_friend',
      isIdentified: false,
      externalGuest: true,
      externalGuestConnectorTools: false,
      isGroupChat: false,
    })
    expect(adapterSendCalls.at(-1)?.text).toBe('ok')
  })

  it('accepts a stable numeric Telegram id when the sender has no username', async () => {
    const { resolveChannelUser } = await import('../../db/channel-user-store.js')
    vi.mocked(resolveChannelUser).mockResolvedValueOnce({
      user: { id: 'shadow_numeric' } as never,
      isIdentified: false,
    })

    const app = makeGuestApp(['42'])
    await postUpdate(app, buildPrivateDm(42, 'hello'))
    await flushMicrotasks()
    await flushMicrotasks()

    expect(pipelineCalls).toHaveLength(1)
    expect(pipelineCalls[0]).toMatchObject({
      userId: 'shadow_numeric',
      externalGuest: true,
    })
  })

  it('forwards the explicit connector opt-in without changing guest identity', async () => {
    const { resolveChannelUser } = await import('../../db/channel-user-store.js')
    vi.mocked(resolveChannelUser).mockResolvedValueOnce({
      user: { id: 'shadow_with_tools' } as never,
      isIdentified: false,
    })

    const app = makeGuestApp(['@friend'], null, true)
    await postUpdate(app, buildPrivateDm(42, 'check my calendar', 'friend'))
    await flushMicrotasks()
    await flushMicrotasks()

    expect(pipelineCalls).toHaveLength(1)
    expect(pipelineCalls[0]).toMatchObject({
      userId: 'shadow_with_tools',
      externalGuest: true,
      externalGuestConnectorTools: true,
    })
  })

  it('extends the isolated connector opt-in to an explicitly allowlisted group guest', async () => {
    const { resolveChannelUser } = await import('../../db/channel-user-store.js')
    vi.mocked(resolveChannelUser).mockResolvedValueOnce({
      user: { id: 'shadow_group_guest' } as never,
      isIdentified: false,
    })

    const app = makeGuestApp(['@friend'], null, true)
    await postUpdate(app, buildGroupMessage(42, 'check the calendar', 'friend'))
    await flushMicrotasks()
    await flushMicrotasks()

    expect(pipelineCalls).toHaveLength(1)
    expect(pipelineCalls[0]).toMatchObject({
      channelId: '-1001234567890',
      userId: 'shadow_group_guest',
      isIdentified: false,
      isGroupChat: true,
      externalGuest: true,
      externalGuestConnectorTools: true,
    })
  })

  it('provisions a numeric allowlist match as a full workspace member when explicitly enabled', async () => {
    const {
      ensureTrustedChannelWorkspaceMembership,
      resolveChannelUser,
    } = await import('../../db/channel-user-store.js')
    const { findAssistantById } = await import('../../db/users.js')
    vi.mocked(ensureTrustedChannelWorkspaceMembership).mockClear()
    vi.mocked(findAssistantById).mockResolvedValueOnce({
      id: 'assistant_1',
      name: 'Test Assistant',
      ownerUserId: 'owner_1',
      workspaceId: 'workspace_1',
      defaultModelAlias: 'gemini-flash',
      systemPrompt: null,
      clearance: 'confidential',
      kind: 'standard',
    } as never)
    vi.mocked(resolveChannelUser).mockResolvedValueOnce({
      user: { id: 'shadow_trusted_member' } as never,
      isIdentified: false,
    })

    const app = makeGuestApp(['42'], null, false, 'allowlist', true)
    await postUpdate(app, buildPrivateDm(42, 'search the web'))
    await flushMicrotasks()
    await flushMicrotasks()

    expect(ensureTrustedChannelWorkspaceMembership).toHaveBeenCalledWith({
      integrationId: 'integ_1',
      workspaceId: 'workspace_1',
      userId: 'shadow_trusted_member',
      provider: 'telegram',
      providerUserId: '42',
    })
    expect(pipelineCalls).toHaveLength(1)
    expect(pipelineCalls[0]).toMatchObject({
      userId: 'shadow_trusted_member',
      isIdentified: true,
      externalGuest: false,
      externalGuestConnectorTools: false,
    })
  })

  it('pins a username allowlist match and provisions the sender as a full workspace member', async () => {
    const {
      ensureTrustedChannelWorkspaceMembership,
      resolveChannelUser,
    } = await import('../../db/channel-user-store.js')
    const { findAssistantById } = await import('../../db/users.js')
    vi.mocked(ensureTrustedChannelWorkspaceMembership).mockClear()
    vi.mocked(findAssistantById).mockResolvedValueOnce({
      id: 'assistant_1',
      name: 'Test Assistant',
      ownerUserId: 'owner_1',
      workspaceId: 'workspace_1',
      defaultModelAlias: 'gemini-flash',
      systemPrompt: null,
      clearance: 'confidential',
      kind: 'standard',
    } as never)
    vi.mocked(resolveChannelUser).mockResolvedValueOnce({
      user: { id: 'shadow_handle_guest' } as never,
      isIdentified: false,
    })

    const app = makeGuestApp(['@friend'], null, false, 'allowlist', true)
    await postUpdate(app, buildPrivateDm(42, 'hello', 'friend'))
    await flushMicrotasks()
    await flushMicrotasks()

    expect(ensureTrustedChannelWorkspaceMembership).toHaveBeenCalledWith({
      integrationId: 'integ_1',
      workspaceId: 'workspace_1',
      userId: 'shadow_handle_guest',
      provider: 'telegram',
      providerUserId: '42',
    })
    expect(pipelineCalls[0]).toMatchObject({
      userId: 'shadow_handle_guest',
      isIdentified: true,
      externalGuest: false,
    })
  })

  it('fails closed when a username grant changes before it can be pinned', async () => {
    const {
      ensureTrustedChannelWorkspaceMembership,
      resolveChannelUser,
    } = await import('../../db/channel-user-store.js')
    const { findAssistantById } = await import('../../db/users.js')
    vi.mocked(ensureTrustedChannelWorkspaceMembership).mockClear()
    vi.mocked(findAssistantById).mockResolvedValueOnce({
      id: 'assistant_1',
      name: 'Test Assistant',
      ownerUserId: 'owner_1',
      workspaceId: 'workspace_1',
      defaultModelAlias: 'gemini-flash',
      systemPrompt: null,
      clearance: 'confidential',
      kind: 'standard',
    } as never)
    vi.mocked(resolveChannelUser).mockResolvedValueOnce({
      user: { id: 'shadow_stale_handle' } as never,
      isIdentified: false,
    })

    const app = makeGuestApp(['@friend'], null, false, 'allowlist', true, false)
    await postUpdate(app, buildPrivateDm(42, 'hello', 'friend'))
    await flushMicrotasks()
    await flushMicrotasks()

    expect(ensureTrustedChannelWorkspaceMembership).not.toHaveBeenCalled()
    expect(pipelineCalls).toEqual([])
    expect(adapterSendCalls.at(-1)?.text).toContain('Trusted access could not be activated')
  })

  it('fails closed when trusted membership cannot be provisioned', async () => {
    const {
      ensureTrustedChannelWorkspaceMembership,
      resolveChannelUser,
    } = await import('../../db/channel-user-store.js')
    const { findAssistantById } = await import('../../db/users.js')
    vi.mocked(ensureTrustedChannelWorkspaceMembership).mockClear()
    vi.mocked(ensureTrustedChannelWorkspaceMembership).mockRejectedValueOnce(new Error('db unavailable'))
    vi.mocked(findAssistantById).mockResolvedValueOnce({
      id: 'assistant_1',
      name: 'Test Assistant',
      ownerUserId: 'owner_1',
      workspaceId: 'workspace_1',
      defaultModelAlias: 'gemini-flash',
      systemPrompt: null,
      clearance: 'confidential',
      kind: 'standard',
    } as never)
    vi.mocked(resolveChannelUser).mockResolvedValueOnce({
      user: { id: 'shadow_failed_grant' } as never,
      isIdentified: false,
    })

    const app = makeGuestApp(['42'], null, false, 'allowlist', true)
    await postUpdate(app, buildPrivateDm(42, 'search the web'))
    await flushMicrotasks()
    await flushMicrotasks()

    expect(pipelineCalls).toEqual([])
    expect(adapterSendCalls.at(-1)?.text).toContain('Trusted access could not be activated')
  })

  it('keeps an unlinked allow_all group sender isolated without inheriting a stale tool opt-in', async () => {
    const { resolveChannelUser } = await import('../../db/channel-user-store.js')
    vi.mocked(resolveChannelUser).mockResolvedValueOnce({
      user: { id: 'shadow_unlisted_group_sender' } as never,
      isIdentified: false,
    })

    const app = makeGuestApp([], null, true, 'allow_all')
    await postUpdate(app, buildGroupMessage(42, 'hello', 'visitor'))
    await flushMicrotasks()
    await flushMicrotasks()

    expect(pipelineCalls).toHaveLength(1)
    expect(pipelineCalls[0]).toMatchObject({
      userId: 'shadow_unlisted_group_sender',
      isGroupChat: true,
      externalGuest: true,
      externalGuestConnectorTools: false,
    })
  })

  it('silently ignores an unlisted stranger, including when the list is empty', async () => {
    for (const allowedUserIds of [['@friend'], []]) {
      const app = makeGuestApp(allowedUserIds)
      await postUpdate(app, buildPrivateDm(42, 'hello', 'stranger'))
      await flushMicrotasks()
      await flushMicrotasks()

      expect(pipelineCalls).toEqual([])
      expect(adapterSendCalls).toEqual([])
    }
  })

  it('keeps the verified owner implicitly allowed when the list is empty', async () => {
    const app = makeGuestApp([], {
      userId: 'owner_1',
      assistantId: 'other_assistant_owned_by_same_user',
    })

    await postUpdate(app, buildPrivateDm(42, 'owner message', 'ownerhandle'))
    await flushMicrotasks()
    await flushMicrotasks()

    expect(pipelineCalls).toHaveLength(1)
    expect(pipelineCalls[0]).toMatchObject({
      userId: 'owner_1',
      isIdentified: true,
      externalGuest: false,
    })
  })
})

describe('[COMP:api/telegram-byo-route] telegramLinkBindsHere', () => {
  const link = (userId: string, assistantId: string | null) => ({ userId, assistantId })

  it('does not bind when there is no link', async () => {
    expect(await telegramLinkBindsHere(null, 'a1', 'owner', 'ws1', async () => 'admin')).toBe(false)
    expect(await telegramLinkBindsHere(undefined, 'a1', 'owner', 'ws1', async () => 'admin')).toBe(false)
  })

  it('binds when the link routes to this exact assistant (no membership query)', async () => {
    const roleLookup = vi.fn(async () => null)
    expect(await telegramLinkBindsHere(link('u', 'a1'), 'a1', 'owner', 'ws1', roleLookup)).toBe(true)
    expect(roleLookup).not.toHaveBeenCalled()
  })

  it('binds when the linked user is the billing-party owner (no membership query)', async () => {
    const roleLookup = vi.fn(async () => null)
    expect(await telegramLinkBindsHere(link('owner', 'other'), 'a1', 'owner', 'ws1', roleLookup)).toBe(true)
    expect(roleLookup).not.toHaveBeenCalled()
  })

  it('binds a workspace member whose link is scoped elsewhere (the 2026-06-02 incident fix)', async () => {
    // Workspace admin who is NOT the billing-party owner and whose verified
    // link routes to a different assistant. Before the fix this returned
    // false → anonymous shadow → RLS blanked every workspace task.
    const roleLookup = vi.fn(async () => 'admin' as const)
    expect(await telegramLinkBindsHere(link('member', 'other'), 'a1', 'owner', 'ws1', roleLookup)).toBe(true)
    expect(roleLookup).toHaveBeenCalledWith('member', 'ws1')
  })

  it('binds for any workspace role, not just owner/admin', async () => {
    const roleLookup = vi.fn(async () => 'member' as const)
    expect(await telegramLinkBindsHere(link('m', 'other'), 'a1', 'owner', 'ws1', roleLookup)).toBe(true)
  })

  it('does NOT bind a cross-tenant stranger who is not a member of this workspace', async () => {
    const roleLookup = vi.fn(async () => null)
    expect(await telegramLinkBindsHere(link('stranger', 'other'), 'a1', 'owner', 'ws1', roleLookup)).toBe(false)
  })

  it('does NOT query membership when the assistant has no workspace', async () => {
    const roleLookup = vi.fn(async () => 'admin' as const)
    expect(await telegramLinkBindsHere(link('m', 'other'), 'a1', 'owner', null, roleLookup)).toBe(false)
    expect(roleLookup).not.toHaveBeenCalled()
  })
})

describe('[COMP:api/telegram-byo-route] group add-protection', () => {
  // `my_chat_member` update: bot added to a group by a user. Telegram reports
  // old.status='left' → new.status='member' (or 'administrator') along with
  // `from` = the user who performed the add.
  function buildGroupAdd(params: {
    adderTgId: number
    chatId?: number
    chatType?: 'group' | 'supergroup' | 'channel'
  }): Record<string, unknown> {
    return {
      update_id: params.adderTgId * 100,
      my_chat_member: {
        chat: {
          id: params.chatId ?? -1002000000001,
          type: params.chatType ?? 'supergroup',
          title: 'Test Group',
        },
        from: { id: params.adderTgId, first_name: 'Adder', username: `adder${params.adderTgId}` },
        date: Math.floor(Date.now() / 1000),
        old_chat_member: { status: 'left', user: { id: 999999, is_bot: true } },
        new_chat_member: { status: 'member', user: { id: 999999, is_bot: true } },
      },
    }
  }

  function makeLinkedAccountStore(row: { userId: string; assistantId: string | null } | null) {
    return {
      findByProvider: vi.fn(async () =>
        row
          ? {
              id: 'la_1',
              userId: row.userId,
              assistantId: row.assistantId,
              provider: 'telegram',
              providerId: '42',
              providerMetadata: null,
              linkedAt: new Date(),
            }
          : null,
      ),
      upsert: vi.fn(),
      findByAssistant: vi.fn(),
      listForUser: vi.fn(),
      deleteForUser: vi.fn(),
    }
  }

  it('leaves the group when the adder has no linked Use Brian account', async () => {
    const linkedAccountStore = makeLinkedAccountStore(null)

    const app = createTestApp(
      '/webhook/telegram-byo',
      telegramByoRoutes({
        provider: {} as never,
        systemPrompt: '',
        tools: new Map(),
        memoryStore: {} as never,
        integrationStore: makeIntegrationStore() as never,
        linkedAccountStore: linkedAccountStore as never,
        capabilityStore: {} as never,
        apiUrl: 'http://test',
      }),
    )

    await postUpdate(app, buildGroupAdd({ adderTgId: 42, chatId: -1002000000001 }))
    await flushMicrotasks()
    await flushMicrotasks()

    expect(leaveChatCalls).toEqual(['-1002000000001'])
  })

  it('stays when the adder is the assistant owner', async () => {
    // Linked row pins adder to owner_1 — the assistant owner.
    const linkedAccountStore = makeLinkedAccountStore({
      userId: 'owner_1',
      assistantId: 'assistant_1',
    })

    const app = createTestApp(
      '/webhook/telegram-byo',
      telegramByoRoutes({
        provider: {} as never,
        systemPrompt: '',
        tools: new Map(),
        memoryStore: {} as never,
        integrationStore: makeIntegrationStore() as never,
        linkedAccountStore: linkedAccountStore as never,
        capabilityStore: {} as never,
        apiUrl: 'http://test',
      }),
    )

    await postUpdate(app, buildGroupAdd({ adderTgId: 42 }))
    await flushMicrotasks()
    await flushMicrotasks()

    expect(leaveChatCalls).toEqual([])
  })

  it('leaves the group when a non-owner linked user adds a personal bot (no team)', async () => {
    // Linked row resolves the adder to a stranger. Assistant has workspaceId=null,
    // so team-admin check is skipped and the route leaves.
    const linkedAccountStore = makeLinkedAccountStore({
      userId: 'stranger',
      assistantId: 'assistant_1',
    })

    const app = createTestApp(
      '/webhook/telegram-byo',
      telegramByoRoutes({
        provider: {} as never,
        systemPrompt: '',
        tools: new Map(),
        memoryStore: {} as never,
        integrationStore: makeIntegrationStore() as never,
        linkedAccountStore: linkedAccountStore as never,
        capabilityStore: {} as never,
        apiUrl: 'http://test',
      }),
    )

    await postUpdate(app, buildGroupAdd({ adderTgId: 42, chatId: -1002000000002 }))
    await flushMicrotasks()
    await flushMicrotasks()

    expect(leaveChatCalls).toEqual(['-1002000000002'])
    expect(teamRoleCalls).toEqual([]) // never consulted — personal bot
  })

  it('stays when the adder is a team admin on a team-scoped assistant', async () => {
    // Override findAssistantById to attach a workspaceId for this test only.
    const { findAssistantById } = await import('../../db/users.js')
    vi.mocked(findAssistantById).mockResolvedValueOnce({
      id: 'assistant_1',
      name: 'Team Bot',
      ownerUserId: 'owner_1',
      workspaceId: 'team_1',
      defaultModelAlias: 'gemini-flash',
      systemPrompt: null,
    } as never)

    teamRoleResponse = 'admin'

    const linkedAccountStore = makeLinkedAccountStore({
      userId: 'team_admin_user',
      assistantId: 'assistant_1',
    })

    const app = createTestApp(
      '/webhook/telegram-byo',
      telegramByoRoutes({
        provider: {} as never,
        systemPrompt: '',
        tools: new Map(),
        memoryStore: {} as never,
        integrationStore: makeIntegrationStore() as never,
        linkedAccountStore: linkedAccountStore as never,
        capabilityStore: {} as never,
        apiUrl: 'http://test',
      }),
    )

    await postUpdate(app, buildGroupAdd({ adderTgId: 42 }))
    await flushMicrotasks()
    await flushMicrotasks()

    expect(leaveChatCalls).toEqual([])
    expect(teamRoleCalls).toEqual([{ userId: 'team_admin_user', workspaceId: 'team_1' }])
  })

  it('leaves when the adder is only a team member (not admin or owner)', async () => {
    const { findAssistantById } = await import('../../db/users.js')
    vi.mocked(findAssistantById).mockResolvedValueOnce({
      id: 'assistant_1',
      name: 'Team Bot',
      ownerUserId: 'owner_1',
      workspaceId: 'team_1',
      defaultModelAlias: 'gemini-flash',
      systemPrompt: null,
    } as never)

    teamRoleResponse = 'member' // plain member — not allowed to add

    const linkedAccountStore = makeLinkedAccountStore({
      userId: 'team_plain_member',
      assistantId: 'assistant_1',
    })

    const app = createTestApp(
      '/webhook/telegram-byo',
      telegramByoRoutes({
        provider: {} as never,
        systemPrompt: '',
        tools: new Map(),
        memoryStore: {} as never,
        integrationStore: makeIntegrationStore() as never,
        linkedAccountStore: linkedAccountStore as never,
        capabilityStore: {} as never,
        apiUrl: 'http://test',
      }),
    )

    await postUpdate(app, buildGroupAdd({ adderTgId: 42, chatId: -1002000000003 }))
    await flushMicrotasks()
    await flushMicrotasks()

    expect(leaveChatCalls).toEqual(['-1002000000003'])
  })

  it('does nothing for a private-chat membership change (not a group add)', async () => {
    const linkedAccountStore = makeLinkedAccountStore(null)

    const app = createTestApp(
      '/webhook/telegram-byo',
      telegramByoRoutes({
        provider: {} as never,
        systemPrompt: '',
        tools: new Map(),
        memoryStore: {} as never,
        integrationStore: makeIntegrationStore() as never,
        linkedAccountStore: linkedAccountStore as never,
        capabilityStore: {} as never,
        apiUrl: 'http://test',
      }),
    )

    // Private chat /start — old=left, new=member, chat.type=private.
    // We don't auto-leave DMs; those are the normal redirect path.
    await request(app)
      .post('/webhook/telegram-byo/channel_1')
      .set('x-telegram-bot-api-secret-token', 'webhook-secret')
      .send({
        update_id: 4242,
        my_chat_member: {
          chat: { id: 42, type: 'private' },
          from: { id: 42, first_name: 'Person' },
          date: Math.floor(Date.now() / 1000),
          old_chat_member: { status: 'left', user: { id: 999999, is_bot: true } },
          new_chat_member: { status: 'member', user: { id: 999999, is_bot: true } },
        },
      })
    await flushMicrotasks()
    await flushMicrotasks()

    expect(leaveChatCalls).toEqual([])
  })

  it('does nothing when the status change is not a fresh join', async () => {
    // old=member, new=administrator — privileges changed but bot was already
    // in the chat. We only act on fresh adds.
    const linkedAccountStore = makeLinkedAccountStore(null)

    const app = createTestApp(
      '/webhook/telegram-byo',
      telegramByoRoutes({
        provider: {} as never,
        systemPrompt: '',
        tools: new Map(),
        memoryStore: {} as never,
        integrationStore: makeIntegrationStore() as never,
        linkedAccountStore: linkedAccountStore as never,
        capabilityStore: {} as never,
        apiUrl: 'http://test',
      }),
    )

    await request(app)
      .post('/webhook/telegram-byo/channel_1')
      .set('x-telegram-bot-api-secret-token', 'webhook-secret')
      .send({
        update_id: 5050,
        my_chat_member: {
          chat: { id: -1002000000009, type: 'supergroup' },
          from: { id: 42, first_name: 'Person' },
          date: Math.floor(Date.now() / 1000),
          old_chat_member: { status: 'member', user: { id: 999999, is_bot: true } },
          new_chat_member: { status: 'administrator', user: { id: 999999, is_bot: true } },
        },
      })
    await flushMicrotasks()
    await flushMicrotasks()

    expect(leaveChatCalls).toEqual([])
  })
})

describe('[COMP:api/telegram-byo-route] persistSeenChat', () => {
  // Unit tests for the merge logic — no webhook involved. We drive a fake
  // store whose `mergeConfigSystem` just runs the mutator and captures the
  // produced config, so we can assert the dirty/skip behaviour.

  function makeFakeStore(initial: Record<string, unknown> = {}) {
    let current: Record<string, unknown> = { ...initial }
    const writes: Array<Record<string, unknown>> = []
    return {
      store: {
        mergeConfigSystem: vi.fn(async (_id: string, mutate: (c: Record<string, unknown>) => Record<string, unknown>) => {
          const next = mutate(current)
          if (next !== current) writes.push(next)
          current = next
        }),
      },
      getWrites: () => writes,
      getCurrent: () => current,
    }
  }

  it('adds a brand-new chat with no topic', async () => {
    const { store, getWrites } = makeFakeStore()
    await persistSeenChat(store as never, 'integ_1', {
      chatId: '-100',
      chatTitle: 'Eng',
      chatType: 'supergroup',
      isForum: false,
      topicId: null,
      topicName: null,
    })
    const writes = getWrites()
    expect(writes).toHaveLength(1)
    const seenChats = writes[0].seenChats as Array<Record<string, unknown>>
    expect(seenChats).toHaveLength(1)
    expect(seenChats[0]).toMatchObject({
      chatId: '-100',
      chatTitle: 'Eng',
      isForum: false,
      topics: [],
    })
  })

  it('adds a new topic to an existing chat', async () => {
    const { store, getWrites } = makeFakeStore({
      seenChats: [
        {
          chatId: '-100',
          chatTitle: 'Eng',
          isForum: true,
          topics: [],
          lastSeenAt: new Date().toISOString(),
        },
      ],
    })
    await persistSeenChat(store as never, 'integ_1', {
      chatId: '-100',
      chatTitle: 'Eng',
      chatType: 'supergroup',
      isForum: true,
      topicId: 7,
      topicName: 'standups',
    })
    const writes = getWrites()
    expect(writes).toHaveLength(1)
    const chat = (writes[0].seenChats as Array<Record<string, unknown>>)[0]
    expect(chat.topics).toEqual([
      expect.objectContaining({ topicId: 7, name: 'standups' }),
    ])
  })

  it('skips the write when chat is fresh, no new topic, no name change', async () => {
    const now = new Date().toISOString()
    const { store, getWrites } = makeFakeStore({
      seenChats: [
        {
          chatId: '-100',
          chatTitle: 'Eng',
          isForum: true,
          topics: [
            { topicId: 7, name: 'standups', lastSeenAt: now },
          ],
          lastSeenAt: now,
        },
      ],
    })
    await persistSeenChat(store as never, 'integ_1', {
      chatId: '-100',
      chatTitle: 'Eng',
      chatType: 'supergroup',
      isForum: true,
      topicId: 7,
      topicName: null,
    })
    expect(getWrites()).toEqual([])
  })

  it('upgrades a topic name when one becomes available', async () => {
    const now = new Date().toISOString()
    const { store, getWrites } = makeFakeStore({
      seenChats: [
        {
          chatId: '-100',
          chatTitle: 'Eng',
          isForum: true,
          topics: [
            { topicId: 7, name: null, lastSeenAt: now },
          ],
          lastSeenAt: now,
        },
      ],
    })
    await persistSeenChat(store as never, 'integ_1', {
      chatId: '-100',
      chatTitle: 'Eng',
      chatType: 'supergroup',
      isForum: true,
      topicId: 7,
      topicName: 'standups',
    })
    const writes = getWrites()
    expect(writes).toHaveLength(1)
    const chat = (writes[0].seenChats as Array<Record<string, unknown>>)[0]
    expect(chat.topics).toEqual([
      expect.objectContaining({ topicId: 7, name: 'standups' }),
    ])
  })

  it('refreshes a stale chat entry (>1h old)', async () => {
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    const { store, getWrites } = makeFakeStore({
      seenChats: [
        {
          chatId: '-100',
          chatTitle: 'Eng',
          isForum: false,
          topics: [],
          lastSeenAt: longAgo,
        },
      ],
    })
    await persistSeenChat(store as never, 'integ_1', {
      chatId: '-100',
      chatTitle: 'Eng',
      chatType: 'supergroup',
      isForum: false,
      topicId: null,
      topicName: null,
    })
    expect(getWrites()).toHaveLength(1)
  })
})

// ──────────────────────────────────────────────────────────────────
// Legacy URL self-heal — channel-integrations split migration
// ──────────────────────────────────────────────────────────────────

describe('[COMP:api/telegram-byo-route] legacy URL self-heal', () => {
  // The webhook URL slug is the workspace `channels` id since migration 158.
  // Bots set up before the split still have an assistant id baked into the
  // Telegram-side webhook URL. The route must:
  //   1. Fall back from `getByChannelForWebhook` to
  //      `getCredentialsForAssistantSystem` when the URL slug doesn't match
  //      a channel row.
  //   2. Process the message normally (the integration is the same row, just
  //      reached via a different lookup).
  //   3. Re-issue `setWebhook` with the new channels-id URL fire-and-forget
  //      so the bot self-heals on the next inbound delivery.
  // See docs/architecture/channels/adapter-pattern.md.

  function makeLegacyIntegrationStore() {
    return {
      // Channel-id lookup misses — this is the legacy case.
      getByChannelForWebhook: vi.fn(async () => null),
      // Assistant-id lookup hits, returning an integration whose canonical
      // channelId is the new channels.id we want Telegram to start using.
      getCredentialsForAssistantSystem: vi.fn(async () => ({
        id: 'integ_legacy',
        channelId: 'channel_1',
        channelType: 'telegram',
        botUsername: 'testbot',
        botUserId: '999999',
        config: { requireMention: false },
        credentials: {
          bot_token: 'fake-token',
          webhook_secret: 'webhook-secret',
        },
      })),
      touchLastEventAt: vi.fn(async () => undefined),
      setBotUsername: vi.fn(async () => undefined),
      mergeConfigSystem: vi.fn(async () => undefined),
    }
  }

  function buildDmUpdate(text: string): Record<string, unknown> {
    return {
      update_id: 9001,
      message: {
        message_id: 1,
        from: { id: 42, first_name: 'Hinson', username: 'hinson' },
        chat: { id: 42, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text,
      },
    }
  }

  it('processes the message via the assistant-id fallback and re-registers the webhook URL', async () => {
    const store = makeLegacyIntegrationStore()
    const app = createTestApp(
      '/webhook/telegram-byo',
      telegramByoRoutes({
        provider: {} as never,
        systemPrompt: '',
        tools: new Map(),
        memoryStore: {} as never,
        integrationStore: store as never,
        capabilityStore: {} as never,
        apiUrl: 'http://test',
      }),
    )

    // POST with a legacy assistant-id URL — the slug is the assistant id,
    // not the canonical channels.id.
    await request(app)
      .post('/webhook/telegram-byo/legacy-assistant-id')
      .set('x-telegram-bot-api-secret-token', 'webhook-secret')
      .send(buildDmUpdate('GM Bro'))
    await flushMicrotasks()
    await flushMicrotasks()

    // Both lookups consulted.
    expect(store.getByChannelForWebhook).toHaveBeenCalledWith('legacy-assistant-id', 'telegram')
    expect(store.getCredentialsForAssistantSystem).toHaveBeenCalledWith('legacy-assistant-id', 'telegram')

    // setWebhook re-issued with the new channels-id URL.
    expect(setWebhookCalls).toEqual([
      { url: 'http://test/webhook/telegram/channel_1', secret: 'webhook-secret' },
    ])

    // The message still flowed through — no user-visible regression.
    expect(pipelineCalls).toHaveLength(1)
    expect(pipelineCalls[0]).toMatchObject({ channelId: '42', isGroupChat: false })
  })

  it('returns 404 when neither lookup resolves an integration', async () => {
    const store = {
      getByChannelForWebhook: vi.fn(async () => null),
      getCredentialsForAssistantSystem: vi.fn(async () => null),
      touchLastEventAt: vi.fn(async () => undefined),
      setBotUsername: vi.fn(async () => undefined),
      mergeConfigSystem: vi.fn(async () => undefined),
    }
    const app = createTestApp(
      '/webhook/telegram-byo',
      telegramByoRoutes({
        provider: {} as never,
        systemPrompt: '',
        tools: new Map(),
        memoryStore: {} as never,
        integrationStore: store as never,
        capabilityStore: {} as never,
        apiUrl: 'http://test',
      }),
    )

    const res = await request(app)
      .post('/webhook/telegram-byo/unknown')
      .set('x-telegram-bot-api-secret-token', 'webhook-secret')
      .send(buildDmUpdate('hi'))

    expect(res.status).toBe(404)
    expect(setWebhookCalls).toEqual([])
    expect(pipelineCalls).toEqual([])
  })

  it('does not re-register the webhook on the normal channels-id path', async () => {
    const app = createTestApp(
      '/webhook/telegram-byo',
      telegramByoRoutes({
        provider: {} as never,
        systemPrompt: '',
        tools: new Map(),
        memoryStore: {} as never,
        integrationStore: makeIntegrationStore() as never,
        capabilityStore: {} as never,
        apiUrl: 'http://test',
      }),
    )

    await request(app)
      .post('/webhook/telegram-byo/channel_1')
      .set('x-telegram-bot-api-secret-token', 'webhook-secret')
      .send(buildDmUpdate('hi'))
    await flushMicrotasks()
    await flushMicrotasks()

    expect(setWebhookCalls).toEqual([])
    expect(pipelineCalls).toHaveLength(1)
  })
})

describe('[COMP:api/telegram-byo-route] outbound documents', () => {
  it('threads pipeline documents through sendResponse to the adapter send', async () => {
    // Regression: this hook used to declare only `(text)`, so the documents
    // the pipeline resolved from sendFile vanished at this seam — adapter
    // capable, pipeline correct, tool successful, file never delivered
    // (the 2026-07-30 "sent your PDF" that never arrived).
    pipelineDocuments = [
      { filename: 'boarding-pass.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-stub') },
    ]
    const app = createTestApp(
      '/webhook/telegram-byo',
      telegramByoRoutes({
        provider: {} as never,
        systemPrompt: '',
        tools: new Map(),
        memoryStore: {} as never,
        integrationStore: makeIntegrationStore() as never,
        capabilityStore: {} as never,
        apiUrl: 'http://test',
      }),
    )

    await postUpdate(app, {
      update_id: 7001,
      message: {
        message_id: 700,
        from: { id: 42, first_name: 'Hinson', username: 'hinson' },
        chat: { id: 42, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: 'send me the pdf',
      },
    })
    await flushMicrotasks()
    await flushMicrotasks()

    expect(pipelineCalls).toHaveLength(1)
    const send = adapterSendCalls.at(-1)
    expect(send?.text).toBe('ok')
    expect(send?.documents?.map((d) => d.filename)).toEqual(['boarding-pass.pdf'])
  })
})

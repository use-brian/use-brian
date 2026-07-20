import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

// Mock channels
vi.mock('@use-brian/channels', () => {
  const sendMessage = vi.fn().mockResolvedValue('msg_1')
  const sendStatus = vi.fn().mockResolvedValue('status_1')
  const editMessage = vi.fn().mockResolvedValue(undefined)
  const handleEvent = vi.fn()
  return {
    createSlackAdapter: vi.fn(() => ({
      sendMessage,
      sendStatus,
      editMessage,
      handleEvent,
    })),
    verifySlackSignature: vi.fn(),
    __mocks: { sendMessage, sendStatus, editMessage, handleEvent },
  }
})

// Mock DB modules
vi.mock('../../db/users.js', () => ({
  findAssistantById: vi.fn(),
  findUserById: vi.fn(),
}))
// Webhook routing resolution — channel-keyed since the channel_integrations
// split. The route resolves the answering assistant via the channel.
vi.mock('../../db/channels-store.js', () => ({
  getChannelForWebhook: vi.fn(),
  resolveAssistantForSurface: vi.fn(),
  resolveRoutingForSurface: vi.fn(),
}))
// billingPartyForAssistant queries `teams` post-089; stub in route tests.
vi.mock('../../billing-party.js', () => ({
  billingPartyForAssistant: vi.fn(async (a: { ownerUserId: string | null; workspaceId: string | null }) => {
    return a.ownerUserId ?? `team-owner-of-${a.workspaceId}`
  }),
}))
vi.mock('../../db/sessions.js', () => ({
  findOrCreateSession: vi.fn(),
  addSessionMessage: vi.fn(),
  toStampedMessages: vi.fn((msgs: Array<{ role: string; content: unknown }>) => msgs.map((m) => ({ role: m.role, content: m.content }))),
  getSessionMessages: vi.fn(),
  updateSessionStatus: vi.fn(),
  getPreferredChannel: vi.fn(),
}))

// Mock core
vi.mock('@use-brian/core', async () => {
  const actual = await vi.importActual<typeof import('@use-brian/core')>('@use-brian/core')
  return {
    ...actual,
    queryLoop: vi.fn(),
    buildMemoryContext: vi.fn(() => ''),
    createMemoryTools: vi.fn(() => ({
      saveMemory: { name: 'saveMemory' },
      getMemory: { name: 'getMemory' },
    })),
    extractPatterns: vi.fn(() => []),
    ensureToolResultPairing: vi.fn((msgs: unknown[]) => msgs),
    synthesizeMissingToolResults: vi.fn(() => []),
  }
})
// The live budget gate (monthly credit cap) lives in billing/credit-gate.js;
// mock it so the gate is deterministic and never touches the DB.
vi.mock('../../billing/credit-gate.js', () => ({
  checkCreditBudget: vi.fn(async () => ({ status: 'ok', creditsUsed: 0, creditCap: 2000, resetsAt: null })),
  getPeriodCredits: vi.fn(async () => 0),
  creditGateStatus: vi.fn(() => 'ok'),
}))

import { slackRoutes } from '../slack.js'
import { verifySlackSignature } from '@use-brian/channels'
import { getChannelForWebhook, resolveAssistantForSurface, resolveRoutingForSurface } from '../../db/channels-store.js'

const mockVerifySignature = vi.mocked(verifySlackSignature)
const mockGetChannelForWebhook = vi.mocked(getChannelForWebhook)
const mockResolveAssistantForSurface = vi.mocked(resolveAssistantForSurface)
const mockResolveRoutingForSurface = vi.mocked(resolveRoutingForSurface)

describe('[COMP:api/slack-route] Slack webhook route', () => {
  const integrationStore = {
    upsert: vi.fn(),
    getByChannelForWebhook: vi.fn(),
    getCredentialsForAssistantSystem: vi.fn(),
    listForWorkspace: vi.fn(),
    deleteForUser: vi.fn(),
    touchLastEventAt: vi.fn().mockResolvedValue(undefined),
  }

  const memoryStore = {
    create: vi.fn().mockResolvedValue({ id: 'm_1' }),
    getSoul: vi.fn().mockResolvedValue(null),
    getIdentity: vi.fn().mockResolvedValue([]),
    getIndex: vi.fn().mockResolvedValue([]),
    getIndexRanked: vi.fn().mockResolvedValue({ rows: [], totalCount: 0 }),
  }

  const options = {
    provider: { stream: vi.fn() } as never,
    systemPrompt: 'Test',
    tools: new Map(),
    memoryStore: memoryStore as never,
    taskStore: { create: vi.fn(), getById: vi.fn(), list: vi.fn().mockResolvedValue([]), update: vi.fn() } as never,
    crmStore: {} as never,
    integrationStore: integrationStore as never,
    capabilityStore: {
      listActive: vi.fn().mockResolvedValue([]),
      hasActive: vi.fn().mockResolvedValue(false),
      listAllActive: vi.fn().mockResolvedValue([]),
      listHistoryForAssistant: vi.fn().mockResolvedValue([]),
      grant: vi.fn(),
      revoke: vi.fn(),
    } as never,
  }

  beforeEach(() => {
    vi.resetAllMocks()
    integrationStore.touchLastEventAt.mockResolvedValue(undefined)
  })

  it('responds to url_verification challenge', async () => {
    const app = createTestApp('/webhook/slack', slackRoutes(options))

    const res = await request(app)
      .post('/webhook/slack/a_1')
      .send({ type: 'url_verification', challenge: 'test_challenge' })

    expect(res.status).toBe(200)
    expect(res.body.challenge).toBe('test_challenge')
  })

  it('returns 404 when no integration found', async () => {
    const app = createTestApp('/webhook/slack', slackRoutes(options))
    integrationStore.getByChannelForWebhook.mockResolvedValueOnce(null)

    const res = await request(app)
      .post('/webhook/slack/a_1')
      .send({ event: { type: 'message', text: 'hi' } })

    expect(res.status).toBe(404)
  })

  it('returns 401 when signature is invalid', async () => {
    const app = createTestApp('/webhook/slack', slackRoutes(options))
    integrationStore.getByChannelForWebhook.mockResolvedValueOnce({
      id: 'int_1',
      credentials: { bot_token: 'xoxb-test', signing_secret: 'secret' },
      botUserId: 'B123',
    })
    mockVerifySignature.mockReturnValueOnce(false)

    const res = await request(app)
      .post('/webhook/slack/a_1')
      .set('x-slack-signature', 'bad')
      .set('x-slack-request-timestamp', '12345')
      .send({ event: { type: 'message', text: 'hi' } })

    expect(res.status).toBe(401)
  })

  it('returns 200 and processes message on valid request', async () => {
    const app = createTestApp('/webhook/slack', slackRoutes(options))
    integrationStore.getByChannelForWebhook.mockResolvedValueOnce({
      id: 'int_1',
      credentials: { bot_token: 'xoxb-test', signing_secret: 'secret' },
      botUserId: 'B123',
    })
    mockVerifySignature.mockReturnValueOnce(true)
    // The route resolves the answering assistant from the channel: an active
    // chat-capable channel + a default routing row.
    mockGetChannelForWebhook.mockResolvedValueOnce({
      id: 'a_1',
      status: 'active',
      enabledCapabilities: ['chat', 'broadcast'],
    } as never)
    mockResolveAssistantForSurface.mockResolvedValueOnce('asst_1')
    mockResolveRoutingForSurface.mockResolvedValueOnce({
      id: 'ca_1',
      channelId: 'a_1',
      assistantId: 'asst_1',
      externalSurfaceId: null,
      modelAlias: 'standard',
      createdAt: new Date('2026-05-18T00:00:00Z'),
    })

    const res = await request(app)
      .post('/webhook/slack/a_1')
      .set('x-slack-signature', 'v0=valid')
      .set('x-slack-request-timestamp', String(Math.floor(Date.now() / 1000)))
      .send({
        event: {
          type: 'message',
          text: 'hello',
          user: 'U123',
          channel: 'C456',
        },
      })

    // Slack webhook should ACK immediately with 200
    expect(res.status).toBe(200)
  })

  // ── Pipeline B ingest producer (webhook → engine → Episode) ────
  //
  // The route's third best-effort fire-and-forget — after touchLastEventAt
  // and the workflow event dispatcher. Gated on the channel's `'ingest'`
  // capability; bot traffic, drops, and filter-misses resolve to a no-op
  // inside the ingestor itself.

  describe('Pipeline B ingest dispatch', () => {
    // Per-message recipient — what dispatchSlackIngest hands the ingestor.
    const ingest = vi.fn(async () => null)
    const slackWebhookIngestor = { ingest }
    const ingestOpts = { ...options, slackWebhookIngestor } as typeof options & {
      slackWebhookIngestor: { ingest: typeof ingest }
    }

    beforeEach(() => {
      ingest.mockReset()
      ingest.mockResolvedValue(null)
    })

    function validEvent(extra: Record<string, unknown> = {}) {
      return {
        type: 'event_callback',
        team_id: 'T100',
        event: {
          type: 'message',
          text: 'hello team',
          user: 'U123',
          channel: 'C456',
          ts: '1700000000.000100',
          ...extra,
        },
      }
    }

    function setupValidIntegration() {
      integrationStore.getByChannelForWebhook.mockResolvedValue({
        id: 'int_1',
        credentials: { bot_token: 'xoxb-test', signing_secret: 'secret' },
        botUserId: 'B123',
        // Paired connector_instance (migration 182). Without this the
        // ingest dispatcher would attempt lazy provisioning against the
        // real DB and bail.
        connectorInstanceId: 'ci_test_1',
      })
      mockVerifySignature.mockReturnValue(true)
      mockResolveAssistantForSurface.mockResolvedValue('asst_1')
      mockResolveRoutingForSurface.mockResolvedValue({
        id: 'ca_1',
        channelId: 'a_1',
        assistantId: 'asst_1',
        externalSurfaceId: null,
        modelAlias: 'standard',
        createdAt: new Date('2026-05-18T00:00:00Z'),
      })
    }

    /** Let the fire-and-forget ingest promise resolve before asserting. */
    async function flushMicrotasks() {
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))
    }

    it('calls ingestor.ingest with normalized payload when ingest capability is enabled', async () => {
      setupValidIntegration()
      mockGetChannelForWebhook.mockResolvedValue({
        id: 'a_1',
        workspaceId: 'w_1',
        status: 'active',
        enabledCapabilities: ['chat', 'broadcast', 'ingest'],
      } as never)
      // findAssistantById is mocked via the global mock — supply a return.
      const usersModule = await import('../../db/users.js')
      vi.mocked(usersModule.findAssistantById).mockResolvedValue({
        id: 'asst_1',
        name: 'Test',
        ownerUserId: 'u_owner',
        workspaceId: 'w_1',
        slackModelAlias: 'gemini-flash',
        systemPrompt: null,
        clearance: 'internal',
      } as never)

      const app = createTestApp('/webhook/slack', slackRoutes(ingestOpts))
      const res = await request(app)
        .post('/webhook/slack/a_1')
        .set('x-slack-signature', 'v0=valid')
        .set('x-slack-request-timestamp', String(Math.floor(Date.now() / 1000)))
        .send(validEvent())

      expect(res.status).toBe(200)
      await flushMicrotasks()
      expect(ingest).toHaveBeenCalledTimes(1)
      const ingestCall = ingest.mock.calls[0] as unknown as [Record<string, unknown>]
      expect(ingestCall[0]).toMatchObject({
        workspaceId: 'w_1',
        userId: 'u_owner',
        assistantId: 'asst_1',
        teamId: 'T100',
        channelId: 'C456',
        ts: '1700000000.000100',
        userSlackId: 'U123',
        text: 'hello team',
        isBot: false,
      })
    })

    it('does NOT call ingestor when ingest capability is missing', async () => {
      setupValidIntegration()
      mockGetChannelForWebhook.mockResolvedValue({
        id: 'a_1',
        workspaceId: 'w_1',
        status: 'active',
        enabledCapabilities: ['chat', 'broadcast'],
      } as never)

      const app = createTestApp('/webhook/slack', slackRoutes(ingestOpts))
      const res = await request(app)
        .post('/webhook/slack/a_1')
        .set('x-slack-signature', 'v0=valid')
        .set('x-slack-request-timestamp', String(Math.floor(Date.now() / 1000)))
        .send(validEvent())

      expect(res.status).toBe(200)
      await flushMicrotasks()
      expect(ingest).not.toHaveBeenCalled()
    })

    it('does NOT call ingestor for bot-authored events', async () => {
      setupValidIntegration()
      mockGetChannelForWebhook.mockResolvedValue({
        id: 'a_1',
        workspaceId: 'w_1',
        status: 'active',
        enabledCapabilities: ['chat', 'broadcast', 'ingest'],
      } as never)

      const app = createTestApp('/webhook/slack', slackRoutes(ingestOpts))
      const res = await request(app)
        .post('/webhook/slack/a_1')
        .set('x-slack-signature', 'v0=valid')
        .set('x-slack-request-timestamp', String(Math.floor(Date.now() / 1000)))
        .send(
          validEvent({
            bot_id: 'B999',
            user: undefined,
          }),
        )

      expect(res.status).toBe(200)
      await flushMicrotasks()
      expect(ingest).not.toHaveBeenCalled()
    })

    it('does NOT ingest an app_mention twin (deduped against the message.* event)', async () => {
      // Slack delivers a `<@bot>` message as TWO separate events — a `message.*`
      // event AND an `app_mention` event with the same ts. The `message.*` event
      // already covers ingest, so the `app_mention` twin must be dropped or the
      // same message is double-materialized (extra extraction + duplicate
      // entities — the 2026-06-30 prod finding). Full happy-path setup so that,
      // WITHOUT the dedup guard, ingest would fire — the not-called assertion is
      // the regression. The `message`-event positive case is covered above.
      setupValidIntegration()
      mockGetChannelForWebhook.mockResolvedValue({
        id: 'a_1',
        workspaceId: 'w_1',
        status: 'active',
        enabledCapabilities: ['chat', 'broadcast', 'ingest'],
      } as never)
      const usersModule = await import('../../db/users.js')
      vi.mocked(usersModule.findAssistantById).mockResolvedValue({
        id: 'asst_1',
        name: 'Test',
        ownerUserId: 'u_owner',
        workspaceId: 'w_1',
        slackModelAlias: 'gemini-flash',
        systemPrompt: null,
        clearance: 'internal',
      } as never)

      const app = createTestApp('/webhook/slack', slackRoutes(ingestOpts))
      const res = await request(app)
        .post('/webhook/slack/a_1')
        .set('x-slack-signature', 'v0=valid')
        .set('x-slack-request-timestamp', String(Math.floor(Date.now() / 1000)))
        .send(validEvent({ type: 'app_mention', text: '<@B123> hello team' }))

      expect(res.status).toBe(200)
      await flushMicrotasks()
      expect(ingest).not.toHaveBeenCalled()
    })
  })
})

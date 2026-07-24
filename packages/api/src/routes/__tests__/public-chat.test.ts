import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

// Mock the shared pipeline — these tests own the ROUTE contract
// (token resolution, schema strictness, caps, delegation shape);
// the pipeline itself is covered by public-api.test.ts.
vi.mock('../public-turn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../public-turn.js')>()
  return {
    ...actual,
    executePublicTurn: vi.fn(async (_deps, _input, _req, res) => {
      res.json({ reply: 'ok from pipeline' })
    }),
    handlePublicHistory: vi.fn(async (_input, res) => {
      res.json({ sessionId: 's', messages: [] })
    }),
  }
})

import { publicChatRoutes, type PublicChatRouteOptions } from '../public-chat.js'
import { executePublicTurn, handlePublicHistory } from '../public-turn.js'

const mockTurn = vi.mocked(executePublicTurn)
const mockHistory = vi.mocked(handlePublicHistory)

const RESOLVED = {
  linkId: 'l_1',
  assistantId: 'a_1',
  dailyMessageLimit: 200,
  workspaceId: 'ws_1',
  assistantName: 'Ops Bot',
  assistantIconSeed: 3,
  assistantBio: 'Answers ops questions',
}

function makeChatLinkStore() {
  return {
    create: vi.fn(),
    listForAssistant: vi.fn(),
    revoke: vi.fn(),
    resolveToken: vi.fn().mockResolvedValue(RESOLVED),
    consumeDailyBudget: vi.fn().mockResolvedValue({ allowed: true, used: 1, limit: 200 }),
  }
}

function makeOptions(chatLinkStore: ReturnType<typeof makeChatLinkStore>): PublicChatRouteOptions {
  return {
    // The pipeline is mocked — these deps are never exercised here.
    provider: {} as never,
    tools: new Map(),
    systemPrompt: 'sys',
    memoryStore: {} as never,
    capabilityStore: { listActive: vi.fn().mockResolvedValue([]) } as never,
    chatLinkStore: chatLinkStore as never,
  }
}

describe('[COMP:api/public-chat-route] Public chat routes', () => {
  let chatLinkStore: ReturnType<typeof makeChatLinkStore>

  beforeEach(() => {
    vi.clearAllMocks()
    chatLinkStore = makeChatLinkStore()
    chatLinkStore.resolveToken.mockResolvedValue(RESOLVED)
    chatLinkStore.consumeDailyBudget.mockResolvedValue({ allowed: true, used: 1, limit: 200 })
  })

  function app() {
    // Fresh router per test = fresh rate-limiter windows.
    return createTestApp('/api', publicChatRoutes(makeOptions(chatLinkStore)))
  }

  describe('GET /public/chat/:token (meta)', () => {
    it('returns assistant meta for an active link', async () => {
      const res = await request(app()).get('/api/public/chat/tok_1')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        assistantName: 'Ops Bot',
        assistantIconSeed: 3,
        assistantBio: 'Answers ops questions',
      })
    })

    it('404s an unknown or revoked token', async () => {
      chatLinkStore.resolveToken.mockResolvedValueOnce(null)
      const res = await request(app()).get('/api/public/chat/bad')
      expect(res.status).toBe(404)
      expect(res.body.error).toBe('link_not_found')
    })
  })

  describe('POST /public/chat/:token/messages', () => {
    const validBody = { visitorId: 'visitor-uuid-1', message: 'hello' }

    it('delegates to the shared pipeline with the chatlink identity namespace', async () => {
      const res = await request(app())
        .post('/api/public/chat/tok_1/messages')
        .send(validBody)

      expect(res.status).toBe(200)
      expect(res.body.reply).toBe('ok from pipeline')
      expect(mockTurn).toHaveBeenCalledTimes(1)
      const input = mockTurn.mock.calls[0][1]
      expect(input.assistantId).toBe('a_1')
      expect(input.identityNamespace).toBe('chatlink:l_1')
      expect(input.analyticsMeta).toEqual({ chat_link_id: 'l_1', surface: 'chat_link' })
      // Anonymous by construction — the route never forwards identity fields.
      expect(input.body.identified).toBeUndefined()
      expect(input.body.externalUserEmail).toBeUndefined()
      expect(input.body.externalUserId).toBe('visitor-uuid-1')
    })

    it('rejects Tier-1 self-identification fields (strict schema)', async () => {
      const res = await request(app())
        .post('/api/public/chat/tok_1/messages')
        .send({ ...validBody, identified: true, externalUserEmail: 'x@example.com' })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('invalid_input')
      expect(mockTurn).not.toHaveBeenCalled()
    })

    it('404s when the token does not resolve', async () => {
      chatLinkStore.resolveToken.mockResolvedValueOnce(null)
      const res = await request(app())
        .post('/api/public/chat/bad/messages')
        .send(validBody)
      expect(res.status).toBe(404)
      expect(res.body.error).toBe('link_not_found')
      expect(chatLinkStore.consumeDailyBudget).not.toHaveBeenCalled()
    })

    it('429s when the per-link daily cap is exhausted', async () => {
      chatLinkStore.consumeDailyBudget.mockResolvedValueOnce({ allowed: false, used: 201, limit: 200 })
      const res = await request(app())
        .post('/api/public/chat/tok_1/messages')
        .send(validBody)
      expect(res.status).toBe(429)
      expect(res.body.error).toBe('link_budget_exhausted')
      expect(mockTurn).not.toHaveBeenCalled()
    })

    it('400s an over-long message before touching the store', async () => {
      const res = await request(app())
        .post('/api/public/chat/tok_1/messages')
        .send({ ...validBody, message: 'x'.repeat(16_001) })
      expect(res.status).toBe(400)
      expect(chatLinkStore.resolveToken).not.toHaveBeenCalled()
    })

    it('rate-limits a hammering IP with a plain 429', async () => {
      // Pin the clock: the limiter is a fixed 60s window keyed on Date.now,
      // so an unpinned loop can straddle a window boundary and (rarely)
      // never accumulate 30 hits in one window — a real flake seen in the
      // full sequential suite.
      const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
      try {
        const shared = app() // one app instance = one limiter window
        let limited = false
        for (let i = 0; i < 31; i++) {
          const res = await request(shared)
            .post('/api/public/chat/tok_1/messages')
            .send(validBody)
          if (res.status === 429 && res.body.error === 'Too many requests') {
            limited = true
            break
          }
        }
        expect(limited).toBe(true)
      } finally {
        dateNowSpy.mockRestore()
      }
    })
  })

  describe('GET /public/chat/:token/messages (history)', () => {
    it('requires a visitorId', async () => {
      const res = await request(app()).get('/api/public/chat/tok_1/messages')
      expect(res.status).toBe(400)
    })

    it('delegates to the shared history handler with the chatlink namespace', async () => {
      const res = await request(app())
        .get('/api/public/chat/tok_1/messages?visitorId=visitor-uuid-1')
      expect(res.status).toBe(200)
      const input = mockHistory.mock.calls[0][0]
      expect(input.assistantId).toBe('a_1')
      expect(input.identityNamespace).toBe('chatlink:l_1')
      expect(input.externalUserId).toBe('visitor-uuid-1')
    })

    it('404s when the token does not resolve', async () => {
      chatLinkStore.resolveToken.mockResolvedValueOnce(null)
      const res = await request(app())
        .get('/api/public/chat/bad/messages?visitorId=visitor-uuid-1')
      expect(res.status).toBe(404)
    })
  })
})

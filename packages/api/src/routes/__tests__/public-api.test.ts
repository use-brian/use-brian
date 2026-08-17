/**
 * Unit tests for the public API v1 route — authentication layer.
 * Component tag: [COMP:api/public-api-route].
 *
 * Covers the security-critical auth ladder of POST /assistants/:id/
 * messages, which fully resolves before the queryLoop turn runs:
 * missing/!malformed bearer token, unknown key, the key↔URL binding
 * (a leaked key for assistant A must not work against B), revoked
 * key, secret mismatch, and the post-auth body validation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

const mockParseToken = vi.fn()
const mockVerifySecret = vi.fn()

vi.mock('../../db/api-key-store.js', async (io) => ({
  ...(await io<typeof import('../../db/api-key-store.js')>()),
  parseAuthToken: (...a: unknown[]) => mockParseToken(...a),
  verifySecret: (...a: unknown[]) => mockVerifySecret(...a),
}))

// Mock only the turn/history executors — the auth-ladder tests below never
// reach them, and the lane-derivation tests assert the delegation shape the
// route hands to the shared pipeline. `fail` and friends stay real.
vi.mock('../public-turn.js', async (io) => ({
  ...(await io<typeof import('../public-turn.js')>()),
  executePublicTurn: vi.fn(async (_deps, _input, _req, res) => {
    res.json({ reply: 'ok' })
  }),
  handlePublicHistory: vi.fn(async (_input, res) => {
    res.json({ sessionId: 's', messages: [] })
  }),
}))

import { acceptsPublicAssistantSse, publicApiRoutes } from '../public-api.js'
import { executePublicTurn } from '../public-turn.js'

const mockTurn = vi.mocked(executePublicTurn)

const apiKeyStore = {
  getByIdSystem: vi.fn(),
  touchLastUsedAt: vi.fn().mockResolvedValue(undefined),
}

function app() {
  return createTestApp(
    '/api/v1',
    publicApiRoutes({ apiKeyStore } as unknown as Parameters<typeof publicApiRoutes>[0]),
  )
}

function post(assistantId: string, opts: { token?: string; body?: unknown } = {}) {
  const req = request(app()).post(`/api/v1/assistants/${assistantId}/messages`)
  if (opts.token !== undefined) req.set('Authorization', `Bearer ${opts.token}`)
  return req.send(opts.body ?? { message: 'hi', externalUserId: 'ext-1' })
}

const activeKey = { id: 'k-1', assistantId: 'a-1', status: 'active', keyHash: 'hash' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('[COMP:api/public-api-route] SSE content negotiation', () => {
  it('requires an explicit text/event-stream media type', () => {
    expect(acceptsPublicAssistantSse(undefined)).toBe(false)
    expect(acceptsPublicAssistantSse('*/*')).toBe(false)
    expect(acceptsPublicAssistantSse('application/json')).toBe(false)
    expect(acceptsPublicAssistantSse('application/json, text/event-stream; q=0.9')).toBe(true)
    expect(acceptsPublicAssistantSse('TEXT/EVENT-STREAM')).toBe(true)
  })
})

describe('[COMP:api/public-api-route] POST /assistants/:id/messages — auth', () => {
  it('rejects a request with no bearer token (401)', async () => {
    const res = await request(app()).post('/api/v1/assistants/a-1/messages').send({})
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('invalid_api_key')
  })

  it('rejects an unparseable token (401)', async () => {
    mockParseToken.mockReturnValueOnce(null)
    const res = await post('a-1', { token: 'garbage' })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('invalid_api_key')
  })

  it('rejects a token whose key id is unknown (401)', async () => {
    mockParseToken.mockReturnValueOnce({ keyId: 'k-x', secret: 's' })
    apiKeyStore.getByIdSystem.mockResolvedValueOnce(null)
    expect((await post('a-1', { token: 'tok' })).status).toBe(401)
  })

  it('rejects a key minted for a different assistant — the key↔URL binding', async () => {
    mockParseToken.mockReturnValueOnce({ keyId: 'k-1', secret: 's' })
    apiKeyStore.getByIdSystem.mockResolvedValueOnce({ ...activeKey, assistantId: 'a-OTHER' })
    const res = await post('a-1', { token: 'tok' })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('invalid_api_key')
  })

  it('rejects a revoked key with 403 key_revoked', async () => {
    mockParseToken.mockReturnValueOnce({ keyId: 'k-1', secret: 's' })
    apiKeyStore.getByIdSystem.mockResolvedValueOnce({ ...activeKey, status: 'revoked' })
    const res = await post('a-1', { token: 'tok' })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('key_revoked')
  })

  it('rejects a token whose secret fails verification (401)', async () => {
    mockParseToken.mockReturnValueOnce({ keyId: 'k-1', secret: 'wrong' })
    apiKeyStore.getByIdSystem.mockResolvedValueOnce(activeKey)
    mockVerifySecret.mockResolvedValueOnce(false)
    expect((await post('a-1', { token: 'tok' })).status).toBe(401)
  })

  it('passes auth but rejects an invalid request body with 400', async () => {
    mockParseToken.mockReturnValueOnce({ keyId: 'k-1', secret: 'ok' })
    apiKeyStore.getByIdSystem.mockResolvedValueOnce(activeKey)
    mockVerifySecret.mockResolvedValueOnce(true)
    const res = await post('a-1', { token: 'tok', body: {} })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_input')
  })
})

/**
 * `claims` is turn-scoped auth power attested by the key holder. These cases
 * cover the wire contract only — the transport and prompt effects live in the
 * shared pipeline (`[COMP:api/public-turn]`). Every request here authenticates
 * successfully, so a 400 can only come from schema validation.
 */
describe('[COMP:api/public-api-route] POST /assistants/:id/messages — claims schema', () => {
  function authed(body: Record<string, unknown>) {
    mockParseToken.mockReturnValueOnce({ keyId: 'k-1', secret: 'ok' })
    apiKeyStore.getByIdSystem.mockResolvedValueOnce(activeKey)
    mockVerifySecret.mockResolvedValueOnce(true)
    return post('a-1', { token: 'tok', body: { message: 'hi', externalUserId: 'ext-1', ...body } })
  }

  it('rejects claims.email disagreeing with the externalUserEmail alias (400 invalid_input)', async () => {
    // The two spellings are one field. A disagreement means the consumer's own
    // code paths resolved different people for one turn; picking either would
    // silently mis-attribute memory, the CRM link, and the connector headers.
    const res = await authed({
      externalUserEmail: 'old@client.example',
      claims: { email: 'new@client.example' },
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_input')
    expect(res.body.detail).toContain('externalUserEmail')
  })

  it('accepts both spellings when they agree (the migration path)', async () => {
    const res = await authed({
      externalUserEmail: 'jane@client.example',
      claims: { email: 'jane@client.example' },
    })
    // Past validation — the turn then fails on the unwired pipeline, never 400.
    expect(res.status).not.toBe(400)
  })

  it('accepts claims alone, and rejects an unknown claims field (strict)', async () => {
    expect((await authed({ claims: { email: 'jane@client.example' } })).status).not.toBe(400)
    expect((await authed({ claims: { orgId: 'acme', roles: ['admin'] } })).status).not.toBe(400)

    const res = await authed({ claims: { email: 'jane@client.example', isAdmin: true } })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_input')
  })

  it('rejects a malformed claims.email and an over-long endUserContext', async () => {
    expect((await authed({ claims: { email: 'not-an-email' } })).status).toBe(400)
    expect((await authed({ endUserContext: 'x'.repeat(4001) })).status).toBe(400)
    expect((await authed({ endUserContext: 'plan: pro' })).status).not.toBe(400)
  })

  it('caps the roles array so a consumer cannot inflate the prompt', async () => {
    const res = await authed({ claims: { roles: Array.from({ length: 17 }, (_, i) => `r${i}`) } })
    expect(res.status).toBe(400)
  })
})

describe('[COMP:api/public-api-route] lane derivation (docs/plans/api-chat-modes.md)', () => {
  function keyRow(overrides: Record<string, unknown> = {}) {
    return {
      ...activeKey,
      audience: 'external',
      anonymousContext: 'thin',
      toolPolicy: 'public_research',
      createdBy: 'u-owner',
      ...overrides,
    }
  }
  function authedPost(row: Record<string, unknown>, body: Record<string, unknown>) {
    mockParseToken.mockReturnValueOnce({ keyId: 'k-1', secret: 'ok' })
    apiKeyStore.getByIdSystem.mockResolvedValueOnce(row)
    mockVerifySecret.mockResolvedValueOnce(true)
    return post('a-1', { token: 'tok', body: { message: 'hi', externalUserId: 'ext-1', ...body } })
  }

  it('external thin key, anonymous turn → default external-client scope', async () => {
    const res = await authedPost(keyRow(), {})
    expect(res.status).toBe(200)
    const input = mockTurn.mock.calls[0][1]
    expect(input.contextScope).toBeUndefined()
    expect(input.internalActor).toBeUndefined()
    expect(input.delivery).toBe('json')
    expect(input.toolPolicy).toBe('public_research')
  })

  it('forwards explicit SSE delivery without changing lane derivation', async () => {
    const req = authedPost(keyRow(), {})
    req.set('Accept', 'text/event-stream')
    const res = await req
    expect(res.status).toBe(200)
    const input = mockTurn.mock.calls[0][1]
    expect(input.contextScope).toBeUndefined()
    expect(input.delivery).toBe('sse')
  })

  it("external full key, anonymous turn → 'assistant-full' (D2)", async () => {
    const res = await authedPost(keyRow({ anonymousContext: 'full' }), {})
    expect(res.status).toBe(200)
    expect(mockTurn.mock.calls[0][1].contextScope).toBe('assistant-full')
  })

  it('external full key, IDENTIFIED turn → stays thin (indexed lane, D3)', async () => {
    const res = await authedPost(keyRow({ anonymousContext: 'full' }), { identified: true })
    expect(res.status).toBe(200)
    expect(mockTurn.mock.calls[0][1].contextScope).toBeUndefined()
  })

  it("internal key → 'internal-member' with the creator as default actor (D4)", async () => {
    const res = await authedPost(keyRow({ audience: 'internal', toolPolicy: 'assistant' }), {})
    expect(res.status).toBe(200)
    const input = mockTurn.mock.calls[0][1]
    expect(input.contextScope).toBe('internal-member')
    expect(input.internalActor).toEqual({ email: null, defaultUserId: 'u-owner' })
  })

  it('internal key forwards a per-request actorEmail attribution', async () => {
    await authedPost(
      keyRow({ audience: 'internal', toolPolicy: 'assistant' }),
      { actorEmail: 'jo@team.example' },
    )
    expect(mockTurn.mock.calls[0][1].internalActor).toEqual({
      email: 'jo@team.example',
      defaultUserId: 'u-owner',
    })
  })

  it('internal key rejects the external tier machinery with 400', async () => {
    for (const body of [
      { identified: true },
      { claims: { email: 'x@client.example' } },
      { externalUserEmail: 'x@client.example' },
      { clientMemory: { key: 'profile', summary: 'private client detail' } },
      { allowPublicResearch: true },
    ]) {
      const res = await authedPost(
        keyRow({ audience: 'internal', toolPolicy: 'assistant' }),
        body,
      )
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('invalid_input')
    }
    expect(mockTurn).not.toHaveBeenCalled()
  })

  it('validates and forwards deterministic client-memory input', async () => {
    const body = {
      identified: true,
      clientMemory: {
        key: 'studio-consultation:session-1',
        summary: 'Interested in a product review.',
        detail: 'Verified consultation transcript.',
        tags: ['consultation', 'prospect'],
      },
    }
    const res = await authedPost(keyRow(), body)
    expect(res.status).toBe(200)
    expect(mockTurn.mock.calls[0][1].body.clientMemory).toEqual(body.clientMemory)
  })

  it('forwards explicit research consent only for a public-research key', async () => {
    const res = await authedPost(keyRow(), { allowPublicResearch: true })
    expect(res.status).toBe(200)
    expect(mockTurn.mock.calls[0][1].body.allowPublicResearch).toBe(true)

    const rejected = await authedPost(
      keyRow({ toolPolicy: 'assistant' }),
      { allowPublicResearch: false },
    )
    expect(rejected.status).toBe(400)
    expect(rejected.body.detail).toContain('public_research')
  })

  it('rejects malformed client-memory input before the turn runs', async () => {
    for (const clientMemory of [
      { key: 'contains spaces', summary: 'detail' },
      { key: 'profile', summary: '' },
      { key: 'profile', summary: 'detail', extra: true },
      { key: 'profile', summary: 'detail', tags: Array.from({ length: 17 }, () => 'tag') },
    ]) {
      const res = await authedPost(keyRow(), { identified: true, clientMemory })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('invalid_input')
    }
    expect(mockTurn).not.toHaveBeenCalled()
  })

  it('external key rejects actorEmail with 400 (attribution is not an escalation)', async () => {
    const res = await authedPost(keyRow(), { actorEmail: 'jo@team.example' })
    expect(res.status).toBe(400)
    expect(res.body.detail).toContain('internal-audience')
    expect(mockTurn).not.toHaveBeenCalled()
  })
})

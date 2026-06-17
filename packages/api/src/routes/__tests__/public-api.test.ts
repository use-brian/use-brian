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

import { publicApiRoutes } from '../public-api.js'

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

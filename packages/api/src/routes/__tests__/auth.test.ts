import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { authRoutes } from '../auth.js'
import { createTokens } from '../../auth/jwt.js'
import type { LinkedAccount, LinkedAccountStore } from '../../db/linked-accounts.js'

const JWT_SECRET = 'test-jwt-secret'
const USER_A = '11111111-1111-1111-1111-111111111111'
const ASSISTANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const ASSISTANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

// query() in auth.ts runs raw SQL against the pool; mock it so tests don't
// need a real DB. We return different rows per SQL pattern.
const queryMock = vi.fn()
vi.mock('../../db/client.js', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}))

function makeApp(store: LinkedAccountStore | undefined) {
  const app = express()
  app.use(express.json())
  app.use('/auth', authRoutes(JWT_SECRET, undefined, store))
  return app
}

function authHeader(userId: string): Record<string, string> {
  const { accessToken } = createTokens(userId, JWT_SECRET)
  return { Authorization: `Bearer ${accessToken}` }
}

function stubStore(overrides?: Partial<LinkedAccountStore>): LinkedAccountStore {
  return {
    findByProvider: async () => null,
    upsert: async (p) => ({
      id: 'la-1',
      userId: p.userId,
      assistantId: p.assistantId,
      provider: p.provider,
      providerId: p.providerId,
      providerMetadata: p.providerMetadata ?? null,
      linkedAt: new Date(),
    }),
    findByAssistant: async () => null,
    listForUser: async () => [],
    deleteForUser: async () => false,
    ...overrides,
  }
}

beforeEach(() => {
  queryMock.mockReset()
})

describe('[COMP:api/auth] GET /auth/telegram-link', () => {
  it('returns 401 without a valid token', async () => {
    const app = makeApp(stubStore())
    await request(app).get('/auth/telegram-link').expect(401)
  })

  it('returns null when the user has no linked Telegram row', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const app = makeApp(stubStore())
    const res = await request(app)
      .get('/auth/telegram-link')
      .set(authHeader(USER_A))
      .expect(200)
    expect(res.body).toEqual({ assistantId: null })
  })

  it('returns the linked assistantId when a row exists', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ assistantId: ASSISTANT_A }] })
    const app = makeApp(stubStore())
    const res = await request(app)
      .get('/auth/telegram-link')
      .set(authHeader(USER_A))
      .expect(200)
    expect(res.body).toEqual({ assistantId: ASSISTANT_A })
  })
})

describe('[COMP:api/auth] POST /auth/telegram-link-update', () => {
  it('returns 401 without a valid token', async () => {
    const app = makeApp(stubStore())
    await request(app).post('/auth/telegram-link-update').send({ assistantId: ASSISTANT_A }).expect(401)
  })

  it('returns 400 when assistantId is missing', async () => {
    const app = makeApp(stubStore())
    await request(app)
      .post('/auth/telegram-link-update')
      .set(authHeader(USER_A))
      .send({})
      .expect(400)
  })

  it('returns 403 when the user does not own the assistant', async () => {
    // Ownership check query returns no rows.
    queryMock.mockResolvedValueOnce({ rows: [] })
    const app = makeApp(stubStore())
    await request(app)
      .post('/auth/telegram-link-update')
      .set(authHeader(USER_A))
      .send({ assistantId: ASSISTANT_A })
      .expect(403)
  })

  it('returns 404 when the user has no existing Telegram link', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: ASSISTANT_A, name: 'My Assistant' }] }) // ownership
      .mockResolvedValueOnce({ rows: [] }) // existing linked row lookup
    const app = makeApp(stubStore())
    await request(app)
      .post('/auth/telegram-link-update')
      .set(authHeader(USER_A))
      .send({ assistantId: ASSISTANT_A })
      .expect(404)
  })

  it('upserts the linked_accounts row on success', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: ASSISTANT_B, name: 'Work' }] }) // ownership
      .mockResolvedValueOnce({
        rows: [{ provider_id: '12345', provider_metadata: { firstName: 'Hinson', chatId: '12345' } }],
      })

    let captured: Parameters<LinkedAccountStore['upsert']>[0] | null = null
    const store = stubStore({
      upsert: async (p): Promise<LinkedAccount> => {
        captured = p
        return {
          id: 'la-1',
          userId: p.userId,
          assistantId: p.assistantId,
          provider: p.provider,
          providerId: p.providerId,
          providerMetadata: p.providerMetadata ?? null,
          linkedAt: new Date(),
        }
      },
    })

    const app = makeApp(store)
    const res = await request(app)
      .post('/auth/telegram-link-update')
      .set(authHeader(USER_A))
      .send({ assistantId: ASSISTANT_B })
      .expect(200)

    expect(res.body).toEqual({ ok: true, assistant: { id: ASSISTANT_B, name: 'Work' } })
    expect(captured).not.toBeNull()
    expect(captured!.userId).toBe(USER_A)
    expect(captured!.assistantId).toBe(ASSISTANT_B)
    expect(captured!.providerId).toBe('12345')
    expect(captured!.provider).toBe('telegram')
  })

  it('returns 503 when linkedAccountStore is not configured', async () => {
    const app = makeApp(undefined)
    await request(app)
      .post('/auth/telegram-link-update')
      .set(authHeader(USER_A))
      .send({ assistantId: ASSISTANT_A })
      .expect(503)
  })
})

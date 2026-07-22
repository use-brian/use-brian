import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

// Mock DB modules
vi.mock('../../db/client.js', () => {
  const mockClient = {
    query: vi.fn(),
    release: vi.fn(),
  }
  return {
    query: vi.fn(),
    queryWithRLS: vi.fn(),
    getPool: vi.fn(() => ({
      connect: vi.fn().mockResolvedValue(mockClient),
      query: vi.fn(),
    })),
    __mockClient: mockClient,
  }
})
vi.mock('../../db/users.js', () => ({
  findUserById: vi.fn(),
  updateUserTimezone: vi.fn(),
}))

import { accountRoutes } from '../account.js'
import { query, queryWithRLS, getPool } from '../../db/client.js'
import { findUserById, updateUserTimezone } from '../../db/users.js'

const mockQuery = vi.mocked(query)
const mockQueryWithRLS = vi.mocked(queryWithRLS)
const mockFindUserById = vi.mocked(findUserById)
const mockUpdateUserTimezone = vi.mocked(updateUserTimezone)

// Access the mock client from the pool
const mockPool = vi.mocked(getPool)

describe('[COMP:api/account-route] Account routes', () => {
  const linkedAccountStore = {
    findByProvider: vi.fn(),
    create: vi.fn(),
    listForUser: vi.fn(),
    deleteForUser: vi.fn(),
  }

  beforeEach(() => {
    vi.resetAllMocks()
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never)
  })

  // ── GET /linked-accounts ────────────────────────────────────

  it('returns linked accounts', async () => {
    const app = createTestApp('/api/account', accountRoutes({ linkedAccountStore: linkedAccountStore as never }), { userId: 'u_1' })
    linkedAccountStore.listForUser.mockResolvedValueOnce([
      { provider: 'telegram', providerId: '123' },
    ])

    const res = await request(app).get('/api/account/linked-accounts')
    expect(res.status).toBe(200)
    expect(res.body.linkedAccounts).toHaveLength(1)
  })

  it('returns empty when no linked account store', async () => {
    const app = createTestApp('/api/account', accountRoutes(), { userId: 'u_1' })
    const res = await request(app).get('/api/account/linked-accounts')
    expect(res.status).toBe(200)
    expect(res.body.linkedAccounts).toEqual([])
  })

  it('returns 401 without userId', async () => {
    const app = createTestApp('/api/account', accountRoutes())
    const res = await request(app).get('/api/account/linked-accounts')
    expect(res.status).toBe(401)
  })

  // ── DELETE /linked-accounts/:id ──────────────────────────────

  it('deletes a linked account', async () => {
    const app = createTestApp('/api/account', accountRoutes({ linkedAccountStore: linkedAccountStore as never }), { userId: 'u_1' })
    linkedAccountStore.deleteForUser.mockResolvedValueOnce(true)

    const res = await request(app).delete('/api/account/linked-accounts/la_1')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(linkedAccountStore.deleteForUser).toHaveBeenCalledWith('u_1', 'la_1')
  })

  it('returns 404 when linked account not found', async () => {
    const app = createTestApp('/api/account', accountRoutes({ linkedAccountStore: linkedAccountStore as never }), { userId: 'u_1' })
    linkedAccountStore.deleteForUser.mockResolvedValueOnce(false)

    const res = await request(app).delete('/api/account/linked-accounts/la_gone')
    expect(res.status).toBe(404)
  })

  it('returns 404 when no linked account store configured', async () => {
    const app = createTestApp('/api/account', accountRoutes(), { userId: 'u_1' })
    const res = await request(app).delete('/api/account/linked-accounts/la_1')
    expect(res.status).toBe(404)
  })

  // ── POST /telegram/link-code ─────────────────────────────────

  it('mints a link code for the first-owned assistant with the bot username', async () => {
    const linkCodeStore = {
      create: vi.fn().mockResolvedValue({
        code: 'ABC123',
        expiresAt: new Date('2026-06-10T00:05:00Z'),
      }),
      findValidCode: vi.fn(),
      claim: vi.fn(),
      getByUserAndAssistant: vi.fn(),
    }
    const app = createTestApp(
      '/api/account',
      accountRoutes({
        linkCodeStore: linkCodeStore as never,
        getTelegramBotUsername: async () => 'use_brian_bot',
      }),
      { userId: 'u_1' },
    )
    // First-owned assistant lookup.
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'a_first' }], rowCount: 1 } as never)

    const res = await request(app).post('/api/account/telegram/link-code')
    expect(res.status).toBe(200)
    expect(res.body.code).toBe('ABC123')
    expect(res.body.botUsername).toBe('use_brian_bot')
    expect(linkCodeStore.create).toHaveBeenCalledWith({ userId: 'u_1', assistantId: 'a_first' })
  })

  it('degrades to botUsername null when the resolver fails', async () => {
    const linkCodeStore = {
      create: vi.fn().mockResolvedValue({
        code: 'XYZ789',
        expiresAt: new Date('2026-06-10T00:05:00Z'),
      }),
      findValidCode: vi.fn(),
      claim: vi.fn(),
      getByUserAndAssistant: vi.fn(),
    }
    const app = createTestApp(
      '/api/account',
      accountRoutes({
        linkCodeStore: linkCodeStore as never,
        getTelegramBotUsername: async () => {
          throw new Error('getMe down')
        },
      }),
      { userId: 'u_1' },
    )
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'a_first' }], rowCount: 1 } as never)

    const res = await request(app).post('/api/account/telegram/link-code')
    expect(res.status).toBe(200)
    expect(res.body.code).toBe('XYZ789')
    expect(res.body.botUsername).toBeNull()
  })

  it('returns 409 no_assistant when the user owns no assistant', async () => {
    const linkCodeStore = {
      create: vi.fn(),
      findValidCode: vi.fn(),
      claim: vi.fn(),
      getByUserAndAssistant: vi.fn(),
    }
    const app = createTestApp(
      '/api/account',
      accountRoutes({ linkCodeStore: linkCodeStore as never }),
      { userId: 'u_1' },
    )
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)

    const res = await request(app).post('/api/account/telegram/link-code')
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('no_assistant')
    expect(linkCodeStore.create).not.toHaveBeenCalled()
  })

  it('returns 503 when no link code store configured', async () => {
    const app = createTestApp('/api/account', accountRoutes(), { userId: 'u_1' })
    const res = await request(app).post('/api/account/telegram/link-code')
    expect(res.status).toBe(503)
  })

  // ── POST /whatsapp/link-code ─────────────────────────────────
  // Settings -> Account -> Connected accounts, WhatsApp row. Same shape as the
  // Telegram route, but the official number is resolved BEFORE minting so a
  // user never holds a code with nowhere to send it.

  function waLinkCodeStore(code = 'WA1234') {
    return {
      create: vi.fn().mockResolvedValue({
        code,
        expiresAt: new Date('2026-06-10T00:05:00Z'),
      }),
      findValidCode: vi.fn(),
      claim: vi.fn(),
      getByUserAndAssistant: vi.fn(),
    }
  }

  it('mints a whatsapp link code with the official number to message', async () => {
    const linkCodeStore = waLinkCodeStore()
    const app = createTestApp(
      '/api/account',
      accountRoutes({
        linkCodeStore: linkCodeStore as never,
        getWhatsappOfficialNumber: async () => '+85261234567',
      }),
      { userId: 'u_1' },
    )
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'a_first' }], rowCount: 1 } as never)

    const res = await request(app).post('/api/account/whatsapp/link-code')
    expect(res.status).toBe(200)
    expect(res.body.code).toBe('WA1234')
    expect(res.body.officialNumber).toBe('+85261234567')
    expect(linkCodeStore.create).toHaveBeenCalledWith({ userId: 'u_1', assistantId: 'a_first' })
  })

  it('returns 503 official_bot_unavailable and mints nothing when unpaired', async () => {
    const linkCodeStore = waLinkCodeStore()
    const app = createTestApp(
      '/api/account',
      accountRoutes({
        linkCodeStore: linkCodeStore as never,
        getWhatsappOfficialNumber: async () => null,
      }),
      { userId: 'u_1' },
    )

    const res = await request(app).post('/api/account/whatsapp/link-code')
    expect(res.status).toBe(503)
    expect(res.body.error).toBe('official_bot_unavailable')
    // The whole point: no dangling code the user cannot deliver.
    expect(linkCodeStore.create).not.toHaveBeenCalled()
  })

  it('treats a throwing number resolver as unavailable, not a 500', async () => {
    const linkCodeStore = waLinkCodeStore()
    const app = createTestApp(
      '/api/account',
      accountRoutes({
        linkCodeStore: linkCodeStore as never,
        getWhatsappOfficialNumber: async () => {
          throw new Error('connector down')
        },
      }),
      { userId: 'u_1' },
    )

    const res = await request(app).post('/api/account/whatsapp/link-code')
    expect(res.status).toBe(503)
    expect(linkCodeStore.create).not.toHaveBeenCalled()
  })

  it('returns 503 in OSS, where no official-number resolver is injected', async () => {
    const linkCodeStore = waLinkCodeStore()
    const app = createTestApp(
      '/api/account',
      accountRoutes({ linkCodeStore: linkCodeStore as never }),
      { userId: 'u_1' },
    )

    const res = await request(app).post('/api/account/whatsapp/link-code')
    expect(res.status).toBe(503)
    expect(linkCodeStore.create).not.toHaveBeenCalled()
  })

  it('returns 409 no_assistant when the user owns no assistant', async () => {
    const linkCodeStore = waLinkCodeStore()
    const app = createTestApp(
      '/api/account',
      accountRoutes({
        linkCodeStore: linkCodeStore as never,
        getWhatsappOfficialNumber: async () => '+85261234567',
      }),
      { userId: 'u_1' },
    )
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)

    const res = await request(app).post('/api/account/whatsapp/link-code')
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('no_assistant')
    expect(linkCodeStore.create).not.toHaveBeenCalled()
  })

  // ── PATCH /timezone ─────────────────────────────────────────

  it('updates timezone with valid IANA value', async () => {
    const app = createTestApp('/api/account', accountRoutes(), { userId: 'u_1' })
    mockUpdateUserTimezone.mockResolvedValueOnce(undefined)

    const res = await request(app)
      .patch('/api/account/timezone')
      .send({ timezone: 'America/New_York' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.timezone).toBe('America/New_York')
  })

  it('rejects invalid timezone', async () => {
    const app = createTestApp('/api/account', accountRoutes(), { userId: 'u_1' })
    const res = await request(app)
      .patch('/api/account/timezone')
      .send({ timezone: 'Mars/Olympus' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Invalid IANA/)
  })

  it('rejects missing timezone', async () => {
    const app = createTestApp('/api/account', accountRoutes(), { userId: 'u_1' })
    const res = await request(app)
      .patch('/api/account/timezone')
      .send({})
    expect(res.status).toBe(400)
  })

  // ── DELETE /memories ────────────────────────────────────────

  it('deletes memories and souls via RLS', async () => {
    const app = createTestApp('/api/account', accountRoutes(), { userId: 'u_1' })
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 5 } as never) // memories
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 2 } as never) // souls

    const res = await request(app).delete('/api/account/memories')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.memoriesDeleted).toBe(5)
    expect(res.body.soulsDeleted).toBe(2)
    // Both calls should use RLS
    expect(mockQueryWithRLS).toHaveBeenCalledTimes(2)
    expect(mockQueryWithRLS.mock.calls[0][0]).toBe('u_1')
    expect(mockQueryWithRLS.mock.calls[1][0]).toBe('u_1')
  })

  // ── DELETE / (account teardown) ──────────────────────────────

  it('returns 204 when user already deleted (idempotent)', async () => {
    const app = createTestApp('/api/account', accountRoutes(), { userId: 'u_gone' })
    mockFindUserById.mockResolvedValueOnce(null as never)

    const res = await request(app).delete('/api/account')
    expect(res.status).toBe(204)
  })

  it('returns 409 when user owns team assistants', async () => {
    const app = createTestApp('/api/account', accountRoutes(), { userId: 'u_1' })
    mockFindUserById.mockResolvedValueOnce({ id: 'u_1', stripeCustomerId: null } as never)
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'a_team', name: 'Team Bot', member_count: '3' }],
      rowCount: 1,
    } as never)

    const res = await request(app).delete('/api/account')
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('transfer_ownership_required')
    expect(res.body.assistants).toHaveLength(1)
    expect(res.body.assistants[0].memberCount).toBe(3)
  })

  it('returns 409 when user owns workspaces with other members', async () => {
    const app = createTestApp('/api/account', accountRoutes(), { userId: 'u_1' })
    mockFindUserById.mockResolvedValueOnce({ id: 'u_1', stripeCustomerId: null } as never)
    // Guard 1: no shared personal assistants.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    // Guard 2: one owned workspace with another member.
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'ws_team', name: 'Shared WS', member_count: '2' }],
      rowCount: 1,
    } as never)

    const res = await request(app).delete('/api/account')
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('transfer_team_ownership_required')
    expect(res.body.teams).toHaveLength(1)
    expect(res.body.teams[0].memberCount).toBe(2)
  })

  it('guards only on workspaces that have OTHER members', async () => {
    // The guard query must scope to shared workspaces. Every user owns
    // their auto-created Personal workspace (never deletable), so a guard
    // on "any owned workspace" makes account deletion unsatisfiable for
    // every user — the 2026-07-21 dead-end.
    const app = createTestApp('/api/account', accountRoutes(), { userId: 'u_1' })
    mockFindUserById.mockResolvedValueOnce({ id: 'u_1', stripeCustomerId: null } as never)
    const pool = mockPool()
    const mockClient = (await pool.connect()) as unknown as { query: ReturnType<typeof vi.fn> }
    mockClient.query.mockResolvedValue({ rows: [], rowCount: 0 })

    const res = await request(app).delete('/api/account')
    expect(res.status).toBe(204)
    // The owned-workspaces guard (2nd query) must predicate on other members.
    const guardSql = mockQuery.mock.calls[1][0] as string
    expect(guardSql).toMatch(/wm\.user_id <> \$1/)
  })

  it('performs transactional teardown for solo user', async () => {
    const app = createTestApp('/api/account', accountRoutes(), { userId: 'u_1' })
    mockFindUserById.mockResolvedValueOnce({
      id: 'u_1',
      stripeCustomerId: null,
      authProvider: 'google',
    } as never)
    // No team-owned assistants (guard 1) and no shared workspaces (guard 2)
    // — the beforeEach default empty resolution covers both.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)

    // The pool.connect().query calls
    const pool = mockPool()
    const mockClient = (await pool.connect()) as unknown as { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }
    mockClient.query.mockResolvedValue({ rows: [], rowCount: 0 })

    const res = await request(app).delete('/api/account')
    expect(res.status).toBe(204)
  })
})

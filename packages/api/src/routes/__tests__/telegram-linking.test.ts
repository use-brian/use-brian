import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'
import { telegramLinkingRoutes } from '../telegram-linking.js'

// Both routes gate on getUserAssistant — `direct OR workspace` access to the
// `:assistantId` in the URL. Default it to "has access" so the existing
// behavioural cases below exercise their own logic; the access cases override it.
const getUserAssistantMock = vi.fn()
vi.mock('../../db/users.js', () => ({
  getUserAssistant: (...args: unknown[]) => getUserAssistantMock(...args),
}))

describe('[COMP:api/telegram-linking-route] Telegram linking routes', () => {
  const linkedAccountStore = {
    findByProvider: vi.fn(),
    upsert: vi.fn(),
    findByAssistant: vi.fn(),
    listForUser: vi.fn(),
    deleteForUser: vi.fn(),
  }
  const linkCodeStore = {
    create: vi.fn(),
    findValidCode: vi.fn(),
    claim: vi.fn(),
    getByUserAndAssistant: vi.fn(),
  }

  beforeEach(() => {
    vi.resetAllMocks()
    getUserAssistantMock.mockResolvedValue({ id: 'a_1', name: 'DD', workspaceId: 'w_1' })
  })

  // ── Access gate ──────────────────────────────────────────────
  //
  // Regression: both routes take :assistantId straight from the URL and used to
  // run with no access check at all. `/link-code` would mint a redeemable code
  // binding the caller's Telegram to ANY assistant id (a cross-workspace bind);
  // `/link-status` returned another user's linked_accounts row verbatim — their
  // Telegram chat id and profile metadata. requireAuth proves *a* user is
  // calling, never that they may touch *this* assistant.

  it('returns 403 from /link-code when the caller cannot access the assistant', async () => {
    getUserAssistantMock.mockResolvedValue(null)
    const router = telegramLinkingRoutes({
      linkedAccountStore: linkedAccountStore as never,
      linkCodeStore: linkCodeStore as never,
    })
    const app = createTestApp('/api/assistants/:assistantId/telegram', router, { userId: 'u_1' })

    const res = await request(app).post('/api/assistants/someone-elses/telegram/link-code')
    expect(res.status).toBe(403)
    expect(linkCodeStore.create).not.toHaveBeenCalled()
  })

  it('returns 403 from /link-status without leaking the linked account', async () => {
    getUserAssistantMock.mockResolvedValue(null)
    const router = telegramLinkingRoutes({
      linkedAccountStore: linkedAccountStore as never,
      linkCodeStore: linkCodeStore as never,
    })
    const app = createTestApp('/api/assistants/:assistantId/telegram', router, { userId: 'u_1' })

    const res = await request(app).get('/api/assistants/someone-elses/telegram/link-status')
    expect(res.status).toBe(403)
    expect(res.body.linkedAccount).toBeUndefined()
    expect(linkedAccountStore.findByAssistant).not.toHaveBeenCalled()
  })

  it('gates on the URL assistantId, not the caller id', async () => {
    const router = telegramLinkingRoutes({
      linkedAccountStore: linkedAccountStore as never,
      linkCodeStore: linkCodeStore as never,
    })
    const app = createTestApp('/api/assistants/:assistantId/telegram', router, { userId: 'u_1' })
    linkCodeStore.create.mockResolvedValueOnce({ code: 'ABC123', expiresAt: '2026-04-10T12:00:00Z' })

    await request(app).post('/api/assistants/a_9/telegram/link-code')
    expect(getUserAssistantMock).toHaveBeenCalledWith('u_1', 'a_9')
  })

  // ── POST /link-code ──────────────────────────────────────────

  it('generates a link code', async () => {
    const router = telegramLinkingRoutes({
      linkedAccountStore: linkedAccountStore as never,
      linkCodeStore: linkCodeStore as never,
    })
    // Mount with parameterized path so mergeParams picks up :assistantId
    const app = createTestApp('/api/assistants/:assistantId/telegram', router, { userId: 'u_1' })

    const code = { code: 'ABC123', expiresAt: '2026-04-10T12:00:00Z' }
    linkCodeStore.create.mockResolvedValueOnce(code)

    const res = await request(app).post('/api/assistants/a_1/telegram/link-code')
    expect(res.status).toBe(200)
    expect(res.body.code).toBe('ABC123')
    expect(res.body.expiresAt).toBe('2026-04-10T12:00:00Z')
    expect(linkCodeStore.create).toHaveBeenCalledWith({
      userId: 'u_1',
      assistantId: 'a_1',
    })
  })

  it('returns 401 without auth', async () => {
    const router = telegramLinkingRoutes({
      linkedAccountStore: linkedAccountStore as never,
      linkCodeStore: linkCodeStore as never,
    })
    const app = createTestApp('/api/assistants/:assistantId/telegram', router)

    const res = await request(app).post('/api/assistants/a_1/telegram/link-code')
    expect(res.status).toBe(401)
  })

  // ── GET /link-status ─────────────────────────────────────────

  it('returns "linked" when already linked', async () => {
    const router = telegramLinkingRoutes({
      linkedAccountStore: linkedAccountStore as never,
      linkCodeStore: linkCodeStore as never,
    })
    const app = createTestApp('/api/assistants/:assistantId/telegram', router, { userId: 'u_1' })

    linkedAccountStore.findByAssistant.mockResolvedValueOnce(
      { provider: 'telegram', providerId: '12345' },
    )

    const res = await request(app).get('/api/assistants/a_1/telegram/link-status')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('linked')
  })

  it('returns "no_code" when no code exists', async () => {
    const router = telegramLinkingRoutes({
      linkedAccountStore: linkedAccountStore as never,
      linkCodeStore: linkCodeStore as never,
    })
    const app = createTestApp('/api/assistants/:assistantId/telegram', router, { userId: 'u_1' })

    linkedAccountStore.findByAssistant.mockResolvedValueOnce(null)
    linkCodeStore.getByUserAndAssistant.mockResolvedValueOnce(null)

    const res = await request(app).get('/api/assistants/a_1/telegram/link-status')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('no_code')
  })

  it('returns "pending" when code is active', async () => {
    const router = telegramLinkingRoutes({
      linkedAccountStore: linkedAccountStore as never,
      linkCodeStore: linkCodeStore as never,
    })
    const app = createTestApp('/api/assistants/:assistantId/telegram', router, { userId: 'u_1' })

    linkedAccountStore.findByAssistant.mockResolvedValueOnce(null)
    linkCodeStore.getByUserAndAssistant.mockResolvedValueOnce({
      code: 'XYZ789',
      expiresAt: new Date(Date.now() + 60_000).toISOString(), // 1 min from now
      claimedAt: null,
    })

    const res = await request(app).get('/api/assistants/a_1/telegram/link-status')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('pending')
  })

  it('returns "expired" when code has expired', async () => {
    const router = telegramLinkingRoutes({
      linkedAccountStore: linkedAccountStore as never,
      linkCodeStore: linkCodeStore as never,
    })
    const app = createTestApp('/api/assistants/:assistantId/telegram', router, { userId: 'u_1' })

    linkedAccountStore.findByAssistant.mockResolvedValueOnce(null)
    linkCodeStore.getByUserAndAssistant.mockResolvedValueOnce({
      code: 'XYZ789',
      expiresAt: new Date(Date.now() - 60_000).toISOString(), // 1 min ago
      claimedAt: null,
    })

    const res = await request(app).get('/api/assistants/a_1/telegram/link-status')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('expired')
  })

  it('returns "linked" when code was claimed', async () => {
    const router = telegramLinkingRoutes({
      linkedAccountStore: linkedAccountStore as never,
      linkCodeStore: linkCodeStore as never,
    })
    const app = createTestApp('/api/assistants/:assistantId/telegram', router, { userId: 'u_1' })

    linkedAccountStore.findByAssistant.mockResolvedValueOnce(null)
    linkCodeStore.getByUserAndAssistant.mockResolvedValueOnce({
      code: 'XYZ789',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      claimedAt: new Date().toISOString(),
    })

    const res = await request(app).get('/api/assistants/a_1/telegram/link-status')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('linked')
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { authRoutes, type EmailAuthDeps } from '../auth.js'
import type { MagicLinkStore } from '../../db/magic-link-store.js'
import type { SmtpClient } from '../../email/smtp-client.js'

const JWT_SECRET = 'test-jwt-secret'

const queryMock = vi.fn()
vi.mock('../../db/client.js', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(() => ({
    connect: async () => ({
      query: async () => ({ rows: [{ id: 'ws_1' }, { id: 'a_1' }] }),
      release: () => undefined,
    }),
  })),
}))

const findUserByEmailMock = vi.fn()
const findOrCreateUserMock = vi.fn()
const promoteChannelUserMock = vi.fn()
const updateUserTimezoneMock = vi.fn()
const findUserByIdMock = vi.fn()

vi.mock('../../db/users.js', () => ({
  findUserByEmail: (...a: unknown[]) => findUserByEmailMock(...a),
  findOrCreateUser: (...a: unknown[]) => findOrCreateUserMock(...a),
  promoteChannelUser: (...a: unknown[]) => promoteChannelUserMock(...a),
  updateUserTimezone: (...a: unknown[]) => updateUserTimezoneMock(...a),
  findUserById: (...a: unknown[]) => findUserByIdMock(...a),
}))

function makeStore(overrides?: Partial<MagicLinkStore>): MagicLinkStore {
  return {
    create: async () => ({ token: 'fresh-token', code: '123456', expiresAt: new Date(Date.now() + 900_000) }),
    consumeByToken: async () => null,
    consumeByCode: async () => ({ status: 'invalid' }),
    countRecentForEmail: async () => 0,
    countRecentForIp: async () => 0,
    ...overrides,
  }
}

function makeSmtp(): {
  client: SmtpClient
  sent: Array<{ to: string; link: string; locale?: string; code?: string }>
} {
  const sent: Array<{ to: string; link: string; locale?: string; code?: string }> = []
  return {
    sent,
    client: {
      async sendMagicLink(to, link, locale, code) {
        sent.push({ to, link, locale, code })
      },
      async sendWorkspaceInvitation() {
        // Not exercised by the magic-link auth tests.
      },
    },
  }
}

function makeApp(emailAuth?: EmailAuthDeps) {
  const app = express()
  app.use(express.json())
  app.use(
    '/auth',
    authRoutes(JWT_SECRET, undefined, undefined, undefined, undefined, undefined, emailAuth),
  )
  return app
}

beforeEach(() => {
  queryMock.mockReset()
  findUserByEmailMock.mockReset()
  findOrCreateUserMock.mockReset()
  promoteChannelUserMock.mockReset()
  updateUserTimezoneMock.mockReset()
  findUserByIdMock.mockReset()
})

describe('[COMP:api/auth-email-request] POST /auth/email/request-link', () => {
  it('returns 503 when the email auth deps are not configured', async () => {
    const app = makeApp(undefined)
    const res = await request(app)
      .post('/auth/email/request-link')
      .send({ email: 'a@b.com' })
    expect(res.status).toBe(503)
  })

  it('returns 200 and sends an email on the happy path', async () => {
    const store = makeStore()
    const smtp = makeSmtp()
    const app = makeApp({ magicLinkStore: store, smtpClient: smtp.client, appUrl: 'https://usebrian.ai' })

    const res = await request(app)
      .post('/auth/email/request-link')
      .send({ email: 'a@b.com' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    // SMTP send is fire-and-forget — wait a tick.
    await new Promise((r) => setTimeout(r, 10))
    expect(smtp.sent).toHaveLength(1)
    expect(smtp.sent[0].to).toBe('a@b.com')
    // The link lands on the confirm page (no consume-on-GET), carries the
    // locale, and the OTP is passed alongside for the email body.
    expect(smtp.sent[0].link).toContain('https://usebrian.ai/login/verify?token=')
    expect(smtp.sent[0].link).toContain('&lang=en')
    expect(smtp.sent[0].code).toBe('123456')
  })

  it('returns 200 even for an invalid email (no enumeration)', async () => {
    const store = makeStore()
    const smtp = makeSmtp()
    const app = makeApp({ magicLinkStore: store, smtpClient: smtp.client, appUrl: 'https://usebrian.ai' })

    const res = await request(app)
      .post('/auth/email/request-link')
      .send({ email: 'not-an-email' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    await new Promise((r) => setTimeout(r, 10))
    expect(smtp.sent).toHaveLength(0)
  })

  it('rate-limits at 3 requests per email per hour', async () => {
    const store = makeStore({ countRecentForEmail: async () => 3 })
    const smtp = makeSmtp()
    const app = makeApp({ magicLinkStore: store, smtpClient: smtp.client, appUrl: 'https://usebrian.ai' })

    const res = await request(app)
      .post('/auth/email/request-link')
      .send({ email: 'a@b.com' })

    expect(res.status).toBe(200) // still 200, never reveals
    await new Promise((r) => setTimeout(r, 10))
    expect(smtp.sent).toHaveLength(0) // but email NOT sent
  })

  it('rate-limits at 10 requests per IP per hour', async () => {
    const store = makeStore({ countRecentForIp: async () => 10 })
    const smtp = makeSmtp()
    const app = makeApp({ magicLinkStore: store, smtpClient: smtp.client, appUrl: 'https://usebrian.ai' })

    const res = await request(app)
      .post('/auth/email/request-link')
      .send({ email: 'a@b.com' })

    expect(res.status).toBe(200)
    await new Promise((r) => setTimeout(r, 10))
    expect(smtp.sent).toHaveLength(0)
  })

  it('captures locale from Accept-Language header when not in body', async () => {
    const calls: Array<Parameters<MagicLinkStore['create']>[0]> = []
    const store = makeStore({
      create: async (input) => {
        calls.push(input)
        return { token: 't', code: '123456', expiresAt: new Date() }
      },
    })
    const smtp = makeSmtp()
    const app = makeApp({ magicLinkStore: store, smtpClient: smtp.client, appUrl: 'https://usebrian.ai' })

    await request(app)
      .post('/auth/email/request-link')
      .set('Accept-Language', 'ja-JP,en;q=0.9')
      .send({ email: 'a@b.com' })

    expect(calls[0]?.locale).toBe('ja')
  })

  it('honors explicit locale in the request body', async () => {
    const calls: Array<Parameters<MagicLinkStore['create']>[0]> = []
    const store = makeStore({
      create: async (input) => {
        calls.push(input)
        return { token: 't', code: '123456', expiresAt: new Date() }
      },
    })
    const smtp = makeSmtp()
    const app = makeApp({ magicLinkStore: store, smtpClient: smtp.client, appUrl: 'https://usebrian.ai' })

    await request(app)
      .post('/auth/email/request-link')
      .set('Accept-Language', 'ja-JP')
      .send({ email: 'a@b.com', locale: 'zh' })

    expect(calls[0]?.locale).toBe('zh')
  })

  it('rejects an unallowlisted nextPath silently (no error response)', async () => {
    const calls: Array<Parameters<MagicLinkStore['create']>[0]> = []
    const store = makeStore({
      create: async (input) => {
        calls.push(input)
        return { token: 't', code: '123456', expiresAt: new Date() }
      },
    })
    const smtp = makeSmtp()
    const app = makeApp({ magicLinkStore: store, smtpClient: smtp.client, appUrl: 'https://usebrian.ai' })

    const res = await request(app)
      .post('/auth/email/request-link')
      .send({ email: 'a@b.com', nextPath: 'https://evil.com/x' })

    expect(res.status).toBe(200)
    expect(calls[0]?.nextPath).toBeUndefined()
  })

  it('accepts an allowlisted nextPath', async () => {
    const calls: Array<Parameters<MagicLinkStore['create']>[0]> = []
    const store = makeStore({
      create: async (input) => {
        calls.push(input)
        return { token: 't', code: '123456', expiresAt: new Date() }
      },
    })
    const smtp = makeSmtp()
    const app = makeApp({ magicLinkStore: store, smtpClient: smtp.client, appUrl: 'https://usebrian.ai' })

    await request(app)
      .post('/auth/email/request-link')
      .send({ email: 'a@b.com', nextPath: '/brain?foo=bar' })

    expect(calls[0]?.nextPath).toBe('/brain?foo=bar')
  })

  it('accepts a workspace-invite accept nextPath', async () => {
    const calls: Array<Parameters<MagicLinkStore['create']>[0]> = []
    const store = makeStore({
      create: async (input) => {
        calls.push(input)
        return { token: 't', code: '123456', expiresAt: new Date() }
      },
    })
    const smtp = makeSmtp()
    const app = makeApp({ magicLinkStore: store, smtpClient: smtp.client, appUrl: 'https://usebrian.ai' })

    // The invite page sends signed-out invitees to /login?next=/invite?token=…
    // — without this prefix the resume is dropped and a brand-new user has to
    // click the emailed invite link a second time after signing up.
    await request(app)
      .post('/auth/email/request-link')
      .send({ email: 'a@b.com', nextPath: '/invite?token=abc123' })

    expect(calls[0]?.nextPath).toBe('/invite?token=abc123')
  })

  it('accepts the desktop bridge continuation (cross-host only) and the claim resume', async () => {
    const calls: Array<Parameters<MagicLinkStore['create']>[0]> = []
    const store = makeStore({
      create: async (input) => {
        calls.push(input)
        return { token: 't', code: '123456', expiresAt: new Date() }
      },
    })
    const smtp = makeSmtp()
    const app = makeApp({ magicLinkStore: store, smtpClient: smtp.client, appUrl: 'https://usebrian.ai' })

    // Relative /desktop is no longer allowlisted — the desktop bridge only
    // travels as an absolute app-origin URL (see ALLOWED_NEXT_HOSTS).
    await request(app)
      .post('/auth/email/request-link')
      .send({ email: 'a@b.com', nextPath: '/desktop/auth?challenge=abc' })
    expect(calls[0]?.nextPath).toBeUndefined()

    // Absolute URL on the doc host (prod: the bridge lives on app.usebrian.ai).
    const abs = 'https://app.usebrian.ai/desktop/auth?challenge=abc&redirect=http://127.0.0.1:5000/cb'
    await request(app)
      .post('/auth/email/request-link')
      .send({ email: 'a@b.com', nextPath: abs })
    expect(calls[1]?.nextPath).toBe(abs)

    // Relative /auth/claim (partner claim flow resume) is allowlisted.
    await request(app)
      .post('/auth/email/request-link')
      .send({ email: 'a@b.com', nextPath: '/auth/claim?token=xyz' })
    expect(calls[2]?.nextPath).toBe('/auth/claim?token=xyz')
  })

  it('does NOT thread addAccount into the verify link by default', async () => {
    const store = makeStore()
    const smtp = makeSmtp()
    const app = makeApp({ magicLinkStore: store, smtpClient: smtp.client, appUrl: 'https://usebrian.ai' })

    await request(app).post('/auth/email/request-link').send({ email: 'a@b.com' })

    await new Promise((r) => setTimeout(r, 10))
    expect(smtp.sent).toHaveLength(1)
    expect(smtp.sent[0].link).not.toContain('addAccount')
  })

  it('appends &addAccount=1 to the verify link when addAccount is requested', async () => {
    const store = makeStore()
    const smtp = makeSmtp()
    const app = makeApp({ magicLinkStore: store, smtpClient: smtp.client, appUrl: 'https://usebrian.ai' })

    await request(app)
      .post('/auth/email/request-link')
      .send({ email: 'a@b.com', addAccount: true })

    await new Promise((r) => setTimeout(r, 10))
    expect(smtp.sent).toHaveLength(1)
    expect(smtp.sent[0].link).toContain('/login/verify?token=')
    expect(smtp.sent[0].link).toContain('&addAccount=1')
  })

  it('accepts addAccount as the string "1" (query-form coercion)', async () => {
    const store = makeStore()
    const smtp = makeSmtp()
    const app = makeApp({ magicLinkStore: store, smtpClient: smtp.client, appUrl: 'https://usebrian.ai' })

    await request(app)
      .post('/auth/email/request-link')
      .send({ email: 'a@b.com', addAccount: '1' })

    await new Promise((r) => setTimeout(r, 10))
    expect(smtp.sent[0].link).toContain('&addAccount=1')
  })
})

describe('[COMP:api/auth-email-verify] POST /auth/email/verify', () => {
  const FAKE_USER = {
    id: 'u_1',
    email: 'a@b.com',
    name: 'Alice',
    handle: 'alice',
    avatarUrl: null,
    authProvider: 'email',
    authProviderId: 'a@b.com',
    plan: 'free',
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripePriceId: null,
    subscriptionStatus: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    paymentFailedAt: null,
    trialUsedAt: null,
    timezone: 'UTC',
    lastSeenTz: null,
    lastSeenTzAt: null,
    createdAt: new Date(),
  }

  it('returns 503 when not configured', async () => {
    const app = makeApp(undefined)
    const res = await request(app)
      .post('/auth/email/verify')
      .send({ token: 'x' })
    expect(res.status).toBe(503)
  })

  it('returns 400 on a missing or empty token', async () => {
    const store = makeStore()
    const smtp = makeSmtp()
    const app = makeApp({ magicLinkStore: store, smtpClient: smtp.client, appUrl: 'https://usebrian.ai' })

    const r1 = await request(app).post('/auth/email/verify').send({})
    expect(r1.status).toBe(400)
    const r2 = await request(app).post('/auth/email/verify').send({ token: '' })
    expect(r2.status).toBe(400)
  })

  it('returns 401 when the token is expired, used, or unknown', async () => {
    const store = makeStore({ consumeByToken: async () => null })
    const smtp = makeSmtp()
    const app = makeApp({ magicLinkStore: store, smtpClient: smtp.client, appUrl: 'https://usebrian.ai' })

    const res = await request(app)
      .post('/auth/email/verify')
      .send({ token: 'whatever' })

    expect(res.status).toBe(401)
    expect(res.body.error).toBe('expired_or_used')
  })

  it('creates a new user when the email is unknown and mints tokens', async () => {
    const store = makeStore({
      consumeByToken: async () => ({ email: 'new@example.com', nextPath: null, locale: 'en' }),
    })
    findUserByEmailMock.mockResolvedValueOnce(null)
    findOrCreateUserMock.mockResolvedValueOnce({ user: { ...FAKE_USER, email: 'new@example.com' }, isNew: true })

    const smtp = makeSmtp()
    const app = makeApp({ magicLinkStore: store, smtpClient: smtp.client, appUrl: 'https://usebrian.ai' })

    const res = await request(app)
      .post('/auth/email/verify')
      .send({ token: 'good-token' })

    expect(res.status).toBe(200)
    expect(res.body.isNew).toBe(true)
    expect(res.body.user.email).toBe('new@example.com')
    expect(res.body.accessToken).toBeTruthy()
    expect(res.body.refreshToken).toBeTruthy()
    // findOrCreateUser called with email provider
    const callArgs = findOrCreateUserMock.mock.calls[0][0]
    expect(callArgs.authProvider).toBe('email')
    expect(callArgs.authProviderId).toBe('new@example.com')
  })

  it('signs into an existing Google user without changing auth_provider', async () => {
    const store = makeStore({
      consumeByToken: async () => ({ email: 'a@b.com', nextPath: '/brain', locale: 'en' }),
    })
    findUserByEmailMock.mockResolvedValueOnce({
      ...FAKE_USER,
      authProvider: 'google',
      authProviderId: 'google-sub-xxx',
    })

    const smtp = makeSmtp()
    const app = makeApp({ magicLinkStore: store, smtpClient: smtp.client, appUrl: 'https://usebrian.ai' })

    const res = await request(app)
      .post('/auth/email/verify')
      .send({ token: 'good-token' })

    expect(res.status).toBe(200)
    expect(res.body.isNew).toBe(false)
    // promoteChannelUser MUST NOT be called for a real Google user
    expect(promoteChannelUserMock).not.toHaveBeenCalled()
    // findOrCreateUser MUST NOT be called — we use the existing row
    expect(findOrCreateUserMock).not.toHaveBeenCalled()
    expect(res.body.nextPath).toBe('/brain')
  })

  it('promotes a channel-shadow user to email-native on first magic-link', async () => {
    const store = makeStore({
      consumeByToken: async () => ({ email: 'tg-user@example.com', nextPath: null, locale: 'en' }),
    })
    findUserByEmailMock.mockResolvedValueOnce({
      ...FAKE_USER,
      email: 'tg-user@example.com',
      authProvider: 'channel',
      authProviderId: 'telegram:12345',
    })
    promoteChannelUserMock.mockResolvedValueOnce(undefined)

    const smtp = makeSmtp()
    const app = makeApp({ magicLinkStore: store, smtpClient: smtp.client, appUrl: 'https://usebrian.ai' })

    const res = await request(app)
      .post('/auth/email/verify')
      .send({ token: 'good-token' })

    expect(res.status).toBe(200)
    expect(promoteChannelUserMock).toHaveBeenCalledOnce()
    const promoteArgs = promoteChannelUserMock.mock.calls[0]
    expect(promoteArgs[0]).toBe(FAKE_USER.id)
    expect(promoteArgs[1]).toMatchObject({ authProvider: 'email', authProviderId: 'tg-user@example.com' })
  })

  it('returns nextPath from the consumed token', async () => {
    const store = makeStore({
      consumeByToken: async () => ({ email: 'a@b.com', nextPath: '/brain/foo', locale: 'en' }),
    })
    findUserByEmailMock.mockResolvedValueOnce(FAKE_USER)

    const smtp = makeSmtp()
    const app = makeApp({ magicLinkStore: store, smtpClient: smtp.client, appUrl: 'https://usebrian.ai' })

    const res = await request(app)
      .post('/auth/email/verify')
      .send({ token: 'good-token' })

    expect(res.body.nextPath).toBe('/brain/foo')
  })
})

describe('[COMP:api/auth-email-verify-code] POST /auth/email/verify-code', () => {
  it('returns 503 when not configured', async () => {
    const app = makeApp(undefined)
    const res = await request(app)
      .post('/auth/email/verify-code')
      .send({ email: 'a@b.com', code: '123456' })
    expect(res.status).toBe(503)
  })

  it('returns 400 on a malformed code or email (never reaches the store)', async () => {
    const consumeByCode = vi.fn(async () => ({ status: 'invalid' as const }))
    const store = makeStore({ consumeByCode })
    const smtp = makeSmtp()
    const app = makeApp({ magicLinkStore: store, smtpClient: smtp.client, appUrl: 'https://usebrian.ai' })

    const badCode = await request(app).post('/auth/email/verify-code').send({ email: 'a@b.com', code: '12ab56' })
    expect(badCode.status).toBe(400)
    const shortCode = await request(app).post('/auth/email/verify-code').send({ email: 'a@b.com', code: '123' })
    expect(shortCode.status).toBe(400)
    const badEmail = await request(app).post('/auth/email/verify-code').send({ email: 'nope', code: '123456' })
    expect(badEmail.status).toBe(400)

    expect(consumeByCode).not.toHaveBeenCalled()
  })

  it('returns 429 too_many_attempts when the store reports the lockout', async () => {
    const store = makeStore({ consumeByCode: async () => ({ status: 'locked' }) })
    const smtp = makeSmtp()
    const app = makeApp({ magicLinkStore: store, smtpClient: smtp.client, appUrl: 'https://usebrian.ai' })

    const res = await request(app)
      .post('/auth/email/verify-code')
      .send({ email: 'a@b.com', code: '123456' })

    expect(res.status).toBe(429)
    expect(res.body.error).toBe('too_many_attempts')
  })

  it('returns 401 expired_or_used for a wrong / expired / unknown code', async () => {
    const store = makeStore({ consumeByCode: async () => ({ status: 'invalid' }) })
    const smtp = makeSmtp()
    const app = makeApp({ magicLinkStore: store, smtpClient: smtp.client, appUrl: 'https://usebrian.ai' })

    const res = await request(app)
      .post('/auth/email/verify-code')
      .send({ email: 'a@b.com', code: '000000' })

    expect(res.status).toBe(401)
    expect(res.body.error).toBe('expired_or_used')
  })

  it('mints the JWT pair on a valid code, resolving the email to a user', async () => {
    const store = makeStore({
      consumeByCode: async () => ({ status: 'ok', email: 'new@example.com', nextPath: '/brain', locale: 'en' }),
    })
    findUserByEmailMock.mockResolvedValueOnce(null)
    findOrCreateUserMock.mockResolvedValueOnce({
      user: { id: 'u_code', email: 'new@example.com', name: null, avatarUrl: null },
      isNew: true,
    })

    const smtp = makeSmtp()
    const app = makeApp({ magicLinkStore: store, smtpClient: smtp.client, appUrl: 'https://usebrian.ai' })

    const res = await request(app)
      .post('/auth/email/verify-code')
      .send({ email: 'new@example.com', code: '123456' })

    expect(res.status).toBe(200)
    expect(res.body.isNew).toBe(true)
    expect(res.body.user.email).toBe('new@example.com')
    expect(res.body.accessToken).toBeTruthy()
    expect(res.body.refreshToken).toBeTruthy()
    expect(res.body.nextPath).toBe('/brain')
  })
})

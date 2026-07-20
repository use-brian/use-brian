/**
 * POST /auth/google — account resolution branches.
 * Spec: docs/architecture/platform/auth.md → "Account resolution (Google side)".
 *
 * The route resolves the account email-first (verified email = account
 * anchor). These tests lock the four branches: cross-provider alternate-method
 * sign-in (the 2026-07-17 `auth_failed` regression: an email-magic-link user
 * could never sign in with Google — duplicate idx_users_email INSERT → 500),
 * the email_verified gate, channel-shadow promotion, and the plain
 * findOrCreateUser path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { authRoutes } from '../auth.js'
import type { User } from '../../db/users.js'

const JWT_SECRET = 'test-jwt-secret'

const findOrCreateUser = vi.fn()
const findUserByEmail = vi.fn()
const promoteChannelUser = vi.fn()
const updateUserTimezone = vi.fn()
const backfillUserProfileFromProvider = vi.fn()

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  getPool: vi.fn(),
}))

vi.mock('../../db/users.js', () => ({
  findOrCreateUser: (...a: unknown[]) => findOrCreateUser(...a),
  findUserByEmail: (...a: unknown[]) => findUserByEmail(...a),
  promoteChannelUser: (...a: unknown[]) => promoteChannelUser(...a),
  updateUserTimezone: (...a: unknown[]) => updateUserTimezone(...a),
  backfillUserProfileFromProvider: (...a: unknown[]) =>
    backfillUserProfileFromProvider(...a),
  findUserById: vi.fn(),
}))

function makeUser(overrides: Partial<User>): User {
  return {
    id: 'u-1',
    email: 'cynthia@example.com',
    name: null,
    handle: null,
    avatarUrl: null,
    avatarSource: null,
    avatarStorageKey: null,
    authProvider: 'email',
    authProviderId: 'cynthia@example.com',
    stripeCustomerId: null,
    timezone: 'UTC',
    lastSeenTz: null,
    lastSeenTzAt: null,
    createdAt: new Date('2026-07-16T00:00:00Z'),
    ...overrides,
  } as User
}

/** Stub Google's tokeninfo endpoint. */
function stubTokeninfo(payload: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => payload,
    })),
  )
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/auth', authRoutes(JWT_SECRET))
  return app
}

beforeEach(() => {
  findOrCreateUser.mockReset()
  findUserByEmail.mockReset()
  promoteChannelUser.mockReset()
  updateUserTimezone.mockReset()
  backfillUserProfileFromProvider.mockReset()
  vi.unstubAllGlobals()
})

describe('[COMP:api/auth] POST /auth/google account resolution', () => {
  it('signs an existing email-provider user into the same row (alternate method, no provider switch)', async () => {
    stubTokeninfo({
      sub: 'google-sub-1',
      email: 'cynthia@example.com',
      email_verified: 'true',
      name: 'Cynthia Yuen',
      picture: 'https://lh3.example/avatar.jpg',
      aud: 'client-id',
    })
    findUserByEmail.mockResolvedValue(makeUser({}))

    const res = await request(makeApp())
      .post('/auth/google')
      .send({ idToken: 'tok' })

    expect(res.status).toBe(200)
    expect(res.body.user.id).toBe('u-1')
    expect(res.body.isNew).toBe(false)
    expect(res.body.user.name).toBe('Cynthia Yuen')
    // The regression: this used to fall through to findOrCreateUser, whose
    // INSERT violated idx_users_email and 500'd the sign-in.
    expect(findOrCreateUser).not.toHaveBeenCalled()
    expect(promoteChannelUser).not.toHaveBeenCalled()
    expect(backfillUserProfileFromProvider).toHaveBeenCalledWith('u-1', {
      name: 'Cynthia Yuen',
      avatarUrl: 'https://lh3.example/avatar.jpg',
    })
  })

  it('rejects an email match when the Google email is not verified', async () => {
    stubTokeninfo({
      sub: 'google-sub-1',
      email: 'cynthia@example.com',
      // email_verified absent → unverified
      aud: 'client-id',
    })
    findUserByEmail.mockResolvedValue(makeUser({}))

    const res = await request(makeApp())
      .post('/auth/google')
      .send({ idToken: 'tok' })

    expect(res.status).toBe(401)
    expect(res.body.error).toBe('google_email_unverified')
    expect(findOrCreateUser).not.toHaveBeenCalled()
    expect(backfillUserProfileFromProvider).not.toHaveBeenCalled()
  })

  it('promotes a channel shadow user (verified email)', async () => {
    stubTokeninfo({
      sub: 'google-sub-1',
      email: 'cynthia@example.com',
      email_verified: 'true',
      name: 'Cynthia Yuen',
      aud: 'client-id',
    })
    findUserByEmail.mockResolvedValue(
      makeUser({ authProvider: 'channel', authProviderId: 'telegram:123' }),
    )

    const res = await request(makeApp())
      .post('/auth/google')
      .send({ idToken: 'tok' })

    expect(res.status).toBe(200)
    expect(promoteChannelUser).toHaveBeenCalledWith('u-1', {
      authProvider: 'google',
      authProviderId: 'google-sub-1',
      name: 'Cynthia Yuen',
      avatarUrl: undefined,
    })
    expect(findOrCreateUser).not.toHaveBeenCalled()
  })

  it('falls through to findOrCreateUser when no user holds the email', async () => {
    stubTokeninfo({
      sub: 'google-sub-1',
      email: 'fresh@example.com',
      email_verified: 'true',
      aud: 'client-id',
    })
    findUserByEmail.mockResolvedValue(null)
    findOrCreateUser.mockResolvedValue({
      user: makeUser({
        id: 'u-2',
        email: 'fresh@example.com',
        authProvider: 'google',
        authProviderId: 'google-sub-1',
      }),
      isNew: true,
    })

    const res = await request(makeApp())
      .post('/auth/google')
      .send({ idToken: 'tok' })

    expect(res.status).toBe(200)
    expect(res.body.isNew).toBe(true)
    expect(findOrCreateUser).toHaveBeenCalledWith(
      expect.objectContaining({
        authProvider: 'google',
        authProviderId: 'google-sub-1',
      }),
    )
  })

  it('routes a repeat sign-in of the same google identity through findOrCreateUser even when unverified', async () => {
    // The email row IS this (google, sub) pair — the unverified gate must not
    // lock out an already-linked account; the pair itself is the proof.
    stubTokeninfo({
      sub: 'google-sub-1',
      email: 'cynthia@example.com',
      aud: 'client-id',
    })
    const existing = makeUser({
      authProvider: 'google',
      authProviderId: 'google-sub-1',
    })
    findUserByEmail.mockResolvedValue(existing)
    findOrCreateUser.mockResolvedValue({ user: existing, isNew: false })

    const res = await request(makeApp())
      .post('/auth/google')
      .send({ idToken: 'tok' })

    expect(res.status).toBe(200)
    expect(findOrCreateUser).toHaveBeenCalled()
    expect(backfillUserProfileFromProvider).not.toHaveBeenCalled()
  })
})

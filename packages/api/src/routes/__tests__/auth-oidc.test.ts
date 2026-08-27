import { createHash } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { verifyAccessToken, verifyRefreshToken } from '../../auth/jwt.js'
import type { User } from '../../db/users.js'
import { authRoutes, type OidcAuthDeps } from '../auth.js'

const JWT_SECRET = 'jwt-secret-for-oidc-tests'
const BRIDGE_SECRET = 'bridge-secret-that-is-at-least-32-chars'
const ISSUER = 'https://id.example.com/tenant'

const findOrCreateUser = vi.fn()
const findUserByEmail = vi.fn()
const promoteChannelUser = vi.fn()
const updateUserTimezone = vi.fn()
const backfillUserProfileFromProvider = vi.fn()

vi.mock('../../db/client.js', () => ({ query: vi.fn(), getPool: vi.fn() }))
vi.mock('../../db/users.js', () => ({
  findOrCreateUser: (...args: unknown[]) => findOrCreateUser(...args),
  findUserByEmail: (...args: unknown[]) => findUserByEmail(...args),
  promoteChannelUser: (...args: unknown[]) => promoteChannelUser(...args),
  updateUserTimezone: (...args: unknown[]) => updateUserTimezone(...args),
  backfillUserProfileFromProvider: (...args: unknown[]) => backfillUserProfileFromProvider(...args),
  findUserById: vi.fn(),
}))

function user(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'member@example.com',
    name: null,
    handle: null,
    avatarUrl: null,
    avatarSource: null,
    avatarStorageKey: null,
    avatarStorageWorkspaceId: null,
    avatarStorageUri: null,
    authProvider: 'email',
    authProviderId: 'member@example.com',
    stripeCustomerId: null,
    timezone: 'UTC',
    lastSeenTz: null,
    lastSeenTzAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

function identity(overrides: Record<string, unknown> = {}) {
  return {
    issuer: ISSUER,
    subject: 'subject-123',
    email: ' Member@Example.com ',
    emailVerified: true,
    name: 'Member Name',
    avatarUrl: 'https://images.example.com/avatar.png',
    timezone: 'Asia/Tokyo',
    ...overrides,
  }
}

function makeApp(overrides: Partial<OidcAuthDeps> = {}) {
  const deps: OidcAuthDeps = {
    config: { issuer: ISSUER, bridgeSecret: BRIDGE_SECRET },
    canSignInEmail: vi.fn(async () => true),
    ...overrides,
  }
  const app = express()
  app.use(express.json())
  app.use('/auth', authRoutes(JWT_SECRET, undefined, undefined, undefined, undefined, undefined, deps))
  return app
}

function post(app: ReturnType<typeof makeApp>, body = identity(), secret = BRIDGE_SECRET) {
  return request(app).post('/auth/oidc/session').set('X-Outpost-Auth-Bridge', secret).send(body)
}

beforeEach(() => {
  findOrCreateUser.mockReset()
  findUserByEmail.mockReset()
  promoteChannelUser.mockReset()
  updateUserTimezone.mockReset()
  updateUserTimezone.mockResolvedValue(undefined)
  backfillUserProfileFromProvider.mockReset()
})

describe('[COMP:api/auth] POST /auth/oidc/session', () => {
  it('is unavailable without enabled Outpost OIDC dependencies', async () => {
    const app = express()
    app.use(express.json())
    app.use('/auth', authRoutes(JWT_SECRET))
    expect((await request(app).post('/auth/oidc/session').send(identity())).status).toBe(404)
  })

  it('rejects wrong or prefix-only bridge secrets', async () => {
    expect((await post(makeApp(), identity(), 'wrong')).status).toBe(401)
    expect((await post(makeApp(), identity(), BRIDGE_SECRET.slice(0, -1))).status).toBe(401)
    expect(findUserByEmail).not.toHaveBeenCalled()
  })

  it('rejects issuer mismatch, unverified email, and unrecognized fields', async () => {
    expect((await post(makeApp(), identity({ issuer: `${ISSUER}/other` }))).body.error).toBe('invalid_oidc_issuer')
    expect((await post(makeApp(), identity({ emailVerified: false }))).body.error).toBe('oidc_email_unverified')
    expect((await post(makeApp(), identity({ nextPath: '/brain' }))).status).toBe(400)
    expect((await post(makeApp(), identity({ idToken: 'provider-token' }))).status).toBe(400)
  })

  it('normalizes email and rejects users outside Outpost admission', async () => {
    const canSignInEmail = vi.fn(async () => false)
    const response = await post(makeApp({ canSignInEmail }))
    expect(response.status).toBe(403)
    expect(response.body.error).toBe('email_enrollment_required')
    expect(canSignInEmail).toHaveBeenCalledWith('member@example.com')
    expect(findUserByEmail).not.toHaveBeenCalled()
  })

  it('reuses an existing real user and backfills profile and timezone', async () => {
    findUserByEmail.mockResolvedValue(user())
    const response = await post(makeApp())
    expect(response.status).toBe(200)
    expect(response.body.user).toMatchObject({ id: 'user-1', name: 'Member Name' })
    expect(response.body.isNew).toBe(false)
    expect(backfillUserProfileFromProvider).toHaveBeenCalledWith('user-1', {
      name: 'Member Name',
      avatarUrl: 'https://images.example.com/avatar.png',
    })
    expect(updateUserTimezone).toHaveBeenCalledWith('user-1', 'Asia/Tokyo')
    expect(findOrCreateUser).not.toHaveBeenCalled()
  })

  it('rejects a recycled email when the existing OIDC subject differs', async () => {
    findUserByEmail.mockResolvedValue(user({ authProvider: 'oidc', authProviderId: 'another-subject' }))
    const response = await post(makeApp())
    expect(response.status).toBe(401)
    expect(response.body.error).toBe('invalid_oidc_identity')
    expect(backfillUserProfileFromProvider).not.toHaveBeenCalled()
    expect(findOrCreateUser).not.toHaveBeenCalled()
  })

  it('promotes a channel shadow to the OIDC identity', async () => {
    findUserByEmail.mockResolvedValue(user({ authProvider: 'channel', authProviderId: 'telegram:1' }))
    const response = await post(makeApp())
    const providerId = createHash('sha256').update(ISSUER).update('\x00').update('subject-123').digest('base64url')
    expect(response.status).toBe(200)
    expect(promoteChannelUser).toHaveBeenCalledWith('user-1', {
      authProvider: 'oidc',
      authProviderId: providerId,
      name: 'Member Name',
      avatarUrl: 'https://images.example.com/avatar.png',
    })
    expect(findOrCreateUser).not.toHaveBeenCalled()
  })

  it('creates a fresh OIDC user with a stable provider ID and Brian JWTs', async () => {
    findUserByEmail.mockResolvedValue(null)
    const created = user({ id: 'fresh-user', authProvider: 'oidc', email: 'member@example.com' })
    findOrCreateUser.mockResolvedValue({ user: created, isNew: true })

    const first = await post(makeApp())
    const expectedProviderId = createHash('sha256').update(ISSUER).update('\x00').update('subject-123').digest('base64url')
    expect(first.status).toBe(200)
    expect(first.body.isNew).toBe(true)
    expect(findOrCreateUser).toHaveBeenCalledWith({
      authProvider: 'oidc',
      authProviderId: expectedProviderId,
      email: 'member@example.com',
      name: 'Member Name',
      avatarUrl: 'https://images.example.com/avatar.png',
      timezone: 'Asia/Tokyo',
    })
    expect(verifyAccessToken(first.body.accessToken, JWT_SECRET)).toBe('fresh-user')
    expect(verifyRefreshToken(first.body.refreshToken, JWT_SECRET)).toBe('fresh-user')

    findOrCreateUser.mockClear()
    await post(makeApp())
    expect(findOrCreateUser.mock.calls[0][0].authProviderId).toBe(expectedProviderId)
  })
})

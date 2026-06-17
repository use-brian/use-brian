import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { devAuthRoutes, isLocalDevEnv, type DevAuthDeps } from '../dev-auth.js'
import { verifyAccessToken, verifyRefreshToken } from '../../auth/jwt.js'
import type { User } from '../../db/users.js'

const JWT_SECRET = 'dev-auth-test-secret'
const DEV_USER_ID = '00000000-0000-4000-a000-0000000000de'

function fakeUser(overrides?: Partial<User>): User {
  return {
    id: DEV_USER_ID,
    email: 'dev@localhost',
    name: 'Local Dev',
    handle: 'local_dev',
    avatarUrl: null,
    authProvider: 'dev',
    authProviderId: 'local-dev',
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
    ...overrides,
  } as User
}

function makeApp(deps: Partial<DevAuthDeps> & { createUser?: DevAuthDeps['createUser'] }) {
  const app = express()
  app.use(express.json())
  app.use(
    '/auth',
    devAuthRoutes({
      jwtSecret: JWT_SECRET,
      isLocal: () => true,
      ...deps,
    }),
  )
  return app
}

describe('[COMP:api/dev-auth] isLocalDevEnv gate', () => {
  it('is false in production regardless of K_SERVICE', () => {
    const prev = { node: process.env.NODE_ENV, k: process.env.K_SERVICE }
    try {
      process.env.NODE_ENV = 'production'
      delete process.env.K_SERVICE
      expect(isLocalDevEnv()).toBe(false)
    } finally {
      process.env.NODE_ENV = prev.node
      if (prev.k === undefined) delete process.env.K_SERVICE
      else process.env.K_SERVICE = prev.k
    }
  })

  it('is false when K_SERVICE is set (Cloud Run), even if NODE_ENV is not production', () => {
    const prev = { node: process.env.NODE_ENV, k: process.env.K_SERVICE }
    try {
      process.env.NODE_ENV = 'development'
      process.env.K_SERVICE = 'sidanclaw-api'
      expect(isLocalDevEnv()).toBe(false)
    } finally {
      process.env.NODE_ENV = prev.node
      if (prev.k === undefined) delete process.env.K_SERVICE
      else process.env.K_SERVICE = prev.k
    }
  })

  it('is true only on a local run (no K_SERVICE, non-production)', () => {
    const prev = { node: process.env.NODE_ENV, k: process.env.K_SERVICE }
    try {
      process.env.NODE_ENV = 'development'
      delete process.env.K_SERVICE
      expect(isLocalDevEnv()).toBe(true)
    } finally {
      process.env.NODE_ENV = prev.node
      if (prev.k === undefined) delete process.env.K_SERVICE
      else process.env.K_SERVICE = prev.k
    }
  })
})

describe('[COMP:api/dev-auth] POST /auth/dev-login', () => {
  it('refuses with 403 and never mints a token when not local (the production guard)', async () => {
    const createUser = vi.fn()
    const app = makeApp({ isLocal: () => false, createUser })
    const res = await request(app).post('/auth/dev-login').expect(403)
    expect(res.body).toEqual({ error: 'dev_login_disabled' })
    // The DB-backed user upsert is never reached — no session can exist.
    expect(createUser).not.toHaveBeenCalled()
  })

  it('returns 503 when JWT_SECRET is unset rather than signing with undefined', async () => {
    const createUser = vi.fn()
    const app = makeApp({ jwtSecret: undefined, createUser })
    await request(app).post('/auth/dev-login').expect(503)
    expect(createUser).not.toHaveBeenCalled()
  })

  it('mints a verifiable access+refresh pair for the deterministic local dev user', async () => {
    const createUser = vi.fn(async () => ({ user: fakeUser(), isNew: false }))
    const app = makeApp({ createUser })
    const res = await request(app).post('/auth/dev-login').expect(200)

    // The minted tokens are REAL — they verify under the same secret the
    // rest of the API uses, which is what makes the debugged session work.
    expect(verifyAccessToken(res.body.accessToken, JWT_SECRET)).toBe(DEV_USER_ID)
    expect(verifyRefreshToken(res.body.refreshToken, JWT_SECRET)).toBe(DEV_USER_ID)
    expect(res.body.user).toMatchObject({ id: DEV_USER_ID, email: 'dev@localhost' })

    // Default identity: deterministic, so re-logging-in reuses one local user.
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        authProvider: 'dev',
        authProviderId: 'local-dev',
        email: 'dev@localhost',
      }),
    )
  })

  it('routes ?as=<slug> to a distinct local identity for multi-user UI', async () => {
    const createUser = vi.fn(async () => ({ user: fakeUser({ id: DEV_USER_ID }), isNew: false }))
    const app = makeApp({ createUser })
    await request(app).post('/auth/dev-login?as=Alice').expect(200)
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        authProviderId: 'local-dev:alice',
        email: 'alice@localhost',
      }),
    )
  })

  it('ignores a malformed ?as and falls back to the default identity', async () => {
    const createUser = vi.fn(async () => ({ user: fakeUser(), isNew: false }))
    const app = makeApp({ createUser })
    await request(app).post('/auth/dev-login?as=not%20a%20slug!').expect(200)
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({ authProviderId: 'local-dev' }),
    )
  })

  it('also accepts GET so the endpoint is reachable from a browser address bar', async () => {
    const createUser = vi.fn(async () => ({ user: fakeUser(), isNew: false }))
    const app = makeApp({ createUser })
    const res = await request(app).get('/auth/dev-login').expect(200)
    expect(verifyAccessToken(res.body.accessToken, JWT_SECRET)).toBe(DEV_USER_ID)
  })
})
